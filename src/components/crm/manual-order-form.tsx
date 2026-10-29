"use client";

import { useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { type ManualOrderInput, type ManualOrderSource } from "@/lib/manual-order-schema";
import type { ShippingRules } from "@/lib/pricing";
import { CustomerFields } from "./manual-order/customer-fields";
import { LineItems } from "./manual-order/line-items";
import { postManualOrder } from "./manual-order/post-order";
import { ShippingFields } from "./manual-order/shipping-fields";
import {
  CatalogUnavailable,
  ConflictBanner,
  GeneralErrorBanner,
  UncertainBanner,
} from "./manual-order/status-banners";
import { TotalsPreview } from "./manual-order/totals-preview";
import {
  isPayloadDifferent,
  newEmptyLine,
  type OrderLineItem,
  type SerializableCity,
  type SerializableProduct,
  type SubmittedSnapshot,
} from "./manual-order/types";
import { useOrderLines } from "./manual-order/use-order-lines";
import { validateManualOrder } from "./manual-order/validate";

export type {
  SerializableCity,
  SerializableProduct,
  SerializableVariant,
} from "./manual-order/types";

export interface ManualOrderFormProps {
  products: SerializableProduct[];
  cities: SerializableCity[];
  shippingRules: ShippingRules;
  /** Optional prefill (abandoned checkout lead). */
  initialCustomer?: { name: string; phone: string };
  initialCityId?: number | null;
  initialAddress?: string | null;
  initialLines?: Array<{ variantId: string; quantity: number }>;
  waRequestId?: string | null;
}

export function ManualOrderForm({
  products,
  cities,
  shippingRules,
  initialCustomer,
  initialCityId,
  initialAddress,
  initialLines,
  waRequestId,
}: ManualOrderFormProps) {
  const router = useRouter();
  const formUid = useId();

  // One crypto.randomUUID() per draft
  const [requestId, setRequestId] = useState<string>(() => crypto.randomUUID());

  // Customer info
  const [customerName, setCustomerName] = useState(initialCustomer?.name ?? "");
  const [customerPhone, setCustomerPhone] = useState(initialCustomer?.phone ?? "");
  const [source, setSource] = useState<ManualOrderSource>("manual_whatsapp");

  // Optional fields
  const [selectedCityId, setSelectedCityId] = useState<string>(
    initialCityId ? String(initialCityId) : "none",
  );
  const [address, setAddress] = useState(initialAddress ?? "");
  const [note, setNote] = useState("");

  const order = useOrderLines(products, shippingRules, initialLines);
  const { lines, setLines, variantsMap, getLineVariant } = order;

  // Submission & Retry states
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uncertainSnapshot, setUncertainSnapshot] =
    useState<SubmittedSnapshot | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});

  const busy = useRef(false);

  // Construct current payload
  function buildCurrentPayload(): ManualOrderInput | null {
    // Group and aggregate lines by variantId
    const aggregated = new Map<string, number>();
    for (const line of lines) {
      const v = getLineVariant(line);
      if (!v) continue;
      aggregated.set(v.variantId, (aggregated.get(v.variantId) ?? 0) + line.quantity);
    }

    const payloadItems = Array.from(aggregated.entries()).map(
      ([variantId, qty]) => ({ variantId, qty }),
    );

    return {
      requestId,
      customer: {
        name: customerName.trim(),
        phone: customerPhone.trim(),
      },
      items: payloadItems,
      source,
      address: address.trim() || undefined,
      cityId: selectedCityId && selectedCityId !== "none" ? Number(selectedCityId) : undefined,
      note: note.trim() || undefined,
    };
  }

  // Check if modified compared to uncertain snapshot
  const currentPayload = buildCurrentPayload();
  const isModifiedSinceUncertain = useMemo(() => {
    if (!uncertainSnapshot || !currentPayload) return false;
    return isPayloadDifferent(currentPayload, uncertainSnapshot.payload);
  }, [uncertainSnapshot, currentPayload]);

  // Execute POST /api/crm/orders
  async function submitPayload(payload: ManualOrderInput) {
    if (busy.current) return;
    busy.current = true;
    setIsSubmitting(true);
    setGeneralError(null);
    setConflictError(null);

    try {
      const result = await postManualOrder(payload);

      if (result.kind === "conflict") {
        setConflictError(result.message);
        toast.error(result.message);
        return;
      }

      if (result.kind === "error") {
        setGeneralError(result.message);
        toast.error(result.message);
        if (result.uncertain) {
          setUncertainSnapshot({ requestId: payload.requestId, payload });
        }
        return;
      }

      if (result.kind === "network") {
        setUncertainSnapshot({ requestId: payload.requestId, payload });
        const msg =
          "La connexion avec le serveur a été interrompue. L'état de la commande est incertain. Vous pouvez réassayer la requête originale sans risque de doublon.";
        setGeneralError(msg);
        toast.error(msg);
        return;
      }

      // Success (201 Created or 200 Replay)
      setUncertainSnapshot(null);
      if (result.replay) {
        toast.success("Commande déjà enregistrée (rejeu identique de la requête). Redirection…");
      } else {
        toast.success("Commande créée avec succès en Nouvelle. Redirection…");
      }

      if (waRequestId && result.orderId) {
        try {
          await fetch(`/api/crm/whatsapp/requests/${encodeURIComponent(waRequestId)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "convert", orderId: result.orderId }),
          });
        } catch {
          // ignore network failure on best-effort convert
        }
      }

      router.push(`/crm/orders/${result.orderId}`);
      router.refresh();
    } finally {
      busy.current = false;
      setIsSubmitting(false);
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors = validateManualOrder({
      customerName,
      customerPhone,
      address,
      note,
      lines,
      getLineVariant,
      variantTotals: order.variantTotals,
      variantsMap,
    });
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;

    if (uncertainSnapshot && isModifiedSinceUncertain) {
      toast.error("Modifications détectées après une requête incertaine. Veuillez d'abord réassayer la requête originale.");
      return;
    }

    const payload = buildCurrentPayload();
    if (!payload) return;

    submitPayload(payload);
  }

  // Restore form to uncertain snapshot
  function handleRestoreOriginal() {
    if (!uncertainSnapshot) return;
    const original = uncertainSnapshot.payload;
    setCustomerName(original.customer.name);
    setCustomerPhone(original.customer.phone);
    setSource(original.source);
    setSelectedCityId(original.cityId ? String(original.cityId) : "none");
    setAddress(original.address ?? "");
    setNote(original.note ?? "");

    // Restore lines from original items
    const restoredLines: OrderLineItem[] = [];
    for (let i = 0; i < original.items.length; i++) {
      const item = original.items[i];
      const vInfo = variantsMap.get(item.variantId);
      if (vInfo) {
        restoredLines.push({
          id: "line_restored_" + i,
          productId: vInfo.product.id,
          variantId: item.variantId,
          quantity: item.qty,
        });
      }
    }

    if (restoredLines.length > 0) {
      setLines(restoredLines);
    }
    setClientErrors({});
    toast.info("Données initiales de la requête restaurées.");
  }

  // Abandon draft and start fresh
  function handleDiscardAndReset() {
    if (
      !confirm(
        "Voulez-vous vraiment abandonner ce brouillon et générer une nouvelle commande vide ? L'identifiant de requête sera renouvelé.",
      )
    ) {
      return;
    }
    setRequestId(crypto.randomUUID());
    setUncertainSnapshot(null);
    setConflictError(null);
    setGeneralError(null);
    setClientErrors({});
    setCustomerName("");
    setCustomerPhone("");
    setSource("manual_whatsapp");
    setSelectedCityId("none");
    setAddress("");
    setNote("");
    setLines([newEmptyLine(products, "line_1")]);
    toast.info("Nouveau brouillon initialisé.");
  }

  if (products.length === 0) return <CatalogUnavailable />;

  return (
    <form onSubmit={handleSubmit} className="space-y-6" noValidate>
      {conflictError ? <ConflictBanner message={conflictError} onDiscard={handleDiscardAndReset} /> : null}

      {uncertainSnapshot ? (
        <UncertainBanner
          snapshot={uncertainSnapshot}
          isModified={isModifiedSinceUncertain}
          isSubmitting={isSubmitting}
          onRetry={() => submitPayload(uncertainSnapshot.payload)}
          onRestore={handleRestoreOriginal}
          onDiscard={handleDiscardAndReset}
        />
      ) : null}

      {generalError && !uncertainSnapshot && !conflictError ? <GeneralErrorBanner message={generalError} /> : null}

      <CustomerFields
        formUid={formUid}
        isSubmitting={isSubmitting}
        clientErrors={clientErrors}
        customerName={customerName}
        setCustomerName={setCustomerName}
        customerPhone={customerPhone}
        setCustomerPhone={setCustomerPhone}
        source={source}
        setSource={setSource}
      />

      <LineItems
        products={products}
        filteredProducts={order.filteredProducts}
        productSearch={order.productSearch}
        setProductSearch={order.setProductSearch}
        lines={lines}
        productsMap={order.productsMap}
        getLineVariant={getLineVariant}
        variantTotals={order.variantTotals}
        clientErrors={clientErrors}
        isSubmitting={isSubmitting}
        handleAddLine={order.handleAddLine}
        handleRemoveLine={order.handleRemoveLine}
        handleProductChange={order.handleProductChange}
        handleVariantChange={order.handleVariantChange}
        handleQuantityChange={order.handleQuantityChange}
      />

      <ShippingFields
        formUid={formUid}
        isSubmitting={isSubmitting}
        clientErrors={clientErrors}
        cities={cities}
        selectedCityId={selectedCityId}
        setSelectedCityId={setSelectedCityId}
        address={address}
        setAddress={setAddress}
        note={note}
        setNote={setNote}
      />

      <TotalsPreview
        itemsSubtotal={order.itemsSubtotal}
        packDiscount={order.packDiscount}
        shipping={order.shipping}
        estimatedTotal={order.estimatedTotal}
        shippingRules={shippingRules}
        isSubmitting={isSubmitting}
        hasUncertain={uncertainSnapshot !== null}
        isModifiedSinceUncertain={isModifiedSinceUncertain}
      />
    </form>
  );
}
