import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import { getVariantById } from "@/lib/services/catalog";
import { getOrderEditState, editOrder, OrderEditError } from "@/lib/services/order-edits";
import { cancelOrder, ConfirmationError } from "@/lib/services/confirmation";
import { listCities } from "@/lib/services/orders";

export interface OrderDraft {
  orderId: string;
  conversationId: string | null;
  address: string | null;
  cityId: number | null;
  cityName: string | null;
  note: string | null;
  readyToConfirm: boolean;
  updatedAt: string;
}

export interface WaProposal {
  id: string;
  orderId: string;
  conversationId: string | null;
  kind: "edit" | "cancel";
  payload: unknown;
  summary: string;
  status: "pending" | "approved" | "rejected" | "superseded" | "failed";
  decidedBy: string | null;
  decidedAt: string | null;
  resultNote: string | null;
  createdAt: string;
}

export interface WaRequest {
  id: string;
  conversationId: string;
  phone: string;
  customerName: string | null;
  items: Array<{ variantId: string; qty: number; label: string }>;
  cityName: string | null;
  address: string | null;
  status: "open" | "converted" | "dismissed";
  orderId: string | null;
  handledBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export class StagingError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "StagingError";
  }
}

interface OrderDraftRow {
  order_id: string;
  conversation_id: string | null;
  address: string | null;
  city_id: number | null;
  city_name: string | null;
  note: string | null;
  ready_to_confirm: number;
  updated_at: string;
}

interface ProposalRow {
  id: string;
  order_id: string;
  conversation_id: string | null;
  kind: "edit" | "cancel";
  payload_json: string;
  summary: string;
  status: "pending" | "approved" | "rejected" | "superseded" | "failed";
  decided_by: string | null;
  decided_at: string | null;
  result_note: string | null;
  created_at: string;
}

interface RequestRow {
  id: string;
  conversation_id: string;
  phone: string;
  customer_name: string | null;
  items_json: string;
  city_name: string | null;
  address: string | null;
  status: "open" | "converted" | "dismissed";
  order_id: string | null;
  handled_by: string | null;
  created_at: string;
  updated_at: string;
}

function mapDraftRow(row: OrderDraftRow): OrderDraft {
  return {
    orderId: row.order_id,
    conversationId: row.conversation_id,
    address: row.address,
    cityId: row.city_id,
    cityName: row.city_name,
    note: row.note,
    readyToConfirm: row.ready_to_confirm === 1,
    updatedAt: row.updated_at,
  };
}

function mapProposalRow(row: ProposalRow): WaProposal {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = null;
  }
  return {
    id: row.id,
    orderId: row.order_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    payload,
    summary: row.summary,
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    resultNote: row.result_note,
    createdAt: row.created_at,
  };
}

function mapRequestRow(row: RequestRow): WaRequest {
  let items: Array<{ variantId: string; qty: number; label: string }> = [];
  try {
    items = JSON.parse(row.items_json);
  } catch {
    items = [];
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    phone: row.phone,
    customerName: row.customer_name,
    items,
    cityName: row.city_name,
    address: row.address,
    status: row.status,
    orderId: row.order_id,
    handledBy: row.handled_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Normalizes city names for comparison: lowercase, strip accents/diacritics,
 * strip leading "ville de", collapse hyphens/underscores/spaces, strip tatweel/tashkeel.
 */
export function normalizeCityName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0640\u064B-\u065F]/g, "")
    .toLowerCase()
    .trim()
    .replace(/^ville\s+de\s+/i, "")
    .replace(/[\s\-_]+/g, " ")
    .trim();
}

function assertOrderDraftable(orderId: string): void {
  const row = getDb().prepare(
    "SELECT confirmation_status, archived_at FROM orders WHERE id = ?",
  ).get(orderId) as { confirmation_status: string; archived_at: string | null } | undefined;

  if (!row) {
    throw new StagingError(404, "Commande introuvable.");
  }
  if (row.archived_at || !["new", "no_answer", "call_back_later"].includes(row.confirmation_status)) {
    throw new StagingError(409, "Commande déjà confirmée ou annulée");
  }
}

// ---------------------------------------------------------------------------
// Order Drafts
// ---------------------------------------------------------------------------

export function getDraft(orderId: string): OrderDraft | null {
  const row = getDb().prepare(
    "SELECT * FROM wa_order_drafts WHERE order_id = ?",
  ).get(orderId) as OrderDraftRow | undefined;
  return row ? mapDraftRow(row) : null;
}

