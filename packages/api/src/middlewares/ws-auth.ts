import type { ExtendedError } from "socket.io";
import type { Socket } from "../utils/ws.js";
import { verifyAccessToken } from "../services/web-session.service.js";
import { db } from "../db.js";
/**
 * Auth middleware — runs before "connection"
 * Client must pass token in socket.handshake.auth.token or Authorization header
 * Adds socket.data.webUser
 * */
export async function wsAuthMiddleware(socket: Socket, next: (err?: ExtendedError) => void) {
  const token: string | undefined =
    socket.handshake.auth?.token ||
    socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, "");

  if (!token) return next(new Error("Unauthorized"));

  try {
    const claims = verifyAccessToken(token);

    let aibUserId: bigint | null = null;
    if (claims.aib) {
      const user = await db.user.findUnique({
        where: { id: BigInt(claims.aib) },
        select: { id: true, isBlocked: true },
      });
      if (!user || user.isBlocked) return next(new Error("Unauthorized"));
      aibUserId = user.id;
    }

    socket.data.webUser = { metaboxUserId: claims.sub, aibUserId, sessionId: claims.sid };
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
}
