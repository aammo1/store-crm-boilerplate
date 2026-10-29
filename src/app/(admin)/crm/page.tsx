import type { Metadata } from "next";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  InboxIcon,
  PackageCheckIcon,
  PackageIcon,
  PhoneCallIcon,
  RefreshCwIcon,
  SendIcon,
  TruckIcon,
  Undo2Icon,
} from "lucide-react";

import { requireUser } from "@/lib/auth-guards";
import { formatCasablanca } from "@/lib/services/orders";
import { courierProfile } from "@/lib/env";
import { COURIERS } from "@/lib/shipping/couriers";
import { getCourierHealth } from "@/lib/services/courier-health";
import { CourierHealthCard } from "@/components/crm/courier-health-card";
import {
  getDashboard,
  type DashboardOrderRow,
  type DashboardParcelRow,
  type DashboardReturnRow,
  type DashboardSubmissionRow,
  type DashboardTransitRow,
} from "@/lib/services/dashboard";
import { SUBMISSION_STATUS_LABELS } from "@/components/crm/status-badge";
import { KpiSection } from "@/components/crm/kpi-section";
import { getKpis, resolveKpiRange } from "@/lib/services/kpis";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Tableau de bord — CRM",
  robots: { index: false },
};

const NORMALIZED_STATUS_LABELS: Record<string, string> = {
  in_transit: "En transit",
  out_for_delivery: "En cours de livraison",
  at_facility: "Au dépôt",
  awaiting_pickup: "En attente de ramassage",
  delivery_issue: "Colis à problème",
  unknown: "Inconnu",
};

const RETURN_STATUS_LABELS: Record<string, string> = {
  returning: "Retour en cours",
  received: "Reçu",
  inspected: "Inspecté",
};

function isOverdue(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

// --- Card shell.

interface CardProps {
  title: string;
  icon: LucideIcon;
  href: string;
  linkLabel: string;
  count: number;
  accent?: boolean;
  sub?: React.ReactNode;
  children?: React.ReactNode;
}

function DashboardCard({
  title,
  icon: Icon,
  href,
  linkLabel,
  count,
  accent = false,
  sub,
  children,
}: CardProps) {
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col rounded-xl border p-5 transition-colors",
        accent
          ? "border-[var(--crm-danger)]/40 bg-[var(--crm-danger-bg)]"
          : "border-border bg-card text-card-foreground",
      )}
    >
      <Link
        href={href}
        className="group flex items-start justify-between gap-3"
        aria-label={`${title} — ouvrir la liste`}
      >
        <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground group-hover:text-foreground">
          <Icon className="size-4 shrink-0" aria-hidden />
          {title}
        </h2>
        <span
          className={cn(
            "font-semibold text-3xl leading-none tabular-nums",
            accent ? "text-[var(--crm-danger)]" : "text-foreground",
          )}
        >
          {count}
        </span>
      </Link>
      {sub}
      {children ? (
        <div className="mt-4 flex-1 border-t border-border pt-4">{children}</div>
      ) : (
        <p className="mt-4 flex-1 border-t border-border pt-4 text-sm text-muted-foreground">
          Rien à signaler.
        </p>
      )}
      <Link
        href={href}
        className="mt-4 inline-flex items-center gap-1 self-start text-xs font-medium text-primary hover:underline"
      >
        {linkLabel}
        <ArrowRightIcon className="size-3" aria-hidden />
      </Link>
    </article>
  );
}

function EmptyRow({ label }: { label: string }) {
  return <p className="text-sm text-muted-foreground">{label}</p>;
}

// --- Row renderers (one line pair per row, no financial data).

