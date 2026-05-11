import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { config } from "@metabox/shared";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";

type AuthRequest = { userId: bigint };

/**
 * Admin routes — accessible to users with ADMIN or MODERATOR role,
 * or via legacy x-admin-secret header.
 */
export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
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

  /** POST /admin/block */
  fastify.post<{ Body: { userId: string; blocked: boolean } }>(
    "/admin/block",
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
