"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { normalizeMaPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import type {
  WhatsAppConnectionState,
  WhatsAppSettings,
} from "@/lib/whatsapp-settings-schema";

export interface WhatsAppSettingsFormProps {
  initialSettings: WhatsAppSettings;
  connectionState: WhatsAppConnectionState;
  configured: {
    evolution: boolean;
    ai: boolean;
  };
  storeName: string;
}

function formatConnectionDate(isoString: string): string | null {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString("fr-FR", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Africa/Casablanca",
    });
  } catch {
    return null;
  }
}

/** "il y a …" relative age, hydration-safe (computed only after mount). */
function formatRelativeAge(isoString: string, now: number): string | null {
  const then = new Date(isoString).getTime();
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "il y a moins d’une minute";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.floor(hours / 24)} j`;
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs font-medium text-destructive">
      {message}
    </p>
  );
}

export function WhatsAppSettingsForm({
  initialSettings,
  connectionState,
  configured,
  storeName,
}: WhatsAppSettingsFormProps) {
  const router = useRouter();

  // 2. Interrupteur principal
  const [enabled, setEnabled] = useState(initialSettings.enabled);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);

  // 3. Notifications clients
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    initialSettings.notificationsEnabled,
  );
  const [notifyConfirmed, setNotifyConfirmed] = useState(initialSettings.notifyConfirmed);
  const [notifyShipped, setNotifyShipped] = useState(initialSettings.notifyShipped);
  const [notifyDelivered, setNotifyDelivered] = useState(initialSettings.notifyDelivered);
  const [notifyOutForDelivery, setNotifyOutForDelivery] = useState(
    initialSettings.notifyOutForDelivery,
  );
  const [notifyDeliveryIssue, setNotifyDeliveryIssue] = useState(
    initialSettings.notifyDeliveryIssue,
  );
  const [notifyCancelled, setNotifyCancelled] = useState(initialSettings.notifyCancelled);
  const [relanceAfterNoAnswer, setRelanceAfterNoAnswer] = useState(
    initialSettings.relanceAfterNoAnswer,
  );
  const [relanceNoAnswerCount, setRelanceNoAnswerCount] = useState(
    String(initialSettings.relanceNoAnswerCount),
  );

  // 4. Alertes admin
  const [adminAlertsEnabled, setAdminAlertsEnabled] = useState(
    initialSettings.adminAlertsEnabled,
  );
  const [adminPhones, setAdminPhones] = useState<string[]>(initialSettings.adminPhones);
  const [newPhoneInput, setNewPhoneInput] = useState("");
  const [phoneInputError, setPhoneInputError] = useState<string | null>(null);
  const [adminQuietHours, setAdminQuietHours] = useState(initialSettings.adminQuietHours);

  // 5. Rythme d'envoi
  const [sendWindowStart, setSendWindowStart] = useState(initialSettings.sendWindowStart);
  const [sendWindowEnd, setSendWindowEnd] = useState(initialSettings.sendWindowEnd);
  const [dailyOutboundCap, setDailyOutboundCap] = useState(String(initialSettings.dailyOutboundCap));
  const [minGapSeconds, setMinGapSeconds] = useState(String(initialSettings.minGapSeconds));
  const [maxGapSeconds, setMaxGapSeconds] = useState(String(initialSettings.maxGapSeconds));

  // 6. Assistant IA
  const [aiEnabled, setAiEnabled] = useState(configured.ai && initialSettings.aiEnabled);
  const [assistantName, setAssistantName] = useState(initialSettings.assistantName);
  const [faqText, setFaqText] = useState(initialSettings.faqText);
  const [aiDailyBudgetUsd, setAiDailyBudgetUsd] = useState(
    (initialSettings.aiDailyBudgetCents / 100).toFixed(2),
  );
  const [aiResumeAfterHours, setAiResumeAfterHours] = useState(
    String(initialSettings.aiResumeAfterHours),
  );

  // 7. Sécurité clients
  const [autoBlockEnabled, setAutoBlockEnabled] = useState(initialSettings.autoBlockEnabled);

  // 8. Fonctions avancées
  const [catalogSuggestionsEnabled, setCatalogSuggestionsEnabled] = useState(
    initialSettings.catalogSuggestionsEnabled,
  );
  const [crossSellEnabled, setCrossSellEnabled] = useState(initialSettings.crossSellEnabled);
  const [orderEditProposalsEnabled, setOrderEditProposalsEnabled] = useState(
    initialSettings.orderEditProposalsEnabled,
  );

  // 9. Médias
  const [mediaRetentionDays, setMediaRetentionDays] = useState(
    String(initialSettings.mediaRetentionDays),
  );

  // Form submit state
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof WhatsAppSettings, string>>>({});
  // Connection age is relative: compute after mount only, to avoid hydration mismatch.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  function clearField(key: keyof WhatsAppSettings) {
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  useEffect(() => {
    setEnabled(initialSettings.enabled);
    setNotificationsEnabled(initialSettings.notificationsEnabled);
    setNotifyConfirmed(initialSettings.notifyConfirmed);
    setNotifyShipped(initialSettings.notifyShipped);
    setNotifyDelivered(initialSettings.notifyDelivered);
    setNotifyOutForDelivery(initialSettings.notifyOutForDelivery);
    setNotifyDeliveryIssue(initialSettings.notifyDeliveryIssue);
    setNotifyCancelled(initialSettings.notifyCancelled);
    setRelanceAfterNoAnswer(initialSettings.relanceAfterNoAnswer);
    setRelanceNoAnswerCount(String(initialSettings.relanceNoAnswerCount));
    setAdminAlertsEnabled(initialSettings.adminAlertsEnabled);
    setAdminPhones(initialSettings.adminPhones);
    setAdminQuietHours(initialSettings.adminQuietHours);
    setSendWindowStart(initialSettings.sendWindowStart);
    setSendWindowEnd(initialSettings.sendWindowEnd);
    setDailyOutboundCap(String(initialSettings.dailyOutboundCap));
    setMinGapSeconds(String(initialSettings.minGapSeconds));
    setMaxGapSeconds(String(initialSettings.maxGapSeconds));
    setAiEnabled(configured.ai && initialSettings.aiEnabled);
    setAssistantName(initialSettings.assistantName);
    setFaqText(initialSettings.faqText);
    setAiDailyBudgetUsd((initialSettings.aiDailyBudgetCents / 100).toFixed(2));
    setAiResumeAfterHours(String(initialSettings.aiResumeAfterHours));
    setAutoBlockEnabled(initialSettings.autoBlockEnabled);
    setCatalogSuggestionsEnabled(initialSettings.catalogSuggestionsEnabled);
    setCrossSellEnabled(initialSettings.crossSellEnabled);
    setOrderEditProposalsEnabled(initialSettings.orderEditProposalsEnabled);
    setMediaRetentionDays(String(initialSettings.mediaRetentionDays));
  }, [initialSettings, configured.ai]);

  function handleToggleEnabled() {
    if (enabled) {
      setEnabled(false);
    } else {
      setConfirmDialogOpen(true);
    }
  }

  function handleAddAdminPhone() {
    const trimmed = newPhoneInput.trim();
    if (!trimmed) return;
    if (adminPhones.length >= 5) {
      setPhoneInputError("Maximum 5 numéros administrateurs.");
      return;
    }
    const normalized = normalizeMaPhone(trimmed);
    if (!normalized) {
      setPhoneInputError("Numéro marocain invalide (ex : 0612345678 ou +212612345678).");
      return;
    }
    if (adminPhones.includes(normalized)) {
      setPhoneInputError("Ce numéro est déjà présent dans la liste.");
      return;
    }
    setAdminPhones([...adminPhones, normalized]);
    setNewPhoneInput("");
    setPhoneInputError(null);
  }

  function handleRemoveAdminPhone(phone: string) {
    setAdminPhones(adminPhones.filter((p) => p !== phone));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    // Client-side validation (the server stays the authority). Errors are mapped to fields.
    const errors: Partial<Record<keyof WhatsAppSettings, string>> = {};

    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!timeRegex.test(sendWindowStart)) {
      errors.sendWindowStart = "Format attendu : HH:MM.";
    }
    if (!timeRegex.test(sendWindowEnd)) {
      errors.sendWindowEnd = "Format attendu : HH:MM.";
    }
    if (!errors.sendWindowStart && !errors.sendWindowEnd && sendWindowStart >= sendWindowEnd) {
      errors.sendWindowEnd = "L’heure de fin doit être postérieure à l’heure de début.";
    }

    const capValue = Number.parseInt(dailyOutboundCap, 10);
    if (!Number.isInteger(capValue) || capValue < 1 || capValue > 1000) {
      errors.dailyOutboundCap = "Le plafond quotidien doit être compris entre 1 et 1000.";
    }

    const minGapValue = Number.parseInt(minGapSeconds, 10);
    if (!Number.isInteger(minGapValue) || minGapValue < 5 || minGapValue > 600) {
      errors.minGapSeconds = "L'écart minimum doit être compris entre 5 et 600 secondes.";
    }
    const maxGapValue = Number.parseInt(maxGapSeconds, 10);
    if (!Number.isInteger(maxGapValue) || maxGapValue < 5 || maxGapValue > 1800) {
      errors.maxGapSeconds = "L'écart maximum doit être compris entre 5 et 1800 secondes.";
    }
    if (
      Number.isInteger(minGapValue) &&
      Number.isInteger(maxGapValue) &&
      minGapValue > maxGapValue
    ) {
      errors.minGapSeconds = "L'écart minimum doit être inférieur ou égal à l'écart maximum.";
    }

    const relanceValue = Number.parseInt(relanceNoAnswerCount, 10);
    if (!Number.isInteger(relanceValue) || relanceValue < 1 || relanceValue > 5) {
      errors.relanceNoAnswerCount = "Le nombre d'appels sans réponse doit être compris entre 1 et 5.";
    }

    const budgetUsd = Number.parseFloat(aiDailyBudgetUsd.replace(",", "."));
    if (!Number.isFinite(budgetUsd) || budgetUsd < 0 || budgetUsd > 100) {
      errors.aiDailyBudgetCents =
        "Budget quotidien IA invalide : entrez un montant en dollars entre 0,00 et 100,00.";
    }
    const aiDailyBudgetCents = Number.isFinite(budgetUsd) ? Math.round(budgetUsd * 100) : 0;

    const resumeValue = Number.parseInt(aiResumeAfterHours, 10);
    if (!Number.isInteger(resumeValue) || resumeValue < 1 || resumeValue > 168) {
      errors.aiResumeAfterHours = "Le délai de reprise de l'IA doit être compris entre 1 et 168 heures.";
    }

    const retentionValue = Number.parseInt(mediaRetentionDays, 10);
    if (!Number.isInteger(retentionValue) || retentionValue < 7 || retentionValue > 365) {
      errors.mediaRetentionDays = "La rétention des médias doit être comprise entre 7 et 365 jours.";
    }

    if (assistantName.trim().length > 60) {
      errors.assistantName = "Le nom de l'assistant ne peut dépasser 60 caractères.";
    }
    if (faqText.length > 4000) {
      errors.faqText = "Le texte de la FAQ ne peut dépasser 4000 caractères.";
    }
    if (adminPhones.length > 5) {
      errors.adminPhones = "Maximum 5 numéros administrateurs.";
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setError("Vérifiez les champs signalés ci-dessous.");
      toast.error("Vérifiez les champs signalés ci-dessous.");
      return;
    }

    // Candidate values after successful validation.
    const next: WhatsAppSettings = {
      enabled,
      notificationsEnabled,
      notifyConfirmed,
      notifyShipped,
      notifyDelivered,
      notifyOutForDelivery,
      notifyDeliveryIssue,
      notifyCancelled,
      relanceAfterNoAnswer,
      relanceNoAnswerCount: relanceValue,
      adminAlertsEnabled,
      adminPhones,
      adminQuietHours,
      sendWindowStart,
      sendWindowEnd,
      dailyOutboundCap: capValue,
      minGapSeconds: minGapValue,
      maxGapSeconds: maxGapValue,
      // Not configured: the checkbox is locked, so never send a change for it.
      aiEnabled: configured.ai ? aiEnabled : initialSettings.aiEnabled,
      assistantName,
      faqText,
      aiDailyBudgetCents,
      aiResumeAfterHours: resumeValue,
      autoBlockEnabled,
      catalogSuggestionsEnabled,
      crossSellEnabled,
      orderEditProposalsEnabled,
      mediaRetentionDays: retentionValue,
    };

    // Send only the changed fields with PUT.
    const patch: Partial<Record<keyof WhatsAppSettings, string | number | boolean | string[]>> = {};
    let changed = false;
    for (const key of Object.keys(next) as Array<keyof WhatsAppSettings>) {
      const value = next[key];
      const initial = initialSettings[key];
      const differs =
        Array.isArray(value) || Array.isArray(initial)
          ? JSON.stringify(value) !== JSON.stringify(initial)
          : value !== initial;
      if (differs) {
        patch[key] = value;
        changed = true;
      }
    }
    if (!changed) {
      toast.info("Aucune modification à enregistrer.");
      return;
    }

    setError(null);
    setFieldErrors({});
    setPending(true);

    try {
      const response = await fetch("/api/crm/whatsapp/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await response.json().catch(() => null)) as
        | { error?: string; field?: string; settings?: WhatsAppSettings }
        | null;
      if (!response.ok) {
        const message = data?.error ?? "Impossible d’enregistrer les paramètres WhatsApp.";
        const field = typeof data?.field === "string" ? data.field : null;
        if (field && field in next) {
          setFieldErrors({ [field]: message } as Partial<Record<keyof WhatsAppSettings, string>>);
        }
        setError(message);
        toast.error(message);
        return;
      }
      setFieldErrors({});
      toast.success("Paramètres WhatsApp enregistrés.");
      router.refresh();
    } catch {
      setError("Erreur de connexion. Veuillez réessayer.");
      toast.error("Erreur de connexion. Veuillez réessayer.");
    } finally {
      setPending(false);
    }
  }

  const formattedUpdatedAt = connectionState.updatedAt
    ? formatConnectionDate(connectionState.updatedAt)
    : null;
  const relativeAge =
    connectionState.updatedAt && now !== null
      ? formatRelativeAge(connectionState.updatedAt, now)
      : null;

  return (
    <>
      <form onSubmit={save} aria-busy={pending} className="flex max-w-3xl flex-col gap-8">
        {/* 1. Statut */}
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Statut du service
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {configured.evolution ? (
              <Badge
                variant="outline"
                className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              >
                Evolution configuré
              </Badge>
            ) : (
              <Badge variant="destructive">Evolution non configuré</Badge>
            )}

            {configured.ai ? (
              <Badge
                variant="outline"
                className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              >
                IA configurée
              </Badge>
            ) : (
              <Badge variant="secondary">IA non configurée</Badge>
            )}

            {connectionState.state === "open" && (
              <Badge
                variant="outline"
                className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              >
                Connexion : connecté
              </Badge>
            )}
            {connectionState.state === "connecting" && (
              <Badge
                variant="outline"
                className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
              >
                Connexion : en cours
              </Badge>
            )}
            {connectionState.state === "close" && (
              <Badge variant="destructive">Connexion : déconnecté</Badge>
            )}
            {connectionState.state === "unknown" && (
              <Badge variant="secondary">Connexion : inconnu</Badge>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            {connectionState.updatedAt
              ? relativeAge
                ? `Statut de connexion mis à jour ${relativeAge}${
                    formattedUpdatedAt ? ` (${formattedUpdatedAt})` : ""
                  }.`
                : `Statut de connexion mis à jour le ${formattedUpdatedAt ?? "à une date inconnue"}.`
              : "Aucun statut de connexion reçu pour le moment."}
          </p>

          {(!configured.evolution || !configured.ai) && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
              <p className="font-medium">Variables d&apos;environnement requises :</p>
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs">
                {!configured.evolution && (
                  <li>
                    Evolution API : <code className="font-mono font-semibold">EVOLUTION_BASE_URL</code>,{" "}
                    <code className="font-mono font-semibold">EVOLUTION_INSTANCE</code>,{" "}
                    <code className="font-mono font-semibold">EVOLUTION_API_KEY</code>,{" "}
                    <code className="font-mono font-semibold">WHATSAPP_WEBHOOK_SECRET</code> (≥ 32 caractères)
                  </li>
                )}
                {!configured.ai && (
                  <li>
                    Assistant IA : <code className="font-mono font-semibold">OPENROUTER_API_KEY</code>
                  </li>
                )}
              </ul>
              <p className="mt-2 text-xs">
                Consultez <code className="font-mono font-semibold">docs/whatsapp.md</code> à la racine
                du projet pour la procédure de configuration complète.
              </p>
            </div>
          )}
        </section>

        <hr className="border-border" />

        {/* 2. Interrupteur principal */}
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-foreground">
                  WhatsApp actif (arrêt d&apos;urgence si désactivé)
                </span>
                <Badge variant={enabled ? "default" : "secondary"}>
                  {enabled ? "Actif" : "Inactif"}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Coupe-circuit général. Lorsqu&apos;il est désactivé, aucun message sortant n&apos;est
                envoyé et l&apos;IA ne répond plus.
              </p>
            </div>
            <div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                onClick={handleToggleEnabled}
                disabled={pending || (!enabled && !configured.evolution)}
                className={cn(
                  "relative inline-flex h-8 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
                  enabled ? "bg-primary" : "bg-muted-foreground/30",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none inline-block size-7 transform rounded-full bg-background shadow-lg ring-0 transition duration-200 ease-in-out",
                    enabled ? "translate-x-5" : "translate-x-0",
                  )}
                />
                <span className="sr-only">
                  {enabled ? "Désactiver WhatsApp" : "Activer WhatsApp"}
                </span>
              </button>
            </div>
          </div>
        </section>

        <hr className="border-border" />

        {/* 3. Notifications clients */}
        <section className="flex flex-col gap-4">
          <div>
            <h3 className="text-base font-semibold">Notifications clients</h3>
            <p className="text-sm text-muted-foreground">
              Messages automatisés envoyés aux clients pour suivre l&apos;avancement de leur commande.
            </p>
          </div>

          <div className="flex items-start gap-3">
            <Checkbox
              id="notificationsEnabled"
              checked={notificationsEnabled}
              onCheckedChange={(c) => setNotificationsEnabled(c === true)}
              disabled={pending}
            />
            <div className="space-y-0.5">
              <Label htmlFor="notificationsEnabled" className="cursor-pointer font-medium">
                Activer les notifications automatiques aux clients
              </Label>
              <p className="text-xs text-muted-foreground">
                Active l&apos;envoi des messages d&apos;événements cochés ci-dessous.
              </p>
            </div>
          </div>

          <div className="ml-7 grid gap-3 sm:grid-cols-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="notifyConfirmed"
                checked={notifyConfirmed}
                onCheckedChange={(c) => setNotifyConfirmed(c === true)}
                disabled={pending || !notificationsEnabled}
              />
              <Label
                htmlFor="notifyConfirmed"
                className={cn("text-sm", notificationsEnabled ? "cursor-pointer" : "opacity-60")}
              >
                Commande confirmée
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="notifyShipped"
                checked={notifyShipped}
                onCheckedChange={(c) => setNotifyShipped(c === true)}
                disabled={pending || !notificationsEnabled}
              />
              <Label
                htmlFor="notifyShipped"
                className={cn("text-sm", notificationsEnabled ? "cursor-pointer" : "opacity-60")}
              >
                Colis expédié avec suivi
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id="notifyOutForDelivery"
                className="mt-0.5"
                checked={notifyOutForDelivery}
                onCheckedChange={(c) => setNotifyOutForDelivery(c === true)}
                disabled={pending || !notificationsEnabled}
              />
              <div className="space-y-0.5">
                <Label
                  htmlFor="notifyOutForDelivery"
                  className={cn("text-sm", notificationsEnabled ? "cursor-pointer" : "opacity-60")}
                >
                  En cours de livraison (tournée)
                </Label>
                <p className="text-xs text-muted-foreground">
                  S&apos;active uniquement pour les statuts transporteur mappés.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="notifyDelivered"
                checked={notifyDelivered}
                onCheckedChange={(c) => setNotifyDelivered(c === true)}
                disabled={pending || !notificationsEnabled}
              />
              <Label
                htmlFor="notifyDelivered"
                className={cn("text-sm", notificationsEnabled ? "cursor-pointer" : "opacity-60")}
              >
                Colis livré
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id="notifyDeliveryIssue"
                className="mt-0.5"
                checked={notifyDeliveryIssue}
                onCheckedChange={(c) => setNotifyDeliveryIssue(c === true)}
                disabled={pending || !notificationsEnabled}
              />
              <div className="space-y-0.5">
                <Label
                  htmlFor="notifyDeliveryIssue"
                  className={cn("text-sm", notificationsEnabled ? "cursor-pointer" : "opacity-60")}
                >
                  Problème de livraison
                </Label>
                <p className="text-xs text-muted-foreground">
                  S&apos;active uniquement pour les statuts transporteur mappés.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="notifyCancelled"
                checked={notifyCancelled}
                onCheckedChange={(c) => setNotifyCancelled(c === true)}
                disabled={pending || !notificationsEnabled}
              />
              <Label
                htmlFor="notifyCancelled"
                className={cn("text-sm", notificationsEnabled ? "cursor-pointer" : "opacity-60")}
              >
                Commande annulée
              </Label>
            </div>
          </div>

          <div className="ml-7 flex flex-col gap-3 rounded-lg border border-border/70 bg-muted/20 p-3 sm:max-w-md">
            <div className="flex items-start gap-2">
              <Checkbox
                id="relanceAfterNoAnswer"
                checked={relanceAfterNoAnswer}
                onCheckedChange={(c) => setRelanceAfterNoAnswer(c === true)}
                disabled={pending || !notificationsEnabled}
              />
              <div className="space-y-0.5">
                <Label
                  htmlFor="relanceAfterNoAnswer"
                  className={cn(
                    "text-sm font-medium",
                    notificationsEnabled ? "cursor-pointer" : "opacity-60",
                  )}
                >
                  Relance après appels sans réponse
                </Label>
                <p className="text-xs text-muted-foreground">
                  Envoie un message WhatsApp invitant le client à rappeler après tentatives
                  infructueuses.
                </p>
              </div>
            </div>
            {relanceAfterNoAnswer && (
              <div className="flex flex-col gap-1.5 pl-6">
                <Label htmlFor="relanceNoAnswerCount" className="text-xs">
                  Nombre d&apos;appels sans réponse avant relance (1 à 5)
                </Label>
                <Input
                  id="relanceNoAnswerCount"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={5}
                  value={relanceNoAnswerCount}
                  onChange={(e) => {
                    setRelanceNoAnswerCount(e.target.value);
                    clearField("relanceNoAnswerCount");
                  }}
                  disabled={pending || !notificationsEnabled}
                  aria-invalid={"relanceNoAnswerCount" in fieldErrors || undefined}
                  aria-describedby={fieldErrors.relanceNoAnswerCount ? "error-relanceNoAnswerCount" : undefined}
                  className="h-9 w-24"
                />
                <FieldError
                  id="error-relanceNoAnswerCount"
                  message={fieldErrors.relanceNoAnswerCount}
                />
              </div>
            )}
          </div>
        </section>

        <hr className="border-border" />

        {/* 4. Alertes admin */}
        <section className="flex flex-col gap-4">
          <div>
            <h3 className="text-base font-semibold">Alertes admin</h3>
            <p className="text-sm text-muted-foreground">
              Notifications WhatsApp envoyées aux administrateurs lors des événements clés (ex :
              commande confirmée).
            </p>
          </div>

          <div className="flex items-start gap-3">
            <Checkbox
              id="adminAlertsEnabled"
              checked={adminAlertsEnabled}
              onCheckedChange={(c) => setAdminAlertsEnabled(c === true)}
              disabled={pending}
            />
            <div className="space-y-0.5">
              <Label htmlFor="adminAlertsEnabled" className="cursor-pointer font-medium">
                Activer les alertes administrateur
              </Label>
              <p className="text-xs text-muted-foreground">
                Envoie une alerte WhatsApp aux numéros ci-dessous dès qu&apos;une commande est confirmée.
              </p>
            </div>
          </div>

          <div className="ml-7 flex flex-col gap-3">
            <Label className="text-sm font-medium">Numéros administrateurs (max 5)</Label>
            {adminPhones.length === 0 ? (
              <p className="text-xs text-muted-foreground">Aucun numéro configuré.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {adminPhones.map((phone) => (
                  <div
                    key={phone}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1 text-xs font-mono"
                  >
                    <span>{phone}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveAdminPhone(phone)}
                      disabled={pending}
                      aria-label={`Supprimer ${phone}`}
                      className="text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none"
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {adminPhones.length < 5 && (
              <div className="flex flex-col gap-2 sm:max-w-md">
                <div className="flex gap-2">
                  <Input
                    value={newPhoneInput}
                    onChange={(e) => {
                      setNewPhoneInput(e.target.value);
                      setPhoneInputError(null);
                    }}
                    placeholder="0612345678 ou +212612345678"
                    disabled={pending}
                    className="h-9 font-mono text-sm"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddAdminPhone();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleAddAdminPhone}
                    disabled={pending || !newPhoneInput.trim()}
                    className="h-9 shrink-0"
                  >
                    <PlusIcon className="mr-1 size-3.5" />
                    Ajouter
                  </Button>
                </div>
                {phoneInputError && (
                  <p className="text-xs text-destructive">{phoneInputError}</p>
                )}
              </div>
            )}
            <FieldError id="error-adminPhones" message={fieldErrors.adminPhones} />

            <div className="mt-2 flex items-start gap-2">
              <Checkbox
                id="adminQuietHours"
                checked={adminQuietHours}
                onCheckedChange={(c) => setAdminQuietHours(c === true)}
                disabled={pending}
              />
              <div className="space-y-0.5">
                <Label htmlFor="adminQuietHours" className="cursor-pointer text-xs font-medium">
                  Respecter la fenêtre d&apos;envoi pour les alertes admin
                </Label>
                <p className="text-xs text-muted-foreground">
                  Si activé, les alertes admin ne seront pas envoyées la nuit en dehors de la
                  fenêtre d&apos;envoi configurée ci-dessous.
                </p>
              </div>
            </div>
          </div>
        </section>

        <hr className="border-border" />

        {/* 5. Rythme d'envoi */}
        <section className="flex flex-col gap-4">
          <div>
            <h3 className="text-base font-semibold">Rythme d&apos;envoi (sécurité anti-blocage)</h3>
            <p className="text-sm text-muted-foreground">
              Horaires, plafonds et cadencement des messages pour éviter tout signalement ou
              bannissement.
            </p>
            <div className="mt-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Les réponses de l&apos;IA à un client qui écrit partent 24h/24 ; seules les
              notifications respectent la plage.
            </div>
          </div>

          <div className="grid gap-4 sm:max-w-xl sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="sendWindowStart">Début de fenêtre d&apos;envoi</Label>
              <Input
                id="sendWindowStart"
                type="time"
                value={sendWindowStart}
                onChange={(e) => {
                  setSendWindowStart(e.target.value);
                  clearField("sendWindowStart");
                }}
                disabled={pending}
                aria-invalid={"sendWindowStart" in fieldErrors || undefined}
                aria-describedby={fieldErrors.sendWindowStart ? "error-sendWindowStart" : "sendWindowStart-help"}
                className="min-h-11"
                required
              />
              <FieldError id="error-sendWindowStart" message={fieldErrors.sendWindowStart} />
              <p id="sendWindowStart-help" className="text-xs text-muted-foreground">
                Fuseau Africa/Casablanca.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="sendWindowEnd">Fin de fenêtre d&apos;envoi</Label>
              <Input
                id="sendWindowEnd"
                type="time"
                value={sendWindowEnd}
                onChange={(e) => {
                  setSendWindowEnd(e.target.value);
                  clearField("sendWindowEnd");
                }}
                disabled={pending}
                aria-invalid={"sendWindowEnd" in fieldErrors || undefined}
                aria-describedby={fieldErrors.sendWindowEnd ? "error-sendWindowEnd" : "sendWindowEnd-help"}
                className="min-h-11"
                required
              />
              <FieldError id="error-sendWindowEnd" message={fieldErrors.sendWindowEnd} />
              <p id="sendWindowEnd-help" className="text-xs text-muted-foreground">
                Fuseau Africa/Casablanca.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:max-w-md">
            <Label htmlFor="dailyOutboundCap">Plafond quotidien d&apos;envois (messages / jour)</Label>
            <Input
              id="dailyOutboundCap"
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              value={dailyOutboundCap}
              onChange={(e) => {
                setDailyOutboundCap(e.target.value);
                clearField("dailyOutboundCap");
              }}
              disabled={pending}
              aria-invalid={"dailyOutboundCap" in fieldErrors || undefined}
              aria-describedby={fieldErrors.dailyOutboundCap ? "error-dailyOutboundCap" : "dailyOutboundCap-help"}
              className="min-h-11"
              required
            />
            <FieldError id="error-dailyOutboundCap" message={fieldErrors.dailyOutboundCap} />
            <p id="dailyOutboundCap-help" className="text-xs text-muted-foreground">
              Recommandé : 40 messages/jour en phase de rodage, puis 60–100 progressivement.
            </p>
          </div>

          <div className="grid gap-4 sm:max-w-xl sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="minGapSeconds">Écart minimum entre envois (secondes)</Label>
              <Input
                id="minGapSeconds"
                type="number"
                inputMode="numeric"
                min={5}
                max={600}
                value={minGapSeconds}
                onChange={(e) => {
                  setMinGapSeconds(e.target.value);
                  clearField("minGapSeconds");
                }}
                disabled={pending}
                aria-invalid={"minGapSeconds" in fieldErrors || undefined}
                aria-describedby={fieldErrors.minGapSeconds ? "error-minGapSeconds" : "minGapSeconds-help"}
                className="min-h-11"
                required
              />
              <FieldError id="error-minGapSeconds" message={fieldErrors.minGapSeconds} />
              <p id="minGapSeconds-help" className="text-xs text-muted-foreground">
                De 5 à 600 s (par défaut 30 s).
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="maxGapSeconds">Écart maximum entre envois (secondes)</Label>
              <Input
                id="maxGapSeconds"
                type="number"
                inputMode="numeric"
                min={5}
                max={1800}
                value={maxGapSeconds}
                onChange={(e) => {
                  setMaxGapSeconds(e.target.value);
                  clearField("maxGapSeconds");
                }}
                disabled={pending}
                aria-invalid={"maxGapSeconds" in fieldErrors || undefined}
                aria-describedby={fieldErrors.maxGapSeconds ? "error-maxGapSeconds" : "maxGapSeconds-help"}
                className="min-h-11"
                required
              />
              <FieldError id="error-maxGapSeconds" message={fieldErrors.maxGapSeconds} />
              <p id="maxGapSeconds-help" className="text-xs text-muted-foreground">
                De 5 à 1800 s (doit être ≥ minimum).
              </p>
            </div>
          </div>
        </section>

        <hr className="border-border" />

        {/* 6. Assistant IA */}
        <section className="flex flex-col gap-4">
          <div>
            <h3 className="text-base font-semibold">Assistant IA</h3>
            <p className="text-sm text-muted-foreground">
              Réponses automatiques 24/7 en Darija marocain, arabe et français via OpenRouter.
            </p>
          </div>

          <div className="flex items-start gap-3">
            <Checkbox
              id="aiEnabled"
              checked={aiEnabled}
              onCheckedChange={(c) => setAiEnabled(c === true)}
              disabled={pending || !configured.ai}
            />
            <div className="space-y-0.5">
              <Label
                htmlFor="aiEnabled"
                className={cn(
                  "font-medium",
                  !configured.ai ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                )}
              >
                Activer l&apos;assistant IA 24/7
              </Label>
              {!configured.ai ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Impossible à activer : la connexion Evolution et{" "}
                  <code className="font-mono">OPENROUTER_API_KEY</code> doivent être configurés
                  (voir « Statut du service » ci-dessus).
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  L&apos;IA répond aux messages, notes vocales et questions sans jamais confirmer ni
                  modifier seul une commande.
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:max-w-xl sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="assistantName">Nom de l&apos;assistant</Label>
              <Input
                id="assistantName"
                maxLength={60}
                value={assistantName}
                onChange={(e) => {
                  setAssistantName(e.target.value);
                  clearField("assistantName");
                }}
                placeholder={`Service client ${storeName}`}
                disabled={pending}
                aria-invalid={"assistantName" in fieldErrors || undefined}
                aria-describedby={fieldErrors.assistantName ? "error-assistantName" : "assistantName-help"}
                className="min-h-11"
              />
              <FieldError id="error-assistantName" message={fieldErrors.assistantName} />
              <p id="assistantName-help" className="text-xs text-muted-foreground">
                Si vide, l&apos;assistant se présente comme « Service client {storeName} ».
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="aiDailyBudgetUsd">Budget quotidien IA (USD $)</Label>
              <Input
                id="aiDailyBudgetUsd"
                type="number"
                step="0.01"
                min="0"
                max="100.00"
                value={aiDailyBudgetUsd}
                onChange={(e) => {
                  setAiDailyBudgetUsd(e.target.value);
                  clearField("aiDailyBudgetCents");
                }}
                disabled={pending}
                aria-invalid={"aiDailyBudgetCents" in fieldErrors || undefined}
                aria-describedby={fieldErrors.aiDailyBudgetCents ? "error-aiDailyBudgetCents" : "aiDailyBudgetUsd-help"}
                className="min-h-11"
                required
              />
              <FieldError id="error-aiDailyBudgetCents" message={fieldErrors.aiDailyBudgetCents} />
              <p id="aiDailyBudgetUsd-help" className="text-xs text-muted-foreground">
                Plafond en $ par jour (ex : 1.00 = 1,00 $). 0 coupe l&apos;IA.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:max-w-md">
            <Label htmlFor="aiResumeAfterHours">Délai de reprise par l&apos;IA (heures)</Label>
            <Input
              id="aiResumeAfterHours"
              type="number"
              inputMode="numeric"
              min={1}
              max={168}
              value={aiResumeAfterHours}
              onChange={(e) => {
                setAiResumeAfterHours(e.target.value);
                clearField("aiResumeAfterHours");
              }}
              disabled={pending}
              aria-invalid={"aiResumeAfterHours" in fieldErrors || undefined}
              aria-describedby={fieldErrors.aiResumeAfterHours ? "error-aiResumeAfterHours" : "aiResumeAfterHours-help"}
              className="min-h-11"
              required
            />
            <FieldError id="error-aiResumeAfterHours" message={fieldErrors.aiResumeAfterHours} />
            <p id="aiResumeAfterHours-help" className="text-xs text-muted-foreground">
              Délai après lequel l&apos;IA reprend la main si aucun agent ne répond (1 à 168 h, défaut
              12 h).
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="faqText">Instructions et FAQ pour l&apos;assistant</Label>
              <span className="text-xs text-muted-foreground">{faqText.length} / 4000</span>
            </div>
            <Textarea
              id="faqText"
              rows={6}
              maxLength={4000}
              value={faqText}
              onChange={(e) => {
                setFaqText(e.target.value);
                clearField("faqText");
              }}
              placeholder="Règles spécifiques, questions fréquentes, délais par ville, consignes de retours..."
              disabled={pending}
              aria-invalid={"faqText" in fieldErrors || undefined}
              aria-describedby={fieldErrors.faqText ? "error-faqText" : "faqText-help"}
              className="resize-y"
            />
            <FieldError id="error-faqText" message={fieldErrors.faqText} />
            <p id="faqText-help" className="text-xs text-muted-foreground">
              Instructions contextuelles injectées dans le prompt système de l&apos;assistant (max
              4000 caractères).
            </p>
          </div>
        </section>

        <hr className="border-border" />

        {/* 7. Sécurité clients */}
        <section className="flex flex-col gap-4">
          <div>
            <h3 className="text-base font-semibold">Sécurité clients</h3>
            <p className="text-sm text-muted-foreground">
              Protection contre les comportements abusifs et le spam.
            </p>
          </div>

          <div className="flex items-start gap-3">
            <Checkbox
              id="autoBlockEnabled"
              checked={autoBlockEnabled}
              onCheckedChange={(c) => setAutoBlockEnabled(c === true)}
              disabled={pending}
            />
            <div className="space-y-0.5">
              <Label htmlFor="autoBlockEnabled" className="cursor-pointer font-medium">
                Bloquer automatiquement les numéros abusifs
              </Label>
              <p className="text-xs text-muted-foreground">
                3 points = blocage auto ; avertissements envoyés même si désactivé. Le client
                cumule des avertissements pour refus de livraison, insultes ou annulations répétées.
              </p>
            </div>
          </div>
        </section>

        <hr className="border-border" />

        {/* 8. Fonctions avancées */}
        <section className="flex flex-col gap-4">
          <div>
            <h3 className="text-base font-semibold">Fonctions avancées (phase ultérieure)</h3>
            <p className="text-sm text-muted-foreground">
              Fonctionnalités prévues pour une phase ultérieure ; laissez-les désactivées pour le
              moment.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-3">
              <Checkbox
                id="catalogSuggestionsEnabled"
                checked={catalogSuggestionsEnabled}
                onCheckedChange={(c) => setCatalogSuggestionsEnabled(c === true)}
                disabled={pending}
              />
              <div className="space-y-0.5">
                <Label htmlFor="catalogSuggestionsEnabled" className="cursor-pointer font-medium">
                  Suggestions de produits du catalogue
                </Label>
                <p className="text-xs text-muted-foreground">
                  Permet à l&apos;assistant IA de proposer des variantes et articles en stock à
                  partir du catalogue de la boutique.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Checkbox
                id="crossSellEnabled"
                checked={crossSellEnabled}
                onCheckedChange={(c) => setCrossSellEnabled(c === true)}
                disabled={pending}
              />
              <div className="space-y-0.5">
                <Label htmlFor="crossSellEnabled" className="cursor-pointer font-medium">
                  Ventes complémentaires (cross-sell)
                </Label>
                <p className="text-xs text-muted-foreground">
                  Permet de proposer des articles complémentaires après la confirmation d&apos;une
                  commande.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Checkbox
                id="orderEditProposalsEnabled"
                checked={orderEditProposalsEnabled}
                onCheckedChange={(c) => setOrderEditProposalsEnabled(c === true)}
                disabled={pending}
              />
              <div className="space-y-0.5">
                <Label
                  htmlFor="orderEditProposalsEnabled"
                  className="cursor-pointer font-medium"
                >
                  Propositions de modifications de commande
                </Label>
                <p className="text-xs text-muted-foreground">
                  Permet à l&apos;assistant IA de rédiger des propositions de modification (adresse,
                  quantité) soumises à la validation d&apos;un agent.
                </p>
              </div>
            </div>
          </div>
        </section>

        <hr className="border-border" />

        {/* 9. Médias */}
        <section className="flex flex-col gap-4">
          <div>
            <h3 className="text-base font-semibold">Médias</h3>
            <p className="text-sm text-muted-foreground">
              Gestion du stockage des notes vocales et des photos envoyées par les clients.
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:max-w-md">
            <Label htmlFor="mediaRetentionDays">Rétention des fichiers médias (jours)</Label>
            <Input
              id="mediaRetentionDays"
              type="number"
              inputMode="numeric"
              min={7}
              max={365}
              value={mediaRetentionDays}
              onChange={(e) => {
                setMediaRetentionDays(e.target.value);
                clearField("mediaRetentionDays");
              }}
              disabled={pending}
              aria-invalid={"mediaRetentionDays" in fieldErrors || undefined}
              aria-describedby={fieldErrors.mediaRetentionDays ? "error-mediaRetentionDays" : "mediaRetentionDays-help"}
              className="min-h-11"
              required
            />
            <FieldError id="error-mediaRetentionDays" message={fieldErrors.mediaRetentionDays} />
            <p id="mediaRetentionDays-help" className="text-xs text-muted-foreground">
              Durée de conservation des audios et images (7 à 365 jours, par défaut 90). Les
              transcriptions textuelles sont toujours conservées.
            </p>
          </div>
        </section>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          <Button type="submit" disabled={pending} className="min-h-11">
            {pending ? "Enregistrement…" : "Enregistrer les paramètres WhatsApp"}
          </Button>
        </div>
      </form>

      {/* Confirmation Dialog when enabling master switch */}
      <Dialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Préchauffage du numéro</DialogTitle>
            <DialogDescription>
              Le numéro est-il chauffé (≈2 semaines d&apos;usage normal) ?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2 text-sm text-muted-foreground">
            <p>
              WhatsApp risque de bannir immédiatement un numéro récemment activé ou non rodé qui
              envoie des messages automatisés.
            </p>
            <p>
              Assurez-vous d&apos;avoir utilisé cette carte SIM manuellement avec des contacts réels
              pendant au moins 2 semaines avant d&apos;activer l&apos;automatisation.
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmDialogOpen(false)}
            >
              Annuler
            </Button>
            <Button
              type="button"
              onClick={() => {
                setEnabled(true);
                setConfirmDialogOpen(false);
              }}
            >
              Confirmer l&apos;activation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
