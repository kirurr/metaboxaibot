/**
 * Admin REST endpoints для управления пулом API-ключей и прокси.
 *
 * Auth: ADMIN-роль или legacy x-admin-secret (как в admin.ts).
 *
 * Cache invalidation: после любой write-операции вызываем invalidatePoolCache(provider)
 * чтобы воркеры подхватили изменения за <30s (TTL локального кэша).
 */
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { config, encryptSecret, maskKey, decryptSecret } from "@metabox/shared";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { extractWebUserFromRequest } from "../middlewares/web-auth.js";
import { invalidatePoolCache } from "../services/key-pool.service.js";
import { clearKeyThrottle } from "../services/throttle.service.js";
import { logger } from "../logger.js";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { constructOpenAPIonRouteHook, badRequestResponse } from "../utils/openapi.js";

type AuthRequest = { userId: bigint };

type ProxyCreateBody = {
  label: string;
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  isActive?: boolean;
  notes?: string;
};
type ProxyUpdateBody = Partial<ProxyCreateBody>;

type KeyCreateBody = {
  provider: string;
  label: string;
  keyValue: string;
  proxyId?: string | null;
  priority?: number;
  isActive?: boolean;
  notes?: string;
};


const VALID_PROTOCOLS = new Set(["http", "https", "socks5"]);

