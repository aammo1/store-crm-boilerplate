import type { Metadata } from "next";
import { BlocklistManager } from "@/components/crm/blocklist-manager";
import { CarrierStatusMapping, type CarrierStatusRowView } from "@/components/crm/carrier-status-mapping";
import { CityTariffsManager } from "@/components/crm/city-tariffs-manager";
import { CourierSettingsForm } from "@/components/crm/courier-settings-form";
import { StoreSettingsForm } from "@/components/crm/store-settings-form";
import { WhatsAppSettingsForm } from "@/components/crm/whatsapp-settings-form";
import { requireAdmin } from "@/lib/auth-guards";
import { courierProfile, deliveryProviderName } from "@/lib/env";
import { listRawStatuses } from "@/lib/services/carrier-status-map";
import { getCourierSettings, listPickupDistricts } from "@/lib/services/courier-settings";
import { listBlockedPhones } from "@/lib/services/customers";
import { defaultCourierCost, listCityTariffs } from "@/lib/services/city-tariffs";
import { getStoreSettings } from "@/lib/services/store-settings";
import { getWhatsAppConnectionState, getWhatsAppSettings } from "@/lib/services/whatsapp-settings";
import { whatsappAiConfigured, whatsappConfigured } from "@/lib/whatsapp/config";

export const runtime = "nodejs";
export const metadata: Metadata = {
  title: "Paramètres",
  robots: { index: false, follow: false },
};

const seenFormatter = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Africa/Casablanca",
  dateStyle: "short",
  timeStyle: "short",
});

function toCarrierStatusView(row: ReturnType<typeof listRawStatuses>[number]): CarrierStatusRowView {
  return {
    ...row,
    lastSeenLabel: seenFormatter.format(new Date(row.lastSeenAt)),
  };
}

export default async function SettingsPage() {
  const user = await requireAdmin();
  const settings = getStoreSettings();
  const isSendit = courierProfile() === "sendit";
  const courierSettings = isSendit ? getCourierSettings() : null;
  const pickupDistricts = isSendit ? listPickupDistricts(deliveryProviderName()) : [];
  const whatsappSettings = getWhatsAppSettings();
  const whatsappConnection = getWhatsAppConnectionState();
  const whatsappIsConfigured = whatsappConfigured();
  const whatsappAiIsConfigured = whatsappAiConfigured();

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Configuration de la boutique</p>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Paramètres</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Les règles enregistrées s’appliquent uniquement aux nouvelles commandes et aux nouvelles offres.
          Les montants et les délais déjà enregistrés sont conservés.
        </p>
      </header>
      <StoreSettingsForm initialSettings={settings} />
      <section className="rounded-xl border border-border bg-card p-5 text-card-foreground">
        <h2 className="mb-1 text-lg font-semibold">WhatsApp</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Connexion Evolution API, notifications proactives, assistant IA et règles de sécurité.
        </p>
        <WhatsAppSettingsForm
          initialSettings={whatsappSettings}
          connectionState={whatsappConnection}
          configured={{
            evolution: whatsappIsConfigured,
            ai: whatsappAiIsConfigured,
          }}
          storeName={settings.storeName}
        />
      </section>
      <section className="rounded-xl border border-border bg-card p-5 text-card-foreground">
        <h2 className="mb-1 text-lg font-semibold">Statuts transporteur (notifications)</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Ces correspondances servent uniquement aux notifications WhatsApp ; elles ne modifient
          jamais le stock ni les statuts de livraison.
        </p>
        <CarrierStatusMapping
          initialRows={listRawStatuses().map(toCarrierStatusView)}
          currentUserName={user.name ?? null}
        />
      </section>
      {isSendit && courierSettings ? (
        <section className="rounded-xl border border-border bg-card p-5 text-card-foreground">
          <CourierSettingsForm
            initialSettings={courierSettings}
            pickupDistricts={pickupDistricts}
          />
        </section>
      ) : null}
      <section className="rounded-xl border border-border bg-card p-5 text-card-foreground">
        <h2 className="mb-1 text-lg font-semibold">Numéros bloqués</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Les commandes de ces numéros restent acceptées mais sont signalées aux agents.
        </p>
        <BlocklistManager initialBlocked={listBlockedPhones()} />
      </section>
      <section className="rounded-xl border border-border bg-card p-5 text-card-foreground">
        <h2 className="mb-1 text-lg font-semibold">Tarifs par ville</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Coût livreur (pour le calcul du profit, jamais visible des agents ni de la boutique) et frais client
          spécifiques, proposés aux agents lors de la modification d’une commande.
        </p>
        <CityTariffsManager initialTariffs={listCityTariffs()} initialDefaultCost={defaultCourierCost()} />
      </section>
    </div>
  );
}
