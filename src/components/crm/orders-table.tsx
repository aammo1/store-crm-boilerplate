import Link from "next/link";
import { AlertTriangleIcon, PhoneIcon } from "lucide-react";

import { CopyButton } from "@/components/crm/copy-button";
import { OrderSelection } from "@/components/crm/order-bulk-actions";
import { StatusBadge } from "@/components/crm/status-badge";
import { formatMad } from "@/lib/pricing";
import type { OrderListItem } from "@/lib/services/orders";
import { formatCasablanca } from "@/lib/services/orders";

import { getCasablancaParts } from "@/lib/callback-time";

interface NextCallbackProps {
  iso: string | null;
  now?: Date;
}

export function NextCallback({ iso, now = new Date() }: NextCallbackProps) {
  if (!iso) return <span className="text-muted-foreground/40">—</span>;

  const targetDate = new Date(iso);
  if (Number.isNaN(targetDate.getTime())) {
    return <span className="text-muted-foreground/40">—</span>;
  }

  const targetParts = getCasablancaParts(targetDate);
  const nowParts = getCasablancaParts(now);

  const isToday =
    targetParts.year === nowParts.year &&
    targetParts.month === nowParts.month &&
    targetParts.day === nowParts.day;

  const tomorrowUtc = new Date(
    Date.UTC(
      Number(nowParts.year),
      Number(nowParts.month) - 1,
      Number(nowParts.day) + 1,
    ),
  );
  const tomorrowYear = String(tomorrowUtc.getUTCFullYear());
  const tomorrowMonth = String(tomorrowUtc.getUTCMonth() + 1).padStart(2, "0");
  const tomorrowDay = String(tomorrowUtc.getUTCDate()).padStart(2, "0");

  const isTomorrow =
    targetParts.year === tomorrowYear &&
    targetParts.month === tomorrowMonth &&
    targetParts.day === tomorrowDay;

  const isOverdue = targetDate.getTime() < now.getTime();
  const timeStr = `${targetParts.hour}:${targetParts.minute}`;
  const dateStr = `${targetParts.day}/${targetParts.month}/${targetParts.year}`;

  let label: string;
  if (isOverdue) {
    label = isToday
      ? `En retard — Aujourd'hui à ${timeStr}`
      : `En retard — ${dateStr} à ${timeStr}`;
  } else if (isToday) {
    label = `Aujourd'hui à ${timeStr}`;
  } else if (isTomorrow) {
    label = `Demain à ${timeStr}`;
  } else {
    label = `${dateStr} à ${timeStr}`;
  }

  return (
    <time
      dateTime={iso}
      title={`${formatCasablanca(iso)} (Casablanca)`}
      className={isOverdue ? "font-medium text-[var(--crm-danger)]" : "text-muted-foreground"}
    >
      {label}
    </time>
  );
}

export function OrdersTable({
  orders,
  now,
  waReadyOrderIds,
}: {
  orders: OrderListItem[];
  now?: Date;
  waReadyOrderIds?: Set<string>;
}) {
  if (orders.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        Aucune commande ne correspond à ces filtres.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card text-card-foreground">
      <table className="w-full min-w-[960px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <th className="w-12 px-4 py-3"><OrderSelection /></th>
            <th className="px-4 py-3 font-medium">Commande</th>
            <th className="px-4 py-3 font-medium">Date</th>
            <th className="px-4 py-3 font-medium">Cliente</th>
            <th className="px-4 py-3 font-medium">Articles</th>
            <th className="px-4 py-3 font-medium">Total</th>
            <th className="px-4 py-3 font-medium">Statut</th>
            <th className="px-4 py-3 font-medium">Agent</th>
            <th className="px-4 py-3 font-medium">Rappel</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr
              key={order.id}
              className="border-b border-border/50 last:border-0 hover:bg-muted/50"
            >
              <td className="px-4 py-3"><OrderSelection id={order.id} /></td>
              <td className="px-4 py-3">
                <Link
                  href={`/crm/orders/${order.id}`}
                  className="font-mono text-xs text-primary hover:underline"
                >
                  {order.id}
                </Link>
                <CopyButton value={order.id} label="" className="text-muted-foreground hover:text-foreground" />
                {order.duplicateOf ? (
                  <Link
                    href={`/crm/orders/${order.duplicateOf}`}
                    className="mt-1 inline-flex items-center gap-1 rounded-full border border-[var(--crm-warning)]/40 bg-[var(--crm-warning-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--crm-warning)] hover:bg-[var(--crm-warning-bg)]/80"
                  >
                    <AlertTriangleIcon className="size-3" aria-hidden />
                    doublon ?
                  </Link>
                ) : null}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {formatCasablanca(order.createdAt)}
              </td>
              <td className="px-4 py-3">
                <span className="block text-foreground">{order.customerName}</span>
                <span className="flex items-center gap-1">
                  <a
                    href={`tel:${order.customerPhone}`}
                    aria-label={`Appeler ${order.customerName}`}
                    className="inline-flex min-h-8 items-center gap-1 rounded-md py-1 pr-1 text-xs text-foreground underline-offset-2 hover:underline"
                  >
                    <PhoneIcon className="size-3.5 text-muted-foreground" aria-hidden />
                    {order.customerPhone}
                  </a>
                  <CopyButton value={order.customerPhone} label="" className="text-muted-foreground hover:text-foreground" />
                </span>
                {order.phoneBlocked || order.priorRefusals > 0 ? (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {order.phoneBlocked ? (
                      <span
                        title="Numéro bloqué"
                        className="inline-flex rounded-full border border-[var(--crm-danger)]/40 bg-[var(--crm-danger-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--crm-danger)]"
                      >
                        Bloqué
                      </span>
                    ) : null}
                    {order.priorRefusals > 0 ? (
                      <span
                        title="Autres commandes refusées ou retournées avec ce numéro"
                        className="inline-flex rounded-full border border-[var(--crm-warning)]/40 bg-[var(--crm-warning-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--crm-warning)]"
                      >
                        {order.priorRefusals} refus
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {order.noAnswerCount > 0 ? (
                  <span
                    title="Appels sans réponse enregistrés"
                    className={
                      order.noAnswerCount >= 3
                        ? "mt-1 inline-flex rounded-full border border-[var(--crm-danger)]/40 bg-[var(--crm-danger-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--crm-danger)]"
                        : "mt-1 inline-flex rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
                    }
                  >
                    {order.noAnswerCount} {order.noAnswerCount > 1 ? "tentatives" : "tentative"} sans réponse
                  </span>
                ) : null}
              </td>
              <td className="max-w-[260px] px-4 py-3 text-muted-foreground">
                <span className="line-clamp-2">{order.itemsSummary}</span>
              </td>
              <td className="px-4 py-3 font-medium tabular-nums whitespace-nowrap text-foreground">
                {formatMad(order.total)}
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-col items-start gap-1">
                  <StatusBadge status={order.confirmationStatus} />
                  {waReadyOrderIds?.has(order.id) || (order as { waReady?: boolean }).waReady ? (
                    <span className="inline-flex rounded-full border border-[var(--crm-success)]/40 bg-[var(--crm-success-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--crm-success)]">
                      Prêt (WhatsApp)
                    </span>
                  ) : null}
                </div>
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {order.assignedToName ?? (
                  <span className="text-muted-foreground/40">Non assignée</span>
                )}
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                <NextCallback iso={order.nextCallbackAt} now={now} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
