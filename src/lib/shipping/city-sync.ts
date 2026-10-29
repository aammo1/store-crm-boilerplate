import { getDb } from "@/lib/db";
import { getProvider } from "./index";
import type { DeliveryProvider } from "./provider";

export async function syncCities(provider: DeliveryProvider = getProvider()): Promise<number> {
  const cities = await provider.listCities();
  const now = new Date().toISOString();
  const db = getDb();
  const upsert = db.prepare(`INSERT INTO cities (id, name, updated_at, provider, arabic_name, is_pickup)
    VALUES (@id, @name, @now, @provider, @arabic, @pickup)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at,
      provider = excluded.provider, arabic_name = excluded.arabic_name, is_pickup = excluded.is_pickup`);
  const prefill = db.prepare(`INSERT INTO city_tariffs (city_id, courier_cost, override_ignores_free_threshold, updated_by, updated_at)
    VALUES (?, ?, 0, NULL, ?) ON CONFLICT(city_id) DO NOTHING`);
  db.transaction(() => {
    for (const c of cities) {
      upsert.run({ id: c.id, name: c.name, now, provider: provider.name, arabic: c.arabicName ?? null, pickup: c.pickup ? 1 : 0 });
      if (typeof c.priceMad === "number" && Number.isInteger(c.priceMad) && c.priceMad >= 0) prefill.run(c.id, c.priceMad, now);
    }
  })();
  return cities.length;
}
