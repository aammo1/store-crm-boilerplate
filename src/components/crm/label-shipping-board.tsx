"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronDownIcon,
  HandIcon,
  InfoIcon,
  PrinterIcon,
  TruckIcon,
} from "lucide-react";

import { CopyButton } from "@/components/crm/copy-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatMad } from "@/lib/pricing";
import { useAssistantSelection } from "@/stores/assistant-context";
import type { LabelFormat } from "@/lib/shipping/couriers";
import type {
  BoardDispatchedOrder,
  BoardParcel,
} from "@/lib/services/expeditions";

export interface LabelShippingBoardProps {
  ready: BoardParcel[];
  dispatched: BoardDispatchedOrder[];
  formats: LabelFormat[];
  courierLabel: string;
}

async function readError(data: Record<string, unknown> | null): Promise<string | null> {
  return typeof data?.error === "string" ? data.error : null;
}

async function postJson(
  url: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

function Section({
  id,
  title,
  count,
  icon,
  initiallyOpen,
  children,
}: {
  id: string;
  title: string;
  count: number;
  icon?: React.ReactNode;
  initiallyOpen?: boolean;
  children: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(initiallyOpen ?? count > 0);
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3">
      <h2>
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={`${id}-content`}
          onClick={() => setIsOpen((prev) => !prev)}
          className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex items-center gap-2.5">
            {icon}
            <span
              id={`${id}-title`}
              className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {title}
            </span>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums",
                count > 0
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground",
              )}
            >
              {count}
            </span>
          </span>
          <ChevronDownIcon
            className={cn(
              "size-5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
              isOpen && "rotate-180 text-foreground",
            )}
            aria-hidden="true"
          />
        </button>
      </h2>
      <div
        id={`${id}-content`}
        role="region"
        aria-labelledby={`${id}-title`}
        hidden={!isOpen}
        className={cn(!isOpen && "hidden")}
      >
        {children}
      </div>
    </section>
  );
}

function ParcelFacts({ parcel }: { parcel: BoardParcel }) {
  return (
    <>
      <span className="font-mono text-xs text-primary">{parcel.orderId}</span>
      <span className="text-sm font-medium text-foreground">{parcel.customerName}</span>
      {parcel.cityName ? (
        <span className="text-xs text-muted-foreground">{parcel.cityName}</span>
      ) : null}
      <span className="ml-auto text-xs uppercase tracking-wide text-muted-foreground">COD</span>
      <span className="text-sm font-semibold whitespace-nowrap text-foreground">
        {formatMad(parcel.total)}
      </span>
    </>
  );
}

function TrackingCell({ tracking }: { tracking: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 font-mono text-xs text-foreground/80">
      <span className="shrink-0 text-muted-foreground">Suivi :</span>
      <span onClick={(event) => event.stopPropagation()}>
        <CopyButton value={tracking} label={tracking} />
      </span>
    </span>
  );
}

