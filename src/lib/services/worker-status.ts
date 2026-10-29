import { getAppState, setAppState } from "@/lib/services/app-state";
import { redactText } from "@/lib/shipping/redact";

export type WorkerName = "submission" | "tracking" | "meta" | "tiktok" | "whatsapp";

export interface WorkerStatus {
  lastTickAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveErrors: number;
}

export const TICK_WRITE_THROTTLE_MS = 15_000;
/** Ticks are persisted at most every 15 s, so never call a worker stale before this. */
export const MIN_STALE_MS = 3 * TICK_WRITE_THROTTLE_MS;
export const ERROR_DEGRADED_THRESHOLD = 5;
const MAX_ERROR_CHARS = 300;

const key = (name: WorkerName): string => `worker_status:${name}`;
const EMPTY: WorkerStatus = { lastTickAt: null, lastErrorAt: null, lastError: null, consecutiveErrors: 0 };

type Globals = { __crmWorkerStatus?: Map<WorkerName, WorkerStatus & { lastWriteAt: number }> };
function cache(): NonNullable<Globals["__crmWorkerStatus"]> {
  const g = globalThis as Globals;
  return (g.__crmWorkerStatus ??= new Map());
}

export function readWorkerStatus(name: WorkerName): WorkerStatus {
  try {
    const raw = getAppState(key(name));
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<WorkerStatus>;
    return {
      lastTickAt: typeof parsed.lastTickAt === "string" ? parsed.lastTickAt : null,
      lastErrorAt: typeof parsed.lastErrorAt === "string" ? parsed.lastErrorAt : null,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
      consecutiveErrors: Number.isInteger(parsed.consecutiveErrors) ? (parsed.consecutiveErrors as number) : 0,
    };
  } catch {
    return { ...EMPTY };
  }
}

function persist(name: WorkerName, status: WorkerStatus, now: number): void {
  cache().set(name, { ...status, lastWriteAt: now });
  setAppState(key(name), JSON.stringify(status));
}

function current(name: WorkerName): WorkerStatus {
  const cached = cache().get(name);
  return cached ?? readWorkerStatus(name);
}

/** Records a loop pass. DB writes are throttled; never throws (health signal only). */
export function recordWorkerTick(name: WorkerName, now: number = Date.now()): void {
  try {
    const cached = cache().get(name);
    if (cached && now - cached.lastWriteAt < TICK_WRITE_THROTTLE_MS) return;
    const prev = current(name);
    persist(name, { ...prev, lastTickAt: new Date(now).toISOString(), consecutiveErrors: 0 }, now);
  } catch {
    // Health signal only.
  }
}

export function redactedErrorMessage(err: unknown): string {
  const text = redactText(err instanceof Error ? err.message : String(err));
  return text.length > MAX_ERROR_CHARS ? text.slice(0, MAX_ERROR_CHARS) : text;
}

/** Records a worker failure (always written). Never throws. */
export function recordWorkerError(name: WorkerName, err: unknown, now: number = Date.now()): void {
  try {
    const prev = current(name);
    persist(
      name,
      {
        ...prev,
        lastErrorAt: new Date(now).toISOString(),
        lastError: redactedErrorMessage(err),
        consecutiveErrors: prev.consecutiveErrors + 1,
      },
      now,
    );
  } catch {
    // Health signal only.
  }
}

/** Stale = enabled and silent for more than 3 intervals (floored by the write throttle). */
export function isWorkerStale(
  enabled: boolean,
  lastTickAt: string | null,
  intervalMs: number,
  now: number = Date.now(),
): boolean {
  if (!enabled || !lastTickAt) return false;
  const last = Date.parse(lastTickAt);
  if (!Number.isFinite(last)) return false;
  return now - last > Math.max(3 * intervalMs, MIN_STALE_MS);
}

export function overallStatus(
  workers: Array<{ enabled: boolean; stale: boolean; consecutiveErrors: number }>,
): "ok" | "degraded" {
  return workers.some((w) => w.enabled && (w.stale || w.consecutiveErrors >= ERROR_DEGRADED_THRESHOLD))
    ? "degraded"
    : "ok";
}
