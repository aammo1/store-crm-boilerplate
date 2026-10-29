import type { Metadata } from "next";

import { BlBuilder } from "@/components/crm/bl-builder";
import { BlDocumentArchive } from "@/components/crm/bl-document-archive";
import { LabelShippingBoard } from "@/components/crm/label-shipping-board";
import { requireUser } from "@/lib/auth-guards";
import { courierProfile } from "@/lib/env";
import { COURIERS } from "@/lib/shipping/couriers";
import { getProvider } from "@/lib/shipping";
import {
  getSavedBlDocuments,
  parseDocumentsPage,
} from "@/lib/services/bl-documents";
import { getShipmentBoard } from "@/lib/services/expeditions";

export const metadata: Metadata = {
  title: "Expéditions — CRM",
  robots: { index: false },
};

interface ExpeditionsPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ExpeditionsPage({
  searchParams,
}: ExpeditionsPageProps) {
  const user = await requireUser();
  const profile = courierProfile();
  const courierDef = COURIERS[profile];
  const label = courierDef.label;

  let provider: ReturnType<typeof getProvider> | null = null;
  let providerError = false;
  try {
    provider = getProvider();
  } catch {
    providerError = true;
  }

  const caps = provider?.capabilities ?? courierDef.capabilities;
  const board = getShipmentBoard();

  if (caps.deliveryNotes) {
    const sp = searchParams ? await searchParams : undefined;
    const page = parseDocumentsPage(sp?.documentsPage);
    const archive = getSavedBlDocuments(page);

    return (
      <div className="space-y-10">
        <div>
          <h1 className="font-semibold text-2xl text-foreground">
            Expéditions
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Constituez les bons de livraison, imprimez les étiquettes puis
            déclarez la remise au livreur colis par colis.
          </p>
        </div>

        {providerError && (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm font-medium text-destructive">
            Transporteur non configuré — voir le tableau de bord.
          </div>
        )}

        <BlBuilder
          assistantEnabled={user.role === "admin"}
          ready={board.ready}
          operations={board.operations}
          savedNotes={board.savedNotes}
          dispatched={board.dispatched}
        />

        <BlDocumentArchive archive={archive} searchParams={sp} />
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <div>
        <h1 className="font-semibold text-2xl text-foreground">
          Expéditions
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Imprimez les étiquettes {label} des colis prêts, collez-les, puis
          déclarez la remise au livreur.
        </p>
      </div>

      {providerError && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm font-medium text-destructive">
          Transporteur non configuré — voir le tableau de bord.
        </div>
      )}

      <LabelShippingBoard
        ready={board.ready}
        dispatched={board.dispatched}
        formats={caps.labelFormats}
        courierLabel={label}
      />
    </div>
  );
}
