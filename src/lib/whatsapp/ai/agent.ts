import { isStepCount, ToolLoopAgent, type ImagePart, type TextPart, type UserModelMessage } from "ai";
import rawStoreConfig from "../../../../store.config";
import { aiBudgetAvailable } from "@/lib/services/whatsapp-ai-usage";
import {
  flagHandoff,
  getConversation,
  recentContext,
  type WaLanguage,
} from "@/lib/services/whatsapp-conversations";
import { effectiveAssistantName, getWhatsAppSettings } from "@/lib/services/whatsapp-settings";
import { msgHandoff } from "@/lib/whatsapp/copy";
import { whatsappModels } from "@/lib/whatsapp/config";
import { AiBudgetExceededError, openRouterProvider, recordUsage, usageFromSdk, withFallback } from "./provider";
import { createCatalogTools, type CatalogToolsContext } from "./catalog-tools";
import { buildSystemPrompt } from "./prompt";
import { createWhatsAppTools, MAX_TOOL_CALLS_PER_TURN } from "./tools";

/** One customer turn for the WhatsApp assistant. Audio arrives already transcribed. */
export interface AgentTurnInput {
  conversationId: string;
  newMessages: Array<{ kind: "text" | "audio" | "image"; text: string; imageBase64?: string }>;
}

export interface AgentTurnResult {
  replies: string[];
  handedOff: boolean;
  model: string;
  toolCalls: string[];
  /**
   * Product cards enqueued in the outbox during this turn (catalog tools only).
   * Cards are enqueued while the tools run, so they are due before the text replies:
   * callers must enqueue the `ai_reply` rows for `replies` only after this resolves,
   * and can start their per-turn dedupe index at `productCardsQueued` so reply keys
   * never collide with the `card:` keys.
   */
  productCardsQueued: number;
}

export const MAX_CONTEXT_MESSAGES = 20;
export const MAX_AGENT_STEPS = 5;
export const MAX_REPLIES = 3;
export const MAX_REPLY_CHARS = 700;

function nowCasablanca(): string {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Africa/Casablanca",
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());
}

/**
 * Builds the single user message for this turn.
 * Images become image parts sent as inline `data:image/jpeg;base64,…` payloads with the
 * "[photo du client]" text plus the caption; audio arrives as plain transcribed text.
 */
function buildUserMessage(newMessages: AgentTurnInput["newMessages"]): UserModelMessage {
  const parts: Array<TextPart | ImagePart> = [];
  for (const message of newMessages) {
    const text = (message.text ?? "").trim();
    if (message.kind === "image" && message.imageBase64) {
      // Accept both raw base64 and a full data URL; the SDK wants bare inline data.
      const rawBase64 = message.imageBase64.replace(/^data:image\/[a-z+]+;base64,/i, "");
      parts.push({ type: "image", image: rawBase64, mediaType: "image/jpeg" });
      parts.push({ type: "text", text: `[photo du client]${text ? ` ${text}` : ""}` });
    } else if (text) {
      parts.push({ type: "text", text });
    }
  }
  if (parts.length === 0) {
    parts.push({ type: "text", text: "(message vide)" });
  }
  return { role: "user", content: parts };
}

/** Strips Markdown headings, table rows and double-star bold from one reply block. */
function cleanReply(raw: string): string {
  const body = raw
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      // Table rows and separators render as garbage on WhatsApp: drop them.
      if (/^\|.*\|$/.test(trimmed)) return "";
      if (/^[-=]{3,}$/.test(trimmed)) return "";
      // Heading markers: keep the text, drop the Markdown syntax.
      return trimmed.replace(/^#{1,6}\s+/, "");
    })
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
  if (!body) return "";
  // WhatsApp supports *bold*: convert **bold** (and leftover double stars).
  const bolded = body.replace(/\*\*([^*]+)\*\*/g, "*$1*").replace(/\*\*/g, "*");
  return bolded.length > MAX_REPLY_CHARS ? bolded.slice(0, MAX_REPLY_CHARS) : bolded;
}

/** Splits model text on blank lines into at most 3 non-empty WhatsApp messages. */
export function splitReplies(text: string): string[] {
  return text
    .split(/\n[ \t]*\n+/)
    .map(cleanReply)
    .filter((reply) => reply.length > 0)
    .slice(0, MAX_REPLIES);
}

