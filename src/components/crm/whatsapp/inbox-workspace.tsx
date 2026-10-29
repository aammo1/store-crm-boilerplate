"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { WaConversation, WaMessageView } from "@/lib/services/whatsapp-conversations";
import { ChatView, type PendingMessage } from "./chat-view";
import { ConversationList } from "./conversation-list";
import { UncertainSendsDialog } from "./uncertain-sends";

export type WhatsAppRole = "admin" | "agent";

type ListView = "todo" | "mine" | "all";

interface WhatsAppSummary {
  todo: number;
  uncertain: number;
  pendingProposals: number;
  openRequests: number;
  connection: { state: "open" | "connecting" | "close" | "unknown"; updatedAt: string | null };
}

interface ConversationDetail {
  conversation: WaConversation;
  messages: WaMessageView[];
}

const VIEW_TABS: Array<{ value: ListView; label: string }> = [
  { value: "todo", label: "À traiter" },
  { value: "mine", label: "Mes conversations" },
  { value: "all", label: "Toutes" },
];

const LIST_PAGE_SIZE = 30;

type ListMode = "replace" | "append";

function errorOf(data: unknown): string | null {
  if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
    return (data as { error: string }).error;
  }
  return null;
}

async function request(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; data: unknown }> {
  try {
    const response = await fetch(url, { cache: "no-store", ...init });
    const data = (await response.json().catch(() => null)) as unknown;
    return { ok: response.ok, data };
  } catch {
    return { ok: false, data: null };
  }
}

export interface InboxWorkspaceProps {
  role: WhatsAppRole;
  userId: string;
}

