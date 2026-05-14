import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Image as ImageIcon,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import clsx from "clsx";
import { uploadChatFile, type ChatUploadDto } from "@/api/uploads";
import type { MediaInputSlotDto, ModelModeDto, ModelSettingDto, WebModelDto } from "@/api/models";
import { ApiError } from "@/api/client";
import {
  submitImageGeneration,
  submitVideoGeneration,
  submitAudioGeneration,
  type SubmitImageGenerationBody,
  type SubmitVideoGenerationBody,
  type SubmitAudioGenerationBody,
  type SubmitGenerationResponse,
} from "@/api/generation";
import { listVoices, type VoiceItem, type VoiceProvider } from "@/api/voices";
import {
  listHeyGenAvatars,
  listMotions,
  listSoulStyles,
  type AvatarItem,
  type MotionItem,
  type SoulStyleItem,
} from "@/api/pickers";
import { VoicePicker } from "./VoicePicker";
import { MediaPicker, type MediaPickItem } from "./MediaPicker";

/**
 * Centered-panel UI генерации (Image/Video), ориентированный на референс из
 * Kling/Higgsfield: горизонтальные mode-tabs, ряд media-слотов с pre-views,
 * настройки модели как чипы/тогглы/слайдеры, промпт, выбор модели и Generate.
 *
 * Все параметры приходят с бэка (`/web/models` отдаёт `modes`/`mediaInputs`/`settings`),
 * UI рендерится из них динамически — без захардкоженных aspect/duration/quality.
 *
 * Реальной отправки в генерацию пока нет: CTA имитирует loading.
 */

export type GenerateSceneProps = {
  title: string;
  subtitle: string;
  promptPlaceholder: string;
  /** Список моделей (дедуплированный по `familyId`). Первая по умолчанию. */
  models: readonly WebModelDto[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function modelDisplayName(m: WebModelDto): string {
  return m.familyName ?? m.name;
}
function modelLetter(m: WebModelDto): string {
  return modelDisplayName(m).trim().slice(0, 1).toUpperCase() || "·";
}
function modelDesc(m: WebModelDto): string {
  return m.descriptionOverride ?? m.description;
}

/** Resolve active mode: либо explicit default, либо первый. */
function resolveActiveMode(
  modes: ModelModeDto[] | null,
  selectedId: string | null,
): ModelModeDto | null {
  if (!modes || modes.length === 0) return null;
  if (selectedId) {
    const f = modes.find((m) => m.id === selectedId);
    if (f) return f;
  }
  return modes.find((m) => m.default) ?? modes[0];
}

/** Фильтруем mediaInputs[] по slotKeys active mode'а. */
function getActiveSlots(
  mediaInputs: MediaInputSlotDto[],
  mode: ModelModeDto | null,
): MediaInputSlotDto[] {
  if (!mode) return mediaInputs;
  if (mode.textOnly) return [];
  const allowed = new Set(mode.slotKeys);
  const requiredOverride = mode.requiredSlotKeys ? new Set(mode.requiredSlotKeys) : null;
  return mediaInputs
    .filter((s) => allowed.has(s.slotKey))
    .map((s) => (requiredOverride ? { ...s, required: requiredOverride.has(s.slotKey) } : s));
}

/** Грубо: видна ли настройка с учётом `dependsOn` (другая настройка == value). */
function isSettingVisible(s: ModelSettingDto, values: Record<string, unknown>): boolean {
  if (!s.dependsOn) return true;
  return values[s.dependsOn.key] === s.dependsOn.value;
}

/** Типы пикеров, которые web пока не реализует — прячем их. */
const UNSUPPORTED_TYPES = new Set<string>([
  // Generic voice-picker (без конкретного провайдера) и d-id-voice-picker —
  // пока не подключены. Остальные voice-picker'ы (cartesia/elevenlabs/openai)
  // обрабатываются через VoicePicker. avatar-/motion-/soul-style-picker и color
  // обрабатываются через MediaPicker. soul-picker (пользовательские soul-id'ы)
  // оставлен — требует доп. логики на user-state.
  "voice-picker",
  "did-voice-picker",
  "soul-picker",
]);

/** Map setting.type → провайдер каталога голосов. */
const VOICE_PROVIDER_BY_TYPE: Record<string, VoiceProvider> = {
  "cartesia-voice-picker": "cartesia",
  "elevenlabs-voice-picker": "elevenlabs",
  "openai-voice-picker": "openai",
};

/** Типы media-пикеров (картинки/видео-превью, не voice). */
type MediaPickerKind = "avatar" | "motion" | "soul-style";
const MEDIA_KIND_BY_TYPE: Record<string, MediaPickerKind> = {
  "avatar-picker": "avatar",
  "motion-picker": "motion",
  "soul-style-picker": "soul-style",
};

/** Для motion-picker значение — массив `{ id, strength }`. Мы храним strength=1. */
type MotionEntry = { id: string; strength: number };

function parseMotionValue(v: unknown): MotionEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is MotionEntry => !!x && typeof (x as MotionEntry).id === "string");
}

