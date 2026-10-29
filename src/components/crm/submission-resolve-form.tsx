"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const fieldClassName =
  "w-full border-input bg-background text-foreground placeholder:text-muted-foreground/50 focus-visible:border-ring focus-visible:ring-ring/20";

type Outcome = "parcel_exists" | "no_parcel";

/**
 * Attributed resolution of a failed / uncertain courier submission. The agent
 * must have checked the courier portal first; the evidence is stored with the
 * decision (no SQL edits, no blind retries).
 */
export function SubmissionResolveForm({ submissionId }: { submissionId: string }) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<Outcome | "">("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [evidence, setEvidence] = useState("");
  const [pending, setPending] = useState(false);

  const ready =
    outcome !== "" &&
    evidence.trim().length >= 10 &&
    (outcome !== "parcel_exists" || trackingNumber.trim().length >= 3);

  async function submit() {
    if (!ready || pending) return;
    setPending(true);
    try {
      const response = await fetch(`/api/crm/submissions/${submissionId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          outcome === "parcel_exists"
            ? { outcome, trackingNumber: trackingNumber.trim(), evidence: evidence.trim() }
            : { outcome, evidence: evidence.trim() },
        ),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        toast.error(data?.error ?? "Résolution impossible.");
        return;
      }
      toast.success(
        outcome === "parcel_exists"
          ? "Colis rattaché — soumission marquée envoyée."
          : "Soumission remise en file d'envoi.",
      );
      router.refresh();
    } catch {
      toast.error("Résolution impossible.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-[var(--crm-warning)]/40 bg-[var(--crm-warning-bg)] p-3">
      <p className="text-sm font-medium text-[var(--crm-warning)]">Vérification requise</p>
      <p className="text-xs text-foreground/80">
        Vérifiez d&apos;abord le portail du transporteur : le colis a-t-il été créé pour cette
        commande ? Ne renvoyez jamais sans cette vérification (risque de doublon
        et de double encaissement).
      </p>
      <fieldset className="space-y-2">
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input
            type="radio"
            name={`outcome-${submissionId}`}
            checked={outcome === "parcel_exists"}
            onChange={() => setOutcome("parcel_exists")}
            className="mt-1"
          />
          Le colis existe sur le portail
        </label>
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input
            type="radio"
            name={`outcome-${submissionId}`}
            checked={outcome === "no_parcel"}
            onChange={() => setOutcome("no_parcel")}
            className="mt-1"
          />
          Aucun colis n&apos;existe — renvoyer en file
        </label>
      </fieldset>
      {outcome === "parcel_exists" ? (
        <div className="space-y-1.5">
          <Label htmlFor={`tracking-${submissionId}`} className="text-foreground">
            Numéro de suivi du portail
          </Label>
          <Input
            id={`tracking-${submissionId}`}
            value={trackingNumber}
            onChange={(event) => setTrackingNumber(event.target.value)}
            maxLength={64}
            className={fieldClassName}
          />
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor={`evidence-${submissionId}`} className="text-foreground">
          Vérification effectuée <span className="text-muted-foreground">(obligatoire)</span>
        </Label>
        <Textarea
          id={`evidence-${submissionId}`}
          rows={2}
          value={evidence}
          onChange={(event) => setEvidence(event.target.value)}
          maxLength={1000}
          placeholder="Ex. portail du transporteur consulté le 14/10, aucun colis au nom de la cliente."
          className={fieldClassName}
        />
      </div>
      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={submit} disabled={!ready || pending}>
          {pending ? "Enregistrement…" : "Enregistrer la résolution"}
        </Button>
      </div>
    </div>
  );
}
