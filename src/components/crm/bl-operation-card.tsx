"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton } from "@/components/crm/copy-button";
import type { BoardBlOperation, BoardParcel } from "@/lib/services/expeditions";

const stages = { create: "Création", attach: "Rattachement des colis", save: "Enregistrement" };
const outcomes = { applied: "Effectué", not_applied: "Non effectué", partial: "Partiel", unused: "Ancien BL inutilisé" };

export function BlOperationCard({ operation, selectedReady, onExplain }: {
  operation: BoardBlOperation; selectedReady: BoardParcel[];
  onExplain?: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [ref, setRef] = useState(operation.ref ?? "");
  const [evidence, setEvidence] = useState("");
  const [attachedIds, setAttachedIds] = useState<Set<string>>(new Set());
  const orphan = operation.parcels.length === 0;
  const missing = (orphan ? selectedReady : operation.parcels.filter(p => !p.attached));
  const prefix = operation.id;

  async function post(action: "resume" | "reconcile", body?: unknown) {
    setPending(true);
    try {
      const response = await fetch(`/api/crm/bl/operations/${operation.id}/${action}`, {
        method: "POST", headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json();
      if (!response.ok) { toast.error(data.error ?? "Opération impossible."); return; }
      toast.success(action === "reconcile"
        ? "Vérification enregistrée. Continuez le BL si une étape reste à effectuer."
        : "BL enregistré. Les PDF sont disponibles.");
      setEditing(false);
    } catch {
      toast.error("Connexion interrompue. Actualisez pour vérifier le résultat avant toute nouvelle action.");
    } finally {
      setPending(false);
      router.refresh();
    }
  }

  return (
    <li className="flex flex-col gap-4 rounded-xl border border-[var(--crm-warning)]/30 bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-foreground/80">{operation.ref ?? operation.id}</span>
        <span className="text-xs font-medium text-[var(--crm-warning)]">
          {operation.status === "ready" ? "Prêt à continuer" : operation.canResolve ? "À résoudre" : "En cours"}
          {" · "}{stages[operation.stage]}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">Créé le {operation.createdAtLabel}</span>
      </div>
      {operation.parcels.length > 0 && (
        <ul className="flex flex-col gap-2 text-xs text-muted-foreground">
          {operation.parcels.map(parcel => (
            <li key={parcel.submissionId} className="flex flex-wrap items-center gap-2">
              <span className="text-foreground">{parcel.customerName} · {parcel.orderId}</span>
              <CopyButton value={parcel.trackingNumber} label={parcel.trackingNumber} />
              <span className="text-muted-foreground">{parcel.attached ? "Rattachement vérifié" : "Rattachement non confirmé"}</span>
            </li>
          ))}
        </ul>
      )}
      {operation.lastError && <p className="break-words text-xs text-[var(--crm-danger)]">{operation.lastError}</p>}
      {operation.resolutions.map((entry, index) => (
        <div key={index} className="border-l-2 border-border pl-3 text-xs text-muted-foreground">
          <p>{entry.actor} · {entry.atLabel} · {outcomes[entry.outcome as keyof typeof outcomes] ?? entry.outcome}</p>
          <p className="mt-1 whitespace-pre-wrap break-words">{entry.evidence}</p>
        </div>
      ))}
      {!editing ? (
        <div className="flex flex-wrap gap-2">
          {operation.status === "ready" && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => post("resume")}>
              <RefreshCwIcon data-icon="inline-start" aria-hidden />
              {pending ? "Reprise…" : "Continuer le BL"}
            </Button>
          )}
          {operation.canResolve && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Résoudre après vérification chez le transporteur</Button>
          )}
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => router.refresh()}>Actualiser</Button>
          {operation.status === "running" && !operation.canResolve && (
            <p className="basis-full text-xs text-muted-foreground">
              Une requête est en cours. Si elle a été interrompue, la résolution sera disponible après 5 minutes, sans relance automatique.
            </p>
          )}
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={event => {
          event.preventDefault();
          post("reconcile", { revision: operation.revision, stage: operation.stage, outcome, evidence,
            ...(operation.stage === "create" && outcome === "applied" ? { ref } : {}),
            ...(outcome === "partial" ? { attachedSubmissionIds: [...attachedIds] } : {}),
            ...(orphan && outcome !== "unused" ? { submissionIds: selectedReady.map(p => p.submissionId) } : {}) });
        }}>
          <p className="text-sm text-muted-foreground">
            Vérifiez le résultat dans le portail du transporteur (ou auprès du support) avant de choisir.
            Une étape déclarée non effectuée pourra être relancée ; une étape effectuée ne le sera pas.
          </p>
          {orphan && <p className="text-xs text-[var(--crm-warning)]">
            Cet ancien BL n&apos;a pas de sélection enregistrée. Sélectionnez ses colis dans « Prêts pour BL » ci-dessus : {selectedReady.length} sélectionné(s).
          </p>}
          <fieldset disabled={pending} className="flex flex-col gap-4">
            <legend className="sr-only">Résolution de l&apos;opération BL</legend>
            <Label htmlFor={`${prefix}-outcome`}>Résultat vérifié — {stages[operation.stage]}</Label>
            <select id={`${prefix}-outcome`} value={outcome} required onChange={event => setOutcome(event.target.value)}
              className="rounded-lg border border-input bg-background p-2 text-sm text-foreground">
              <option value="">Choisir le résultat vérifié</option>
              <option value="applied">{operation.stage === "create" ? "BL créé — référence retrouvée" : operation.stage === "attach" ? "Tous les colis restants sont rattachés" : "BL enregistré chez le transporteur"}</option>
              <option value="not_applied">{operation.stage === "create" ? "Aucun BL créé — absence vérifiée" : operation.stage === "attach" ? "Aucun des colis restants n'est rattaché" : "BL encore en brouillon — vérifié"}</option>
              {operation.stage === "attach" && <option value="partial">Une partie des colis restants est rattachée</option>}
              {orphan && operation.id.startsWith("legacy:") && <option value="unused">Ancien BL inutilisé — aucun colis chez le transporteur, vérifié</option>}
            </select>
            {operation.stage === "create" && outcome === "applied" && <>
              <Label htmlFor={`${prefix}-ref`}>Référence du BL existant chez le transporteur</Label>
              <Input id={`${prefix}-ref`} value={ref} required maxLength={128} onChange={event => setRef(event.target.value)} />
            </>}
            {outcome === "partial" && <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-xs text-muted-foreground">Cochez uniquement les rattachements confirmés. Les autres doivent être vérifiés absents de ce BL.</legend>
              {missing.map(parcel => <label key={parcel.submissionId} className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox checked={attachedIds.has(parcel.submissionId)} onCheckedChange={checked => {
                  setAttachedIds(previous => { const next = new Set(previous); if (checked) next.add(parcel.submissionId); else next.delete(parcel.submissionId); return next; });
                }} />
                {parcel.trackingNumber} · {parcel.customerName}
              </label>)}
            </fieldset>}
            <Label htmlFor={`${prefix}-evidence`}>Vérification effectuée et preuve / référence support</Label>
            <Textarea id={`${prefix}-evidence`} value={evidence} required minLength={10} maxLength={1000}
              placeholder="Ex. : portail du transporteur vérifié le…, référence…, codes de suivi présents / absents…"
              onChange={event => setEvidence(event.target.value)} />
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={pending || !outcome || (orphan && outcome !== "unused" && !selectedReady.length)}>
              {pending ? "Enregistrement…" : "Enregistrer la résolution"}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>Annuler</Button>
          </div>
        </form>
      )}
      {onExplain && <Button type="button" variant="outline" size="sm" onClick={onExplain}>Expliquer ce BL avec Z-800</Button>}
    </li>
  );
}
