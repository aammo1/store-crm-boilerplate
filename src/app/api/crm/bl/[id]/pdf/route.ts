import { NextResponse } from "next/server";
import { AuthGuardError, requireUser } from "@/lib/auth-guards";
import { getDb } from "@/lib/db";
import { getProvider } from "@/lib/shipping";
import { courierPortal } from "@/lib/shipping/courier-copy";
import { redactText } from "@/lib/shipping/redact";
import type { PdfFormat } from "@/lib/shipping/provider";

export const runtime = "nodejs";

const PDF_FORMATS: readonly PdfFormat[] = ["standard", "a4", "tickets10x10"];
const FETCH_TIMEOUT_MS = 20_000;

function json(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status });
}

// --- Placeholder PDF (mock provider only).

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Minimal single-page PDF so the full BL flow is verifiable with
 * DELIVERY_PROVIDER=mock (the mock exposes a non-HTTP URL and no real bytes).
 * Handwritten object graph with computed xref offsets — no dependency needed.
 */
function placeholderPdf(ref: string): Uint8Array {
  const content = [
    "BT /F1 16 Tf 56 796 Td (Bon de livraison - Mode test) Tj ET",
    `BT /F1 12 Tf 56 768 Td (Ref : ${pdfEscape(ref)}) Tj ET`,
    "BT /F1 10 Tf 56 744 Td (Mode test - aucune generation reelle chez le transporteur.) Tj ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    await requireUser();
    const { id } = await params;

    const formatParam = new URL(request.url).searchParams.get("format") ?? "standard";
    if (!PDF_FORMATS.includes(formatParam as PdfFormat)) {
      return json(400, { error: "Format PDF invalide (standard, a4 ou tickets10x10)." });
    }
    const format = formatParam as PdfFormat;

    const note = getDb()
      .prepare("SELECT id, ref FROM delivery_notes WHERE id = ?")
      .get(id) as { id: string; ref: string } | undefined;
    if (!note) {
      return json(404, { error: "BL introuvable." });
    }

    // Built server-side only — never shipped to the browser, never logged.
    const pdfUrl = getProvider().deliveryNotePdfUrl(note.ref, format);
    const filename = `BL-${note.ref.replace(/[^A-Za-z0-9._-]/g, "") || "ref"}.pdf`;

    if (!/^https?:/i.test(pdfUrl)) {
      // Mock provider (mock:// URL): deterministic placeholder bytes.
      return new NextResponse(placeholderPdf(note.ref) as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    let upstream: Response;
    try {
      upstream = await fetch(pdfUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "follow",
      });
    } catch (err) {
      console.error(`[bl-pdf] transporteur injoignable : ${redactText(err instanceof Error ? err.message : String(err))}`);
      return json(502, {
        error: `PDF indisponible — transporteur injoignable. Téléchargez-le depuis ${courierPortal()}.`,
      });
    }

    if (!upstream.ok) {
      console.error(`[bl-pdf] transporteur HTTP ${upstream.status} pour ${filename}`);
      return json(502, {
        error: `PDF indisponible (HTTP ${upstream.status}) — téléchargez-le depuis ${courierPortal()}.`,
      });
    }

    // The PDF auth model is unverified (docs/operations.md, Ozon): a 200 carrying
    // an HTML login page must not be streamed to the user as a PDF.
    const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
    if (contentType !== "" && !contentType.includes("pdf")) {
      return json(502, {
        error: `Le transporteur n'a pas renvoyé de PDF (connexion au portail requise ?). Téléchargez-le depuis ${courierPortal()}.`,
      });
    }

    return new NextResponse(upstream.body as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}
