"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  ImageIcon,
  MessageCircleIcon,
  MicIcon,
  SparklesIcon,
  XCircleIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatCasablancaDateTime } from "@/components/crm/whatsapp/format";
import type { OrderDraft, WaProposal } from "@/lib/services/whatsapp-staging";
import type { WaConversation, WaMessageView } from "@/lib/services/whatsapp-conversations";

interface OutboxItem {
  id: string;
  purpose: string;
  status: string;
  sentAt: string | null;
  createdAt: string;
}

interface OrderWhatsappData {
  conversation: WaConversation | null;
  messages: WaMessageView[];
  draft: OrderDraft | null;
  proposals: WaProposal[];
  outbox: OutboxItem[];
}

const PURPOSE_LABELS: Record<string, string> = {
  notify_confirmed: "Confirmation",
  notify_shipped: "Expédition",
  notify_delivered: "Livraison",
  notify_out_for_delivery: "En cours de livraison",
  notify_delivery_issue: "Problème livraison",
  notify_cancelled: "Annulation",
  relance_no_answer: "Relance",
  admin_alert: "Alerte admin",
};

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  queued: { label: "En attente", className: "border-border text-muted-foreground" },
  sending: { label: "En cours d'envoi", className: "border-[var(--crm-info)]/40 text-[var(--crm-info)]" },
  sent: { label: "Envoyé", className: "border-[var(--crm-success)]/40 text-[var(--crm-success)] bg-[var(--crm-success-bg)]" },
  uncertain: { label: "Incertain", className: "border-[var(--crm-warning)]/40 text-[var(--crm-warning)] bg-[var(--crm-warning-bg)]" },
  failed: { label: "Échec", className: "border-destructive/40 text-destructive bg-destructive/10" },
  cancelled: { label: "Annulé", className: "border-border text-muted-foreground line-through" },
};

const PROPOSAL_STATUS_LABELS: Record<string, { label: string; className: string }> = {
  pending: { label: "En attente", className: "border-[var(--crm-warning)]/40 text-[var(--crm-warning)] bg-[var(--crm-warning-bg)]" },
  approved: { label: "Approuvée", className: "border-[var(--crm-success)]/40 text-[var(--crm-success)] bg-[var(--crm-success-bg)]" },
  rejected: { label: "Rejetée", className: "border-border text-muted-foreground" },
  superseded: { label: "Remplacée", className: "border-border text-muted-foreground" },
  failed: { label: "Échec", className: "border-destructive/40 text-destructive bg-destructive/10" },
};

