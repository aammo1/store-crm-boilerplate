function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export interface PlaceholderPdfOptions {
  title?: string;
  lines?: string[];
}

/**
 * Minimal single-page PDF so courier flows (BL or labels) are verifiable with
 * DELIVERY_PROVIDER=mock (the mock exposes non-HTTP URLs and no real bytes).
 * Handwritten object graph with computed xref offsets — no dependency needed.
 */
export function placeholderPdf(optionsOrRef: PlaceholderPdfOptions | string): Uint8Array {
  let title: string;
  let lines: string[];

  if (typeof optionsOrRef === "string") {
    title = "Bon de livraison - Mode test";
    lines = [
      `Ref : ${optionsOrRef}`,
      "Mode test - aucune generation reelle chez le transporteur.",
    ];
  } else {
    title = optionsOrRef.title ?? "Document - Mode test";
    lines = optionsOrRef.lines ?? [
      "Mode test - aucune generation reelle chez le transporteur.",
    ];
  }

  const contentParts: string[] = [
    `BT /F1 16 Tf 56 796 Td (${pdfEscape(title)}) Tj ET`,
  ];
  let y = 768;
  for (const line of lines) {
    contentParts.push(`BT /F1 12 Tf 56 ${y} Td (${pdfEscape(line)}) Tj ET`);
    y -= 24;
  }
  const content = contentParts.join("\n");

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
