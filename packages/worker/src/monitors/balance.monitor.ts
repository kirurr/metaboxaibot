import { Api } from "grammy";
import { config } from "@metabox/shared";
import { logger } from "../logger.js";

interface ProviderStatus {
  name: string;
  ok: boolean;
  message: string;
}

// ── ElevenLabs ────────────────────────────────────────────────────────────────

async function checkElevenlabs(): Promise<ProviderStatus | null> {
  const key = config.ai.elevenlabs;
  if (!key) return null;

  const res = await fetch("https://api.elevenlabs.io/v1/user", {
    headers: { "xi-api-key": key },
  });

  if (!res.ok) throw new Error(`ElevenLabs API returned ${res.status}`);

  const data = (await res.json()) as {
    subscription: { character_count: number; character_limit: number };
  };

  const { character_count, character_limit } = data.subscription;
  const remaining = character_limit - character_count;
  const threshold = config.alerts.elevenlabsThresholdChars;

  return {
    name: "ElevenLabs",
    ok: remaining >= threshold,
    message: `осталось *${remaining.toLocaleString("ru")}* из ${character_limit.toLocaleString("ru")} символов`,
  };
}

// ── FAL.ai ────────────────────────────────────────────────────────────────────
// Endpoint: https://fal.ai/api/billing (Key auth via Authorization header)

async function checkFal(): Promise<ProviderStatus | null> {
  const key = config.ai.fal;
  if (!key) return null;

  const res = await fetch("https://fal.ai/api/billing", {
    headers: { Authorization: `Key ${key}` },
  });

  if (!res.ok) throw new Error(`FAL API returned ${res.status}`);

  const data = (await res.json()) as { balance: number };
  const balance: number = data.balance ?? 0;
  const threshold = config.alerts.falThresholdUsd;

  return {
    name: "FAL.ai",
    ok: balance >= threshold,
    message: `баланс *$${balance.toFixed(2)}*`,
  };
}

// ── Main check ────────────────────────────────────────────────────────────────

export async function checkProviderBalances(): Promise<void> {
  // Баланс-алерты идут в тему BALANCE (config.balanceAlerts), а не в общий
  // alerts-канал. Пороги (elevenlabsThresholdChars / falThresholdUsd) при этом
  // остаются на config.alerts — это настройки проверки, а не назначение.
  const chatId = config.balanceAlerts.chatId;
  if (!chatId) return; // Feature not configured

  const checks: Array<() => Promise<ProviderStatus | null>> = [checkElevenlabs, checkFal];

  const results = await Promise.allSettled(checks.map((fn) => fn()));

  const alerts: string[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn({ err: result.reason }, "Balance check failed");
      continue;
    }
    const status = result.value;
    if (!status) continue; // Provider key not configured

    if (!status.ok) {
      alerts.push(`🔴 *${status.name}*: ${status.message}`);
    } else {
      logger.info({ provider: status.name }, `Balance OK — ${status.message}`);
    }
  }

  if (alerts.length === 0) return;

  const telegram = new Api(config.bot.token);
  const text = `⚠️ *Metabox — низкий баланс провайдера*\n\n${alerts.join("\n")}`;
  await telegram.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    message_thread_id: config.balanceAlerts.threadId,
  });
  logger.warn({ alerts }, "Low balance alert sent");
}
