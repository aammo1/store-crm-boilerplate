import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";

import {
  ManualOrderForm,
  type SerializableProduct,
} from "@/components/crm/manual-order-form";
import { requireUser } from "@/lib/auth-guards";
import { getLead } from "@/lib/services/checkout-leads";
import { listProducts } from "@/lib/services/catalog";
import { listCities } from "@/lib/services/orders";
import { getStoreSettings } from "@/lib/services/store-settings";

export const metadata: Metadata = {
  title: "Nouvelle commande — CRM",
  robots: { index: false },
};

interface PageSearchParams {
  leadId?: string;
  waRequest?: string;
  name?: string;
  phone?: string;
  city?: string;
  address?: string;
  items?: string;
}

export default async function NewManualOrderPage({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  await requireUser();
  const sp = await searchParams;
  const lead = typeof sp.leadId === "string" && sp.leadId.length <= 64 ? getLead(sp.leadId) : null;

  const allProducts = listProducts();
  const cities = listCities();
  const { shippingFeeMad, freeShippingThresholdMad } = getStoreSettings();

  // Project minimal serializable active catalog options
  const products: SerializableProduct[] = allProducts
    .filter((product) => product.active)
    .map((product) => ({
      id: product.id,
      name: product.name,
      price: product.price,
      packs: product.packs,
      variants: product.variants
        .filter((variant) => variant.active)
        .map((variant) => ({
          variantId: variant.id,
          sku: variant.sku,
          label: variant.label,
          options: variant.options,
          available: variant.available,
        })),
    }))
    .filter((product) => product.variants.length > 0);

  const initialCustomer = lead
    ? { name: lead.name === "Sans nom" ? "" : lead.name, phone: lead.phone }
    : sp.name || sp.phone
      ? { name: sp.name ?? "", phone: sp.phone ?? "" }
      : undefined;

  let initialCityId: number | null = null;
  if (sp.city) {
    const norm = sp.city.trim().toLowerCase();
    const matched = cities.find(
      (c) =>
        c.name.toLowerCase() === norm ||
        (c.arabicName && c.arabicName.toLowerCase() === norm),
    );
    if (matched) initialCityId = matched.id;
  }

  let initialLines: Array<{ variantId: string; quantity: number }> | undefined;
  if (sp.items) {
    const parsed: Array<{ variantId: string; quantity: number }> = [];
    for (const part of sp.items.split(",")) {
      const [variantId, qtyStr] = part.split(":");
      const qty = parseInt(qtyStr, 10);
      if (variantId && !isNaN(qty) && qty > 0) {
        parsed.push({ variantId: variantId.trim(), quantity: qty });
      }
    }
    if (parsed.length > 0) {
      initialLines = parsed;
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/crm/orders"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" aria-hidden />
          Retour aux commandes
        </Link>
        <h1 className="mt-2 font-semibold text-2xl text-foreground">
          Nouvelle commande
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Saisie manuelle d&apos;un achat reçu hors boutique (WhatsApp, téléphone, Instagram ou autre canal).
        </p>
      </div>

      <ManualOrderForm
        products={products}
        cities={cities}
        shippingRules={{ shippingFeeMad, freeShippingThresholdMad }}
        initialCustomer={initialCustomer}
        initialCityId={initialCityId}
        initialAddress={sp.address || null}
        initialLines={initialLines}
        waRequestId={sp.waRequest || null}
      />
    </div>
  );
}
