"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  AgingBucket,
  CsvMapping,
  PreviewRow,
  PreviewStatus,
  RemittanceSummary,
  StatementPreview,
} from "@/lib/services/cod-remittances";

const fieldClassName =
  "w-full border-input bg-background text-foreground placeholder:text-muted-foreground/50 focus-visible:border-ring focus-visible:ring-ring/20";
const selectClassName =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20";

const mad = new Intl.NumberFormat("fr-MA", { maximumFractionDigits: 0 });
const formatMad = (n: number) => `${mad.format(n)} MAD`;
const dayLabel = (d: string) => d.split("-").reverse().join("/");
const dateTime = new Intl.DateTimeFormat("fr-MA", {
  timeZone: "Africa/Casablanca",
  dateStyle: "short",
});

const STATUS_LABELS: Record<PreviewStatus, string> = {
  matched: "Conforme",
  mismatch: "Écart de montant",
  foreign: "Autre boutique / inconnu",
  invalid: "Ligne invalide",
  duplicate: "Doublon",
  already_paid: "Déjà encaissée",
  needs_delivery: "Livraison non enregistrée",
  not_deliverable: "Non encaissable",
};

function formatForeignSummary(count: number): string {
  const plural = count > 1 ? "s" : "";
  return `${count} colis inconnu${plural} dans cette boutique ignoré${plural} (autre boutique du même compte ?)`;
}

const MAX_FILE_BYTES = 900 * 1024;

type Selection = { keep: boolean; acceptMismatch: boolean; markDelivered: boolean };
type CommitResponse = {
  error?: string;
  remittance?: RemittanceSummary | null;
  applied?: number;
  skipped?: Array<{ key: string; reason: string }>;
  aging?: AgingBucket[];
};

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data: T | null }> {
  const res = await fetch(url, init);
  return { ok: res.ok, data: (await res.json().catch(() => null)) as T | null };
}

