"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2Icon, XCircleIcon } from "lucide-react";
import { toast } from "sonner";
import type { VariantOption as CommerceVariantOption } from "@/lib/commerce-types";

import { CancelReasonChips } from "@/components/crm/cancel-reason-chips";
import { CityCombobox } from "@/components/crm/city-combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export interface ConfirmOrderLine {
  lineIndex: number;
  productId: string;
  productName: string;
  variantId: string;
  label: string;
  options: CommerceVariantOption[];
  sku: string;
  quantity: number;
  upsell: boolean;
}

export interface ConfirmOrderCity {
  id: number;
  name: string;
  arabicName?: string | null;
}

interface VariantOption {
  variantId: string;
  sku: string;
  label: string;
  options: CommerceVariantOption[];
  available: number;
}

function variantDescription(variant: Pick<VariantOption, "label" | "options" | "sku">): string {
  const options = variant.options.map((option) => `${option.name} : ${option.value}`).join(" / ");
  return `${variant.label || "Standard"}${options ? ` · ${options}` : ""} · SKU ${variant.sku}`;
}

const fieldClassName =
  "w-full min-w-0 border-input bg-card text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring [&_[data-slot=select-value]]:block [&_[data-slot=select-value]]:truncate";

async function readError(response: Response, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? fallback;
}