export function upsertDraft(
  orderId: string,
  conversationId: string | null,
  patch: { address?: string; cityName?: string; note?: string },
): OrderDraft {
  const db = getDb();
  return db.transaction(() => {
    assertOrderDraftable(orderId);
    if (conversationId !== null) {
      const conv = db.prepare("SELECT id FROM wa_conversations WHERE id = ?").get(conversationId);
      if (!conv) throw new StagingError(404, "Conversation introuvable.");
    }

    let nextAddress: string | undefined = undefined;
    if (patch.address !== undefined) {
      const trimmed = patch.address.trim();
      if (trimmed.length < 5 || trimmed.length > 500) {
        throw new StagingError(400, "L'adresse doit comporter entre 5 et 500 caractères.");
      }
      nextAddress = trimmed;
    }

    let nextCityId: number | null | undefined = undefined;
    let nextCityName: string | null | undefined = undefined;
    if (patch.cityName !== undefined) {
      const trimmedCity = patch.cityName.trim();
      if (trimmedCity.length > 80) {
        throw new StagingError(400, "Le nom de la ville ne peut pas dépasser 80 caractères.");
      }
      if (trimmedCity.length === 0) {
        nextCityId = null;
        nextCityName = null;
      } else {
        const cities = listCities();
        const normInput = normalizeCityName(trimmedCity);
        const matched = cities.find((c) => {
          if (normalizeCityName(c.name) === normInput) return true;
          if (c.arabicName && normalizeCityName(c.arabicName) === normInput) return true;
          return false;
        });
        if (matched) {
          nextCityId = matched.id;
          nextCityName = matched.name;
        } else {
          nextCityId = null;
          nextCityName = trimmedCity;
        }
      }
    }

    let nextNote: string | null | undefined = undefined;
    if (patch.note !== undefined) {
      nextNote = patch.note.trim() || null;
    }

    const existing = getDraft(orderId);
    const now = new Date().toISOString();

    if (existing) {
      const finalAddress = nextAddress !== undefined ? nextAddress : existing.address;
      const finalCityId = nextCityId !== undefined ? nextCityId : existing.cityId;
      const finalCityName = nextCityName !== undefined ? nextCityName : existing.cityName;
      const finalNote = nextNote !== undefined ? nextNote : existing.note;
      const finalConvId = conversationId !== undefined ? conversationId : existing.conversationId;
      const finalReady = existing.readyToConfirm && finalAddress && finalCityId !== null ? 1 : 0;

      db.prepare(`UPDATE wa_order_drafts SET
        conversation_id = ?, address = ?, city_id = ?, city_name = ?, note = ?,
        ready_to_confirm = ?, updated_at = ?
        WHERE order_id = ?`).run(
        finalConvId,
        finalAddress,
        finalCityId,
        finalCityName,
        finalNote,
        finalReady,
        now,
        orderId,
      );
    } else {
      const finalAddress = nextAddress !== undefined ? nextAddress : null;
      const finalCityId = nextCityId !== undefined ? nextCityId : null;
      const finalCityName = nextCityName !== undefined ? nextCityName : null;
      const finalNote = nextNote !== undefined ? nextNote : null;

      db.prepare(`INSERT INTO wa_order_drafts (
        order_id, conversation_id, address, city_id, city_name, note, ready_to_confirm, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`).run(
        orderId,
        conversationId,
        finalAddress,
        finalCityId,
        finalCityName,
        finalNote,
        now,
      );
    }

    return getDraft(orderId)!;
  }).immediate();
}

export function markReadyToConfirm(
  orderId: string,
): { ok: true } | { ok: false; missing: Array<"address" | "city"> } {
  const db = getDb();
  // Explicit callback return type: keeps `ok` a literal instead of widening to boolean.
  type ReadyResult = { ok: true } | { ok: false; missing: Array<"address" | "city"> };
  return db.transaction((): ReadyResult => {
    assertOrderDraftable(orderId);

    const draft = getDraft(orderId);
    const missing: Array<"address" | "city"> = [];
    if (!draft?.address || draft.address.trim().length < 5) {
      missing.push("address");
    }
    if (!draft || draft.cityId === null) {
      missing.push("city");
    }

    if (missing.length > 0) {
      return { ok: false, missing };
    }

    const now = new Date().toISOString();
    db.prepare("UPDATE wa_order_drafts SET ready_to_confirm = 1, updated_at = ? WHERE order_id = ?").run(
      now,
      orderId,
    );
    return { ok: true };
  }).immediate();
}

