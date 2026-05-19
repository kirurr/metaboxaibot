import type { useI18n } from "../i18n";
import type { Model } from "../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

export function groupByFamily(models: Model[]): {
  families: Map<string, Model[]>;
  standalone: Model[];
} {
  const families = new Map<string, Model[]>();
  const standalone: Model[] = [];
  for (const m of models) {
    if (m.familyId) {
      const arr = families.get(m.familyId) ?? [];
      arr.push(m);
      families.set(m.familyId, arr);
    } else {
      standalone.push(m);
    }
  }
  return { families, standalone };
}

/**
 * When a costMatrix dimension setting changes to a value that creates an invalid
 * combination, returns corrections for the other dims to restore validity.
 * Returns null when the combination is valid or the model has no costMatrix.
 */
export function autoCorrectForCostMatrix(
  model: Model,
  changedKey: string,
  changedValue: unknown,
  currentValues: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!model.costMatrix) return null;
  const { dims, table } = model.costMatrix;
  if (!dims.includes(changedKey)) return null;

  const newValues = { ...currentValues, [changedKey]: changedValue };
  const key = dims.map((d) => String(newValues[d] ?? "")).join("__");
  if (key in table) return null;

  const changedIndex = dims.indexOf(changedKey);
  const changedStr = String(changedValue);

  // Table keys are always strings, but setting option values can be numbers,
  // booleans, etc. Coerce each corrected value back to the type of the matching
  // option so strict equality checks in the UI still work.
  const coerceToOptionValue = (dimKey: string, raw: string): unknown => {
    const def = model.settings.find((s) => s.key === dimKey);
    const match = def?.options?.find((o) => String(o.value) === raw);
    return match ? match.value : raw;
  };

  for (const tableKey of Object.keys(table)) {
    const parts = tableKey.split("__");
    if (parts[changedIndex] === changedStr) {
      const corrections: Record<string, unknown> = {};
      for (let i = 0; i < dims.length; i++) {
        if (i !== changedIndex) corrections[dims[i]] = coerceToOptionValue(dims[i], parts[i]);
      }
      return corrections;
    }
  }
  return null;
}

interface PickerOption {
  id: string;
  label: string;
}

export function buildPickerOptions(
  models: Model[],
  modelTranslations: Record<string, { name?: string }>,
): PickerOption[] {
  const seen = new Set<string>();
  const opts: PickerOption[] = [];
  for (const m of models) {
    if (m.familyId) {
      const key = `family__${m.familyId}`;
      if (!seen.has(key)) {
        seen.add(key);
        const label = m.familyName ?? m.familyId.charAt(0).toUpperCase() + m.familyId.slice(1);
        opts.push({ id: key, label });
      }
    } else {
      opts.push({
        id: `standalone__${m.id}`,
        label: modelTranslations[m.id]?.name ?? m.name,
      });
    }
  }
  return opts;
}

export function getPickerIdForModel(modelId: string, models: Model[]): string {
  const m = models.find((x) => x.id === modelId);
  if (!m) {
    const first = models[0];
    if (!first) return "";
    return first.familyId ? `family__${first.familyId}` : `standalone__${first.id}`;
  }
  return m.familyId ? `family__${m.familyId}` : `standalone__${m.id}`;
}

/**
 * Estimate pixel dimensions from aspect ratio and resolution string.
 * Matches the backend's computeVideoTokens / estimateVideoDimensions logic.
 */
function estimateVideoDimensions(aspectRatio: string, resolution: string): [number, number] {
  const base = parseInt(resolution, 10) || 720;

  const match = aspectRatio.match(/^(\d+):(\d+)$/);
  if (!match) return [base, base]; // "auto" or unknown → square at base

  const rw = Number(match[1]);
  const rh = Number(match[2]);

  if (rw === rh) return [base, base];

  const long = Math.round((base * Math.max(rw, rh)) / Math.min(rw, rh));
  return rw > rh ? [long, base] : [base, long];
}

function resolveAddons(m: Model, values: Record<string, unknown>): number {
  if (!m.tokenCostAddons?.length) return 0;
  return m.tokenCostAddons.reduce((sum, addon) => {
    const val = String(values[addon.settingKey] ?? "");
    return sum + (addon.map[val] ?? 0);
  }, 0);
}

