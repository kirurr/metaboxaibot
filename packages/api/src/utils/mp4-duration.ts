/**
 * Lightweight MP4 metadata parser.
 * Walks the ISO Base Media box tree to extract duration, video resolution and FPS
 * without any external dependencies.
 *
 * Duration  : moov → mvhd        (version 0: 32-bit fields, version 1: 64-bit)
 * Resolution: moov → trak → tkhd (width/height as 16.16 fixed-point; audio tracks = 0×0)
 * FPS       : moov → trak → mdia → mdhd (timescale) + minf → stbl → stts (sample_delta)
 *             fps = timescale / sample_delta
 */
export interface Mp4Info {
  /** Video duration in seconds, or null if moov/mvhd not found. */
  duration: number | null;
  /** Video width in pixels, or null if not found. */
  width: number | null;
  /** Video height in pixels, or null if not found. */
  height: number | null;
  /** Frame rate, or null if not found. */
  fps: number | null;
}

export function parseMp4Info(buf: Buffer): Mp4Info {
  const moov = findBox(buf, 0, buf.length, "moov");
  if (!moov) return { duration: null, width: null, height: null, fps: null };

  const duration = parseMvhd(buf, moov.start, moov.end);
  const track = parseVideoTrack(buf, moov.start, moov.end);
  return {
    duration,
    width: track?.width ?? null,
    height: track?.height ?? null,
    fps: track?.fps ?? null,
  };
}

/** Backward-compatible wrapper — returns duration in seconds, or null. */
export function parseMp4Duration(buf: Buffer): number | null {
  return parseMp4Info(buf).duration;
}

export interface VideoProbeInfo {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  fileSizeBytes: number;
}

/**
 * Fetches a video URL and extracts duration + dimensions from the MP4 moov atom.
 * Falls back to null fields when the container isn't MP4 or moov isn't present
 * (caller decides how to surface that).
 */
