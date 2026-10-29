import { tool } from "ai";
import { z } from "@/lib/validation";
import { getDb } from "@/lib/db";
import { listStorefront } from "@/lib/services/catalog";
import { availableFor } from "@/lib/services/inventory";
import { flagHandoff, getConversation } from "@/lib/services/whatsapp-conversations";
import {
  createProposal,
  createRequest,
  getDraft,
  markReadyToConfirm,
  StagingError,
  upsertDraft,
} from "@/lib/services/whatsapp-staging";
import { orderRefFromOrderId } from "@/lib/whatsapp/phone";

/** Hard cap of tool invocations per agent turn; extra calls receive { error: "budget" }. */
export const MAX_TOOL_CALLS_PER_TURN = 8;

/**
 * Per-turn context shared by every tool. `toolCalls` is filled by the budget guard so
 * the agent can report which tools ran and detect handoffs.
 */
export interface WhatsAppToolsContext {
  conversationId: string;
  /** Normalized customer phone from the conversation row (needed for purchase requests). */
  phone: string;
  /** Tool names invoked this turn, in order (mutated by the guard). */
  toolCalls: string[];
}

type OrderAccess = "full" | "status_only";

interface LinkedOrder {
  orderId: string;
  ref: string;
  access: OrderAccess;
}

interface OrderSnapshotRow {
  id: string;
  created_at: string;
  confirmation_status: string;
  delivery_outcome: string | null;
  items_json: string;
  total: number;
}

/** Folds a string for case- and accent-insensitive search (dashes become spaces). */
function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
    .trim();
}

