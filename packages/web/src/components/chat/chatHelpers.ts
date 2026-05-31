import type { DialogDto, MessageDto } from "@/api/dialogs";
import type { WebModelDto } from "@/api/models";
import type { Msg } from "./chatTypes";

/** Локализованный fallback для title диалога (когда `title === null`). */
export function dialogTitle(d: DialogDto, fallback: string): string {
  return d.title ?? fallback;
}

export function modelDisplayName(m: WebModelDto): string {
  return m.familyName ?? m.webName;
}

export function modelDesc(m: WebModelDto): string {
  // Приоритет — краткий тэглайн (локализованный), иначе полное описание (уже
  // override-aware и локализованное на бэке). Совпадает с `displayModelDesc`
  // (capabilityData) и `modelDesc` в GenerateScene.
  return m.shortDescription ?? m.description;
}

export function modelRate(m: WebModelDto, t: (k: string) => string): string {
  // LLM: бэк отдаёт стоимость за 1000 токенов сообщения (доли ✦) — округление
  // до десятков, которое работает для image/video/audio (там значения 10–500 ✦),
  // здесь схлопывало бы всё в 0. Поэтому формат с 2–3 знаками после запятой.
  if (m.tokenCostUnit === "1k_tok") {
    // Пересчитываем стоимость в токенах на символы
    // Стоимость в токенах * множитель символов = 1000 токенов / 3500 символов
    const v = m.tokenCostApprox * Number((1000 / 3500).toFixed(2));
    const formatted = v < 0.1 ? v.toFixed(3) : v.toFixed(2);
    return `≈ ${formatted} ${t("chat.tokensEst")} / ${t("chat.per1kSymbols")}`;
  }

  const n = Math.round(m.tokenCostApprox / 10) * 10;
  const unit =
    m.tokenCostUnit === "msg"
      ? "/ msg"
      : m.tokenCostUnit === "mpx"
        ? "/ MP"
        : m.tokenCostUnit === "second"
          ? "/ sec"
          : m.tokenCostUnit === "kchar"
            ? "/ 1k chars"
            : m.tokenCostUnit === "mvideotoken"
              ? "/ M vtok"
              : "/ req";
  return `≈ ${n.toLocaleString("ru-RU")} т ${unit}`;
}

export function messageDtoToMsg(m: MessageDto): Msg {
  const isAi = m.role !== "user";
  return {
    role: m.role === "user" ? "user" : "ai",
    text: m.content,
    ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
    // Сохраняем токены только для assistant — для user они в БД лежат как 0
    // и не участвуют в подсчёте контекста (полная история уже в inputTokens
    // следующего assistant-ответа).
    ...(isAi && typeof m.inputTokens === "number" ? { inputTokens: m.inputTokens } : {}),
    ...(isAi && typeof m.outputTokens === "number" ? { outputTokens: m.outputTokens } : {}),
  };
}

/**
 * Форматирует число токенов как `1.2K` / `128K` / `850`. Для значений ≥10K
 * округляем до целого (`128K`, не `128.0K`); для 1K..10K оставляем 1 знак
 * после запятой (`1.2K`); ниже — как есть.
 */
export function formatTokensK(n: number): string {
  if (n < 1000) return String(n);
  const v = n / 1000;
  return v >= 10 ? `${Math.round(v)}K` : `${v.toFixed(1)}K`;
}

/** Обрезает имя файла, сохраняя расширение: "длинное-имя.png" → "длинн….png". */
export function truncateFileName(name: string, max = 16): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const base = dot > 0 ? name.slice(0, dot) : name;
  const keep = Math.max(1, max - ext.length - 1);
  return base.slice(0, keep) + "…" + ext;
}

export function formatBytes(bytes: number | null | undefined, t: (k: string) => string): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} ${t("chat.byteShort")}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${t("chat.kbShort")}`;
  return `${(bytes / 1024 / 1024).toFixed(1)} ${t("chat.mbShort")}`;
}
