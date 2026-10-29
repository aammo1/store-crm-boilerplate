// Ozon credentials (client id + API key) live inside the URL path
// (/customers/{ID}/{KEY}/{operation}) — see docs/operations.md. They must
// never reach logs, thrown errors or browser bundles: anything that may carry
// an Ozon URL passes through redactUrl()/redactText() first.

const CUSTOMER_PATH_RE = /\/customers\/[^/?#\s]*\/[^/?#\s]*/gi;
const QUERY_SECRET_RE =
  /([?&](?:api[_-]?key|apikey|key|token|secret|password|authorization|public_key|secret_key)=)[^&#\s]+/gi;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const JSON_SECRET_RE = /("(?:public_key|secret_key|token|access_token)"\s*:\s*")[^"]*"/gi;

/** Replaces the credential-bearing /customers/{ID}/{KEY} segments with *** . */
export function redactUrl(url: unknown): string {
  if (typeof url !== "string") return "[url]";
  return url
    .replace(CUSTOMER_PATH_RE, "/customers/***/***")
    .replace(QUERY_SECRET_RE, "$1***")
    .replace(BEARER_RE, "$1***")
    .replace(JSON_SECRET_RE, '$1***"');
}

/** Best-effort scrub for free-form text (error strings, log lines). */
export function redactText(text: string): string {
  if (typeof text !== "string") return "";
  return redactUrl(text);
}

/** Replaces literal secret values (client id, API key) inside free-form text. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.replace(new RegExp(escapeRegExp(secret), "gi"), "***");
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
