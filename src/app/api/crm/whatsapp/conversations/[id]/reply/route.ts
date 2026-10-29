import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { AuthGuardError, requireUser } from "@/lib/auth-guards";
import { getDb } from "@/lib/db";
import { readLimitedJson, RequestBodyError } from "@/lib/request-body";
import {
  canAccessConversation,
  getConversation,
  logOrderContact,
  noteAgentReply,
  takeOver,
} from "@/lib/services/whatsapp-conversations";
import { enqueueOutbox } from "@/lib/services/whatsapp-outbox";
import { z } from "@/lib/validation";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 8 * 1024;

const replyBody = z.object({
  text: z
    .string()
    .trim()
    .min(1, "Message vide.")
    .max(2000, "Message trop long (2000 caractères maximum)."),
});

/** Sentinel: rolls the whole reply transaction back when the outbox refuses the row. */
class EnqueueRejected extends Error {}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { id } = await params;

    // Access denied and unknown conversations both answer 404 so existence is never revealed.
    if (!canAccessConversation(id, user.id, user.role)) {
      return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
    }
    const conversation = getConversation(id);
    if (!conversation) {
      return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
    }
    if (conversation.blocked) {
      return NextResponse.json({ error: "Numéro bloqué" }, { status: 403 });
    }
    if (conversation.noWhatsapp) {
      return NextResponse.json({ error: "Ce numéro n'a pas WhatsApp." }, { status: 409 });
    }

    let body: unknown;
    try {
      body = await readLimitedJson(request, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return NextResponse.json({ error: "Requête invalide" }, { status: 400 });
    }
    const parsed = replyBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Requête invalide" },
        { status: 400 },
      );
    }
    const text = parsed.data.text;

    const now = new Date().toISOString();
    let queued = false;
    try {
      getDb().transaction(() => {
        takeOver(id, user.id);
        queued = enqueueOutbox({
          dedupeKey: `agent:${user.id}:${randomUUID()}`,
          phone: conversation.phone,
          purpose: "agent_reply",
          body: text,
          conversationId: id,
          authorUserId: user.id,
        });
        if (!queued) throw new EnqueueRejected();
        noteAgentReply(id, now);
        for (const order of conversation.orders) {
          if (order.access !== "full") continue;
          logOrderContact(order.orderId, user.id, "WhatsApp : réponse agent");
        }
      })();
    } catch (error) {
      if (!(error instanceof EnqueueRejected)) throw error;
    }

    if (!queued) {
      // enqueueOutbox returns false when WhatsApp is disabled (or the phone became
      // blocked/no-WhatsApp in the meantime); nothing was persisted.
      return NextResponse.json({ error: "WhatsApp désactivé" }, { status: 409 });
    }

    return NextResponse.json({ queued: true }, { status: 202 });
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}
