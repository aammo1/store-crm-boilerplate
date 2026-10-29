import { ProviderError } from "@/lib/shipping/errors";
import { getProvider } from "@/lib/shipping";
import { syncCities } from "@/lib/shipping/city-sync";
import { log } from "@/lib/log";
import { recordWorkerError } from "@/lib/services/worker-status";
import {
  acquireWorkerLease,
  heartbeatWorkerLease,
  releaseWorkerLease,
} from "@/lib/services/process-lease";
import { startSubmissionWorker } from "@/lib/workers/submission";
import { startTrackingWorker } from "@/lib/workers/tracking";
import { startMetaWorker } from "@/lib/workers/meta";
import { startTikTokWorker } from "@/lib/workers/tiktok";
import { startWhatsAppWorker } from "@/lib/workers/whatsapp";

const CITIES_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function refreshCitiesLoop(): Promise<void> {
  const run = async (): Promise<void> => {
    try {
      const count = await syncCities(getProvider());
      log.info("cities.sync_ok", { count });
    } catch (err) {
      // Non-fatal: retried on the next pass. log.error redacts the message.
      const kind = err instanceof ProviderError ? err.kind : "unknown";
      log.error("cities.sync_failed", { kind, error: err });
    }
  };
  const g = globalThis as { __crmCitiesTimer?: NodeJS.Timeout };
  g.__crmCitiesTimer = setInterval(() => void run(), CITIES_SYNC_INTERVAL_MS);
  await run();
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const RETRY_ACQUIRE_INTERVAL_MS = 60_000;

type WorkerGlobals = {
  __crmWorkersStarted?: boolean;
  __crmWorkerLeaseTimer?: NodeJS.Timeout;
  __crmLeaseRetryTimer?: NodeJS.Timeout;
  __crmLeaseHooks?: boolean;
  __crmCitiesTimer?: NodeJS.Timeout;
  __crmSubmissionWorker?: NodeJS.Timeout;
  __crmTrackingWorker?: NodeJS.Timeout;
  __crmMetaWorker?: NodeJS.Timeout;
  __crmTikTokWorker?: NodeJS.Timeout;
  __crmWhatsAppWorker?: NodeJS.Timeout;
  __crmWhatsAppMaintenance?: NodeJS.Timeout;
};

/** Clears every worker timer so a process that lost the lease stops working. */
export function stopWorkerTimers(): void {
  const g = globalThis as WorkerGlobals;
  for (const key of [
    "__crmSubmissionWorker",
    "__crmTrackingWorker",
    "__crmMetaWorker",
    "__crmTikTokWorker",
    "__crmWhatsAppWorker",
    "__crmWhatsAppMaintenance",
    "__crmCitiesTimer",
    "__crmWorkerLeaseTimer",
  ] as const) {
    if (g[key]) clearInterval(g[key]);
    delete g[key];
  }
}

function startAllWorkers(): void {
  // Isolated: one worker failing to boot must not silently disable the others.
  startSafely("submission", startSubmissionWorker);
  startSafely("tracking", startTrackingWorker);
  startSafely("meta", startMetaWorker);
  startSafely("tiktok", startTikTokWorker);
  startSafely("whatsapp", startWhatsAppWorker);
  void refreshCitiesLoop();
}

function scheduleRetry(): void {
  const g = globalThis as WorkerGlobals;
  if (g.__crmLeaseRetryTimer) return;
  g.__crmLeaseRetryTimer = setInterval(() => {
    try {
      tryBecomeOwner(false);
    } catch (err) {
      log.error("workers.lease_acquire_failed", { error: err });
    }
  }, RETRY_ACQUIRE_INTERVAL_MS);
  g.__crmLeaseRetryTimer.unref();
}

function tryBecomeOwner(first: boolean): void {
  const g = globalThis as WorkerGlobals;
  const { acquired, holder } = acquireWorkerLease();
  if (!acquired) {
    if (first) {
      log.warn("workers.lease_held_elsewhere", {
        pid: holder?.pid ?? null,
        host: holder?.hostname ?? null,
        detail: "workers non démarrés dans ce processus",
      });
    }
    scheduleRetry();
    return;
  }
  if (g.__crmLeaseRetryTimer) {
    clearInterval(g.__crmLeaseRetryTimer);
    delete g.__crmLeaseRetryTimer;
  }
  g.__crmWorkerLeaseTimer = setInterval(() => {
    let still = false;
    try {
      still = heartbeatWorkerLease();
    } catch (err) {
      // Transient DB error: keep going, the TTL protects against a long outage.
      log.error("workers.lease_heartbeat_failed", { error: err });
      return;
    }
    if (!still) {
      log.error("workers.lease_lost", { detail: "arrêt des workers dans ce processus" });
      stopWorkerTimers();
      scheduleRetry();
    }
  }, HEARTBEAT_INTERVAL_MS);
  g.__crmWorkerLeaseTimer.unref();
  installReleaseHooks();
  startAllWorkers();
}

function installReleaseHooks(): void {
  const g = globalThis as WorkerGlobals;
  if (g.__crmLeaseHooks) return;
  g.__crmLeaseHooks = true;
  const release = () => {
    try {
      releaseWorkerLease();
    } catch {
      // Best effort: the lease expires by TTL.
    }
  };
  process.on("beforeExit", release);
  process.on("exit", release);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      release();
      // Our listener suppressed the default exit; restore it if nobody else handles the signal.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
}

/** Idempotent workers entrypoint: workers run only in the process holding the DB lease. */
export function startWorkers(): void {
  const g = globalThis as WorkerGlobals;
  if (g.__crmWorkersStarted) return;
  g.__crmWorkersStarted = true;
  try {
    tryBecomeOwner(true);
  } catch (err) {
    log.error("workers.lease_acquire_failed", { error: err });
    scheduleRetry();
  }
}

function startSafely(name: string, start: () => void): void {
  try {
    start();
  } catch (err) {
    log.error("workers.start_failed", { worker: name, error: err });
    if (
      name === "submission" ||
      name === "tracking" ||
      name === "meta" ||
      name === "tiktok" ||
      name === "whatsapp"
    ) {
      recordWorkerError(name, err);
    }
  }
}

/** Which worker timers are registered in this process (consumed by /api/health). */
export function workerHealth(): {
  submission: { enabled: boolean };
  tracking: { enabled: boolean };
  meta: { enabled: boolean };
  tiktok: { enabled: boolean };
  whatsapp: { enabled: boolean };
} {
  const g = globalThis as {
    __crmSubmissionWorker?: NodeJS.Timeout;
    __crmTrackingWorker?: NodeJS.Timeout;
    __crmMetaWorker?: NodeJS.Timeout;
    __crmTikTokWorker?: NodeJS.Timeout;
    __crmWhatsAppWorker?: NodeJS.Timeout;
  };
  return {
    submission: { enabled: !!g.__crmSubmissionWorker },
    tracking: { enabled: !!g.__crmTrackingWorker },
    meta: { enabled: !!g.__crmMetaWorker },
    tiktok: { enabled: !!g.__crmTikTokWorker },
    whatsapp: { enabled: !!g.__crmWhatsAppWorker },
  };
}
