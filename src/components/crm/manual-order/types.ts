import type { ManualOrderInput } from "@/lib/manual-order-schema";
import type { ProductPack, VariantOption } from "@/lib/commerce-types";

export interface SerializableVariant {
  variantId: string;
  sku: string;
  label: string;
  options: VariantOption[];
  available: number;
}

export interface SerializableProduct {
  id: string;
  name: string;
  price: number;
  /** Active quantity packs, display preview only; the server recomputes. */
  packs?: ProductPack[];
  variants: SerializableVariant[];
}

export interface SerializableCity {
  id: number;
  name: string;
  arabicName?: string | null;
}

export interface OrderLineItem {
  id: string;
  productId: string;
  variantId: string;
  quantity: number;
}

export interface SubmittedSnapshot {
  requestId: string;
  payload: ManualOrderInput;
}

export const fieldClassName =
  "w-full min-w-0 border-input bg-card text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring [&_[data-slot=select-value]]:block [&_[data-slot=select-value]]:truncate";

export function newEmptyLine(products: SerializableProduct[], id: string): OrderLineItem {
  return {
    id,
    productId: products.length === 1 ? products[0].id : "",
    variantId: products.length === 1 && products[0].variants.length === 1 ? products[0].variants[0].variantId : "",
    quantity: 1,
  };
}

export function isPayloadDifferent(a: ManualOrderInput, b: ManualOrderInput): boolean {
  if (a.customer.name.trim() !== b.customer.name.trim()) return true;
  if (a.customer.phone.trim() !== b.customer.phone.trim()) return true;
  if (a.source !== b.source) return true;
  if ((a.address ?? "") !== (b.address ?? "")) return true;
  if ((a.cityId ?? null) !== (b.cityId ?? null)) return true;
  if ((a.note ?? "") !== (b.note ?? "")) return true;

  if (a.items.length !== b.items.length) return true;

  const sortFn = (x: { variantId: string }, y: { variantId: string }) =>
    x.variantId.localeCompare(y.variantId);
  const itemsA = [...a.items].sort(sortFn);
  const itemsB = [...b.items].sort(sortFn);

  for (let i = 0; i < itemsA.length; i++) {
    if (
      itemsA[i].variantId !== itemsB[i].variantId ||
      itemsA[i].qty !== itemsB[i].qty
    ) {
      return true;
    }
  }
  return false;
}
