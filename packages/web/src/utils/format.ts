/**
 * Локальные хелперы форматирования для отображения профиля и токенов.
 * Намеренно не подключаем тяжёлые i18n-либы — данных и форматов мало.
 */

/** Полное имя или fallback на email-prefix / "User". */
export function fullName(firstName: string | null, lastName: string | null, email: string): string {
  const parts = [firstName, lastName].filter((s): s is string => !!s && s.trim().length > 0);
  if (parts.length > 0) return parts.join(" ");
  const localPart = email.split("@")[0];
  return localPart || "User";
}

/** До 2 символов в верхнем регистре — для круглой аватарки. */
export function initials(firstName: string | null, lastName: string | null, email: string): string {
  const first = firstName?.trim()?.[0];
  const last = lastName?.trim()?.[0];
  if (first && last) return (first + last).toUpperCase();
  if (first) return first.toUpperCase();
  const localPart = email.split("@")[0] ?? "";
  return (localPart.slice(0, 2) || "U").toUpperCase();
}

/**
 * Парсит decimal-строку токенов в Number. Безопасен для значений до 9e15
 * (наш balance до этого никогда не дорастёт). Возвращает 0 на null/NaN.
 */
export function parseTokens(raw: string | null | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** "28,450 tokens" / "1,247,330" — округление до целого + тысячные разделители. */
export function formatTokens(raw: string | null | undefined): string {
  return Math.round(parseTokens(raw)).toLocaleString("en-US");
}

/** "+2,140" / "−4,410" — со знаком и тысячным разделителем. */
export function formatTokenDelta(raw: string | null | undefined): string {
  const n = parseTokens(raw);
  const sign = n < 0 ? "−" : "+";
  return sign + Math.round(Math.abs(n)).toLocaleString("en-US");
}

/** "Today · 14:02" / "Yesterday · 11:47" / "May 1". Locale = ru по дефолту. */
export function formatTxnTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `Сегодня · ${hm}`;
  if (isYesterday) return `Вчера · ${hm}`;
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}