export function InboxWorkspace({ role, userId }: InboxWorkspaceProps) {
  const isAdmin = role === "admin";

  const [view, setView] = useState<ListView>("todo");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<WaConversation[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [actionBusy, setActionBusy] = useState(false);

  const [summary, setSummary] = useState<WhatsAppSummary | null>(null);
  const [uncertainOpen, setUncertainOpen] = useState(false);

  const searchParams = useSearchParams();

  // Latest-value refs so the visibility-gated polling intervals always run the
  // current filters/selection without being recreated.
  const viewRef = useRef<ListView>("todo");
  const searchRef = useRef("");
  const selectedIdRef = useRef<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const listInFlightRef = useRef(false);
  const listRequestSeqRef = useRef(0);
  const loadListRef = useRef<(mode: ListMode) => Promise<void>>(async () => {});
  const selectRef = useRef<(id: string | null) => void>(() => {});
  const pendingKeyRef = useRef(0);

  viewRef.current = view;
  searchRef.current = search;
  selectedIdRef.current = selectedId;

  // ---------------------------------------------------------------- list ----

  const loadList = useCallback(async (mode: ListMode) => {
    if (mode === "append" && (listInFlightRef.current || !cursorRef.current)) return;
    const seq = ++listRequestSeqRef.current;
    listInFlightRef.current = true;
    if (mode === "replace") setListLoading(true);
    try {
      const params = new URLSearchParams({ view: viewRef.current, limit: String(LIST_PAGE_SIZE) });
      const query = searchRef.current;
      if (query) params.set("q", query);
      if (mode === "append" && cursorRef.current) params.set("cursor", cursorRef.current);
      const response = await fetch(`/api/crm/whatsapp/conversations?${params.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as { items: WaConversation[]; nextCursor: string | null };
      // Une requête plus récente (changement de filtre) a supplanté celle-ci.
      if (seq !== listRequestSeqRef.current) return;
      setItems((previous) => (mode === "append" ? [...previous, ...data.items] : data.items));
      cursorRef.current = data.nextCursor;
      setHasMore(Boolean(data.nextCursor));
      setListError(false);
    } catch {
      if (seq === listRequestSeqRef.current) setListError(true);
    } finally {
      if (seq === listRequestSeqRef.current) {
        listInFlightRef.current = false;
        setListLoading(false);
      }
    }
  }, []);

  loadListRef.current = loadList;

  // Reload when the filters change (debounced search included); also the first load.
  useEffect(() => {
    cursorRef.current = null;
    void loadList("replace");
  }, [loadList, view, search]);

  // Debounced search: 300 ms.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // List polling: every 20 s while the tab is visible.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadListRef.current("replace");
    }, 20_000);
    return () => clearInterval(timer);
  }, []);

  // -------------------------------------------------------------- summary ----

  const loadSummary = useCallback(async () => {
    try {
      const response = await fetch("/api/crm/whatsapp/summary", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as WhatsAppSummary;
      if (data && typeof data.todo === "number" && data.connection) setSummary(data);
    } catch {
      // réseau indisponible : le prochain cycle réessaie
    }
  }, []);

  useEffect(() => {
    void loadSummary();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadSummary();
    }, 60_000);
    return () => clearInterval(timer);
  }, [loadSummary]);

  // ------------------------------------------------------------- detail ----

  const markRead = useCallback((id: string) => {
    setItems((previous) =>
      previous.map((conversation) =>
        conversation.id === id ? { ...conversation, unreadCount: 0 } : conversation,
      ),
    );
    void fetch(`/api/crm/whatsapp/conversations/${encodeURIComponent(id)}/read`, {
      method: "POST",
    }).catch(() => undefined);
  }, []);

  const loadDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      try {
        const response = await fetch(`/api/crm/whatsapp/conversations/${encodeURIComponent(id)}`, {
          cache: "no-store",
        });
        if (response.status === 404) {
          // Accès retiré ou conversation supprimée : retour à la liste.
          selectRef.current(null);
          window.history.replaceState(null, "", "/crm/whatsapp");
          toast.error("Conversation introuvable.");
          return;
        }
        if (!response.ok) return;
        const data = (await response.json()) as ConversationDetail;
        if (selectedIdRef.current !== id) return;
        setDetail(data);
        // Retire les bulles optimistes dont l'envoi a été confirmé par le serveur.
        setPending((previous) =>
          previous.filter(
            (entry) =>
              !data.messages.some(
                (message) =>
                  message.direction === "out" &&
                  message.body === entry.text &&
                  Date.parse(message.createdAt) >= Date.parse(entry.sentAt) - 2000,
              ),
          ),
        );
        setItems((previous) =>
          previous.map((conversation) =>
            conversation.id === id ? { ...conversation, ...data.conversation } : conversation,
          ),
        );
        if (data.conversation.unreadCount > 0) markRead(id);
      } catch {
        // réseau indisponible : le prochain cycle réessaie
      } finally {
        setDetailLoading(false);
      }
    },
    [markRead],
  );

  // ------------------------------------------------------------ selection ----

  const select = useCallback(
    (id: string | null) => {
      if (selectedIdRef.current === id) return;
      selectedIdRef.current = id;
      setSelectedId(id);
      setDetail(null);
      setPending([]);
      if (id) {
        markRead(id);
        void loadDetail(id);
      }
    },
    [loadDetail, markRead],
  );

  selectRef.current = select;

  const openConversation = useCallback(
    (id: string) => {
      if (selectedIdRef.current === id) return;
      window.history.pushState(null, "", `/crm/whatsapp?c=${encodeURIComponent(id)}`);
      select(id);
    },
    [select],
  );

  const closeConversation = useCallback(() => {
    if (!selectedIdRef.current) return;
    window.history.replaceState(null, "", "/crm/whatsapp");
    select(null);
  }, [select]);

  // Deep links, browser back and forward navigation.
  useEffect(() => {
    const id = searchParams.get("c");
    if ((id ?? null) === (selectedIdRef.current ?? null)) return;
    select(id);
  }, [searchParams, select]);

  // Open conversation polling: every 10 s while the tab is visible.
  useEffect(() => {
    if (!selectedId) return;
    const id = selectedId;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadDetail(id);
    }, 10_000);
    return () => clearInterval(timer);
  }, [selectedId, loadDetail]);

  // -------------------------------------------------------------- actions ----

  const refreshAfterAction = useCallback(
    async (id: string) => {
      await Promise.all([loadDetail(id), loadSummary(), loadListRef.current("replace")]);
    },
    [loadDetail, loadSummary],
  );

  const takeOver = useCallback(async (): Promise<boolean> => {
    const id = selectedIdRef.current;
    if (!id) return false;
    setActionBusy(true);
    const { ok, data } = await request(
      `/api/crm/whatsapp/conversations/${encodeURIComponent(id)}/takeover`,
      { method: "POST" },
    );
    setActionBusy(false);
    if (!ok) {
      toast.error(errorOf(data) ?? "Action impossible.");
      return false;
    }
    toast.success("Conversation prise en main.");
    await refreshAfterAction(id);
    return true;
  }, [refreshAfterAction]);

  const release = useCallback(async (): Promise<boolean> => {
    const id = selectedIdRef.current;
    if (!id) return false;
    setActionBusy(true);
    const { ok, data } = await request(
      `/api/crm/whatsapp/conversations/${encodeURIComponent(id)}/takeover`,
      { method: "DELETE" },
    );
    setActionBusy(false);
    if (!ok) {
      toast.error(errorOf(data) ?? "Action impossible.");
      return false;
    }
    toast.success("Conversation rendue à l’IA.");
    await refreshAfterAction(id);
    return true;
  }, [refreshAfterAction]);

  const block = useCallback(
    async (reason: string): Promise<boolean> => {
      const id = selectedIdRef.current;
      if (!id) return false;
      setActionBusy(true);
      const { ok, data } = await request(
        `/api/crm/whatsapp/conversations/${encodeURIComponent(id)}/block`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      );
      setActionBusy(false);
      if (!ok) {
        toast.error(errorOf(data) ?? "Blocage impossible.");
        return false;
      }
      toast.success("Numéro bloqué.");
      await refreshAfterAction(id);
      return true;
    },
    [refreshAfterAction],
  );

  const unblock = useCallback(async (): Promise<boolean> => {
    const id = selectedIdRef.current;
    if (!id) return false;
    if (!window.confirm("Débloquer ce numéro ? Les signalements seront effacés.")) return false;
    setActionBusy(true);
    const { ok, data } = await request(
      `/api/crm/whatsapp/conversations/${encodeURIComponent(id)}/block`,
      { method: "DELETE" },
    );
    setActionBusy(false);
    if (!ok) {
      toast.error(errorOf(data) ?? "Déblocage impossible.");
      return false;
    }
    toast.success("Numéro débloqué.");
    await refreshAfterAction(id);
    return true;
  }, [refreshAfterAction]);

  const linkOrder = useCallback(
    async (orderRef: string): Promise<boolean> => {
      const id = selectedIdRef.current;
      if (!id) return false;
      setActionBusy(true);
      const { ok, data } = await request(
        `/api/crm/whatsapp/conversations/${encodeURIComponent(id)}/link-order`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderRef }),
        },
      );
      setActionBusy(false);
      if (!ok) {
        toast.error(errorOf(data) ?? "Liaison impossible.");
        return false;
      }
      const conversation = (data as { conversation?: WaConversation } | null)?.conversation;
      if (conversation) {
        setDetail((previous) =>
          previous && previous.conversation.id === id ? { ...previous, conversation } : previous,
        );
        setItems((previous) =>
          previous.map((item) => (item.id === id ? { ...item, ...conversation } : item)),
        );
      }
      toast.success(`Commande #${orderRef} liée à la conversation.`);
      void loadListRef.current("replace");
      return true;
    },
    [],
  );

  const sendReply = useCallback(
    async (text: string): Promise<boolean> => {
      const id = selectedIdRef.current;
      if (!id) return false;
      const sentAt = new Date().toISOString();
      const { ok, data } = await request(
        `/api/crm/whatsapp/conversations/${encodeURIComponent(id)}/reply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        },
      );
      if (!ok) {
        toast.error(errorOf(data) ?? "Envoi impossible.");
        return false;
      }
      // Réponse acceptée (202) : bulle optimiste "en file d'envoi" jusqu'à ce que
      // le worker confirme l'envoi dans la liste des messages.
      pendingKeyRef.current += 1;
      setPending((previous) => [
        ...previous,
        { key: `pending-${pendingKeyRef.current}-${sentAt}`, text, sentAt },
      ]);
      // La réponse d'un agent prend la main côté serveur : on reflète l'état.
      setDetail((previous) =>
        previous && previous.conversation.id === id
          ? {
              ...previous,
              conversation: {
                ...previous.conversation,
                mode: "human",
                takenOverBy: userId,
                needsHuman: false,
                handoffReason: null,
                unreadCount: 0,
              },
            }
          : previous,
      );
      setItems((previous) =>
        previous.map((conversation) =>
          conversation.id === id
            ? {
                ...conversation,
                mode: "human",
                takenOverBy: userId,
                needsHuman: false,
                handoffReason: null,
                unreadCount: 0,
              }
            : conversation,
        ),
      );
      void loadListRef.current("replace");
      return true;
    },
    [userId],
  );

  // ----------------------------------------------------------------- UI ----

  const todoCount = summary ? summary.todo : null;
  const uncertainCount = isAdmin && summary ? summary.uncertain : null;
  const connectionState = summary?.connection.state ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="font-semibold text-2xl text-foreground">WhatsApp</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Conversations clients : répondez, prenez la main sur l’IA et liez les commandes.
          </p>
        </div>
        {isAdmin && (
          <Button type="button" variant="outline" onClick={() => setUncertainOpen(true)}>
            <TriangleAlertIcon className="size-4" aria-hidden="true" />
            Envois incertains{uncertainCount !== null && uncertainCount > 0 ? ` (${uncertainCount})` : ""}
          </Button>
        )}
      </div>

      {connectionState !== null && connectionState !== "open" && connectionState !== "unknown" && (
        <div
          role="alert"
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
            connectionState === "close"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-border bg-muted text-muted-foreground",
          )}
        >
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            {connectionState === "close"
              ? "WhatsApp déconnecté — reconnectez le numéro (QR) dans Evolution."
              : "WhatsApp en cours de connexion…"}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div role="group" aria-label="Filtres de conversations" className="flex flex-wrap gap-1.5">
          {VIEW_TABS.map((tab) => {
            const active = view === tab.value;
            return (
              <button
                key={tab.value}
                type="button"
                aria-pressed={active}
                onClick={() => setView(tab.value)}
                className={cn(
                  "min-h-8 rounded-full border border-border px-3 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {tab.label}
                {tab.value === "todo" && todoCount !== null ? ` (${todoCount})` : ""}
              </button>
            );
          })}
        </div>
        <Input
          type="search"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Rechercher un nom ou un téléphone…"
          aria-label="Rechercher une conversation"
          className="h-9 md:max-w-xs"
        />
      </div>

      <div className="flex flex-col md:h-[calc(100dvh-15rem)] md:min-h-[480px] md:flex-row">
        {/* Conversation list — full width on mobile, fixed column on desktop. */}
        <div className="min-h-0 border-border md:h-full md:w-[340px] md:shrink-0 md:overflow-hidden md:border-r">
          <ConversationList
            conversations={items}
            selectedId={selectedId}
            view={view}
            loading={listLoading}
            hasError={listError}
            hasMore={hasMore}
            onSelect={openConversation}
            onRetry={() => void loadList("replace")}
            onLoadMore={() => void loadList("append")}
          />
        </div>

        {/* Chat — full-screen overlay on mobile once a conversation is selected. */}
        <div
          className={cn(
            "bg-background",
            selectedId
              ? "fixed inset-0 z-50 flex flex-col md:static md:z-auto md:min-w-0 md:flex-1"
              : "hidden md:flex md:min-w-0 md:flex-1 md:flex-col",
          )}
        >
          <ChatView
            key={selectedId ?? "none"}
            conversation={detail?.conversation ?? null}
            messages={detail?.messages ?? []}
            pending={pending}
            loading={detailLoading}
            role={role}
            userId={userId}
            busy={actionBusy}
            onBack={closeConversation}
            onSend={sendReply}
            onTakeover={takeOver}
            onRelease={release}
            onBlock={block}
            onUnblock={unblock}
            onLinkOrder={linkOrder}
          />
        </div>
      </div>

      {isAdmin && (
        <UncertainSendsDialog
          open={uncertainOpen}
          onOpenChange={setUncertainOpen}
          onResolved={() => void loadSummary()}
        />
      )}
    </div>
  );
}
