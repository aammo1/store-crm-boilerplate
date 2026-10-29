import { NextResponse } from "next/server";
import { AuthGuardError, requireUser } from "@/lib/auth-guards";
import {
  canAccessConversation,
  getConversation,
  listMessages,
} from "@/lib/services/whatsapp-conversations";
import { z } from "@/lib/validation";

export const runtime = "nodejs";

const messagesQuery = z.object({
  before: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(
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

    const parsed = messagesQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Requête invalide" },
        { status: 400 },
      );
    }

    const messages = listMessages(id, {
      before: parsed.data.before,
      limit: parsed.data.limit,
    });

    return NextResponse.json(
      { conversation, messages },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}
