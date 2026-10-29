"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCasablancaDateTime, maskPhoneDisplay, purposeLabel } from "./format";

interface OutboxIssueRow {
  id: string;
  conversationId: string | null;
  orderId: string | null;
  phone: string;
  purpose: string;
  kind: string;
  body: string;
  attempts: number;
  status: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UncertainSendsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful resolution so the parent can refresh its counters. */
  onResolved: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  uncertain: "Incertain",
  failed: "Échec",
};

/**
 * Shared table for both sections. `readOnly` (failed rows) hides the actions
 * column entirely: the resolve endpoint only accepts `uncertain` rows.
 */
function IssueTable({
  rows,
  readOnly = false,
  busyId,
  onResolve,
}: {
  rows: OutboxIssueRow[];
  readOnly?: boolean;
  busyId: string | null;
  onResolve: (row: OutboxIssueRow, resolution: "sent" | "not_sent_requeue" | "cancel") => void;
}) {
  return (
    <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
          <th scope="col" className="border-b border-border px-2 py-2 font-medium">
            Objectif
          </th>
          <th scope="col" className="border-b border-border px-2 py-2 font-medium">
            Téléphone
          </th>
          <th scope="col" className="border-b border-border px-2 py-2 font-medium">
            Créé le
          </th>
          <th scope="col" className="border-b border-border px-2 py-2 font-medium">
            Dernière erreur
          </th>
          {!readOnly && (
            <th scope="col" className="border-b border-border px-2 py-2 text-right font-medium">
              Actions
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="align-top">
            <td className="border-b border-border px-2 py-2">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-foreground">{purposeLabel(row.purpose)}</span>
                <Badge variant={row.status === "uncertain" ? "secondary" : "destructive"}>
                  {STATUS_LABELS[row.status] ?? row.status}
                </Badge>
              </div>
              <p className="mt-0.5 line-clamp-2 max-w-[220px] text-xs text-muted-foreground">
                {row.body}
              </p>
            </td>
            <td className="border-b border-border px-2 py-2 tabular-nums" dir="ltr">
              {maskPhoneDisplay(row.phone)}
            </td>
            <td className="border-b border-border px-2 py-2 text-xs text-muted-foreground">
              {formatCasablancaDateTime(row.createdAt)}
            </td>
            <td className="border-b border-border px-2 py-2 text-xs text-muted-foreground">
              <span className="line-clamp-2 max-w-[220px]">{row.lastError ?? "—"}</span>
            </td>
            {!readOnly && (
              <td className="border-b border-border px-2 py-2">
                <div className="flex flex-wrap justify-end gap-1">
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={busyId !== null}
                    onClick={() => onResolve(row, "sent")}
                  >
                    Marquer envoyé
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={busyId !== null}
                    onClick={() => onResolve(row, "not_sent_requeue")}
                  >
                    Renvoyer
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="destructive"
                    disabled={busyId !== null}
                    onClick={() => onResolve(row, "cancel")}
                  >
                    Annuler
                  </Button>
                </div>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Admin-only reconciliation panel. Rows stuck in `uncertain` are actionable
 * ("Marquer envoyé", "Renvoyer", "Annuler"); permanently `failed` rows are
 * listed read-only for visibility (they linger until the 30-day purge) and
 * the resolve endpoint rejects them, so they get no action buttons. Never
 * shown to agents: the summary route exposes the global count to everyone,
 * but resolution is restricted to admins server-side.
 */
export function UncertainSendsDialog({ open, onOpenChange, onResolved }: UncertainSendsDialogProps) {
  const [rows, setRows] = useState<OutboxIssueRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const inFlight = useRef(false);

  // Only `uncertain` rows are actionable server-side; `failed` rows are
  // terminal and listed read-only below.
  const uncertainRows = rows.filter((row) => row.status === "uncertain");
  const failedRows = rows.filter((row) => row.status === "failed");

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const response = await fetch("/api/crm/whatsapp/outbox?limit=100", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as { items?: OutboxIssueRow[] };
      setRows(Array.isArray(data.items) ? data.items : []);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function resolve(row: OutboxIssueRow, resolution: "sent" | "not_sent_requeue" | "cancel") {
    if (busyId) return;
    if (resolution === "cancel" && !window.confirm("Annuler ce message ? Il ne sera jamais envoyé.")) {
      return;
    }
    setBusyId(row.id);
    try {
      const response = await fetch(`/api/crm/whatsapp/outbox/${encodeURIComponent(row.id)}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        toast.error(data?.error ?? "Résolution impossible.");
        return;
      }
      setRows((current) => current.filter((item) => item.id !== row.id));
      const success =
        resolution === "sent"
          ? "Message marqué comme envoyé."
          : resolution === "not_sent_requeue"
            ? "Message remis en file d’envoi."
            : "Message annulé.";
      toast.success(success);
      onResolved();
    } catch {
      toast.error("Résolution impossible.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Envois incertains</DialogTitle>
          <DialogDescription>
            Vérifiez d’abord sur le téléphone si le message est parti, pour éviter un doublon.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-auto">
          {loading && rows.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">Chargement…</p>
          ) : loadError ? (
            <div className="space-y-2 p-4 text-center">
              <p className="text-sm text-muted-foreground">Impossible de charger les envois.</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                Réessayer
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">
              Aucun envoi en attente de résolution.
            </p>
          ) : (
            <>
              {/* Actionable rows: only `uncertain` is resolvable server-side. */}
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  À résoudre ({uncertainRows.length})
                </h3>
                {uncertainRows.length === 0 ? (
                  <p className="p-2 text-center text-sm text-muted-foreground">
                    Aucun envoi incertain en attente de résolution.
                  </p>
                ) : (
                  <IssueTable
                    rows={uncertainRows}
                    busyId={busyId}
                    onResolve={(row, resolution) => void resolve(row, resolution)}
                  />
                )}
              </section>
              {/* Failed rows are terminal: read-only until the 30-day purge. */}
              {failedRows.length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Échecs définitifs ({failedRows.length})
                  </h3>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Ces envois ont définitivement échoué : aucune action n’est possible, ils seront
                    purgés automatiquement après 30 jours.
                  </p>
                  <IssueTable
                    rows={failedRows}
                    readOnly
                    busyId={busyId}
                    onResolve={(row, resolution) => void resolve(row, resolution)}
                  />
                </section>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
