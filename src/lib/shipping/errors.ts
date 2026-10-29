export type ProviderErrorKind = "retryable" | "permanent" | "unknown" | "throttled";

/**
 * The only error type that crosses the provider boundary. Workers branch on
 * `kind` only — never on courier response shapes. Messages must already be
 * safe to log (URLs/credentials redacted via redactUrl()/redactSecrets()).
 *
 * `throttled` = the courier explicitly refused to process the request (e.g.
 * HTTP 429) or the request never left (login failed first) and nothing was
 * created; only adapters that can guarantee this may raise it.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryAfterSec?: number;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options?: { cause?: unknown; retryAfterSec?: number },
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    if (options && options.cause !== undefined) this.cause = options.cause;
    if (options && options.retryAfterSec !== undefined) this.retryAfterSec = options.retryAfterSec;
  }
}
