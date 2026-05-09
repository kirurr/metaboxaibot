import { getRedis } from "../redis.js";

const PREFIX = "media-hint:";
// 7 дней — больше пользы держать ключ нет: если юзер не вернулся за неделю,
// сообщение в чате уже потеряло актуальность, спокойно отпускаем.
const TTL_SECONDS = 7 * 24 * 60 * 60;

type Section = "design" | "video";

function key(userId: bigint, section: Section): string {
  return `${PREFIX}${userId.toString()}:${section}`;
}

export const mediaHintService = {
  async get(userId: bigint, section: Section): Promise<number | null> {
    const raw = await getRedis()
      .get(key(userId, section))
      .catch(() => null);
    if (!raw) return null;
    const id = Number.parseInt(raw, 10);
    return Number.isFinite(id) ? id : null;
  },

  async set(userId: bigint, section: Section, messageId: number): Promise<void> {
    await getRedis()
      .set(key(userId, section), String(messageId), "EX", TTL_SECONDS)
      .catch(() => null);
  },

  async clear(userId: bigint, section: Section): Promise<void> {
    await getRedis()
      .del(key(userId, section))
      .catch(() => null);
  },
};
