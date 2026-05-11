/**
 * Exchange rate service — fetches USDT/RUB from Binance, stores in DB.
 *
 * Schedule: 4× daily at 00:00, 06:00, 12:00, 18:00 MSK (UTC+3).
 * Rate is adjusted by –2.5% to account for exchange commission.
 *
 * Note: расчёт звёзд больше НЕ использует этот курс (см. `calcStars` ниже —
 * считается из `config.payments.starPriceRub` напрямую в рублях). Курс
 * остаётся для информационных целей / возможной аналитики.
 */

import { db } from "../db.js";
import { config } from "@metabox/shared";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Commission deduction from exchange rate (2.5%) */
const EXCHANGE_COMMISSION = 0.025;

/** Binance ticker endpoint */
const BINANCE_URL = "https://api.binance.com/api/v3/ticker/price";

/** Fallback free API for USD/RUB */
const FALLBACK_URL = "https://open.er-api.com/v6/latest/USD";

/** In-memory cache */
let cachedRate: number | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** Track last update hour (MSK) to avoid double updates */
let lastUpdateHourMSK = -1;

// ── Fetch rate from Binance ───────────────────────────────────────────────────

async function fetchBinanceUsdtRub(): Promise<number | null> {
  try {
    // Binance may not have USDTRUB directly, try USDTRUB first
    const res = await fetch(`${BINANCE_URL}?symbol=USDTRUB`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { price: string };
      return parseFloat(data.price);
    }
  } catch {
    // ignore
  }

  try {
    // Fallback: try USDTUSDT × USD/RUB from free API
    const res = await fetch(FALLBACK_URL, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = (await res.json()) as { rates?: { RUB?: number } };
      if (data.rates?.RUB) {
        return data.rates.RUB;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Fetch rate from external API, apply –2.5% commission, save to DB. */
export async function updateRate(): Promise<number | null> {
  const rawRate = await fetchBinanceUsdtRub();
  if (!rawRate) {
    console.warn("[exchange-rate] Failed to fetch rate from all sources");
    return null;
  }

  // Apply –2.5% commission
  const adjustedRate = rawRate * (1 - EXCHANGE_COMMISSION);

  await db.exchangeRate.upsert({
    where: { pair: "USDT_RUB" },
    update: { rate: adjustedRate },
    create: { pair: "USDT_RUB", rate: adjustedRate },
  });

  cachedRate = adjustedRate;
  cacheTime = Date.now();
  console.log(
    `[exchange-rate] Updated USDT/RUB: raw=${rawRate.toFixed(2)} → adjusted=${adjustedRate.toFixed(2)} (−${EXCHANGE_COMMISSION * 100}%)`,
  );

  return adjustedRate;
}

/** Get current USDT/RUB rate (from cache or DB). */
export async function getRate(): Promise<number> {
  if (cachedRate && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedRate;
  }

  const row = await db.exchangeRate.findUnique({ where: { pair: "USDT_RUB" } });
  const rate = row ? Number(row.rate) : 92;
  cachedRate = rate;
  cacheTime = Date.now();
  return rate;
}

/**
 * Calculate Telegram Stars price from RUB price.
 * Делит цену в RUB на `config.payments.starPriceRub` (RUB за 1 Star) и
 * округляет вверх до десятки (e.g. 1297 → 1300, 1367 → 1370).
 *
 * Раньше принимал второй аргумент `usdtRubRate` и шёл через USD —
 * избавились от лишнего звена, чтобы цена не зависела от Binance-курса
 * и могла настраиваться одной env-переменной.
 */
export function calcStars(priceRub: number): number {
  const rawStars = priceRub / config.payments.starPriceRub;
  return Math.ceil(rawStars / 10) * 10;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/** MSK hours at which rate should be updated */
const UPDATE_HOURS_MSK = [0, 6, 12, 18];

function getMSKHour(): number {
  const now = new Date();
  // MSK = UTC+3
  const mskOffset = 3 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const mskMinutes = utcMinutes + mskOffset;
  return Math.floor((((mskMinutes % 1440) + 1440) % 1440) / 60);
}

/** Called every 15 min from setInterval. Checks if it's time to update. */
export async function checkAndUpdate(): Promise<void> {
  const mskHour = getMSKHour();

  if (UPDATE_HOURS_MSK.includes(mskHour) && lastUpdateHourMSK !== mskHour) {
    lastUpdateHourMSK = mskHour;
    await updateRate();
  }
}

/** Start the exchange rate scheduler. Call once on app startup. */
export function startRateScheduler(): void {
  // Fetch immediately on startup
  updateRate().catch((e) => console.error("[exchange-rate] Startup fetch failed:", e));

  // Check every 15 minutes
  setInterval(
    () => {
      checkAndUpdate().catch((e) => console.error("[exchange-rate] Scheduled update failed:", e));
    },
    15 * 60 * 1000,
  );
}
