import { getDb } from "@/lib/db";
import { getDashboard } from "@/lib/services/dashboard";
import { getShipmentBoard } from "@/lib/services/expeditions";
import { DEFAULT_LOCATION } from "@/lib/services/inventory";
import { getCrmOrder, listOrders, type ListOrdersOptions } from "@/lib/services/orders";
import { getReturn, getReturnBySubmission } from "@/lib/services/returns";
import { redactSecrets, redactText } from "@/lib/shipping/redact";
import { assistantPage } from "@/lib/services/assistant-investigation";
import type { VariantOption } from "@/lib/commerce-types";

// Only explicit read queries are exposed. Never accept SQL or provider URLs.
export function readAssistantPriorities() {
  const dashboard = getDashboard();
  const stripPhones = <T extends { customerPhone: string }>(row: T) => {
    const { customerPhone: _phone, ...safe } = row;
    void _phone;
    return safe;
  };
  return {
    ...dashboard,
    newOrders: { ...dashboard.newOrders, rows: dashboard.newOrders.rows.map(stripPhones) },
    callbacksDue: { ...dashboard.callbacksDue, rows: dashboard.callbacksDue.rows.map(stripPhones) },
  };
}

export function readAssistantOrders(options: ListOrdersOptions) {
  const result = listOrders({ ...options, pageSize: options.pageSize === 20 ? 20 : 10 });
  return { ...result, orders: result.orders.map(({ customerPhone: _phone, ...row }) => {
    void _phone;
    return row;
  }) };
}

export function readAssistantOrder(id: string) {
  const order = getCrmOrder(id);
  if (!order) return null;
  const tracking = order.submission ? getDb().prepare(
    "SELECT last_sync_at AS lastTrackingSyncAt, raw_status AS lastRawTrackingStatus FROM courier_submissions WHERE id = ?",
  ).get(order.submission.id) as { lastTrackingSyncAt: string | null; lastRawTrackingStatus: string | null } | undefined : undefined;
  return {
    id: order.id, customerName: order.customerName, cityName: order.cityName,
    items: order.items, upsellStatus: order.upsellStatus,
    upsellItems: order.upsellStatus === "accepted" ? order.upsellItems : null,
    total: order.total, shipping: order.shipping, currency: order.currency,
    confirmationStatus: order.confirmationStatus, codStatus: order.codStatus,
    assignedToName: order.assignedToName, nextCallbackAt: order.nextCallbackAt,
    duplicateOf: order.duplicateOf, createdAt: order.createdAt, updatedAt: order.updatedAt,
    contacts: order.contacts.slice(-10).map(({ channel, outcome, note, nextCallbackAt, createdAt }) => ({ channel, outcome, note, nextCallbackAt, createdAt })),
    submission: order.submission ? { ...order.submission, ...tracking } : null,
    return: order.submission ? getReturnBySubmission(order.submission.id) : null,
  };
}

export function readAssistantShipping() {
  const board = getShipmentBoard();
  return {
    note: "Extraits du tableau d’expéditions, pas des totaux globaux. Les limites du tableau s’appliquent.",
    ready: { boardCount: board.ready.length, rows: board.ready.slice(0, 10) },
    operations: { boardCount: board.operations.length, rows: board.operations.slice(0, 10).map(({ resolutions: _resolutions, parcels, ...operation }) => {
      void _resolutions;
      return { ...operation, parcelCount: parcels.length, parcels: parcels.slice(0, 5) };
    }) },
    savedNotes: { boardCount: board.savedNotes.length, rows: board.savedNotes.slice(0, 10).map(({ parcels, ...note }) => ({ ...note, parcelCount: parcels.length, parcels: parcels.slice(0, 5) })) },
    dispatched: { boardCount: board.dispatched.length, rows: board.dispatched.slice(0, 10) },
  };
}