export function ConfirmOrder({
  orderId,
  lines,
  cities,
  initialAddress,
  initialCityId,
  totalLabel,
}: {
  orderId: string;
  lines: ConfirmOrderLine[];
  cities: ConfirmOrderCity[];
  initialAddress: string | null;
  initialCityId: number | null;
  totalLabel: string;
}) {
  const router = useRouter();
  const [variantsByProduct, setVariantsByProduct] = useState<Record<string, VariantOption[]>>({});
  const [loadingVariants, setLoadingVariants] = useState(true);
  const [selections, setSelections] = useState<Record<number, string>>({});
  const [address, setAddress] = useState(initialAddress ?? "");
  const [cityId, setCityId] = useState(initialCityId ? String(initialCityId) : "");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [syncingCities, setSyncingCities] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);

  async function handleSyncCities() {
    setSyncingCities(true);
    try {
      const response = await fetch("/api/crm/cities/sync", { method: "POST" });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; count?: number; error?: string } | null;
      if (!response.ok || !data?.ok) {
        toast.error(data?.error ?? "Échec de la synchronisation des villes.");
        return;
      }
      toast.success(`${data.count} villes synchronisées avec succès !`);
      router.refresh();
    } catch {
      toast.error("Erreur de connexion au serveur.");
    } finally {
      setSyncingCities(false);
    }
  }

  useEffect(() => {
    const productIds = [...new Set(lines.map((line) => line.productId))];
    let cancelled = false;
    setLoadingVariants(true);
    Promise.all(
      productIds.map(async (productId) => {
        try {
          const response = await fetch(`/api/crm/products/${productId}/variants`);
          if (!response.ok) return [productId, [] as VariantOption[]] as const;
          const data = (await response.json()) as { variants?: VariantOption[] };
          return [productId, data.variants ?? []] as const;
        } catch {
          return [productId, [] as VariantOption[]] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const map: Record<string, VariantOption[]> = {};
      for (const [productId, variants] of entries) {
        map[productId] = variants;
      }
      setVariantsByProduct(map);
      setSelections((previous) => {
        const next = { ...previous };
        for (const line of lines) {
          if (next[line.lineIndex]) continue;
          const match = (map[line.productId] ?? []).find(
            (variant) => variant.variantId === line.variantId,
          );
          if (match) next[line.lineIndex] = match.variantId;
        }
        return next;
      });
      setLoadingVariants(false);
    });
    return () => {
      cancelled = true;
    };
  }, [lines]);

  function handleLineChange(line: ConfirmOrderLine, variantId: string) {
    setSelections((previous) => ({ ...previous, [line.lineIndex]: variantId }));
    setError("");
  }

  async function onConfirm() {
    if (busy.current) return;
    const missing = lines.find((line) => !selections[line.lineIndex]);
    if (missing) {
      toast.error(
        missing.upsell
          ? `Sélectionnez une variante pour la ligne upsell (${missing.productName}).`
          : `Sélectionnez une variante pour ${missing.productName}.`,
      );
      return;
    }
    if (!address.trim()) {
      toast.error("Veuillez saisir l'adresse de livraison.");
      return;
    }
    if (!cityId) {
      toast.error("Veuillez choisir la ville de livraison.");
      return;
    }
    busy.current = true;
    setConfirming(true);
    setError("");
    try {
      const response = await fetch(`/api/crm/orders/${orderId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: lines.map((line) => ({
            lineIndex: line.lineIndex,
            variantId: selections[line.lineIndex],
          })),
          address: address.trim(),
          cityId: Number(cityId),
        }),
      });
      if (!response.ok) {
        const message = await readError(response, "Erreur lors de la confirmation.");
        setError(message);
        toast.error(message);
        return;
      }
      toast.success("Commande confirmée — stock réservé, colis mis en file.");
      router.refresh();
    } catch {
      setError("Erreur de connexion. Rechargez la commande pour vérifier son état avant de réessayer.");
      toast.error("Erreur lors de la confirmation.");
    } finally {
      busy.current = false;
      setConfirming(false);
    }
  }

  async function onCancel() {
    if (busy.current) return;
    if (!reason.trim()) {
      toast.error("Veuillez indiquer un motif d'annulation.");
      return;
    }
    busy.current = true;
    setCancelling(true);
    try {
      const response = await fetch(`/api/crm/orders/${orderId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!response.ok) {
        toast.error(await readError(response, "Erreur lors de l'annulation."));
        return;
      }
      toast.success("Commande annulée.");
      router.refresh();
    } catch {
      toast.error("Erreur lors de l'annulation.");
    } finally {
      busy.current = false;
      setCancelling(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-5 text-card-foreground">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Confirmation de la commande
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Les variantes choisies sont enregistrées avec la confirmation, qui réserve le stock et met le colis en file transporteur.
      </p>

      {cities.length === 0 ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--crm-warning)]/40 bg-[var(--crm-warning-bg)] px-3 py-2 text-sm text-[var(--crm-warning)]">
          <span>Lancez la synchronisation des villes pour activer la confirmation.</span>
          <Button
            type="button"
            size="sm"
            disabled={syncingCities}
            onClick={handleSyncCities}
            className="bg-[var(--crm-warning)] text-foreground hover:opacity-90 font-medium"
          >
            {syncingCities ? "Synchronisation…" : "Synchroniser les villes"}
          </Button>
        </div>
      ) : null}

      <ul className="mt-4 space-y-3">
        {lines.map((line) => {
          const variants = variantsByProduct[line.productId] ?? [];
          const value = selections[line.lineIndex];
          return (
            <li key={line.lineIndex} className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <p className="text-sm font-medium text-foreground">
                  {line.productName}
                  <span className="text-muted-foreground"> ×{line.quantity}</span>
                  {line.upsell ? (
                    <span className="ml-2 inline-flex rounded-full border border-[var(--crm-upsell)]/40 bg-[var(--crm-upsell-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--crm-upsell)]">
                      Upsell
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {variantDescription(line)}
                </p>
              </div>
              <Select
                value={value}
                onValueChange={(variantId) => handleLineChange(line, variantId)}
                disabled={confirming || cancelling || loadingVariants || variants.length === 0}
              >
                <SelectTrigger className={`${fieldClassName} min-w-0`} aria-label={`Variante à confirmer de l’article ${line.lineIndex + 1}`}>
                  <SelectValue
                    placeholder={
                      loadingVariants ? "Chargement des variantes…" : "Choisir la variante…"
                    }
                  />
                </SelectTrigger>
                <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)] [&_[data-slot=select-item]]:whitespace-normal [&_[data-slot=select-item]]:break-words">
                  {variants.map((variant) => (
                    <SelectItem
                      key={variant.variantId}
                      value={variant.variantId}
                      disabled={variant.available <= 0}
                    >
                      {variantDescription(variant)} — {variant.available} dispo
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!loadingVariants && variants.length === 0 ? (
                <p className="mt-1 text-xs text-[var(--crm-danger)]">
                  Aucune variante active pour ce produit.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? <p role="alert" className="mt-4 rounded-lg border border-destructive p-3 text-sm text-destructive">{error}</p> : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="confirm-address" className="text-muted-foreground">
            Adresse
          </Label>
          <Textarea
              id="confirm-address"
              disabled={confirming || cancelling}
            rows={2}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="Adresse complète de livraison…"
            className={fieldClassName}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm-city" className="text-muted-foreground">
            Ville
          </Label>
          <CityCombobox
            id="confirm-city"
            cities={cities}
            value={cityId}
            onChange={setCityId}
            disabled={confirming || cancelling}
            className={fieldClassName}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border pt-4">
        <p className="text-sm text-muted-foreground">Total à payer à la livraison</p>
        <p className="text-base font-semibold text-foreground">{totalLabel}</p>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button
          type="button"
          onClick={onConfirm}
          disabled={confirming || cancelling || loadingVariants || cities.length === 0}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <CheckCircle2Icon aria-hidden />
          {confirming ? "Confirmation…" : "Confirmer la commande"}
        </Button>
        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            aria-label="Motif d’annulation"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Motif d'annulation…"
            maxLength={2000}
            className={`${fieldClassName} sm:max-w-64`}
          />
          <Button
            type="button"
            variant="destructive"
            onClick={onCancel}
            disabled={confirming || cancelling}
            className="shrink-0"
          >
            <XCircleIcon aria-hidden />
            {cancelling ? "Annulation…" : "Annuler la commande"}
          </Button>
        </div>
      </div>
      <div className="mt-2">
        <CancelReasonChips value={reason} onPick={setReason} disabled={confirming || cancelling} />
      </div>
    </section>
  );
}