export async function probeVideoMetadata(videoUrl: string): Promise<VideoProbeInfo> {
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Failed to fetch video for probe: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const info = parseMp4Info(buf);
  return {
    durationSec: info.duration,
    width: info.width,
    height: info.height,
    fps: info.fps,
    fileSizeBytes: buf.byteLength,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Scan boxes within [start, end) for the first box of the given type.
 * Returns the content range [contentStart, contentEnd) — i.e. past the 8-byte header.
 */
function findBox(
  buf: Buffer,
  start: number,
  end: number,
  type: string,
): { start: number; end: number } | null {
  let offset = start;
  while (offset + 8 <= end) {
    const size = buf.readUInt32BE(offset);
    if (size < 8) break;
    const boxType = buf.toString("latin1", offset + 4, offset + 8);
    const boxEnd = Math.min(offset + size, buf.length);
    if (boxType === type) return { start: offset + 8, end: boxEnd };
    offset += size;
  }
  return null;
}

/**
 * Walk moov content for mvhd and return duration in seconds.
 *
 * mvhd v0: [8 hdr][1 ver][3 flags][4 ctime][4 mtime][4 timescale][4 duration] …
 * mvhd v1: [8 hdr][1 ver][3 flags][8 ctime][8 mtime][4 timescale][8 duration] …
 * (offset counts from box start, i.e. including the 8-byte header)
 */
function parseMvhd(buf: Buffer, start: number, end: number): number | null {
  let offset = start;
  while (offset + 8 <= end) {
    const size = buf.readUInt32BE(offset);
    if (size < 8) break;
    const boxType = buf.toString("latin1", offset + 4, offset + 8);

    if (boxType === "mvhd") {
      const version = buf.readUInt8(offset + 8);
      if (version === 1 && offset + 40 <= buf.length) {
        const timescale = buf.readUInt32BE(offset + 28);
        if (timescale === 0) return null;
        const hi = buf.readUInt32BE(offset + 32);
        const lo = buf.readUInt32BE(offset + 36);
        return (hi * 0x1_0000_0000 + lo) / timescale;
      } else if (version === 0 && offset + 28 <= buf.length) {
        const timescale = buf.readUInt32BE(offset + 20);
        if (timescale === 0) return null;
        return buf.readUInt32BE(offset + 24) / timescale;
      }
    }

    offset += size;
  }
  return null;
}

/**
 * Walk moov content for trak boxes and return the first video track's metadata.
 * Audio tracks have width=0 / height=0 in tkhd, so they are skipped.
 */
function parseVideoTrack(
  buf: Buffer,
  moovStart: number,
  moovEnd: number,
): { width: number; height: number; fps: number | null } | null {
  let offset = moovStart;
  while (offset + 8 <= moovEnd) {
    const size = buf.readUInt32BE(offset);
    if (size < 8) break;
    const boxType = buf.toString("latin1", offset + 4, offset + 8);

    if (boxType === "trak") {
      const trakStart = offset + 8;
      const trakEnd = Math.min(offset + size, buf.length);
      const dims = parseTkhd(buf, trakStart, trakEnd);
      if (dims) {
        const fps = parseTrackFps(buf, trakStart, trakEnd);
        return { ...dims, fps };
      }
    }

    offset += size;
  }
  return null;
}

/**
 * Parse tkhd inside a trak to get video width/height (audio tracks return null).
 *
 * tkhd v0 (offsets from box start):
 *   [8] ver  [12] ctime  [16] mtime  [20] track_ID  [24] reserved  [28] duration
 *   [32] reserved×2  [40] layer  [42] alt_grp  [44] volume  [46] reserved
 *   [48] matrix (36 B)  [84] width 16.16  [88] height 16.16
 *
 * tkhd v1:
 *   [8] ver  [12] ctime×8  [20] mtime×8  [28] track_ID  [32] reserved  [36] duration×8
 *   [44] reserved×2  [52] layer  [54] alt_grp  [56] volume  [58] reserved
 *   [60] matrix (36 B)  [96] width 16.16  [100] height 16.16
 *
 * Width/height are 16.16 fixed-point: upper 16 bits = integer pixels.
 */
function parseTkhd(
  buf: Buffer,
  start: number,
  end: number,
): { width: number; height: number } | null {
  let offset = start;
  while (offset + 8 <= end) {
    const size = buf.readUInt32BE(offset);
    if (size < 8) break;
    const boxType = buf.toString("latin1", offset + 4, offset + 8);

    if (boxType === "tkhd") {
      const version = buf.readUInt8(offset + 8);
      const widthOff = version === 1 ? offset + 96 : offset + 84;
      const heightOff = version === 1 ? offset + 100 : offset + 88;

      if (heightOff + 4 <= buf.length) {
        // Upper 16 bits of the 16.16 fixed-point value = integer pixel count
        const width = buf.readUInt16BE(widthOff);
        const height = buf.readUInt16BE(heightOff);
        if (width > 0 && height > 0) return { width, height };
      }
    }

    offset += size;
  }
  return null;
}

/**
 * Derive frame rate for a track by parsing:
 *   trak → mdia → mdhd   (timescale: ticks per second)
 *   trak → mdia → minf → stbl → stts  (sample_delta: ticks per frame)
 *
 * fps = timescale / sample_delta
 *
 * mdhd v0 content: [ver][flags][ctime 4B][mtime 4B][timescale 4B][duration 4B]…
 * mdhd v1 content: [ver][flags][ctime 8B][mtime 8B][timescale 4B][duration 8B]…
 * (findBox returns content start, so index 0 = version byte)
 *
 * stts content: [ver][flags][entry_count 4B][ (sample_count 4B, sample_delta 4B)… ]
 */
function parseTrackFps(buf: Buffer, trakStart: number, trakEnd: number): number | null {
  const mdia = findBox(buf, trakStart, trakEnd, "mdia");
  if (!mdia) return null;

  // timescale from mdhd
  const mdhd = findBox(buf, mdia.start, mdia.end, "mdhd");
  if (!mdhd) return null;
  const mdhdVersion = buf.readUInt8(mdhd.start);
  const timescaleOff = mdhd.start + (mdhdVersion === 1 ? 20 : 12);
  if (timescaleOff + 4 > buf.length) return null;
  const timescale = buf.readUInt32BE(timescaleOff);
  if (timescale === 0) return null;

  // sample_delta from stts
  const minf = findBox(buf, mdia.start, mdia.end, "minf");
  if (!minf) return null;
  const stbl = findBox(buf, minf.start, minf.end, "stbl");
  if (!stbl) return null;
  const stts = findBox(buf, stbl.start, stbl.end, "stts");
  if (!stts) return null;

  // stts content: [1B ver][3B flags][4B entry_count][4B sample_count][4B sample_delta]…
  if (stts.start + 16 > buf.length) return null;
  const entryCount = buf.readUInt32BE(stts.start + 4);
  if (entryCount === 0) return null;
  const sampleDelta = buf.readUInt32BE(stts.start + 12); // first entry's delta
  if (sampleDelta === 0) return null;

  const fps = timescale / sampleDelta;
  // Sanity-check: realistic video FPS
  return fps >= 1 && fps <= 120 ? Math.round(fps * 1000) / 1000 : null;
}
