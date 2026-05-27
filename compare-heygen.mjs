#!/usr/bin/env node
/**
 * Сравнивает выгрузку использования HeyGen из провайдера (`heygen_usage.csv`)
 * с записями списаний из нашей БД (`db_heygen_usage.csv`).
 *
 * Цель: найти, почему на дашборде провайдера расход больше, чем сумма наших
 * списаний. Идём по провайдерским записям, ищем парную в БД по providerJobId
 * (= "Request ID" в CSV провайдера), сверяем стоимость.
 *
 * Запуск: node compare-heygen.mjs [provider.csv] [db.csv]
 *   (по умолчанию пути: heygen_usage.csv и db_heygen_usage.csv в текущей папке)
 */

import fs from "node:fs";

// ── Конфиг ──────────────────────────────────────────────────────────────────
const PROVIDER_CSV = process.argv[2] ?? "heygen_usage.csv";
const DB_CSV = process.argv[3] ?? "db_heygen_usage.csv";

/** Допуск по цене (USD). Расхождение ниже считаем шумом float-арифметики. */
const PRICE_TOLERANCE = 0.005;

/** Если |db / provider| отклоняется от среднего соотношения больше чем на это
 *  значение — считаем «существенным» расхождением (для сортировки). */
const RATIO_OUTLIER_THRESHOLD = 0.05;

// ── Утилиты ─────────────────────────────────────────────────────────────────

/**
 * Минимальный CSV-парсер: split по запятой, без поддержки quoted-полей с
 * запятыми внутри. Для наших файлов этого достаточно (email'ы и duration
 * не содержат запятых).
 */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    headers.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
    return row;
  });
}

function fmt(n, d = 2) {
  return Number(n).toFixed(d);
}

function pct(num, denom) {
  if (!denom) return "n/a";
  return `${((num / denom) * 100).toFixed(1)}%`;
}

// ── Загрузка ────────────────────────────────────────────────────────────────

const providerRows = parseCsv(fs.readFileSync(PROVIDER_CSV, "utf8"));
const dbRows = parseCsv(fs.readFileSync(DB_CSV, "utf8"));

console.log(`Loaded provider: ${providerRows.length} rows from ${PROVIDER_CSV}`);
console.log(`Loaded db:       ${dbRows.length} rows from ${DB_CSV}`);

// ── Индексирование БД ───────────────────────────────────────────────────────

/** Map providerJobId → db row */
const dbByProviderJobId = new Map();
const dbDuplicateIds = []; // если вдруг один providerJobId попал в БД дважды

const dbStats = {
  total: dbRows.length,
  done: 0,
  failed: 0,
  withProviderJobId: 0,
  withoutProviderJobIdDone: 0,
  withoutProviderJobIdFailed: 0,
  totalUsd: 0,
  failedWithProviderJobId: 0,
};

for (const row of dbRows) {
  const pid = row.providerJobId;
  const status = row.status;
  const usd = parseFloat(row.usdspent);

  if (status === "done") dbStats.done++;
  else if (status === "failed") dbStats.failed++;

  if (!isNaN(usd)) dbStats.totalUsd += usd;

  if (!pid) {
    if (status === "failed") dbStats.withoutProviderJobIdFailed++;
    else dbStats.withoutProviderJobIdDone++;
    continue;
  }
  dbStats.withProviderJobId++;
  if (status === "failed") dbStats.failedWithProviderJobId++;

  if (dbByProviderJobId.has(pid)) {
    dbDuplicateIds.push(pid);
  } else {
    dbByProviderJobId.set(pid, row);
  }
}

// ── Сравнение по записям провайдера ─────────────────────────────────────────

const missingInDb = []; // Provider record → нет parной в БД
const priceMismatch = []; // |provider - db| > tolerance
const matched = []; // совпадения для расчёта среднего ratio

let providerTotalUsd = 0;
const providerIdSet = new Set();