export function RemittanceWorkspace({
  initialRemittances,
  initialAging,
  today,
}: {
  initialRemittances: RemittanceSummary[];
  initialAging: AgingBucket[];
  today: string;
}) {
  const [remittances, setRemittances] = useState(initialRemittances);
  const [aging, setAging] = useState(initialAging);
  const [csv, setCsv] = useState("");
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [selection, setSelection] = useState<Record<number, Selection>>({});
  const [reference, setReference] = useState("");
  const [receivedOn, setReceivedOn] = useState(today);
  const [declaredTotal, setDeclaredTotal] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [lastImportSummary, setLastImportSummary] = useState<string | null>(null);

  async function refresh() {
    const { ok, data } = await api<{ remittances?: RemittanceSummary[]; aging?: AgingBucket[] }>("/api/crm/remittances");
    if (ok && data?.remittances) {
      setRemittances(data.remittances);
      if (data.aging) setAging(data.aging);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast.error("Fichier trop volumineux (900 Ko maximum).");
      return;
    }
    setLastImportSummary(null);
    setCsv(await file.text());
    setPreview(null);
  }

  async function runPreview(nextMapping: CsvMapping | null = mapping) {
    if (busy || !csv.trim()) return;
    setLastImportSummary(null);
    setBusy(true);
    try {
      const { ok, data } = await api<{ error?: string; preview?: StatementPreview }>("/api/crm/remittances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", csv, mapping: nextMapping ?? undefined }),
      });
      if (!ok || !data?.preview) {
        toast.error(data?.error ?? "Impossible d'analyser le fichier.");
        return;
      }
      setPreview(data.preview);
      setMapping(data.preview.mapping);
      const next: Record<number, Selection> = {};
      for (const row of data.preview.rows) {
        next[row.rowNumber] = { keep: row.status === "matched", acceptMismatch: false, markDelivered: false };
      }
      setSelection(next);
    } catch {
      toast.error("Erreur de connexion. Veuillez réessayer.");
    } finally {
      setBusy(false);
    }
  }

  function afterCommit(data: CommitResponse, foreignCount = 0) {
    if (data.aging) setAging(data.aging);
    const skipped = data.skipped ?? [];
    const serverForeign = skipped.filter(
      (s) => s.reason?.includes("inconnu dans cette boutique") || (s as { status?: string }).status === "foreign",
    ).length;
    const totalForeign = Math.max(foreignCount, serverForeign);
    if (data.remittance) {
      toast.success(`${data.applied} commande(s) marquée(s) payée(s).${skipped.length ? ` ${skipped.length} ignorée(s).` : ""}`);
      setPreview(null);
      setCsv("");
      setPicked(new Set());
      setLastImportSummary(totalForeign > 0 ? formatForeignSummary(totalForeign) : null);
    } else {
      toast.error(skipped[0]?.reason ?? "Aucune commande n'a pu être encaissée.");
      if (totalForeign > 0) setLastImportSummary(formatForeignSummary(totalForeign));
    }
    void refresh();
  }

  function metaPayload() {
    const total = declaredTotal.trim();
    return {
      reference: reference.trim(),
      receivedOn,
      declaredTotal: total === "" ? null : Number(total),
      note: note.trim() || null,
    };
  }

  function validateMeta(): boolean {
    if (!reference.trim()) {
      toast.error("La référence est requise.");
      return false;
    }
    if (declaredTotal.trim() !== "" && !/^\d+$/.test(declaredTotal.trim())) {
      toast.error("Le total déclaré doit être un entier en MAD.");
      return false;
    }
    return true;
  }

  async function post(body: unknown, foreignCount = 0) {
    if (busy) return;
    setBusy(true);
    try {
      const { ok, data } = await api<CommitResponse>("/api/crm/remittances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!ok || !data) {
        toast.error(data?.error ?? "Impossible d'enregistrer l'encaissement.");
        return;
      }
      afterCommit(data, foreignCount);
    } catch {
      toast.error("Erreur de connexion. Veuillez réessayer.");
    } finally {
      setBusy(false);
    }
  }

  function commitStatement() {
    if (!preview || !validateMeta()) return;
    const foreignCount = preview.rows.filter((r) => r.status === "foreign").length;
    const rows = preview.rows
      .filter((r) => {
        const s = selection[r.rowNumber];
        if (!s?.keep || r.paidAmount === null) return false;
        return ["matched", "mismatch", "needs_delivery"].includes(r.status);
      })
      .map((r) => {
        const s = selection[r.rowNumber];
        return {
          trackingNumber: r.trackingNumber,
          paidAmount: r.paidAmount as number,
          feeAmount: r.feeAmount,
          acceptMismatch: r.status === "mismatch" && s.acceptMismatch,
          markDelivered: r.status === "needs_delivery" && s.markDelivered,
        };
      });
    if (rows.length === 0) {
      toast.error("Aucune ligne sélectionnée.");
      return;
    }
    void post({ ...metaPayload(), rows }, foreignCount);
  }

  function commitManual() {
    if (picked.size === 0 || !validateMeta()) return;
    void post({ ...metaPayload(), orderIds: [...picked] });
  }

  async function undo(r: RemittanceSummary) {
    if (busy) return;
    if (!window.confirm(`Annuler l'encaissement « ${r.reference } » ? Les ${r.lineCount} commande(s) repasseront en attente de paiement.`)) return;
    setBusy(true);
    try {
      const { ok, data } = await api<{ error?: string; aging?: AgingBucket[] }>(
        `/api/crm/remittances/${encodeURIComponent(r.id)}`,
        { method: "DELETE" },
      );
      if (!ok) {
        toast.error(data?.error ?? "Impossible d'annuler l'encaissement.");
        return;
      }
      toast.success("Encaissement annulé.");
      if (data?.aging) setAging(data.aging);
      await refresh();
    } catch {
      toast.error("Erreur de connexion. Veuillez réessayer.");
    } finally {
      setBusy(false);
    }
  }

  function togglePick(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function update(row: PreviewRow, patch: Partial<Selection>) {
    setSelection((prev) => ({ ...prev, [row.rowNumber]: { ...prev[row.rowNumber], ...patch } }));
  }

  const unpaidTotal = aging.reduce((s, b) => s + b.total, 0);
  const unpaidCount = aging.reduce((s, b) => s + b.count, 0);
  const columnOptions = preview?.headers ?? [];

  const metaForm = (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="space-y-1.5">
        <Label htmlFor="rem-ref">Référence du relevé</Label>
        <Input id="rem-ref" maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} className={fieldClassName} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rem-date">Date de réception</Label>
        <Input id="rem-date" type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} className={fieldClassName} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rem-total">Total déclaré (MAD, optionnel)</Label>
        <Input id="rem-total" inputMode="numeric" value={declaredTotal} onChange={(e) => setDeclaredTotal(e.target.value)} className={fieldClassName} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rem-note">Note (optionnel)</Label>
        <Input id="rem-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={fieldClassName} />
      </div>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <header>
        <h1 className="text-xl font-bold text-foreground">Encaissements</h1>
        <p className="text-sm text-muted-foreground">
          Rapprochez les relevés du transporteur avec les commandes livrées.
        </p>
      </header>

      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <h2 className="text-base font-semibold text-foreground">Importer un relevé CSV</h2>
        {lastImportSummary ? (
          <p className="rounded-md bg-muted/50 p-2.5 text-sm text-muted-foreground">
            {lastImportSummary}
          </p>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="rem-file">Fichier CSV</Label>
          <Input id="rem-file" type="file" accept=".csv,text/csv,text/plain" onChange={(e) => void onFile(e.target.files?.[0])} className={fieldClassName} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rem-csv">ou collez le contenu</Label>
          <textarea
            id="rem-csv"
            rows={5}
            value={csv}
            onChange={(e) => { setCsv(e.target.value); setPreview(null); setLastImportSummary(null); }}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
          />
        </div>
        <Button type="button" disabled={busy || !csv.trim()} onClick={() => void runPreview(null)} className="min-h-[44px] w-full sm:w-auto">
          {busy ? "Analyse..." : "Analyser"}
        </Button>

        {preview && mapping ? (
          <div className="space-y-4 pt-2">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="map-track">Colonne suivi</Label>
                <select id="map-track" className={selectClassName} value={mapping.trackingColumn}
                  onChange={(e) => setMapping({ ...mapping, trackingColumn: Number(e.target.value) })}>
                  {columnOptions.map((h, i) => <option key={i} value={i}>{h || `Colonne ${i + 1}`}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="map-amount">Colonne montant versé</Label>
                <select id="map-amount" className={selectClassName} value={mapping.amountColumn}
                  onChange={(e) => setMapping({ ...mapping, amountColumn: Number(e.target.value) })}>
                  {columnOptions.map((h, i) => <option key={i} value={i}>{h || `Colonne ${i + 1}`}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="map-fee">Colonne frais (optionnel)</Label>
                <select id="map-fee" className={selectClassName} value={mapping.feeColumn ?? ""}
                  onChange={(e) => setMapping({ ...mapping, feeColumn: e.target.value === "" ? null : Number(e.target.value) })}>
                  <option value="">Aucune</option>
                  {columnOptions.map((h, i) => <option key={i} value={i}>{h || `Colonne ${i + 1}`}</option>)}
                </select>
              </div>
            </div>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void runPreview(mapping)} className="min-h-[44px]">
              Recalculer l&apos;aperçu
            </Button>
            <p className="text-xs text-muted-foreground">
              Le montant versé est net des frais : net + frais doit égaler le total de la commande.
            </p>
            {preview.rows.some((r) => r.status === "foreign") ? (
              <p className="text-sm text-muted-foreground">
                {formatForeignSummary(preview.rows.filter((r) => r.status === "foreign").length)}
              </p>
            ) : null}

            <ul className="space-y-2">
              {preview.rows.map((row) => {
                const s = selection[row.rowNumber];
                const selectable = ["matched", "mismatch", "needs_delivery"].includes(row.status);
                return (
                  <li key={row.rowNumber} className="rounded-lg border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {selectable ? (
                        <input
                          type="checkbox"
                          aria-label={`Inclure la ligne ${row.rowNumber}`}
                          className="size-5"
                          checked={s?.keep ?? false}
                          onChange={(e) => update(row, { keep: e.target.checked })}
                        />
                      ) : null}
                      <span className="font-mono">{row.trackingNumber || "—"}</span>
                      <span className="text-muted-foreground">
                        {row.paidAmount !== null ? `${formatMad(row.paidAmount)}${row.feeAmount ? ` + frais ${formatMad(row.feeAmount)}` : ""}` : ""}
                        {row.expectedAmount !== null ? ` · attendu ${formatMad(row.expectedAmount)}` : ""}
                      </span>
                      <span className={
                        row.status === "matched"
                          ? "font-medium text-foreground"
                          : row.status === "foreign"
                            ? "font-medium text-muted-foreground"
                            : "font-medium text-destructive"
                      }>
                        {STATUS_LABELS[row.status]}
                      </span>
                    </div>
                    {row.message ? <p className="mt-1 text-xs text-muted-foreground">Ligne {row.rowNumber} : {row.message}</p> : null}
                    {row.status === "mismatch" && s?.keep ? (
                      <label className="mt-2 flex min-h-[44px] items-center gap-2 text-xs">
                        <input type="checkbox" className="size-5" checked={s.acceptMismatch} onChange={(e) => update(row, { acceptMismatch: e.target.checked })} />
                        Accepter l&apos;écart (il sera enregistré)
                      </label>
                    ) : null}
                    {row.status === "needs_delivery" && s?.keep ? (
                      <label className="mt-2 flex min-h-[44px] items-center gap-2 text-xs">
                        <input type="checkbox" className="size-5" checked={s.markDelivered} onChange={(e) => update(row, { markDelivered: e.target.checked })} />
                        Marquer livré et payé
                      </label>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {metaForm}
            <Button type="button" disabled={busy} onClick={commitStatement} className="min-h-[44px] w-full sm:w-auto">
              {busy ? "Enregistrement..." : "Valider l'encaissement"}
            </Button>
          </div>
        ) : null}
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <h2 className="text-base font-semibold text-foreground">Livrées en attente de paiement</h2>
        <p className="text-sm text-muted-foreground">
          {unpaidCount} commande(s) · {formatMad(unpaidTotal)}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Ancienneté</th>
                <th className="py-2 pr-3 font-medium">Commandes</th>
                <th className="py-2 font-medium">Montant dû</th>
              </tr>
            </thead>
            <tbody>
              {aging.map((b) => (
                <tr key={b.label} className="border-b border-border/60">
                  <td className="py-2 pr-3">{b.label}</td>
                  <td className="py-2 pr-3">{b.count}</td>
                  <td className="py-2">{formatMad(b.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {unpaidCount > 0 ? (
          <div className="space-y-3 pt-2">
            <h3 className="text-sm font-semibold text-foreground">Sélection manuelle</h3>
            <ul className="space-y-1">
              {aging.flatMap((b) => b.orders).map((o) => (
                <li key={o.orderId}>
                  <label className="flex min-h-[44px] items-center gap-3 rounded-md px-1 text-sm">
                    <input type="checkbox" className="size-5" checked={picked.has(o.orderId)} onChange={() => togglePick(o.orderId)} />
                    <span className="font-mono text-xs">{o.orderId}</span>
                    <span>{o.customerName}</span>
                    <span className="text-muted-foreground">{formatMad(o.total)} · {o.ageDays} j</span>
                  </label>
                </li>
              ))}
            </ul>
            {picked.size > 0 ? (
              <>
                {!preview ? metaForm : null}
                <Button type="button" disabled={busy} onClick={commitManual} className="min-h-[44px] w-full sm:w-auto">
                  Marquer {picked.size} commande(s) payée(s)
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">Historique</h2>
        {remittances.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun encaissement enregistré.</p>
        ) : (
          <ul className="space-y-2">
            {remittances.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3 text-sm">
                <div>
                  <p className="font-medium text-foreground">{r.reference}</p>
                  <p className="text-xs text-muted-foreground">
                    {dayLabel(r.receivedOn)} · {r.lineCount} commande(s) · {formatMad(r.paidTotal)} versés · frais {formatMad(r.feesTotal)}
                    {r.declaredTotal !== null ? ` · déclaré ${formatMad(r.declaredTotal)}` : ""}
                    {r.mismatchCount ? ` · ${r.mismatchCount} écart(s)` : ""}
                    {` · saisi le ${dateTime.format(new Date(r.createdAt))}`}
                  </p>
                </div>
                {r.canUndo ? (
                  <Button type="button" variant="outline" disabled={busy} onClick={() => void undo(r)} className="min-h-[44px]">
                    Annuler
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
