import { createRequire } from "module";
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "stream";
import { logger } from "../logger.js";

const _require = createRequire(import.meta.url);
const ffmpegPath: string | null = _require("ffmpeg-static") as string | null;
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
// `ffprobe-static` экспортит `{ path }`, а не строку как `ffmpeg-static`.
// Без явной регистрации `fluent-ffmpeg.ffprobe()` искал бы бинарник в PATH —
// в alpine-контейнере его там нет, отсюда "Cannot find ffprobe" в проде.
const ffprobeStatic = _require("ffprobe-static") as { path?: string } | null;
if (ffprobeStatic?.path) ffmpeg.setFfprobePath(ffprobeStatic.path);

/**
 * Transcodes an arbitrary audio buffer to MP3.
 * Input format is auto-detected by ffmpeg (works for OGG/Opus, M4A, AAC, FLAC, etc.).
 * Used before uploading to providers that only accept MP3/WAV (e.g. HeyGen).
 *
 * Pass `inputFormat` to force ffmpeg's input demuxer when auto-detection fails
 * (e.g. raw streams without container headers).
 *
 * Writes input to a temp file first — piping via stdin breaks MP4/M4A demuxing
 * for files with `moov` atom at the end (ffmpeg can't seek backward on a pipe).
 */
export async function transcodeToMp3(input: Buffer, inputFormat?: string): Promise<Buffer> {
  const tempPath = join(tmpdir(), `metabox-transcode-${randomBytes(12).toString("hex")}`);
  await fs.writeFile(tempPath, input);

  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const output = new PassThrough();
      const chunks: Buffer[] = [];
      let settled = false;
      const stderrLines: string[] = [];

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const succeed = (buf: Buffer) => {
        if (settled) return;
        settled = true;
        resolve(buf);
      };

      output.on("data", (chunk: Buffer) => chunks.push(chunk));
      output.on("error", fail);

      const cmd = ffmpeg(tempPath);
      if (inputFormat) cmd.inputFormat(inputFormat);
      cmd
        .noVideo()
        .audioCodec("libmp3lame")
        .audioBitrate(128)
        .format("mp3")
        .on("stderr", (line: string) => {
          stderrLines.push(line);
        })
        .on("error", (err: Error) => {
          logger.error(
            {
              err: err.message,
              stderr: stderrLines.slice(-20).join("\n"),
              inputBytes: input.byteLength,
              inputFormat,
            },
            "ffmpeg transcode failed",
          );
          fail(err);
        })
        .on("end", () => {
          const buf = Buffer.concat(chunks);
          if (!buf.byteLength) {
            logger.error(
              {
                stderr: stderrLines.slice(-20).join("\n"),
                inputBytes: input.byteLength,
                inputFormat,
              },
              "ffmpeg transcode produced empty output",
            );
            fail(new Error("ffmpeg transcode produced empty output"));
            return;
          }
          succeed(buf);
        })
        .pipe(output, { end: true });
    });
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

/** @deprecated Use `transcodeToMp3(input)` — input format is auto-detected. */
export async function transcodeOggToMp3(input: Buffer): Promise<Buffer> {
  return transcodeToMp3(input);
}

/**
 * Returns the duration in seconds of an audio buffer using ffprobe.
 * Auto-detects format (mp3/ogg/m4a/wav/webm/…). Returns `null` on failure
 * (corrupt file, unsupported format, ffprobe not available) — callers must
 * decide whether to fall back to a default duration or reject the request.
 *
 * Used for pre-flight cost estimation when the output length depends on
 * the input audio (e.g. HeyGen lip-sync, where billing is per second of
 * the resulting video — which equals the audio length).
 */
export async function probeAudioDurationSec(input: Buffer): Promise<number | null> {
  const tempPath = join(tmpdir(), `metabox-probe-${randomBytes(12).toString("hex")}`);
  await fs.writeFile(tempPath, input);
  try {
    return await new Promise<number | null>((resolve) => {
      ffmpeg.ffprobe(tempPath, (err, data) => {
        if (err) {
          logger.warn({ err: err.message, bytes: input.byteLength }, "ffprobe failed");
          resolve(null);
          return;
        }
        const seconds = data?.format?.duration;
        if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0) {
          resolve(null);
          return;
        }
        resolve(seconds);
      });
    });
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}
