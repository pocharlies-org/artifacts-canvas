/**
 * Minimal PDF writer: one JPEG image per page (DCTDecode), no fonts, no dependencies.
 * Page size in points = image px * 0.75 (96 dpi -> 72 dpi).
 */
export interface PdfPage {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

export function buildPdf(pages: PdfPage[], title = 'artifacts-canvas export'): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (b: Uint8Array | string) => {
    const u = typeof b === 'string' ? enc.encode(b) : b;
    chunks.push(u);
    length += u.length;
  };
  const obj = (n: number, body: () => void) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    body();
    push('\nendobj\n');
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = pages.length;
  // object numbers: 1 catalog, 2 pages, 3 info, then per page: page, content, image
  const pageObj = (i: number) => 4 + i * 3;
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`));
  obj(3, () => push(`<< /Title (${pdfString(title)}) /Producer (artifacts-canvas) >>`));
  pages.forEach((p, i) => {
    const w = +(p.width * 0.75).toFixed(2);
    const h = +(p.height * 0.75).toFixed(2);
    const po = pageObj(i);
    obj(po, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im${i} ${po + 2} 0 R >> >> /Contents ${po + 1} 0 R >>`));
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im${i} Do Q`;
    obj(po + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(po + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg);
      push('\nendstream');
    });
  });
  const total = 4 + n * 3;
  const xref = length;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function pdfString(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '?').replace(/([()\\])/g, '\\$1').slice(0, 200);
}
