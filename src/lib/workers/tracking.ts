import { pollIntervalMs, pollOnce } from "@/lib/services/tracking";
import { log } from "@/lib/log";
import { recordWorkerError, recordWorkerTick } from "@/lib/services/worker-status";

/**
 * Tracking poller (task-14): one pass on boot, then every
 * OZON_POLL_INTERVAL_MIN minutes (default 30, floor 5). Ticks are serialized —
 * a tick is skipped if the previous poll is still running, so bulk calls never
 * overlap. All polling logic lives in services/tracking.ts (timer-free).
 */
export function startTrackingWorker(): void {
  const g = globalThis as {
    __crmTrackingWorker?: NodeJS.Timeout;
    __crmTrackingRunning?: boolean;
  };
  if (g.__crmTrackingWorker) return;

  if (process.env.DELIVERY_PROVIDER === "mock") {
    log.info("tracking.mock_provider", { detail: "aucun appel réel au transporteur" });
  }

  const tick = async (): Promise<void> => {
    if (g.__crmTrackingRunning) {
      log.warn("tracking.tick_skipped", { detail: "sondage précédent encore en cours" });
      return;
    }
    g.__crmTrackingRunning = true;
    try {
      await pollOnce();
      recordWorkerTick("tracking");
    } catch (err) {
      log.error("tracking.poll_failed", { error: err });
      recordWorkerError("tracking", err);
    } finally {
      g.__crmTrackingRunning = false;
    }
  };

  void tick();
  g.__crmTrackingWorker = setInterval(() => void tick(), pollIntervalMs());
}