/**
 * Runs one WhatsApp assistant turn: reads the conversation context, calls CRM-scoped
 * tools and returns 1–3 short replies. Never creates, confirms, cancels or prices an
 * order; the tools read server data and staging writes stay behind human approval.
 */
export async function runWhatsAppAgent(input: AgentTurnInput): Promise<AgentTurnResult> {
  if (!aiBudgetAvailable()) {
    throw new AiBudgetExceededError();
  }

  const conversation = getConversation(input.conversationId);
  if (!conversation) {
    throw new Error("Conversation introuvable.");
  }

  const settings = getWhatsAppSettings();
  // Raw store.config import (not the server-only @/config module): same pattern as
  // src/lib/whatsapp/notify.ts and src/lib/services/carrier-status-map.ts so this
  // module loads in node tests. Widen first: store.config.ts pins the template's
  // locale as a literal, and fresh copies legitimately switch it to "ar".
  const storeName: string = rawStoreConfig.name;
  const rawLocale: string = rawStoreConfig.locale;
  const storeLocale: "fr" | "ar" = rawLocale === "ar" ? "ar" : "fr";
  const assistantName = effectiveAssistantName(settings, storeName);
  const language: WaLanguage = conversation.language ?? "fr";

  const systemPrompt = buildSystemPrompt({
    storeName,
    assistantName,
    language,
    faqText: settings.faqText,
    nowCasablanca: nowCasablanca(),
    orders: conversation.orders.map((o) => ({ ref: o.ref, access: o.access })),
    catalogEnabled: settings.catalogSuggestionsEnabled,
    orderEditProposalsEnabled: settings.orderEditProposalsEnabled,
    crossSellEnabled: settings.crossSellEnabled,
  });

  const contextMessages = recentContext(conversation.id, MAX_CONTEXT_MESSAGES)
    .filter((m) => m.text.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.text }));

  const userMessage = buildUserMessage(input.newMessages);
  const hasImage = input.newMessages.some((m) => m.kind === "image" && m.imageBase64);

  const models = whatsappModels();
  const provider = openRouterProvider();
  const toolsCtx: CatalogToolsContext = {
    conversationId: conversation.id,
    phone: conversation.phone,
    language,
    productCardsQueued: 0,
    toolCalls: [],
  };
  const catalogToolFlags = {
    catalog: settings.catalogSuggestionsEnabled,
    editProposals: settings.orderEditProposalsEnabled,
    crossSell: settings.crossSellEnabled,
  };

  const { result: response, model } = await withFallback(
    models.chat,
    models.chatFallback,
    async (modelId) => {
      const agent = new ToolLoopAgent({
        model: provider.chatModel(modelId),
        instructions: systemPrompt,
        // Catalog tools merge in only for their enabled flags: with every flag OFF
        // the tool set is exactly the base set.
        tools: { ...createWhatsAppTools(toolsCtx), ...createCatalogTools(toolsCtx, catalogToolFlags) },
        stopWhen: isStepCount(MAX_AGENT_STEPS),
        // Reserve the last step for a plain-text answer instead of another tool call.
        prepareStep: ({ stepNumber }) => (stepNumber >= MAX_AGENT_STEPS - 1 ? { toolChoice: "none" as const } : {}),
        maxOutputTokens: 500,
        temperature: 0.3,
        maxRetries: 0,
        // streamText/generateText default error callbacks log raw request bodies
        // (customer content); silence them — errors surface through withFallback.
        prepareCall: (callSettings) => ({ ...callSettings, onError: () => {} }),
      });

      const generated = await agent.generate({ messages: [...contextMessages, userMessage] });

      for (const step of generated.steps) {
        recordUsage({
          role: hasImage ? "vision" : "chat",
          model: modelId,
          ...usageFromSdk(step.usage),
          conversationId: conversation.id,
        });
      }

      return generated;
    },
  );

  const toolCalls = [...toolsCtx.toolCalls];
  const handedOff = toolCalls.includes("handoffToHuman");
  let replies = splitReplies(response.text);

  if (replies.length === 0 && !handedOff) {
    replies = [
      msgHandoff({
        locale: storeLocale,
        storeName,
        assistantName,
        seed: conversation.id,
      }),
    ];
    flagHandoff(conversation.id, "réponse IA vide");
  }

  return {
    replies,
    handedOff,
    model,
    toolCalls: toolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN),
    productCardsQueued: toolsCtx.productCardsQueued,
  };
}
