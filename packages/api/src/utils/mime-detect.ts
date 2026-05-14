/**
 * MIME-type detection from magic bytes.
 * Used to override unreliable HTTP Content-Type headers
 * (S3 presigned URLs and Telegram file URLs often return application/octet-stream).
 */

/**
 * Detects image MIME type from the first bytes of the buffer.
 * Returns null if the format is not recognized.
 */
export function detectImageMimeType(buf: ArrayBuffer | Buffer): string | null {
  const b = buf instanceof Buffer ? buf : new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  // WebP: RIFF....WEBP
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "image/webp";
  return null;
}

/**
 * Detects audio MIME type from the first bytes of the buffer.
 * Returns null if the format is not recognized.
 */
export function detectAudioMimeType(buf: ArrayBuffer | Buffer): string | null {
  const b = buf instanceof Buffer ? buf : new Uint8Array(buf);
  // ID3 tag (MP3)
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return "audio/mpeg";
  // AAC ADTS — must be checked before MP3: the ADTS sync word shares the
  // 0xFFEx prefix with an MP3 frame header, so the looser MP3 mask below
  // (b[1] & 0xE0) would swallow it first. ADTS layer bits are always 00
  // (b[1] & 0xF6 === 0xF0), which an MP3 frame header never has.
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return "audio/aac";
  // MPEG sync word (MP3 frame)
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "audio/mpeg";
  // OGG
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return "audio/ogg";
  // RIFF/WAVE
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x41 &&
    b[10] === 0x56 &&
    b[11] === 0x45
  )
    return "audio/wav";
  // FLAC
  if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return "audio/flac";
  // ISO BMFF (MP4/M4A): "....ftyp" at bytes 0-7 (size + 'ftyp')
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    // brand at bytes 8-11: M4A , mp42, isom, etc → all audio-capable mp4
    return "audio/mp4";
  }
  return null;
}

/**
 * Detects video MIME type from the first bytes of the buffer.
 * Returns null if the format is not recognized.
 */
export function detectVideoMimeType(buf: ArrayBuffer | Buffer): string | null {
  const b = buf instanceof Buffer ? buf : new Uint8Array(buf);
  // ISO BMFF (MP4/MOV): "....ftyp" at bytes 0-7 (size + 'ftyp')
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    // brand at bytes 8-11: qt → quicktime, isom/mp4*/avc1/dash → mp4
    if (b[8] === 0x71 && b[9] === 0x74 && b[10] === 0x20 && b[11] === 0x20)
      return "video/quicktime";
    return "video/mp4";
  }
  // WebM / Matroska: EBML header 1A 45 DF A3
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return null;
}

/** Maps a MIME type to its canonical file extension (no leading dot). */
export function mimeToExtension(mime: string): string | null {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "audio/mpeg":
      return "mp3";
    case "audio/ogg":
      return "ogg";
    case "audio/wav":
      return "wav";
    case "audio/flac":
      return "flac";
    case "audio/aac":
      return "aac";
    case "audio/mp4":
      return "m4a";
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    default:
      return null;
  }
}

/**
 * Returns a safe image MIME type: detects from magic bytes first,
 * then falls back to the HTTP Content-Type header value (if it starts with "image/"),
 * then falls back to the provided default.
 */
export function resolveImageMimeType(
  buf: ArrayBuffer | Buffer,
  headerContentType: string | null,
  defaultType = "image/jpeg",
): string {
  return (
    detectImageMimeType(buf) ??
    (headerContentType?.startsWith("image/") ? headerContentType : null) ??
    defaultType
  );
}

/**
 * Returns a safe audio MIME type: detects from magic bytes first,
 * then falls back to the HTTP Content-Type header value (if it starts with "audio/"),
 * then falls back to the provided default.
 */
export function resolveAudioMimeType(
  buf: ArrayBuffer | Buffer,
  headerContentType: string | null,
  defaultType = "audio/mpeg",
): string {
  return (
    detectAudioMimeType(buf) ??
    (headerContentType?.startsWith("audio/") ? headerContentType : null) ??
    defaultType
  );
}
