import type { Metadata } from "next";
import Link from "next/link";
import { ClockIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";

import { OrdersTable } from "@/components/crm/orders-table";
import { OrderBulkActions } from "@/components/crm/order-bulk-actions";
import {
  CONFIRMATION_LABELS,
  SUBMISSION_STATUS_LABELS,
} from "@/components/crm/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireUser } from "@/lib/auth-guards";
import { cn } from "@/lib/utils";
import {
  countDueCallbacks,
  formatCasablanca,
  listOrders,
  type ConfirmationStatus,
  type SubmissionFilterStatus,
} from "@/lib/services/orders";

export const metadata: Metadata = {
  title: "Commandes — CRM",
  robots: { index: false },
};

const STATUS_TABS: Array<ConfirmationStatus | "all"> = [
  "new",
  "no_answer",
  "call_back_later",
  "confirmed",
  "cancelled",
  "all",
];

interface OrdersPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function ordersUrl(params: {
  status?: string;
  q?: string;
  callbackDue?: boolean;
  submission?: SubmissionFilterStatus[];
  tracking?: string[];
  page?: number;
  archived?: boolean;
  mine?: boolean;
  utmSource?: string;
  utmCampaign?: string;
}): string {
  const sp = new URLSearchParams();
  if (params.status) sp.set("status", params.status);
  if (params.archived) sp.set("archived", "1");
  if (params.mine) sp.set("mine", "1");
  if (params.q) sp.set("q", params.q);
  if (params.utmSource) sp.set("utm_source", params.utmSource);
  if (params.utmCampaign) sp.set("utm_campaign", params.utmCampaign);
  if (params.callbackDue) sp.set("callbackDue", "1");
  if (params.submission && params.submission.length > 0) {
    sp.set("submission", params.submission.join(","));
  }
  if (params.tracking && params.tracking.length > 0) {
    sp.set("tracking", params.tracking.join(","));
  }
  if (params.page && params.page > 1) sp.set("page", String(params.page));
  const qs = sp.toString();
  return qs ? `/crm/orders?${qs}` : "/crm/orders";
}

const SUBMISSION_FILTERS = [
  "queued",
  "submitting",
  "submitted",
  "failed",
  "needs_review",
  "cancelled",
] as const;

function parseSubmissionFilter(
  value: string | string[] | undefined,
): SubmissionFilterStatus[] {
  const raw = first(value);
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is SubmissionFilterStatus =>
      (SUBMISSION_FILTERS as readonly string[]).includes(part),
    );
}

const TRACKING_FILTER_LABELS: Record<string, string> = {
  in_transit: "En transit",
  out_for_delivery: "En livraison",
  at_facility: "Au dépôt",
  awaiting_pickup: "En attente de ramassage",
  delivery_issue: "Colis à problème",
  unknown: "Statut inconnu",
};

function parseTrackingFilter(value: string | string[] | undefined): string[] {
  const raw = first(value);
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part in TRACKING_FILTER_LABELS);
}

