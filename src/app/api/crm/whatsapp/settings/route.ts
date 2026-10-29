import { NextResponse } from "next/server";
import { AuthGuardError, requireAdmin } from "@/lib/auth-guards";
import { browserMutationAllowed } from "@/lib/browser-mutation";
import { readLimitedJson, RequestBodyError } from "@/lib/request-body";
import { cancelAllQueued } from "@/lib/services/whatsapp-outbox";
import {
  getWhatsAppConnectionState,
  getWhatsAppSettings,
  updateWhatsAppSettings,
  WhatsAppSettingsError,
} from "@/lib/services/whatsapp-settings";
import { z } from "@/lib/validation";
import { whatsappAiConfigured, whatsappConfigured } from "@/lib/whatsapp/config";

export const runtime = "nodejs";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(error: unknown) {
  if (error instanceof AuthGuardError) {
    return json({ error: error.message }, error.status);
  }
  if (error instanceof RequestBodyError) {
    return json({ error: error.message }, error.status);
  }
  if (error instanceof WhatsAppSettingsError) {
    return json({ error: error.message, ...(error.field ? { field: error.field } : {}) }, error.status);
  }
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    const field = (first?.path?.[0] ?? (first as { keys?: string[] })?.keys?.[0])?.toString();
    return json(
      {
        error: first?.message ?? "Paramètres invalides.",
        ...(field ? { field } : {}),
      },
      400,
    );
  }
  return json({ error: "Impossible de charger ou d’enregistrer les paramètres WhatsApp." }, 500);
}

export async function GET() {
  try {
    await requireAdmin();
    return json({
      settings: getWhatsAppSettings(),
      connection: getWhatsAppConnectionState(),
      configured: {
        evolution: whatsappConfigured(),
        ai: whatsappAiConfigured(),
      },
    });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request) {
  try {
    await requireAdmin();
    if (!browserMutationAllowed(request)) {
      return json({ error: "Origine non autorisée." }, 403);
    }
    const body = await readLimitedJson(request, 8192);
    const wasEnabled = getWhatsAppSettings().enabled;
    const settings = updateWhatsAppSettings(body);
    if (wasEnabled && !settings.enabled) cancelAllQueued();
    return json({ settings });
  } catch (error) {
    return failure(error);
  }
}
