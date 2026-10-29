import { getDb } from "@/lib/db";
import { log } from "@/lib/log";
import { toLocalPhone } from "@/lib/phone";
import { getProvider } from "@/lib/shipping";
import { ProviderError } from "@/lib/shipping/errors";
import { courierReference } from "@/lib/shipping/parcel-payload";
import type { DeliveryProvider, ParcelLookupResult } from "@/lib/shipping/provider";
import { redactText } from "@/lib/shipping/redact";
import { SENDIT_STATUS_LABELS } from "@/lib/shipping/status-map";

export class LookupError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "LookupError";
  }
}

export type LookupResult =
  | {
      status: "found";
      trackingNumber: string;
      rawStatus: string | null;
      statusLabel: string | null;
      reference: string;
    }
  | { status: "not_found"; reference: string }
  | { status: "inconclusive"; reference: string; message: string };

interface SubmissionLookupRow {
  id: string;
  order_id: string;
  status: string;
  payload_json: string | null;
}

interface OrderLookupRow {
  id: string;
  customer_phone: string;
}

export interface CourierLookupDeps {
  getDb?: () => ReturnType<typeof getDb>;
  getProvider?: () => DeliveryProvider;
}

/**
 * Read-only lookup of an uncertain submission at the courier (Sendit).
 * Never mutates the database. Resolution still requires explicit agent action.
 */
export async function lookupSubmissionAtCourier(
  submissionId: string,
  deps: CourierLookupDeps = {},
): Promise<LookupResult> {
  const db = (deps.getDb ?? getDb)();
  const provider = (deps.getProvider ?? getProvider)();

  const submission = db
    .prepare("SELECT id, order_id, status, payload_json FROM courier_submissions WHERE id = ?")
    .get(submissionId) as SubmissionLookupRow | undefined;

  if (!submission) {
    throw new LookupError(404, "Soumission introuvable.");
  }

  if (submission.status !== "needs_review" && submission.status !== "failed") {
    throw new LookupError(
      409,
      "Seules les soumissions « À vérifier » ou « Échec » peuvent faire l'objet d'une recherche.",
    );
  }

  const order = db
    .prepare("SELECT id, customer_phone FROM orders WHERE id = ?")
    .get(submission.order_id) as OrderLookupRow | undefined;

  if (!order) {
    throw new LookupError(404, "Commande introuvable.");
  }

  if (!provider.capabilities.parcelLookup || typeof provider.findParcelByReference !== "function") {
    throw new LookupError(
      409,
      "Ce transporteur ne permet pas la recherche de colis par référence.",
    );
  }

  let snapshot: { courier_reference?: string; customer_phone?: string } | null = null;
  if (submission.payload_json) {
    try {
      snapshot = JSON.parse(submission.payload_json);
    } catch {
      // Ignore parse failure; fall back to order row and courierReference()
    }
  }

  const reference = snapshot?.courier_reference ?? courierReference(submission.order_id);
  const rawPhone = snapshot?.customer_phone ?? order.customer_phone;
  const phone = toLocalPhone(rawPhone ?? "");

  let lookup: ParcelLookupResult;
  try {
    lookup = await provider.findParcelByReference(reference, phone);
  } catch (err) {
    if (err instanceof ProviderError) {
      const message = redactText(err.message) || "Erreur du transporteur lors de la recherche.";
      log.info("courier.lookup", { submissionId, status: "inconclusive" });
      return {
        status: "inconclusive",
        reference,
        message,
      };
    }
    throw err;
  }

  let result: LookupResult;
  if (lookup.parcel) {
    const rawStatus = lookup.parcel.rawStatus;
    const statusLabel =
      provider.profile === "sendit" && rawStatus
        ? SENDIT_STATUS_LABELS[rawStatus] ??
          SENDIT_STATUS_LABELS[rawStatus.toUpperCase()] ??
          null
        : null;

    result = {
      status: "found",
      trackingNumber: lookup.parcel.trackingNumber,
      rawStatus,
      statusLabel,
      reference,
    };
  } else if (lookup.complete) {
    result = {
      status: "not_found",
      reference,
    };
  } else {
    result = {
      status: "inconclusive",
      reference,
      message: "Recherche incomplète — vérifiez sur le portail.",
    };
  }

  log.info("courier.lookup", { submissionId, status: result.status });
  return result;
}
