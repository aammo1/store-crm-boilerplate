import { getDb, closePendingStorefrontUpsell, hasOrderFulfillmentHistory } from "@/lib/db";
import type { CommerceOrderItem as OrderItem } from "@/lib/commerce-types";
import { getVariantById } from "@/lib/services/catalog";
import { replaceOrderVariant } from "@/lib/services/order-lines";
import { getOrderEditState } from "@/lib/services/order-edits";
import {
  InsufficientStockError,
  releaseForOrder,
  reserveForOrder,
  type ReserveLine,
  type StockShortage,
} from "@/lib/services/inventory";
import { getCrmOrder as getOrder, insertContact, type CrmOrder, type ConfirmationStatus } from "@/lib/services/orders";
import { createSubmission } from "@/lib/services/submissions";
import { clearDraft } from "@/lib/services/whatsapp-staging";
import { notifyOrderCancelled, notifyOrderConfirmed } from "@/lib/whatsapp/notify";
import { courierPortal } from "@/lib/shipping/courier-copy";
import { deliveryProviderName } from "@/lib/env";
import { log } from "@/lib/log";

export class ConfirmationError extends Error {
  readonly status: 400 | 404 | 409;
  readonly shortages: StockShortage[] | null;

  constructor(
    status: 400 | 404 | 409,
    message: string,
    shortages: StockShortage[] | null = null,
  ) {
    super(message);
    this.name = "ConfirmationError";
    this.status = status;
    this.shortages = shortages;
  }
}

export interface ConfirmActor {
  id: string;
  name?: string | null;
}

export interface ConfirmLineInput {
  lineIndex: number;
  variantId: string;
}

export interface ConfirmInput {
  lines: ConfirmLineInput[];
  address: string;
  cityId: number;
}

export interface ConfirmResult {
  created: boolean;
  submissionId: string | null;
}

export interface LineUpdateInput {
  lineIndex: number;
  variantId: string;
}

const CONFIRMABLE_STATUSES: ConfirmationStatus[] = [
  "new",
  "no_answer",
  "call_back_later",
];

interface LatestSubmissionRow {
  id: string;
  status: string;
  tracking_number: string | null;
}

/**
 * One write path for the confirmation workflow. Every mutation runs inside a
 * single better-sqlite3 transaction started with `.immediate()`; the inner
 * transactions of reserveForOrder/createSubmission/insertContact then become
 * SAVEPOINTs, so a failure after the reserve step (e.g. InsufficientStockError,
 * a rejected submission insert) rolls the reservations, the order update and
 * the queued submission back together — all-or-nothing, nothing partial.
 */

function combinedLines(order: CrmOrder): Array<{ item: OrderItem; upsell: boolean }> {
  const lines = order.items.map((item) => ({ item, upsell: false }));
  if (order.upsellStatus === "accepted") {
    for (const item of order.upsellItems ?? []) {
      lines.push({ item, upsell: true });
    }
  }
  return lines;
}

function latestSubmission(orderId: string): LatestSubmissionRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, status, tracking_number FROM courier_submissions
         WHERE order_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(orderId) as LatestSubmissionRow | undefined) ?? null
  );
}

function hasActiveReservations(orderId: string): boolean {
  return (
    getDb()
      .prepare(
        "SELECT 1 FROM reservations WHERE order_id = ? AND status = 'active' LIMIT 1",
      )
      .get(orderId) !== undefined
  );
}

function insufficientStockMessage(shortages: StockShortage[]): string {
  return shortages
    .map((s) => `Stock insuffisant pour ${s.sku} (${s.available} disponible(s))`)
    .join(" · ");
}

