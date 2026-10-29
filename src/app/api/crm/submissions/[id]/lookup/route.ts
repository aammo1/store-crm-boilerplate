import { NextResponse } from "next/server";
import { AuthGuardError, requireUser } from "@/lib/auth-guards";
import { browserMutationAllowed } from "@/lib/browser-mutation";
import {
  lookupSubmissionAtCourier,
  LookupError,
} from "@/lib/services/courier-lookup";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    await requireUser();

    if (!browserMutationAllowed(request)) {
      return NextResponse.json(
        { error: "Origine non autorisée." },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }

    const { id } = await params;
    const result = await lookupSubmissionAtCourier(id);

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    if (error instanceof LookupError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw error;
  }
}
