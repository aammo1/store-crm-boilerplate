import { NextResponse } from "next/server";
import { AuthGuardError, requireAdmin } from "@/lib/auth-guards";
import { browserMutationAllowed } from "@/lib/browser-mutation";
import { readLimitedJson, RequestBodyError } from "@/lib/request-body";
import { deliveryProviderName } from "@/lib/env";
import {
  CourierSettingsError,
  getCourierSettings,
  listPickupDistricts,
  updateCourierSettings,
} from "@/lib/services/courier-settings";
import { courierSettingsUpdateSchema } from "@/lib/courier-settings-schema";

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
  if (error instanceof CourierSettingsError) {
    return json({ error: error.message }, error.status);
  }
  return json({ error: "Impossible de charger ou d’enregistrer les paramètres du transporteur." }, 500);
}

export async function GET() {
  try {
    await requireAdmin();
    return json({
      settings: getCourierSettings(),
      pickupDistricts: listPickupDistricts(deliveryProviderName()),
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
    const body = await readLimitedJson(request, 4096);
    const parsed = courierSettingsUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Paramètres invalides." }, 400);
    }
    const settings = updateCourierSettings(parsed.data);
    return json({ settings });
  } catch (error) {
    return failure(error);
  }
}
