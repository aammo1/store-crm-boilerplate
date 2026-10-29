import { NextResponse } from "next/server";
import { AuthGuardError, requireAdmin } from "@/lib/auth-guards";
import { browserMutationAllowed } from "@/lib/browser-mutation";
import { readLimitedJson, RequestBodyError } from "@/lib/request-body";
import {
  CarrierStatusMapError,
  listRawStatuses,
  NOTIFY_CATEGORIES,
  setNotifyCategory,
} from "@/lib/services/carrier-status-map";
import { z } from "@/lib/validation";

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
  if (error instanceof CarrierStatusMapError) {
    return json({ error: error.message }, error.status);
  }
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    const field = (first?.path?.[0] ?? (first as { keys?: string[] })?.keys?.[0])?.toString();
    return json(
      { error: first?.message ?? "Statut transporteur invalide.", ...(field ? { field } : {}) },
      400,
    );
  }
  return json({ error: "Impossible de charger ou d’enregistrer les statuts transporteur." }, 500);
}

const putSchema = z
  .object({
    provider: z.string().trim().min(1).max(40),
    rawStatus: z.string().trim().min(1).max(200),
    category: z.enum(NOTIFY_CATEGORIES).nullable(),
  })
  .strict();

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const provider = new URL(request.url).searchParams.get("provider") ?? undefined;
    return json({ statuses: listRawStatuses(provider || undefined) });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request) {
  try {
    const user = await requireAdmin();
    if (!browserMutationAllowed(request)) {
      return json({ error: "Origine non autorisée." }, 403);
    }
    const body = putSchema.parse(await readLimitedJson(request, 8192));
    setNotifyCategory(body.provider, body.rawStatus, body.category, user.id);
    return json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
