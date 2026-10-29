import { getDb, hasOrderFulfillmentHistory } from "@/lib/db";
import type { SessionUser } from "@/lib/auth-guards";
import { orderRulesKey } from "@/lib/services/order-lines";
import { cancelQueuedForOrder } from "@/lib/services/whatsapp-outbox";

export class OrderLifecycleError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "OrderLifecycleError";
  }
}

/** Serialize against confirmation, workers, and upsells; a batch is all-or-nothing. */
export function changeOrderLifecycle(
  ids: string[],
  action: "archive" | "restore" | "delete",
  actor: Pick<SessionUser, "id" | "role">,
): number {
  if (action === "delete" && actor.role !== "admin") {
    throw new OrderLifecycleError(403, "Suppression réservée aux administrateurs.");
  }
  const unique = [...new Set(ids)];
  if (!unique.length || unique.length > 100) {
    throw new OrderLifecycleError(400, "Sélectionnez entre 1 et 100 commandes.");
  }
  const db = getDb();
  return db.transaction(() => {
    const now = new Date().toISOString();
    for (const id of unique) {
      const order = db.prepare("SELECT archived_at, confirmation_status FROM orders WHERE id = ?")
        .get(id) as { archived_at: string | null; confirmation_status: string } | undefined;
      if (!order) throw new OrderLifecycleError(404, "Une commande sélectionnée est introuvable. Actualisez la liste.");
      if (action === "delete") {
        if (!order.archived_at) {
          throw new OrderLifecycleError(409, "Archivez les commandes avant de les supprimer définitivement.");
        }
        if (order.confirmation_status === "confirmed" || hasOrderFulfillmentHistory(id) ||
          db.prepare("SELECT 1 FROM stock_movements WHERE order_id = ? LIMIT 1").get(id) ||
          db.prepare("SELECT 1 FROM submission_resolutions WHERE order_id = ? LIMIT 1").get(id)) {
          throw new OrderLifecycleError(409, "Suppression impossible : une commande possède un historique de stock ou d’expédition. Conservez-la dans les archives.");
        }
        if (db.prepare("SELECT 1 FROM storefront_request_receipts WHERE order_id = ? LIMIT 1").get(id)) {
          throw new OrderLifecycleError(409, "Conservez cette commande dans les archives : ses reçus de commande doivent rester rejouables.");
        }
        // Remove only this order's durable conversion jobs, including pending jobs.
        db.prepare("DELETE FROM meta_events WHERE event_id IN (SELECT event_id FROM meta_purchases WHERE order_id = ?)").run(id);
        db.prepare("DELETE FROM tiktok_events WHERE event_id IN (SELECT event_id FROM tiktok_purchases WHERE order_id = ?)").run(id);
        // WhatsApp rows follow the order (their FKs are hard, except wa_requests
        // whose link is soft and keeps the request usable without an order).
        db.prepare("DELETE FROM wa_outbox WHERE order_id = ?").run(id);
        db.prepare("DELETE FROM wa_conversation_orders WHERE order_id = ?").run(id);
        db.prepare("DELETE FROM wa_order_drafts WHERE order_id = ?").run(id);
        db.prepare("DELETE FROM wa_proposals WHERE order_id = ?").run(id);
        db.prepare("UPDATE wa_requests SET order_id = NULL WHERE order_id = ?").run(id);
        // manual_order_requests.order_id is a hard FK, so the row must go with the order;
        // keep a tombstone so replaying the request id cannot create a new order.
        for (const r of db.prepare("SELECT request_id FROM manual_order_requests WHERE order_id = ?").all(id) as { request_id: string }[]) {
          db.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
            .run(`manual_request_tombstone:${r.request_id}`, JSON.stringify({ deletedOrderId: id, deletedAt: now }));
        }
        for (const table of ["meta_purchases", "tiktok_purchases", "manual_order_requests", "order_contacts"]) {
          db.prepare(`DELETE FROM ${table} WHERE order_id = ?`).run(id);
        }
        db.prepare("DELETE FROM orders WHERE id = ?").run(id);
        db.prepare("DELETE FROM app_state WHERE key = ?").run(orderRulesKey(id));
      } else if (action === "archive") {
        db.prepare("UPDATE orders SET archived_at = ?, archived_by = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
          .run(now, actor.id, now, id);
        // An archived order must not receive queued notifications anymore.
        cancelQueuedForOrder(id);
      } else {
        db.prepare("UPDATE orders SET archived_at = NULL, archived_by = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL")
          .run(now, id);
      }
    }
    return unique.length;
  }).immediate();
}
