import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeftIcon,
  MessageCircleIcon,
  PhoneIcon,
  StickyNoteIcon,
  TruckIcon,
} from "lucide-react";

import { AssignControl } from "@/components/crm/assign-control";
import { CancelOrder } from "@/components/crm/cancel-order";
import { ConfirmOrder } from "@/components/crm/confirm-order";
import { DeliveryOutcomeActions } from "@/components/crm/delivery-outcome-actions";
import { getDeliveryOutcome } from "@/lib/services/delivery-outcomes";
import { EditOrder } from "@/components/crm/edit-order";
import { OrderWhatsappPanel } from "@/components/crm/whatsapp/order-whatsapp-panel";
import { getDraft } from "@/lib/services/whatsapp-staging";
import { BlockPhoneButton } from "@/components/crm/block-phone-button";
import { OrderAttributionCard } from "@/components/crm/order-attribution-card";
import { OrderEditHistoryList } from "@/components/crm/order-edit-history";
import { getOrderEditState, listOrderEdits, orderCityFeeProposal, orderEditOptions } from "@/lib/services/order-edits";
import { MissingOrderShippingRulesError, orderShippingRules } from "@/lib/services/order-lines";
import { CopyButton } from "@/components/crm/copy-button";
import { SubmissionResolveForm } from "@/components/crm/submission-resolve-form";
import { getProvider } from "@/lib/shipping";
import { courierLabel } from "@/lib/shipping/courier-copy";
import { ContactLogForm } from "@/components/crm/contact-log-form";
import {
  COD_STATUS_LABELS,
  OUTCOME_LABELS,
  CHANNEL_LABELS,
  StatusBadge,
  SUBMISSION_STATUS_LABELS,
  UPSELL_STATUS_LABELS,
} from "@/components/crm/status-badge";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth-guards";
import { getStoreSettings } from "@/lib/services/store-settings";
import type { CommerceOrderItem } from "@/lib/commerce-types";
import { formatMad } from "@/lib/pricing";
import {
  formatCasablanca,
  getCrmOrder,
  getCustomerHistory,
  listAgents,
  listCities,
  type CrmOrder,
} from "@/lib/services/orders";
import { buildWaLink, type WaTemplateKey } from "@/lib/wa-templates";
import {
  MANUAL_ORDER_SOURCE_LABELS,
  type ManualOrderSource,
} from "@/lib/manual-order-schema";

export const metadata: Metadata = {
  title: "Commande — CRM",
  robots: { index: false },
};

function formatOrderSource(source: string | null | undefined): string {
  if (!source) return "—";
  if (source in MANUAL_ORDER_SOURCE_LABELS) {
    return MANUAL_ORDER_SOURCE_LABELS[source as ManualOrderSource];
  }
  if (source === "storefront") {
    return "Boutique en ligne";
  }
  return source;
}

function variantDescription(item: CommerceOrderItem): string {
  return `${item.variant_label}${item.options.length ? ` · ${item.options.map((option) => `${option.name} : ${option.value}`).join(" / ")}` : ""} · SKU ${item.sku}`;
}

function itemsSummaryForWa(order: CrmOrder): string {
  const lines = [...order.items, ...(order.upsellStatus === "accepted" ? order.upsellItems ?? [] : [])];
  return lines
    .map((item) => {
      const variant = ` (${variantDescription(item)})`;
      return `• ${item.quantity}× ${item.name}${variant}`;
    })
    .join("\n");
}

function waButton(
  order: CrmOrder,
  trackingNumber: string | null,
  key: WaTemplateKey,
  label: string,
  storeName: string,
) {
  const href = buildWaLink(order.customerPhone, key, {
    boutique: storeName,
    nom: order.customerName,
    produits: itemsSummaryForWa(order),
    total: formatMad(order.total),
    ville: order.cityName ?? "",
    suivi: trackingNumber ?? "",
  });
  const title =
    key === "rappel"
      ? "Ouvre un modèle WhatsApp dans un nouvel onglet (ne planifie aucun rappel dans le CRM)"
      : undefined;
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--crm-success)]/40 bg-[var(--crm-success-bg)] px-2.5 text-sm font-medium text-[var(--crm-success)] transition-colors hover:bg-[var(--crm-success-bg)]/80"
    >
      <MessageCircleIcon className="size-4" aria-hidden />
      WhatsApp · {label}
    </a>
  );
}

