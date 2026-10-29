"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { ArrowLeftIcon, Link2Icon, SendIcon, ShieldBanIcon, ShieldCheckIcon, UserRoundIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import type { WaConversation, WaMessageView } from "@/lib/services/whatsapp-conversations";
import { formatCasablancaDateTime, maskPhoneDisplay } from "./format";

const MAX_REPLY_LENGTH = 2000;

/** Optimistic reply kept client-side until the worker confirms the send. */
export interface PendingMessage {
  key: string;
  text: string;
  sentAt: string;
}

export interface ChatViewProps {
  conversation: WaConversation | null;
  messages: WaMessageView[];
  pending: PendingMessage[];
  loading: boolean;
  role: "admin" | "agent";
  userId: string;
  busy: boolean;
  onBack: () => void;
  onSend: (text: string) => Promise<boolean>;
  onTakeover: () => Promise<boolean>;
  onRelease: () => Promise<boolean>;
  onBlock: (reason: string) => Promise<boolean>;
  onUnblock: () => Promise<boolean>;
  onLinkOrder: (orderRef: string) => Promise<boolean>;
}

const AUTHOR_LABELS: Record<WaMessageView["author"], string> = {
  customer: "Client",
  ai: "IA",
  agent: "Agent",
  system: "Système",
};

/**
 * Delivery state of outbound bubbles, mapped to the four spec'd icons
 * (queued ⏳, sent ✓, uncertain ⚠️, failed ✕). `sending` shows the queued
 * hourglass; `cancelled` shows the failure cross — neither state normally
 * reaches wa_messages, the mapping is defensive.
 */
const OUTBOUND_STATUS_META: Record<string, { icon: string; label: string }> = {
  queued: { icon: "⏳", label: "En file d’envoi" },
  sending: { icon: "⏳", label: "Envoi en cours" },
  sent: { icon: "✓", label: "Envoyé" },
  uncertain: { icon: "⚠️", label: "Envoi incertain — à vérifier" },
  failed: { icon: "✕", label: "Échec d’envoi" },
  cancelled: { icon: "✕", label: "Envoi annulé" },
};

function messageMediaUrl(message: WaMessageView): string | null {
  return message.mediaPath && !message.mediaDeletedAt
    ? `/api/crm/whatsapp/media/${encodeURIComponent(message.id)}`
    : null;
}

