import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import type { CommerceOrderItem as OrderItem } from "@/lib/commerce-types";
import { priceOrderLines } from "@/lib/services/order-pricing";
import { getActivePacksFor } from "@/lib/services/packs";
import { normalizeMaPhone } from "@/lib/phone";
import { getVariantById } from "@/lib/services/catalog";
import { getStoreSettings } from "@/lib/services/store-settings";
import { setAppState } from "@/lib/services/app-state";
import { pickAssignee } from "@/lib/services/assignment";
import { orderLineSnapshot, orderRulesKey } from "@/lib/services/order-lines";
import { deliveryProviderName } from "@/lib/env";
import {
  type ManualOrderInput,
  MANUAL_ORDER_SOURCE_LABELS,
  manualOrderInputSchema,
} from "@/lib/manual-order-schema";

export const manualRequestTombstoneKey = (requestId: string) => `manual_request_tombstone:${requestId}`;

export class ManualOrderError extends Error {
  constructor(
    readonly status: 400 | 409 | 500,
    message: string,
  ) {
    super(message);
    this.name = "ManualOrderError";
  }
}

export interface ManualOrderTotals {
  itemsSubtotal: number;
  shipping: number;
  total: number;
  packDiscount?: number;
}

export interface CreateManualOrderResult {
  orderId: string;
  totals: ManualOrderTotals;
  isReplay: boolean;
}

export interface CanonicalManualPayload {
  address: string | null;
  cityId: number | null;
  customer: {
    name: string;
    phone: string;
  };
  items: Array<{ variantId: string; qty: number }>;
  note: string | null;
  source: string;
}

export function buildCanonicalPayload(
  input: ManualOrderInput,
): CanonicalManualPayload {
  const normalizedPhone =
    normalizeMaPhone(input.customer.phone) ?? input.customer.phone.trim();

  const aggregatedMap = new Map<string, number>();
  for (const item of input.items) {
    aggregatedMap.set(
      item.variantId,
      (aggregatedMap.get(item.variantId) ?? 0) + item.qty,
    );
  }

  const sortedItems = Array.from(aggregatedMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([variantId, qty]) => ({ variantId, qty }));

  return {
    address: input.address?.trim() || null,
    cityId: input.cityId ?? null,
    customer: {
      name: input.customer.name.trim(),
      phone: normalizedPhone,
    },
    items: sortedItems,
    note: input.note?.trim() || null,
    source: input.source,
  };
}

export function computePayloadHash(canonical: CanonicalManualPayload): string {
  const stableRepresentation = JSON.stringify({
    address: canonical.address,
    cityId: canonical.cityId,
    customer: {
      name: canonical.customer.name,
      phone: canonical.customer.phone,
    },
    items: canonical.items.map((i) => ({ variantId: i.variantId, qty: i.qty })),
    note: canonical.note,
    source: canonical.source,
  });

  return crypto
    .createHash("sha256")
    .update(stableRepresentation)
    .digest("hex");
}