export function clearDraft(orderId: string): void {
  getDb().prepare("DELETE FROM wa_order_drafts WHERE order_id = ?").run(orderId);
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

function getProposalRow(id: string): ProposalRow | null {
  const row = getDb().prepare(
    "SELECT * FROM wa_proposals WHERE id = ?",
  ).get(id) as ProposalRow | undefined;
  return row ?? null;
}

export function getProposal(id: string): WaProposal | null {
  const row = getProposalRow(id);
  return row ? mapProposalRow(row) : null;
}

export function createProposal(input: {
  orderId: string;
  conversationId: string | null;
  kind: "edit" | "cancel";
  lines?: Array<{ variantId: string; qty: number }>;
  reason?: string;
  summary: string;
}): WaProposal {
  const db = getDb();
  return db.transaction(() => {
    if (!input.summary?.trim()) {
      throw new StagingError(400, "Le résumé est requis.");
    }
    if (input.summary.trim().length > 500) {
      throw new StagingError(400, "Le résumé ne peut pas dépasser 500 caractères.");
    }

    let payload: Record<string, unknown>;

    if (input.kind === "edit") {
      let state: ReturnType<typeof getOrderEditState>;
      try {
        state = getOrderEditState(input.orderId);
      } catch (err) {
        if (err instanceof OrderEditError) {
          throw new StagingError(err.status, err.message);
        }
        throw err;
      }
      if (!state.editable) {
        throw new StagingError(409, "Modification impossible : commande confirmée, annulée, archivée ou déjà prise en charge.");
      }

      if (!input.lines || !Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 10) {
        throw new StagingError(400, "Une proposition de modification doit comporter entre 1 et 10 articles.");
      }

      for (const line of input.lines) {
        if (!line.variantId) {
          throw new StagingError(400, "Identifiant de variante requis.");
        }
        if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > 10) {
          throw new StagingError(400, "La quantité doit être comprise entre 1 et 10.");
        }
        const variant = getVariantById(line.variantId);
        if (!variant || !variant.active || !variant.productActive) {
          throw new StagingError(400, "Une ou plusieurs variantes ne sont plus disponibles.");
        }
      }

      payload = {
        lines: input.lines.map((l) => ({ variantId: l.variantId, qty: l.qty })),
        revision: state.revision,
      };
      if (input.reason?.trim()) {
        payload.reason = input.reason.trim();
      }
    } else if (input.kind === "cancel") {
      const orderRow = db.prepare(
        "SELECT confirmation_status FROM orders WHERE id = ?",
      ).get(input.orderId) as { confirmation_status: string } | undefined;
      if (!orderRow) {
        throw new StagingError(404, "Commande introuvable.");
      }
      if (orderRow.confirmation_status === "cancelled") {
        throw new StagingError(409, "Cette commande est déjà annulée.");
      }

      if (!input.reason?.trim()) {
        throw new StagingError(400, "Le motif d'annulation est requis.");
      }
      if (input.reason.trim().length > 300) {
        throw new StagingError(400, "Le motif d'annulation ne peut pas dépasser 300 caractères.");
      }

      payload = {
        reason: input.reason.trim(),
      };
    } else {
      throw new StagingError(400, "Type de proposition invalide.");
    }

    // Any previous pending proposal of same kind for the order -> status 'superseded'
    db.prepare(
      "UPDATE wa_proposals SET status = 'superseded' WHERE order_id = ? AND kind = ? AND status = 'pending'",
    ).run(input.orderId, input.kind);

    const id = `prop_${nanoid(16)}`;
    const now = new Date().toISOString();

    db.prepare(`INSERT INTO wa_proposals (
      id, order_id, conversation_id, kind, payload_json, summary, status,
      decided_by, decided_at, result_note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?)`).run(
      id,
      input.orderId,
      input.conversationId,
      input.kind,
      JSON.stringify(payload),
      input.summary.trim(),
      now,
    );

    return getProposal(id)!;
  }).immediate();
}

export function listProposals(orderId: string, status?: string): WaProposal[] {
  const db = getDb();
  const rows = status
    ? (db.prepare(
        "SELECT * FROM wa_proposals WHERE order_id = ? AND status = ? ORDER BY created_at DESC",
      ).all(orderId, status) as ProposalRow[])
    : (db.prepare(
        "SELECT * FROM wa_proposals WHERE order_id = ? ORDER BY created_at DESC",
      ).all(orderId) as ProposalRow[]);
  return rows.map(mapProposalRow);
}

export function listPendingProposals(): WaProposal[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM wa_proposals WHERE status = 'pending' ORDER BY created_at DESC",
  ).all() as ProposalRow[];
  return rows.map(mapProposalRow);
}

