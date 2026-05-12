import type { FastifyInstance } from "fastify";
import { verifyDownloadToken } from "../utils/download-token.js";
import { getFileUrl } from "../services/s3.service.js";

export async function downloadRoutes(fastify: FastifyInstance) {
  // Use wildcard to avoid dot-in-param routing issues (token contains "payload.hmac")
  fastify.get<{ Params: { "*": string } }>(
    "/download/*",
    { schema: { hide: true } },
    async (request, reply) => {
      const token = request.params["*"];

      let payload: { k: string; u: string; e: number };
      try {
        payload = verifyDownloadToken(token);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }

      // Extract filename from s3Key (e.g. "image/123/abc.png" → "abc.png")
      const filename = payload.k.split("/").pop() ?? "file";
      const presignedUrl = await getFileUrl(payload.k, filename).catch(() => null);
      if (!presignedUrl) {
        return reply.status(404).send({ error: "File not found or S3 not configured" });
      }

      return reply.redirect(presignedUrl, 302);
    },
  );
}