export default async function OrdersPage({ searchParams }: OrdersPageProps) {
  const user = await requireUser();
  const sp = await searchParams;
  const archived = first(sp.archived) === "1";
  // "Mes commandes": orders assigned to the signed-in user; kept across every view link.
  const mine = first(sp.mine) === "1";
  const viewUrl = (params: Parameters<typeof ordersUrl>[0]) => ordersUrl({ archived, mine, utmSource, utmCampaign, ...params });
  const utmSource = first(sp.utm_source)?.slice(0, 200);
  const utmCampaign = first(sp.utm_campaign)?.slice(0, 200);
  const now = new Date();
  const nowIso = now.toISOString();

  const submission = parseSubmissionFilter(sp.submission);
  const tracking = parseTrackingFilter(sp.tracking);
  const callbackDue = first(sp.callbackDue) === "1";
  const rawStatus = first(sp.status);

  let status: ConfirmationStatus | "all";
  if (rawStatus && (STATUS_TABS as string[]).includes(rawStatus)) {
    status = rawStatus as ConfirmationStatus | "all";
  } else if (archived || callbackDue || submission.length > 0 || tracking.length > 0) {
    status = "all";
  } else {
    status = "new";
  }

  // Normalize incompatible status when callbackDue=1 is requested:
  // Callbacks only exist for call_back_later confirmation status.
  // If callbackDue is requested with an incompatible confirmation status,
  // normalize status to "all" so existing links do not create an impossible queue.
  if (callbackDue && status !== "all" && status !== "call_back_later") {
    status = "all";
  }

  const q = first(sp.q);
  const pageParam = Number(first(sp.page) ?? "1");
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;

  const dueCallbacksCount = countDueCallbacks(now);

  const result = listOrders({
    archived,
    status,
    q,
    callbackDue,
    assignedTo: mine ? user.id : undefined,
    utmSource,
    utmCampaign,
    submission: submission.length > 0 ? submission : undefined,
    tracking: tracking.length > 0 ? tracking : undefined,
    page,
  });

  // Export keeps every current filter but never the page number.
  const exportParams = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (key === "page" || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) exportParams.append(key, v);
  }
  if (!exportParams.has("status")) exportParams.set("status", status);
  const exportHref = `/api/crm/orders/export?${exportParams.toString()}`;

  const isATraiterActive =
    status === "new" &&
    !callbackDue &&
    submission.length === 0 &&
    tracking.length === 0 &&
    !q;

  const isSansReponseActive =
    status === "no_answer" &&
    !callbackDue &&
    submission.length === 0 &&
    tracking.length === 0 &&
    !q;

  const isRappelsDuJourActive =
    callbackDue &&
    submission.length === 0 &&
    tracking.length === 0 &&
    !q;

  const isProblemesEnvoiActive =
    status === "all" &&
    !callbackDue &&
    tracking.length === 0 &&
    !q &&
    submission.length === 2 &&
    submission.includes("failed") &&
    submission.includes("needs_review");

  const hasFilterChips = Boolean(
    q || callbackDue || submission.length > 0 || tracking.length > 0,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-semibold text-2xl text-foreground">
            {archived ? "Commandes archivées" : "Commandes"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {result.total} {result.total > 1 ? "commandes" : "commande"} · Données à
            jour au {formatCasablanca(nowIso)} (Casablanca)
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {user.role === "admin" ? (
            <Button asChild variant="outline">
              <a href={exportHref}>Exporter CSV</a>
            </Button>
          ) : null}
          <Button asChild variant="outline">
            <Link href={ordersUrl({ archived: !archived, status: "all" })}>
              {archived ? "Commandes actives" : "Archives"}
            </Link>
          </Button>
          <Button asChild className="bg-primary text-primary-foreground hover:bg-primary/90">
            <Link href="/crm/orders/new">
              <PlusIcon aria-hidden className="mr-1.5 size-4" />
              Nouvelle commande
            </Link>
          </Button>
        </div>
      </div>

      {/* Quick shortcuts and status tabs */}
      <div className="space-y-3">
        {!archived ? <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Files de travail
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={ordersUrl({ mine, status: "new" })}
              aria-current={isATraiterActive ? "page" : undefined}
              className={cn(
                "rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
                isATraiterActive
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              )}
            >
              À traiter
            </Link>
            <Link
              href={ordersUrl({ mine, status: "no_answer" })}
              aria-current={isSansReponseActive ? "page" : undefined}
              className={cn(
                "rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
                isSansReponseActive
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              )}
            >
              Sans réponse
            </Link>
            <Link
              href={ordersUrl({ mine, status: "all", callbackDue: true })}
              aria-current={isRappelsDuJourActive ? "page" : undefined}
              title="Tous les rappels d'aujourd'hui et en retard"
              className={cn(
                "rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
                isRappelsDuJourActive
                  ? "border-[var(--crm-warning)]/80 bg-[var(--crm-warning-bg)] text-[var(--crm-warning)]"
                  : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              )}
            >
              Rappels du jour ({dueCallbacksCount})
            </Link>
            <Link
              href={ordersUrl({ mine, status: "all", submission: ["failed", "needs_review"] })}
              aria-current={isProblemesEnvoiActive ? "page" : undefined}
              className={cn(
                "rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
                isProblemesEnvoiActive
                  ? "border-[var(--crm-danger)]/80 bg-[var(--crm-danger-bg)] text-[var(--crm-danger)]"
                  : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              )}
            >
              Problèmes d&apos;envoi
            </Link>
            <Link
              href={ordersUrl({ status, q, callbackDue, submission, tracking, mine: !mine })}
              aria-pressed={mine}
              className={cn(
                "rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
                mine
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              )}
            >
              Mes commandes
            </Link>
          </div>
        </div> : null}

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Statuts
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {STATUS_TABS.map((tab) => {
              const active =
                tab === status &&
                !callbackDue &&
                !isProblemesEnvoiActive;
              return (
                <Link
                  key={tab}
                  href={viewUrl({ status: tab, q, submission, tracking })}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                  )}
                >
                  {tab === "all" ? "Toutes" : CONFIRMATION_LABELS[tab]}
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      {/* Rappels du jour queue explanation */}
      {callbackDue ? (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--crm-warning)]/30 bg-[var(--crm-warning-bg)] px-3.5 py-2.5 text-sm text-[var(--crm-warning)]">
          <ClockIcon className="size-4 shrink-0 text-[var(--crm-warning)]" aria-hidden />
          <span>Tous les rappels d&apos;aujourd&apos;hui et en retard</span>
        </div>
      ) : null}

      {/* Active filters bar */}
      {hasFilterChips ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-sm text-card-foreground">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Filtres actifs :
          </span>
          {q ? (
            <Link
              href={viewUrl({ status, callbackDue, submission, tracking })}
              aria-label="Supprimer le filtre de recherche"
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted/80"
            >
              <span>Recherche : « {q} »</span>
              <XIcon className="size-3 text-muted-foreground hover:text-foreground" aria-hidden />
            </Link>
          ) : null}
          {callbackDue ? (
            <Link
              href={viewUrl({ status, q, submission, tracking })}
              aria-label="Supprimer le filtre des rappels"
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--crm-warning)]/40 bg-[var(--crm-warning-bg)] px-2.5 py-1 text-xs font-medium text-[var(--crm-warning)] hover:bg-[var(--crm-warning-bg)]/80"
            >
              <span>Rappels du jour</span>
              <XIcon className="size-3 text-[var(--crm-warning)]/70 hover:text-[var(--crm-warning)]" aria-hidden />
            </Link>
          ) : null}
          {submission.map((value) => (
            <Link
              key={value}
              href={viewUrl({
                status,
                q,
                callbackDue,
                submission: submission.filter((v) => v !== value),
                tracking,
              })}
              aria-label={`Supprimer le filtre de transmission ${SUBMISSION_STATUS_LABELS[value]}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--crm-warning)]/40 bg-[var(--crm-warning-bg)] px-2.5 py-1 text-xs font-medium text-[var(--crm-warning)] hover:bg-[var(--crm-warning-bg)]/80"
            >
              <span>Transmission : {SUBMISSION_STATUS_LABELS[value]}</span>
              <XIcon className="size-3 text-[var(--crm-warning)]/70 hover:text-[var(--crm-warning)]" aria-hidden />
            </Link>
          ))}
          {tracking.map((value) => (
            <Link
              key={value}
              href={viewUrl({
                status,
                q,
                callbackDue,
                submission,
                tracking: tracking.filter((v) => v !== value),
              })}
              aria-label={`Supprimer le filtre de suivi ${TRACKING_FILTER_LABELS[value]}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--crm-warning)]/40 bg-[var(--crm-warning-bg)] px-2.5 py-1 text-xs font-medium text-[var(--crm-warning)] hover:bg-[var(--crm-warning-bg)]/80"
            >
              <span>Suivi : {TRACKING_FILTER_LABELS[value]}</span>
              <XIcon className="size-3 text-[var(--crm-warning)]/70 hover:text-[var(--crm-warning)]" aria-hidden />
            </Link>
          ))}
          <Link
            href={viewUrl({ status: "all" })}
            className="ml-auto text-xs font-medium text-primary hover:underline"
          >
            Effacer les filtres
          </Link>
        </div>
      ) : status !== "all" ? (
        <div className="flex items-center justify-end">
          <Link
            href={viewUrl({ status: "all" })}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            Effacer les filtres
          </Link>
        </div>
      ) : null}

      <form
        method="get"
        action="/crm/orders"
        className="flex max-w-md items-center gap-2"
      >
        <input type="hidden" name="status" value={status} />
        {archived ? <input type="hidden" name="archived" value="1" /> : null}
        {mine ? <input type="hidden" name="mine" value="1" /> : null}
        {callbackDue ? <input type="hidden" name="callbackDue" value="1" /> : null}
        {submission.length > 0 ? (
          <input type="hidden" name="submission" value={submission.join(",")} />
        ) : null}
        {tracking.length > 0 ? (
          <input type="hidden" name="tracking" value={tracking.join(",")} />
        ) : null}
        <Input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Téléphone, nom, n° commande ou suivi…"
          aria-label="Rechercher une commande"
          className="h-9 border-input bg-card text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring"
        />
        <Button type="submit" size="lg" variant="secondary" className="h-9 shrink-0">
          <SearchIcon aria-hidden />
          Rechercher
        </Button>
      </form>

      <OrderBulkActions
        key={JSON.stringify([archived, mine, status, q, page, callbackDue, submission, tracking, result.orders.map((o) => o.id)])}
        ids={result.orders.map((o) => o.id)}
        archived={archived}
        isAdmin={user.role === "admin"}
      >
        <OrdersTable orders={result.orders} now={now} />
      </OrderBulkActions>

      {result.pageCount > 1 ? (
        <nav
          aria-label="Pagination"
          className="flex items-center justify-between text-sm"
        >
          {page > 1 ? (
            <Link
              href={viewUrl({ status, q, callbackDue, submission, tracking, page: page - 1 })}
              className="rounded-lg border border-border px-3 py-1.5 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
            >
              ← Précédent
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted-foreground">
            Page {result.page} sur {result.pageCount}
          </span>
          {page < result.pageCount ? (
            <Link
              href={viewUrl({ status, q, callbackDue, submission, tracking, page: page + 1 })}
              className="rounded-lg border border-border px-3 py-1.5 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
            >
              Suivant →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
