import { COURIERS, type CourierName } from "./couriers";
import { ProviderError } from "./errors";
import type {
  City,
  CreateParcelResult,
  DeliveryNoteHandles,
  DeliveryProvider,
  LabelsPdf,
  ParcelInfoResult,
  ParcelLookupResult,
  ParcelRequest,
  PdfFormat,
  TrackingResult,
} from "./provider";

/**
 * Deterministic in-memory provider for scratch tests (tasks 09/14/15).
 * Status values are fake and never reach real couriers.
 *
 * `trackingStatuses` (and setTrackingStatus) let tests choose the raw status
 * each code reports from track() — default remains "MOCK_CREATED" for Ozon
 * and "PENDING" for Sendit. Codes must be registered via createParcel();
 * setTrackingStatus only overrides the status their track() entry reports.
 *
 * In the running app a single shared instance per profile is used (see getProvider in
 * ./index.ts); this factory stays instantiable for isolated tests.
 */
export interface MockProviderOptions {
  profile?: CourierName;
  trackingStatuses?: Map<string, string>;
}

export type MockProvider = DeliveryProvider & {
  setTrackingStatus(trackingNumber: string, status: string): void;
};

export function createMockProvider(options: MockProviderOptions = {}): MockProvider {
  const profile: CourierName = options.profile ?? "ozon";
  const capabilities = COURIERS[profile].capabilities;
  const trackingStatuses = options.trackingStatuses ?? new Map<string, string>();
  const cities: City[] =
    profile === "sendit"
      ? [
          { id: 1, name: "Casablanca", arabicName: "الدار البيضاء", pickup: true, priceMad: 20 },
          { id: 2, name: "Rabat", arabicName: "الرباط", pickup: false, priceMad: 35 },
          { id: 3, name: "Marrakech", arabicName: "مراكش", pickup: false, priceMad: 35 },
          { id: 4, name: "Fès", arabicName: "فاس", pickup: false, priceMad: 35 },
          { id: 5, name: "Agadir", arabicName: "أكادير", pickup: false, priceMad: 40 },
        ]
      : [
          { id: 1, name: "Casablanca" },
          { id: 2, name: "Rabat" },
          { id: 3, name: "Marrakech" },
          { id: 4, name: "Fès" },
          { id: 5, name: "Agadir" },
        ];

  const parcels = new Map<string, ParcelRequest>();
  const referenceToCode = new Map<string, string>();
  const notes = new Map<string, { codes: string[]; saved: boolean }>();
  // Per-instance boot id keeps generated numbers unique across process
  // restarts (the sequence alone restarts at 1 and would collide with codes
  // already stored in the database).
  const bootId = Date.now().toString(36).toUpperCase();
  let parcelSeq = 0;
  let noteSeq = 0;

  return {
    name: "mock" as const,
    profile,
    capabilities,
    isConfigured(): boolean {
      return true;
    },
    configurationIssues(): string[] {
      return [];
    },
    async testConnection(): Promise<void> {},
    async listCities(): Promise<City[]> {
      return cities.map((city) => ({ ...city }));
    },
    async createParcel(input: ParcelRequest): Promise<CreateParcelResult> {
      parcelSeq += 1;
      const prefix = profile === "sendit" ? "SNDMOCK" : "OZEMOCK";
      const trackingNumber = `${prefix}${bootId}${String(parcelSeq).padStart(9, "0")}`;
      parcels.set(trackingNumber, input);
      if (input.reference) referenceToCode.set(input.reference, trackingNumber);
      const price = input.codAmountMad ?? 0;
      return {
        trackingNumber,
        raw: {
          "TRACKING-NUMBER": trackingNumber,
          RECEIVER: input.receiver,
          PRICE: String(price),
        },
      };
    },
    async getParcelInfo(trackingNumber: string): Promise<ParcelInfoResult> {
      const input = parcels.get(trackingNumber);
      if (!input) return { raw: null };
      const price = input.codAmountMad ?? 0;
      return {
        raw: {
          "TRACKING-NUMBER": trackingNumber,
          RECEIVER: input.receiver,
          PRICE: String(price),
        },
        trackingNumber,
      };
    },
    async track(trackingNumbers: string[]): Promise<TrackingResult[]> {
      return trackingNumbers.map((trackingNumber) => {
        // Codes minted by an earlier process are still known to this stateless
        // mock (its in-memory registry does not survive restarts).
        const found =
          parcels.has(trackingNumber) ||
          trackingNumber.startsWith("OZEMOCK") ||
          trackingNumber.startsWith("SNDMOCK");
        const defaultStatus =
          trackingNumber.startsWith("SNDMOCK")
            ? "PENDING"
            : trackingNumber.startsWith("OZEMOCK")
            ? "MOCK_CREATED"
            : profile === "sendit"
            ? "PENDING"
            : "MOCK_CREATED";
        const status = trackingStatuses.get(trackingNumber) ?? defaultStatus;
        return {
          trackingNumber,
          rawStatus: found ? status : null,
          raw: found ? { status } : null,
          found,
        };
      });
    },
    setTrackingStatus(trackingNumber: string, status: string): void {
      trackingStatuses.set(trackingNumber, status);
    },
    async createDeliveryNote(): Promise<DeliveryNoteHandles> {
      if (profile === "sendit") {
        throw new ProviderError("permanent", "BL non pris en charge par ce transporteur");
      }
      noteSeq += 1;
      const ref = `BLMOCK${bootId}${String(noteSeq).padStart(6, "0")}`;
      notes.set(ref, { codes: [], saved: false });
      return { ref };
    },
    async addParcelsToDeliveryNote(ref: string, codes: string[]): Promise<void> {
      if (profile === "sendit") {
        throw new ProviderError("permanent", "BL non pris en charge par ce transporteur");
      }
      const note = notes.get(ref);
      if (note) note.codes.push(...codes);
    },
    async saveDeliveryNote(ref: string): Promise<void> {
      if (profile === "sendit") {
        throw new ProviderError("permanent", "BL non pris en charge par ce transporteur");
      }
      const note = notes.get(ref);
      if (note) note.saved = true;
    },
    deliveryNotePdfUrl(ref: string, format: PdfFormat): string {
      if (profile === "sendit") {
        return "mock://pdf/unsupported";
      }
      return `mock://pdf/${format}/${encodeURIComponent(ref)}`;
    },
    async getLabelsPdf(trackingNumbers: string[], format: string): Promise<LabelsPdf> {
      return { url: `mock://labels/${format}/${trackingNumbers.length}` };
    },
    async findParcelByReference(reference: string): Promise<ParcelLookupResult> {
      const trackingNumber = referenceToCode.get(reference);
      if (!trackingNumber) return { complete: true, parcel: null };
      const defaultStatus = profile === "sendit" ? "PENDING" : "MOCK_CREATED";
      const rawStatus = trackingStatuses.get(trackingNumber) ?? defaultStatus;
      return { complete: true, parcel: { trackingNumber, rawStatus } };
    },
  };
}
