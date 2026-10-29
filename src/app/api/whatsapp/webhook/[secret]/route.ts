import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { log } from "@/lib/log";
import { readLimitedJson, RequestBodyError } from "@/lib/request-body";
import { budgetKey, consumeBudgets } from "@/lib/services/security-budgets";
import { storeInboundEvent } from "@/lib/services/whatsapp-inbound-events";
import { webhookSecret, whatsappConfigured } from "@/lib/whatsapp/config";

// Sole inbound Evolution webhook — the only exception to the "no webhook
// automation" rule. Store-then-process: authenticated events are persisted raw
// and acknowledged at once; the whatsapp worker processes them later through
// the inbound processor. No AI, media download or business logic runs here.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

type RouteContext = { params: Promise<{ secret: string }> };

export async function POST(request: Request, { params }: RouteContext): Promise<NextResponse> {
  if (!whatsappConfigured()) {
    return new NextResponse(null, { status: 404 });
  }

  const expectedSecret = webhookSecret();
  if (!expectedSecret) {
    return new NextResponse(null, { status: 404 });
  }

  const { secret: pathSecret } = await params;
  if (!safeCompare(pathSecret, expectedSecret)) {
    return new NextResponse(null, { status: 404 });
  }

  const headerSecret = request.headers.get("x-webhook-secret") ?? "";
  if (!safeCompare(headerSecret, expectedSecret)) {
    return new NextResponse(null, { status: 401 });
  }

  const retryAfter = consumeBudgets([
    {
      key: budgetKey("wa_webhook", "global"),
      limit: 600,
      windowMs: 60_000,
    },
  ]);
  if (retryAfter > 0) {
    return new NextResponse(null, {
      status: 429,
      headers: { "Retry-After": String(retryAfter) },
    });
  }

  let body: unknown;
  try {
    body = await readLimitedJson(request, 512 * 1024);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return new NextResponse(null, { status: error.status });
    }
    return new NextResponse(null, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    log.info("wa.webhook", { event: "", stored: false, duplicate: false });
    return NextResponse.json({ ok: true });
  }

  const payload = body as Record<string, unknown>;
  const rawEvent = typeof payload.event === "string" ? payload.event : "";
  const event = rawEvent.toLowerCase().replace(/_/g, ".");

  let stored = false;
  let duplicate = false;

  if (event === "messages.upsert") {
    const rawData = payload.data;
    const messageList: Record<string, unknown>[] = Array.isArray(rawData)
      ? rawData.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
      : rawData !== null && typeof rawData === "object"
      ? [rawData as Record<string, unknown>]
      : [];

    for (const msg of messageList) {
      const key = msg.key;
      if (!key || typeof key !== "object") continue;
      const keyObj = key as Record<string, unknown>;

      if (keyObj.fromMe === true) continue;

      const remoteJid = typeof keyObj.remoteJid === "string" ? keyObj.remoteJid : "";
      if (
        remoteJid.endsWith("@g.us") ||
        remoteJid.endsWith("@broadcast") ||
        remoteJid.endsWith("@newsletter") ||
        remoteJid === "status@broadcast"
      ) {
        continue;
      }

      const waMessageId = typeof keyObj.id === "string" && keyObj.id.trim() ? keyObj.id.trim() : null;
      if (!waMessageId) continue;

      const singleMessagePayload: Record<string, unknown> = {
        ...(typeof payload.instance === "string" ? { instance: payload.instance } : {}),
        ...msg,
      };

      const res = storeInboundEvent({
        eventType: "messages.upsert",
        waMessageId,
        payload: singleMessagePayload,
      });
      if (res.stored) stored = true;
      if (res.duplicate) duplicate = true;
    }
  } else if (event === "connection.update") {
    const res = storeInboundEvent({
      eventType: "connection.update",
      waMessageId: null,
      payload,
    });
    if (res.stored) stored = true;
    if (res.duplicate) duplicate = true;
  }

  log.info("wa.webhook", { event, stored, duplicate });
  return NextResponse.json({ ok: true });
}

// Any non-POST method gets 405; with WhatsApp unconfigured the whole endpoint
// stays invisible (404), so probe requests confirm nothing.
function methodNotAllowed(): NextResponse {
  return new NextResponse(null, { status: whatsappConfigured() ? 405 : 404 });
}

export async function GET(): Promise<NextResponse> {
  return methodNotAllowed();
}

export async function PUT(): Promise<NextResponse> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<NextResponse> {
  return methodNotAllowed();
}

export async function PATCH(): Promise<NextResponse> {
  return methodNotAllowed();
}