function OrderRows({
  rows,
  emptyLabel,
  showCallback = false,
}: {
  rows: DashboardOrderRow[];
  emptyLabel: string;
  showCallback?: boolean;
}) {
  if (rows.length === 0) return <EmptyRow label={emptyLabel} />;
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.orderId} className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <Link
              href={`/crm/orders/${row.orderId}`}
              className="shrink-0 font-mono text-xs text-primary hover:underline"
            >
              {row.orderId}
            </Link>
            <span className="truncate text-xs text-foreground/80">{row.customerName}</span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {row.customerPhone}
            {row.cityName ? ` · ${row.cityName}` : ""}
            {showCallback && row.nextCallbackAt ? (
              <>
                {" · Rappel "}
                <span
                  className={cn(
                    isOverdue(row.nextCallbackAt) &&
                      "font-medium text-[var(--crm-danger)]",
                  )}
                >
                  {formatCasablanca(row.nextCallbackAt)}
                </span>
              </>
            ) : (
              ` · ${formatCasablanca(row.createdAt)}`
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

function SubmissionRows({
  rows,
  emptyLabel,
  showError = false,
}: {
  rows: DashboardSubmissionRow[];
  emptyLabel: string;
  showError?: boolean;
}) {
  if (rows.length === 0) return <EmptyRow label={emptyLabel} />;
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.submissionId} className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <Link
              href={`/crm/orders/${row.orderId}`}
              className="shrink-0 font-mono text-xs text-primary hover:underline"
            >
              {row.orderId}
            </Link>
            <span className="text-xs text-muted-foreground">
              {SUBMISSION_STATUS_LABELS[row.status] ?? row.status}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {row.customerName} · {formatCasablanca(row.updatedAt)}
          </p>
          {showError && row.lastError ? (
            <p className="mt-1 line-clamp-1 text-xs text-[var(--crm-warning)]">
              {row.lastError}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ParcelRows({
  rows,
  emptyLabel,
  showBlRef = true,
}: {
  rows: DashboardParcelRow[];
  emptyLabel: string;
  showBlRef?: boolean;
}) {
  if (rows.length === 0) return <EmptyRow label={emptyLabel} />;
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.submissionId} className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <Link
              href={`/crm/orders/${row.orderId}`}
              className="shrink-0 font-mono text-xs text-primary hover:underline"
            >
              {row.orderId}
            </Link>
            <span className="truncate text-xs text-foreground/80">{row.customerName}</span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {row.cityName ?? "Ville inconnue"}
            {row.trackingNumber ? ` · Suivi ${row.trackingNumber}` : " · Suivi en attente"}
            {showBlRef && row.blRef ? ` · BL ${row.blRef}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}

function TransitRows({
  rows,
  emptyLabel,
}: {
  rows: DashboardTransitRow[];
  emptyLabel: string;
}) {
  if (rows.length === 0) return <EmptyRow label={emptyLabel} />;
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.submissionId} className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <Link
              href={`/crm/orders/${row.orderId}`}
              className="shrink-0 font-mono text-xs text-primary hover:underline"
            >
              {row.orderId}
            </Link>
            <span className="text-xs text-muted-foreground">
              {NORMALIZED_STATUS_LABELS[row.normalizedStatus] ?? row.normalizedStatus}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {row.customerName}
            {row.trackingNumber ? ` · Suivi ${row.trackingNumber}` : ""}
            {` · ${formatCasablanca(row.updatedAt)}`}
          </p>
        </li>
      ))}
    </ul>
  );
}

function ReturnRows({
  rows,
  emptyLabel,
}: {
  rows: DashboardReturnRow[];
  emptyLabel: string;
}) {
  if (rows.length === 0) return <EmptyRow label={emptyLabel} />;
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.id} className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <Link
              href={`/crm/orders/${row.orderId}`}
              className="shrink-0 font-mono text-xs text-primary hover:underline"
            >
              {row.orderId}
            </Link>
            <span className="text-xs text-muted-foreground">
              {RETURN_STATUS_LABELS[row.status] ?? row.status}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {row.customerName}
            {row.trackingNumber ? ` · Suivi ${row.trackingNumber}` : ""}
            {` · ${formatCasablanca(row.createdAt)}`}
          </p>
        </li>
      ))}
    </ul>
  );
}

function LowStockRows({
  rows,
  emptyLabel,
}: {
  rows: Array<{ sku: string; available: number }>;
  emptyLabel: string;
}) {
  if (rows.length === 0) return <EmptyRow label={emptyLabel} />;
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.sku} className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-xs text-foreground/80">{row.sku}</span>
          <span
            className={cn(
              "text-xs font-semibold tabular-nums",
              row.available === 0 ? "text-[var(--crm-danger)]" : "text-foreground",
            )}
          >
            {row.available}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SubCount({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "amber";
}) {
  return (
    <p
      className={cn(
        "mt-2 text-xs",
        tone === "amber" && value > 0
          ? "text-[var(--crm-warning)]"
          : "text-muted-foreground",
      )}
    >
      {label} : <span className="font-semibold tabular-nums">{value}</span>
    </p>
  );
}

// --- Page.

export default async function CrmDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const { preset, from, to } = resolveKpiRange({ range: one(sp.range), from: one(sp.from), to: one(sp.to) });
  // Role is enforced inside getKpis: agents never receive money fields.
  const kpis = getKpis({ from, to, role: user.role === "admin" ? "admin" : "agent" });
  const data = getDashboard();
  const courierHealth = getCourierHealth();
  const { syncHealth } = data;
  const profile = courierProfile();
  const hasDeliveryNotes = COURIERS[profile].capabilities.deliveryNotes;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-semibold text-2xl text-foreground">
          Tableau de bord
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Données à jour au {formatCasablanca(data.generatedAt)} (Casablanca)
        </p>
      </div>

      <KpiSection kpis={kpis} preset={preset} />

      {data.deliveryIssuesCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--crm-danger)]/40 bg-[var(--crm-danger-bg)] p-4 text-sm text-[var(--crm-danger)]">
          <div className="flex items-center gap-2">
            <AlertTriangleIcon className="size-4 shrink-0" aria-hidden />
            <span>
              <strong>Colis à problème : {data.deliveryIssuesCount}</strong> (injoignable, reporté, adresse à changer)
            </span>
          </div>
          <Link
            href="/crm/orders?tracking=delivery_issue"
            className="flex items-center gap-1 font-medium hover:underline"
          >
            Voir les commandes
            <ArrowRightIcon className="size-3.5" aria-hidden />
          </Link>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <DashboardCard
          title="Nouvelles commandes"
          icon={InboxIcon}
          href="/crm/orders?status=new"
          linkLabel="Voir les commandes"
          count={data.newOrders.count}
          accent={data.newOrders.count > 0}
        >
          <OrderRows
            rows={data.newOrders.rows}
            emptyLabel="Aucune nouvelle commande."
          />
        </DashboardCard>

        <DashboardCard
          title="Rappels dus"
          icon={PhoneCallIcon}
          href="/crm/orders?status=all&callbackDue=1"
          linkLabel="Voir les rappels dus"
          count={data.callbacksDue.count}
          accent={data.callbacksDue.count > 0}
        >
          <OrderRows
            rows={data.callbacksDue.rows}
            emptyLabel="Aucun rappel dû aujourd'hui."
            showCallback
          />
        </DashboardCard>

        <DashboardCard
          title="À soumettre / en cours d'envoi"
          icon={SendIcon}
          href="/crm/orders?submission=queued,submitting"
          linkLabel="Voir les commandes en file"
          count={data.pendingSubmissions.count}
        >
          <SubmissionRows
            rows={data.pendingSubmissions.rows}
            emptyLabel="Aucune transmission en attente."
          />
        </DashboardCard>

        <DashboardCard
          title="Échecs / à vérifier"
          icon={AlertTriangleIcon}
          href="/crm/orders?submission=failed,needs_review"
          linkLabel="Voir les transmissions à vérifier"
          count={data.failedSubmissions.count}
          accent={data.failedSubmissions.count > 0}
        >
          <SubmissionRows
            rows={data.failedSubmissions.rows}
            emptyLabel="Aucune transmission en échec."
            showError
          />
        </DashboardCard>

        <DashboardCard
          title={hasDeliveryNotes ? "À expédier (BL)" : "À expédier (étiquettes)"}
          icon={PackageIcon}
          href="/crm/expeditions"
          linkLabel="Ouvrir les expéditions"
          count={data.readyBl.count}
        >
          <ParcelRows
            rows={data.readyBl.rows}
            emptyLabel={
              hasDeliveryNotes
                ? "Aucun colis à mettre sur un BL."
                : "Aucun colis à étiqueter."
            }
            showBlRef={hasDeliveryNotes}
          />
        </DashboardCard>

        {hasDeliveryNotes ? (
          <DashboardCard
            title="À remettre au livreur"
            icon={PackageCheckIcon}
            href="/crm/expeditions"
            linkLabel="Ouvrir les expéditions"
            count={data.awaitingHandoff.count}
          >
            <ParcelRows
              rows={data.awaitingHandoff.rows}
              emptyLabel="Aucun colis en attente de remise."
            />
          </DashboardCard>
        ) : null}

        <DashboardCard
          title="En cours de livraison"
          icon={TruckIcon}
          href="/crm/orders?status=all&tracking=in_transit,out_for_delivery,at_facility"
          linkLabel="Voir les colis en cours"
          count={data.inTransit.count}
          sub={
            data.inTransit.unknownCount > 0 ? (
              <SubCount
                label="Inconnu"
                value={data.inTransit.unknownCount}
                tone="amber"
              />
            ) : null
          }
        >
          <TransitRows
            rows={data.inTransit.rows}
            emptyLabel="Aucun colis en cours de livraison."
          />
          {data.inTransit.unknownCount > 0 ? (
            <div className="mt-3 rounded-lg border border-[var(--crm-warning)]/30 bg-[var(--crm-warning-bg)] p-3">
              <p className="text-xs font-medium text-[var(--crm-warning)]">
                Statuts bruts à vérifier
              </p>
              <ul className="mt-2 space-y-1.5">
                {data.inTransit.unknownRows.map((row) => (
                  <li
                    key={row.submissionId}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <Link
                      href={`/crm/orders/${row.orderId}`}
                      className="shrink-0 font-mono text-primary hover:underline"
                    >
                      {row.orderId}
                    </Link>
                    <span
                      className="truncate font-mono text-[var(--crm-warning)]"
                      title={row.rawStatus ?? undefined}
                    >
                      {row.rawStatus ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </DashboardCard>

        <DashboardCard
          title="Retours en cours"
          icon={Undo2Icon}
          href="/crm/retours"
          linkLabel="Ouvrir les retours"
          count={data.returns.returningCount}
          sub={
            data.returns.receivedCount > 0 ? (
              <SubCount label="Reçus à inspecter" value={data.returns.receivedCount} />
            ) : null
          }
        >
          <ReturnRows
            rows={data.returns.rows}
            emptyLabel="Aucun retour en cours."
          />
        </DashboardCard>

        <DashboardCard
          title="Stock bas"
          icon={PackageIcon}
          href="/crm/stock"
          linkLabel="Ouvrir le stock"
          count={data.lowStockItems.count}
          accent={data.lowStockItems.count > 0}
        >
          <LowStockRows
            rows={data.lowStockItems.rows}
            emptyLabel="Stock suffisant partout."
          />
        </DashboardCard>
      </div>

      <CourierHealthCard health={courierHealth} isAdmin={user.role === "admin"} />

      <section
        className={cn(
          "rounded-xl border p-5",
          syncHealth.failing
            ? "border-[var(--crm-warning)]/40 bg-[var(--crm-warning-bg)]"
            : "border-border bg-card text-card-foreground",
        )}
      >
        <div className="flex items-center gap-2">
          <RefreshCwIcon className="size-4" aria-hidden />
          <h2 className="text-sm font-medium text-muted-foreground">
            Santé synchronisation
          </h2>
          {syncHealth.failing ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-[var(--crm-warning)]/40 bg-[var(--crm-warning-bg)] px-2 py-0.5 text-xs font-medium text-[var(--crm-warning)]">
              <AlertTriangleIcon className="size-3" aria-hidden />
              Alerte
            </span>
          ) : null}
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs tracking-wide text-muted-foreground uppercase">
              Suivi transporteur
            </p>
            <p
              className={cn(
                "mt-1 text-sm font-medium",
                syncHealth.failing ? "text-[var(--crm-warning)]" : "text-foreground",
              )}
            >
              {syncHealth.lastSyncLabel ?? "Jamais synchronisé"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {syncHealth.lastSyncAbsolute ?? "Aucune synchronisation réussie enregistrée"}
            </p>
          </div>
          <div>
            <p className="text-xs tracking-wide text-muted-foreground uppercase">Villes</p>
            <p className="mt-1 text-sm font-medium text-foreground">
              {syncHealth.citiesLastSyncLabel ?? "Jamais synchronisé"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {syncHealth.citiesLastSyncAbsolute ?? "Aucune liste de villes en base"}
            </p>
          </div>
        </div>

        {syncHealth.failing ? (
          <p className="mt-4 text-xs text-[var(--crm-warning)]">
            {syncHealth.staleParcels > 0
              ? `${syncHealth.staleParcels} colis non synchronisé(s) depuis trop longtemps — `
              : "Dernière synchronisation de suivi trop ancienne ou jamais effectuée — "}
            vérifiez le worker de suivi des colis.
          </p>
        ) : null}
      </section>
    </div>
  );
}