export function approveProposal(
  id: string,
  actor: { id: string; name?: string | null },
): WaProposal {
  const db = getDb();
  // The order mutation (editOrder/cancelOrder) runs in its own savepoint: when it
  // fails, its rollback leaves the order untouched while the proposal is marked
  // `failed` and the failure message is rethrown as a staging conflict.
  const failureMessage = db.transaction((): string | null => {
    const proposal = getProposalRow(id);
    if (!proposal) {
      throw new StagingError(404, "Proposition introuvable.");
    }
    if (proposal.status !== "pending") {
      throw new StagingError(409, "Cette proposition n'est plus en attente.");
    }

    let payload: { lines?: Array<{ variantId: string; qty: number }>; revision?: string; reason?: string };
    try {
      payload = JSON.parse(proposal.payload_json);
    } catch {
      throw new StagingError(400, "Proposition invalide.");
    }

    const now = new Date().toISOString();
    try {
      if (proposal.kind === "edit") {
        if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
          throw new StagingError(400, "Proposition invalide.");
        }
        const state = getOrderEditState(proposal.order_id);
        const isPack = state.snapshot.discountMode === "pack";
        editOrder(proposal.order_id, {
          // Revision captured when the AI made the proposal: if the order changed
          // since, editOrder rejects it and the proposal fails instead of clobbering
          // the concurrent change.
          revision: typeof payload.revision === "string" ? payload.revision : state.revision,
          // The proposal only covers regular lines: accepted upsell lines are carried over
          // with their index so editOrder keeps their stored discounted price.
          lines: [
            ...payload.lines.map((l) => ({ variantId: l.variantId, qty: l.qty })),
            ...state.snapshot.upsellItems.map((item, upsellIndex) => ({
              variantId: item.variant_id,
              qty: item.quantity,
              upsellIndex,
            })),
          ],
          discountMode: isPack ? "pack" : (state.snapshot.discountMode ?? "manual"),
          discountType: isPack ? "none" : state.snapshot.discountType,
          discountValue: isPack ? 0 : state.snapshot.discountValue,
          shippingMode: state.snapshot.shippingMode,
          reason: "Proposition WhatsApp approuvée",
        }, actor);
      } else if (proposal.kind === "cancel") {
        const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
        cancelOrder(proposal.order_id, {
          reason: `Demande client WhatsApp : ${reason || "demande du client"}`,
        }, actor);
      } else {
        throw new StagingError(400, "Type de proposition inconnu.");
      }
    } catch (err) {
      if (err instanceof OrderEditError || err instanceof ConfirmationError) {
        db.prepare(
          "UPDATE wa_proposals SET status = 'failed', decided_by = ?, decided_at = ?, result_note = ? WHERE id = ?",
        ).run(actor.id, now, err.message, id);
        return err.message;
      }
      throw err;
    }

    db.prepare(
      "UPDATE wa_proposals SET status = 'approved', decided_by = ?, decided_at = ?, result_note = NULL WHERE id = ?",
    ).run(actor.id, now, id);
    return null;
  }).immediate();

  if (failureMessage !== null) {
    throw new StagingError(409, failureMessage);
  }
  return getProposal(id)!;
}

export function rejectProposal(
  id: string,
  actor: { id: string; name?: string | null },
  note?: string,
): WaProposal {
  const db = getDb();
  return db.transaction(() => {
    const proposal = getProposalRow(id);
    if (!proposal) {
      throw new StagingError(404, "Proposition introuvable.");
    }
    if (proposal.status !== "pending") {
      throw new StagingError(409, "Cette proposition n'est plus en attente.");
    }

    const now = new Date().toISOString();
    db.prepare(
      "UPDATE wa_proposals SET status = 'rejected', decided_by = ?, decided_at = ?, result_note = ? WHERE id = ?",
    ).run(actor.id, now, note?.trim() || null, id);
    return getProposal(id)!;
  }).immediate();
}

// ---------------------------------------------------------------------------
// WhatsApp Requests
// ---------------------------------------------------------------------------

export function getRequest(id: string): WaRequest | null {
  const row = getDb().prepare(
    "SELECT * FROM wa_requests WHERE id = ?",
  ).get(id) as RequestRow | undefined;
  return row ? mapRequestRow(row) : null;
}