export function OrderWhatsappPanel({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [data, setData] = useState<OrderWhatsappData | null>(null);
  const [loading, setLoading] = useState(true);

  // Proposal modal states
  const [approvingProposal, setApprovingProposal] = useState<WaProposal | null>(null);
  const [rejectingProposal, setRejectingProposal] = useState<WaProposal | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [submittingAction, setSubmittingAction] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch(`/api/crm/orders/${encodeURIComponent(orderId)}/whatsapp`);
      if (!res.ok) return;
      const json = (await res.json()) as OrderWhatsappData;
      setData(json);
    } catch {
      // ignore polling network errors
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30_000);
    return () => clearInterval(interval);
  }, [loadData]);

  function handleUseDraft(draft: OrderDraft) {
    window.dispatchEvent(new CustomEvent("apply-wa-draft", { detail: draft }));
    const confirmEl = document.getElementById("confirm-address");
    if (confirmEl) {
      confirmEl.scrollIntoView({ behavior: "smooth", block: "center" });
      confirmEl.focus();
    }
    toast.success("Brouillon WhatsApp appliqué au formulaire de confirmation.");
  }

  async function confirmApproveProposal() {
    if (!approvingProposal || submittingAction) return;
    setSubmittingAction(true);
    try {
      const res = await fetch(`/api/crm/whatsapp/proposals/${encodeURIComponent(approvingProposal.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      const resData = (await res.json().catch(() => null)) as { proposal?: WaProposal; error?: string } | null;
      if (!res.ok || resData?.error) {
        toast.error(resData?.error ?? "Échec lors de l'approbation de la proposition.");
        return;
      }
      toast.success("Proposition WhatsApp approuvée.");
      setApprovingProposal(null);
      startTransition(() => {
        router.refresh();
      });
      await loadData();
    } catch {
      toast.error("Erreur de connexion au serveur.");
    } finally {
      setSubmittingAction(false);
    }
  }

  async function confirmRejectProposal() {
    if (!rejectingProposal || submittingAction) return;
    setSubmittingAction(true);
    try {
      const res = await fetch(`/api/crm/whatsapp/proposals/${encodeURIComponent(rejectingProposal.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", note: rejectNote.trim() || undefined }),
      });
      const resData = (await res.json().catch(() => null)) as { proposal?: WaProposal; error?: string } | null;
      if (!res.ok || resData?.error) {
        toast.error(resData?.error ?? "Échec lors du rejet de la proposition.");
        return;
      }
      toast.success("Proposition WhatsApp rejetée.");
      setRejectingProposal(null);
      setRejectNote("");
      startTransition(() => {
        router.refresh();
      });
      await loadData();
    } catch {
      toast.error("Erreur de connexion au serveur.");
    } finally {
      setSubmittingAction(false);
    }
  }

  if (loading && !data) {
    return (
      <section className="rounded-xl border border-border bg-card p-5 text-card-foreground">
        <div className="flex items-center gap-2">
          <MessageCircleIcon className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">WhatsApp</h2>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Chargement des données WhatsApp…</p>
      </section>
    );
  }

  const conversation = data?.conversation ?? null;
  const messages = data?.messages ?? [];
  const draft = data?.draft ?? null;
  const proposals = data?.proposals ?? [];
  const outbox = data?.outbox ?? [];

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-5 text-card-foreground">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-3">
        <div className="flex items-center gap-2">
          <MessageCircleIcon className="size-4 text-[var(--crm-success)]" aria-hidden />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">WhatsApp</h2>
        </div>

        {conversation ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                conversation.mode === "human"
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground"
              }`}
            >
              {conversation.mode === "human" ? "Humain" : "IA"}
            </span>

            {conversation.needsHuman ? (
              <span className="rounded-full border border-[var(--crm-warning)]/40 bg-[var(--crm-warning-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--crm-warning)]">
                À traiter
              </span>
            ) : null}

            {conversation.blocked ? (
              <span className="rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
                Bloqué
              </span>
            ) : null}

            {typeof conversation.strikePoints === "number" && conversation.strikePoints > 0 ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                {conversation.strikePoints} pt{conversation.strikePoints > 1 ? "s" : ""}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* No conversation empty state */}
      {!conversation ? (
        <div className="rounded-lg border border-dashed border-border/70 p-4 text-center">
          <p className="text-sm font-medium text-foreground">Aucune conversation WhatsApp</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Le client peut initier l&apos;échange sur WhatsApp en mentionnant la référence de cette commande.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Derniers messages</span>
            <Link
              href={`/crm/whatsapp?c=${encodeURIComponent(conversation.id)}`}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              <span>Ouvrir dans la boîte WhatsApp</span>
              <ExternalLinkIcon className="size-3" aria-hidden />
            </Link>
          </div>

          {messages.length === 0 ? (
            <p className="text-xs text-muted-foreground">Aucun message échangé pour l&apos;instant.</p>
          ) : (
            <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-border bg-muted/20 p-2 text-xs">
              {messages.slice(0, 20).map((msg) => {
                const isOut = msg.direction === "out";
                const authorLabel =
                  msg.author === "customer"
                    ? "Client"
                    : msg.author === "ai"
                      ? "IA"
                      : msg.author === "agent"
                        ? "Agent"
                        : "Système";

                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col gap-0.5 rounded-md p-2 ${
                      isOut ? "ml-4 bg-primary/10 border border-primary/20 text-foreground" : "mr-4 bg-muted text-foreground"
                    }`}
                  >
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span className="font-semibold">{authorLabel}</span>
                      <span>{formatCasablancaDateTime(msg.createdAt)}</span>
                    </div>

                    <div className="mt-0.5">
                      {msg.kind === "audio" ? (
                        <div className="flex items-center gap-1 text-foreground">
                          <MicIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="italic">{msg.transcript || "Message vocal"}</span>
                        </div>
                      ) : msg.kind === "image" ? (
                        <div className="flex items-center gap-1 text-foreground">
                          <ImageIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                          <span>{msg.body || "Image"}</span>
                        </div>
                      ) : (
                        <p className="whitespace-pre-line text-foreground">{msg.body}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* AI Draft Card */}
      {draft ? (
        <div className="space-y-2 rounded-lg border border-[var(--crm-info)]/30 bg-[var(--crm-info-bg)]/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <SparklesIcon className="size-3.5 text-primary" aria-hidden />
              <span className="text-xs font-semibold text-foreground">Brouillon IA</span>
            </div>

            {draft.readyToConfirm ? (
              <span className="rounded-full border border-[var(--crm-success)]/40 bg-[var(--crm-success-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--crm-success)]">
                Prêt à confirmer
              </span>
            ) : null}
          </div>

          <dl className="grid gap-x-4 gap-y-1 text-xs">
            <div>
              <dt className="inline text-muted-foreground">Adresse : </dt>
              <dd className="inline font-medium text-foreground">{draft.address || "Non renseignée"}</dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Ville : </dt>
              <dd className="inline font-medium text-foreground">
                {draft.cityName || "Non renseignée"}
                {draft.cityName && draft.cityId === null ? (
                  <span className="ml-1 text-[var(--crm-warning)] font-normal">
                    (⚠ ville non reconnue)
                  </span>
                ) : null}
              </dd>
            </div>
            {draft.note ? (
              <div>
                <dt className="inline text-muted-foreground">Note : </dt>
                <dd className="inline text-foreground">{draft.note}</dd>
              </div>
            ) : null}
          </dl>

          <div className="pt-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => handleUseDraft(draft)}
              className="h-7 w-full text-xs font-medium"
            >
              Utiliser le brouillon WhatsApp
            </Button>
          </div>
        </div>
      ) : null}

      {/* Proposals */}
      {proposals.length > 0 ? (
        <div className="space-y-2 border-t border-border/50 pt-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Propositions WhatsApp ({proposals.length})
          </h3>

          <ul className="space-y-2">
            {proposals.map((prop) => {
              const statusCfg = PROPOSAL_STATUS_LABELS[prop.status] ?? {
                label: prop.status,
                className: "border-border text-muted-foreground",
              };
              const isPending = prop.status === "pending";

              return (
                <li key={prop.id} className="rounded-lg border border-border bg-card p-3 text-xs space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <span className="font-semibold text-foreground">
                      {prop.kind === "edit" ? "Modification de commande" : "Demande d'annulation"}
                    </span>
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusCfg.className}`}>
                      {statusCfg.label}
                    </span>
                  </div>

                  <p className="text-foreground">{prop.summary}</p>

                  {prop.resultNote ? (
                    <p className="rounded bg-muted/60 p-1.5 text-[11px] text-muted-foreground">
                      Note : {prop.resultNote}
                    </p>
                  ) : null}

                  <div className="text-[10px] text-muted-foreground">
                    Créée le {formatCasablancaDateTime(prop.createdAt)}
                    {prop.decidedAt ? ` · Traitée le ${formatCasablancaDateTime(prop.decidedAt)}` : ""}
                  </div>

                  {isPending ? (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => setApprovingProposal(prop)}
                        className="h-7 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                      >
                        <CheckCircle2Icon className="mr-1 size-3" aria-hidden />
                        Approuver
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setRejectingProposal(prop);
                          setRejectNote("");
                        }}
                        className="h-7 text-xs text-destructive hover:bg-destructive/10"
                      >
                        <XCircleIcon className="mr-1 size-3" aria-hidden />
                        Rejeter
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Outbox Notifications */}
      {outbox.length > 0 ? (
        <div className="space-y-2 border-t border-border/50 pt-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Notifications envoyées ({outbox.length})
          </h3>

          <ul className="space-y-1.5 text-xs">
            {outbox.map((row) => {
              const purpose = PURPOSE_LABELS[row.purpose] ?? row.purpose;
              const statusCfg = STATUS_LABELS[row.status] ?? {
                label: row.status,
                className: "border-border text-muted-foreground",
              };
              const time = formatCasablancaDateTime(row.sentAt ?? row.createdAt);

              return (
                <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 bg-muted/20 px-2.5 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-foreground">{purpose}</span>
                    <span className={`rounded-full border px-1.5 py-0.2 text-[10px] font-medium ${statusCfg.className}`}>
                      {statusCfg.label}
                    </span>
                  </div>
                  <span className="text-[11px] text-muted-foreground">{time}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Approve Dialog */}
      <Dialog open={approvingProposal !== null} onOpenChange={(open) => !open && setApprovingProposal(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Approuver la proposition</DialogTitle>
            <DialogDescription>
              {approvingProposal?.kind === "edit"
                ? "La commande sera modifiée et recalculée par le serveur."
                : "La commande sera annulée."}
            </DialogDescription>
          </DialogHeader>

          {approvingProposal ? (
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <p className="font-medium text-foreground">{approvingProposal.summary}</p>
            </div>
          ) : null}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              disabled={submittingAction}
              onClick={() => setApprovingProposal(null)}
            >
              Annuler
            </Button>
            <Button
              type="button"
              disabled={submittingAction}
              onClick={confirmApproveProposal}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {submittingAction ? "Approbation…" : "Confirmer l'approbation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={rejectingProposal !== null} onOpenChange={(open) => !open && setRejectingProposal(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rejeter la proposition</DialogTitle>
            <DialogDescription>
              Indiquez éventuellement la raison du rejet. Cette note sera conservée dans l&apos;historique.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {rejectingProposal ? (
              <p className="text-xs text-muted-foreground">{rejectingProposal.summary}</p>
            ) : null}
            <Textarea
              rows={3}
              maxLength={500}
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder="Motif du rejet (facultatif)…"
              className="w-full text-sm border-input bg-card text-foreground"
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              disabled={submittingAction}
              onClick={() => setRejectingProposal(null)}
            >
              Annuler
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={submittingAction}
              onClick={confirmRejectProposal}
            >
              {submittingAction ? "Rejet…" : "Confirmer le rejet"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
