import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  AtSign,
  Check,
  ChevronDown,
  Image as ImageIcon,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import clsx from "clsx";
import { Trans, useTranslation } from "react-i18next";
import { uploadChatFile, signChatUploads, type ChatUploadDto } from "@/api/uploads";
import type { MediaInputSlotDto, ModelModeDto, ModelSettingDto, WebModelDto } from "@/api/models";
import { ApiError } from "@/api/client";
import { ChipPopover } from "@/components/settings/ChipPopover";
import { SettingControl } from "@/components/settings/SettingControl";
import { isSettingVisible, UNSUPPORTED_TYPES } from "@/components/settings/utils";
import {
  submitImageGeneration,
  submitVideoGeneration,
  submitAudioGeneration,
  previewGeneration,
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
import {
  listUserAvatars,
  renameUserAvatar,
  deleteUserAvatar,
  type UserAvatarDto,
} from "@/api/userAvatars";
import { useQueryClient } from "@tanstack/react-query";
import { uploadedMediaKeys } from "@/api/uploadedMedia";
import { VoicePicker } from "./VoicePicker";
import { MediaPicker, type MediaPickItem, type MediaUserItem } from "./MediaPicker";
import { MediaReusePopup, type ReusedMedia } from "./MediaReusePopup";
import { ElementMentionPicker } from "./ElementMentionPicker";
import { ElementImageSelectPopup } from "./ElementImageSelectPopup";
import { useElements } from "@/hooks/useElements";
import type { Element } from "@/api/elements";
import {
  parseActiveMentions,
  translateMentionsToCanonical,
  buildElementMediaInputs,
  type ActiveMention,
} from "@/utils/elementMentions";
import { CreateAvatarModal } from "./CreateAvatarModal";
import { GenerationHistory, type PendingJob, type TrackedJobOutput } from "./GenerationHistory";
import { FloatingMediaBg } from "./FloatingMediaBg";
import type { AmbientSection } from "@/api/ambientMedia";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useUIStore } from "@/stores/uiStore";
import { useGenerationDraftStore, type StoredSlotFile } from "@/stores/generationDraftStore";
import { navigateToGenerate, normalizeSection } from "@/utils/navigateToGenerate";
import type { GeneratePrefill } from "@/utils/navigateToGenerate";
import { PromptExamplesGallery } from "@/components/prompts/PromptExamplesGallery";
import type { PromptExample } from "@/api/promptExamples";

// Стабильная ссылка на пустой список меншенов. Когда @-элементы выключены
// (модель без promptRefs.elements), `activeMentions` отдаёт ИМЕННО её, а не
// новый `[]` на каждый рендер. Иначе новый identity на каждый символ промпта
// протекал в `activeElementIds`/`cappedMentions` и в deps debounce-эффекта
// превью, перезапуская его на каждое нажатие.
const EMPTY_MENTIONS: ActiveMention[] = [];

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
  /**
   * Скрыть UI выбора модели (дропдаун + family-axis chips). Используется
   * пресетами с зафиксированной моделью (например, /image/swap).
   */
  hideModelPicker?: boolean;
  /**
   * Скрыть поле промпта целиком. Для сценариев, где юзер только грузит медиа —
   * например, апскейл фото / удаление фона / замена лица (/image/<preset>).
   */
  hidePrompt?: boolean;
  /**
   * Фикс-промпт пресета. Если задан — именно он уходит в сабмит/preview, минуя
   * изменяемый `prompt`-стейт. Нужно для hidePrompt-пресетов: иначе при SPA-навигации
   * система восстановления черновика может затереть предзаполненный промпт пустым,
   * и бэкенд вернёт «Prompt is required». Пустая строка ("") — валидное значение
   * (модель promptOptional). `undefined` — обычный режим (промпт из стейта/ввода юзера).
   */
  fixedPrompt?: string;
  /**
   * Если задан — пресетный режим: показываем кнопку «Сбросить», когда юзер
   * вручную изменил modelId / prompt / settings относительно пресет-снимка.
   * Слот-файлы НЕ сбрасываются. Callback должен запустить повторное
   * применение префила (обычно — `navigate(pathname, { state: { prefill } })`).
   */
  onReset?: () => void;
  /**
   * Мапа `modelId → { key: value }` из пресета. При ручной смене модели
   * (когда у пресета `hideModelPicker: false` и есть `allowedModelIds`)
   * автоматически применяются настройки соответствующей модели.
   */
  presetSettingsByModel?: Record<string, Record<string, unknown>>;
  /**
   * Секция для ambient-фона на пустом экране (картинки/видео «выпадают» и
   * плавают, пока нет генераций). `undefined` — фон выключен (например, /audio).
   */
  ambientSection?: AmbientSection;
  /**
   * Секция для модалки «Готовые промпты» в шапке. Если не задана — кнопка
   * не рендерится (для пресетных страниц и аудио, где галереи нет).
   */
  promptSection?: "design" | "video";
};

type GenerateDraft = {
  modelId: string;
  prompt: string;
  settings: Record<string, unknown>;
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

/** Map setting.type → провайдер каталога голосов. */
const VOICE_PROVIDER_BY_TYPE: Record<string, VoiceProvider> = {
  "cartesia-voice-picker": "cartesia",
  "elevenlabs-voice-picker": "elevenlabs",
  "openai-voice-picker": "openai",
};

/** Типы media-пикеров (картинки/видео-превью, не voice). */
type MediaPickerKind = "avatar" | "motion" | "soul-style" | "soul-character";
const MEDIA_KIND_BY_TYPE: Record<string, MediaPickerKind> = {
  "avatar-picker": "avatar",
  "motion-picker": "motion",
  "soul-style-picker": "soul-style",
  // soul-picker — выбор пользовательского Soul-персонажа (созданного через
  // /web/user-avatars/higgsfield-soul). Каталога нет — только Мои персонажи.
  "soul-picker": "soul-character",
};

/** Для motion-picker значение — массив `{ id, strength }`. Мы храним strength=1. */
type MotionEntry = { id: string; strength: number };

function parseMotionValue(v: unknown): MotionEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is MotionEntry => !!x && typeof (x as MotionEntry).id === "string");
}

// ── Sub: slot file picker ────────────────────────────────────────────────────

type SlotMediaType = "image" | "video" | "audio";

const ACCEPT_BY_TYPE: Record<SlotMediaType, string> = {
  image: "image/png,image/jpeg,image/webp,image/gif",
  video: "video/mp4,video/quicktime,video/webm",
  audio: "audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/webm,audio/ogg",
};

// Источник правды для маппинга `slot.mode` → тип медиа. Все 12 значений
// MediaInputMode из shared/types/ai.ts покрыты: image-modes (first_frame,
// last_frame, reference, edit, style_reference, reference_element,
// reference_image) попадают в дефолт ниже; video/audio — явно.
const MODE_TO_TYPE: Record<string, SlotMediaType> = {
  motion_video: "video",
  reference_video: "video",
  first_clip: "video",
  driving_audio: "audio",
  reference_audio: "audio",
};

function slotTypeFor(slot: MediaInputSlotDto): SlotMediaType {
  return MODE_TO_TYPE[slot.mode] ?? "image";
}

function slotAcceptFor(slot: MediaInputSlotDto): string {
  return ACCEPT_BY_TYPE[slotTypeFor(slot)];
}

/** Совпадает ли MIME файла с разрешённым `accept`. Учитывает оба формата
 *  записи: явный `image/png` и wildcard `image/*`. */
function fileMatchesAccept(file: File, accept: string): boolean {
  const fileType = (file.type || "").toLowerCase();
  if (!fileType) return false;
  const fileCategory = fileType.split("/")[0];
  return accept
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .some((p) => {
      if (!p) return false;
      if (p === fileType) return true;
      if (p.endsWith("/*")) return fileCategory === p.slice(0, -2);
      return false;
    });
}

type SlotFile =
  | { id: string; status: "uploading"; file: File }
  // `file` опционален: после rehydrate из draft-store сырой File недоступен.
  | { id: string; status: "ready"; file?: File; dto: ChatUploadDto }
  | { id: string; status: "error"; file: File; error: string };