for (const row of providerRows) {
  const pid = row["Request ID"];
  const credits = parseFloat(row["Credits Used"]);
  if (!pid || isNaN(credits)) continue;
  providerIdSet.add(pid);
  providerTotalUsd += credits;

  const dbRow = dbByProviderJobId.get(pid);
  if (!dbRow) {
    missingInDb.push({
      providerJobId: pid,
      dateTime: row["Date/Time"],
      duration: row["Duration"],
      creditsUsd: credits,
      userEmail: row["User Email"],
    });
    continue;
  }

  const dbUsd = parseFloat(dbRow.usdspent);
  if (isNaN(dbUsd)) {
    // db row есть (status=failed с providerJobId), но usdspent NULL — провайдер
    // зачарджил за невыданный пользователю результат. Тоже выделяем отдельно.
    priceMismatch.push({
      providerJobId: pid,
      dateTime: row["Date/Time"],
      duration: row["Duration"],
      creditsUsd: credits,
      dbUsd: 0,
      dbStatus: dbRow.status,
      diff: credits,
      ratio: 0,
      reason: "db_status_failed_no_charge",
    });
    continue;
  }

  matched.push({ providerUsd: credits, dbUsd });

  if (Math.abs(credits - dbUsd) > PRICE_TOLERANCE) {
    priceMismatch.push({
      providerJobId: pid,
      dateTime: row["Date/Time"],
      duration: row["Duration"],
      creditsUsd: credits,
      dbUsd,
      dbStatus: dbRow.status,
      diff: credits - dbUsd,
      ratio: dbUsd / credits,
      reason: "price_mismatch",
    });
  }
}

// DB-записи с providerJobId, которого нет в провайдерской выгрузке
const dbWithProviderIdNotInProvider = [];
for (const row of dbRows) {
  const pid = row.providerJobId;
  if (pid && !providerIdSet.has(pid)) {
    dbWithProviderIdNotInProvider.push({
      id: row.id,
      providerJobId: pid,
      status: row.status,
      usdspent: parseFloat(row.usdspent),
      createdAt: row.createdAt,
    });
  }
}

// ── Расчёты ────────────────────────────────────────────────────────────────

const matchedProviderUsd = matched.reduce((s, m) => s + m.providerUsd, 0);
const matchedDbUsd = matched.reduce((s, m) => s + m.dbUsd, 0);
const avgRatio = matchedProviderUsd > 0 ? matchedDbUsd / matchedProviderUsd : 0;

const missingInDbTotalUsd = missingInDb.reduce((s, m) => s + m.creditsUsd, 0);

// Сортируем mismatch'и от самых «странных» к нормальным
priceMismatch.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
missingInDb.sort((a, b) => b.creditsUsd - a.creditsUsd);

// ── Вывод ───────────────────────────────────────────────────────────────────

const line = "─".repeat(78);
console.log(`\n${line}\n  СВОДКА\n${line}`);
console.log(`Provider total: ${providerRows.length} записей, $${fmt(providerTotalUsd, 2)}`);
console.log(`DB total:       ${dbStats.total} записей, $${fmt(dbStats.totalUsd, 2)}`);
console.log(
  `  done:   ${dbStats.done} (с providerJobId: ${
    dbStats.withProviderJobId - dbStats.failedWithProviderJobId
  }, без providerJobId: ${dbStats.withoutProviderJobIdDone})`,
);
console.log(
  `  failed: ${dbStats.failed} (с providerJobId: ${dbStats.failedWithProviderJobId}, без: ${dbStats.withoutProviderJobIdFailed})`,
);
console.log(
  `Разница (provider - db): $${fmt(providerTotalUsd - dbStats.totalUsd, 2)} = ${pct(
    providerTotalUsd - dbStats.totalUsd,
    providerTotalUsd,
  )} от провайдера`,
);

console.log(`\n${line}\n  СОВПАВШИЕ ЗАПИСИ (по providerJobId)\n${line}`);
console.log(`Matched: ${matched.length}`);
console.log(`  Provider USD: $${fmt(matchedProviderUsd, 2)}`);
console.log(`  DB USD:       $${fmt(matchedDbUsd, 2)}`);
console.log(
  `  Соотношение DB/Provider: ${fmt(avgRatio, 4)} (${pct(matchedDbUsd, matchedProviderUsd)})`,
);
console.log(`  Гэп на matched: $${fmt(matchedProviderUsd - matchedDbUsd, 2)}`);

if (dbDuplicateIds.length > 0) {
  console.log(
    `\n⚠  Дубликаты в БД (один providerJobId в нескольких строках): ${dbDuplicateIds.length}`,
  );
  console.log("   ", dbDuplicateIds.slice(0, 5).join(", "));
}

console.log(`\n${line}\n  ЗАПИСИ ПРОВАЙДЕРА БЕЗ ПАРЫ В БД\n${line}`);
console.log(`Кол-во: ${missingInDb.length}, сумма: $${fmt(missingInDbTotalUsd, 2)}`);
console.log(`Доля в общем расходе провайдера: ${pct(missingInDbTotalUsd, providerTotalUsd)}`);
if (missingInDb.length > 0) {
  console.log(`\nproviderJobId                      | дата                  | dur  | $`);
  for (const m of missingInDb) {
    console.log(
      `${m.providerJobId.padEnd(34)} | ${m.dateTime.padEnd(20)} | ${(m.duration ?? "").padStart(
        5,
      )} | ${fmt(m.creditsUsd, 2)}`,
    );
  }
}

