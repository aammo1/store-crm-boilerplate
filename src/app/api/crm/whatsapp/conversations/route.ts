import { NextResponse } from "next/server";
import { AuthGuardError, requireUser } from "@/lib/auth-guards";
import { listConversations } from "@/lib/services/whatsapp-conversations";
import { z } from "@/lib/validation";

export const runtime = "nodejs";

const listQuery = z.object({
  view: z.enum(["todo", "mine", "all"]).default("all"),
  q: z.string().trim().max(80).optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const user = await requireUser();

    const parsed = listQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Requête invalide" },
        { status: 400 },
      );
    }

    const { items, nextCursor } = listConversations({
      view: parsed.data.view,
      userId: user.id,
      role: user.role,
      q: parsed.data.q,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });

    return NextResponse.json(
      { items, nextCursor },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}
