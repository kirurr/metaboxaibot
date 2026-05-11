import type { FastifyInstance } from "fastify";
import { verifyDownloadToken } from "../utils/download-token.js";
import { getFileUrl } from "../services/s3.service.js";
import { constructOpenAPIonRouteHook } from "../utils/openapi.js";

export async function downloadRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["download"]),
  );

  // Use wildcard to avoid dot-in-param routing issues (token contains "payload.hmac")
  fastify.get<{ Params: { "*": string } }>(
    "/download/*",
    {
      schema: {
        description: "Download file via signed token",
        params: {
          type: "object",
          properties: {
            "*": { type: "string", description: "Signed download token" },
          },
          required: ["*"],
        },
        response: {
          302: {
            description: "Redirect to presigned S3 URL",
          },
          400: {
            type: "object",
            properties: {
              error: { type: "string", description: "Invalid or expired token" },
            },
          },
          404: {
            type: "object",
            properties: {
              error: { type: "string", description: "File not found or S3 not configured" },
            },
          },
        },
      },
    },
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
