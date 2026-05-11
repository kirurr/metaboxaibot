import type { FastifyPluginAsync } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { acquireKey } from "../services/key-pool.service.js";
import { PoolExhaustedError } from "../utils/pool-exhausted-error.js";

interface HeyGenLookItem {
  id: string;
  name: string;
  gender?: string | null;
  preview_image_url?: string | null;
}

interface HeyGenLooksPage {
  data?: HeyGenLookItem[];
  has_more?: boolean;
  next_token?: string | null;
}

interface MappedAvatar {
  avatar_id: string;
  avatar_name: string;
  gender: string;
  preview_image_url: string | null;
}

async function fetchOnePage(
  apiKey: string,
  cursor: string | undefined,
  pageSize: number,
): Promise<{ raw: HeyGenLookItem[]; has_more: boolean; next_token: string | null }> {
  const url = new URL("https://api.heygen.com/v3/avatars/looks");
  url.searchParams.set("ownership", "public");
  url.searchParams.set("limit", String(pageSize));
  if (cursor) url.searchParams.set("token", cursor);

  const res = await fetch(url.toString(), {
    headers: { "X-Api-Key": apiKey, Accept: "application/json" },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HeyGen /v3/avatars/looks error: ${res.status} ${text}`);
  }

  const page = (await res.json()) as HeyGenLooksPage;
  return {
    raw: page.data ?? [],
    has_more: page.has_more ?? false,
    next_token: page.next_token ?? null,
  };
}

function applyFilters(
  items: HeyGenLookItem[],
  gender: string | undefined,
  search: string | undefined,
): MappedAvatar[] {
  const genderLower = gender?.toLowerCase();
  const searchLower = search?.toLowerCase();
  return items
    .filter((l) => {
      if (genderLower && genderLower !== "all") {
        if ((l.gender ?? "").toLowerCase() !== genderLower) return false;
      }
      if (searchLower) {
        if (!l.name.toLowerCase().includes(searchLower)) return false;
      }
      return true;
    })
    .map((l) => ({
      avatar_id: l.id,
      avatar_name: l.name,
      gender: l.gender ?? "",
      preview_image_url: l.preview_image_url ?? null,
    }));
}

export const heygenAvatarsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);

  /**
   * GET /heygen-avatars — paginated public avatar list with server-side filtering.
   *
   * When filters (gender/search) are active the server keeps fetching HeyGen pages
   * until it has collected `limit` matching items or exhausted the full list.
   *
   * Query params:
   *   token  — opaque cursor returned by a previous response (omit for first page)
   *   limit  — desired number of matching items (default 20, max 50)
   *   gender — filter: Man | Woman (omit / "all" for no filter)
   *   search — name substring (case-insensitive)
   *
   * Response: { items, has_more, next_token }
   *   next_token — pass back on the next request to continue from where we left off
   */
  fastify.get<{
    Querystring: { token?: string; limit?: string; gender?: string; search?: string };
  }>("/heygen-avatars", async (request, reply) => {
    let apiKey: string;
    try {
      apiKey = (await acquireKey("heygen")).apiKey;
    } catch (err) {
      if (err instanceof PoolExhaustedError) {
        return reply.status(503).send({ error: "HeyGen API key not configured" });
      }
      throw err;
    }

    const { token, gender, search } = request.query;
    const limit = Math.min(50, Math.max(1, parseInt(request.query.limit ?? "20", 10) || 20));
    const hasFilters = (gender && gender !== "all") || !!search;

    const collected: MappedAvatar[] = [];
    let cursor: string | undefined = token || undefined;
    let heygHasMore = true;

    try {
      // Keep fetching until we have enough matching items or HeyGen has no more pages
      while (collected.length < limit && heygHasMore) {
        const page = await fetchOnePage(apiKey, cursor, 50);
        const matched = applyFilters(page.raw, gender, search);
        collected.push(...matched);
        heygHasMore = page.has_more;
        cursor = page.next_token ?? undefined;

        // Without filters a single page is always exactly what we return
        if (!hasFilters) break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: msg });
    }

    // Trim to requested limit; if we collected more, there are still more results
    const items = collected.slice(0, limit);
    const overflow = collected.length > limit;

    return {
      items,
      has_more: overflow || heygHasMore,
      // When we overflowed, the cursor stays at current position (client will re-request from here)
      next_token: overflow || heygHasMore ? (cursor ?? null) : null,
    };
  });
};