function publicBaseUrl(): string {
  return (process.env.CRM_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
}

/** Public tracking stage, mirroring order-tracking-lookup.ts without its phone gate. */
function stageOf(order: { confirmation_status: string; delivery_outcome: string | null }, submitted: boolean): string {
  if (order.confirmation_status === "cancelled") return "cancelled";
  if (order.delivery_outcome === "delivered") return "delivered";
  if (order.delivery_outcome === "refused") return "refused";
  if (submitted) return "shipped";
  if (order.confirmation_status === "confirmed") return "confirmed";
  return "received";
}

function summarizeItems(json: string): string {
  try {
    const items = JSON.parse(json) as Array<{ name?: string; quantity?: number; variant_label?: string }>;
    return items
      .map((it) => `${it.name ?? "?"} ×${it.quantity ?? 1}${it.variant_label ? ` (${it.variant_label})` : ""}`)
      .join(" · ");
  } catch {
    return "";
  }
}

function getOrderSnapshot(orderId: string): OrderSnapshotRow | null {
  const row = getDb()
    .prepare(
      "SELECT id, created_at, confirmation_status, delivery_outcome, items_json, total FROM orders WHERE id = ?",
    )
    .get(orderId) as OrderSnapshotRow | undefined;
  return row ?? null;
}

function getTrackingNumber(orderId: string): string | null {
  const row = getDb()
    .prepare(
      "SELECT tracking_number FROM courier_submissions WHERE order_id = ? AND status = 'submitted' ORDER BY created_at DESC LIMIT 1",
    )
    .get(orderId) as { tracking_number: string | null } | undefined;
  return row?.tracking_number ?? null;
}

/**
 * Builds the CRM-scoped tool set for one WhatsApp agent turn.
 * Every output is compact JSON treated as untrusted data by the model, and never
 * contains customer address, phone or name — even for full-access orders.
 */
export function createWhatsAppTools(ctx: WhatsAppToolsContext) {
  const refSchema = z.string().trim().min(1).max(40);

  function guard<T>(name: string, fn: () => T): T | { error: string } {
    if (ctx.toolCalls.length >= MAX_TOOL_CALLS_PER_TURN) {
      return { error: "budget" };
    }
    ctx.toolCalls.push(name);
    return fn();
  }

  function resolveLinkedOrder(ref: string): LinkedOrder | null {
    const normalized = ref.trim().replace(/^#/, "").toUpperCase().slice(0, 8);
    if (!normalized) return null;
    const conversation = getConversation(ctx.conversationId);
    const match = conversation?.orders.find((o) => o.ref === normalized);
    return match ? { orderId: match.orderId, ref: match.ref, access: match.access } : null;
  }

  /**
   * Whitelisted order view. status_only orders expose ref, stage and tracking only;
   * full access adds the creation date, items summary and total. Never any address,
   * phone or customer name.
   */
  function describeOrder(orderId: string, access: OrderAccess) {
    const order = getOrderSnapshot(orderId);
    if (!order) return null;
    const ref = orderRefFromOrderId(orderId);
    const trackingNumber = getTrackingNumber(orderId);
    const base = {
      ref,
      stage: stageOf(order, trackingNumber !== null),
      ...(trackingNumber ? { trackingNumber } : {}),
      suiviUrl: `${publicBaseUrl()}/suivi?ref=${ref}`,
    };
    if (access === "status_only") return base;
    return {
      ...base,
      createdAt: order.created_at,
      itemsSummary: summarizeItems(order.items_json),
      totalMad: order.total,
    };
  }

  function mapStagingError(err: unknown, conflictError: string): { error: string } {
    if (err instanceof StagingError) {
      if (err.status === 409) return { error: conflictError };
      if (err.status === 404) return { error: "not_found" };
      return { error: "invalid" };
    }
    return { error: "failed" };
  }

  return {
    listMyOrders: tool({
      description:
        "Lister les commandes liées à cette conversation. Les commandes en accès complet affichent la date, le résumé des articles, le total en MAD et le numéro de suivi ; les commandes en accès « statut seul » n'exposent que la référence, l'étape et le numéro de suivi.",
      inputSchema: z.object({}).strict(),
      execute: async () =>
        guard("listMyOrders", () => {
          const conversation = getConversation(ctx.conversationId);
          const orders = (conversation?.orders ?? [])
            .map((o) => describeOrder(o.orderId, o.access))
            .filter(Boolean);
          return { orders };
        }),
    }),

    orderStatus: tool({
      description:
        "Lire le statut d'une commande à partir de sa référence à 8 caractères. La commande doit être liée à cette conversation. Respecte les niveaux d'accès : pour un accès « statut seul », ne donne que l'étape et le suivi.",
      inputSchema: z.object({ ref: refSchema }).strict(),
      execute: async ({ ref }: { ref: string }) =>
        guard("orderStatus", () => {
          const linked = resolveLinkedOrder(ref);
          if (!linked) return { error: "not_linked" };
          const snapshot = describeOrder(linked.orderId, linked.access);
          if (!snapshot) return { error: "not_linked" };
          return snapshot;
        }),
    }),

    saveAddress: tool({
      description:
        "Enregistrer l'adresse et/ou la ville de livraison d'une commande liée (accès complet uniquement). cityMatched indique si la ville a été reconnue dans la liste des villes livrables.",
      inputSchema: z
        .object({
          ref: refSchema,
          address: z.string().trim().min(5).max(500).optional(),
          city: z.string().trim().min(1).max(80).optional(),
        })
        .strict()
        .refine((v) => v.address !== undefined || v.city !== undefined, "Adresse ou ville requise."),
      execute: async ({ ref, address, city }: { ref: string; address?: string; city?: string }) =>
        guard("saveAddress", () => {
          const linked = resolveLinkedOrder(ref);
          if (!linked) return { error: "not_linked" };
          if (linked.access !== "full") return { error: "not_allowed" };
          try {
            upsertDraft(linked.orderId, ctx.conversationId, {
              ...(address !== undefined ? { address } : {}),
              ...(city !== undefined ? { cityName: city } : {}),
            });
            const draft = getDraft(linked.orderId);
            return { saved: true, cityMatched: Boolean(draft?.cityId) };
          } catch (err) {
            return mapStagingError(err, "already_confirmed");
          }
        }),
    }),

    markReadyToConfirm: tool({
      description:
        "Marquer une commande liée comme prête à confirmer (accès complet uniquement). Nécessite une adresse et une ville enregistrées. Préviens ensuite le client qu'un conseiller va l'appeler pour confirmer.",
      inputSchema: z.object({ ref: refSchema }).strict(),
      execute: async ({ ref }: { ref: string }) =>
        guard("markReadyToConfirm", () => {
          const linked = resolveLinkedOrder(ref);
          if (!linked) return { error: "not_linked" };
          if (linked.access !== "full") return { error: "not_allowed" };
          try {
            const result = markReadyToConfirm(linked.orderId);
            return result.ok ? { ok: true } : { ok: false, missing: result.missing };
          } catch (err) {
            return mapStagingError(err, "already_confirmed");
          }
        }),
    }),

    requestCancellation: tool({
      description:
        "Enregistrer une demande d'annulation pour une commande liée (accès complet uniquement). C'est une demande : un conseiller la traitera. Passe la main à un conseiller après l'appel.",
      inputSchema: z.object({ ref: refSchema, reason: z.string().trim().min(1).max(300) }).strict(),
      execute: async ({ ref, reason }: { ref: string; reason: string }) =>
        guard("requestCancellation", () => {
          const linked = resolveLinkedOrder(ref);
          if (!linked) return { error: "not_linked" };
          if (linked.access !== "full") return { error: "not_allowed" };
          try {
            createProposal({
              orderId: linked.orderId,
              conversationId: ctx.conversationId,
              kind: "cancel",
              reason,
              summary: `Demande d'annulation WhatsApp : ${reason}`.slice(0, 500),
            });
            flagHandoff(ctx.conversationId, "demande d'annulation");
            return { ok: true };
          } catch (err) {
            return mapStagingError(err, "already_cancelled");
          }
        }),
    }),

    findProducts: tool({
      description:
        "Chercher des produits actifs du catalogue par nom ou catégorie. Renvoie le prix officiel en MAD, les options disponibles (uniquement les variantes en stock), les packs de quantité et le lien produit. Les prix et packs viennent du serveur : ne les invente jamais et n'accorde aucune remise.",
      inputSchema: z.object({ query: z.string().trim().min(1).max(100) }).strict(),
      execute: async ({ query }: { query: string }) =>
        guard("findProducts", () => {
          const needle = foldText(query);
          if (!needle) return { products: [] };
          const needleCompact = needle.replace(/ /g, "");
          const base = publicBaseUrl();
          const products = listStorefront()
            .filter((p) => {
              const hay = foldText(`${p.name} ${p.category}`);
              return hay.includes(needle) || hay.replace(/ /g, "").includes(needleCompact);
            })
            .slice(0, 5)
            .map((p) => {
              const inStock = p.variants.filter((v) => availableFor(v.id) > 0);
              return {
                name: p.name,
                priceMad: p.price,
                options: [...new Set(inStock.flatMap((v) => v.options.map((o) => `${o.name}: ${o.value}`)))],
                packs: p.packs.map((pack) => `${pack.quantity} pour ${pack.price} DH`),
                url: `${base}/produit/${p.slug}`,
                variants: inStock.map((v) => ({ variantId: v.id, label: v.label })),
              };
            })
            .filter((p) => p.variants.length > 0);
          return { products };
        }),
    }),

    createPurchaseRequest: tool({
      description:
        "Créer une demande d'achat manuelle, uniquement si le client refuse de commander sur le site. Rassemble le nom du client, les articles (variantId, quantité, libellé), la ville et l'adresse.",
      inputSchema: z
        .object({
          customerName: z.string().trim().min(1).max(80),
          items: z
            .array(
              z
                .object({
                  variantId: z.string().trim().min(1).max(100),
                  qty: z.number().int().min(1).max(10),
                  label: z.string().trim().min(1).max(120),
                })
                .strict(),
            )
            .min(1)
            .max(10),
          city: z.string().trim().min(1).max(80).optional(),
          address: z.string().trim().min(5).max(500).optional(),
        })
        .strict(),
      execute: async (input: {
        customerName: string;
        items: Array<{ variantId: string; qty: number; label: string }>;
        city?: string;
        address?: string;
      }) =>
        guard("createPurchaseRequest", () => {
          try {
            createRequest({
              conversationId: ctx.conversationId,
              phone: ctx.phone,
              customerName: input.customerName,
              items: input.items,
              cityName: input.city,
              address: input.address,
            });
            return { ok: true };
          } catch (err) {
            return mapStagingError(err, "conflict");
          }
        }),
    }),

    handoffToHuman: tool({
      description:
        "Passer la main à un conseiller humain : réclamation, produit endommagé, remboursement, client en colère, demande explicite d'un humain, confusion répétée, ou toute question que la FAQ et les outils ne permettent pas de résoudre.",
      inputSchema: z.object({ reason: z.string().trim().min(1).max(300) }).strict(),
      execute: async ({ reason }: { reason: string }) =>
        guard("handoffToHuman", () => {
          flagHandoff(ctx.conversationId, reason.slice(0, 120));
          return { ok: true };
        }),
    }),
  };
}