function SlotCard({
  slot,
  files,
  onOpenPicker,
  onRemove,
  onSlotError,
}: {
  slot: MediaInputSlotDto;
  files: SlotFile[];
  /** Открыть попап выбора медиа (загрузка/переиспользование). */
  onOpenPicker: () => void;
  onRemove: (id: string) => void;
  /** Превью не загрузилось (presigned URL мёртв / 403). Родитель удаляет файл
   *  и показывает rate-limited toast. */
  onSlotError?: (id: string) => void;
}) {
  const isMulti = slot.maxImages > 1;
  const canAddMore = files.length < slot.maxImages;

  return (
    <div className={clsx("gen-slot", isMulti && "gen-slot-multi")}>
      <div className="gen-slot-head">
        <span className="gen-slot-label">{slot.label}</span>
        <span className={clsx("gen-slot-badge", slot.required ? "is-required" : "is-optional")}>
          {slot.required ? "Required" : "Optional"}
        </span>
      </div>
      {files.length === 0 ? (
        <button
          className="gen-slot-drop"
          onClick={onOpenPicker}
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
            <SlotFileTile
              key={f.id}
              file={f}
              onRemove={() => onRemove(f.id)}
              onPreviewError={() => onSlotError?.(f.id)}
            />
          ))}
          {canAddMore && (
            <button className="gen-slot-add" onClick={onOpenPicker} aria-label="Добавить ещё">
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

function SlotFileTile({
  file,
  onRemove,
  onPreviewError,
}: {
  file: SlotFile;
  onRemove: () => void;
  /** Превью (img/video) выдало `error` — родитель решает, удалять ли tile. */
  onPreviewError?: () => void;
}) {
  // ObjectURL для preview из локального File (быстрее чем ждать presigned URL).
  // Для image — превью; для video — тоже превью (первый кадр через <video>).
  // Audio не превьюим — там нечего показать, останется иконка.
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const fileKind = file.file?.type?.split("/")[0] ?? null;
  useEffect(() => {
    if (!file.file || (fileKind !== "image" && fileKind !== "video")) {
      setLocalUrl(null);
      return;
    }
    const u = URL.createObjectURL(file.file);
    setLocalUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file.file, fileKind]);

  const dtoMime = file.status === "ready" ? file.dto.mimeType : null;
  const dtoKind = dtoMime ? dtoMime.split("/")[0] : null;
  const previewKind = fileKind ?? dtoKind;
  const url = file.status === "ready" ? (file.dto.url ?? localUrl) : localUrl;
  const altName = file.file?.name ?? (file.status === "ready" ? file.dto.name : "");
  // Только restored-файлы (без сырого File) могут «протухнуть» — у свежезагруженных
  // fallback на localUrl всё равно покажет картинку, дроп бы был ложным.
  const handlePreviewError = () => {
    if (!file.file) onPreviewError?.();
  };
  return (
    <div
      className={clsx(
        "gen-slot-tile",
        file.status === "uploading" && "is-uploading",
        file.status === "error" && "is-error",
      )}
    >
      {url && previewKind === "image" ? (
        <img src={url} alt={altName} onError={handlePreviewError} />
      ) : url && previewKind === "video" ? (
        <video src={url} muted playsInline preload="metadata" onError={handlePreviewError} />
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

/**
 * Одна настройка = один chip с label + текущим значением.
 * Клик по chip'у открывает popover с фактическим control'ом (slider / chip-row
 * вариантов / input). Toggle и voice/media-pickers — спец-случаи без popover'а:
 *  - toggle: клик мгновенно переключает значение
 *  - voice/media: клик открывает существующий side-drawer
 */
function SettingChip({
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
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  // Outside-click закрывает popover. Учитываем и chip, и popover (portal).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (chipRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // ── Voice picker chip → открывает side-drawer (не popover) ────────────────
  const voiceProvider = VOICE_PROVIDER_BY_TYPE[setting.type];
  if (voiceProvider && openVoicePicker) {
    const currentId = String(value ?? setting.default ?? "");
    const name = currentId ? (voiceNameLookup?.(voiceProvider, currentId) ?? null) : null;
    return (
      <button
        type="button"
        className="gen-chip-pill"
        onClick={() => openVoicePicker(voiceProvider)}
        title={setting.description ?? setting.label}
      >
        <span className="gen-chip-pill-label">{setting.label}:</span>
        <span className="gen-chip-pill-val">{name ?? "Не выбрано"}</span>
      </button>
    );
  }

  // ── Media picker chip → открывает side-drawer ─────────────────────────────
  const mediaKind = MEDIA_KIND_BY_TYPE[setting.type];
  if (mediaKind && openMediaPicker) {
    let summary: string;
    if (mediaKind === "motion") {
      const entries = parseMotionValue(value ?? setting.default);
      summary =
        entries.length === 0
          ? "Не выбрано"
          : entries.length === 1
            ? (mediaNameLookup?.(mediaKind, entries[0].id) ?? entries[0].id)
            : `${entries.length} пресета`;
    } else {
      const currentId = String(value ?? setting.default ?? "");
      summary = currentId ? (mediaNameLookup?.(mediaKind, currentId) ?? currentId) : "Не выбрано";
    }
    return (
      <button
        type="button"
        className="gen-chip-pill"
        onClick={() => openMediaPicker(mediaKind)}
        title={setting.description ?? setting.label}
      >
        <span className="gen-chip-pill-label">{setting.label}:</span>
        <span className="gen-chip-pill-val">{summary}</span>
      </button>
    );
  }

  // ── Toggle chip → клик переключает, popover не нужен ──────────────────────
  if (setting.type === "toggle") {
    const checked = Boolean(value);
    return (
      <button
        type="button"
        className={clsx("gen-chip-pill", checked && "is-on")}
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        title={setting.description ?? setting.label}
      >
        <span className="gen-chip-pill-label">{setting.label}:</span>
        <span className="gen-chip-pill-val">{checked ? "Вкл" : "Выкл"}</span>
      </button>
    );
  }

  // ── Summary для chip-display ──────────────────────────────────────────────
  let summary: React.ReactNode;
  if (setting.type === "color") {
    const hex = typeof value === "string" && value ? value : String(setting.default ?? "#000000");
    summary = (
      <span className="gen-chip-pill-swatch-wrap">
        <span className="gen-chip-pill-swatch" style={{ background: hex }} />
        <span>{hex}</span>
      </span>
    );
  } else if (setting.type === "slider" || setting.type === "number") {
    const num = typeof value === "number" ? value : Number(setting.default ?? 0);
    summary = String(num);
  } else if (setting.type === "text") {
    const text = typeof value === "string" ? value : String(setting.default ?? "");
    summary = text || "Не задано";
  } else if (setting.type === "select" || setting.type === "dropdown") {
    const opts = setting.options ?? [];
    const cur = String(value ?? setting.default ?? "");
    const found = opts.find((o) => String(o.value) === cur);
    summary = found?.label ?? cur ?? "—";
  } else {
    return null; // unknown type
  }

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={clsx("gen-chip-pill", open && "is-open")}
        onClick={() => setOpen((v) => !v)}
        title={setting.description ?? setting.label}
      >
        <span className="gen-chip-pill-label">{setting.label}:</span>
        <span className="gen-chip-pill-val">{summary}</span>
      </button>
      {open && (
        <ChipPopover anchorRef={chipRef} popRef={popRef}>
          <SettingControl setting={setting} value={value} onChange={onChange} />
        </ChipPopover>
      )}
    </>
  );
}

/**
 * Chip-выбор для оси семейства моделей (версия / вариант). Структурно — то же
 * самое, что generic `SettingChip` для select, но значение не идёт в
 * `settingValues`: клик меняет `modelId` сцены (свопаем сиблинга семейства).
 *
 * Если в семействе только одно значение на оси (например все Recraft-сиблинги
 * имеют `versionLabel="v4"`), компонент возвращает `null` — лишний chip без
 * выбора прятать чище, чем показывать noop-кнопку.
 */
function FamilyAxisChip({
  label,
  current,
  options,
  onSelect,
}: {
  label: string;
  current: string;
  options: string[];
  onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (chipRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (options.length <= 1) return null;

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={clsx("gen-chip-pill", open && "is-open")}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="gen-chip-pill-label">{label}:</span>
        <span className="gen-chip-pill-val">{current}</span>
      </button>
      {open && (
        <ChipPopover anchorRef={chipRef} popRef={popRef}>
          <div className="gen-pop-body">
            <div className="gen-pop-chips-row">
              {options.map((o) => (
                <button
                  key={o}
                  type="button"
                  className={clsx("gen-chip", o === current && "on")}
                  onClick={() => {
                    onSelect(o);
                    setOpen(false);
                  }}
                >
                  {o}
                </button>
              ))}
            </div>
          </div>
        </ChipPopover>
      )}
    </>
  );
}

// ── Main scene ───────────────────────────────────────────────────────────────

export function GenerateScene({
  title,
  subtitle,
  promptPlaceholder,
  models,
  hideModelPicker = false,
  hidePrompt = false,
  fixedPrompt,
  onReset,
  presetSettingsByModel,
  ambientSection,
  promptSection,
}: GenerateSceneProps) {
  const { t } = useTranslation();
  // Ambient-фон только на «десктопной» ширине (≥900px). На телефонах и iPad в
  // портрете (<900) его нет — там панель и так full-width, медиа некуда класть.
  // iPad в ландшафте (1024px) уже считается десктопом → фон показываем.
  const isMobile = useIsMobile();
  const promptsDialogRef = useRef<HTMLDialogElement>(null);

  // ── Family grouping ───────────────────────────────────────────────────────
  // `models` приходит ПОЛНЫМ списком секции (page-обёртки больше не дедупят) —
  // здесь делаем дедуп по familyId для дропдауна моделей в footer'е и считаем
  // siblings + версии/варианты для chip'ов в блоке настроек.
  const families = useMemo(() => {
    const seen = new Set<string>();
    const out: WebModelDto[] = [];
    for (const m of models) {
      const key = m.familyId ?? m.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    return out;
  }, [models]);

  // Выбранная модель / режим / промпт / настройки / файлы по слотам.
  // Lazy initializer берёт `?model=` из URL сразу на mount, чтобы R0 не целился
  // в families[0] и не перетирал store сторонней моделью до URL-sync effect'а.
  const [modelId, setModelId] = useState<string>(() => {
    const urlModel =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("model")
        : null;
    return urlModel ?? families[0]?.id ?? "";
  });
  const [modeId, setModeId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [settingValues, setSettingValues] = useState<Record<string, unknown>>({});
  const [slotFiles, setSlotFiles] = useState<Record<string, SlotFile[]>>({});
  // Какой слот сейчас открыл попап выбора медиа (upload / переиспользование).
  const [reuseSlotKey, setReuseSlotKey] = useState<string | null>(null);

  // ── @-меншены элементов (MVP) ───────────────────────────────────────────────
  // Открыт ли модальный пикер элементов (кнопка @Elements).
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  // Для какого элемента открыт попап выбора картинок (null — закрыт).
  const [imageSelectFor, setImageSelectFor] = useState<Element | null>(null);
  // Активный inline-`@`-токен у курсора (для dropdown'а подсказок).
  const [mentionQuery, setMentionQuery] = useState<{ query: string; start: number } | null>(null);
  // Подсвеченный пункт dropdown'а (клавиатурная навигация ↑/↓/Enter).
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  // Выбор картинок per-element: elementId → s3Key[] (персист в draft-store).
  const [elementSelections, setElementSelections] = useState<Record<string, string[]>>({});
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Активный mode-tab — чтобы доскроллить к нему при переключении режима.
  const activeModeTabRef = useRef<HTMLButtonElement | null>(null);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const modelBtnRef = useRef<HTMLButtonElement | null>(null);
  const modelPopRef = useRef<HTMLDivElement | null>(null);

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

  // Пользовательские аватары — отдельные кеши per provider, отображаются в верхней
  // секции пикера. Поллим если есть pending (status="creating") Soul-аватары.
  const [heygenUserCache, setHeygenUserCache] = useState<UserAvatarDto[] | null>(null);
  const [heygenUserLoading, setHeygenUserLoading] = useState(false);
  const [soulUserCache, setSoulUserCache] = useState<UserAvatarDto[] | null>(null);
  const [soulUserLoading, setSoulUserLoading] = useState(false);

  // Модалка создания аватара — provider определяет UI (1 фото vs 10-30 фото).
  const [createAvatarProvider, setCreateAvatarProvider] = useState<
    "heygen" | "higgsfield_soul" | null
  >(null);

  // Динамическая стоимость генерации — пересчитывается после изменения
  // настроек/слотов/промпта/модели (с дебаунсом). `null` до первого ответа —
  // тогда UI использует статический `tokenCostApprox` из каталога.
  const [previewCost, setPreviewCost] = useState<number | null>(null);
  const [previewPricingMode, setPreviewPricingMode] = useState<"total" | "per_second">("total");
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewAbortRef = useRef<AbortController | null>(null);

  // Локально трекаемые job'ы между submit'ом и финальным WS-event'ом.
  // GenerationHistory сама подписывается на notification:new и зовёт
  // onJobResolved/onJobFailed когда соответствующая нотификация прилетает.
  const [pendingJobs, setPendingJobs] = useState<PendingJob[]>([]);

  // Стабильные колбэки для GenerationHistory — иначе инлайн-стрелки меняли бы
  // ссылку на каждый рендер и React.memo на истории не срабатывал бы (она
  // перерисовывалась бы на каждый символ промпта). Завязаны только на стабильный
  // setPendingJobs, поэтому deps пустые.
  const handleJobResolved = useCallback((jobId: string) => {
    setPendingJobs((prev) => prev.filter((p) => p.id !== jobId));
  }, []);
  const handleJobFailed = useCallback((jobId: string, errorMessage: string) => {
    setPendingJobs((prev) =>
      prev.map((p) => (p.id === jobId ? { ...p, errorMessage, status: "error" } : p)),
    );
  }, []);
  const handleJobSucceeded = useCallback((jobId: string, outputs: TrackedJobOutput[]) => {
    setPendingJobs((prev) =>
      prev.map((p) => (p.id === jobId ? { ...p, outputs, status: "success" } : p)),
    );
  }, []);

  // Есть ли уже генерации в правой пэйне. Пока пусто и задан ambientSection —
  // в фоне показываем «выпадающие» плавающие медиа; как только появилась первая
  // генерация — фон скрывается (его место занимает галерея).
  const [historyHasContent, setHistoryHasContent] = useState(false);

  // Когда модели приехали — выставляем дефолт (первый из дедуплированных
  // семейств, не из полного списка: иначе можно случайно стартовать с
  // not-default-варианта).
  useEffect(() => {
    if (!modelId && families.length > 0) setModelId(families[0].id);
  }, [families, modelId]);

  // ── URL → modelId sync ────────────────────────────────────────────────────
  // `?model=<id>` в URL — источник правды для навигации (mega-menu в navbar'е,
  // shareable links). Когда юзер уже в текущем разделе и кликает другую модель
  // в navbar'е, route не меняется → размонта нет → без этого effect'а modelId
  // не переключился бы.
  //
  // Обратный синк (state → URL) делаем НЕ через effect, а атомарным `pickModel`
  // helper'ом — иначе два effect'а отвечающие друг другу зациклились бы
  // (state="A" эхает в URL "A", тем временем URL="B" эхает в state "B" → swap).
  const [searchParams, setSearchParams] = useSearchParams();
  const urlModelId = searchParams.get("model");

  // URL подтягивается React Router'ом отдельно от setState — между pickModel
  // и обновлением useSearchParams() есть кадр, где state опережает URL.
  // lastPickedRef не даёт URL-sync вернуть modelId на stale urlModelId.
  const lastPickedRef = useRef<string | null>(null);

  // Помечает modelId, для которого state синхронизирован со store. Sync-эффекты
  // пишут в store только при совпадении — иначе на mount, до загрузки каталога,
  // sync написал бы пустые values и перетёр сохранённое.
  const restoredForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!urlModelId) return;
    if (urlModelId === modelId && lastPickedRef.current === modelId) {
      lastPickedRef.current = null;
      return;
    }
    if (urlModelId === modelId) return;
    if (lastPickedRef.current === modelId) return;
    if (models.some((m) => m.id === urlModelId)) {
      setModelId(urlModelId);
    }
  }, [urlModelId, models, modelId]);

  // Atomic swap: settings/slots/mode + modelId + URL за один event handler
  // (React батчит) → UI не показывает stale slot files предыдущей модели.
  function pickModel(id: string) {
    if (id === modelId) return;
    const { settings, slots, prompt: p, elementSelections: sel } = restoreDraftForModel(id);
    lastPickedRef.current = id;
    restoredForRef.current = id;
    setModeId(null);
    setSettingValues(settings);
    setSlotFiles(slots);
    setPrompt(p);
    setElementSelections(sel);
    setModelId(id);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("model", id);
        return next;
      },
      { replace: true },
    );
    void refreshRestoredSlotUrls(slots);
  }

  // Читает per-family bag из draft-store, фильтрует слоты по mediaInputs
  // целевой модели и обрезает каждый до slot.maxImages.
  function restoreDraftForModel(id: string): {
    settings: Record<string, unknown>;
    slots: Record<string, SlotFile[]>;
    prompt: string;
    elementSelections: Record<string, string[]>;
  } {
    const target = models.find((m) => m.id === id);
    if (!target) return { settings: {}, slots: {}, prompt: "", elementSelections: {} };
    const key = target.familyId ?? target.id;
    const entry = useGenerationDraftStore.getState().byKey[key];
    if (!entry) return { settings: {}, slots: {}, prompt: "", elementSelections: {} };
    const slots: Record<string, SlotFile[]> = {};
    for (const slot of target.mediaInputs ?? []) {
      const arr = entry.slots[slot.slotKey];
      if (arr && arr.length > 0) {
        slots[slot.slotKey] = arr.slice(0, slot.maxImages).map((f) => ({
          id: f.id,
          status: "ready" as const,
          dto: f.dto,
        }));
      }
    }
    return {
      settings: entry.settings,
      slots,
      prompt: entry.prompt ?? "",
      elementSelections: entry.elementSelections ?? {},
    };
  }

  // selectedModel ищем в полном `models` (sibling-варианты тоже там) —
  // дропдаун показывает только families[0] на семейство, но юзер может
  // переключиться на sibling через version/variant chip'ы.
  const selectedModel = useMemo(
    () => models.find((m) => m.id === modelId) ?? families[0],
    [models, families, modelId],
  );

  // ── Family axis (version / variant) ────────────────────────────────────────
  // Считаем siblings выбранной модели и доступные version/variant под them.
  // Возвращаем null если у модели нет familyId или в семействе всего 1 модель.
  //
  // Не у всех семейств есть version-ось: например kling имеет только variantLabel
  // (Standard/Pro), без versionLabel. В этом случае variants берутся из ВСЕХ
  // siblings, а не из подмножества с тем же versionLabel'ом — иначе chip не
  // рендерился бы (variantSource был бы пуст).
  const familyAxis = useMemo(() => {
    if (!selectedModel?.familyId) return null;
    const siblings = models.filter((m) => m.familyId === selectedModel.familyId);
    if (siblings.length <= 1) return null;
    // Уникальные version'ы в порядке появления (Set сохраняет insertion order).
    const versions = Array.from(
      new Set(siblings.map((m) => m.versionLabel).filter((v): v is string => !!v)),
    );
    const currentVersion = selectedModel.versionLabel ?? null;
    // Если у семейства есть version-ось — фильтруем variants по текущей версии,
    // иначе берём из всех siblings.
    const variantSource =
      versions.length > 0 && currentVersion
        ? siblings.filter((m) => m.versionLabel === currentVersion)
        : siblings;
    const variants = Array.from(
      new Set(variantSource.map((m) => m.variantLabel).filter((v): v is string => !!v)),
    );
    return {
      versions,
      currentVersion,
      variants,
      currentVariant: selectedModel.variantLabel ?? null,
    };
  }, [models, selectedModel]);

  // Свопаем modelId на sibling с указанной версией. Стараемся сохранить
  // вариант (Pro→Pro), иначе берём первый sibling в новой версии.
  function selectFamilyVersion(version: string) {
    if (!selectedModel?.familyId) return;
    const siblings = models.filter((m) => m.familyId === selectedModel.familyId);
    const target =
      siblings.find(
        (m) => m.versionLabel === version && m.variantLabel === selectedModel.variantLabel,
      ) ?? siblings.find((m) => m.versionLabel === version);
    if (target) pickModel(target.id);
  }

  function selectFamilyVariant(variant: string) {
    if (!selectedModel?.familyId) return;
    const siblings = models.filter((m) => m.familyId === selectedModel.familyId);
    const target = siblings.find(
      (m) => m.versionLabel === selectedModel.versionLabel && m.variantLabel === variant,
    );
    if (target) pickModel(target.id);
  }

  // Safety net: пути, где modelId меняется не через pickModel (lazy initializer
  // на mount, URL-sync на внешнюю навигацию, prefill effect ниже). Зависит от
  // `models`, чтобы перезапуститься после загрузки каталога. Stage-2 prefill и
  // preset-by-model effect идут ПОСЛЕ в порядке объявления — preset wins.
  useEffect(() => {
    if (!modelId) {
      setModeId(null);
      setSettingValues({});
      setSlotFiles({});
      setPrompt("");
      setElementSelections({});
      restoredForRef.current = null;
      return;
    }
    if (restoredForRef.current === modelId) return;
    if (models.length === 0) return;
    if (!models.some((m) => m.id === modelId)) return;

    setModeId(null);
    restoredForRef.current = modelId;
    const { settings, slots, prompt: p, elementSelections: sel } = restoreDraftForModel(modelId);
    setSettingValues(settings);
    setSlotFiles(slots);
    setPrompt(p);
    setElementSelections(sel);
    void refreshRestoredSlotUrls(slots);
  }, [modelId, models]);

  // Sync settingValues → draft-store под per-family key.
  useEffect(() => {
    if (!selectedModel) return;
    if (restoredForRef.current !== selectedModel.id) return;
    const key = selectedModel.familyId ?? selectedModel.id;
    useGenerationDraftStore.getState().setSettings(key, settingValues);
  }, [selectedModel, settingValues]);

  // Sync slotFiles → draft-store. Только `ready`-файлы; uploading/error не персистим.
  useEffect(() => {
    if (!selectedModel) return;
    if (restoredForRef.current !== selectedModel.id) return;
    const key = selectedModel.familyId ?? selectedModel.id;
    const stored: Record<string, StoredSlotFile[]> = {};
    for (const [k, arr] of Object.entries(slotFiles)) {
      const ready = arr.flatMap((f) =>
        f.status === "ready" ? [{ id: f.id, status: "ready" as const, dto: f.dto }] : [],
      );
      if (ready.length > 0) stored[k] = ready;
    }
    useGenerationDraftStore.getState().setSlots(key, stored);
  }, [selectedModel, slotFiles]);

  // Sync elementSelections → draft-store (выбор картинок @-элементов).
  useEffect(() => {
    if (!selectedModel) return;
    if (restoredForRef.current !== selectedModel.id) return;
    const key = selectedModel.familyId ?? selectedModel.id;
    useGenerationDraftStore.getState().setElementSelections(key, elementSelections);
  }, [selectedModel, elementSelections]);

  // Sync prompt → draft-store (per-family) — переживает перезагрузку страницы.
  useEffect(() => {
    if (!selectedModel) return;
    if (restoredForRef.current !== selectedModel.id) return;
    const key = selectedModel.familyId ?? selectedModel.id;
    useGenerationDraftStore.getState().setPrompt(key, prompt);
  }, [selectedModel, prompt]);

  // Авто-рост textarea промпта под контент (в пределах CSS min/max-height).
  // Реагирует и на ввод, и на программную подстановку (restore / @-меншены).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [prompt]);

  // ── Prefill из location.state (Gallery «Повторить» / PromptsPage «Попробовать») ──
  // Источник кладёт payload через `navigateToGenerate(...)`. Применяем один раз
  // на каждый navigate (страж — `location.key`, не булевый флаг — иначе
  // самопереход /image → /image с новым префилом не сработает).
  //
  // Двухстадийное применение нужно из-за того, что reset-effect выше (на смену
  // modelId) обнуляет settingValues, а defaults-effect ниже (на selectedModel)
  // заполняет дефолты. Если бы мы сразу setSettingValues(prefill.settings) —
  // оба effect'а затёрли бы префил. Решение: кладём payload в ref, второй
  // effect ниже (зависит от selectedModel — выполнится ПОСЛЕ reset и defaults)
  // применяет ref поверх дефолтов.
  const location = useLocation();
  const navigate = useNavigate();
  const pushToast = useUIStore((s) => s.pushToast);
  const lastConsumedPrefillKey = useRef<string | null>(null);
  const pendingPrefillRef = useRef<GeneratePrefill | null>(null);
  // Параллельно с pendingPrefillRef помечаем «это восстановление черновика,
  // не пресет» — чтобы stage-2 effect не ставил presetSnapshot и кнопка
  // «Сбросить» не появилась после возврата назад.
  const pendingPrefillIsDraftRef = useRef<boolean>(false);
  // Снимок последнего применённого префила — используется для определения
  // «юзер что-то поменял» (isDirty) и показа кнопки «Сбросить» на пресетных
  // страницах. Включает modelId / prompt / settings; slotFiles не трекаем.
  const [presetSnapshot, setPresetSnapshot] = useState<{
    modelId: string;
    prompt: string;
    settings: Record<string, unknown>;
  } | null>(null);
  useEffect(() => {
    const state = location.state as { prefill?: GeneratePrefill; draft?: GenerateDraft } | null;
    // Draft восстанавливается при back-навигации с модалки «Готовые промпты»:
    // тот же путь, что и для prefill, но без snapshot'а (это «возврат к
    // черновику», а не пресет → кнопка «Сбросить» не должна появиться).
    const prefill = state?.prefill;
    const draft = !prefill && state?.draft ? state.draft : null;
    if (!prefill && !draft) return;
    if (lastConsumedPrefillKey.current === location.key) return;
    if (models.length === 0) return; // ждём загрузку каталога

    const requestedModelId = prefill?.modelId ?? draft?.modelId;
    if (!requestedModelId) return;
    const modelExists = models.some((m) => m.id === requestedModelId);
    const targetId = modelExists ? requestedModelId : (families[0]?.id ?? null);
    if (!targetId) return; // ни запрошенной, ни дефолтной модели нет — выходим

    lastConsumedPrefillKey.current = location.key;

    // settings оставляем только если модель найдена — чужие ключи для дефолтной
    // модели смысла не имеют (юзер увидит, что чипы не реагируют на префил).
    const sourcePrompt = prefill?.prompt ?? draft?.prompt ?? "";
    const sourceSettings = prefill ? prefill.settings : draft?.settings;
    // resolved.section используется только как ярлык для тоста — apply берёт
    // modelId/prompt/settings. Для draft (без prefill) — фолбэк "image".
    const resolved: GeneratePrefill = {
      section: prefill?.section ?? "image",
      modelId: targetId,
      prompt: sourcePrompt,
      settings: modelExists ? sourceSettings : undefined,
    };

    if (modelId === targetId) {
      // Модель уже выбрана — никаких reset/defaults effect'ов не будет.
      // Применяем напрямую, без ref'а.
      setPrompt(resolved.prompt ?? "");
      if (resolved.settings) {
        setSettingValues((prev) => ({ ...prev, ...resolved.settings }));
      }
      // Snapshot для isDirty — только для пресет-префила. Восстановление
      // черновика (draft) snapshot НЕ устанавливает: это просто возврат
      // к юзерскому состоянию, кнопка «Сбросить» не нужна.
      if (prefill) {
        setPresetSnapshot({
          modelId: targetId,
          prompt: resolved.prompt ?? "",
          settings: resolved.settings ?? {},
        });
      }
    } else {
      // Отложенное применение — после reset и defaults effect'ов.
      pendingPrefillRef.current = resolved;
      pendingPrefillIsDraftRef.current = !prefill;
      setModelId(targetId);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("model", targetId);
          return next;
        },
        { replace: true },
      );
    }

    if (!modelExists) {
      pushToast({
        type: "info",
        message: "Модель из примера больше недоступна — открыли с дефолтной",
      });
    }

    // Чистим location.state — чтобы F5 / back-navigation не повторили префил.
    navigate(location.pathname + location.search, { replace: true, state: null });
  }, [
    location.key,
    location.state,
    location.pathname,
    location.search,
    models,
    families,
    modelId,
    navigate,
    setSearchParams,
    pushToast,
  ]);

  const activeMode = useMemo(
    () => resolveActiveMode(selectedModel?.modes ?? null, modeId),
    [selectedModel, modeId],
  );

  // Доскроллить tab-полосу к активному режиму (горизонтально, без vertical-jump).
  useEffect(() => {
    activeModeTabRef.current?.scrollIntoView({
      inline: "nearest",
      block: "nearest",
      behavior: "smooth",
    });
  }, [activeMode?.id]);

  const activeSlots = useMemo(
    () => (selectedModel ? getActiveSlots(selectedModel.mediaInputs, activeMode) : []),
    [selectedModel, activeMode],
  );

  // ── @-меншены элементов: capability + активные меншены ──────────────────────
  // Модель поддерживает @-элементы, если в promptRefs задан `elements`. Картинки
  // элемента кладутся в слоты ref_element_N — их карточки в UI прячем (juзер
  // подставляет элементы через @ в промпте), но в каталоге слоты остаются.
  const elementsCap = selectedModel?.promptRefs?.elements ?? null;
  const elementsFeatureOn = !!elementsCap;
  const maxImagesPerElement = useMemo(
    () => selectedModel?.mediaInputs.find((s) => s.mode === "reference_element")?.maxImages ?? 4,
    [selectedModel],
  );
  // Список грузим только когда фича включена (enabled toggle в useElements).
  const { elements: userElements } = useElements(elementsFeatureOn);
  // Активные элементы выводятся из текста промпта (порядок = первое появление).
  const activeMentions = useMemo(
    () => (elementsFeatureOn ? parseActiveMentions(prompt, userElements) : EMPTY_MENTIONS),
    [elementsFeatureOn, prompt, userElements],
  );
  const activeElementIds = useMemo(
    () => new Set(activeMentions.map((m) => m.element.id)),
    [activeMentions],
  );
  // Слоты без reference_element — их карточки рендерим, элементные прячем.
  const visibleSlots = useMemo(
    () => activeSlots.filter((s) => s.mode !== "reference_element"),
    [activeSlots],
  );
  // Меншены в пределах лимита модели — только они едут в слоты/трансляцию.
  const cappedMentions = useMemo(
    () => (elementsCap ? activeMentions.slice(0, elementsCap.max) : []),
    [elementsCap, activeMentions],
  );
  // Подсказки inline-`@`: элементы по фильтру, без уже активных, при не-лимите.
  const mentionMatches = useMemo(() => {
    if (!mentionQuery || !elementsFeatureOn) return [];
    if (elementsCap && activeMentions.length >= elementsCap.max) return [];
    const q = mentionQuery.query.toLowerCase();
    return userElements
      .filter((el) => !activeElementIds.has(el.id) && el.name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [
    mentionQuery,
    elementsFeatureOn,
    elementsCap,
    activeMentions,
    userElements,
    activeElementIds,
  ]);

  // Список доступных settings — выкидываем unsupported types и применяем dependsOn.
  const visibleSettings = useMemo(() => {
    if (!selectedModel) return [];
    return selectedModel.settings.filter(
      (s) => !UNSUPPORTED_TYPES.has(s.type) && isSettingVisible(s, settingValues),
    );
  }, [selectedModel, settingValues]);

  // Юзер расходится с применённым пресет-снимком? Показ кнопки «Сбросить»
  // на пресетных страницах. Сравниваем только то, что снимок описывает —
  // modelId / prompt / ключи из snapshot.settings. Дополнительные ручные
  // настройки за пределами snapshot.settings не считаем «изменением пресета».
  const isDirtyFromPreset = useMemo(() => {
    if (!presetSnapshot) return false;
    if (presetSnapshot.modelId !== modelId) return true;
    if (presetSnapshot.prompt !== prompt) return true;
    for (const [k, v] of Object.entries(presetSnapshot.settings)) {
      if (settingValues[k] !== v) return true;
    }
    return false;
  }, [presetSnapshot, modelId, prompt, settingValues]);

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

  // Stage 2 префила — выполняется ПОСЛЕ defaults-effect выше (порядок useEffect
  // соответствует порядку объявления), поэтому накладываем prefill.settings
  // поверх свежевыставленных дефолтов.
  useEffect(() => {
    const pending = pendingPrefillRef.current;
    if (!pending) return;
    if (!selectedModel || selectedModel.id !== pending.modelId) return;
    const isDraft = pendingPrefillIsDraftRef.current;
    pendingPrefillRef.current = null;
    pendingPrefillIsDraftRef.current = false;
    setPrompt(pending.prompt ?? "");
    if (pending.settings) {
      const pendingSettings = pending.settings;
      setSettingValues((prev) => ({ ...prev, ...pendingSettings }));
    }
    if (!isDraft) {
      setPresetSnapshot({
        modelId: pending.modelId,
        prompt: pending.prompt ?? "",
        settings: pending.settings ?? {},
      });
    }
  }, [selectedModel]);

  // Авто-применение per-model настроек пресета при ручной смене модели.
  // Срабатывает только в пресет-режиме (есть snapshot) и только когда юзер
  // сменил модель на ОТЛИЧНУЮ от той, что в snapshot'е — иначе после первичного
  // префила (stage-2 выше) snapshot.modelId === selectedModel.id и мы no-op.
  // prompt в snapshot оставляем прежним, чтобы dirty-индикатор по prompt
  // продолжал работать корректно после смены модели.
  useEffect(() => {
    if (!presetSettingsByModel) return;
    if (!selectedModel || !presetSnapshot) return;
    if (presetSnapshot.modelId === selectedModel.id) return;

    const next = presetSettingsByModel[selectedModel.id];
    if (next) {
      setSettingValues((prev) => ({ ...prev, ...next }));
    }
    setPresetSnapshot({
      modelId: selectedModel.id,
      prompt: presetSnapshot.prompt,
      settings: next ?? {},
    });
  }, [selectedModel, presetSettingsByModel, presetSnapshot]);

  // Outside-click для popover'а моделей. Popup в portal'е → проверяем оба ref'а.
  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (modelBtnRef.current?.contains(t)) return;
      if (modelPopRef.current?.contains(t)) return;
      setModelOpen(false);
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

  // Пользовательские аватары — force-reload поддерживается через `reload=true`
  // (после создания/удаления/переименования).
  async function ensureUserAvatars(
    provider: "heygen" | "higgsfield_soul",
    opts?: { reload?: boolean },
  ) {
    const isHey = provider === "heygen";
    if (!opts?.reload) {
      if (isHey && (heygenUserCache || heygenUserLoading)) return;
      if (!isHey && (soulUserCache || soulUserLoading)) return;
    }
    if (isHey) setHeygenUserLoading(true);
    else setSoulUserLoading(true);
    try {
      const list = await listUserAvatars(provider);
      if (isHey) setHeygenUserCache(list);
      else setSoulUserCache(list);
    } catch {
      if (isHey) setHeygenUserCache([]);
      else setSoulUserCache([]);
    } finally {
      if (isHey) setHeygenUserLoading(false);
      else setSoulUserLoading(false);
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
    if (kinds.has("avatar")) {
      ensureAvatars();
      ensureUserAvatars("heygen");
    }
    if (kinds.has("motion")) ensureMotions();
    if (kinds.has("soul-style")) ensureSoulStyles();
    if (kinds.has("soul-character")) ensureUserAvatars("higgsfield_soul");
    // Кеши намеренно вне deps — иначе после первой загрузки triggered бы заново.
  }, [selectedModel]);

  function mediaNameLookup(kind: MediaPickerKind, id: string): string | null {
    // Пользовательские пикеры — ищем по своему кешу, иначе фоллбэк на каталог.
    if (kind === "avatar") {
      const userHit = heygenUserCache?.find((x) => x.externalId === id || x.id === id);
      if (userHit) return userHit.name;
      const catalogHit = avatarCache?.find((x) => x.id === id);
      return catalogHit?.name ?? null;
    }
    if (kind === "soul-character") {
      const hit = soulUserCache?.find((x) => x.externalId === id || x.id === id);
      return hit?.name ?? null;
    }
    if (kind === "motion") {
      const hit = motionCache?.find((x) => x.id === id);
      return hit?.name ?? null;
    }
    const hit = soulStyleCache?.find((x) => x.id === id);
    return hit?.name ?? null;
  }

  function openMediaPicker(settingKey: string, kind: MediaPickerKind) {
    if (kind === "avatar") {
      ensureAvatars();
      ensureUserAvatars("heygen");
    }
    if (kind === "motion") ensureMotions();
    if (kind === "soul-style") ensureSoulStyles();
    if (kind === "soul-character") ensureUserAvatars("higgsfield_soul");
    setVoicePickerSetting(null);
    setMediaPickerSetting({ key: settingKey, kind });
  }

  async function handleRenameUserAvatar(id: string, currentName: string) {
    const newName = window.prompt("Новое название", currentName)?.trim();
    if (!newName || newName === currentName) return;
    try {
      await renameUserAvatar(id, newName);
    } finally {
      // reload оба кеша лениво — мы не знаем какой именно provider у id
      if (heygenUserCache?.some((x) => x.id === id)) {
        void ensureUserAvatars("heygen", { reload: true });
      }
      if (soulUserCache?.some((x) => x.id === id)) {
        void ensureUserAvatars("higgsfield_soul", { reload: true });
      }
    }
  }

  async function handleDeleteUserAvatar(id: string) {
    if (!window.confirm("Удалить аватар? Это действие нельзя отменить.")) return;
    try {
      await deleteUserAvatar(id);
    } finally {
      if (heygenUserCache?.some((x) => x.id === id)) {
        void ensureUserAvatars("heygen", { reload: true });
      }
      if (soulUserCache?.some((x) => x.id === id)) {
        void ensureUserAvatars("higgsfield_soul", { reload: true });
      }
    }
  }

  // Upload-handler: грузит файлы в S3 через chat-uploads endpoint, обновляет
  // соответствующий slot state по мере готовности.
  async function addToSlot(slotKey: string, fileList: FileList) {
    const list = Array.from(fileList);
    const slot = activeSlots.find((s) => s.slotKey === slotKey);
    if (!slot) return;
    const currentCount = slotFiles[slotKey]?.length ?? 0;
    const room = Math.max(0, slot.maxImages - currentCount);
    // Pre-flight type guard. Отрезаем файлы неподходящего типа ДО S3-аплоада,
    // чтобы юзер сразу получил понятный тост вместо мутного 415 или
    // «Could not process the attached image» с бэка KIE.
    const accept = slotAcceptFor(slot);
    const accepted: File[] = [];
    let rejected = 0;
    for (const file of list.slice(0, room)) {
      if (fileMatchesAccept(file, accept)) {
        accepted.push(file);
      } else {
        rejected++;
      }
    }
    if (rejected > 0) {
      const slotType = slotTypeFor(slot);
      const typeKey =
        slotType === "video"
          ? "generate.typeVideo"
          : slotType === "audio"
            ? "generate.typeAudio"
            : "generate.typeImage";
      pushToast({
        type: "info",
        message: t("generate.errorWrongFileType", { type: t(typeKey) }),
      });
    }
    const toUpload = accepted;
    if (toUpload.length === 0) return;

    const initial: Extract<SlotFile, { status: "uploading" }>[] = toUpload.map((file) => ({
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

  // Кладёт выбранные в попапе медиа (uploaded / generated) в слот как готовые
  // SlotFile без аплоада — submit отправит их s3Key'и, бэкенд пресайнит.
  function reusedToSlotFile(item: ReusedMedia): Extract<SlotFile, { status: "ready" }> {
    return {
      id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: "ready",
      dto: {
        s3Key: item.s3Key,
        name: item.name,
        mimeType: item.mimeType,
        size: 0,
        kind: item.type,
        url: item.url,
      },
    };
  }

  function addReusedToSlot(slotKey: string, items: ReusedMedia[]) {
    const slot = activeSlots.find((s) => s.slotKey === slotKey);
    if (!slot || items.length === 0) return;
    setSlotFiles((prev) => {
      const existing = prev[slotKey] ?? [];
      // single-слот — заменяем содержимое единственным выбором.
      if (slot.maxImages <= 1) {
        return { ...prev, [slotKey]: [reusedToSlotFile(items[0])] };
      }
      // multi — добавляем, дедуп по s3Key, обрезаем по остатку места.
      const existingKeys = new Set(
        existing.flatMap((f) => (f.status === "ready" ? [f.dto.s3Key] : [])),
      );
      const room = Math.max(0, slot.maxImages - existing.length);
      const additions = items
        .filter((it) => !existingKeys.has(it.s3Key))
        .slice(0, room)
        .map(reusedToSlotFile);
      return { ...prev, [slotKey]: [...existing, ...additions] };
    });
  }

  // Upload из попапа: переиспользуем существующий addToSlot (кладёт в слот +
  // грузит в S3 + персистит в uploaded_media на бэке), затем инвалидируем
  // uploaded-media запрос, чтобы новый файл появился в гриде Upload.
  async function handleReuseUpload(slotKey: string, slotType: SlotMediaType, fileList: FileList) {
    await addToSlot(slotKey, fileList);
    void queryClient.invalidateQueries({ queryKey: uploadedMediaKeys.list(slotType) });
  }

  // Rate-limit для toast'а «файл устарел»: при батче битых превью (например, 4
  // картинки в multi-слоте все с протухшей подписью) не хотим 4 одинаковых
  // тоста подряд. Достаточно одного раз в 3 секунды.
  const expiredToastAtRef = useRef<number>(0);
  function pushExpiredToastOnce() {
    const now = Date.now();
    if (now - expiredToastAtRef.current < 3_000) return;
    expiredToastAtRef.current = now;
    pushToast({ type: "info", message: t("generate.expiredFilesDropped") });
  }

  function handleSlotPreviewError(slotKey: string, id: string) {
    removeFromSlot(slotKey, id);
    pushExpiredToastOnce();
  }

  // Перевыпускает presigned URL'ы для restored-файлов (status="ready" без
  // сырого File). Если backend вернул `null` (s3Key мёртв / чужой) — файл
  // выбрасываем из слота. Sync-effect `slotFiles → setSlots` ниже сам
  // запишет обновлённый DTO обратно в draft-store.
  async function refreshRestoredSlotUrls(slots: Record<string, SlotFile[]>) {
    const keys = new Set<string>();
    for (const arr of Object.values(slots)) {
      for (const f of arr) {
        if (f.status === "ready" && !f.file) keys.add(f.dto.s3Key);
      }
    }
    if (keys.size === 0) return;
    let result: Record<string, string | null>;
    try {
      result = await signChatUploads(Array.from(keys));
    } catch {
      // На ошибке сети ничего не делаем — onError-fallback на <img>/<video>
      // подчистит мёртвые tile'ы по факту.
      return;
    }
    let dropped = 0;
    setSlotFiles((prev) => {
      const next: Record<string, SlotFile[]> = {};
      for (const [slotKey, arr] of Object.entries(prev)) {
        const kept: SlotFile[] = [];
        for (const f of arr) {
          if (f.status !== "ready" || f.file) {
            kept.push(f);
            continue;
          }
          const fresh = result[f.dto.s3Key];
          if (fresh === undefined) {
            // ключ не в ответе (например, добавлен пока летел запрос) — оставляем
            kept.push(f);
            continue;
          }
          if (fresh === null) {
            dropped++;
            continue;
          }
          kept.push({ ...f, dto: { ...f.dto, url: fresh } });
        }
        next[slotKey] = kept;
      }
      return next;
    });
    if (dropped > 0) pushExpiredToastOnce();
  }

  // Аплоад в процессе → дизейблим CTA. Без этого юзер может стартовать
  // генерацию с пустым/неполным набором ассетов (s3Key'и ещё не выданы).
  const uploadInProgress = useMemo(
    () => Object.values(slotFiles).some((arr) => arr.some((f) => f.status === "uploading")),
    [slotFiles],
  );

  // Если генерация недоступна — на кнопке отображается ПРИЧИНА (а не дизейбл-стилистика
  // с opacity), чтобы юзер понял, что именно нужно доделать. `null` = всё готово.
  const blockerReason = useMemo<string | null>(() => {
    if (busy) return t("generate.btnGenerating");
    if (uploadInProgress) return t("generate.btnUploading");
    if (!selectedModel) return t("generate.btnSelectModel");

    const missingSlot = activeSlots.find(
      (s) =>
        s.required && (slotFiles[s.slotKey]?.filter((f) => f.status === "ready").length ?? 0) === 0,
    );
    if (missingSlot) return t("generate.btnAddToSlot", { slot: missingSlot.label });

    const hasReadyMedia = Object.values(slotFiles).some((arr) =>
      arr.some((f) => f.status === "ready"),
    );
    const promptIsEmpty = prompt.trim().length === 0;
    if (hidePrompt) {
      // hidePrompt-пресеты (апскейл/удаление фона/замена лица…): промпт скрыт и
      // задан пресетом — не требуем его, не зависим от promptOptional в каталоге.
      // Вместо промпта гейтим по медиа: генерировать без фото нечего.
      if (!hasReadyMedia) return t("generate.btnAddMedia");
    } else if (promptIsEmpty) {
      if (!selectedModel.promptOptional) return t("generate.btnEnterPrompt");
      if (selectedModel.promptOptionalRequiresMedia && !hasReadyMedia) {
        return t("generate.btnPromptOrMedia");
      }
    }

    // @-элементы: лимит модели и пустые элементы блокируют генерацию.
    if (elementsCap) {
      if (activeMentions.length > elementsCap.max) {
        return t("generate.elementLimit", { max: elementsCap.max });
      }
      const empty = activeMentions.find((m) => m.element.media.length === 0);
      if (empty) return t("generate.elementNoImages", { name: empty.element.name });
    }
    return null;
  }, [
    busy,
    uploadInProgress,
    selectedModel,
    activeSlots,
    slotFiles,
    prompt,
    elementsCap,
    activeMentions,
    t,
  ]);

  const canGenerate = blockerReason === null;

  // ── @-меншены: ввод/вставка/выбор ───────────────────────────────────────────
  // Детект незакрытого `@<word>` слева от курсора. Вызываем не только на вводе,
  // но и при перемещении каретки (клик/стрелки) — иначе stale-позиция привела бы
  // к вырезанию чужого куска текста при выборе подсказки.
  function detectMention(ta: HTMLTextAreaElement) {
    if (!elementsFeatureOn) {
      setMentionQuery(null);
      return;
    }
    const caret = ta.selectionStart ?? ta.value.length;
    const m = ta.value.slice(0, caret).match(/(?:^|[^\w])@(\w*)$/);
    if (m) {
      setMentionQuery({ query: m[1], start: caret - m[1].length - 1 });
      setMentionActiveIndex(0);
    } else {
      setMentionQuery(null);
    }
  }

  // onChange промпта: обновляем текст и пересчитываем меншен у курсора.
  function onPromptChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setPrompt(e.target.value);
    detectMention(e.target);
  }

  // Клавиатура в inline-`@` dropdown: ↑/↓ — навигация, Enter — выбор, Esc —
  // закрытие. Активно только пока dropdown открыт; иначе клавиши идут в textarea.
  function onPromptKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!mentionQuery || mentionMatches.length === 0) return;
    const len = mentionMatches.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMentionActiveIndex((i) => (i + 1) % len);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setMentionActiveIndex((i) => (i - 1 + len) % len);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const el = mentionMatches[Math.min(mentionActiveIndex, len - 1)];
      if (el) handlePickElement(el);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setMentionQuery(null);
    }
  }

  // Вставляет `@name ` в промпт: заменяет набранный inline-`@`-токен (если есть),
  // иначе вставляет в позицию курсора. Возвращает фокус и каретку после вставки.
  function insertMentionText(name: string) {
    const ta = taRef.current;
    const insert = `@${name} `;
    const caret = ta?.selectionStart ?? prompt.length;
    let next: string;
    let newCaret: number;
    if (mentionQuery) {
      const before = prompt.slice(0, mentionQuery.start);
      const after = prompt.slice(caret);
      next = before + insert + after;
      newCaret = before.length + insert.length;
    } else {
      next = prompt.slice(0, caret) + insert + prompt.slice(caret);
      newCaret = caret + insert.length;
    }
    setPrompt(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(newCaret, newCaret);
    });
  }

  // Выбор элемента (из @Elements-пикера или inline-dropdown'а): вставляем меншен
  // и сразу открываем выбор картинок (если у элемента они есть).
  function handlePickElement(el: Element) {
    insertMentionText(el.name);
    setMentionPickerOpen(false);
    if (el.media.length > 0) setImageSelectFor(el);
  }

  // ── Сборка payload для submit/preview ───────────────────────────────────────
  // mediaInputs: слоты-кадры (без ref_element_*, ими управляют @-меншены) +
  // картинки активных @-элементов в ref_element_N.
  function buildSubmitMediaInputs(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [slotKey, files] of Object.entries(slotFiles)) {
      if (slotKey.startsWith("ref_element_")) continue;
      const keys = files.flatMap((f) => (f.status === "ready" ? [f.dto.s3Key] : []));
      if (keys.length > 0) out[slotKey] = keys;
    }
    if (elementsCap) {
      Object.assign(
        out,
        buildElementMediaInputs(cappedMentions, elementSelections, maxImagesPerElement),
      );
    }
    return out;
  }

  // Промпт для отправки: дружелюбные @имя → каноническая @ElementN (MVP-трансляция).
  // fixedPrompt (hidePrompt-пресеты) авторитетнее изменяемого стейта — защищает от
  // гонки с восстановлением черновика при SPA-навигации (см. проп fixedPrompt).
  function buildSubmitPrompt(): string {
    const base = fixedPrompt != null ? fixedPrompt : prompt;
    return elementsCap ? translateMentionsToCanonical(base, cappedMentions) : base;
  }

  // ── Debounced cost preview ─────────────────────────────────────────────────
  // Зовём `/web/generation/preview` после каждого изменения инпутов с 350ms
  // дебаунсом. На последовательные изменения отменяем предыдущий запрос через
  // AbortController — на сервер не уходят устаревшие комбинации.
  // Не зовём пока есть незавершённые аплоады: после готовности slotFiles
  // обновится и effect перезапустится с актуальными s3Key'ами.
  useEffect(() => {
    if (!selectedModel) return;
    if (uploadInProgress) return;

    const mediaInputs = buildSubmitMediaInputs();
    const submitPrompt = buildSubmitPrompt();

    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewAbortRef.current?.abort();
      previewAbortRef.current = controller;
      setPreviewLoading(true);
      previewGeneration(
        {
          modelId: selectedModel.id,
          ...(modeId ? { modeId } : {}),
          prompt: submitPrompt,
          ...(Object.keys(settingValues).length > 0 ? { settings: settingValues } : {}),
          ...(Object.keys(mediaInputs).length > 0 ? { mediaInputs } : {}),
        },
        { signal: controller.signal },
      )
        .then((res) => {
          if (controller.signal.aborted) return;
          setPreviewCost(res.cost);
          setPreviewPricingMode(res.pricingMode);
        })
        .catch((err) => {
          // Прерванный — никакой обработки. Прочие ошибки тоже игнорируем:
          // оставляем последнюю валидную оценку (или фоллбэк tokenCostApprox).
          if ((err as ApiError)?.code === "TIMEOUT") return;
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewLoading(false);
        });
    }, 350);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    selectedModel,
    modeId,
    prompt,
    settingValues,
    slotFiles,
    uploadInProgress,
    elementsCap,
    cappedMentions,
    elementSelections,
    maxImagesPerElement,
  ]);

  // Reset preview при смене модели — старая цифра не имеет смысла для новой
  // модели, лучше показать фоллбэк tokenCostApprox чем устаревшую оценку.
  useEffect(() => {
    setPreviewCost(null);
    setPreviewPricingMode("total");
  }, [selectedModel?.id]);

  async function generate() {
    if (!canGenerate || !selectedModel) return;
    setBusy(true);
    setSubmitError(null);
    try {
      // В payload — только ready-файлы (uploading/error пропускаем). Передаём
      // s3Key'и: presigned URL'ы могут протухнуть, бекенд сам резолвит. Картинки
      // @-элементов кладутся в ref_element_N, а @имя в промпте → @ElementN (MVP).
      const mediaInputs = buildSubmitMediaInputs();
      const submitPrompt = buildSubmitPrompt();

      const section = selectedModel.section;
      const settingsField =
        Object.keys(settingValues).length > 0 ? { settings: settingValues } : {};
      const mediaField = Object.keys(mediaInputs).length > 0 ? { mediaInputs } : {};

      let result: SubmitGenerationResponse;
      if (section === "design" || section === "image") {
        const body: SubmitImageGenerationBody = {
          modelId: selectedModel.id,
          prompt: submitPrompt,
          ...(modeId ? { modeId } : {}),
          ...settingsField,
          ...mediaField,
        };
        result = await submitImageGeneration(body);
      } else if (section === "video") {
        const body: SubmitVideoGenerationBody = {
          modelId: selectedModel.id,
          prompt: submitPrompt,
          ...(modeId ? { modeId } : {}),
          ...settingsField,
          ...mediaField,
        };
        result = await submitVideoGeneration(body);
      } else if (section === "audio") {
        const body: SubmitAudioGenerationBody = {
          modelId: selectedModel.id,
          prompt: submitPrompt,
          ...settingsField,
        };
        result = await submitAudioGeneration(body);
      } else {
        throw new Error(`Unsupported section: ${section}`);
      }
      // Локально трекаем pending-job: GenerationHistory подхватит её и
      // переключит в success/error когда придёт `notification:new`.
      // section пишем нормализованный под DB-словарь ("image"/"video"/"audio"),
      // т.к. модель имеет "design" в каталоге — у success-карточки рендер
      // outputs зависит от типа медиа.
      const trackedSection = section === "design" || section === "image" ? "image" : section;
      setPendingJobs((prev) => [
        {
          id: result.dbJobId,
          modelId: selectedModel.id,
          section: trackedSection,
          prompt,
          startedAt: Date.now(),
          status: "pending",
        },
        ...prev,
      ]);
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
    if (mediaPickerSetting.kind === "soul-style") {
      return (soulStyleCache ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        previewUrl: s.previewUrl,
      }));
    }
    // soul-character — каталога нет, только пользовательские; рендерится из user-section.
    return [];
  }, [mediaPickerSetting, avatarCache, motionCache, soulStyleCache]);

  // User-items: HeyGen-аватары для kind=avatar, Soul-персонажи для kind=soul-character.
  // Передаём в picker как `userItems`; в value сохраняем `externalId` (HeyGen
  // asset_id или Soul character_id) — именно его ждёт worker/адаптер при submit.
  const mediaUserItems: MediaUserItem[] | undefined = useMemo(() => {
    if (!mediaPickerSetting) return undefined;
    const source =
      mediaPickerSetting.kind === "avatar"
        ? heygenUserCache
        : mediaPickerSetting.kind === "soul-character"
          ? soulUserCache
          : null;
    if (!source) return undefined;
    return source.map((u) => ({
      // Для выбора используем externalId (то, что пойдёт в провайдер). Пока
      // status=creating externalId может быть null — используем cuid как
      // временный id, но тогда tile disabled.
      id: u.externalId ?? u.id,
      name: u.name,
      previewUrl: u.previewUrl,
      status: u.status,
    }));
  }, [mediaPickerSetting, heygenUserCache, soulUserCache]);

  const mediaUserItemsLoading =
    mediaPickerSetting?.kind === "avatar"
      ? heygenUserLoading
      : mediaPickerSetting?.kind === "soul-character"
        ? soulUserLoading
        : false;

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
      : mediaPickerSetting.kind === "soul-character"
        ? "Soul-персонаж"
        : mediaPickerSetting.kind === "motion"
          ? "Пресеты движения"
          : "Стиль изображения"
    : "";
  const mediaPickerSubtitle = mediaPickerSetting
    ? mediaPickerSetting.kind === "avatar"
      ? "HeyGen"
      : mediaPickerSetting.kind === "soul-character"
        ? "Higgsfield Soul"
        : "HiggsField"
    : "";
  // motion-picker — multi, максимум 2 (из описания shared'-модели). Остальные — single.
  const mediaPickerMaxItems = mediaPickerSetting?.kind === "motion" ? 2 : 1;

  // create-button: открывает модалку аплоада для соответствующего провайдера.
  const mediaPickerOnCreate =
    mediaPickerSetting?.kind === "avatar"
      ? () => setCreateAvatarProvider("heygen")
      : mediaPickerSetting?.kind === "soul-character"
        ? () => setCreateAvatarProvider("higgsfield_soul")
        : undefined;

  // soul-character: каталога нет, скрываем нижнюю секцию.
  const mediaPickerHideCatalog = mediaPickerSetting?.kind === "soul-character";

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

  // ── Prompts modal — открытие/закрытие через ref на <dialog>. ───────────────
  function openPromptsDialog() {
    const dlg = promptsDialogRef.current;
    if (!dlg) return;
    dlg.showModal();
    document.body.style.overflow = "hidden";
  }
  function closePromptsDialog() {
    const dlg = promptsDialogRef.current;
    if (!dlg) return;
    dlg.close();
    document.body.style.overflow = "";
  }

  // Apply prompt example: 1) кладём текущий черновик в state ТЕКУЩЕЙ entry
  // через replace, 2) пушим новый URL с prefill. При back-навигации браузер
  // возвращается на entry с draft → effect выше восстанавливает prompt/model/
  // settings. Файлы в слотах не сохраняются (объекты File не сериализуются).
  function handleApplyPromptExample(ex: PromptExample) {
    const targetSection = ex.model ? normalizeSection(ex.section) : null;
    if (!targetSection || !ex.model) {
      pushToast({ type: "info", message: "Модель примера недоступна" });
      return;
    }
    const settings =
      ex.modelSettings && typeof ex.modelSettings === "object"
        ? (ex.modelSettings as Record<string, unknown>)
        : undefined;

    // Глушим prefill-effect на текущей entry — replace ниже изменит
    // location.state и иначе бы effect среагировал и попытался применить
    // draft до того, как мы успеем сделать push.
    lastConsumedPrefillKey.current = location.key;

    const draft: GenerateDraft = {
      modelId,
      prompt,
      settings: settingValues,
    };
    navigate(location.pathname + location.search, {
      replace: true,
      state: { draft },
    });
    navigateToGenerate(navigate, {
      section: targetSection,
      modelId: ex.model.id,
      prompt: ex.prompt,
      settings,
    });
  }

  return (
    <div className={clsx("gen-scene", (voicePickerSetting || mediaPickerSetting) && "has-picker")}>
      <div className="gen-bg" aria-hidden>
        {ambientSection && !historyHasContent && !isMobile && (
          <FloatingMediaBg section={ambientSection} />
        )}
      </div>
      <div className="gen-panel">
        <div className="gen-head">
          <div>
            <h1>{title}</h1>
            <p className="gen-sub">{subtitle}</p>
          </div>
          {onReset && isDirtyFromPreset && (
            <button type="button" className="gen-reset-btn ml-auto" onClick={onReset}>
              <RotateCcw size={14} />
              <span>Сбросить</span>
            </button>
          )}
        </div>

        {/* Mode tabs — только если у модели несколько режимов. */}
        {selectedModel?.modes && selectedModel.modes.length > 1 && (
          <div className="gen-mode-tabs">
            {selectedModel.modes.map((m) => (
              <button
                key={m.id}
                ref={activeMode?.id === m.id ? activeModeTabRef : null}
                className={clsx("gen-mode-tab", activeMode?.id === m.id && "on")}
                onClick={() => setModeId(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}

        {/* Скроллящийся блок с слотами / промптом / настройками.
            Фикс'нутый footer ниже (model picker + CTA) всегда виден. */}
        <div className="gen-panel-scroll">
          {/* Media slots — фильтруются по активному режиму. Слоты reference_element
              скрыты: элементы подставляются через @-меншены в промпте. */}
          {visibleSlots.length > 0 && (
            <div
              className={clsx("gen-slots", visibleSlots.length === 1 && "is-single")}
              style={{
                gridTemplateColumns: `repeat(${Math.min(visibleSlots.length, 2)}, minmax(0, 1fr))`,
              }}
            >
              {visibleSlots.map((slot) => (
                <SlotCard
                  key={slot.slotKey}
                  slot={slot}
                  files={slotFiles[slot.slotKey] ?? []}
                  onOpenPicker={() => setReuseSlotKey(slot.slotKey)}
                  onRemove={(id) => removeFromSlot(slot.slotKey, id)}
                  onSlotError={(id) => handleSlotPreviewError(slot.slotKey, id)}
                />
              ))}
            </div>
          )}

          {/* Prompt. Кнопки «Готовые промпты» + «Элементы» — панелью в левом
              нижнем углу инпута; textarea авторастёт и резервирует место снизу.
              hidePrompt прячет блок целиком (пресет апскейла и т.п.) — значение
              prompt при этом остаётся в state и уходит в сабмит. */}
          {!hidePrompt && (
            <div
              className={clsx(
                "gen-prompt-wrap",
                (promptSection || elementsFeatureOn) && "has-inline-tools",
              )}
              style={{ position: "relative" }}
            >
              <textarea
                ref={taRef}
                className="gen-prompt"
                placeholder={promptPlaceholder}
                value={prompt}
                onChange={onPromptChange}
                // Перемещение каретки мышью/стрелками не триггерит onChange —
                // ловим отдельно, чтобы mentionQuery не «залип» на старой позиции.
                onClick={(e) => detectMention(e.currentTarget)}
                onKeyDown={onPromptKeyDown}
                onKeyUp={(e) => {
                  // Навигационные клавиши обрабатывает onPromptKeyDown; здесь их
                  // пропускаем, иначе detectMention переоткрыл бы dropdown (Esc)
                  // и сбрасывал бы подсветку (↑/↓).
                  if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key)) return;
                  detectMention(e.currentTarget);
                }}
                onBlur={() => {
                  // Закрываем dropdown после клика по подсказке (mousedown успевает
                  // отработать раньше blur), иначе — при уходе фокуса.
                  window.setTimeout(() => setMentionQuery(null), 150);
                }}
              />
              {(promptSection || elementsFeatureOn) && (
                <div className="gen-prompt-tools">
                  {promptSection && (
                    <button
                      type="button"
                      className="gen-prompt-examples-btn"
                      onClick={openPromptsDialog}
                      title={t("generate.openPromptExamples")}
                      aria-label={t("generate.openPromptExamples")}
                    >
                      <Wand2 size={14} />
                      <span>{t("generate.openPromptExamples")}</span>
                    </button>
                  )}
                  {elementsFeatureOn && (
                    <button
                      type="button"
                      className="gen-prompt-examples-btn"
                      onClick={() => setMentionPickerOpen(true)}
                      title={t("generate.elementsButton")}
                      aria-label={t("generate.elementsButton")}
                    >
                      <AtSign size={14} />
                      <span>{t("generate.elementsButton")}</span>
                    </button>
                  )}
                </div>
              )}
              {/* Inline-`@` dropdown подсказок элементов. */}
              {mentionQuery && mentionMatches.length > 0 && (
                <ul
                  className="card"
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: "100%",
                    marginTop: 4,
                    zIndex: 50,
                    maxHeight: 240,
                    overflowY: "auto",
                    padding: 4,
                    listStyle: "none",
                  }}
                >
                  {mentionMatches.map((el, i) => (
                    <li key={el.id}>
                      <button
                        type="button"
                        // mousedown (не click): срабатывает до blur textarea.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          handlePickElement(el);
                        }}
                        // Синхронизируем подсветку с мышью, чтобы ↑/↓ и hover не расходились.
                        onMouseEnter={() => setMentionActiveIndex(i)}
                        className={clsx(
                          "flex w-full items-center gap-2 rounded-[var(--radius)] px-2 py-1.5 text-left text-sm text-text",
                          i === Math.min(mentionActiveIndex, mentionMatches.length - 1)
                            ? "bg-bg-elevated"
                            : "hover:bg-bg-elevated",
                        )}
                      >
                        <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded bg-bg-elevated">
                          {el.media[0]?.url ? (
                            <img src={el.media[0].url} alt="" className="size-full object-cover" />
                          ) : (
                            <AtSign size={14} className="text-text-secondary" />
                          )}
                        </span>
                        <span className="truncate">@{el.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Чипы активных @-элементов (распознанных в промпте). Клик — выбор
              картинок элемента. Кнопка «Элементы» живёт внутри textarea выше. */}
          {elementsFeatureOn && activeMentions.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                alignItems: "center",
                marginTop: 8,
              }}
            >
              {activeMentions.map(({ element }, i) => {
                const count =
                  elementSelections[element.id]?.length ??
                  Math.min(maxImagesPerElement, element.media.length);
                const over = elementsCap ? i >= elementsCap.max : false;
                const cover = element.media[0]?.url ?? null;
                return (
                  <button
                    key={element.id}
                    type="button"
                    className={clsx("gen-chip-pill", !over && "is-on")}
                    title={over ? t("generate.elementLimit", { max: elementsCap?.max }) : undefined}
                    onClick={() => setImageSelectFor(element)}
                  >
                    <span
                      className="flex shrink-0 items-center justify-center overflow-hidden rounded bg-bg-elevated"
                      style={{ width: 16, height: 16 }}
                    >
                      {cover ? (
                        <img src={cover} alt="" className="size-full object-cover" />
                      ) : (
                        <AtSign size={10} className="text-text-secondary" />
                      )}
                    </span>
                    <span className="gen-chip-pill-label">@{element.name}</span>
                    <span className="gen-chip-pill-val">{count}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Настройки модели — каждая как chip с popover'ом, wrap'ятся в строку.
              Family axis chip'ы (version / variant) идут первыми — это про
              «какую модель из семейства взять», логически выше per-model
              tuning settings. FamilyAxisChip сам прячется если выбора нет
              (1 версия/вариант). */}
          {((!hideModelPicker && familyAxis) || visibleSettings.length > 0) && (
            <div className="gen-settings-chips">
              {!hideModelPicker && familyAxis && familyAxis.currentVersion && (
                <FamilyAxisChip
                  label={t("generate.familyVersion")}
                  current={familyAxis.currentVersion}
                  options={familyAxis.versions}
                  onSelect={selectFamilyVersion}
                />
              )}
              {!hideModelPicker && familyAxis && familyAxis.currentVariant && (
                <FamilyAxisChip
                  label={t("generate.familyVariant")}
                  current={familyAxis.currentVariant}
                  options={familyAxis.variants}
                  onSelect={selectFamilyVariant}
                />
              )}
              {visibleSettings.map((s) => (
                <SettingChip
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
        </div>

        {/* Footer: model picker + CTA. Sticky, всегда видны. */}
        <div className="gen-panel-footer">
          {!hideModelPicker && (
            <div className="gen-model-row">
              <button
                ref={modelBtnRef}
                className="gen-model-btn"
                onClick={() => setModelOpen(!modelOpen)}
              >
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
                <ChipPopover
                  anchorRef={modelBtnRef}
                  popRef={modelPopRef}
                  className="gen-model-pop"
                  matchAnchorWidth
                >
                  {families.map((m) => {
                    // Active = выбранная модель из этого семейства (даже если
                    // юзер переключился на sibling-вариант через chip'ы).
                    const isActive = selectedModel?.familyId
                      ? m.familyId === selectedModel.familyId
                      : m.id === modelId;
                    return (
                      <button
                        key={m.id}
                        className={clsx("gen-model-row-item", isActive && "on")}
                        onClick={() => {
                          pickModel(m.id);
                          setModelOpen(false);
                        }}
                      >
                        <div className="gen-model-glyph">{modelLetter(m)}</div>
                        <div className="gen-model-item-body">
                          <div className="gen-model-item-name">{modelDisplayName(m)}</div>
                          <div className="gen-model-item-desc">{modelDesc(m)}</div>
                        </div>
                        {isActive && <Check size={14} />}
                      </button>
                    );
                  })}
                </ChipPopover>
              )}
            </div>
          )}

          <button className="gen-cta" disabled={!canGenerate} onClick={generate}>
            {busy || uploadInProgress ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <Sparkles size={16} />
            )}
            <span>{blockerReason ?? t("generate.btnGenerate")}</span>
            {selectedModel && (
              <span className="gen-cta-cost mono">
                {previewLoading && <Loader2 size={11} className="spin" />}≈{" "}
                {(previewCost ?? selectedModel.tokenCostApprox).toFixed(2)}
                {previewPricingMode === "per_second" ? " / сек" : ""}
              </span>
            )}
          </button>

          {submitError && (
            <div className="gen-error" role="alert">
              {submitError}
            </div>
          )}
        </div>
      </div>

      {/* История генераций — отдельная пэйн справа от `.gen-panel`. Занимает
          всё оставшееся пустое место экрана. На мобильных скрывается через
          CSS (там панель и так full-width). */}
      <div className="gen-history-pane">
        {ambientSection && !historyHasContent && !isMobile && (
          <div className="gen-ambient-headline" aria-hidden>
            <h2>
              <Trans
                i18nKey="generate.ambientTitle"
                components={{ hl: <span className="gen-hl" /> }}
              />
            </h2>
            <p>
              {t(
                ambientSection === "video"
                  ? "generate.ambientSubtitleVideo"
                  : "generate.ambientSubtitleImage",
              )}
            </p>
          </div>
        )}
        <GenerationHistory
          selectedModel={selectedModel}
          pendingJobs={pendingJobs}
          onJobResolved={handleJobResolved}
          onJobFailed={handleJobFailed}
          onJobSucceeded={handleJobSucceeded}
          onHasContentChange={setHistoryHasContent}
        />
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
            userItems={mediaUserItems}
            userItemsLoading={mediaUserItemsLoading}
            userItemsLabel={
              mediaPickerSetting?.kind === "soul-character"
                ? t("mediaPicker.myCharacters")
                : t("mediaPicker.myAvatars")
            }
            hideCatalog={mediaPickerHideCatalog}
            onCreate={mediaPickerOnCreate}
            onRename={mediaPickerOnCreate ? handleRenameUserAvatar : undefined}
            onDelete={mediaPickerOnCreate ? handleDeleteUserAvatar : undefined}
          />
        </>
      )}

      {reuseSlotKey &&
        (() => {
          const slot = activeSlots.find((s) => s.slotKey === reuseSlotKey);
          if (!slot) return null;
          const slotType = slotTypeFor(slot);
          const readyCount = (slotFiles[reuseSlotKey] ?? []).filter(
            (f) => f.status === "ready",
          ).length;
          const room = slot.maxImages <= 1 ? 1 : Math.max(0, slot.maxImages - readyCount);
          return (
            <MediaReusePopup
              slotType={slotType}
              accept={slotAcceptFor(slot)}
              room={room}
              multi={slot.maxImages > 1}
              onUpload={(fl) => handleReuseUpload(reuseSlotKey, slotType, fl)}
              onSelect={(items) => addReusedToSlot(reuseSlotKey, items)}
              onClose={() => setReuseSlotKey(null)}
            />
          );
        })()}

      {/* @Elements: модальный пикер элементов (кнопка @Elements). */}
      {mentionPickerOpen && (
        <ElementMentionPicker
          activeElementIds={activeElementIds}
          atLimit={!!elementsCap && activeMentions.length >= elementsCap.max}
          onPick={handlePickElement}
          onClose={() => setMentionPickerOpen(false)}
        />
      )}

      {/* @Elements: выбор подмножества картинок элемента (2..maxImages). */}
      {imageSelectFor && (
        <ElementImageSelectPopup
          element={imageSelectFor}
          maxImages={maxImagesPerElement}
          initialSelected={elementSelections[imageSelectFor.id] ?? []}
          onConfirm={(keys) => {
            setElementSelections((prev) => ({ ...prev, [imageSelectFor.id]: keys }));
            setImageSelectFor(null);
          }}
          onClose={() => setImageSelectFor(null)}
        />
      )}

      {createAvatarProvider && (
        <CreateAvatarModal
          provider={createAvatarProvider}
          onClose={() => setCreateAvatarProvider(null)}
          onCreated={(_avatar) => {
            // Свежесозданный аватар — reload соответствующего кеша. Это
            // подхватит и status="ready" (HeyGen), и status="creating" (Soul).
            if (createAvatarProvider === "heygen") {
              void ensureUserAvatars("heygen", { reload: true });
            } else {
              void ensureUserAvatars("higgsfield_soul", { reload: true });
            }
          }}
        />
      )}

      {promptSection && (
        <dialog
          ref={promptsDialogRef}
          onClose={() => {
            document.body.style.overflow = "";
          }}
          onClick={(e) => {
            // Закрыть по клику на бэкдроп — дочерний контент имеет
            // `gen-prompts-modal-body` со своим stopPropagation.
            if (e.target === promptsDialogRef.current) {
              closePromptsDialog();
            }
          }}
          className="
            rise
            p-4 md:p-8
            backdrop:transition-all
            fixed inset-0
            w-screen h-screen
            max-w-none max-h-none
            m-0
            overflow-y-auto
            outline-none
            bg-transparent
            backdrop:backdrop-blur"
        >
          <div className="gen-prompts-modal-body relative" onClick={(e) => e.stopPropagation()}>
            <button
              className="btn btn-ghost btn-icon absolute top-0 right-0 z-50"
              onClick={closePromptsDialog}
            >
              <X />
            </button>
            <PromptExamplesGallery
              section={promptSection}
              hideTypeTabs
              onApply={(ex) => {
                closePromptsDialog();
                handleApplyPromptExample(ex);
              }}
            />
          </div>
        </dialog>
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
