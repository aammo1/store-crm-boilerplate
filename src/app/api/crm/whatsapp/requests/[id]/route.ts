import { NextResponse } from "next/server";
import { AuthGuardError, requireUser } from "@/lib/auth-guards";
import { readLimitedJson, RequestBodyError } from "@/lib/request-body";
import {
  StagingError,
  convertRequest,
  dismissRequest,
} from "@/lib/services/whatsapp-staging";
import { z } from "@/lib/validation";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 4 * 1024;

const requestAction = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("convert"),
    orderId: z.string().trim().min(1, "Commande requise.").max(64),
  }),
  z.object({ action: z.literal("dismiss") }),
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser();
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
    const parsed = requestAction.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Requête invalide" },
        { status: 400 },
      );
    }

    try {
      if (parsed.data.action === "convert") {
        convertRequest(id, parsed.data.orderId, user.id);
      } else {
        dismissRequest(id, user.id);
      }
      return NextResponse.json({ ok: true });
    } catch (error) {
      if (error instanceof StagingError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}
