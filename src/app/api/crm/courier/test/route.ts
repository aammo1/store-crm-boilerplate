import { NextResponse } from "next/server";
import { AuthGuardError, requireAdmin } from "@/lib/auth-guards";
import { browserMutationAllowed } from "@/lib/browser-mutation";
import { checkCourierTestThrottle } from "@/lib/services/courier-health";
import { getProvider } from "@/lib/shipping";
import { redactText } from "@/lib/shipping/redact";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    await requireAdmin();

    if (!browserMutationAllowed(request)) {
      return NextResponse.json({ error: "Origine non autorisée." }, { status: 403 });
    }

    if (!checkCourierTestThrottle()) {
      return NextResponse.json(
        { ok: false, error: "Trop de requêtes — attendez 10 secondes entre chaque test." },
        { status: 429 },
      );
    }

    let provider;
    try {
      provider = getProvider();
    } catch (err) {
      const message = redactText(err instanceof Error ? err.message : String(err));
      return NextResponse.json({ ok: false, error: message });
    }

    if (!provider.testConnection) {
      if (provider.name === "mock") {
        return NextResponse.json({ ok: true, skipped: true });
      }
      return NextResponse.json({ ok: false, error: "Test non disponible pour ce transporteur." });
    }

    try {
      await provider.testConnection();
      return NextResponse.json({ ok: true });
    } catch (err) {
      const message = redactText(err instanceof Error ? err.message : String(err));
      return NextResponse.json({ ok: false, error: message });
    }
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}
