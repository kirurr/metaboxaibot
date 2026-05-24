/**
 * Shared multipart/form-data builder for tests that exercise endpoints
 * using `@fastify/multipart`. Mirrors what a browser would emit so the
 * server-side parser produces real `request.file()` parts.
 *
 * Sample byte buffers are intentionally minimal (magic-bytes only) — the
 * multipart parser is mime-driven, not content-sniffing, so the smallest
 * valid prefix is enough to exercise the kind/extension mapping.
 */

export interface MultipartPart {
  name: string;
  value: string | Buffer;
  filename?: string;
  contentType?: string;
}

export function buildMultipart(parts: MultipartPart[]): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = `----vitest-${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (p.filename !== undefined) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`,
        ),
      );
      chunks.push(
        Buffer.from(`Content-Type: ${p.contentType ?? "application/octet-stream"}\r\n\r\n`),
      );
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`));
    }
    chunks.push(typeof p.value === "string" ? Buffer.from(p.value) : p.value);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

// 8-byte PNG signature — enough for fastify's mime-driven dispatcher.
export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Minimal PDF header.
export const PDF_BYTES = Buffer.from("%PDF-1.4\n", "ascii");
// MP4 `ftyp` box header — covers magic-byte detection where present.
export const MP4_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);
// MP3 frame sync.
export const MP3_BYTES = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