function serializeProxy(p: {
  id: string;
  label: string;
  protocol: string;
  host: string;
  port: number;
  username: string | null;
  passwordCipher: string | null;
  isActive: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    id: p.id,
    label: p.label,
    protocol: p.protocol,
    host: p.host,
    port: p.port,
    hasUsername: !!p.username,
    hasPassword: !!p.passwordCipher,
    isActive: p.isActive,
    notes: p.notes,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function serializeKey(k: {
  id: string;
  provider: string;
  label: string;
  keyMask: string;
  proxyId: string | null;
  priority: number;
  isActive: boolean;
  notes: string | null;
  requestCount: bigint;
  errorCount: bigint;
  lastUsedAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorText: string | null;
  createdAt: Date;
  updatedAt: Date;
  proxy?: { id: string; label: string } | null;
}): Record<string, unknown> {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    keyMask: k.keyMask,
    proxyId: k.proxyId,
    proxy: k.proxy ? { id: k.proxy.id, label: k.proxy.label } : null,
    priority: k.priority,
    isActive: k.isActive,
    notes: k.notes,
    requestCount: k.requestCount.toString(),
    errorCount: k.errorCount.toString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    lastErrorAt: k.lastErrorAt?.toISOString() ?? null,
    lastErrorText: k.lastErrorText,
    createdAt: k.createdAt.toISOString(),
    updatedAt: k.updatedAt.toISOString(),
  };
}

export async function adminKeysRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["admin-keys"]),
  );

  fastify.addHook("preHandler", async (request, reply) => {
    const secret = config.api.adminSecret;
    const provided = request.headers["x-admin-secret"];
    if (secret && provided === secret) return;

    const authHeader = request.headers.authorization ?? "";
    let userId: bigint | null = null;

    if (authHeader.startsWith("Bearer ")) {
      const webUser = await extractWebUserFromRequest(request);
      if (!webUser || webUser.aibUserId === null) {
        await reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      userId = webUser.aibUserId;
    } else if (authHeader.startsWith("tma ") || authHeader.startsWith("wtoken ")) {
      try {
        await telegramAuthHook(request, reply);
      } catch {
        await reply.status(403).send({ error: "Forbidden" });
        return;
      }
      userId = (request as unknown as AuthRequest).userId ?? null;
      if (userId === null) return;
    } else {
      await reply.status(401).send({ error: "Unauthorized" });
      return;
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!user || user.role !== "ADMIN") {
      await reply.status(403).send({ error: "Forbidden" });
    }
  });

  // ── Proxies ──────────────────────────────────────────────────────────────
  fastify.get(
    "/admin/proxies",
    {
      schema: {
        description: "Get all proxies ordered by creation date",
        response: {
          200: {
            type: "object",
            properties: {
              proxies: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Proxy ID" },
                    label: { type: "string", description: "Human-readable label" },
                    protocol: { type: "string", description: "Protocol: http, https, or socks5" },
                    host: { type: "string", description: "Proxy hostname" },
                    port: { type: "number", description: "Proxy port" },
                    hasUsername: { type: "boolean", description: "Whether username is set" },
                    hasPassword: { type: "boolean", description: "Whether password is set" },
                    isActive: { type: "boolean", description: "Whether proxy is active" },
                    notes: { type: "string", nullable: true, description: "Admin notes" },
                    createdAt: { type: "string", description: "Creation timestamp" },
                    updatedAt: { type: "string", description: "Last update timestamp" },
                  },
                  required: [
                    "id",
                    "label",
                    "protocol",
                    "host",
                    "port",
                    "hasUsername",
                    "hasPassword",
                    "isActive",
                    "notes",
                    "createdAt",
                    "updatedAt",
                  ],
                },
              },
            },
            required: ["proxies"],
          },
        },
      },
    },
    async () => {
      const proxies = await db.proxy.findMany({ orderBy: { createdAt: "desc" } });
      return { proxies: proxies.map(serializeProxy) };
    },
  );

  fastify.post<{ Body: ProxyCreateBody }>(
    "/admin/proxies",
    {
      schema: {
        description: "Create a new proxy",
        body: {
          type: "object",
          properties: {
            label: { type: "string", description: "Human-readable label" },
            protocol: {
              type: "string",
              enum: ["http", "https", "socks5"],
              description: "Protocol",
            },
            host: { type: "string", description: "Proxy hostname or IP" },
            port: { type: "number", description: "Proxy port" },
            username: { type: "string", description: "Optional username for auth" },
            password: { type: "string", description: "Optional password for auth" },
            isActive: { type: "boolean", description: "Whether proxy is active (default true)" },
            notes: { type: "string", description: "Optional admin notes" },
          },
          required: ["label", "protocol", "host", "port"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              proxy: { type: "object" },
            },
            required: ["proxy"],
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const b = request.body;
      if (!b?.label || !b?.protocol || !b?.host || !b?.port) {
        await reply.status(400).send({ error: "label, protocol, host, port required" });
        return;
      }
      if (!VALID_PROTOCOLS.has(b.protocol)) {
        await reply.status(400).send({ error: "protocol must be http|https|socks5" });
        return;
      }
      const proxy = await db.proxy.create({
        data: {
          label: b.label,
          protocol: b.protocol,
          host: b.host,
          port: b.port,
          username: b.username ? encryptSecret(b.username) : null,
          passwordCipher: b.password ? encryptSecret(b.password) : null,
          isActive: b.isActive ?? true,
          notes: b.notes ?? null,
        },
      });
      invalidatePoolCache();
      return { proxy: serializeProxy(proxy) };
    },
  );

  fastify.patch<{ Params: { id: string }; Body: ProxyUpdateBody }>(
    "/admin/proxies/:id",
    {
      schema: {
        description: "Update an existing proxy",
        params: {
          type: "object",
          properties: { id: { type: "string", description: "Proxy ID" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            label: { type: "string", description: "Human-readable label" },
            protocol: {
              type: "string",
              enum: ["http", "https", "socks5"],
              description: "Protocol",
            },
            host: { type: "string", description: "Proxy hostname or IP" },
            port: { type: "number", description: "Proxy port" },
            username: { type: "string", description: "Optional username for auth" },
            password: { type: "string", description: "Optional password for auth" },
            isActive: { type: "boolean", description: "Whether proxy is active" },
            notes: { type: "string", description: "Optional admin notes" },
          },
        },
        response: {
          200: { type: "object", properties: { proxy: { type: "object" } }, required: ["proxy"] },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const b = request.body;
      const { id } = request.params;
      if (b.protocol && !VALID_PROTOCOLS.has(b.protocol)) {
        await reply.status(400).send({ error: "protocol must be http|https|socks5" });
        return;
      }
      const data: Record<string, unknown> = {};
      if (b.label !== undefined) data.label = b.label;
      if (b.protocol !== undefined) data.protocol = b.protocol;
      if (b.host !== undefined) data.host = b.host;
      if (b.port !== undefined) data.port = b.port;
      if (b.username !== undefined) data.username = b.username ? encryptSecret(b.username) : null;
      if (b.password !== undefined)
        data.passwordCipher = b.password ? encryptSecret(b.password) : null;
      if (b.isActive !== undefined) data.isActive = b.isActive;
      if (b.notes !== undefined) data.notes = b.notes;

      const proxy = await db.proxy.update({ where: { id }, data });
      invalidatePoolCache();
      return { proxy: serializeProxy(proxy) };
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/admin/proxies/:id",
    {
      schema: {
        description: "Delete a proxy",
        params: {
          type: "object",
          properties: { id: { type: "string", description: "Proxy ID" } },
          required: ["id"],
        },
        response: {
          200: {
            type: "object",
            properties: { success: { type: "boolean" } },
            required: ["success"],
          },
          409: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const inUse = await db.providerKey.count({ where: { proxyId: id } });
      if (inUse > 0) {
        await reply
          .status(409)
          .send({ error: `Proxy is used by ${inUse} provider key(s); detach them first` });
        return;
      }
      await db.proxy.delete({ where: { id } });
      invalidatePoolCache();
      return { success: true };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/admin/proxies/:id/test",
    {
      schema: {
        description: "Test proxy connectivity",
        params: {
          type: "object",
          properties: { id: { type: "string", description: "Proxy ID" } },
          required: ["id"],
        },
        response: {
          200: {
            type: "object",
            properties: { ok: { type: "boolean" }, ip: { type: "string" } },
            required: ["ok", "ip"],
          },
          404: { type: "object", properties: { error: { type: "string" } } },
          502: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              status: { type: "number" },
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const proxy = await db.proxy.findUnique({ where: { id: request.params.id } });
      if (!proxy) {
        await reply.status(404).send({ error: "Proxy not found" });
        return;
      }
      const username = proxy.username ? decryptSecret(proxy.username) : undefined;
      const password = proxy.passwordCipher ? decryptSecret(proxy.passwordCipher) : undefined;
      const auth =
        username && password
          ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
          : "";
      const uri = `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
      try {
        const agent = new ProxyAgent({ uri });
        const res = await undiciFetch("https://api.ipify.org?format=json", {
          dispatcher: agent,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          await reply.status(502).send({ ok: false, status: res.status });
          return;
        }
        const json = (await res.json()) as { ip: string };
        return { ok: true, ip: json.ip };
      } catch (err) {
        logger.warn({ err, proxyId: proxy.id }, "admin proxy test failed");
        await reply
          .status(502)
          .send({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ── Provider keys ────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { provider?: string } }>(
    "/admin/provider-keys",
    {
      schema: {
        description: "Get all provider keys with optional filter",
        querystring: {
          type: "object",
          properties: { provider: { type: "string", description: "Filter by provider name" } },
        },
        response: {
          200: {
            type: "object",
            properties: { keys: { type: "array", items: { type: "object" } } },
            required: ["keys"],
          },
        },
      },
    },
    async (request) => {
      const where = request.query.provider ? { provider: request.query.provider } : {};
      const keys = await db.providerKey.findMany({
        where,
        orderBy: [{ provider: "asc" }, { priority: "desc" }, { createdAt: "asc" }],
        include: { proxy: { select: { id: true, label: true } } },
      });
      return { keys: keys.map(serializeKey) };
    },
  );

  fastify.post<{ Body: KeyCreateBody }>(
    "/admin/provider-keys",
    {
      schema: {
        description: "Create a new provider key",
        body: {
          type: "object",
          properties: {
            provider: { type: "string", description: "Provider name (e.g., openai, anthropic)" },
            label: { type: "string", description: "Human-readable label" },
            keyValue: { type: "string", description: "Actual API key value" },
            proxyId: { type: "string", nullable: true, description: "Optional proxy ID to attach" },
            priority: { type: "number", description: "Priority (higher = used first, default 0)" },
            isActive: { type: "boolean", description: "Whether key is active (default true)" },
            notes: { type: "string", description: "Optional admin notes" },
          },
          required: ["provider", "label", "keyValue"],
        },
        response: {
          200: { type: "object", properties: { key: { type: "object" } }, required: ["key"] },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const b = request.body;
      if (!b?.provider || !b?.label || !b?.keyValue) {
        await reply.status(400).send({ error: "provider, label, keyValue required" });
        return;
      }
      if (b.proxyId) {
        const proxy = await db.proxy.findUnique({ where: { id: b.proxyId } });
        if (!proxy) {
          await reply.status(400).send({ error: "proxyId not found" });
          return;
        }
      }
      const key = await db.providerKey.create({
        data: {
          provider: b.provider,
          label: b.label,
          keyCipher: encryptSecret(b.keyValue),
          keyMask: maskKey(b.keyValue),
          proxyId: b.proxyId ?? null,
          priority: b.priority ?? 0,
          isActive: b.isActive ?? true,
          notes: b.notes ?? null,
        },
        include: { proxy: { select: { id: true, label: true } } },
      });
      invalidatePoolCache(b.provider);
      return { key: serializeKey(key) };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/admin/provider-keys/:id/clear-throttle",
    {
      schema: {
        description: "Clear throttle/cooldown for a provider key",
        params: {
          type: "object",
          properties: { id: { type: "string", description: "Key ID" } },
          required: ["id"],
        },
        response: {
          200: {
            type: "object",
            properties: { success: { type: "boolean" } },
            required: ["success"],
          },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const exists = await db.providerKey.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (!exists) {
        await reply.status(404).send({ error: "Key not found" });
        return;
      }
      await clearKeyThrottle(request.params.id);
      return { success: true };
    },
  );

  fastify.get(
    "/admin/providers",
    {
      schema: {
        description: "Get summary of active keys per provider",
        response: {
          200: {
            type: "object",
            properties: {
              providers: {
                type: "array",
                items: {
                  type: "object",
                  properties: { provider: { type: "string" }, activeKeyCount: { type: "number" } },
                  required: ["provider", "activeKeyCount"],
                },
              },
            },
            required: ["providers"],
          },
        },
      },
    },
    async () => {
      const grouped = await db.providerKey.groupBy({
        by: ["provider"],
        _count: { _all: true },
        where: { isActive: true },
      });
      const providers = grouped.map((g) => ({
        provider: g.provider,
        activeKeyCount: g._count._all,
      }));
      return { providers };
    },
  );
}
