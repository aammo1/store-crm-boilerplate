import { tool, type ToolSet } from "ai";
import { getDb } from "@/lib/db";
import rawStoreConfig from "../../../../store.config";
import type { VariantOption } from "@/lib/commerce-types";
import {
  getProductBySlug,
  getVariantById,
  listStorefront,
  type StorefrontProductView,
} from "@/lib/services/catalog";
import { availableFor } from "@/lib/services/inventory";
import { getConversation, type WaLanguage } from "@/lib/services/whatsapp-conversations";
import { enqueueOutbox } from "@/lib/services/whatsapp-outbox";
import { createProposal, StagingError } from "@/lib/services/whatsapp-staging";
import { getWhatsAppSettings } from "@/lib/services/whatsapp-settings";
import { casablancaParts } from "@/lib/whatsapp/pacing";
import { storefrontMediaOrigin, toStorefrontCatalogProduct } from "@/lib/storefront-catalog-dto";
import { z } from "@/lib/validation";
import { MAX_TOOL_CALLS_PER_TURN, type WhatsAppToolsContext } from "./tools";

/**
 * Catalog tools for the WhatsApp assistant (later-phase catalog feature, CRM catalog only).
 *
 * Gated per flag, never guessing:
 * - `catalogSuggestionsEnabled`: sendProductCards, checkAvailability, matchProductPhoto
 * - `orderEditProposalsEnabled`: proposeOrderEdit (staging only — a human approves)
 * - `crossSellEnabled`: suggestCrossSell (at most one per conversation)
 *
 * Prices, packs and availability always come from server services; no tool output ever
 * contains a computed total for an order edit.
 */

/** Hard cap of one card caption (WhatsApp shows long captions badly). */
const MAX_CAPTION_CHARS = 1000;
/** Product cards allowed per agent turn, across all sendProductCards calls. */
const MAX_PRODUCT_CARDS_PER_TURN = 3;
/** Below this normalized token overlap a photo match is refused instead of guessed. */
const PHOTO_MATCH_THRESHOLD = 0.35;
/** app_state key holding the one-shot cross-sell marker per conversation. */
const CROSS_SELL_KEY_PREFIX = "wa_crosssell:";

/**
 * Per-turn context shared with the base tools. `toolCalls` is the SAME array as the
 * base tools' context, so the per-turn budget stays shared. `productCardsQueued` is
 * mutated by sendProductCards and read by the agent after the turn.
 */
export interface CatalogToolsContext extends WhatsAppToolsContext {
  /** Conversation language; `ar` and `darija_arabic` get Arabic card captions. */
  language: WaLanguage;
  /** Product cards enqueued during the current turn. */
  productCardsQueued: number;
}

/** Which catalog tools to merge into the agent turn. */
export interface CatalogToolFlags {
  catalog: boolean;
  editProposals: boolean;
  crossSell: boolean;
}

/** An in-stock variant proposed as the closest alternative. */
interface RankedVariant {
  variantId: string;
  label: string;
  options: VariantOption[];
}

/** Mirrors the guard of tools.ts (same shared counter) without modifying that file. */
function guard<T>(ctx: CatalogToolsContext, name: string, fn: () => T): T | { error: string } {
  if (ctx.toolCalls.length >= MAX_TOOL_CALLS_PER_TURN) {
    return { error: "budget" };
  }
  ctx.toolCalls.push(name);
  return fn();
}

/** Folds a string for case- and accent-insensitive comparison (same rules as tools.ts). */
function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
    .trim();
}

/** Public origin for customer-facing URLs: env wins, raw config domain as fallback. */
function publicOrigin(): string | null {
  const raw = (process.env.CRM_PUBLIC_URL?.trim() || rawStoreConfig.domain).replace(/\/+$/, "");
  try {
    return storefrontMediaOrigin(raw);
  } catch {
    return null;
  }
}

function isArabicLanguage(language: WaLanguage): boolean {
  return language === "ar" || language === "darija_arabic";
}

/** Numeric value of a folded option string ("42" -> 42), null when not numeric. */
function numericValue(folded: string): number | null {
  return /^-?\d+(?:\.\d+)?$/.test(folded) ? Number(folded) : null;
}

