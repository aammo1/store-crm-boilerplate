import crypto from "node:crypto";

const secret = () => crypto.randomBytes(32).toString("base64url");
const q = (v) => `"${String(v).replace(/(["\\$`])/g, "\\$1")}"`;

export const PRODUCTION_ENV_HEADER = `# Coller dans Coolify → Environment Variables. Ne pas committer.
# OBLIGATOIRE : renseigner SECURITY_TRUSTED_IP_HEADER (ex. X-Forwarded-For, uniquement
# derrière un proxy vérifié qui écrase cet en-tête) OU mettre SECURITY_ACCEPT_GLOBAL_BUDGETS=1
# pour accepter des budgets globaux sans IP client. Sinon le démarrage en production échoue.
# Si Ozon a été ignoré dans l'assistant, DELIVERY_PROVIDER vaut "mock" au départ : passez-le
# à "ozon" uniquement après avoir renseigné OZON_CLIENT_ID et OZON_API_KEY.
`;

export function envText(values, header) {
  return `${header}${Object.entries(values).map(([k, v]) => `${k}=${q(v)}`).join("\n")}\n`;
}

export function envValues(a, { production, catalogAgentKey } = {}) {
  const origin = production ? a.domain : "http://localhost:3000";
  const hasOzon = Boolean(a.ozonClientId && a.ozonApiKey);
  return {
    DB_PATH: production ? "/app/data/crm.db" : "./data/crm.db",
    UPLOAD_DIR: production ? "/app/data/uploads" : "./data/uploads",
    AUTH_SECRET: secret(),
    STOREFRONT_API_KEY: secret(),
    CATALOG_AGENT_KEY: catalogAgentKey || secret(),
    CRM_PUBLIC_URL: origin,
    SECURITY_ALLOWED_ORIGINS: origin,
    DELIVERY_PROVIDER: production && hasOzon ? "ozon" : "mock",
    OZON_CLIENT_ID: a.ozonClientId,
    OZON_API_KEY: a.ozonApiKey,
    OZON_BASE_URL: "https://api.ozonexpress.ma",
    ...(production ? { SECURITY_TRUSTED_IP_HEADER: "", SECURITY_ACCEPT_GLOBAL_BUDGETS: "" } : {}),
    FACEBOOK_PIXEL_ID: a.metaPixelId,
    FACEBOOK_ACCESS_TOKEN: a.metaAccessToken,
    TIKTOK_PIXEL_ID: a.tiktokPixelId,
    TIKTOK_ACCESS_TOKEN: a.tiktokAccessToken,
  };
}
