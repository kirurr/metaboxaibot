import type { FastifyInstance } from "fastify";
import { verifyDownloadToken } from "../utils/download-token.js";
import { getFileUrl } from "../services/s3.service.js";

export async function downloadRoutes(fastify: FastifyInstance) {
  // Use wildcard to avoid dot-in-param routing issues (token contains "payload.hmac")
  fastify.get<{ Params: { "*": string } }>(
    "/download/*",
    {
      config: {
        // Отдельный (щедрый) лимит вместо общего 120/мин: грид галереи легко
        // открывает десятки тумб разом, и они НЕ должны делить бюджет с обычными
        // API-запросами — иначе один просмотр галереи валит 429 на весь IP.
        // Токены HMAC-подписаны, user-scoped и истекают, так что свой бакет
        // безопасен.
        rateLimit: { max: 600, timeWindow: "1 minute" },
      },
      schema: {
        hide: true,
        description: "Download file via signed token",
        params: {
          type: "object",
          additionalProperties: true,
          properties: {
            "*": {
              type: "string",
              description: "Encoded download token containing file key, user ID and expiry",
            },
          },
          required: ["*"],
        },
        response: {
          302: { type: "object", additionalProperties: true },
          400: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
          404: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      // URL: `/download/<token>` либо `/download/<token>/<filename>` — имя в
      // хвосте добавляется ради расширения (провайдерам для определения
      // контейнера, и браузеру). Токен (base64url.hex) слешей не содержит —
      // берём часть до первого `/`.
      const star = request.params["*"];
      const slash = star.indexOf("/");
      const token = slash === -1 ? star : star.slice(0, slash);

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

      // Кэшируем 302 на стороне браузера: при стабильном токене (см.
      // download-token.ts) URL не меняется, и повторные рендеры берут редирект
      // из кэша вместо удара по роуту. max-age < PRESIGN_TTL (3600s), чтобы
      // закэшированный редирект не указывал на протухший presigned-S3 URL.
      reply.header("cache-control", "private, max-age=600");
      return reply.redirect(presignedUrl, 302);
    },
  );
}