export function readAssistantStock(q: string, threshold?: number, page = 1, productId?: string) {
  const rows = getDb().prepare(`
    SELECT v.id AS variantId, p.id AS productId, p.name AS product, v.label, v.options_json AS optionsJson, v.sku,
      COALESCE(b.physical, 0) AS physical, COALESCE(b.reserved, 0) AS reserved,
      COALESCE(b.quarantine, 0) AS quarantine,
      MAX(0, COALESCE(b.physical, 0) - COALESCE(b.reserved, 0) - COALESCE(b.quarantine, 0)) AS available
    FROM variants v JOIN products p ON p.id = v.product_id
    LEFT JOIN stock_balances b ON b.variant_id = v.id AND b.location = @location
    WHERE v.active = 1 AND p.active = 1
      ${productId ? "AND p.id = @productId" : ""}
      AND (p.name LIKE @q OR v.sku LIKE @q OR v.label LIKE @q
        OR EXISTS (SELECT 1 FROM json_each(v.options_json) option
          WHERE json_extract(option.value, '$.name') LIKE @q OR json_extract(option.value, '$.value') LIKE @q))
      AND (@threshold IS NULL OR MAX(0, COALESCE(b.physical, 0) - COALESCE(b.reserved, 0) - COALESCE(b.quarantine, 0)) <= @threshold)
    ORDER BY available ASC, p.name, v.label, v.id LIMIT 21 OFFSET @offset
  `).all({ q: `%${q}%`, threshold: threshold ?? null, location: DEFAULT_LOCATION, offset: (page - 1) * 20, ...(productId ? { productId } : {}) });
  return assistantPage(rows.map((row) => {
    const { optionsJson, ...fields } = row as { optionsJson: string };
    return { ...fields, options: JSON.parse(optionsJson) as VariantOption[] };
  }), page);
}

export function readAssistantReturn(id: string, page = 1) {
  const result = getReturn(id);
  if (!result) return null;
  const db = getDb();
  const submission = db.prepare("SELECT order_id AS orderId FROM courier_submissions WHERE id = ?").get(result.submissionId) as { orderId: string };
  const order = getCrmOrder(submission.orderId);
  const items = [...(order?.items ?? []), ...(order?.upsellStatus === "accepted" ? order.upsellItems ?? [] : [])];
  const lines = db.prepare(`SELECT l.variant_id AS variantId, p.id AS productId, p.name AS product, v.label, v.sku, v.options_json AS optionsJson,
    l.dispatched_qty AS dispatchedQty, l.sellable_qty AS sellableQty, l.damaged_qty AS damagedQty
    FROM return_lines l JOIN variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
    WHERE l.return_id = ? ORDER BY l.variant_id LIMIT 21 OFFSET ?`).all(id, (page - 1) * 20);
  const snapshotLines = lines.map((row) => {
    const { optionsJson, ...line } = row as { variantId: string; optionsJson: string };
    const item = items.find((item) => item.variant_id === line.variantId);
    return { ...line, ...(item ? { product: item.name, sku: item.sku, label: item.variant_label } : {}),
      options: item?.options ?? JSON.parse(optionsJson) as VariantOption[],
      identitySource: item ? "order_snapshot" : "current_catalog" };
  });
  return { ...result, orderId: submission.orderId, lines: assistantPage(snapshotLines, page), note: "Les quantités totales viennent du retour ; les lignes d’inspection sont un extrait. Identité issue de la commande, ou du catalogue actuel si aucun instantané ne correspond." };
}

// Bound every free-text field, scrub credential-bearing URLs and literal secrets.
export function sanitizeAssistantData(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(redactText(value), [
    process.env.OZON_CLIENT_ID ?? "", process.env.OZON_API_KEY ?? "",
    process.env.SENDIT_PUBLIC_KEY ?? "", process.env.SENDIT_SECRET_KEY ?? "",
    process.env.OPENROUTER_API_KEY ?? "",
    process.env.AUTH_SECRET ?? "", process.env.STOREFRONT_API_KEY ?? "", process.env.CATALOG_AGENT_KEY ?? "",
  ]).slice(0, 600);
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeAssistantData);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeAssistantData(item)]));
  return value;
}