/** Card caption from server data only: name, MAD price, in-stock options, packs, link. */
function buildCardCaption(input: {
  name: string;
  priceMad: number;
  options: string[];
  packs: Array<{ quantity: number; price: number }>;
  url: string;
  arabic: boolean;
  /** At least one active variant is in stock. */
  inStock: boolean;
}): string {
  const { name, priceMad, options, packs, url, arabic } = input;
  const currency = arabic ? "درهم" : "DH";
  const lines = [`*${name}* — ${priceMad} ${currency}`];
  if (!input.inStock) {
    lines.push(arabic ? "غير متوفر حاليا" : "Actuellement épuisé");
  } else if (input.options.length > 0) {
    lines.push(`${arabic ? "متوفر" : "Disponible"} : ${options.join(", ")}`);
  }
  // Optionless in-stock product: no availability line.
  if (packs.length > 0) {
    lines.push(
      packs
        .map((pack) =>
          arabic ? `${pack.quantity} بـ ${pack.price} ${currency}` : `${pack.quantity} pour ${pack.price} ${currency}`,
        )
        .join(", "),
    );
  }
  lines.push(url);
  const caption = lines.join("\n");
  return caption.length > MAX_CAPTION_CHARS ? `${caption.slice(0, MAX_CAPTION_CHARS - 1)}…` : caption;
}

/** True when both folded option-value lists contain exactly the same values. */
function sameFoldedValues(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((value) => set.has(value));
}

/**
 * Ranks a product's in-stock active variants against requested option values:
 * most shared values first, numeric distance as tie-break ("42" -> "41"/"43"),
 * then a stable id order.
 */
function rankedInStock(
  product: { variants: Array<{ id: string; label: string; active: boolean; options: VariantOption[] }> },
  requestedRawValues: string[],
  limit: number,
): RankedVariant[] {
  const requested = requestedRawValues.map(foldText).filter(Boolean);
  const requestedNumbers = requested
    .map(numericValue)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  return product.variants
    .filter((variant) => variant.active && availableFor(variant.id) > 0)
    .map((variant) => {
      const values = variant.options.map((option) => foldText(option.value));
      const valueSet = new Set(values);
      const shared = requested.filter((value) => valueSet.has(value)).length;
      const variantNumbers = values
        .map(numericValue)
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b);
      let distance = Number.POSITIVE_INFINITY;
      if (requestedNumbers.length > 0 && variantNumbers.length > 0) {
        const pairs = Math.min(requestedNumbers.length, variantNumbers.length);
        let sum = 0;
        for (let i = 0; i < pairs; i++) sum += Math.abs(requestedNumbers[i] - variantNumbers[i]);
        distance = sum;
      }
      return { variant, shared, distance };
    })
    .sort(
      (a, b) =>
        b.shared - a.shared ||
        a.distance - b.distance ||
        a.variant.id.localeCompare(b.variant.id),
    )
    .slice(0, limit)
    .map(({ variant }) => ({ variantId: variant.id, label: variant.label, options: variant.options }));
}

// ---------------------------------------------------------------------------
// Photo-matching tokens (accent-insensitive, French/Arabic stopwords removed)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  // French
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "mais", "donc", "or", "ni", "car",
  "je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles", "me", "te", "se",
  "ce", "cet", "cette", "ces", "mon", "ton", "son", "ma", "ta", "sa", "notre", "votre", "leur",
  "qui", "que", "quoi", "dont", "est", "sont", "suis", "es", "sommes", "etes", "etre",
  "en", "au", "aux", "sur", "sous", "dans", "pour", "par", "avec", "sans", "chez", "vers", "entre",
  "ici", "oui", "non", "pas", "plus", "moins", "tres", "peu", "trop", "comme", "tout", "tous",
  "toute", "toutes", "si", "quel", "quelle", "vous",
  // Darija (latin)
  "dyal", "dial", "ana", "nta", "nti", "bghit", "wach", "kayn", "kain", "fin", "chno", "chnu",
  "ach", "kifach", "kif", "imta", "bzaf", "chwiya", "safi", "3afak", "afak", "chokran", "baraka",
  "llahu", "fik", "mzyan", "mchi", "khaso", "khasso", "had", "hadi", "hado", "hadchi",
  "li", "mn", "men", "fo9", "taht", "m3a", "ghi", "guer", "chkoun",
  // Arabic script
  "في", "من", "على", "إلى", "عن", "هذا", "هذه", "ذلك", "التي", "الذي", "ما", "لا", "و", "ثم", "أو",
  "هو", "هي", "أن", "إن", "كان", "كانت", "كل", "بعد", "قبل", "مع", "عند", "هنا", "هناك",
  "بغيت", "واش", "كاين", "فين", "شنو", "شحال", "بزاف", "شوية", "صافي", "عافاك", "شكرا", "ديال",
  "غير", "شي", "كيفاش", "هاد", "هادي", "شكون",
]);

