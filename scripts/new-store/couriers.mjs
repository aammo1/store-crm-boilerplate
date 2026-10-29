// Mirror of src/lib/shipping/couriers.ts (checked by scripts/unit/new-store-env.test.mjs).
export const WIZARD_COURIERS = {
  ozon: { label: "Ozon Express", requiredEnv: ["OZON_CLIENT_ID", "OZON_API_KEY"] },
  sendit: { label: "Sendit", requiredEnv: ["SENDIT_PUBLIC_KEY", "SENDIT_SECRET_KEY"] },
};
