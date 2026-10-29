import type { CourierCapabilities, CourierName } from "./couriers";

export interface City {
  id: number;
  name: string;
  arabicName?: string | null;
  /** Courier allows this city/district as merchant pickup (Sendit). */
  pickup?: boolean;
  /** Courier's own delivery price, integer MAD, when the courier publishes it. */
  priceMad?: number | null;
}

export interface ParcelItem {
  name: string;
  options: { name: string; value: string }[];
  quantity: number;
  sku: string | null;
}

/** Courier-neutral parcel request built from the frozen payload snapshot. */
export interface ParcelRequest {
  /** Per-store unique reference "<slug>-<orderId>" — stable across retries. */
  reference: string;
  orderId: string;
  receiver: string;
  /** Local Moroccan format 0[5-7]XXXXXXXX. Adapters re-validate. */
  phoneLocal: string;
  cityId: number;
  cityName: string | null;
  address: string;
  /** Final COD amount, integer MAD. */
  codAmountMad: number;
  /** Human shipment description (shipmentDescription(items)). */
  description: string;
  items: ParcelItem[];
  /** Backward-compatible alias for description during migration */
  nature?: string;
  /** Backward-compatible alias for codAmountMad during migration */
  priceMad?: number;
}

export interface LabelsPdf {
  url: string;
} // https URL fetched server-side, or mock:// placeholder

export interface ParcelLookupResult {
  /** false = search could not finish; absence proves nothing. */
  complete: boolean;
  parcel: { trackingNumber: string; rawStatus: string | null } | null;
}

export interface CreateParcelResult {
  trackingNumber: string;
  raw: unknown;
}

export interface ParcelInfoResult {
  raw: unknown;
  trackingNumber?: string;
}

export interface TrackingResult {
  trackingNumber: string;
  rawStatus: string | null;
  raw: unknown;
  found: boolean;
}

export interface DeliveryNoteHandles {
  ref: string;
}

export type PdfFormat = "standard" | "a4" | "tickets10x10";

/**
 * Courier abstraction. Business logic (submission worker, tracking poller)
 * only ever sees these typed results and ProviderError kinds — never raw
 * courier response shapes.
 */
export interface DeliveryProvider {
  readonly name: "mock" | CourierName;
  /** Courier behaviour this instance emulates/implements. */
  readonly profile: CourierName;
  readonly capabilities: CourierCapabilities;
  isConfigured?(): boolean;
  /** French reasons why jobs cannot be sent yet (missing keys, pickup district…). */
  configurationIssues?(): string[];
  listCities(): Promise<City[]>;
  createParcel(input: ParcelRequest): Promise<CreateParcelResult>;
  getParcelInfo(trackingNumber: string): Promise<ParcelInfoResult>;
  /** Caller decides batch size; the implementation sends one bulk JSON request (or concurrent requests if bulk is unsupported). */
  track(trackingNumbers: string[]): Promise<TrackingResult[]>;
  // BL (capabilities.deliveryNotes). Couriers without BL throw ProviderError("permanent", "BL non pris en charge par ce transporteur").
  createDeliveryNote(): Promise<DeliveryNoteHandles>;
  addParcelsToDeliveryNote(ref: string, codes: string[]): Promise<void>;
  saveDeliveryNote(ref: string): Promise<void>;
  /** Built server-side only — never shipped to the client bundle. */
  deliveryNotePdfUrl(ref: string, format: PdfFormat): string;
  /** capabilities.labels */
  getLabelsPdf?(trackingNumbers: string[], format: string): Promise<LabelsPdf>;
  /** capabilities.parcelLookup — read-only. */
  findParcelByReference?(reference: string, phoneLocal: string): Promise<ParcelLookupResult>;
  /** Cheap authenticated call for the health card; throws ProviderError on failure. */
  testConnection?(): Promise<void>;
}