export function LabelShippingBoard({
  ready,
  dispatched,
  formats,
  courierLabel,
}: LabelShippingBoardProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<string | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<string>(formats[0]?.id ?? "10x10");
  const [confirmOpen, setConfirmOpen] = useState(false);

  useAssistantSelection("shipment-selection", {
    selectedParcelIds: [...selected].slice(0, 10),
    selectionCount: selected.size,
  });

  const selectedReady = ready.filter((parcel) => selected.has(parcel.submissionId));
  const allSelected = ready.length > 0 && selectedReady.length === ready.length;

  function toggle(submissionId: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(submissionId)) next.delete(submissionId);
      else next.add(submissionId);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(ready.map((p) => p.submissionId)));
  }

  function printSelectedLabels() {
    if (selectedReady.length === 0) {
      toast.error("Sélectionnez d'abord les colis dont vous souhaitez imprimer les étiquettes.");
      return;
    }
    const ids = selectedReady.map((p) => p.submissionId).join(",");
    const format = selectedFormat || formats[0]?.id || "10x10";
    window.open(
      `/api/crm/labels/pdf?ids=${encodeURIComponent(ids)}&format=${encodeURIComponent(format)}`,
      "_blank",
    );
  }

  async function handoffSingleParcel(submissionId: string) {
    setPending(`parcel:${submissionId}`);
    try {
      const { status, data } = await postJson(
        `/api/crm/parcels/${submissionId}/handoff`,
        { parcelId: submissionId },
      );
      const error = await readError(data);
      if (status === 0 || (status >= 400 && !error)) {
        toast.error("Remise au livreur impossible, réessayez.");
        return;
      }
      if (status >= 400) {
        toast.error(error);
        return;
      }
      toast.success(
        data?.alreadyDispatched
          ? "Colis déjà remis au livreur — aucun double débit."
          : "Colis remis au livreur — stock décrémenté.",
      );
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(submissionId);
        return next;
      });
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function handleBulkHandoff() {
    if (selectedReady.length === 0) return;
    setPending("bulk");
    try {
      const { status, data } = await postJson("/api/crm/parcels/handoff", {
        parcelIds: selectedReady.map((p) => p.submissionId),
      });
      const error = await readError(data);
      if (status === 0 || (status >= 400 && !error)) {
        toast.error("Remise au livreur impossible, réessayez.");
        return;
      }
      if (status >= 400) {
        toast.error(error);
        return;
      }
      const results = (data?.results ?? []) as Array<{ ok?: boolean; error?: string }>;
      const failures = results.filter((result) => result.ok === false);
      if (failures.length === 0) {
        toast.success(`${results.length} colis remis au livreur — stock décrémenté.`);
      } else {
        toast.error(
          `${failures.length} échec(s) de remise : ${failures
            .map((failure) => failure.error)
            .filter(Boolean)
            .join(" · ")}`,
        );
      }
      setSelected(new Set());
      setConfirmOpen(false);
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-10">
      <div className="flex items-start gap-3 rounded-xl border border-[var(--crm-warning)]/40 bg-[var(--crm-warning-bg)] px-4 py-3 text-sm text-[var(--crm-warning)]">
        <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          Imprimez les étiquettes {courierLabel} des colis prêts, collez-les, puis déclarez la remise
          au livreur. La remise au livreur décrémente le stock réservé.
        </p>
      </div>

      <Section
        id="ready"
        title="Colis prêts"
        count={ready.length}
        icon={<TruckIcon className="size-4 text-muted-foreground" aria-hidden />}
      >
        {ready.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            Aucun colis prêt — les commandes confirmées apparaissent ici une fois transmises au transporteur.
          </p>
        ) : (
          <>
            <ul className="space-y-2">
              {ready.map((parcel) => {
                const isSelected = selected.has(parcel.submissionId);
                return (
                  <li
                    key={parcel.submissionId}
                    onClick={() => toggle(parcel.submissionId)}
                    className={cn(
                      "flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors",
                      isSelected
                        ? "border-primary bg-primary/5"
                        : "border-border bg-card hover:border-foreground/20",
                    )}
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggle(parcel.submissionId)}
                      onClick={(event) => event.stopPropagation()}
                      disabled={!parcel.trackingNumber}
                      aria-label={`Sélectionner la commande ${parcel.orderId}`}
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <ParcelFacts parcel={parcel} />
                      </div>
                      <p className="line-clamp-1 text-xs text-muted-foreground">
                        {parcel.itemsSummary}
                      </p>
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                        <TrackingCell tracking={parcel.trackingNumber} />
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={(event) => {
                            event.stopPropagation();
                            handoffSingleParcel(parcel.submissionId);
                          }}
                          disabled={pending === `parcel:${parcel.submissionId}`}
                        >
                          <HandIcon className="size-3.5" aria-hidden />
                          {pending === `parcel:${parcel.submissionId}`
                            ? "Remise…"
                            : "Remis au livreur"}
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-muted/30 px-4 py-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleAll}
                  aria-label="Tout sélectionner"
                />
                Tout sélectionner
              </label>

              {formats.length > 1 ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <label htmlFor="label-format-select" className="font-medium">
                    Format :
                  </label>
                  <select
                    id="label-format-select"
                    value={selectedFormat}
                    onChange={(event) => setSelectedFormat(event.target.value)}
                    className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {formats.map((format) => (
                      <option key={format.id} value={format.id}>
                        {format.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              <Button
                type="button"
                variant="secondary"
                onClick={printSelectedLabels}
                disabled={selectedReady.length === 0}
              >
                <PrinterIcon className="size-4" aria-hidden />
                Imprimer les étiquettes ({selectedReady.length})
              </Button>

              <Button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={selectedReady.length === 0 || pending === "bulk"}
              >
                <HandIcon className="size-4" aria-hidden />
                Remis au livreur ({selectedReady.length})
              </Button>
            </div>
          </>
        )}
      </Section>

      <Section
        id="dispatched"
        title="Récemment remis"
        count={dispatched.length}
        initiallyOpen={false}
        icon={<HandIcon className="size-4 text-muted-foreground" aria-hidden />}
      >
        {dispatched.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            Aucune remise au livreur sur les 14 derniers jours.
          </p>
        ) : (
          <ul className="space-y-2">
            {dispatched.map((entry) => (
              <li
                key={entry.orderId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-card px-4 py-3"
              >
                <span className="font-mono text-xs text-primary">{entry.orderId}</span>
                <span className="text-sm font-medium text-foreground">{entry.customerName}</span>
                {entry.cityName ? (
                  <span className="text-xs text-muted-foreground">{entry.cityName}</span>
                ) : null}
                <span className="ml-auto text-sm font-semibold text-foreground">
                  {formatMad(entry.total)}
                </span>
                <span className="text-xs text-muted-foreground">{entry.actor}</span>
                <span className="text-xs text-muted-foreground">
                  {entry.dispatchedAtLabel}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Dialog open={confirmOpen} onOpenChange={(open) => { if (pending !== "bulk") setConfirmOpen(open); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Confirmer la remise au livreur</DialogTitle>
            <DialogDescription>
              Confirmer la remise de {selectedReady.length} colis au livreur ? Le stock sera sorti.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending === "bulk"}
              onClick={() => setConfirmOpen(false)}
            >
              Annuler
            </Button>
            <Button
              type="button"
              disabled={pending === "bulk" || selectedReady.length === 0}
              onClick={handleBulkHandoff}
            >
              <HandIcon className="size-4" aria-hidden />
              {pending === "bulk" ? "Remise en cours…" : "Confirmer la remise"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
