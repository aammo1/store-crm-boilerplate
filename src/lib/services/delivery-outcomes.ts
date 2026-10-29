import { getDb } from "@/lib/db";
import { ConfirmationError } from "@/lib/services/confirmation";
import { listMovements, recoverDispatch } from "@/lib/services/inventory";
import { insertContact } from "@/lib/services/orders";
import { ensureReturn } from "@/lib/services/returns";
import { notifyOrderDelivered, onOrderRefused } from "@/lib/whatsapp/notify";

export type DeliveryOutcome = "delivered" | "refused";
export type DeliveryOutcomeSource = "agent" | "tracking";
export type DeliveryOutcomeActor = { id: string; role: "admin" | "agent" } | "tracking-poller";

export interface DeliveryOutcomeView {
  outcome: DeliveryOutcome;
  at: string;
  by: string | null;
  byName: string | null;
  source: DeliveryOutcomeSource;
}

const OUTCOME_LABELS: Record<DeliveryOutcome, string> = {
  delivered: "livré",
  refused: "refusé",
};

interface OutcomeRow {
  delivery_outcome: DeliveryOutcome | null;
  delivery_outcome_at: string | null;
  delivery_outcome_by: string | null;
  delivery_outcome_source: DeliveryOutcomeSource | null;
  by_name: string | null;
}

export function getDeliveryOutcome(orderId: string): DeliveryOutcomeView | null {
  const row = getDb()
    .prepare(
      `SELECT o.delivery_outcome, o.delivery_outcome_at, o.delivery_outcome_by,
              o.delivery_outcome_source, u.name AS by_name
       FROM orders o LEFT JOIN users u ON u.id = o.delivery_outcome_by
       WHERE o.id = ?`,
    )
    .get(orderId) as OutcomeRow | undefined;
  if (!row?.delivery_outcome || !row.delivery_outcome_at || !row.delivery_outcome_source) {
    return null;
  }
  return {
    outcome: row.delivery_outcome,
    at: row.delivery_outcome_at,
    by: row.delivery_outcome_by,
    byName: row.by_name,
    source: row.delivery_outcome_source,
  };
}

/**
 * Records the delivery outcome and runs the same side effects verified tracking
 * would: delivered -> exactly-once dispatch recovery (inventory service is the
 * sole stock writer), refused -> insert-or-ignore return (no stock change).
 * cod_status is never touched. Tracking never overrides an existing outcome.
 */
export function setDeliveryOutcome(
  orderId: string,
  outcome: DeliveryOutcome,
  actor: DeliveryOutcomeActor,
  source: DeliveryOutcomeSource,
  reason?: string,
): DeliveryOutcomeView {
  const db = getDb();
  return db
    .transaction((): DeliveryOutcomeView => {
      const order = db
        .prepare("SELECT confirmation_status FROM orders WHERE id = ?")
        .get(orderId) as { confirmation_status: string } | undefined;
      if (!order) throw new ConfirmationError(404, "Commande introuvable");

      const submission = db
        .prepare(
          `SELECT id FROM courier_submissions
           WHERE order_id = ? AND status = 'submitted'
             AND tracking_number IS NOT NULL AND tracking_number <> ''
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(orderId) as { id: string } | undefined;
      if (order.confirmation_status !== "confirmed" || !submission) {
        throw new ConfirmationError(409, "Aucun colis expédié pour cette commande.");
      }

      const existing = getDeliveryOutcome(orderId);
      const actorId = actor === "tracking-poller" ? "tracking-poller" : actor.id;
      const trimmedReason = reason?.trim() ?? "";

      if (existing) {
        if (existing.outcome === outcome) return existing; // no-op
        if (source === "tracking") return existing; // never overrides
        if (actor === "tracking-poller" || actor.role !== "admin") {
          throw new ConfirmationError(
            409,
            "Seul un administrateur peut modifier un résultat de livraison déjà enregistré.",
          );
        }
        if (!trimmedReason) {
          throw new ConfirmationError(400, "Motif requis pour modifier le résultat de livraison.");
        }
        if (trimmedReason.length > 500) {
          throw new ConfirmationError(400, "Motif trop long (500 caractères maximum).");
        }
      }

      if (outcome === "delivered") {
        const prior = listMovements({ orderId }).filter(
          (m) => m.kind === "dispatch" || m.ref.startsWith("disp"),
        );
        if (prior.length === 0) {
          try {
            recoverDispatch(orderId, actorId);
          } catch (err) {
            throw new ConfirmationError(
              409,
              `Remise au livreur impossible : ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } else {
        ensureReturn(submission.id, `refused (${source})`);
      }

      const now = new Date().toISOString();
      db.prepare(
        `UPDATE orders SET delivery_outcome = ?, delivery_outcome_at = ?,
           delivery_outcome_by = ?, delivery_outcome_source = ?, updated_at = ?
         WHERE id = ?`,
      ).run(outcome, now, actorId, source, now, orderId);

      if (existing && actor !== "tracking-poller") {
        insertContact({
          orderId,
          agentId: actor.id,
          channel: "note",
          outcome: "note",
          note: `Résultat de livraison modifié : ${OUTCOME_LABELS[existing.outcome]} → ${OUTCOME_LABELS[outcome]}. Motif : ${trimmedReason}`,
        });
      }

      // Notifications join this transaction (outbox pattern); the hooks guard
      // themselves and never throw, only successful writes enqueue.
      if (outcome === "delivered") {
        notifyOrderDelivered(orderId);
      } else {
        onOrderRefused(orderId);
      }

      return getDeliveryOutcome(orderId) as DeliveryOutcomeView;
    })
    .immediate();
}
