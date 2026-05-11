import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { config } from "@metabox/shared";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import {
  constructOpenAPIonRouteHook,
  forbiddenResponse,
} from "../utils/openapi.js";

type AuthRequest = { userId: bigint };

/**
 * Admin routes — accessible to users with ADMIN or MODERATOR role,
 * or via legacy x-admin-secret header.
 */
export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["admin"]),
  );

  fastify.addHook("preHandler", async (request, reply) => {
    // Legacy: secret-based auth
    const secret = config.api.adminSecret;
    const provided = request.headers["x-admin-secret"];
    if (secret && provided === secret) return;

    // Role-based auth via Telegram initData
    try {
      await telegramAuthHook(request, reply);
    } catch {
      await reply.status(403).send({ error: "Forbidden" });
      return;
    }

    const { userId } = request as unknown as AuthRequest;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!user || (user.role !== "ADMIN" && user.role !== "MODERATOR")) {
      await reply.status(403).send({ error: "Forbidden" });
    }
  });

  /** GET /admin/users?page=1&limit=50&search=john */
  fastify.get<{ Querystring: { page?: string; limit?: string; search?: string } }>(
    "/admin/users",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            page: { type: "string", description: "Page number, starts from 1" },
            limit: { type: "string", description: "Items per page, max 100" },
            search: { type: "string", description: "Search by username, firstName, or lastName" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              users: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "User ID" },
                    username: { type: "string", nullable: true, description: "Telegram username" },
                    firstName: { type: "string", nullable: true, description: "User's first name" },
                    tokenBalance: { type: "string", description: "Current token balance" },
                    role: { type: "string", description: "User role: USER, MODERATOR, or ADMIN" },
                    isBlocked: { type: "boolean", description: "Whether user is blocked" },
                    createdAt: { type: "string", description: "Account creation timestamp" },
                  },
                  required: ["id", "username", "firstName", "tokenBalance", "role", "isBlocked", "createdAt"],
                },
              },
              total: { type: "number", description: "Total number of users matching the filter" },
              page: { type: "number", description: "Current page number" },
              limit: { type: "number", description: "Items per page" },
            },
            required: ["users", "total", "page", "limit"],
          },
        },
      },
    },
    async (request) => {
      const page = Math.max(1, Number(request.query.page ?? 1));
      const limit = Math.min(100, Number(request.query.limit ?? 50));
      const search = request.query.search?.trim();

      const where = search
        ? {
            OR: [
              { username: { contains: search, mode: "insensitive" as const } },
              { firstName: { contains: search, mode: "insensitive" as const } },
              { lastName: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {};

      const [users, total] = await Promise.all([
        db.user.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            username: true,
            firstName: true,
            tokenBalance: true,
            role: true,
            isBlocked: true,
            createdAt: true,
          },
        }),
        db.user.count({ where }),
      ]);
      return {
        users: users.map((u) => ({
          ...u,
          id: u.id.toString(),
          tokenBalance: u.tokenBalance.toString(),
          createdAt: u.createdAt.toISOString(),
        })),
        total,
        page,
        limit,
      };
    },
  );

  /** POST /admin/grant — grant tokens to a user */
  fastify.post<{ Body: { userId: string; amount: number; reason?: string } }>(
    "/admin/grant",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            userId: { type: "string", description: "Target user's ID" },
            amount: { type: "number", description: "Positive amount of tokens to grant" },
            reason: { type: "string", description: "Reason for granting tokens" },
          },
          required: ["userId", "amount"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              newBalance: { type: "string", description: "User's new token balance" },
            },
            required: ["success", "newBalance"],
          },
          400: {
            description: "Bad request - userId and positive amount required",
            type: "object",
            properties: {
              error: { type: "string", const: "userId and positive amount required" },
            },
          },
          403: forbiddenResponse,
          404: {
            description: "User not found",
            type: "object",
            properties: {
              error: { type: "string", const: "User not found" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { userId, amount, reason } = request.body;
      if (!userId || !amount || amount <= 0) {
        await reply.status(400).send({ error: "userId and positive amount required" });
        return;
      }
      const user = await db.user.findUnique({ where: { id: BigInt(userId) } });
      if (!user) {
        await reply.status(404).send({ error: "User not found" });
        return;
      }
      const [updated] = await db.$transaction([
        db.user.update({
          where: { id: user.id },
          data: { tokenBalance: { increment: amount } },
        }),
        db.tokenTransaction.create({
          data: {
            userId: user.id,
            type: "credit",
            amount,
            reason: reason ?? "admin",
          },
        }),
      ]);
      return { success: true, newBalance: updated.tokenBalance.toString() };
    },
  );

  /** POST /admin/block - block or unblock a user */
  fastify.post<{ Body: { userId: string; blocked: boolean } }>(
    "/admin/block",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            userId: { type: "string", description: "Target user's ID" },
            blocked: { type: "boolean", description: "Set to true to block, false to unblock" },
          },
          required: ["userId", "blocked"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              isBlocked: { type: "boolean", description: "Current blocked status" },
            },
            required: ["success", "isBlocked"],
          },
          400: {
            description: "Bad request - userId required",
            type: "object",
            properties: {
              error: { type: "string", const: "userId required" },
            },
          },
          403: forbiddenResponse,
          404: {
            description: "User not found",
            type: "object",
            properties: {
              error: { type: "string", const: "User not found" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { userId, blocked } = request.body;
      if (!userId) {
        await reply.status(400).send({ error: "userId required" });
        return;
      }
      const user = await db.user.findUnique({ where: { id: BigInt(userId) } });
      if (!user) {
        await reply.status(404).send({ error: "User not found" });
        return;
      }
      await db.user.update({
        where: { id: user.id },
        data: { isBlocked: blocked },
      });
      return { success: true, isBlocked: blocked };
    },
  );

  /** POST /admin/role — change user role (ADMIN only) */
  fastify.post<{ Body: { userId: string; role: string } }>(
    "/admin/role",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            userId: { type: "string", description: "Target user's ID" },
            role: { type: "string", enum: ["USER", "MODERATOR", "ADMIN"], description: "New role to assign" },
          },
          required: ["userId", "role"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
            },
            required: ["success"],
          },
          400: {
            description: "Bad request",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
          403: {
            description: "Forbidden - only admins can change user roles",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
          404: {
            description: "User not found",
            type: "object",
            properties: {
              error: { type: "string", const: "User not found" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { userId, role } = request.body;
      if (!userId || !role) {
        await reply.status(400).send({ error: "userId and role required" });
        return;
      }

      const validRoles = ["USER", "MODERATOR", "ADMIN"];
      if (!validRoles.includes(role)) {
        await reply.status(400).send({ error: "Invalid role. Must be USER, MODERATOR, or ADMIN" });
        return;
      }

      // Only ADMIN can change roles
      const requesterId = (request as unknown as AuthRequest).userId;
      if (requesterId) {
        const requester = await db.user.findUnique({
          where: { id: requesterId },
          select: { role: true },
        });
        if (!requester || requester.role !== "ADMIN") {
          await reply.status(403).send({ error: "Only admins can change user roles" });
          return;
        }
      }

      const user = await db.user.findUnique({ where: { id: BigInt(userId) } });
      if (!user) {
        await reply.status(404).send({ error: "User not found" });
        return;
      }

      await db.user.update({
        where: { id: user.id },
        data: { role: role as "USER" | "MODERATOR" | "ADMIN" },
      });

      return { success: true };
    },
  );
}