export function confirmOrder(
  orderId: string,
  input: ConfirmInput,
  actor: ConfirmActor,
): ConfirmResult {
  const db = getDb();
  return db.transaction((): ConfirmResult => {
    const order = getOrder(orderId);
    if (!order) throw new ConfirmationError(404, "Commande introuvable");

    if (order.confirmationStatus === "confirmed") {
      return { created: false, submissionId: latestSubmission(orderId)?.id ?? null };
    }
    if (order.confirmationStatus === "cancelled") {
      throw new ConfirmationError(409, "Commande annulée — confirmation impossible.");
    }
    if (order.archivedAt) throw new ConfirmationError(409, "Restaurez la commande avant de la confirmer.");
    const address = input.address?.trim() ?? "";
    if (address.length < 5 || address.length > 500) {
      throw new ConfirmationError(
        400,
        "Adresse trop courte — indiquez au moins le quartier et la rue (5 caractères minimum).",
      );
    }
    if (!Number.isInteger(input.cityId) || input.cityId < 1) {
      throw new ConfirmationError(400, "Adresse et ville requises.");
    }
    if (!CONFIRMABLE_STATUSES.includes(order.confirmationStatus)) {
      throw new ConfirmationError(400, "Statut de commande incompatible avec la confirmation.");
    }
    if (hasOrderFulfillmentHistory(orderId)) {
      throw new ConfirmationError(
        409,
        "Cette commande a déjà été prise en charge — résolvez la réservation ou la transmission existante avant toute nouvelle confirmation.",
      );
    }

    const city = db.prepare("SELECT id, name FROM cities WHERE id = ? AND provider = ?").get(
      input.cityId,
      deliveryProviderName(),
    ) as { id: number; name: string } | undefined;
    if (!city) {
      throw new ConfirmationError(400, "Ville inconnue — lancez la synchronisation des villes.");
    }

    closePendingStorefrontUpsell(db, orderId);
    const lines = combinedLines(getOrder(orderId)!);
    if (lines.length === 0) {
      throw new ConfirmationError(400, "La commande ne contient aucun article.");
    }

    const overrides = new Map<number, string>();
    for (const line of input.lines) {
      if (!Number.isInteger(line.lineIndex) || line.lineIndex < 0 || line.lineIndex >= lines.length) {
        throw new ConfirmationError(400, "Ligne introuvable.");
      }
      if (overrides.has(line.lineIndex)) {
        throw new ConfirmationError(400, "Ligne en double dans la demande de confirmation.");
      }
      overrides.set(line.lineIndex, line.variantId);
    }

    const reserveLines: ReserveLine[] = [];
    const finalItems: OrderItem[] = [];
    const finalUpsellItems: OrderItem[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const { item, upsell } = lines[index];
      const providedVariantId = overrides.get(index);
      const variant = getVariantById(providedVariantId ?? item.variant_id);
      if (!variant || !variant.active || !variant.productActive) {
        throw new ConfirmationError(400, `Variante indisponible pour ${item.name} — choisissez une autre variante.`);
      }
      if (variant.productId !== item.product_id) {
        throw new ConfirmationError(400, `La variante choisie n'appartient pas à ${item.name}.`);
      }
      reserveLines.push({ variantId: variant.id, qty: item.quantity });
      const resolved = replaceOrderVariant(item, variant);
      if (upsell) {
        finalUpsellItems.push(resolved);
      } else {
        finalItems.push(resolved);
      }
    }

    try {
      reserveForOrder(orderId, reserveLines, actor.id, "crm");
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        throw new ConfirmationError(
          409,
          insufficientStockMessage(error.shortages),
          error.shortages,
        );
      }
      throw error;
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE orders
       SET confirmation_status = 'confirmed', address = @address, city_id = @cityId,
            city_name = @cityName, items_json = @itemsJson, updated_at = @updatedAt
       WHERE id = @orderId`,
    ).run({
      address,
      cityId: city.id,
      cityName: city.name,
      itemsJson: JSON.stringify(finalItems),
      updatedAt: now,
      orderId,
    });
    if (finalUpsellItems.length > 0) {
      db.prepare("UPDATE orders SET upsell_items_json = ? WHERE id = ?").run(
        JSON.stringify(finalUpsellItems),
        orderId,
      );
    }

    if (JSON.stringify(finalItems) !== JSON.stringify(order.items) ||
        JSON.stringify(finalUpsellItems) !== JSON.stringify(order.upsellItems ?? [])) {
      const after = getOrderEditState(orderId).snapshot;
      db.prepare(`INSERT INTO order_edits (id, order_id, actor_id, actor_name, reason, before_json, after_json, created_at)
        VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?)`).run(orderId, actor.id, actor.name ?? actor.id,
          "Variantes choisies à la confirmation", JSON.stringify({ ...after, items: order.items,
            upsellItems: order.upsellItems ?? [] }), JSON.stringify(after), now);
    }

    // WhatsApp side effects join this transaction (outbox pattern) but must never
    // break a confirmation: notify guards itself, the draft cleanup is trivial
    // yet still wrapped so no hook can throw.
    notifyOrderConfirmed(orderId, actor);
    try {
      clearDraft(orderId);
    } catch (err) {
      log.error("wa.notify_failed", { label: "clear_draft", error: err });
    }

    const submission = createSubmission(orderId);
    if (!submission) {
      throw new ConfirmationError(
        409,
        "Une transmission transporteur est déjà en file pour cette commande.",
      );
    }
    return { created: true, submissionId: submission.id };
  }).immediate();
}

export function cancelOrder(
  orderId: string,
  input: { reason: string },
  actor: ConfirmActor,
): void {
  const db = getDb();
  db.transaction(() => {
    const order = getOrder(orderId);
    if (!order) throw new ConfirmationError(404, "Commande introuvable");
    if (order.confirmationStatus === "cancelled") {
      throw new ConfirmationError(409, "Commande déjà annulée");
    }
    if (!input.reason?.trim()) throw new ConfirmationError(400, "Motif d'annulation requis.");

    const submission = latestSubmission(orderId);
    if (submission) {
      if (submission.status === "submitted" || submission.tracking_number) {
        throw new ConfirmationError(
          409,
          "Colis déjà expédié — résolution manuelle auprès du transporteur.",
        );
      }
      if (submission.status === "submitting") {
        throw new ConfirmationError(
          409,
          "Transmission transporteur en cours — réessayez dans un instant.",
        );
      }
      if (submission.status === "needs_review") {
        // The courier may have created a parcel: stock stays reserved until an
        // agent verifies the portal and resolves the submission (R7/R8).
        throw new ConfirmationError(
          409,
          `Résultat transporteur incertain — vérifiez ${courierPortal()} et résolvez la soumission avant d'annuler.`,
        );
      }
    }

    if (hasActiveReservations(orderId)) {
      releaseForOrder(orderId, actor.id, `Annulation commande ${orderId} — ${input.reason}`);
    }

    const now = new Date().toISOString();
    closePendingStorefrontUpsell(db, orderId);
    db.prepare(
      "UPDATE orders SET confirmation_status = 'cancelled', updated_at = ? WHERE id = ?",
    ).run(now, orderId);
    db.prepare(`UPDATE courier_submissions SET status = 'failed',
      last_error = 'Commande annulée — pas de création de colis', updated_at = ?
      WHERE order_id = ? AND status = 'queued'`).run(now, orderId);
    insertContact({
      orderId,
      agentId: actor.id,
      channel: "note",
      outcome: "note",
      note: `Commande annulée. Motif : ${input.reason}`,
    });

    // Cancels queued notifications, optionally informs the customer and counts
    // repeated cancellations after confirmation; never throws (own savepoint).
    notifyOrderCancelled(orderId);
  }).immediate();
}

