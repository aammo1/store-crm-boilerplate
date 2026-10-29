import { NextResponse } from "next/server";
import { AuthGuardError, requireUser } from "@/lib/auth-guards";
import {
  canAccessConversation,
  releaseToAi,
  takeOver,
} from "@/lib/services/whatsapp-conversations";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { id } = await params;

    // Access denied and unknown conversations both answer 404 so existence is never revealed.
    if (!canAccessConversation(id, user.id, user.role)) {
      return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
    }
    takeOver(id, user.id);
    return NextResponse.json({ ok: true });
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
    const user = await requireUser();
    const { id } = await params;

    if (!canAccessConversation(id, user.id, user.role)) {
      return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
    }
    releaseToAi(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}
