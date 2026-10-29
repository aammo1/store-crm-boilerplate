import path from "node:path";
import { log } from "@/lib/log";
import { recordWorkerError, recordWorkerTick } from "@/lib/services/worker-status";
import { whatsappConfigured } from "@/lib/whatsapp/config";
import {
  getWhatsAppSender,
  WhatsAppError,
  type SendResult,
} from "@/lib/whatsapp/evolution";
import {
  claimNextOutbox,
  markOutboxFailed,
  markOutboxRetry,
  markOutboxSent,
  markOutboxUncertain,
  purgeOutbox,
  recoverStaleSending,
  cancelQueuedForPhone,
  type OutboxPurpose,
} from "@/lib/services/whatsapp-outbox";
import {
  claimNextInboundEvent,
  purgeInboundEvents,
  recoverStaleInbound,
} from "@/lib/services/whatsapp-inbound-events";
import { processInboundEvent } from "@/lib/whatsapp/inbound-processor";
import {
  autoReleaseStale,
  markNoWhatsapp,
} from "@/lib/services/whatsapp-conversations";
import {
  getWhatsAppSettings,
  setWhatsAppConnectionState,
} from "@/lib/services/whatsapp-settings";
import { purgeExpiredMedia } from "@/lib/whatsapp/media";

export const WA_TICK_MS = 2000;
export const WA_MAINTENANCE_MS = 5 * 60_000;
export const MAX_INBOUND_PER_TICK = 5;

let tickRunning = false;
let maintenanceRunning = false;

let sleepFn = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function __setSleepForTest(fn: ((ms: number) => Promise<void>) | null): void {
  sleepFn = fn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
}

export function __resetWhatsAppWorkerForTest(): void {
  tickRunning = false;
  maintenanceRunning = false;
  sleepFn = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const g = globalThis as {
    __crmWhatsAppWorker?: NodeJS.Timeout;
    __crmWhatsAppMaintenance?: NodeJS.Timeout;
  };
  if (g.__crmWhatsAppWorker) {
    clearInterval(g.__crmWhatsAppWorker);
    delete g.__crmWhatsAppWorker;
  }
  if (g.__crmWhatsAppMaintenance) {
    clearInterval(g.__crmWhatsAppMaintenance);
    delete g.__crmWhatsAppMaintenance;
  }
}

function guessImageMime(mediaRef: string | null | undefined): string {
  if (!mediaRef) return "image/jpeg";
  const ext = path.extname(mediaRef).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

function isTypingPurpose(purpose: OutboxPurpose): boolean {
  return (
    purpose === "ai_reply" ||
    purpose === "agent_reply" ||
    purpose === "strike_warning" ||
    purpose === "product_card"
  );
}

export async function waTick(now: Date = new Date()): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    // 1. Inbound: process up to MAX_INBOUND_PER_TICK events
    // Inbound is processed even when settings.enabled is false, so the inbox keeps recording.
    for (let i = 0; i < MAX_INBOUND_PER_TICK; i++) {
      const ev = claimNextInboundEvent(now);
      if (!ev) break;
      await processInboundEvent(ev);
    }

    // 2. Outbound: at most one paced outbox message
    const settings = getWhatsAppSettings();
    if (settings.enabled) {
      const sender = getWhatsAppSender();
      if (sender) {
        const row = claimNextOutbox(now);
        if (row) {
          const number = row.phone.replace("+", "");
          let sendStarted = false;
          try {
            // Typing simulation for interactive / conversational purposes
            if (isTypingPurpose(row.purpose)) {
              const bodyLen = (row.body ?? "").length;
              const clamped = Math.min(6000, Math.max(1200, bodyLen * 40));
              const d = clamped + Math.floor(Math.random() * 801);
              try {
                await sender.sendPresence(number, "composing", d);
              } catch {
                // Presence errors are ignored
              }
              await sleepFn(d);
            }

            let res: SendResult;
            if (row.kind === "image") {
              const mediaRef = row.mediaRef ?? "";
              const mimetype = guessImageMime(mediaRef);
              const fileName = mediaRef ? path.basename(mediaRef) : "image.jpg";
              sendStarted = true;
              res = await sender.sendImage(number, { url: mediaRef, mimetype, fileName }, row.body);
            } else {
              sendStarted = true;
              res = await sender.sendText(number, row.body);
            }

            markOutboxSent(row.id, row.lease, res.waMessageId);
          } catch (err) {
            if (err instanceof WhatsAppError) {
              if (err.kind === "retryable") {
                markOutboxRetry(row.id, row.lease, err.message);
              } else if (err.kind === "permanent") {
                markOutboxFailed(row.id, row.lease, err.message);
                if (err.message.includes("not_on_whatsapp")) {
                  markNoWhatsapp(row.phone);
                  cancelQueuedForPhone(row.phone);
                }
              } else {
                markOutboxUncertain(row.id, row.lease, err.message);
              }
            } else {
              const errorMsg = err instanceof Error ? err.message : String(err);
              if (sendStarted) {
                markOutboxUncertain(row.id, row.lease, errorMsg);
              } else {
                markOutboxFailed(row.id, row.lease, errorMsg);
              }
            }
          }
        }
      }
    }

    recordWorkerTick("whatsapp");
  } catch (err) {
    log.error("whatsapp.worker_failed", { error: err });
    recordWorkerError("whatsapp", err);
  } finally {
    tickRunning = false;
  }
}

export async function waMaintenance(now: Date = new Date()): Promise<void> {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    const settings = getWhatsAppSettings();

    // 1. Recover stale sending (turns stuck rows into 'uncertain')
    recoverStaleSending(now);

    // 2. Recover stale inbound
    recoverStaleInbound(now);

    // 3. Auto-release stale human takeovers
    autoReleaseStale(settings.aiResumeAfterHours, now);

    // 4. Refresh connection state
    const sender = getWhatsAppSender();
    if (sender) {
      try {
        const state = await sender.connectionState();
        setWhatsAppConnectionState({ state });
      } catch {
        // Connection state errors ignored during maintenance
      }
    }

    // 5. Purge old rows and expired media
    purgeOutbox(now);
    purgeInboundEvents(now);
    await purgeExpiredMedia(settings.mediaRetentionDays, now);
  } catch (err) {
    log.error("whatsapp.maintenance_failed", { error: err });
  } finally {
    maintenanceRunning = false;
  }
}

export function startWhatsAppWorker(): void {
  if (!whatsappConfigured()) return;
  const g = globalThis as {
    __crmWhatsAppWorker?: NodeJS.Timeout;
    __crmWhatsAppMaintenance?: NodeJS.Timeout;
  };
  if (g.__crmWhatsAppWorker) return;

  g.__crmWhatsAppWorker = setInterval(() => void waTick(), WA_TICK_MS);
  g.__crmWhatsAppMaintenance = setInterval(() => void waMaintenance(), WA_MAINTENANCE_MS);
  void waMaintenance();
  void waTick();
}
