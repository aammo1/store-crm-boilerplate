"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BuyBoxLabels } from "@/config/i18n";
import type { ProductOptionDefinition, ProductPack, PublicCommerceVariant } from "@/lib/commerce-types";
import { track } from "@/lib/storefront/track";
import { MAX_LINE_QTY, type CartLine } from "@/stores/cart";
import { useCartApi } from "@/stores/cart-provider";
import { openCart, openCheckout, prefetchFunnel } from "@/stores/funnel";
import { VARIANT_IMAGES_EVENT, type VariantImagesDetail } from "./gallery";

export interface BuyBoxProduct {
  id: string;
  slug: string;
  name: string;
  price: number;
  images: string[];
  optionDefinitions: ProductOptionDefinition[];
  variants: PublicCommerceVariant[];
  packs: ProductPack[];
  landingEnabled: boolean;
}

type Selection = Record<string, string>;

function matches(variant: PublicCommerceVariant, selection: Selection): boolean {
  return Object.entries(selection).every(([name, value]) => variant.options.some((o) => o.name === name && o.value === value));
}

function initialSelection(product: BuyBoxProduct): Selection {
  const first = product.variants.find((v) => v.available) ?? product.variants[0];
  const selection: Selection = {};
  for (const def of product.optionDefinitions) {
    const value = first?.options.find((o) => o.name === def.name)?.value;
    if (value !== undefined) selection[def.name] = value;
  }
  return selection;
}

/** `?options=Couleur:Noir` (repeat the parameter for several options). */
function selectionFromUrl(product: BuyBoxProduct): Selection | null {
  const wanted: Selection = {};
  for (const raw of new URLSearchParams(location.search).getAll("options")) {
    const i = raw.indexOf(":");
    if (i > 0) wanted[raw.slice(0, i)] = raw.slice(i + 1);
  }
  const base = initialSelection(product);
  let changed = false;
  for (const def of product.optionDefinitions) {
    const value = wanted[def.name];
    if (value !== undefined && def.values.includes(value) && base[def.name] !== value) { base[def.name] = value; changed = true; }
  }
  return changed ? base : null;
}

// Strings arrive pre-translated from the server (buyBoxLabels) so the dictionary stays out of the
// client bundle.
const fill = (template: string, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), template);

export function BuyBox({ product, labels }: { product: BuyBoxProduct; labels: BuyBoxLabels }) {
  const formatPrice = (n: number) => `${n} ${labels.currency}`;
  const pieces = (n: number) => fill(n === 1 ? labels.piece : labels.pieces, { n });
  const cart = useCartApi();
  const [selection, setSelection] = useState<Selection>(() => initialSelection(product));
  const [qty, setQty] = useState(1);
  const viewed = useRef(false);

  useEffect(() => {
    if (!viewed.current) {
      viewed.current = true;
      track("ViewContent", [{ id: product.id, quantity: 1 }]);
    }
    const fromUrl = selectionFromUrl(product);
    if (fromUrl) setSelection(fromUrl);
  }, [product]);

  const variant = useMemo(() => {
    if (product.optionDefinitions.length === 0) return product.variants[0];
    return product.variants.find((v) => matches(v, selection));
  }, [product, selection]);

  useEffect(() => {
    const detail: VariantImagesDetail = { productId: product.id, images: variant?.images ?? [] };
    window.dispatchEvent(new CustomEvent(VARIANT_IMAGES_EVENT, { detail }));
  }, [product.id, variant]);

  const soldOut = !variant || !variant.available;

  function valueDisabled(name: string, value: string): boolean {
    const others = Object.fromEntries(Object.entries(selection).filter(([k]) => k !== name));
    return !product.variants.some((v) => v.available && matches(v, { ...others, [name]: value }));
  }

  function line(): Omit<CartLine, "qty"> | null {
    if (!variant) return null;
    return {
      variantId: variant.id,
      productId: product.id,
      slug: product.slug,
      name: product.name,
      image: variant.images[0] ?? product.images[0] ?? "",
      optionsLabel: variant.label,
      unitPrice: product.price,
      packs: product.packs,
    };
  }

  function addToCart() {
    const l = line();
    if (!l || soldOut) return;
    cart.getState().add(l, qty);
    openCart();
  }

  function orderNow() {
    const l = line();
    if (!l || soldOut) return;
    cart.getState().add(l, qty);
    openCheckout();
  }

  const packs = product.packs.filter((p) => p.price < p.quantity * product.price && p.quantity <= MAX_LINE_QTY);

  return (
    <div id="commander" className="scroll-mt-4 space-y-4">
      {product.optionDefinitions.map((def) => (
        <fieldset key={def.name}>
          <legend className="mb-2 text-sm font-medium">
            {def.name}
            {selection[def.name] && <span className="ms-1 font-normal text-store-fg/70">: {selection[def.name]}</span>}
          </legend>
          <div className="flex flex-wrap gap-2" role="group" aria-label={fill(labels.chooseOption, { name: def.name })}>
            {def.values.map((value) => {
              const selected = selection[def.name] === value;
              const disabled = valueDisabled(def.name, value);
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setSelection((s) => ({ ...s, [def.name]: value }))}
                  className={`min-w-11 rounded-store border px-3 py-2 text-sm ${
                    selected ? "border-store-primary bg-store-primary text-store-primary-fg" : "border-store-border"
                  } ${disabled ? "text-store-fg/40 line-through" : ""}`}
                >
                  {value}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}

      {packs.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium">{labels.packs}</p>
          <div className="flex flex-wrap gap-2">
            {packs.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={qty === p.quantity}
                onClick={() => setQty(p.quantity)}
                className={`rounded-store border px-3 py-2 text-start text-sm ${
                  qty === p.quantity ? "border-store-primary bg-store-muted" : "border-store-border"
                }`}
              >
                {p.label ?? pieces(p.quantity)} : {formatPrice(p.price)}{" "}
                <span className="text-store-accent">(−{formatPrice(p.quantity * product.price - p.price)})</span>
                {p.highlight && <span className="ms-1 text-xs font-semibold">{labels.bestValue}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">{labels.quantity}</span>
        <div className="inline-flex items-center rounded-store border border-store-border">
          <button type="button" aria-label={labels.decrease} disabled={qty <= 1} onClick={() => setQty((q) => Math.max(1, q - 1))} className="size-10 disabled:opacity-40">−</button>
          <output className="min-w-8 text-center text-sm font-medium" aria-live="polite">{qty}</output>
          <button type="button" aria-label={labels.increase} disabled={qty >= MAX_LINE_QTY} onClick={() => setQty((q) => Math.min(MAX_LINE_QTY, q + 1))} className="size-10 disabled:opacity-40">+</button>
        </div>
      </div>

      <div className="grid gap-2">
        <button
          type="button"
          disabled={soldOut}
          onClick={orderNow}
          onPointerEnter={prefetchFunnel}
          onFocus={prefetchFunnel}
          className="h-12 rounded-store bg-store-accent px-4 font-semibold text-store-accent-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          {soldOut ? labels.soldOut : labels.orderNow}
        </button>
        <button
          type="button"
          disabled={soldOut}
          onClick={addToCart}
          onPointerEnter={prefetchFunnel}
          onFocus={prefetchFunnel}
          className="h-12 rounded-store border border-store-primary px-4 font-semibold text-store-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {labels.addToCart}
        </button>
        {product.landingEnabled && (
          <Link href={`/l/${product.slug}`} className="text-center text-sm text-store-fg/70 underline">
            {labels.viewOffer}
          </Link>
        )}
      </div>
    </div>
  );
}
