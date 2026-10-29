import { useCallback, useMemo, useState } from "react";

import type { ProductPack } from "@/lib/commerce-types";
import { applyPacks } from "@/lib/pack-pricing";
import { shippingFor, type ShippingRules } from "@/lib/pricing";
import {
  newEmptyLine,
  type OrderLineItem,
  type SerializableProduct,
  type SerializableVariant,
} from "./types";

export function useOrderLines(
  products: SerializableProduct[],
  shippingRules: ShippingRules,
  initialLines?: Array<{ variantId: string; quantity: number }>,
) {
  const [productSearch, setProductSearch] = useState("");
  const [lines, setLines] = useState<OrderLineItem[]>(() => {
    if (initialLines && initialLines.length > 0) {
      const generated: OrderLineItem[] = [];
      for (let i = 0; i < initialLines.length; i++) {
        const item = initialLines[i];
        let foundProductId: string | null = null;
        for (const p of products) {
          if (p.variants.some((v) => v.variantId === item.variantId)) {
            foundProductId = p.id;
            break;
          }
        }
        if (foundProductId) {
          generated.push({
            id: `line_init_${i}`,
            productId: foundProductId,
            variantId: item.variantId,
            quantity: item.quantity,
          });
        }
      }
      if (generated.length > 0) return generated;
    }
    return [newEmptyLine(products, "line_1")];
  });

  const productsMap = useMemo(() => {
    const map = new Map<string, SerializableProduct>();
    for (const p of products) map.set(p.id, p);
    return map;
  }, [products]);

  const variantsMap = useMemo(() => {
    const map = new Map<string, { product: SerializableProduct; variant: SerializableVariant }>();
    for (const p of products) {
      for (const v of p.variants) {
        map.set(v.variantId, { product: p, variant: v });
      }
    }
    return map;
  }, [products]);

  const filteredProducts = useMemo(() => {
    if (!productSearch.trim()) return products;
    const q = productSearch.toLowerCase().trim();
    return products.filter((p) => p.name.toLowerCase().includes(q));
  }, [products, productSearch]);

  const getLineVariant = useCallback(
    (line: OrderLineItem): SerializableVariant | undefined => {
      const p = productsMap.get(line.productId);
      return p?.variants.find((v) => v.variantId === line.variantId);
    },
    [productsMap],
  );

  // Aggregated quantities per variant across lines
  const variantTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const line of lines) {
      const v = getLineVariant(line);
      if (v) {
        totals.set(v.variantId, (totals.get(v.variantId) ?? 0) + line.quantity);
      }
    }
    return totals;
  }, [lines, getLineVariant]);

  // Display pricing calculations (pure helpers shippingFor / formatMad)
  const itemsSubtotal = useMemo(() => {
    let sub = 0;
    for (const line of lines) {
      const p = productsMap.get(line.productId);
      if (p && getLineVariant(line)) {
        sub += p.price * line.quantity;
      }
    }
    return sub;
  }, [lines, productsMap, getLineVariant]);

  const packDiscount = useMemo(() => {
    const packsByProduct: Record<string, ProductPack[]> = {};
    const priced: { productId: string; qty: number; unitPrice: number }[] = [];
    for (const line of lines) {
      const p = productsMap.get(line.productId);
      if (p && getLineVariant(line)) {
        packsByProduct[p.id] = p.packs ?? [];
        priced.push({ productId: p.id, qty: line.quantity, unitPrice: p.price });
      }
    }
    return applyPacks(priced, packsByProduct).discount;
  }, [lines, productsMap, getLineVariant]);

  const shipping = itemsSubtotal === 0 ? 0 : shippingFor(itemsSubtotal - packDiscount, shippingRules);
  const estimatedTotal = itemsSubtotal - packDiscount + shipping;

  function handleAddLine() {
    setLines((prev) => [...prev, newEmptyLine(products, "line_" + Math.random().toString(36).slice(2, 9))]);
  }

  function handleRemoveLine(index: number) {
    if (lines.length <= 1) return;
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  function handleProductChange(index: number, newProductId: string) {
    const newProduct = productsMap.get(newProductId);

    setLines((prev) =>
      prev.map((line, i) =>
        i === index
          ? {
              ...line,
              productId: newProductId,
              variantId: newProduct?.variants.length === 1 ? newProduct.variants[0].variantId : "",
            }
          : line,
      ),
    );
  }

  function handleVariantChange(index: number, variantId: string) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, variantId } : line)));
  }

  function handleQuantityChange(index: number, newQty: number) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, quantity: newQty } : line)));
  }

  return {
    lines,
    setLines,
    productSearch,
    setProductSearch,
    productsMap,
    variantsMap,
    filteredProducts,
    getLineVariant,
    variantTotals,
    itemsSubtotal,
    packDiscount,
    shipping,
    estimatedTotal,
    handleAddLine,
    handleRemoveLine,
    handleProductChange,
    handleVariantChange,
    handleQuantityChange,
  };
}