function MessageBubble({ message }: { message: WaMessageView }) {
  const outgoing = message.direction === "out";
  const mediaUrl = messageMediaUrl(message);
  const mediaExpired = Boolean(message.mediaPath && message.mediaDeletedAt);
  const isMedia = message.kind === "audio" || message.kind === "image";
  const authorLabel = AUTHOR_LABELS[message.author];
  // A persisted outbound message without a live outbox row was necessarily
  // sent before being recorded, so a missing status falls back to "sent".
  const statusMeta = outgoing
    ? (OUTBOUND_STATUS_META[message.status ?? "sent"] ?? OUTBOUND_STATUS_META.sent)
    : null;

  return (
    <li className={cn("flex flex-col", outgoing ? "items-end" : "items-start")}>
      {outgoing && (
        <span className="mb-0.5 text-[11px] font-medium text-muted-foreground">{authorLabel}</span>
      )}
      <div
        className={cn(
          "max-w-[85%] space-y-1.5 rounded-2xl px-3 py-2 text-sm md:max-w-[75%]",
          outgoing ? "rounded-br-sm" : "rounded-bl-sm",
          isMedia || (!message.body && mediaUrl === null)
            ? "border border-border bg-card"
            : outgoing && message.author === "agent"
              ? "bg-primary text-primary-foreground"
              : outgoing && message.author === "ai"
                ? "bg-secondary text-secondary-foreground"
                : outgoing
                  ? "border border-dashed border-border bg-muted/50 text-muted-foreground"
                  : "bg-muted text-foreground",
        )}
      >
        {mediaUrl && message.kind === "image" && (
          <a href={mediaUrl} target="_blank" rel="noopener noreferrer" className="block">
            {/* eslint-disable-next-line @next/next/no-img-element -- media served by the authenticated CRM route, not optimizable static assets */}
            <img
              src={mediaUrl}
              alt="Image envoyée par le client"
              loading="lazy"
              className="max-h-48 w-auto rounded-lg border border-border object-contain"
            />
          </a>
        )}
        {mediaUrl && message.kind === "audio" && (
          <audio controls preload="none" src={mediaUrl} className="w-full min-w-[220px] max-w-[280px]" />
        )}
        {mediaExpired && (
          <p className="text-xs italic text-muted-foreground">Média supprimé (rétention)</p>
        )}
        {message.body && <p className="whitespace-pre-wrap break-words">{message.body}</p>}
        {message.transcript && (
          <p className="text-xs italic text-muted-foreground">{message.transcript}</p>
        )}
        {!message.body && !message.transcript && !mediaUrl && !mediaExpired && message.kind === "other" && (
          <p className="text-xs italic text-muted-foreground">Autre message</p>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
        <time dateTime={message.createdAt}>{formatCasablancaDateTime(message.createdAt)}</time>
        {statusMeta && (
          <span title={statusMeta.label} aria-label={statusMeta.label}>
            {statusMeta.icon}
          </span>
        )}
      </div>
    </li>
  );
}

function PendingBubble({ pending }: { pending: PendingMessage }) {
  return (
    <li className="flex flex-col items-end opacity-75">
      <span className="mb-0.5 text-[11px] font-medium text-muted-foreground">Agent</span>
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary/80 px-3 py-2 text-sm text-primary-foreground md:max-w-[75%]">
        <p className="whitespace-pre-wrap break-words">{pending.text}</p>
      </div>
      <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
        <span title="En file d’envoi" aria-label="En file d’envoi">
          ⏳
        </span>
        <span>Envoi en cours…</span>
      </div>
    </li>
  );
}

export function ChatView({
  conversation,
  messages,
  pending,
  loading,
  role,
  userId,
  busy,
  onBack,
  onSend,
  onTakeover,
  onRelease,
  onBlock,
  onUnblock,
  onLinkOrder,
}: ChatViewProps) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkRef, setLinkRef] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockReason, setBlockReason] = useState("");
  const [blockError, setBlockError] = useState<string | null>(null);
  const [blockBusy, setBlockBusy] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  // Keep the newest message in view unless the user scrolled up to read history.
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  useEffect(() => {
    followRef.current = true;
    scrollToBottom();
  }, [conversation?.id]);

  useEffect(() => {
    if (followRef.current) scrollToBottom();
  }, [messages.length, pending.length, loading]);

  if (!conversation) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6 text-center">
        {loading ? (
          <p className="text-sm text-muted-foreground">Chargement de la conversation…</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Sélectionnez une conversation pour la lire et y répondre.
          </p>
        )}
      </div>
    );
  }

  const isAdmin = role === "admin";
  const phoneDisplay = isAdmin ? conversation.phone : maskPhoneDisplay(conversation.phone);
  const takenOver = Boolean(conversation.takenOverBy);
  const aiPaused = Boolean(
    conversation.aiPausedUntil && Date.parse(conversation.aiPausedUntil) > Date.now(),
  );
  const statusLine =
    conversation.needsHuman && conversation.handoffReason
      ? `À traiter : ${conversation.handoffReason}`
      : takenOver
        ? conversation.takenOverBy === userId
          ? "Vous avez pris la main sur cette conversation."
          : "Pris en charge par un autre agent."
        : null;

  async function handleSend() {
    const text = reply.trim();
    if (!text || sending || conversation?.blocked || conversation?.noWhatsapp) return;
    setSending(true);
    const ok = await onSend(text);
    if (ok) setReply("");
    setSending(false);
  }

  function handleReplyKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void handleSend();
    }
  }

  function submitLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ref = linkRef.trim().toUpperCase();
    if (!/^[A-Za-z0-9]{8}$/.test(ref)) {
      setLinkError("Référence invalide (8 caractères alphanumériques).");
      return;
    }
    setLinkBusy(true);
    void onLinkOrder(ref)
      .then((ok) => {
        if (ok) {
          setLinkOpen(false);
          setLinkRef("");
          setLinkError(null);
        }
      })
      .finally(() => setLinkBusy(false));
  }

  function submitBlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = blockReason.trim();
    if (reason.length < 3 || reason.length > 200) {
      setBlockError("Motif requis (3 à 200 caractères).");
      return;
    }
    setBlockBusy(true);
    void onBlock(reason)
      .then((ok) => {
        if (ok) {
          setBlockOpen(false);
          setBlockReason("");
          setBlockError(null);
        }
      })
      .finally(() => setBlockBusy(false));
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-start gap-1 border-b border-border bg-card px-2 py-2 md:px-4">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="min-h-[44px] min-w-[44px] md:hidden"
          onClick={onBack}
          aria-label="Retour aux conversations"
          title="Retour aux conversations"
        >
          <ArrowLeftIcon className="size-5" aria-hidden="true" />
        </Button>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {conversation.displayName ?? phoneDisplay}
          </p>
          {conversation.displayName && (
            <p className="truncate text-xs text-muted-foreground" dir="ltr">
              {phoneDisplay}
            </p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {conversation.orders.map((order) => (
              <Link
                key={order.orderId}
                href={`/crm/orders/${order.orderId}`}
                className="rounded-4xl border border-border px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted hover:text-muted-foreground"
              >
                #{order.ref}
              </Link>
            ))}
            {conversation.blocked && <Badge variant="destructive">⛔ Bloqué</Badge>}
            {conversation.noWhatsapp && <Badge variant="outline">Pas de WhatsApp</Badge>}
            {(conversation.strikePoints ?? 0) > 0 && (
              <Badge variant="outline">⚠️ {conversation.strikePoints} pts</Badge>
            )}
            {aiPaused && <Badge variant="secondary">IA en pause</Badge>}
          </div>
          {statusLine && <p className="mt-1 text-xs text-muted-foreground">{statusLine}</p>}
        </div>

        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {takenOver ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void onRelease()}
            >
              Rendre à l’IA
            </Button>
          ) : (
            <Button type="button" size="sm" disabled={busy} onClick={() => void onTakeover()}>
              <UserRoundIcon className="size-3.5" aria-hidden="true" />
              Prendre la main
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setLinkRef("");
              setLinkError(null);
              setLinkOpen(true);
            }}
          >
            <Link2Icon className="size-3.5" aria-hidden="true" />
            Lier une commande
          </Button>
          {isAdmin &&
            (conversation.blocked ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void onUnblock()}
              >
                <ShieldCheckIcon className="size-3.5" aria-hidden="true" />
                Débloquer
              </Button>
            ) : (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setBlockReason("");
                  setBlockError(null);
                  setBlockOpen(true);
                }}
              >
                <ShieldBanIcon className="size-3.5" aria-hidden="true" />
                Bloquer
              </Button>
            ))}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-4"
      >
        <ul aria-live="polite" className="mx-auto flex max-w-2xl flex-col gap-2">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {pending.map((entry) => (
            <PendingBubble key={entry.key} pending={entry} />
          ))}
          {messages.length === 0 && pending.length === 0 && (
            <li className="text-center text-sm text-muted-foreground">
              {loading
                ? "Chargement des messages…"
                : "Aucun message. La conversation démarre quand le client écrit."}
            </li>
          )}
        </ul>
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-border bg-card px-3 py-3 md:px-4">
        <div className="mx-auto max-w-2xl">
          {conversation.blocked ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {isAdmin
                ? "Numéro bloqué — débloquez-le pour répondre."
                : "Numéro bloqué — demandez à un administrateur de le débloquer."}
            </p>
          ) : conversation.noWhatsapp ? (
            <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
              Ce numéro n’a pas WhatsApp : joignez le client par téléphone.
            </p>
          ) : (
            <>
              <div className="flex items-end gap-2">
                <Textarea
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  onKeyDown={handleReplyKeyDown}
                  maxLength={MAX_REPLY_LENGTH}
                  rows={2}
                  placeholder="Votre réponse…"
                  aria-label="Votre réponse"
                  className="min-h-11 flex-1 resize-none"
                />
                <Button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={sending || reply.trim().length === 0}
                  aria-label="Envoyer la réponse"
                  className="min-h-[44px]"
                >
                  <SendIcon className="size-4" aria-hidden="true" />
                  Envoyer
                </Button>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>Votre réponse met l’IA en pause pour cette conversation.</span>
                <span className="shrink-0 tabular-nums">
                  {reply.length}/{MAX_REPLY_LENGTH}
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Link order dialog */}
      <Dialog
        open={linkOpen}
        onOpenChange={(open) => {
          if (!open) setLinkOpen(false);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Lier une commande</DialogTitle>
            <DialogDescription>
              Saisissez la référence à 8 caractères, par exemple #A1B2C3D4.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitLink} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="wa-link-order-ref">Référence commande</Label>
              <Input
                id="wa-link-order-ref"
                value={linkRef}
                onChange={(event) => setLinkRef(event.target.value.toUpperCase())}
                maxLength={8}
                placeholder="A1B2C3D4"
                className="font-mono uppercase"
                autoComplete="off"
                autoFocus
              />
              {linkError && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {linkError}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setLinkOpen(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={linkBusy}>
                Lier
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Block dialog (admin) */}
      <Dialog
        open={blockOpen}
        onOpenChange={(open) => {
          if (!open) setBlockOpen(false);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Bloquer ce numéro</DialogTitle>
            <DialogDescription>
              L’IA cessera de répondre et les envois vers ce numéro seront bloqués. Un administrateur
              pourra le débloquer à tout moment.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitBlock} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="wa-block-reason">Motif</Label>
              <Textarea
                id="wa-block-reason"
                value={blockReason}
                onChange={(event) => setBlockReason(event.target.value)}
                maxLength={200}
                rows={3}
                placeholder="Ex. Insultes répétées"
                autoFocus
              />
              {blockError && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {blockError}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setBlockOpen(false)}>
                Annuler
              </Button>
              <Button type="submit" variant="destructive" disabled={blockBusy}>
                Bloquer
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