export function createManualOrder(
  input: ManualOrderInput,
  actor: { id: string; role?: string },
): CreateManualOrderResult {
  const db = getDb();
  const parsed = manualOrderInputSchema.safeParse(input);
  if (!parsed.success) throw new ManualOrderError(400, parsed.error.issues[0]?.message ?? "Requête invalide.");
  input = parsed.data;
  const canonical = buildCanonicalPayload(input);
  const payloadHash = computePayloadHash(canonical);

  const tx = db.transaction((): CreateManualOrderResult => {
    // 1. Request lookup for idempotent replay / conflict check
    const existing = db
      .prepare(
        "SELECT request_id, order_id, agent_id, payload_hash FROM manual_order_requests WHERE request_id = ?",
      )
      .get(input.requestId) as
      | {
          request_id: string;
          order_id: string;
          agent_id: string;
          payload_hash: string;
        }
      | undefined;

    if (existing) {
      if (
        existing.agent_id !== actor.id ||
        existing.payload_hash !== payloadHash
      ) {
        throw new ManualOrderError(
          409,
          "Identifiant de requête déjà utilisé pour une autre commande ou par un autre utilisateur.",
        );
      }

      const order = db
        .prepare("SELECT id, subtotal, shipping, total, discount_amount FROM orders WHERE id = ?")
        .get(existing.order_id) as
        | { id: string; subtotal: number; shipping: number; total: number; discount_amount: number }
        | undefined;

      if (!order) {
        throw new ManualOrderError(
          500,
          "Commande introuvable pour cette requête enregistrée.",
        );
      }

      return {
        orderId: order.id,
        totals: {
          itemsSubtotal: order.subtotal,
          shipping: order.shipping,
          total: order.total,
          ...(order.discount_amount > 0 ? { packDiscount: order.discount_amount } : {}),
        },
        isReplay: true,
      };
    }

    // Deleted manual orders leave a tombstone (the FK forces row deletion), so a
    // replay of the same request id can never create a second order.
    if (db.prepare("SELECT 1 FROM app_state WHERE key = ?").get(manualRequestTombstoneKey(input.requestId))) {
      throw new ManualOrderError(409, "Cette demande a déjà créé une commande, supprimée depuis.");
    }

    // 2. Validate aggregated quantities
    for (const item of canonical.items) {
      if (item.qty > 10) {
        throw new ManualOrderError(
          400,
          "La quantité cumulée pour un même article ne peut pas dépasser 10.",
        );
      }
    }

    // 3. City resolution (if provided)
    let cityName: string | null = null;
    let cityId: number | null = null;
    if (canonical.cityId !== null) {
      const cityRow = db
        .prepare("SELECT id, name FROM cities WHERE id = ? AND provider = ?")
        .get(canonical.cityId, deliveryProviderName()) as { id: number; name: string } | undefined;
      if (!cityRow) {
        throw new ManualOrderError(
          400,
          "Ville inconnue — veuillez synchroniser la liste des villes.",
        );
      }
      cityId = cityRow.id;
      cityName = cityRow.name;
    }

    // 4. Catalog variant resolution
    const items: OrderItem[] = [];
    for (const line of canonical.items) {
      const variantInfo = getVariantById(line.variantId);
      if (!variantInfo || !variantInfo.active || !variantInfo.productActive) {
        throw new ManualOrderError(
          400,
          `Variante « ${line.variantId} » introuvable ou inactive dans le catalogue.`,
        );
      }
      items.push(orderLineSnapshot(variantInfo, variantInfo.product.name, variantInfo.price, line.qty));
    }

    const rules = getStoreSettings();
    const priced = priceOrderLines(
      items.map((i) => ({ productId: i.product_id, qty: i.quantity, unitPrice: i.unit_price })),
      getActivePacksFor(items.map((i) => i.product_id), db),
      rules,
    );
    const { subtotal, shipping, total, discount } = priced;

    const orderId = `ord_${nanoid(12)}`;
    setAppState(orderRulesKey(orderId), JSON.stringify({ shippingFeeMad: rules.shippingFeeMad,
      freeShippingThresholdMad: rules.freeShippingThresholdMad }));
    const now = new Date().toISOString();

    // 5. Insert order
    db.prepare(
      `INSERT INTO orders (
        id, customer_name, customer_phone, items_json, upsell_offer_json,
        upsell_status, upsell_items_json, subtotal, shipping, total,
        currency, created_at, updated_at, confirmation_status, address,
        city_id, city_name, cod_status, source, assigned_to,
        discount_type, discount_value, discount_amount, pack_snapshot_json
      ) VALUES (
        @id, @customer_name, @customer_phone, @items_json, NULL,
        'declined', NULL, @subtotal, @shipping, @total,
        'MAD', @created_at, @updated_at, 'new', @address,
        @city_id, @city_name, 'awaiting_payment', @source, @assigned_to,
        @discount_type, @discount, @discount, @pack_snapshot
      )`,
    ).run({
      id: orderId,
      customer_name: canonical.customer.name,
      customer_phone: canonical.customer.phone,
      items_json: JSON.stringify(items),
      subtotal,
      shipping,
      total,
      created_at: now,
      updated_at: now,
      address: canonical.address,
      city_id: cityId,
      city_name: cityName,
      source: canonical.source,
      // An agent who creates the order keeps it (cursor untouched); admins use auto-assignment.
      assigned_to:
        actor.role === "agent" && rules.assignmentMode !== "manual"
          ? actor.id
          : pickAssignee(db, rules.assignmentMode),
      discount_type: discount > 0 ? "fixed" : "none",
      discount,
      pack_snapshot: discount > 0 ? JSON.stringify(priced.applications) : null,
    });

    // 6. Insert attribution note in order_contacts
    const contactId = `occ_${nanoid(12)}`;
    const sourceLabel =
      MANUAL_ORDER_SOURCE_LABELS[
        input.source as keyof typeof MANUAL_ORDER_SOURCE_LABELS
      ] ?? input.source;
    const noteParts = [`Commande créée manuellement via ${sourceLabel}.`];
    if (canonical.note) {
      noteParts.push(canonical.note);
    }
    const contactNote = noteParts.join("\n\n");

    db.prepare(
      `INSERT INTO order_contacts (
        id, order_id, agent_id, channel, outcome, note, next_callback_at, created_at
      ) VALUES (?, ?, ?, 'note', 'note', ?, NULL, ?)`,
    ).run(contactId, orderId, actor.id, contactNote, now);

    // 7. Insert manual_order_requests record
    db.prepare(
      `INSERT INTO manual_order_requests (
        request_id, order_id, agent_id, payload_hash, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(input.requestId, orderId, actor.id, payloadHash, now);

    return {
      orderId,
      totals: {
        itemsSubtotal: subtotal,
        shipping,
        total,
        ...(discount > 0 ? { packDiscount: discount } : {}),
      },
      isReplay: false,
    };
  });

  return tx.immediate();
}