export function createRequest(input: {
  conversationId: string;
  phone: string;
  customerName?: string;
  items: Array<{ variantId: string; qty: number; label: string }>;
  cityName?: string;
  address?: string;
}): WaRequest {
  const db = getDb();
  return db.transaction(() => {
    if (!input.conversationId?.trim()) {
      throw new StagingError(400, "L'identifiant de conversation est requis.");
    }
    if (!input.phone?.trim()) {
      throw new StagingError(400, "Le numéro de téléphone est requis.");
    }
    const convId = input.conversationId.trim();
    const conv = db.prepare("SELECT id FROM wa_conversations WHERE id = ?").get(convId);
    if (!conv) {
      throw new StagingError(404, "Conversation introuvable.");
    }
    if (!input.items || !Array.isArray(input.items) || input.items.length === 0 || input.items.length > 10) {
      throw new StagingError(400, "Une demande doit comporter entre 1 et 10 articles.");
    }

    const items: Array<{ variantId: string; qty: number; label: string }> = [];
    for (const item of input.items) {
      if (!item.variantId) {
        throw new StagingError(400, "Identifiant de variante requis.");
      }
      if (!Number.isInteger(item.qty) || item.qty < 1 || item.qty > 10) {
        throw new StagingError(400, "La quantité doit être comprise entre 1 et 10.");
      }
      if (!item.label?.trim() || item.label.trim().length > 120) {
        throw new StagingError(400, "Le libellé de l'article est requis (120 caractères maximum).");
      }
      const variant = getVariantById(item.variantId);
      if (!variant || !variant.active || !variant.productActive) {
        throw new StagingError(400, "Une ou plusieurs variantes ne sont plus disponibles.");
      }
      items.push({
        variantId: item.variantId,
        qty: item.qty,
        label: item.label.trim(),
      });
    }

    const existing = db.prepare(
      "SELECT id FROM wa_requests WHERE conversation_id = ? AND status = 'open' LIMIT 1",
    ).get(input.conversationId.trim()) as { id: string } | undefined;

    const now = new Date().toISOString();

    if (existing) {
      db.prepare(`UPDATE wa_requests SET
        phone = ?, customer_name = ?, items_json = ?, city_name = ?, address = ?, updated_at = ?
        WHERE id = ?`).run(
        input.phone.trim(),
        input.customerName?.trim() || null,
        JSON.stringify(items),
        input.cityName?.trim() || null,
        input.address?.trim() || null,
        now,
        existing.id,
      );
      return getRequest(existing.id)!;
    }

    const id = `req_${nanoid(16)}`;
    db.prepare(`INSERT INTO wa_requests (
      id, conversation_id, phone, customer_name, items_json, city_name, address,
      status, order_id, handled_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, ?)`).run(
      id,
      input.conversationId.trim(),
      input.phone.trim(),
      input.customerName?.trim() || null,
      JSON.stringify(items),
      input.cityName?.trim() || null,
      input.address?.trim() || null,
      now,
      now,
    );

    return getRequest(id)!;
  }).immediate();
}

export function listOpenRequests(): WaRequest[] {
  const rows = getDb().prepare(
    "SELECT * FROM wa_requests WHERE status = 'open' ORDER BY created_at DESC",
  ).all() as RequestRow[];
  return rows.map(mapRequestRow);
}

export function convertRequest(id: string, orderId: string, userId: string): void {
  const db = getDb();
  db.transaction(() => {
    const req = db.prepare("SELECT status FROM wa_requests WHERE id = ?").get(id) as { status: string } | undefined;
    if (!req) {
      throw new StagingError(404, "Demande introuvable.");
    }
    if (req.status !== "open") {
      throw new StagingError(409, "Cette demande n'est plus ouverte.");
    }

    const order = db.prepare("SELECT id FROM orders WHERE id = ?").get(orderId);
    if (!order) {
      throw new StagingError(404, "Commande introuvable.");
    }

    const now = new Date().toISOString();
    db.prepare(
      "UPDATE wa_requests SET status = 'converted', order_id = ?, handled_by = ?, updated_at = ? WHERE id = ?",
    ).run(orderId, userId, now, id);
  }).immediate();
}

export function dismissRequest(id: string, userId: string): void {
  const db = getDb();
  db.transaction(() => {
    const req = db.prepare("SELECT status FROM wa_requests WHERE id = ?").get(id) as { status: string } | undefined;
    if (!req) {
      throw new StagingError(404, "Demande introuvable.");
    }
    if (req.status !== "open") {
      throw new StagingError(409, "Cette demande n'est plus ouverte.");
    }

    const now = new Date().toISOString();
    db.prepare(
      "UPDATE wa_requests SET status = 'dismissed', handled_by = ?, updated_at = ? WHERE id = ?",
    ).run(userId, now, id);
  }).immediate();
}
