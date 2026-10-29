import { NextResponse } from "next/server";
import { AuthGuardError, requireUser } from "@/lib/auth-guards";
import { listOpenRequests } from "@/lib/services/whatsapp-staging";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  try {
    await requireUser();
    return NextResponse.json(
      { requests: listOpenRequests() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}
