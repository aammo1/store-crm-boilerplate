import { NextResponse } from "next/server";
import { AuthGuardError, requireUser } from "@/lib/auth-guards";
import { getDb } from "@/lib/db";
import { courierProfile } from "@/lib/env";
import { placeholderPdf } from "@/lib/pdf-placeholder";
import { getProvider } from "@/lib/shipping";
import { COURIERS } from "@/lib/shipping/couriers";
import type { DeliveryProvider, LabelsPdf } from "@/lib/shipping/provider";
import { redactText } from "@/lib/shipping/redact";

export const runtime = "nodejs";

const FETCH_TIMEOUT_MS = 20_000;
const ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_REDIRECTS = 2;

/**
 * Fetches the courier's PDF URL following at most MAX_REDIRECTS redirects by
 * hand: every hop must stay on the host the provider returned (and be https,
 * unless that first URL was http), so a redirect can never reach another host.
 */
async function fetchLabelsPdf(firstUrl: string): Promise<Response> {
  const first = new URL(firstUrl);
  let current = first;
  for (let hop = 0; ; hop++) {
    const response = await fetch(current, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "manual",
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || hop >= MAX_REDIRECTS) {
      throw new Error("Redirections d'étiquettes refusées");
    }
    const next = new URL(location, current);
    const protocolOk =
      next.protocol === "https:" || (first.protocol === "http:" && next.protocol === "http:");
    if (!protocolOk || next.host !== first.host) {
      throw new Error("Redirection d'étiquettes hors de l'hôte autorisé");
    }
    current = next;
  }
}

function json(status: number, body: Record<string, unknown>, headers?: Record<string, string>): NextResponse {
  return NextResponse.json(body, { status, headers });
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await requireUser();

    const requestUrl = new URL(request.url);
    const idsParam = requestUrl.searchParams.get("ids");
    const formatParam = requestUrl.searchParams.get("format");

    if (!idsParam) {
      return json(400, { error: "Identifiants de colis requis (?ids=...)." });
    }

    const rawIds = idsParam.split(",").map((s) => s.trim());
    if (rawIds.length === 0 || rawIds.length > 100 || rawIds.some((id) => !id)) {
      return json(400, { error: "Nombre d'identifiants invalide (entre 1 et 100)." });
    }

    for (const id of rawIds) {
      if (!ID_REGEX.test(id)) {
        return json(400, { error: `Identifiant de colis invalide : ${id}` });
      }
    }

    const uniqueIds = Array.from(new Set(rawIds));

    let provider: DeliveryProvider;
    try {
      provider = getProvider();
    } catch {
      return json(409, { error: "Transporteur non configuré ou indisponible." });
    }

    if (!provider.capabilities.labels || typeof provider.getLabelsPdf !== "function") {
      return json(409, { error: "Ce transporteur ne prend pas en charge les étiquettes." });
    }

    const allowedFormatIds = provider.capabilities.labelFormats.map((f) => f.id);
    if (!formatParam || !allowedFormatIds.includes(formatParam)) {
      return json(400, {
        error: `Format d'étiquettes invalide (${allowedFormatIds.join(", ")}).`,
      });
    }

    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = getDb()
      .prepare(
        `SELECT id, tracking_number
         FROM courier_submissions
         WHERE id IN (${placeholders})
           AND status = 'submitted'
           AND tracking_number IS NOT NULL`,
      )
      .all(...uniqueIds) as Array<{ id: string; tracking_number: string }>;

    const rowMap = new Map(rows.map((r) => [r.id, r.tracking_number]));
    const codes: string[] = [];
    for (const id of uniqueIds) {
      const code = rowMap.get(id);
      if (code) {
        codes.push(code);
      }
    }

    const skippedCount = uniqueIds.length - codes.length;
    if (codes.length === 0) {
      return json(404, { error: "Aucun colis prêt pour impression des étiquettes." });
    }

    let result: LabelsPdf;
    try {
      result = await provider.getLabelsPdf(codes, formatParam);
    } catch (err) {
      console.error(
        `[labels-pdf] getLabelsPdf error: ${redactText(err instanceof Error ? err.message : String(err))}`,
      );
      const courierLabel = COURIERS[courierProfile()].label;
      return json(502, {
        error: `Étiquettes indisponibles — réessayez ou imprimez-les depuis le portail ${courierLabel}.`,
      });
    }

    const filename = "etiquettes.pdf";

    if (!result?.url || !/^https?:/i.test(result.url)) {
      const pdfBytes = placeholderPdf({
        title: "Etiquettes - Mode test",
        lines: [`${codes.length} colis`],
      });
      return new NextResponse(new Uint8Array(pdfBytes), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${filename}"`,
          "Cache-Control": "no-store",
          "X-Labels-Skipped": String(skippedCount),
        },
      });
    }

    let upstream: Response;
    try {
      upstream = await fetchLabelsPdf(result.url);
    } catch (err) {
      console.error(
        `[labels-pdf] transporteur injoignable : ${redactText(err instanceof Error ? err.message : String(err))}`,
      );
      const courierLabel = COURIERS[courierProfile()].label;
      return json(502, {
        error: `Étiquettes indisponibles — réessayez ou imprimez-les depuis le portail ${courierLabel}.`,
      });
    }

    if (!upstream.ok) {
      console.error(`[labels-pdf] transporteur HTTP ${upstream.status}`);
      const courierLabel = COURIERS[courierProfile()].label;
      return json(502, {
        error: `Étiquettes indisponibles — réessayez ou imprimez-les depuis le portail ${courierLabel}.`,
      });
    }

    const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("application/pdf")) {
      const courierLabel = COURIERS[courierProfile()].label;
      return json(502, {
        error: `Étiquettes indisponibles — réessayez ou imprimez-les depuis le portail ${courierLabel}.`,
      });
    }

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Labels-Skipped": String(skippedCount),
      },
    });
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}
