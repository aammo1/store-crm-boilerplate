import { getDb } from "@/lib/db";
import { deliveryProviderName } from "@/lib/env";
import { getAppState, setAppState } from "@/lib/services/app-state";
import {
  DEFAULT_COURIER_SETTINGS,
  courierSettingsSchema,
  courierSettingsUpdateSchema,
  type CourierSettings,
} from "@/lib/courier-settings-schema";

export const COURIER_SETTINGS_KEY = "courier_settings";

export class CourierSettingsError extends Error {
  readonly status: number;

  constructor(messageOrStatus: string | number, statusOrMessage: number | string = 400) {
    let message: string;
    let status = 400;
    if (typeof messageOrStatus === "number") {
      status = messageOrStatus;
      message = typeof statusOrMessage === "string" ? statusOrMessage : "";
    } else {
      message = messageOrStatus;
      if (typeof statusOrMessage === "number") {
        status = statusOrMessage;
      }
    }
    super(message);
    this.name = "CourierSettingsError";
    this.status = status;
  }
}

/**
 * Returns the current courier settings from app_state, or defaults if not yet set.
 * Corrupt JSON or schema mismatches fail closed by throwing.
 * No boot-time writes are made if state is missing.
 */
export function getCourierSettings(): CourierSettings {
  const value = getAppState(COURIER_SETTINGS_KEY);
  if (value === null) {
    return { ...DEFAULT_COURIER_SETTINGS };
  }
  return courierSettingsSchema.parse(JSON.parse(value));
}

/**
 * List pickup-capable districts for the given provider, sorted by name.
 */
export function listPickupDistricts(provider: string): Array<{ id: number; name: string }> {
  return getDb()
    .prepare("SELECT id, name FROM cities WHERE provider = ? AND is_pickup = 1 ORDER BY name")
    .all(provider) as Array<{ id: number; name: string }>;
}

/**
 * Validated partial update merged with current settings in an immediate transaction.
 * When senditPickupDistrictId is a number, it must exist in cities with is_pickup = 1
 * for the active delivery provider.
 */
export function updateCourierSettings(input: unknown): CourierSettings {
  const update = courierSettingsUpdateSchema.parse(input);
  return getDb().transaction(() => {
    const current = getCourierSettings();
    const merged = courierSettingsSchema.parse({ ...current, ...update });
    if (typeof merged.senditPickupDistrictId === "number") {
      const row = getDb()
        .prepare("SELECT 1 FROM cities WHERE id = ? AND provider = ? AND is_pickup = 1")
        .get(merged.senditPickupDistrictId, deliveryProviderName());
      if (!row) {
        throw new CourierSettingsError(
          "District de ramassage inconnu — synchronisez les villes puis choisissez un district de ramassage.",
          400,
        );
      }
    }
    setAppState(COURIER_SETTINGS_KEY, JSON.stringify(merged));
    return merged;
  }).immediate();
}
