import { NextResponse } from "next/server";
import { AuthGuardError, requireUser } from "@/lib/auth-guards";
import { readLimitedJson, RequestBodyError } from "@/lib/request-body";
import { StagingError, approveProposal, rejectProposal } from "@/lib/services/whatsapp-staging";
import { z } from "@/lib/validation";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 4 * 1024;

const proposalAction = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().trim().max(500, "Note trop longue (500 caractères maximum).").optional(),
});

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
    const parsed = proposalAction.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Requête invalide" },
        { status: 400 },
      );
    }

    const actor = { id: user.id, name: user.name ?? null };
    try {
      const proposal =
        parsed.data.action === "approve"
          ? approveProposal(id, actor)
          : rejectProposal(id, actor, parsed.data.note);
      return NextResponse.json({ proposal });
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
