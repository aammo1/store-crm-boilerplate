import { NextResponse } from "next/server";
import { AuthGuardError, requireUser } from "@/lib/auth-guards";
import { browserMutationAllowed } from "@/lib/browser-mutation";
import { parcelsHandoffSchema } from "@/lib/api-schemas";
import { HandoffError, handoffParcels } from "@/lib/services/expeditions";
import { readLimitedJson, RequestBodyError } from "@/lib/request-body";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 32 * 1024;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const user = await requireUser();

    if (!browserMutationAllowed(request)) {
      return NextResponse.json({ error: "Origine non autorisée." }, { status: 403 });
    }

    let body: unknown;
    try {
      body = await readLimitedJson(request, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return NextResponse.json({ error: "Corps de requête invalide." }, { status: 400 });
    }

    const parsed = parcelsHandoffSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Requête invalide", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const outcome = handoffParcels(parsed.data.parcelIds, user.email ?? user.id);
    return NextResponse.json(outcome);
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    if (error instanceof HandoffError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
