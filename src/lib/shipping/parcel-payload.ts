import rawStoreConfig from "../../../store.config";
import { toLocalPhone } from "@/lib/phone";
import type { CrmOrder } from "@/lib/services/orders";
import type { ParcelRequest } from "./provider";
import type { CommerceOrderItem } from "@/lib/commerce-types";
import { shipmentDescription } from "@/lib/order-item-label";

export interface ParcelPayloadSnapshot {
  order_id: string;
  customer_name: string;
  customer_phone: string;
  address: string | null;
  city_id: number | null;
  city_name: string | null;
  total: number;
  items: Omit<CommerceOrderItem, "unit_price" | "line_total">[];
  courier_reference?: string;
}

type ParcelOrder = Pick<
  CrmOrder,
  | "id"
  | "customerName"
  | "customerPhone"
  | "address"
  | "cityId"
  | "cityName"
  | "total"
  | "items"
  | "upsellStatus"
  | "upsellItems"
>;

export function courierReference(orderId: string): string {
  const slug = String(rawStoreConfig.slug ?? "store").replace(/[^A-Za-z0-9_-]/g, "");
  return `${slug}-${orderId}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

export function buildSnapshotObject(order: ParcelOrder): ParcelPayloadSnapshot {
  const upsellItems =
    order.upsellStatus === "accepted" ? (order.upsellItems ?? []) : [];
  return {
    order_id: order.id,
    customer_name: order.customerName,
    customer_phone: order.customerPhone,
    address: order.address,
    city_id: order.cityId,
    city_name: order.cityName,
    total: order.total,
    courier_reference: courierReference(order.id),
    items: [...order.items, ...upsellItems].map((item) => ({
      product_id: item.product_id,
      name: item.name,
      variant_id: item.variant_id,
      sku: item.sku,
      variant_label: item.variant_label,
      options: (item.options ?? []).map((option) => ({ ...option })),
      quantity: item.quantity,
    })),
  };
}

/** Frozen snapshot of the parcel data at job-creation time — later order edits never alter an already-queued parcel. */
export function buildPayloadSnapshot(order: ParcelOrder): string {
  return JSON.stringify(buildSnapshotObject(order));
}

function snapshotFrom(
  payloadJson: string | null,
  order: ParcelOrder,
): ParcelPayloadSnapshot {
  if (payloadJson) {
    try {
      const parsed: unknown = JSON.parse(payloadJson);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof (parsed as { order_id?: unknown }).order_id === "string" &&
        typeof (parsed as { customer_phone?: unknown }).customer_phone === "string" &&
        typeof (parsed as { total?: unknown }).total === "number"
      ) {
        return parsed as ParcelPayloadSnapshot;
      }
    } catch {
      // Fall through to a fresh snapshot from the order row.
    }
  }
  return buildSnapshotObject(order);
}

export function buildCreateParcelInput(
  submission: { payload: string | null },
  order: ParcelOrder,
): ParcelRequest {
  const snapshot = snapshotFrom(submission.payload, order);
  const description = shipmentDescription(snapshot.items);
  return {
    reference: snapshot.courier_reference ?? courierReference(snapshot.order_id),
    orderId: snapshot.order_id,
    receiver: snapshot.customer_name,
    phoneLocal: toLocalPhone(snapshot.customer_phone),
    cityId: snapshot.city_id ?? 0,
    cityName: snapshot.city_name,
    address: snapshot.address ?? "",
    codAmountMad: snapshot.total,
    description,
    items: (snapshot.items ?? []).map((i) => ({
      name: i.name,
      options: (i.options ?? []).map((o) => ({ name: o.name, value: o.value })),
      quantity: i.quantity,
      sku: i.sku ?? null,
    })),
  };
}
