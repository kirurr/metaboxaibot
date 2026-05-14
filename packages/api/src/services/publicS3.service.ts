import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { config } from "@metabox/shared";
import { logger } from "../logger.js";
import { withRetry } from "./s3.service.js";

function makePublicClient(): S3Client | null {
  const { bucket, region, endpoint, accessKeyId, secretAccessKey } = config.s3Public;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;

  const client = new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: !!endpoint,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  // Mirror the private client's checksum-mode strip — see s3.service.ts for
  // the rationale. Without it Wasabi/R2 reject the request with 403 because
  // the auto-added `x-amz-checksum-mode` header was not part of the signature.
  client.middlewareStack.add(
    (next) => async (args) => {
      const req = args.request as { headers?: Record<string, string> };
      if (req?.headers) {
        delete req.headers["x-amz-checksum-mode"];
        delete req.headers["X-Amz-Checksum-Mode"];
      }
      return next(args);
    },
    {
      step: "build",
      name: "stripChecksumModeHeader",
      priority: "high",
      override: true,
    },
  );

  return client;
}

/**
 * Upload a Buffer to the PUBLIC S3 bucket. Retries once on transient errors.
 * Returns the S3 key on success, null if the public bucket is not configured.
 * Throws after two failed attempts — callers decide how to recover.
 */
export async function uploadBuffer(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<string | null> {
  const client = makePublicClient();
  if (!client) {
    logger.warn({ key }, "publicS3.uploadBuffer: public S3 not configured, skipping");
    return null;
  }

  await withRetry("publicS3.uploadBuffer", { key, contentType, size: buffer.byteLength }, () =>
    client.send(
      new PutObjectCommand({
        Bucket: config.s3Public.bucket!,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    ),
  );

  return key;
}

/**
 * Returns a direct public URL to an object in the public bucket.
 * Returns null if `S3_PUBLIC_URL` is not configured.
 */
export function getFileUrl(key: string): string | null {
  const { publicUrl } = config.s3Public;
  if (!publicUrl) {
    logger.warn({ key }, "publicS3.getFileUrl: S3_PUBLIC_URL not configured");
    return null;
  }
  return `${publicUrl.replace(/\/$/, "")}/${key}`;
}

export const publicS3Service = {
  uploadBuffer,
  getFileUrl,
};
