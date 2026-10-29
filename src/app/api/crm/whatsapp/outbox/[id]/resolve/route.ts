import { NextResponse } from "next/server";
import { AuthGuardError, requireAdmin } from "@/lib/auth-guards";
import { readLimitedJson, RequestBodyError } from "@/lib/request-body";
import { getDb } from "@/lib/db";
import { resolveUncertain } from "@/lib/services/whatsapp-outbox";
import { z } from "@/lib/validation";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 2 * 1024;

const resolveBody = z.object({
  resolution: z.enum(["sent", "not_sent_requeue", "cancel"]),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireAdmin();
    const { id } = await params;

    let body: unknown;
    try {
      body = await readLimitedJson(request, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return NextResponse.json({ error: "Requête invalide" }, { status: 400 });
    }
    const parsed = resolveBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Requête invalide" },
        { status: 400 },
      );
    }

    const row = getDb().prepare("SELECT status FROM wa_outbox WHERE id = ?").get(id) as
      | { status: string }
      | undefined;
    if (!row) {
      return NextResponse.json({ error: "Ligne introuvable." }, { status: 404 });
    }
    if (row.status !== "uncertain") {
      return NextResponse.json(
        { error: "Cette ligne n'est plus en attente de résolution." },
        { status: 409 },
      );
    }

    if (!resolveUncertain(id, user.id, parsed.data.resolution)) {
      return NextResponse.json(
        { error: "Cette ligne n'est plus en attente de résolution." },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}