const CHANNEL_ICONS = {
  whatsapp: MessageCircleIcon,
  phone: PhoneIcon,
  note: StickyNoteIcon,
} as const;

function ContactEntryRow({
  entry,
}: {
  entry: {
    id: string;
    agentName: string | null;
    channel: string;
    outcome: string;
    note: string | null;
    nextCallbackAt: string | null;
    createdAt: string;
  };
}) {
  const Icon = CHANNEL_ICONS[entry.channel as keyof typeof CHANNEL_ICONS] ?? StickyNoteIcon;
  return (
    <li className="flex gap-3 border-b border-border/50 pb-4 last:border-0 last:pb-0">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted">
        <Icon className="size-3.5 text-muted-foreground" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">
          <span className="font-medium">{CHANNEL_LABELS[entry.channel] ?? entry.channel}</span>
          <span className="text-muted-foreground"> · </span>
          <span>{OUTCOME_LABELS[entry.outcome] ?? entry.outcome}</span>
        </p>
        {entry.note ? (
          <p className="mt-1 text-sm whitespace-pre-line text-foreground/80">{entry.note}</p>
        ) : null}
        {entry.nextCallbackAt ? (
          <p className="mt-1 text-xs text-[var(--crm-warning)]">
            Rappel prévu le {formatCasablanca(entry.nextCallbackAt)}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          {entry.agentName ?? "—"} · {formatCasablanca(entry.createdAt)}
        </p>
      </div>
    </li>
  );
}

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const order = getCrmOrder(id);
  if (!order) notFound();

  const agents = listAgents();
  const cities = listCities();
  const editState = getOrderEditState(id);
  const editHistory = listOrderEdits(id);
  const customerHistory = getCustomerHistory(order.id, order.customerPhone);
  const waDraft = getDraft(order.id);
  const { storeName } = getStoreSettings();
  let shippingRules;
  let pricingError;
  try { shippingRules = orderShippingRules(id); }
  catch (error) {
    if (!(error instanceof MissingOrderShippingRulesError)) throw error;
    pricingError = error.message;
  }
  const upsellLines = order.upsellStatus === "accepted" ? (order.upsellItems ?? []) : [];
  const allLines: Array<CommerceOrderItem & { upsell: boolean }> = [
    ...order.items.map((item) => ({ ...item, upsell: false })),
    ...upsellLines.map((item) => ({ ...item, upsell: true })),
  ];
  const trackingNumber = order.submission?.trackingNumber ?? null;
  const deliveryOutcome = getDeliveryOutcome(order.id);
  const provider = getProvider();
  const lookupCourierLabel = provider.capabilities.parcelLookup
    ? courierLabel()
    : undefined;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={order.archivedAt ? "/crm/orders?archived=1&status=all" : "/crm/orders"}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" aria-hidden />
          Retour aux commandes
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl font-semibold text-foreground">{order.id}</h1>
          <CopyButton value={order.id} label="" className="text-muted-foreground hover:text-foreground" />
          <StatusBadge status={order.confirmationStatus} />
          {order.duplicateOf ? (
            <Link
              href={`/crm/orders/${order.duplicateOf}`}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--crm-warning)]/40 bg-[var(--crm-warning-bg)] px-2 py-0.5 text-xs font-medium text-[var(--crm-warning)] hover:bg-[var(--crm-warning-bg)]/80"
            >
              ⚠ doublon possible — voir l&apos;autre commande
            </Link>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {order.archivedAt ? `Archivée le ${formatCasablanca(order.archivedAt)} · ` : ""}
          Créée le {formatCasablanca(order.createdAt)} · Source : {formatOrderSource(order.source)}
          {order.nextCallbackAt
            ? ` · Prochain rappel : ${formatCasablanca(order.nextCallbackAt)}`
            : ""}
        </p>
      </div>

      {customerHistory.blocked ? (
        <div
          role="alert"
          className="rounded-xl border border-[var(--crm-danger)]/40 bg-[var(--crm-danger-bg)] px-4 py-3 text-sm text-[var(--crm-danger)]"
        >
          <p className="font-semibold">⛔ Numéro bloqué</p>
          <p className="mt-1">
            Motif : {customerHistory.blocked.reason}
            {customerHistory.blocked.createdBy ? ` · par ${customerHistory.blocked.createdBy}` : ""} ·{" "}
            {formatCasablanca(customerHistory.blocked.createdAt)}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {waButton(order, trackingNumber, "confirmation", "Confirmation", storeName)}
        {waButton(order, trackingNumber, "rappel", "Rappel", storeName)}
        {waButton(order, trackingNumber, "expedition", "Expédition", storeName)}

        <span className="mx-1 hidden h-6 w-px bg-border sm:block" />

        <Button variant="outline" size="sm" asChild>
          <Link href="/crm/expeditions">
            <TruckIcon aria-hidden />
            Bons de livraison
          </Link>
        </Button>
      </div>

      {pricingError && editState.editable ? <p role="alert" className="rounded-xl border border-destructive p-4 text-sm text-destructive">{pricingError}</p> : null}
      {editState.editable && shippingRules ? <EditOrder key={editState.revision} orderId={id} revision={editState.revision}
        snapshot={editState.snapshot} options={orderEditOptions()} shippingRules={shippingRules} cityFee={orderCityFeeProposal(id)}>
        <ConfirmOrder
          orderId={order.id}
          lines={allLines.map((item, index) => ({
            lineIndex: index,
            productId: item.product_id,
            productName: item.name,
            variantId: item.variant_id,
            label: item.variant_label,
            options: item.options,
            sku: item.sku,
            quantity: item.quantity,
            upsell: item.upsell,
          }))}
          cities={cities}
          initialAddress={order.address}
          initialCityId={order.cityId}
          totalLabel={formatMad(order.total)}
          draft={
            waDraft
              ? {
                  address: waDraft.address,
                  cityId: waDraft.cityId,
                  cityName: waDraft.cityName,
                  readyToConfirm: waDraft.readyToConfirm,
                }
              : null
          }
        />
      </EditOrder> : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <section className="rounded-xl border border-border bg-card p-5 text-card-foreground">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Cliente
            </h2>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Nom</dt>
                <dd className="text-foreground">{order.customerName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Téléphone</dt>
                <dd className="flex items-center gap-2">
                  <a
                    href={`tel:${order.customerPhone}`}
                    className="text-foreground underline-offset-2 hover:underline"
                  >
                    {order.customerPhone}
                  </a>
                  <CopyButton
                    value={order.customerPhone}
                    label=""
                    className="text-muted-foreground hover:text-foreground"
                  />
                </dd>
                {customerHistory.blocked ? null : (
                  <div className="mt-2">
                    <BlockPhoneButton phone={order.customerPhone} />
                  </div>
                )}
              </div>
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Adresse</dt>
                <dd className="text-foreground">
                  {order.address ?? (
                    <span className="text-muted-foreground">
                      À préciser à la confirmation
                    </span>
                  )}
                  {order.cityName ? ` — ${order.cityName}` : ""}
                </dd>
              </div>
            </dl>
          </section>

          <OrderAttributionCard attribution={order.attribution} />

          <section className="rounded-xl border border-border bg-card p-5 text-card-foreground">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Historique client
            </h2>
            {customerHistory.orderCount === 0 ? (
              <p className="text-sm text-muted-foreground">Première commande avec ce numéro.</p>
            ) : (
              <>
                {customerHistory.returnedCount > 0 || customerHistory.cancelledCount >= 2 ? (
                  <p
                    role="note"
                    className="mb-3 rounded-lg border border-[var(--crm-warning)]/40 bg-[var(--crm-warning-bg)] px-3 py-2 text-sm font-medium text-[var(--crm-warning)]"
                  >
                    ⚠ Client à risque : {customerHistory.returnedCount} retour(s), {customerHistory.cancelledCount} annulation(s)
                    sur {customerHistory.orderCount} autre(s) commande(s). Vérifiez bien avant de confirmer.
                  </p>
                ) : null}
                <p className="mb-3 text-sm text-muted-foreground">
                  {customerHistory.orderCount} autre(s) commande(s) · {customerHistory.confirmedCount} confirmée(s) ·{" "}
                  {customerHistory.cancelledCount} annulée(s) · {customerHistory.returnedCount} retour(s) ·{" "}
                  {customerHistory.deliveredCount} livrée(s) · {customerHistory.refusedCount} refusée(s)
                </p>
                <ul className="divide-y divide-border text-sm">
                  {customerHistory.recent.map((past) => (
                    <li key={past.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                      <Link href={`/crm/orders/${past.id}`} className="font-mono text-foreground underline-offset-2 hover:underline">
                        {past.id}
                      </Link>
                      <StatusBadge status={past.confirmationStatus} />
                      {past.returned ? (
                        <span className="rounded-full border border-destructive/40 px-2 py-0.5 text-xs text-destructive">Retour</span>
                      ) : null}
                      {past.archived ? <span className="text-xs text-muted-foreground">Archivée</span> : null}
                      <span className="ml-auto text-muted-foreground">
                        {formatMad(past.total)} · {formatCasablanca(past.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-5 text-card-foreground">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Articles
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Produit</th>
                    <th className="py-2 pr-4 font-medium">Variante</th>
                    <th className="py-2 pr-4 font-medium">Qté</th>
                    <th className="py-2 pr-4 font-medium">P.U.</th>
                    <th className="py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {allLines.map((item, index) => (
                    <tr key={`${item.product_id}-${index}`} className="border-b border-border/50 last:border-0">
                      <td className="py-2 pr-4 text-foreground">
                        {item.name}
                        {item.upsell ? (
                          <span className="ml-2 inline-flex rounded-full border border-[var(--crm-upsell)]/40 bg-[var(--crm-upsell-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--crm-upsell)]">
                            Upsell
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {variantDescription(item)}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">×{item.quantity}</td>
                      <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground">
                        {formatMad(item.unit_price)}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap text-foreground">
                        {formatMad(item.line_total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="mt-4 space-y-1.5 border-t border-border pt-4 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Sous-total</dt>
                <dd className="text-foreground">{formatMad(order.subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Remise supplémentaire{editState.snapshot.discountType === "percent" ? ` (${editState.snapshot.discountValue} %)` : ""}</dt>
                <dd className="text-foreground">−{formatMad(editState.snapshot.discountAmount)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Livraison</dt>
                <dd className="text-foreground">{formatMad(order.shipping)}</dd>
              </div>
              <div className="flex justify-between text-base font-semibold">
                <dt className="text-foreground">Total (paiement à la livraison)</dt>
                <dd className="text-foreground">{formatMad(order.total)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              Upsell : {UPSELL_STATUS_LABELS[order.upsellStatus] ?? order.upsellStatus}
              {" · "}
              Paiement : {COD_STATUS_LABELS[order.codStatus] ?? order.codStatus}
            </p>
          </section>

          <OrderEditHistoryList entries={editHistory} />

          <section className="rounded-xl border border-border bg-card p-5 text-card-foreground">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Journal de contact
            </h2>
            {order.contacts.length > 0 ? (
              <ul className="space-y-4">
                {order.contacts.map((entry) => (
                  <ContactEntryRow key={entry.id} entry={entry} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Aucun contact enregistré pour le moment.
              </p>
            )}
          </section>
        </div>

        <div className="min-w-0 space-y-6">
          <OrderWhatsappPanel orderId={order.id} />

          <section className="rounded-xl border border-border bg-card p-5 text-card-foreground">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Assignation
            </h2>
            <p className="mb-3 text-sm text-muted-foreground">
              {order.assignedToName ? (
                <>
                  Assignée à{" "}
                  <span className="font-medium text-foreground">{order.assignedToName}</span>
                </>
              ) : (
                <span className="text-muted-foreground">Non assignée</span>
              )}
            </p>
            <AssignControl
              orderId={order.id}
              currentAssignedTo={order.assignedTo}
              currentUserId={user.id}
              isAdmin={user.role === "admin"}
              agents={agents.map((agent) => ({
                id: agent.id,
                name: agent.name,
                role: agent.role,
              }))}
            />
          </section>

          <section className="rounded-xl border border-border bg-card p-5 text-card-foreground">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Expédition
            </h2>
            {order.submission ? (
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Statut</dt>
                  <dd className="text-foreground">
                    {SUBMISSION_STATUS_LABELS[order.submission.status] ??
                      order.submission.status}
                  </dd>
                </div>
                {trackingNumber ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Suivi</dt>
                    <dd className="flex items-center gap-1 font-mono text-xs text-foreground">
                      {trackingNumber}
                      <CopyButton
                        value={trackingNumber}
                        label=""
                        className="text-muted-foreground hover:text-foreground"
                      />
                    </dd>
                  </div>
                ) : null}
                {order.submission.lastError ? (
                  <div>
                    <dt className="text-muted-foreground">Dernière erreur</dt>
                    <dd className="mt-1 break-words text-xs text-[var(--crm-danger)]">
                      {order.submission.lastError}
                    </dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-4 text-xs text-muted-foreground">
                  <dt>Mise à jour</dt>
                  <dd>{formatCasablanca(order.submission.updatedAt)}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                Aucune soumission transporteur pour le moment.
              </p>
            )}
            {order.submission &&
            order.confirmationStatus === "confirmed" &&
            ["needs_review", "failed"].includes(order.submission.status) ? (
              <SubmissionResolveForm
                submissionId={order.submission.id}
                lookupCourierLabel={lookupCourierLabel}
              />
            ) : null}
            {order.confirmationStatus === "confirmed" &&
            order.submission?.status === "submitted" &&
            trackingNumber ? (
              <div className="mt-4 border-t border-border pt-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Livraison</span>
                  {deliveryOutcome ? (
                    <>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                          deliveryOutcome.outcome === "delivered"
                            ? "border-[var(--crm-success)]/40 bg-[var(--crm-success-bg)] text-[var(--crm-success)]"
                            : "border-[var(--crm-danger)]/40 text-[var(--crm-danger)]"
                        }`}
                      >
                        {deliveryOutcome.outcome === "delivered" ? "Livré" : "Refusé"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {deliveryOutcome.source === "tracking"
                          ? "Suivi transporteur"
                          : (deliveryOutcome.byName ?? "Agent")}{" "}
                        · {formatCasablanca(deliveryOutcome.at)}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">Non renseignée</span>
                  )}
                </div>
                <DeliveryOutcomeActions
                  orderId={order.id}
                  current={deliveryOutcome?.outcome ?? null}
                  isAdmin={user.role === "admin"}
                />
              </div>
            ) : null}
            {order.confirmationStatus === "confirmed" &&
              (!order.submission || ["queued", "failed"].includes(order.submission.status)) &&
              !trackingNumber ? <CancelOrder orderId={order.id} /> : null}
          </section>
        </div>
      </div>

      <section className="rounded-xl border border-border bg-card p-5 text-card-foreground">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Résultat du contact
        </h2>
        <ContactLogForm
          key={`${order.id}-${order.confirmationStatus}`}
          orderId={order.id}
          orderStatus={order.confirmationStatus}
        />
      </section>
    </div>
  );
}