/** Folds one token: strips the Arabic definite article and a trailing French plural "s". */
function normalizeToken(token: string): string {
  let value = token;
  if (value.startsWith("ال") && /^[\u0600-\u06ff]{4,}$/.test(value)) {
    value = value.slice(2);
  }
  if (value.length >= 4 && value.endsWith("s") && !value.endsWith("ss")) {
    value = value.slice(0, -1);
  }
  return value;
}

/** Deduplicated search tokens for photo matching (and product haystacks). */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of foldText(text).split(" ")) {
    if (!raw || raw.length < 2 || STOPWORDS.has(raw)) continue;
    const normalized = normalizeToken(raw);
    if (normalized.length < 2 || STOPWORDS.has(normalized)) continue;
    tokens.push(normalized);
  }
  return [...new Set(tokens)];
}

/** Normalized token overlap of the description against name + category + description. */
function photoScore(descriptionTokens: string[], product: StorefrontProductView): number {
  if (descriptionTokens.length === 0) return 0;
  const folded = foldText(`${product.name} ${product.category} ${product.description}`);
  const haystack = new Set(tokenize(folded));
  // Compact form ("T-shirt" -> "tshirt") mirrors findProducts so compound words match.
  const compact = folded.replace(/ /g, "");
  const matched = descriptionTokens.filter(
    (token) => haystack.has(token) || (token.length >= 4 && compact.includes(token)),
  ).length;
  return matched / descriptionTokens.length;
}

// ---------------------------------------------------------------------------
// Tool set
// ---------------------------------------------------------------------------

function flagsFromSettings(): CatalogToolFlags {
  const settings = getWhatsAppSettings();
  return {
    catalog: settings.catalogSuggestionsEnabled,
    editProposals: settings.orderEditProposalsEnabled,
    crossSell: settings.crossSellEnabled,
  };
}

/**
 * Builds the catalog tools for one agent turn, keeping only the enabled flags.
 * With every flag OFF the result is empty, so the agent tool set stays exactly
 * the task-17 set. Flags come from the caller (agent settings) by default from
 * getWhatsAppSettings() for direct callers.
 */
