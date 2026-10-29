"use client";

import { useState } from "react";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  Loader2Icon,
  PlugIcon,
  TruckIcon,
} from "lucide-react";
import type { CourierHealth } from "@/lib/services/courier-health";
import { formatCasablancaDisplay } from "@/lib/callback-time";
import { cn } from "@/lib/utils";

export interface CourierHealthCardProps {
  health: CourierHealth;
  isAdmin: boolean;
}

export function CourierHealthCard({ health, isAdmin }: CourierHealthCardProps) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  async function handleTest() {
    if (testing) return;
    setTesting(true);
    setTestResult(null);

    try {
      const res = await fetch("/api/crm/courier/test", { method: "POST" });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        skipped?: boolean;
        error?: string;
      } | null;

      if (!res.ok) {
        setTestResult({
          ok: false,
          message: data?.error ?? `Erreur (${res.status})`,
        });
        return;
      }

      if (data?.skipped) {
        setTestResult({
          ok: true,
          message: "Connexion réussie (mode test)",
        });
      } else if (data?.ok) {
        setTestResult({
          ok: true,
          message: "Connexion réussie",
        });
      } else {
        setTestResult({
          ok: false,
          message: data?.error ?? "Échec du test de connexion.",
        });
      }
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : "Erreur réseau",
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <article
      className={cn(
        "rounded-xl border p-5 transition-colors",
        !health.configured
          ? "border-[var(--crm-danger)]/40 bg-[var(--crm-danger-bg)]/20"
          : "border-border bg-card text-card-foreground",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <TruckIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <h2 className="text-base font-semibold text-foreground">
            Transporteur : {health.label}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
              health.mode === "mock"
                ? "border-[var(--crm-warning)]/40 bg-[var(--crm-warning-bg)] text-[var(--crm-warning)]"
                : "border-[var(--crm-info)]/40 bg-[var(--crm-info-bg)] text-[var(--crm-info)]",
            )}
          >
            {health.mode === "mock" ? "Mode test" : "Live"}
          </span>
          {health.configured ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-[var(--crm-success)]/40 bg-[var(--crm-success-bg)] px-2.5 py-0.5 text-xs font-medium text-[var(--crm-success)]">
              <CheckCircle2Icon className="size-3" aria-hidden />
              Prêt
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-[var(--crm-danger)]/40 bg-[var(--crm-danger-bg)] px-2.5 py-0.5 text-xs font-medium text-[var(--crm-danger)]">
              <AlertCircleIcon className="size-3" aria-hidden />
              À configurer
            </span>
          )}
        </div>
      </div>

      {health.issues.length > 0 ? (
        <div className="mt-4 rounded-lg border border-[var(--crm-danger)]/30 bg-[var(--crm-danger-bg)] p-3">
          <p className="text-xs font-medium text-[var(--crm-danger)]">
            Problèmes bloquant la transmission :
          </p>
          <ul className="mt-1 list-disc list-inside space-y-1 text-xs text-[var(--crm-danger)]">
            {health.issues.map((issue, idx) => (
              <li key={idx}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-border/50 bg-background/50 p-3">
          <p className="text-xs text-muted-foreground">Villes</p>
          <p className="mt-1 font-semibold text-lg tabular-nums text-foreground">
            {health.citiesCount}
          </p>
        </div>
        <div className="rounded-lg border border-border/50 bg-background/50 p-3">
          <p className="text-xs text-muted-foreground">En attente bloqués</p>
          <p
            className={cn(
              "mt-1 font-semibold text-lg tabular-nums",
              health.queuedBlocked > 0 ? "text-[var(--crm-danger)]" : "text-foreground",
            )}
          >
            {health.queuedBlocked}
          </p>
        </div>
        <div className="rounded-lg border border-border/50 bg-background/50 p-3">
          <p className="text-xs text-muted-foreground">À résoudre</p>
          <p
            className={cn(
              "mt-1 font-semibold text-lg tabular-nums",
              health.needsReview > 0 ? "text-[var(--crm-warning)]" : "text-foreground",
            )}
          >
            {health.needsReview}
          </p>
        </div>
        <div className="rounded-lg border border-border/50 bg-background/50 p-3">
          <p className="text-xs text-muted-foreground">Colis à problème</p>
          <p
            className={cn(
              "mt-1 font-semibold text-lg tabular-nums",
              health.deliveryIssues > 0 ? "text-[var(--crm-danger)]" : "text-foreground",
            )}
          >
            {health.deliveryIssues}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 text-xs">
        <div>
          <span className="text-muted-foreground">Dernière synchro villes : </span>
          <span className="font-medium text-foreground">
            {health.lastCitiesSyncAt
              ? formatCasablancaDisplay(health.lastCitiesSyncAt)
              : "Jamais synchronisé"}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Dernière synchro suivi : </span>
          <span className="font-medium text-foreground">
            {health.lastTrackingSyncAt
              ? formatCasablancaDisplay(health.lastTrackingSyncAt)
              : "Jamais synchronisé"}
          </span>
        </div>
      </div>

      {isAdmin ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border/60 pt-3">
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          >
            {testing ? (
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <PlugIcon className="size-3.5" aria-hidden />
            )}
            {testing ? "Test en cours..." : "Tester la connexion"}
          </button>

          {testResult ? (
            <div
              className={cn(
                "inline-flex items-center gap-1.5 text-xs font-medium",
                testResult.ok ? "text-[var(--crm-success)]" : "text-[var(--crm-danger)]",
              )}
            >
              {testResult.ok ? (
                <CheckCircle2Icon className="size-3.5 shrink-0" aria-hidden />
              ) : (
                <AlertTriangleIcon className="size-3.5 shrink-0" aria-hidden />
              )}
              <span>{testResult.message}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