export function updateOrderLine(
  orderId: string,
  input: LineUpdateInput,
  actor: ConfirmActor,
): OrderItem {
  const db = getDb();
  return db.transaction((): OrderItem => {
    const order = getOrder(orderId);
    if (!order) throw new ConfirmationError(404, "Commande introuvable");
    if (!CONFIRMABLE_STATUSES.includes(order.confirmationStatus)) {
      throw new ConfirmationError(
        409,
        "Les articles ne peuvent être modifiés que sur une commande non confirmée.",
      );
    }
    if (hasOrderFulfillmentHistory(orderId)) {
      throw new ConfirmationError(
        409,
        "Cette commande a déjà été prise en charge — ses articles ne peuvent plus être modifiés.",
      );
    }

    const upsellCount =
      order.upsellStatus === "accepted" ? (order.upsellItems?.length ?? 0) : 0;
    if (!Number.isInteger(input.lineIndex) || input.lineIndex < 0 || input.lineIndex >= order.items.length + upsellCount) {
      throw new ConfirmationError(400, "Ligne introuvable.");
    }
    if (input.lineIndex >= order.items.length) {
      throw new ConfirmationError(400, "La ligne upsell se choisit lors de la confirmation.");
    }

    const item = order.items[input.lineIndex];
    const variant = getVariantById(input.variantId);
    if (!variant || !variant.active || !variant.productActive || variant.productId !== item.product_id) {
      throw new ConfirmationError(400, `Variante indisponible pour ${item.name}.`);
    }

    if (order.archivedAt) throw new ConfirmationError(409, "Restaurez la commande avant de modifier ses articles.");
    const before = getOrderEditState(orderId).snapshot;
    const items = order.items.map((line, index) => index === input.lineIndex ? replaceOrderVariant(line, variant) : line);
    const now = new Date().toISOString();
    const reason = `Variante modifiée : ${item.name} — ${variant.label} (SKU ${variant.sku})`;
    db.prepare("UPDATE orders SET items_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(items), now, orderId);
    db.prepare(`INSERT INTO order_edits (id, order_id, actor_id, actor_name, reason, before_json, after_json, created_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?)`).run(orderId, actor.id, actor.name ?? actor.id,
        reason, JSON.stringify(before), JSON.stringify({ ...before, items }), now);
    insertContact({ orderId, agentId: actor.id, channel: "note", outcome: "note", note: reason });
    return items[input.lineIndex];
  }).immediate();
}
