import crypto from "node:crypto";

const secret = () => crypto.randomBytes(32).toString("base64url");
const q = (v) => `"${String(v).replace(/(["\\$`])/g, "\\$1")}"`;

export const PRODUCTION_ENV_HEADER = `# Coller dans Coolify → Environment Variables. Ne pas committer.
# OBLIGATOIRE : renseigner SECURITY_TRUSTED_IP_HEADER (ex. X-Forwarded-For, uniquement
# derrière un proxy vérifié qui écrase cet en-tête) OU mettre SECURITY_ACCEPT_GLOBAL_BUDGETS=1
# pour accepter des budgets globaux sans IP client. Sinon le démarrage en production échoue.
# Si les clés du transporteur ont été ignorées, DELIVERY_PROVIDER vaut "mock" au départ : passez-le à "ozon" ou "sendit" uniquement après avoir renseigné ses clés (OZON_CLIENT_ID/OZON_API_KEY ou SENDIT_PUBLIC_KEY/SENDIT_SECRET_KEY). Sendit : choisissez ensuite le district de ramassage dans CRM → Paramètres.
`;

export function envText(values, header) {
  return `${header}${Object.entries(values).map(([k, v]) => `${k}=${q(v)}`).join("\n")}\n`;
}

export function envValues(a, { production, catalogAgentKey } = {}) {
  const origin = production ? a.domain : "http://localhost:3000";
  const courier = a.courier === "sendit" ? "sendit" : "ozon";
  const creds =
    courier === "sendit"
      ? Boolean(a.senditPublicKey && a.senditSecretKey)
      : Boolean(a.ozonClientId && a.ozonApiKey);
  return {
    DB_PATH: production ? "/app/data/crm.db" : "./data/crm.db",
    UPLOAD_DIR: production ? "/app/data/uploads" : "./data/uploads",
    AUTH_SECRET: secret(),
    STOREFRONT_API_KEY: secret(),
    CATALOG_AGENT_KEY: catalogAgentKey || secret(),
    CRM_PUBLIC_URL: origin,
    SECURITY_ALLOWED_ORIGINS: origin,
    DELIVERY_PROVIDER: production && creds ? courier : "mock",
    MOCK_COURIER_PROFILE: courier,
    ...(courier === "ozon"
      ? {
          OZON_CLIENT_ID: a.ozonClientId || "",
          OZON_API_KEY: a.ozonApiKey || "",
          OZON_BASE_URL: "https://api.ozonexpress.ma",
        }
      : {
          SENDIT_PUBLIC_KEY: a.senditPublicKey || "",
          SENDIT_SECRET_KEY: a.senditSecretKey || "",
        }),
    ...(production ? { SECURITY_TRUSTED_IP_HEADER: "", SECURITY_ACCEPT_GLOBAL_BUDGETS: "" } : {}),
    FACEBOOK_PIXEL_ID: a.metaPixelId,
    FACEBOOK_ACCESS_TOKEN: a.metaAccessToken,
    TIKTOK_PIXEL_ID: a.tiktokPixelId,
    TIKTOK_ACCESS_TOKEN: a.tiktokAccessToken,
  };
}
