export type CourierName = "ozon" | "sendit";

export interface LabelFormat {
  id: string;
  label: string;
}

export interface CourierCapabilities {
  /** Ozon-style BL: create → attach → save, and handoff requires a saved BL. */
  deliveryNotes: boolean;
  /** Courier can return printable parcel labels for a set of tracking codes. */
  labels: boolean;
  labelFormats: LabelFormat[];
  /** Read-only lookup of an existing parcel by our reference (+ phone). */
  parcelLookup: boolean;
  /** One request can track many codes (Ozon). False = one request per code. */
  bulkTracking: boolean;
  /** Courier requires a merchant pickup district chosen in CRM settings. */
  pickupDistrict: boolean;
}

export interface CourierDefinition {
  name: CourierName;
  /** French display name used in CRM copy ("portail {label}"). */
  label: string;
  portalUrl: string;
  capabilities: CourierCapabilities;
  /** Env vars required when DELIVERY_PROVIDER selects this courier in production. */
  requiredEnv: string[];
  /** Env vars whose values must be redacted anywhere they could leak. */
  secretEnv: string[];
}

export const COURIERS: Record<CourierName, CourierDefinition> = {
  ozon: {
    name: "ozon",
    label: "Ozon Express",
    portalUrl: "https://client.ozoneexpress.ma",
    capabilities: {
      deliveryNotes: true,
      labels: false, // Ozon labels come from the BL PDF formats, not a per-parcel endpoint
      labelFormats: [],
      parcelLookup: false,
      bulkTracking: true,
      pickupDistrict: false,
    },
    requiredEnv: ["OZON_CLIENT_ID", "OZON_API_KEY"],
    secretEnv: ["OZON_CLIENT_ID", "OZON_API_KEY"],
  },
  sendit: {
    name: "sendit",
    label: "Sendit",
    portalUrl: "https://app.sendit.ma",
    capabilities: {
      deliveryNotes: false,
      labels: true,
      labelFormats: [{ id: "10x10", label: "Étiquettes 10×10" }],
      parcelLookup: true,
      bulkTracking: false,
      pickupDistrict: true,
    },
    requiredEnv: ["SENDIT_PUBLIC_KEY", "SENDIT_SECRET_KEY"],
    secretEnv: ["SENDIT_PUBLIC_KEY", "SENDIT_SECRET_KEY"],
  },
};

export const COURIER_NAMES = Object.keys(COURIERS) as CourierName[];

export function courierDefinition(name: CourierName): CourierDefinition {
  return COURIERS[name];
}