// ── Sub: slot file picker ────────────────────────────────────────────────────

type SlotFile =
  | { id: string; status: "uploading"; file: File }
  | { id: string; status: "ready"; file: File; dto: ChatUploadDto }
  | { id: string; status: "error"; file: File; error: string };

function SlotCard({
  slot,
  files,
  onAdd,
  onRemove,
}: {
  slot: MediaInputSlotDto;
  files: SlotFile[];
  onAdd: (files: FileList) => void;
  onRemove: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isMulti = slot.maxImages > 1;
  const canAddMore = files.length < slot.maxImages;
  const accept = slot.imagesOnly
    ? "image/png,image/jpeg,image/webp,image/gif"
    : "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm";

  return (
    <div className={clsx("gen-slot", isMulti && "gen-slot-multi")}>
      <div className="gen-slot-head">
        <span className="gen-slot-label">{slot.label}</span>
        <span className={clsx("gen-slot-badge", slot.required ? "is-required" : "is-optional")}>
          {slot.required ? "Required" : "Optional"}
        </span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={isMulti}
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) onAdd(e.target.files);
          e.target.value = "";
        }}
      />
      {files.length === 0 ? (
        <button
          className="gen-slot-drop"
          onClick={() => inputRef.current?.click()}
          aria-label={`Загрузить ${slot.label}`}
        >
          <div className="gen-slot-icon">
            <ImageIcon size={22} />
          </div>
          <div className="gen-slot-hint">{slot.label}</div>
          {isMulti && <div className="gen-slot-meta">До {slot.maxImages} файлов</div>}
        </button>
      ) : (
        <div className="gen-slot-grid">
          {files.map((f) => (
            <SlotFileTile key={f.id} file={f} onRemove={() => onRemove(f.id)} />
          ))}
          {canAddMore && (
            <button
              className="gen-slot-add"
              onClick={() => inputRef.current?.click()}
              aria-label="Добавить ещё"
            >
              <Plus size={18} />
              {isMulti && (
                <span className="gen-slot-count">
                  {files.length}/{slot.maxImages}
                </span>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SlotFileTile({ file, onRemove }: { file: SlotFile; onRemove: () => void }) {
  // ObjectURL для preview из локального File (быстрее чем ждать presigned URL).
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.file.type.startsWith("image/")) {
      setLocalUrl(null);
      return;
    }
    const u = URL.createObjectURL(file.file);
    setLocalUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file.file]);

  const url = file.status === "ready" ? (file.dto.url ?? localUrl) : localUrl;
  return (
    <div
      className={clsx(
        "gen-slot-tile",
        file.status === "uploading" && "is-uploading",
        file.status === "error" && "is-error",
      )}
    >
      {url ? (
        <img src={url} alt={file.file.name} />
      ) : (
        <div className="gen-slot-tile-icon">
          <ImageIcon size={16} />
        </div>
      )}
      {file.status === "uploading" && <div className="gen-slot-tile-overlay">…</div>}
      {file.status === "error" && (
        <div className="gen-slot-tile-overlay" title={file.error}>
          !
        </div>
      )}
      <button className="gen-slot-tile-remove" onClick={onRemove} aria-label="Удалить">
        <X size={11} />
      </button>
    </div>
  );
}

// ── Sub: setting control ─────────────────────────────────────────────────────

function SettingControl({
  setting,
  value,
  onChange,
  openVoicePicker,
  voiceNameLookup,
  openMediaPicker,
  mediaNameLookup,
}: {
  setting: ModelSettingDto;
  value: unknown;
  onChange: (v: unknown) => void;
  openVoicePicker?: (provider: VoiceProvider) => void;
  voiceNameLookup?: (provider: VoiceProvider, id: string) => string | null;
  openMediaPicker?: (kind: MediaPickerKind) => void;
  mediaNameLookup?: (kind: MediaPickerKind, id: string) => string | null;
}) {
  // Voice picker buttons — рендерим до общей логики, чтобы не уходить в неподходящие
  // ветки (например select при пустых options).
  const voiceProvider = VOICE_PROVIDER_BY_TYPE[setting.type];
  if (voiceProvider && openVoicePicker) {
    const currentId = String(value ?? setting.default ?? "");
    const name = currentId ? (voiceNameLookup?.(voiceProvider, currentId) ?? null) : null;
    return (
      <div className="gen-set">
        <div className="gen-set-label">
          <span>{setting.label}</span>
          {setting.description && <span className="gen-set-desc">{setting.description}</span>}
        </div>
        <button
          className="gen-voice-btn"
          onClick={() => openVoicePicker(voiceProvider)}
          type="button"
        >
          <span className="gen-voice-btn-name">{name ?? currentId ?? "Выбрать голос"}</span>
          <ChevronRight size={14} />
        </button>
      </div>
    );
  }

  // Media picker buttons (avatar / motion / soul-style).
  const mediaKind = MEDIA_KIND_BY_TYPE[setting.type];
  if (mediaKind && openMediaPicker) {
    let summary: string;
    if (mediaKind === "motion") {
      const entries = parseMotionValue(value ?? setting.default);
      if (entries.length === 0) {
        summary = "Не выбрано";
      } else if (entries.length === 1) {
        summary = mediaNameLookup?.(mediaKind, entries[0].id) ?? entries[0].id;
      } else {
        summary = `${entries.length} пресета`;
      }
    } else {
      const currentId = String(value ?? setting.default ?? "");
      summary = currentId ? (mediaNameLookup?.(mediaKind, currentId) ?? currentId) : "Не выбрано";
    }
    return (
      <div className="gen-set">
        <div className="gen-set-label">
          <span>{setting.label}</span>
          {setting.description && <span className="gen-set-desc">{setting.description}</span>}
        </div>
        <button className="gen-voice-btn" onClick={() => openMediaPicker(mediaKind)} type="button">
          <span className="gen-voice-btn-name">{summary}</span>
          <ChevronRight size={14} />
        </button>
      </div>
    );
  }

  // Color — native input inline. Без drawer'а, всё сразу видно.
  if (setting.type === "color") {
    const hex = typeof value === "string" && value ? value : String(setting.default ?? "#000000");
    return (
      <div className="gen-set">
        <div className="gen-set-label">
          <span>{setting.label}</span>
          {setting.description && <span className="gen-set-desc">{setting.description}</span>}
        </div>
        <div className="gen-color-row">
          <input
            type="color"
            className="gen-color-input"
            value={hex}
            onChange={(e) => onChange(e.target.value)}
          />
          <input
            type="text"
            className="gen-text gen-color-text"
            value={hex}
            onChange={(e) => onChange(e.target.value)}
            placeholder="#RRGGBB"
          />
        </div>
      </div>
    );
  }

  if (setting.type === "toggle") {
    const checked = Boolean(value);
    return (
      <div className="gen-set gen-set-toggle">
        <div className="gen-set-label">
          <span>{setting.label}</span>
          {setting.description && <span className="gen-set-desc">{setting.description}</span>}
        </div>
        <button
          className={clsx("gen-toggle", checked && "on")}
          onClick={() => onChange(!checked)}
          role="switch"
          aria-checked={checked}
        >
          <span className="gen-toggle-knob" />
        </button>
      </div>
    );
  }
  if (setting.type === "slider") {
    const min = setting.min ?? 0;
    const max = setting.max ?? 100;
    const step = setting.step ?? 1;
    const num = typeof value === "number" ? value : Number(setting.default ?? min);
    return (
      <div className="gen-set">
        <div className="gen-set-label">
          <span>{setting.label}</span>
          <span className="gen-set-val mono">{num}</span>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={num}
          onChange={(e) => onChange(Number(e.target.value))}
          className="gen-slider"
        />
      </div>
    );
  }
  if (setting.type === "number") {
    return (
      <div className="gen-set">
        <div className="gen-set-label">
          <span>{setting.label}</span>
        </div>
        <input
          type="number"
          min={setting.min}
          max={setting.max}
          step={setting.step}
          value={typeof value === "number" ? value : Number(setting.default ?? 0)}
          onChange={(e) => onChange(Number(e.target.value))}
          className="gen-num"
        />
      </div>
    );
  }
  if (setting.type === "text") {
    return (
      <div className="gen-set">
        <div className="gen-set-label">
          <span>{setting.label}</span>
        </div>
        <input
          type="text"
          value={typeof value === "string" ? value : String(setting.default ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className="gen-text"
        />
      </div>
    );
  }
  // select / dropdown — рендерим как chip-row (компактно) или dropdown для >6 опций.
  if (setting.type === "select" || setting.type === "dropdown") {
    const opts = setting.options ?? [];
    if (opts.length === 0) return null;
    if (opts.length > 6) {
      // Dropdown — нативный select для большого числа опций.
      return (
        <div className="gen-set">
          <div className="gen-set-label">
            <span>{setting.label}</span>
          </div>
          <select
            className="gen-select"
            value={String(value ?? setting.default ?? "")}
            onChange={(e) => {
              // Native <select> возвращает string — резолвим обратно в исходный
              // тип опции (number/boolean/string), чтобы адаптеры на воркере
              // не получили "1" вместо 1. Chip-row (≤6 опций) такого приёма
              // не требует, там o.value передаётся напрямую.
              const found = opts.find((o) => String(o.value) === e.target.value);
              onChange(found ? found.value : e.target.value);
            }}
          >
            {opts.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
    }
    // Chip-row — компактно, видно всё сразу.
    return (
      <div className="gen-set">
        <div className="gen-set-label">
          <span>{setting.label}</span>
        </div>
        <div className="gen-chips">
          {opts.map((o) => {
            const active = String(value ?? setting.default) === String(o.value);
            return (
              <button
                key={String(o.value)}
                className={clsx("gen-chip", active && "on")}
                onClick={() => onChange(o.value)}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  return null;
}

// ── Main scene ───────────────────────────────────────────────────────────────

export function GenerateScene({ title, subtitle, promptPlaceholder, models }: GenerateSceneProps) {
  // Выбранная модель / режим / промпт / настройки / файлы по слотам.
  const [modelId, setModelId] = useState<string>(models[0]?.id ?? "");
  const [modeId, setModeId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [settingValues, setSettingValues] = useState<Record<string, unknown>>({});
  const [slotFiles, setSlotFiles] = useState<Record<string, SlotFile[]>>({});
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const modelPickRef = useRef<HTMLDivElement | null>(null);

  // Voice picker state: какой setting сейчас открыт и кеш каталогов голосов.
  // Кеш живёт в локальном стейте компонента — не глобальный, чтобы при logout
  // он чистился вместе с unmount. При повторном открытии того же провайдера
  // список не перезапрашивается.
  const [voicePickerSetting, setVoicePickerSetting] = useState<{
    key: string;
    provider: VoiceProvider;
  } | null>(null);
  const [voiceCache, setVoiceCache] = useState<Record<string, VoiceItem[]>>({});
  const [voiceLoading, setVoiceLoading] = useState<Record<string, boolean>>({});

  // Media-picker (avatar / motion / soul-style) state — параллельная voice'у
  // структура. Mutual exclusion обеспечивается в open*-хелперах ниже.
  const [mediaPickerSetting, setMediaPickerSetting] = useState<{
    key: string;
    kind: MediaPickerKind;
  } | null>(null);
  const [avatarCache, setAvatarCache] = useState<AvatarItem[] | null>(null);
  const [avatarLoading, setAvatarLoading] = useState(false);
  const [motionCache, setMotionCache] = useState<MotionItem[] | null>(null);
  const [motionLoading, setMotionLoading] = useState(false);
  const [soulStyleCache, setSoulStyleCache] = useState<SoulStyleItem[] | null>(null);
  const [soulStyleLoading, setSoulStyleLoading] = useState(false);

  // Когда модели приехали — выставляем дефолт.
  useEffect(() => {
    if (!modelId && models.length > 0) setModelId(models[0].id);
  }, [models, modelId]);

  const selectedModel = useMemo(
    () => models.find((m) => m.id === modelId) ?? models[0],
    [models, modelId],
  );

  // Reset state на смену модели — слоты/настройки/режим разные у каждой модели.
  useEffect(() => {
    setModeId(null);
    setSettingValues({});
    setSlotFiles({});
  }, [modelId]);

  const activeMode = useMemo(
    () => resolveActiveMode(selectedModel?.modes ?? null, modeId),
    [selectedModel, modeId],
  );

  const activeSlots = useMemo(
    () => (selectedModel ? getActiveSlots(selectedModel.mediaInputs, activeMode) : []),
    [selectedModel, activeMode],
  );

  // Список доступных settings — выкидываем unsupported types и применяем dependsOn.
  const visibleSettings = useMemo(() => {
    if (!selectedModel) return [];
    return selectedModel.settings.filter(
      (s) => !UNSUPPORTED_TYPES.has(s.type) && isSettingVisible(s, settingValues),
    );
  }, [selectedModel, settingValues]);

  // Инициализируем дефолтные значения настроек при смене модели/набора параметров.
  useEffect(() => {
    if (!selectedModel) return;
    setSettingValues((prev) => {
      const next: Record<string, unknown> = {};
      for (const s of selectedModel.settings) {
        if (UNSUPPORTED_TYPES.has(s.type)) continue;
        next[s.key] = prev[s.key] !== undefined ? prev[s.key] : s.default;
      }
      return next;
    });
  }, [selectedModel]);

  // Outside-click для popover'а моделей.
  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modelPickRef.current && !modelPickRef.current.contains(e.target as Node)) {
        setModelOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modelOpen]);

  // Идемпотентная загрузка каталога голосов для указанного провайдера. Уже-
  // загруженный или в-полёте — no-op.
  async function ensureVoiceList(provider: VoiceProvider) {
    if (voiceCache[provider] || voiceLoading[provider]) return;
    setVoiceLoading((prev) => ({ ...prev, [provider]: true }));
    try {
      const list = await listVoices(provider);
      setVoiceCache((prev) => ({ ...prev, [provider]: list }));
    } catch {
      setVoiceCache((prev) => ({ ...prev, [provider]: [] }));
    } finally {
      setVoiceLoading((prev) => ({ ...prev, [provider]: false }));
    }
  }

  // Eager-prefetch каталогов для voice-picker-настроек выбранной модели, чтобы
  // в settings-блоке можно было сразу показать имя выбранного голоса (а не его id).
  useEffect(() => {
    if (!selectedModel) return;
    const providers = new Set<VoiceProvider>();
    for (const s of selectedModel.settings) {
      const p = VOICE_PROVIDER_BY_TYPE[s.type];
      if (p) providers.add(p);
    }
    for (const p of providers) {
      ensureVoiceList(p);
    }
    // ensureVoiceList закрыто над `voiceCache`/`voiceLoading` — добавлять их в deps
    // вызовет лишний цикл fetch'ей после загрузки списка. Запускаемся только при
    // смене модели.
  }, [selectedModel]);

  function voiceNameLookup(provider: VoiceProvider, id: string): string | null {
    const list = voiceCache[provider];
    if (!list) return null;
    const found = list.find((v) => v.id === id);
    return found ? found.name : null;
  }

  function openVoicePicker(settingKey: string, provider: VoiceProvider) {
    ensureVoiceList(provider);
    setMediaPickerSetting(null);
    setVoicePickerSetting({ key: settingKey, provider });
  }

  // ── Media picker loaders + lookups ─────────────────────────────────────────
  async function ensureAvatars() {
    if (avatarCache || avatarLoading) return;
    setAvatarLoading(true);
    try {
      setAvatarCache(await listHeyGenAvatars());
    } catch {
      setAvatarCache([]);
    } finally {
      setAvatarLoading(false);
    }
  }
  async function ensureMotions() {
    if (motionCache || motionLoading) return;
    setMotionLoading(true);
    try {
      setMotionCache(await listMotions());
    } catch {
      setMotionCache([]);
    } finally {
      setMotionLoading(false);
    }
  }
  async function ensureSoulStyles() {
    if (soulStyleCache || soulStyleLoading) return;
    setSoulStyleLoading(true);
    try {
      setSoulStyleCache(await listSoulStyles());
    } catch {
      setSoulStyleCache([]);
    } finally {
      setSoulStyleLoading(false);
    }
  }

  // Eager-prefetch media каталогов когда у модели есть соответствующие settings.
  useEffect(() => {
    if (!selectedModel) return;
    const kinds = new Set<MediaPickerKind>();
    for (const s of selectedModel.settings) {
      const k = MEDIA_KIND_BY_TYPE[s.type];
      if (k) kinds.add(k);
    }
    if (kinds.has("avatar")) ensureAvatars();
    if (kinds.has("motion")) ensureMotions();
    if (kinds.has("soul-style")) ensureSoulStyles();
    // Кеши намеренно вне deps — иначе после первой загрузки triggered бы заново.
  }, [selectedModel]);

  function mediaNameLookup(kind: MediaPickerKind, id: string): string | null {
    const list = kind === "avatar" ? avatarCache : kind === "motion" ? motionCache : soulStyleCache;
    if (!list) return null;
    const found = list.find((x) => x.id === id);
    return found ? found.name : null;
  }

  function openMediaPicker(settingKey: string, kind: MediaPickerKind) {
    if (kind === "avatar") ensureAvatars();
    if (kind === "motion") ensureMotions();
    if (kind === "soul-style") ensureSoulStyles();
    setVoicePickerSetting(null);
    setMediaPickerSetting({ key: settingKey, kind });
  }

  // Upload-handler: грузит файлы в S3 через chat-uploads endpoint, обновляет
  // соответствующий slot state по мере готовности.
  async function addToSlot(slotKey: string, fileList: FileList) {
    const list = Array.from(fileList);
    const slot = activeSlots.find((s) => s.slotKey === slotKey);
    if (!slot) return;
    const currentCount = slotFiles[slotKey]?.length ?? 0;
    const room = Math.max(0, slot.maxImages - currentCount);
    const toUpload = list.slice(0, room);
    if (toUpload.length === 0) return;

    const initial: SlotFile[] = toUpload.map((file) => ({
      id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: "uploading",
      file,
    }));
    setSlotFiles((prev) => ({ ...prev, [slotKey]: [...(prev[slotKey] ?? []), ...initial] }));

    await Promise.all(
      initial.map(async (entry) => {
        try {
          const dto = await uploadChatFile(entry.file);
          setSlotFiles((prev) => ({
            ...prev,
            [slotKey]: (prev[slotKey] ?? []).map((x) =>
              x.id === entry.id ? { id: entry.id, status: "ready", file: entry.file, dto } : x,
            ),
          }));
        } catch (err) {
          const e = err as ApiError;
          const msg =
            e.code === "UNSUPPORTED_MEDIA_TYPE"
              ? "Тип не поддерживается"
              : e.code === "FILE_TOO_LARGE"
                ? "Файл больше 25 МБ"
                : e.message || "Ошибка";
          setSlotFiles((prev) => ({
            ...prev,
            [slotKey]: (prev[slotKey] ?? []).map((x) =>
              x.id === entry.id
                ? { id: entry.id, status: "error", file: entry.file, error: msg }
                : x,
            ),
          }));
        }
      }),
    );
  }

  function removeFromSlot(slotKey: string, id: string) {
    setSlotFiles((prev) => ({
      ...prev,
      [slotKey]: (prev[slotKey] ?? []).filter((x) => x.id !== id),
    }));
  }

  // Готовность к отправке: prompt непустой ИЛИ модель позволяет пустой prompt при
  // наличии обязательного слота. Все required-слоты должны быть заполнены.
  const requiredSlotsOk = activeSlots
    .filter((s) => s.required)
    .every((s) => (slotFiles[s.slotKey]?.filter((f) => f.status === "ready").length ?? 0) > 0);
  const promptOk =
    prompt.trim().length > 0 ||
    (selectedModel?.promptOptional &&
      (!selectedModel.promptOptionalRequiresMedia ||
        Object.values(slotFiles).some((arr) => arr.some((f) => f.status === "ready"))));
  const canGenerate = !!selectedModel && requiredSlotsOk && promptOk && !busy;

  async function generate() {
    if (!canGenerate || !selectedModel) return;
    setBusy(true);
    setSubmitError(null);
    try {
      // В payload — только ready-файлы (uploading/error пропускаем). Передаём
      // s3Key'и: presigned URL'ы могут протухнуть, бекенд сам резолвит.
      const mediaInputs: Record<string, string[]> = {};
      for (const [slotKey, files] of Object.entries(slotFiles)) {
        const keys = files.flatMap((f) => (f.status === "ready" ? [f.dto.s3Key] : []));
        if (keys.length > 0) mediaInputs[slotKey] = keys;
      }

      const section = selectedModel.section;
      const settingsField =
        Object.keys(settingValues).length > 0 ? { settings: settingValues } : {};
      const mediaField =
        Object.keys(mediaInputs).length > 0 ? { mediaInputs } : {};

      let result: SubmitGenerationResponse;
      if (section === "design" || section === "image") {
        const body: SubmitImageGenerationBody = {
          modelId: selectedModel.id,
          prompt,
          ...(modeId ? { modeId } : {}),
          ...settingsField,
          ...mediaField,
        };
        result = await submitImageGeneration(body);
      } else if (section === "video") {
        const body: SubmitVideoGenerationBody = {
          modelId: selectedModel.id,
          prompt,
          ...(modeId ? { modeId } : {}),
          ...settingsField,
          ...mediaField,
        };
        result = await submitVideoGeneration(body);
      } else if (section === "audio") {
        const body: SubmitAudioGenerationBody = {
          modelId: selectedModel.id,
          prompt,
          ...settingsField,
        };
        result = await submitAudioGeneration(body);
      } else {
        throw new Error(`Unsupported section: ${section}`);
      }
      // TODO: следить за прогрессом через WS-событие на subscriber'е (job-notifications).
      console.info("[generate] job submitted", section, result.dbJobId);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Не удалось запустить генерацию";
      setSubmitError(msg);
    } finally {
      setBusy(false);
    }
  }

  // Активный picker — резолвим один раз для render'а.
  const activePickerProvider = voicePickerSetting?.provider ?? null;
  const activePickerVoices = activePickerProvider ? (voiceCache[activePickerProvider] ?? []) : [];
  const activePickerLoading = activePickerProvider ? !!voiceLoading[activePickerProvider] : false;
  const activePickerCurrentId = voicePickerSetting
    ? String(settingValues[voicePickerSetting.key] ?? "")
    : "";

  // Media picker — резолвим items и selectedIds под текущий kind.
  const mediaPickerItems: MediaPickItem[] = useMemo(() => {
    if (!mediaPickerSetting) return [];
    if (mediaPickerSetting.kind === "avatar") {
      return (avatarCache ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        meta: a.gender,
        previewUrl: a.previewUrl,
      }));
    }
    if (mediaPickerSetting.kind === "motion") {
      return (motionCache ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        previewUrl: m.previewUrl,
        meta: m.category,
      }));
    }
    return (soulStyleCache ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      previewUrl: s.previewUrl,
    }));
  }, [mediaPickerSetting, avatarCache, motionCache, soulStyleCache]);

  const mediaPickerLoading =
    mediaPickerSetting?.kind === "avatar"
      ? avatarLoading
      : mediaPickerSetting?.kind === "motion"
        ? motionLoading
        : mediaPickerSetting?.kind === "soul-style"
          ? soulStyleLoading
          : false;
  const mediaPickerPreviewKind: "image" | "video" =
    mediaPickerSetting?.kind === "motion" ? "video" : "image";

  // SelectedIds: для motion-picker — массив id'ов из MotionEntry[].
  const mediaSelectedIds: string[] = useMemo(() => {
    if (!mediaPickerSetting) return [];
    const raw = settingValues[mediaPickerSetting.key];
    if (mediaPickerSetting.kind === "motion") {
      return parseMotionValue(raw).map((e) => e.id);
    }
    return raw ? [String(raw)] : [];
  }, [mediaPickerSetting, settingValues]);

  // Подписи и max-items.
  const mediaPickerTitle = mediaPickerSetting
    ? mediaPickerSetting.kind === "avatar"
      ? "Выбор аватара"
      : mediaPickerSetting.kind === "motion"
        ? "Пресеты движения"
        : "Стиль изображения"
    : "";
  const mediaPickerSubtitle = mediaPickerSetting
    ? mediaPickerSetting.kind === "avatar"
      ? "HeyGen"
      : "HiggsField"
    : "";
  // motion-picker — multi, максимум 2 (из описания shared'-модели). Остальные — single.
  const mediaPickerMaxItems = mediaPickerSetting?.kind === "motion" ? 2 : 1;

  function onMediaSelect(ids: string[]) {
    if (!mediaPickerSetting) return;
    if (mediaPickerSetting.kind === "motion") {
      // MotionEntry[] с strength=1 по умолчанию. UI для strength добавим позже.
      const next: MotionEntry[] = ids.map((id) => ({ id, strength: 1 }));
      setSettingValues((prev) => ({ ...prev, [mediaPickerSetting.key]: next }));
    } else {
      setSettingValues((prev) => ({
        ...prev,
        [mediaPickerSetting.key]: ids[0] ?? null,
      }));
    }
  }

  return (
    <div className={clsx("gen-scene", (voicePickerSetting || mediaPickerSetting) && "has-picker")}>
      <div className="gen-bg" aria-hidden />
      <div className="gen-panel">
        <div className="gen-head">
          <h1>{title}</h1>
          <p className="gen-sub">{subtitle}</p>
        </div>

        {/* Mode tabs — только если у модели несколько режимов. */}
        {selectedModel?.modes && selectedModel.modes.length > 1 && (
          <div className="gen-mode-tabs">
            {selectedModel.modes.map((m) => (
              <button
                key={m.id}
                className={clsx("gen-mode-tab", activeMode?.id === m.id && "on")}
                onClick={() => setModeId(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}

        {/* Media slots — фильтруются по активному режиму. */}
        {activeSlots.length > 0 && (
          <div
            className={clsx("gen-slots", activeSlots.length === 1 && "is-single")}
            style={{
              gridTemplateColumns: `repeat(${Math.min(activeSlots.length, 2)}, minmax(0, 1fr))`,
            }}
          >
            {activeSlots.map((slot) => (
              <SlotCard
                key={slot.slotKey}
                slot={slot}
                files={slotFiles[slot.slotKey] ?? []}
                onAdd={(fl) => addToSlot(slot.slotKey, fl)}
                onRemove={(id) => removeFromSlot(slot.slotKey, id)}
              />
            ))}
          </div>
        )}

        {/* Prompt. */}
        <textarea
          className="gen-prompt"
          placeholder={promptPlaceholder}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
        />

        {/* Настройки модели (все, что не aspect/duration — для них своя строка). */}
        {visibleSettings.length > 0 && (
          <div className="gen-settings">
            {visibleSettings.map((s) => (
              <SettingControl
                key={s.key}
                setting={s}
                value={settingValues[s.key] ?? s.default}
                onChange={(v) => setSettingValues((prev) => ({ ...prev, [s.key]: v }))}
                openVoicePicker={(provider) => openVoicePicker(s.key, provider)}
                voiceNameLookup={voiceNameLookup}
                openMediaPicker={(kind) => openMediaPicker(s.key, kind)}
                mediaNameLookup={mediaNameLookup}
              />
            ))}
          </div>
        )}

        {/* Model picker (chip). */}
        <div ref={modelPickRef} className="gen-model-row">
          <button className="gen-model-btn" onClick={() => setModelOpen(!modelOpen)}>
            <div className="gen-model-glyph">
              {selectedModel ? modelLetter(selectedModel) : "·"}
            </div>
            <div className="gen-model-text">
              <span className="gen-model-meta">Model</span>
              <span className="gen-model-name">
                {selectedModel ? modelDisplayName(selectedModel) : "Загрузка…"}
              </span>
            </div>
            <ChevronDown size={16} />
          </button>
          {modelOpen && (
            <div className="gen-model-pop">
              {models.map((m) => (
                <button
                  key={m.id}
                  className={clsx("gen-model-row-item", m.id === modelId && "on")}
                  onClick={() => {
                    setModelId(m.id);
                    setModelOpen(false);
                  }}
                >
                  <div className="gen-model-glyph">{modelLetter(m)}</div>
                  <div className="gen-model-item-body">
                    <div className="gen-model-item-name">{modelDisplayName(m)}</div>
                    <div className="gen-model-item-desc">{modelDesc(m)}</div>
                  </div>
                  {m.id === modelId && <Check size={14} />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Generate CTA. */}
        <button className="gen-cta" disabled={!canGenerate} onClick={generate}>
          <Sparkles size={16} />
          <span>{busy ? "Generating…" : "Generate"}</span>
          {selectedModel && (
            <span className="gen-cta-cost mono">
              ≈ {Math.round(selectedModel.tokenCostApprox)} т
            </span>
          )}
        </button>

        {submitError && (
          <div className="gen-error" role="alert">
            {submitError}
          </div>
        )}
      </div>

      {voicePickerSetting && activePickerProvider && (
        <>
          {/* Backdrop — только на мобильных, скрывает остальной экран. */}
          <div
            className="voice-picker-backdrop"
            onClick={() => setVoicePickerSetting(null)}
            aria-hidden
          />
          <VoicePicker
            provider={activePickerProvider}
            voices={activePickerVoices}
            isLoading={activePickerLoading}
            currentVoiceId={activePickerCurrentId}
            onSelect={(v) => {
              setSettingValues((prev) => ({ ...prev, [voicePickerSetting.key]: v.id }));
              setVoicePickerSetting(null);
            }}
            onClose={() => setVoicePickerSetting(null)}
          />
        </>
      )}

      {mediaPickerSetting && (
        <>
          <div
            className="voice-picker-backdrop"
            onClick={() => setMediaPickerSetting(null)}
            aria-hidden
          />
          <MediaPicker
            title={mediaPickerTitle}
            subtitle={mediaPickerSubtitle}
            items={mediaPickerItems}
            isLoading={mediaPickerLoading}
            selectedIds={mediaSelectedIds}
            maxItems={mediaPickerMaxItems}
            previewKind={mediaPickerPreviewKind}
            onChange={onMediaSelect}
            onClose={() => setMediaPickerSetting(null)}
          />
        </>
      )}
    </div>
  );
}

// Legacy type re-exports — старые Image/Video их больше не используют, оставляю
// пустыми type-aliases чтобы не падали возможные сторонние импорты.
export type SceneChip = never;
export type GenModel = { id: string; name: string; description?: string };
export type GenDimension = {
  key: string;
  label: string;
  options: readonly string[];
  defaultValue: string;
};
