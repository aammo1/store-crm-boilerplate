import { NextResponse } from "next/server";
import { requireUser, AuthGuardError } from "@/lib/auth-guards";
import { syncCities } from "@/lib/shipping/city-sync";
import { getProvider } from "@/lib/shipping";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  try {
    await requireUser();
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }

  try {
    const count = await syncCities(getProvider());
    return NextResponse.json({ ok: true, count });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur de synchronisation";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
