"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WaConversation } from "@/lib/services/whatsapp-conversations";
import { formatRelativeTime, maskPhoneDisplay } from "./format";

export interface ConversationListProps {
  conversations: WaConversation[];
  selectedId: string | null;
  view: "todo" | "mine" | "all";
  loading: boolean;
  hasError: boolean;
  hasMore: boolean;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onLoadMore: () => void;
}

function ConversationBadges({ conversation }: { conversation: WaConversation }) {
  return (
    <div className="flex flex-wrap gap-1">
      {conversation.mode === "ai" ? (
        <Badge variant="secondary">🤖 IA</Badge>
      ) : (
        <Badge>🙋 Humain</Badge>
      )}
      {conversation.needsHuman && <Badge variant="destructive">À traiter</Badge>}
      {(conversation.strikePoints ?? 0) > 0 && (
        <Badge variant="outline">⚠️ {conversation.strikePoints} pts</Badge>
      )}
      {conversation.blocked && <Badge variant="destructive">⛔ Bloqué</Badge>}
      {conversation.noWhatsapp && <Badge variant="outline">Pas de WhatsApp</Badge>}
      {conversation.orders.map((order) => (
        <Badge variant="outline" key={order.orderId}>
          #{order.ref}
        </Badge>
      ))}
    </div>
  );
}

function EmptyState({ view, hasError, onRetry }: Pick<ConversationListProps, "view" | "hasError" | "onRetry">) {
  if (hasError) {
    return (
      <div className="space-y-2 p-4 text-center">
        <p className="text-sm text-muted-foreground">Impossible de charger les conversations.</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Réessayer
        </Button>
      </div>
    );
  }
  const message =
    view === "todo"
      ? "Aucune conversation à traiter."
      : view === "mine"
        ? "Aucune conversation vous concernant."
        : "Aucune conversation.";
  return <p className="p-4 text-center text-sm text-muted-foreground">{message}</p>;
}

export function ConversationList({
  conversations,
  selectedId,
  view,
  loading,
  hasError,
  hasMore,
  onSelect,
  onRetry,
  onLoadMore,
}: ConversationListProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {conversations.length === 0 && !loading ? (
        <EmptyState view={view} hasError={hasError} onRetry={onRetry} />
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
          {conversations.map((conversation) => {
            const selected = conversation.id === selectedId;
            const unread = conversation.unreadCount > 0;
            return (
              <li key={conversation.id}>
                <button
                  type="button"
                  onClick={() => onSelect(conversation.id)}
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "flex w-full flex-col gap-1.5 px-3 py-3 text-left transition-colors outline-none",
                    "hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    selected && "bg-muted",
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={cn(
                        "min-w-0 truncate text-sm",
                        unread ? "font-semibold text-foreground" : "font-medium text-foreground/90",
                      )}
                    >
                      {conversation.displayName ?? maskPhoneDisplay(conversation.phone)}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {formatRelativeTime(conversation.updatedAt)}
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    {unread && (
                      <span
                        className="mt-1 size-2 shrink-0 rounded-full bg-primary"
                        aria-label="Messages non lus"
                      />
                    )}
                    <span className="line-clamp-2 min-w-0 flex-1 text-xs text-muted-foreground">
                      {conversation.lastPreview ?? "—"}
                    </span>
                  </div>
                  <ConversationBadges conversation={conversation} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && conversations.length > 0 && (
        <div className="border-t border-border p-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={loading}
            onClick={onLoadMore}
          >
            Charger plus
          </Button>
        </div>
      )}
      {loading && conversations.length === 0 && (
        <p className="p-4 text-center text-sm text-muted-foreground">Chargement…</p>
      )}
    </div>
  );
}
