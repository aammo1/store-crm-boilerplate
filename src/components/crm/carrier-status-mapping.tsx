"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import type { CarrierStatusRow, NotifyCategory } from "@/lib/services/carrier-status-map";

export interface CarrierStatusRowView extends CarrierStatusRow {
  lastSeenLabel: string;
}

const CATEGORY_LABELS: Record<NotifyCategory, string> = {
  in_transit: "En transit",
  out_for_delivery: "En cours de livraison",
  delivery_issue: "Problème / reporté",
  ignore: "Ignorer",
};

const selectClassName =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20";

/**
 * Owner mapping of courier raw statuses to WhatsApp notification categories.
 * Notification-only: never changes stock, delivery outcomes or tracking
 * statuses. Each row change is saved immediately with a PUT.
 */
export function CarrierStatusMapping({
  initialRows,
  currentUserName,
}: {
  initialRows: CarrierStatusRowView[];
  currentUserName: string | null;
}) {
  const [rows, setRows] = useState(initialRows);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const busy = useRef(false);

  async function save(index: number, category: NotifyCategory | null) {
    const row = rows[index];
    const key = `${row.provider}|${row.rawStatus}`;
    if (busy.current) return;
    busy.current = true;
    setSavingKey(key);
    try {
      const response = await fetch("/api/crm/carrier-statuses", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: row.provider, rawStatus: row.rawStatus, category }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        toast.error(data?.error ?? "Enregistrement impossible.");
        return;
      }
      setRows((current) =>
        current.map((r, i) =>
          i === index
            ? {
                ...r,
                category,
                mappedByName: category === null ? null : currentUserName ?? r.mappedByName,
              }
            : r,
        ),
      );
      toast.success(
        category === null
          ? "Statut démappé."
          : `Catégorie enregistrée : ${CATEGORY_LABELS[category]}.`,
      );
    } catch {
      toast.error("Erreur de connexion.");
    } finally {
      busy.current = false;
      setSavingKey(null);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-2 text-sm text-muted-foreground">
        <p>
          Aucun statut brut enregistré pour le moment. Les statuts apparaissent ici dès que le
          suivi des colis observe un nouveau libellé du transporteur.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm sm:min-w-[720px]">
        <caption className="sr-only">Correspondances des statuts transporteur</caption>
        <thead className="sr-only sm:not-sr-only">
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-4 font-medium">Transporteur</th>
            <th className="py-2 pr-4 font-medium">Statut brut</th>
            <th className="py-2 pr-4 font-medium">Vu (n fois)</th>
            <th className="py-2 pr-4 font-medium">Dernière fois</th>
            <th className="py-2 pr-4 font-medium">Catégorie</th>
            <th className="py-2 font-medium">Mappé par</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = `${row.provider}|${row.rawStatus}`;
            const unmapped = row.category === null;
            return (
              <tr
                key={key}
                className={`grid grid-cols-2 gap-x-3 border-b border-border/50 py-3 last:border-0 sm:table-row sm:py-0 ${
                  unmapped ? "bg-[var(--crm-warning-bg)]" : ""
                }`}
              >
                <td className="py-2 pr-4 font-medium sm:py-3">
                  <span className="text-xs text-muted-foreground sm:hidden">Transporteur : </span>
                  {row.provider}
                </td>
                <td className="py-2 pr-4 sm:py-3">
                  <span className="font-mono break-all">
                    <span className="text-xs text-muted-foreground sm:hidden">Statut brut : </span>
                    {row.rawStatus}
                  </span>
                  {unmapped ? <Badge className="ml-2 align-middle">Non mappé</Badge> : null}
                </td>
                <td className="py-2 pr-4 sm:py-3 sm:text-right">
                  <span className="text-xs text-muted-foreground sm:hidden">Vu : </span>
                  {row.sampleCount}×
                </td>
                <td className="py-2 pr-4 whitespace-nowrap sm:py-3">
                  <span className="text-xs text-muted-foreground sm:hidden">Dernière fois : </span>
                  {row.lastSeenLabel}
                </td>
                <td className="py-2 pr-4 sm:py-3">
                  <span className="text-xs text-muted-foreground sm:hidden">Catégorie : </span>
                  <select
                    aria-label={`Catégorie de notification pour ${row.rawStatus}`}
                    className={`${selectClassName} min-h-11 sm:h-9 sm:min-h-0 w-full sm:w-52`}
                    value={row.category ?? ""}
                    disabled={savingKey !== null && savingKey !== key}
                    onChange={(event) => {
                      const value = event.target.value;
                      save(index, value === "" ? null : (value as NotifyCategory));
                    }}
                  >
                    <option value="">— non mappé —</option>
                    {(Object.keys(CATEGORY_LABELS) as NotifyCategory[]).map((category) => (
                      <option key={category} value={category}>
                        {CATEGORY_LABELS[category]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2 text-muted-foreground sm:py-3">
                  <span className="text-xs sm:hidden">Mappé par : </span>
                  {row.mappedByName ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