console.log(`\n${line}\n  РАСХОЖДЕНИЯ ПО ЦЕНЕ (|diff| > $${PRICE_TOLERANCE})\n${line}`);
console.log(`Кол-во: ${priceMismatch.length}`);
if (priceMismatch.length > 0) {
  const totalMismatchProviderUsd = priceMismatch.reduce((s, m) => s + m.creditsUsd, 0);
  const totalMismatchDbUsd = priceMismatch.reduce((s, m) => s + m.dbUsd, 0);
  console.log(
    `Provider: $${fmt(totalMismatchProviderUsd, 2)} | DB: $${fmt(totalMismatchDbUsd, 2)} | gap: $${fmt(
      totalMismatchProviderUsd - totalMismatchDbUsd,
      2,
    )}`,
  );
  console.log(
    `\nproviderJobId                      | дата                  | dur  | prov $ | db $  | diff   | ratio | reason`,
  );
  for (const m of priceMismatch) {
    const flag = Math.abs(m.ratio - avgRatio) > RATIO_OUTLIER_THRESHOLD ? "*" : " ";
    console.log(
      `${flag} ${m.providerJobId.padEnd(32)} | ${m.dateTime.padEnd(20)} | ${(
        m.duration ?? ""
      ).padStart(5)} | ${fmt(m.creditsUsd, 2).padStart(6)} | ${fmt(m.dbUsd, 2).padStart(
        5,
      )} | ${fmt(m.diff, 3).padStart(6)} | ${fmt(m.ratio, 3).padStart(5)} | ${m.reason}`,
    );
  }
  console.log(
    `\n* — отклонение ratio db/provider больше чем на ${RATIO_OUTLIER_THRESHOLD} от среднего ${fmt(
      avgRatio,
      3,
    )}: либо одиночные кейсы с другим тарифом, либо реальные ошибки расчёта.`,
  );
}

console.log(`\n${line}\n  В БД ЕСТЬ providerJobId, КОТОРОГО НЕТ В ВЫГРУЗКЕ ПРОВАЙДЕРА\n${line}`);
console.log(`Кол-во: ${dbWithProviderIdNotInProvider.length}`);
if (dbWithProviderIdNotInProvider.length > 0) {
  console.log(`Это либо записи вне диапазона выгрузки провайдера, либо submitted-но-не-зачарджено`);
  console.log(
    `\nid                        | providerJobId                      | status | $    | createdAt`,
  );
  for (const r of dbWithProviderIdNotInProvider) {
    console.log(
      `${r.id.padEnd(25)} | ${r.providerJobId.padEnd(34)} | ${(r.status ?? "").padEnd(6)} | ${
        isNaN(r.usdspent) ? "—".padStart(4) : fmt(r.usdspent, 2).padStart(4)
      } | ${r.createdAt}`,
    );
  }
}

// ── Итоговый сюрвей расхождения ─────────────────────────────────────────────

console.log(`\n${line}\n  АНАЛИЗ ГЭПА\n${line}`);
const matchedGap = matchedProviderUsd - matchedDbUsd;
const overallGap = providerTotalUsd - dbStats.totalUsd;
console.log(
  `Общий гэп (provider - db total):  $${fmt(overallGap, 2)} (${pct(overallGap, providerTotalUsd)})`,
);
console.log(`  ├─ Записи провайдера без БД:     $${fmt(missingInDbTotalUsd, 2)}`);
console.log(`  ├─ Гэп на совпавших (price diff): $${fmt(matchedGap, 2)}`);
const failedDbWithChargeUsd = priceMismatch
  .filter((m) => m.reason === "db_status_failed_no_charge")
  .reduce((s, m) => s + m.creditsUsd, 0);
if (failedDbWithChargeUsd > 0) {
  console.log(`  ├─ Из них failed-в-БД с usd=NULL: $${fmt(failedDbWithChargeUsd, 2)}`);
}
const explained = missingInDbTotalUsd + matchedGap;
console.log(`  └─ Сумма объяснённого:            $${fmt(explained, 2)}`);
console.log(
  `Необъяснённый остаток: $${fmt(overallGap - explained, 2)} (округление + записи в БД без providerJobId)`,
);