export function modelCostLabel(
  m: Model,
  values: Record<string, unknown>,
  t: ReturnType<typeof useI18n>["t"],
): string | null {
  if (m.isLLM) {
    return `~${m.tokenCostApproxMsg.toFixed(2)} ✦${t("manage.price.perMsg")}`;
  }
  if (m.tokenCostPerMPixel > 0) {
    return `${m.tokenCostPerMPixel.toFixed(2)} ✦${t("manage.price.perMPixel")}`;
  }
  if (m.tokenCostPerMVideoToken > 0) {
    const aspectRatio = String(
      values["aspect_ratio"] ?? m.settings.find((s) => s.key === "aspect_ratio")?.default ?? "16:9",
    );
    const duration = Number(
      values["duration"] ?? m.settings.find((s) => s.key === "duration")?.default ?? 5,
    );
    const resolution = String(
      values["resolution"] ?? m.settings.find((s) => s.key === "resolution")?.default ?? "720p",
    );
    const [w, h] = estimateVideoDimensions(aspectRatio, resolution);
    const fps = m.videoFps || 24;
    const videoTokens = (w * h * fps * duration) / 1024;
    const cost = (m.tokenCostPerMVideoToken * videoTokens) / 1_000_000;
    return `~${cost.toFixed(2)} ✦${t("manage.price.perReq")}`;
  }
  if (m.tokenCostPerKChar > 0) {
    let costPerKChar = m.tokenCostPerKChar;
    if (m.tokenCostVariants) {
      const vKey = String(
        values[m.tokenCostVariants.settingKey] ??
          m.settings.find((s) => s.key === m.tokenCostVariants!.settingKey)?.default ??
          "",
      );
      costPerKChar = m.tokenCostVariants.map[vKey] ?? costPerKChar;
    }
    return `${costPerKChar.toFixed(2)} ✦${t("manage.price.perKChar")}`;
  }
  if (m.tokenCostPerSecond > 0) {
    let perSecond = m.tokenCostPerSecond;
    if (m.costMatrix) {
      const key = m.costMatrix.dims.map((dim) => String(values[dim] ?? "")).join("__");
      perSecond = m.costMatrix.table[key] ?? perSecond;
    } else if (m.tokenCostVariants) {
      const vKey = String(
        values[m.tokenCostVariants.settingKey] ??
          m.settings.find((s) => s.key === m.tokenCostVariants!.settingKey)?.default ??
          "",
      );
      perSecond = m.tokenCostVariants.map[vKey] ?? perSecond;
    }
    return `${perSecond.toFixed(2)} ✦${t("manage.price.perSec")}`;
  }
  if (m.tokenCostPerRequest > 0) {
    // Virtual batch: юзер выбрал n=1..4 → итог = n × per_request. Показываем
    // одной строкой без пометок «×N» (как договорено). Списание идёт K × per_request,
    // K = количество успешных sub-job'ов.
    const numImages = Math.max(1, Math.min(4, Number(values["num_images"] ?? 1) || 1));
    // Multi-dimensional pricing (e.g. quality × size)
    if (m.costMatrix) {
      const key = m.costMatrix.dims.map((dim) => String(values[dim] ?? "")).join("__");
      const cost = m.costMatrix.table[key] ?? m.tokenCostPerRequest;
      return `${(cost * numImages).toFixed(2)} ✦${t("manage.price.perReq")}`;
    }
    // Single-setting variant pricing + optional addons
    let base = m.tokenCostPerRequest;
    if (m.tokenCostVariants) {
      const vKey = String(
        values[m.tokenCostVariants.settingKey] ??
          m.settings.find((s) => s.key === m.tokenCostVariants!.settingKey)?.default ??
          "",
      );
      base = m.tokenCostVariants.map[vKey] ?? base;
    }
    const cost = (base + resolveAddons(m, values)) * numImages;
    return `${cost.toFixed(2)} ✦${t("manage.price.perReq")}`;
  }
  return null;
}

/**
 * Строго «модель действительно активна в чате» — бот в `*_ACTIVE` для своей
 * секции и отвечает на сообщения с её моделью. НЕ включает `*_SECTION` (этап
 * выбора): в селекшн-стадии бот не отвечает на сообщения, поэтому показывать
 * бейдж «Активна» на сохранённой из прошлой сессии модели было бы враньём.
 * Старая версия объединяла оба состояния — это привело к багу: юзер тапал
 * «Видео будущего», открывал миниаппу и видел бейдж на модели из прошлой
 * сессии, хотя в чат бот не отвечал.
 *
 * `HEYGEN_AVATAR_PHOTO` оставляем — это под-состояние внутри активного видео
 * (загрузка фото для аватара), модель уже active.
 */
export function isActiveSection(section: string, state?: string) {
  switch (section) {
    case "gpt":
      return state === "GPT_ACTIVE";
    case "design":
      return state === "DESIGN_ACTIVE";
    case "video":
      return state === "VIDEO_ACTIVE" || state === "HEYGEN_AVATAR_PHOTO";
    case "audio":
      return state === "AUDIO_ACTIVE";
  }
  return false;
}

/**
 * True когда юзер находится в секции, но конкретная модель в чате ещё НЕ
 * запущена (бот сидит на состоянии типа "выберите раздел"). В этом состоянии
 * имеет смысл показывать кнопку "Начать работу" — она отправит запрос
 * активации в чат. После реальной активации (state → `*_ACTIVE`) кнопка не
 * нужна: повторный клик дублирует приветственное сообщение модели.
 */
export function isInSectionPicker(section: string, state?: string) {
  switch (section) {
    case "gpt":
      return state === "GPT_SECTION";
    case "design":
      return state === "DESIGN_SECTION";
    case "video":
      return state === "VIDEO_SECTION";
    case "audio":
      return state === "AUDIO_SECTION";
  }
  return false;
}
