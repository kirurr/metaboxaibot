/**
 * /web/* статистика для ai.metabox.global (packages/web).
 *
 * Сейчас здесь только дневной расход токенов для графика на странице Tokens.
 * Используем `webAuthPreHandler` (как у `/auth/web-transactions`), а не
 * `webTelegramLinkedPreHandler`: web-only юзеру (aibUserId === null) отдаём
 * пустой массив, чтобы страница рендерилась без 403.
 */

import type { FastifyPluginAsync } from "fastify";
import { db } from "../db.js";
import { webAuthPreHandler } from "../middlewares/web-auth.js";
import { constructOpenAPIonRouteHook } from "../utils/openapi.js";

/** Сколько дней показываем на графике использования. */
const USAGE_DAYS = 28;
/** Зона для суток: UI на ru-RU, у Москвы нет DST (фикс. UTC+3). */
const USAGE_TZ = "Europe/Moscow";

const moscowDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: USAGE_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "YYYY-MM-DD" для даты в зоне Москвы (en-CA даёт ISO-формат). */
function moscowDay(d: Date): string {
  return moscowDayFmt.format(d);
}

/** "12.3400" → "12.34", "5.0000" → "5", "0" → "0". Точно, без округления. */
function trimDecimal(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

interface DailyRow {
  day: string;
  spent: string;
}

export const webStatsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["stats"]),
  );

  // ── GET /web/usage-daily ──────────────────────────────────────────────────
  // Дневной расход токенов (списания, amount < 0) за последние 28 дней.
  // Возвращаем ровно USAGE_DAYS элементов (старый→новый) с zero-fill, чтобы
  // фронт не дублировал работу с датами.
  fastify.get(
    "/web/usage-daily",
    {
      preHandler: webAuthPreHandler,
      schema: {
        description: "Daily token spend (last 28 days) for the Tokens usage chart",
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              data: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: true,
                  properties: {
                    date: { type: "string" },
                    spent: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { aibUserId } = request.webUser!;
      if (aibUserId === null) {
        return reply.send({ data: [] });
      }

      // 28 дней-ключей (старый→новый) в зоне Москвы.
      const now = new Date();
      const days: string[] = [];
      for (let i = USAGE_DAYS - 1; i >= 0; i--) {
        days.push(moscowDay(new Date(now.getTime() - i * 86_400_000)));
      }

      // Запас в один день — границы суток в Москве не совпадают с UTC.
      const startDate = new Date(now.getTime() - (USAGE_DAYS + 1) * 86_400_000);

      const rows = await db.$queryRaw<DailyRow[]>`
        SELECT to_char(date_trunc('day', "createdAt" AT TIME ZONE ${USAGE_TZ}), 'YYYY-MM-DD') AS day,
               SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END)::text AS spent
        FROM token_transactions
        WHERE "userId" = ${aibUserId} AND "createdAt" >= ${startDate}
        GROUP BY day
      `;

      const byDay = new Map(rows.map((r) => [r.day, trimDecimal(r.spent)]));
      const data = days.map((date) => ({ date, spent: byDay.get(date) ?? "0" }));

      return reply.send({ data });
    },
  );
};
