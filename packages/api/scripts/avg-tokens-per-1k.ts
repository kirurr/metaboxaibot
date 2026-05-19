/**
 * Считает среднее число токенов на 1000 символов по содержимому таблицы `messages`.
 *
 * Вход: JSON-файл с дампом таблицы (path как первый CLI-аргумент или stdin).
 * Поддерживаемые форматы:
 *   1) Массив объектов вида { content: string, ... }  — например, прямой экспорт из Prisma/psql.
 *   2) Массив строк.
 *   3) Объект { data: [...] } — обёртка psql `\copy ... json`.
 *
 * Запуск:
 *   pnpm -F @metabox/api exec tsx scripts/avg-tokens-per-1k.ts path/to/messages.json
 *   cat messages.json | pnpm -F @metabox/api exec tsx scripts/avg-tokens-per-1k.ts
 *
 * Использует cl100k_base — тот же encoder, что и runtime token-estimator.
 */
import { readFileSync } from "node:fs";
import { getEncoding } from "js-tiktoken";

function readInput(): string {
  const path = process.argv[2];
  if (path) return readFileSync(path, "utf8");
  // stdin fallback
  return readFileSync(0, "utf8");
}

/**
 * В выгрузках с LaTeX-контентом (`\[`, `\(`, `\,` и т.п.) попадаются
 * невалидные JSON-эскейпы. JSON допускает только `\" \\ \/ \b \f \n \r \t \uXXXX`.
 * Идём слева-направо, отслеживая state «внутри строки», и валидные пары
 * (`\\`, `\"`, `\uXXXX` и др.) пропускаем целиком — это важно, иначе
 * корректный `\\` (literal backslash) ошибочно превратится в `\\\` и
 * сломает то, что было валидным.
 */
function fixInvalidJsonEscapes(raw: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      continue;
    }
    if (c === '"') {
      out += c;
      inString = false;
      continue;
    }
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) {
      out += c;
      continue;
    }
    if (
      next === '"' ||
      next === "\\" ||
      next === "/" ||
      next === "b" ||
      next === "f" ||
      next === "n" ||
      next === "r" ||
      next === "t"
    ) {
      out += c + next;
      i += 1;
      continue;
    }
    if (next === "u") {
      const hex = raw.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += c + next + hex;
        i += 5;
        continue;
      }
    }
    // невалидный эскейп — удваиваем backslash, символ next оставляем
    out += "\\\\";
  }
  return out;
}

function parseLoose(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const patched = fixInvalidJsonEscapes(raw);
    if (patched === raw) throw err;
    process.stderr.write(
      `[info] JSON parse failed (${(err as Error).message}); retrying with escape-fix.\n`,
    );
    return JSON.parse(patched);
  }
}

function extractContents(parsed: unknown): string[] {
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { data?: unknown })?.data)
      ? (parsed as { data: unknown[] }).data
      : null;
  if (!arr) {
    throw new Error("Expected a JSON array or an object with 'data' array.");
  }
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === "string") {
      out.push(item);
    } else if (
      item &&
      typeof item === "object" &&
      typeof (item as { content?: unknown }).content === "string"
    ) {
      out.push((item as { content: string }).content);
    }
  }
  return out;
}

function main() {
  const raw = readInput();
  const parsed: unknown = parseLoose(raw);
  const contents = extractContents(parsed);

  if (contents.length === 0) {
    console.error("No usable text content found.");
    process.exit(1);
  }

  const enc = getEncoding("cl100k_base");

  let totalChars = 0;
  let totalTokens = 0;
  let nonEmpty = 0;

  for (const text of contents) {
    if (!text) continue;
    totalChars += text.length;
    totalTokens += enc.encode(text).length;
    nonEmpty += 1;
  }

  if (totalChars === 0) {
    console.error("All messages are empty.");
    process.exit(1);
  }

  const tokensPer1kChars = (totalTokens / totalChars) * 1000;
  const avgCharsPerMessage = totalChars / nonEmpty;
  const avgTokensPerMessage = totalTokens / nonEmpty;

  console.log(
    JSON.stringify(
      {
        messages: nonEmpty,
        totalChars,
        totalTokens,
        avgCharsPerMessage: Number(avgCharsPerMessage.toFixed(2)),
        avgTokensPerMessage: Number(avgTokensPerMessage.toFixed(2)),
        tokensPer1kChars: Number(tokensPer1kChars.toFixed(2)),
      },
      null,
      2,
    ),
  );
}

main();