export function createCatalogTools(ctx: CatalogToolsContext, flags?: CatalogToolFlags): ToolSet {
  const enabled = flags ?? flagsFromSettings();
  const refSchema = z.string().trim().min(1).max(40);

  function resolveLinkedOrder(ref: string): { orderId: string; ref: string; access: "full" | "status_only" } | null {
    const normalized = ref.trim().replace(/^#/, "").toUpperCase().slice(0, 8);
    if (!normalized) return null;
    const conversation = getConversation(ctx.conversationId);
    const match = conversation?.orders.find((order) => order.ref === normalized);
    return match ? { orderId: match.orderId, ref: match.ref, access: match.access } : null;
  }

  // Conditional assignment keeps every present key a real tool (never undefined),
  // so the agent can spread the result straight into its tool set.
  const tools: ToolSet = {};

  if (enabled.catalog) {
    tools.sendProductCards = tool({
      description:
        "Envoyer 1 à 3 cartes produit du catalogue : image, légende (nom, prix en MAD, options en stock, packs) et lien. " +
        "Utilise des slugs exacts de produits actifs. Le paramètre note est facultatif et n'est PAS envoyé : " +
        "écris ta courte ligne de texte séparément, après l'appel.",
      inputSchema: z
        .object({
          productSlugs: z.array(z.string().trim().min(1).max(200)).min(1).max(3),
          note: z.string().trim().max(300).optional(),
        })
        .strict(),
      execute: async ({ productSlugs }: { productSlugs: string[] }) =>
        guard(ctx, "sendProductCards", () => {
          const origin = publicOrigin();
          if (!origin) return { error: "unconfigured" };
          const arabic = isArabicLanguage(ctx.language);
          const day = casablancaParts(new Date()).date;
          const sent: string[] = [];
          const skipped: string[] = [];
          const seen = new Set<string>();
          for (const rawSlug of productSlugs) {
            const slug = rawSlug.trim();
            if (!slug || seen.has(slug)) continue;
            seen.add(slug);
            if (ctx.productCardsQueued >= MAX_PRODUCT_CARDS_PER_TURN) {
              skipped.push(slug);
              continue;
            }
            const product = getProductBySlug(slug);
            if (!product || !product.active) {
              skipped.push(slug);
              continue;
            }
            const image = toStorefrontCatalogProduct(product, origin).images[0] ?? null;
            const inStockVariants = product.variants.filter(
              (variant) => variant.active && availableFor(variant.id) > 0,
            );
            const options = [
              ...new Set(
                inStockVariants.flatMap((variant) => variant.options.map((o) => `${o.name}: ${o.value}`)),
              ),
            ];
            const caption = buildCardCaption({
              name: product.name,
              priceMad: product.price,
              options,
              packs: product.packs,
              url: `${origin}/produit/${product.slug}`,
              arabic,
              inStock: inStockVariants.length > 0,
            });
            // One card per product per Casablanca day per conversation (outbox dedupe).
            const enqueued = enqueueOutbox({
              dedupeKey: `card:${ctx.conversationId}:${product.slug}:${day}`,
              phone: ctx.phone,
              purpose: "product_card",
              kind: image ? "image" : "text",
              body: caption,
              mediaRef: image,
              conversationId: ctx.conversationId,
              respectWindow: false,
              countsTowardCap: false,
            });
            if (enqueued) {
              sent.push(product.slug);
              ctx.productCardsQueued += 1;
            } else {
              skipped.push(product.slug);
            }
          }
          return { sent, skipped };
        }),
    });
    tools.checkAvailability = tool({
      description:
        "Vérifier la disponibilité exacte d'une option produit (slug + valeurs d'options, insensible à la casse et aux accents). " +
        "Renvoie available et, si l'option demandée est épuisée, jusqu'à 3 variantes en stock les plus proches. " +
        "Ne promet que des options en stock.",
      inputSchema: z
        .object({
          productSlug: z.string().trim().min(1).max(200),
          options: z.array(z.string().trim().min(1).max(80)).min(1).max(6),
        })
        .strict(),
      execute: async ({ productSlug, options }: { productSlug: string; options: string[] }) =>
        guard(ctx, "checkAvailability", () => {
          const product = getProductBySlug(productSlug);
          if (!product || !product.active) return { error: "not_found" };
          const requested = [...new Set(options.map((option) => foldText(option)).filter(Boolean))];
          if (requested.length === 0) return { error: "invalid" };
          const exact = product.variants.find(
            (variant) =>
              variant.active &&
              sameFoldedValues(
                variant.options.map((option) => foldText(option.value)),
                requested,
              ),
          );
          if (exact && availableFor(exact.id) > 0) {
            return { available: true, alternatives: [] as RankedVariant[] };
          }
          return {
            available: false,
            alternatives: rankedInStock(product, options, 3),
          };
        }),
    });
    tools.matchProductPhoto = tool({
      description:
        "Retrouver le produit du catalogue qui correspond à la photo du client, à partir de TA description de la photo. " +
        "Si match est null, ne devine jamais : dis honnêtement que tu n'es pas sûr et demande le nom du produit ou son lien.",
      inputSchema: z.object({ description: z.string().trim().min(3).max(1000) }).strict(),
      execute: async ({ description }: { description: string }) =>
        guard(ctx, "matchProductPhoto", () => {
          const tokens = tokenize(description);
          if (tokens.length === 0) return { match: null };
          const ranked = listStorefront()
            .map((product) => ({ product, score: photoScore(tokens, product) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);
          const best = ranked[0];
          if (!best || best.score < PHOTO_MATCH_THRESHOLD) {
            return { match: null };
          }
          const origin = publicOrigin() ?? "";
          const toCandidate = (entry: { product: StorefrontProductView; score: number }) => ({
            slug: entry.product.slug,
            name: entry.product.name,
            priceMad: entry.product.price,
            url: `${origin}/produit/${entry.product.slug}`,
            score: Math.round(entry.score * 100) / 100,
          });
          return {
            match: toCandidate(best),
            candidates: ranked.filter((entry) => entry.score > 0).map(toCandidate),
          };
        }),
    });
  }

  if (enabled.editProposals) {
    tools.proposeOrderEdit = tool({
      description:
        "Proposer la modification d'une commande liée NON confirmée (accès complet uniquement) : variantes et quantités. " +
        "C'est une proposition : un conseiller la validera. Ne calcule et n'annonce JAMAIS de prix ou de total pour cette modification ; " +
        "dis au client que le nouveau total sera confirmé par un conseiller.",
      inputSchema: z
        .object({
          ref: refSchema,
          lines: z
            .array(
              z
                .object({
                  variantId: z.string().trim().min(1).max(100),
                  qty: z.number().int().min(1).max(10),
                })
                .strict(),
            )
            .min(1)
            .max(10),
          summary: z.string().trim().min(1).max(500),
        })
        .strict(),
      execute: async ({
        ref,
        lines,
        summary,
      }: {
        ref: string;
        lines: Array<{ variantId: string; qty: number }>;
        summary: string;
      }) =>
        guard(ctx, "proposeOrderEdit", () => {
          const linked = resolveLinkedOrder(ref);
          if (!linked) return { error: "not_linked" };
          if (linked.access !== "full") return { error: "not_allowed" };

          const unknownVariant = lines.find((line) => {
            const variant = getVariantById(line.variantId);
            return !variant || !variant.active || !variant.productActive;
          });
          if (unknownVariant) return { error: "invalid" };

          const insufficient = lines.filter((line) => availableFor(line.variantId) < line.qty);
          if (insufficient.length > 0) {
            const alternatives: RankedVariant[] = [];
            for (const line of insufficient) {
              const variant = getVariantById(line.variantId);
              if (!variant) continue;
              // Closest in-stock variants of the same product; a partially stocked
              // variant ranks first, so the model can retry with a lower quantity.
              for (const alternative of rankedInStock(
                variant.product,
                variant.options.map((option) => option.value),
                2,
              )) {
                if (!alternatives.some((entry) => entry.variantId === alternative.variantId)) {
                  alternatives.push(alternative);
                }
              }
            }
            return { error: "out_of_stock", alternatives: alternatives.slice(0, 3) };
          }

          try {
            // Staging only: no handoff (the AI keeps the conversation), no price,
            // and the pending proposal waits for a human on the order page.
            createProposal({
              orderId: linked.orderId,
              conversationId: ctx.conversationId,
              kind: "edit",
              lines: lines.map((line) => ({ variantId: line.variantId, qty: line.qty })),
              summary,
            });
            return { proposed: true };
          } catch (err) {
            if (err instanceof StagingError) {
              if (err.status === 409) return { error: "already_confirmed" };
              if (err.status === 404) return { error: "not_found" };
              return { error: "invalid" };
            }
            return { error: "failed" };
          }
        }),
    });
  }

  if (enabled.crossSell) {
    tools.suggestCrossSell = tool({
      description:
        "Proposer UN produit complémentaire en stock (au maximum une fois par conversation) : nom, prix en MAD et lien. " +
        "À utiliser seulement après avoir répondu à la question du client, et sans insister.",
      inputSchema: z.object({ productSlug: z.string().trim().min(1).max(200) }).strict(),
      execute: async ({ productSlug }: { productSlug: string }) =>
        guard(ctx, "suggestCrossSell", () => {
          const anchor = getProductBySlug(productSlug);
          if (!anchor || !anchor.active) return { error: "not_found" };
          const db = getDb();
          const key = `${CROSS_SELL_KEY_PREFIX}${ctx.conversationId}`;
          // Atomic one-shot claim: at most one suggestion per conversation.
          const claim = db
            .prepare(
              "INSERT INTO app_state (key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING",
            )
            .run(key);
          if (claim.changes === 0) return { error: "already_suggested" };
          const candidates = listStorefront().filter(
            (product) =>
              product.id !== anchor.id && product.variants.some((variant) => variant.available),
          );
          const pick =
            candidates.find((product) => product.category === anchor.category) ?? candidates[0];
          if (!pick) {
            // Nothing available now: release the claim so a later turn can retry.
            db.prepare("DELETE FROM app_state WHERE key = ?").run(key);
            return { error: "none" };
          }
          const origin = publicOrigin() ?? "";
          return {
            suggested: {
              name: pick.name,
              priceMad: pick.price,
              url: `${origin}/produit/${pick.slug}`,
            },
          };
        }),
    });
  }

  return tools;
}
