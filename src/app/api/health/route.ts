import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { deliveryProviderName, runtimeEnvWarnings } from "@/lib/env";
import { workerLeaseStatus } from "@/lib/services/process-lease";
import { pollIntervalMs } from "@/lib/services/tracking";
import { getCourierHealth } from "@/lib/services/courier-health";
import {
  isWorkerStale,
  overallStatus,
  readWorkerStatus,
  type WorkerName,
} from "@/lib/services/worker-status";
import { workerHealth } from "@/lib/workers";
import { WORKER_INTERVAL_MS as META_INTERVAL_MS } from "@/lib/workers/meta";
import { submissionIntervalMs } from "@/lib/workers/submission";
import { WORKER_INTERVAL_MS as TIKTOK_INTERVAL_MS } from "@/lib/workers/tiktok";
import { WA_TICK_MS } from "@/lib/workers/whatsapp";
import { getWhatsAppConnectionState } from "@/lib/services/whatsapp-settings";
import { outboxStats } from "@/lib/services/whatsapp-outbox";
import { whatsappConfigured } from "@/lib/whatsapp/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_TOKEN_LENGTH = 32;

function detailsAuthorized(request: Request): boolean {
  const expected = process.env.HEALTH_DETAILS_TOKEN;
  if (!expected || expected.length < MIN_TOKEN_LENGTH) return false;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readQueues() {
  const row = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
         COALESCE(SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END), 0) AS needs_review,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
        FROM courier_submissions cs
        WHERE NOT EXISTS (SELECT 1 FROM orders o
          WHERE o.id = cs.order_id AND o.confirmation_status = 'cancelled')`,
    )
    .get() as { queued: number; needs_review: number; failed: number };
  return {
    submissionsQueued: row.queued,
    submissionsNeedsReview: row.needs_review,
    submissionsFailed: row.failed,
  };
}

export function GET(request: Request): NextResponse {
  const headers = { "Cache-Control": "no-store" };
  try {
    getDb().prepare("SELECT 1").get();
    const enabled = workerHealth();
    const intervals: Record<WorkerName, number> = {
      submission: submissionIntervalMs(),
      tracking: pollIntervalMs(),
      meta: META_INTERVAL_MS,
      tiktok: TIKTOK_INTERVAL_MS,
      whatsapp: WA_TICK_MS,
    };
    const now = Date.now();
    const workers = {} as Record<
      WorkerName,
      ReturnType<typeof readWorkerStatus> & { enabled: boolean; stale: boolean }
    >;
    for (const name of Object.keys(intervals) as WorkerName[]) {
      const status = readWorkerStatus(name);
      const isEnabled = enabled[name].enabled;
      workers[name] = {
        enabled: isEnabled,
        ...status,
        stale: isWorkerStale(isEnabled, status.lastTickAt, intervals[name], now),
      };
    }
    const status = overallStatus(Object.values(workers));
    const time = new Date(now).toISOString();
    if (!detailsAuthorized(request)) {
      return NextResponse.json({ status, time }, { headers });
    }
    const courierHealth = getCourierHealth();
    return NextResponse.json(
      {
        status,
        time,
        db: true,
        provider: deliveryProviderName(),
        courier: {
          name: deliveryProviderName(),
          profile: courierHealth.courier,
          configured: courierHealth.configured,
          issues: courierHealth.issues,
          citiesCount: courierHealth.citiesCount,
          lastCitiesSyncAt: courierHealth.lastCitiesSyncAt,
          lastTrackingSyncAt: courierHealth.lastTrackingSyncAt,
        },
        warnings: runtimeEnvWarnings(),
        lease: workerLeaseStatus(),
        workers,
        queues: readQueues(),
        whatsapp: {
          configured: whatsappConfigured(),
          connection: getWhatsAppConnectionState(),
          outbox: outboxStats(),
        },
      },
      { headers },
    );
  } catch {
    return NextResponse.json({ status: "down", time: new Date().toISOString() }, { status: 503, headers });
  }
}
