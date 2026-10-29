import { NextResponse } from "next/server";
import { AuthGuardError, requireAdmin } from "@/lib/auth-guards";
import { readLimitedJson, RequestBodyError } from "@/lib/request-body";
import { BlocklistError, blockPhone, unblockPhone } from "@/lib/services/customers";
import { clearStrikes } from "@/lib/services/whatsapp-strikes";
import { getConversation } from "@/lib/services/whatsapp-conversations";
import { z } from "@/lib/validation";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 4 * 1024;

const blockBody = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Motif requis (3 caractères minimum).")
    .max(200, "Motif trop long (200 caractères maximum)."),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireAdmin();
    const { id } = await params;

    const conversation = getConversation(id);
    if (!conversation) {
      return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
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
    const parsed = blockBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Requête invalide" },
        { status: 400 },
      );
    }

    try {
      const result = blockPhone(conversation.phone, parsed.data.reason, user.id);
      return NextResponse.json({ ok: true, created: result.created });
    } catch (error) {
      if (error instanceof BlocklistError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    await requireAdmin();
    const { id } = await params;

    const conversation = getConversation(id);
    if (!conversation) {
      return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
    }

    try {
      const unblocked = unblockPhone(conversation.phone);
      const clearedStrikes = clearStrikes(conversation.phone);
      return NextResponse.json({ ok: true, unblocked, clearedStrikes });
    } catch (error) {
      if (error instanceof BlocklistError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}
