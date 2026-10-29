import { getDb } from "@/lib/db";
import { deliveryProviderName } from "@/lib/env";
import { getAppState } from "@/lib/services/app-state";

export const DEFAULT_COURIER_COST_KEY = "default_courier_cost";

export class CityTariffError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message);
    this.name = "CityTariffError";
  }
}

export interface CityTariff {
  cityId: number;
  cityName: string;
  courierCost: number | null;
  customerFeeOverride: number | null;
  overrideIgnoresFreeThreshold: boolean;
  updatedAt: string | null;
}

export interface CityTariffInput {
  cityId: number;
  courierCost: number | null;
  customerFeeOverride: number | null;
  overrideIgnoresFreeThreshold: boolean;
}

interface Row {
  city_id: number; city_name: string; courier_cost: number | null; customer_fee_override: number | null;
  override_ignores_free_threshold: number | null; updated_at: string | null;
}

const toTariff = (r: Row): CityTariff => ({
  cityId: r.city_id, cityName: r.city_name, courierCost: r.courier_cost,
  customerFeeOverride: r.customer_fee_override,
  overrideIgnoresFreeThreshold: r.override_ignores_free_threshold === 1, updatedAt: r.updated_at,
});

function assertCost(value: number | null, label: string) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000)) {
    throw new CityTariffError(400, `${label} : entier MAD positif ou nul requis.`);
  }
}

/**
 * Cities of the active courier, with their tariff when one exists; tariff rows
 * already saved for another courier's cities stay listed. Admin data: never
 * expose to the storefront.
 */
export function listCityTariffs(): CityTariff[] {
  return (getDb().prepare(`SELECT c.id AS city_id, c.name AS city_name, t.courier_cost, t.customer_fee_override,
      t.override_ignores_free_threshold, t.updated_at
    FROM cities c LEFT JOIN city_tariffs t ON t.city_id = c.id
    WHERE c.provider = ? OR t.city_id IS NOT NULL
    ORDER BY c.name COLLATE NOCASE ASC`).all(deliveryProviderName()) as Row[]).map(toTariff);
}

export function getCityTariff(cityId: number): CityTariff | null {
  const row = getDb().prepare(`SELECT c.id AS city_id, c.name AS city_name, t.courier_cost, t.customer_fee_override,
      t.override_ignores_free_threshold, t.updated_at
    FROM cities c LEFT JOIN city_tariffs t ON t.city_id = c.id WHERE c.id = ?`).get(cityId) as Row | undefined;
  return row ? toTariff(row) : null;
}

/** Courier cost for cities without an explicit cost; null when unset. */
export function defaultCourierCost(): number | null {
  const raw = getAppState(DEFAULT_COURIER_COST_KEY);
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function setDefaultCourierCost(value: number | null): void {
  assertCost(value, "Coût par défaut");
  const db = getDb();
  if (value === null) db.prepare("DELETE FROM app_state WHERE key = ?").run(DEFAULT_COURIER_COST_KEY);
  else db.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(DEFAULT_COURIER_COST_KEY, String(value));
}

/** Effective courier cost for a city: explicit cost, else the default (null when neither). */
export function courierCostFor(cityId: number | null): number | null {
  const tariff = cityId === null ? null : getCityTariff(cityId);
  return tariff?.courierCost ?? defaultCourierCost();
}

function writeTariff(input: CityTariffInput, actorId: string, now: string) {
  assertCost(input.courierCost, "Coût livreur");
  assertCost(input.customerFeeOverride, "Frais client");
  if (!getDb().prepare(`SELECT 1 FROM cities c WHERE c.id = ?
      AND (c.provider = ? OR EXISTS (SELECT 1 FROM city_tariffs t WHERE t.city_id = c.id))`)
    .get(input.cityId, deliveryProviderName())) {
    throw new CityTariffError(404, `Ville introuvable (${input.cityId}).`);
  }
  if (input.courierCost === null && input.customerFeeOverride === null) {
    getDb().prepare("DELETE FROM city_tariffs WHERE city_id = ?").run(input.cityId);
    return;
  }
  getDb().prepare(`INSERT INTO city_tariffs (city_id, courier_cost, customer_fee_override, override_ignores_free_threshold, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(city_id) DO UPDATE SET courier_cost = excluded.courier_cost,
      customer_fee_override = excluded.customer_fee_override,
      override_ignores_free_threshold = excluded.override_ignores_free_threshold,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(
    input.cityId, input.courierCost, input.customerFeeOverride,
    input.customerFeeOverride !== null && input.overrideIgnoresFreeThreshold ? 1 : 0, actorId, now);
}

export function upsertCityTariff(input: CityTariffInput, actorId: string): CityTariff {
  getDb().transaction(() => writeTariff(input, actorId, new Date().toISOString()))();
  return getCityTariff(input.cityId)!;
}

/** All-or-nothing bulk upsert (CSV paste). */
export function upsertCityTariffs(inputs: CityTariffInput[], actorId: string): number {
  const now = new Date().toISOString();
  getDb().transaction(() => { for (const input of inputs) writeTariff(input, actorId, now); })();
  return inputs.length;
}
