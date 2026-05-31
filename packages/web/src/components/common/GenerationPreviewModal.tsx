import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SyntheticEvent,
  type TouchEvent as ReactTouchEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Coins,
  Copy,
  Download,
  FolderPlus,
  Heart,
  Images,
  Maximize2,
  Music2,
  Trash2,
  X,
} from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/common/Button";
import { ModelAvatar } from "@/components/common/ModelAvatar";
import { FolderNameDialog } from "@/components/common/FolderNameDialog";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { ShotEntry } from "@/utils/multishot";
import type { SettingRow } from "@/utils/settingsDisplay";
import type { GalleryFolder } from "@/api/gallery";
import { preloadImage } from "@/utils/imagePreload";

/**
 * Универсальная модалка просмотра output'а(-ов) генерации. Используется и в
 * ленте генерации (`GenerationHistory`), и в галерее (`Gallery` page).
 *
 * Layout: на весь экран замыленная копия медиа фоном, в центре сам медиа
 * (image/video/audio), инфо-карточка справа на >=lg (1024px) и снизу на мобиле.
 *
 * Поддерживает несколько output'ов одного job'а: prev/next стрелки + thumbnail
 * strip под медиа. Если output один — нав не рисуется. Эта же модалка лежит
 * в основе галерейного «Lightbox'а» — Gallery передаёт сюда все outputs job'а.
 *
 * Инфо-карточка опциональна (`info`). Внутри: title + meta-чипы (дата/токены),
 * сворачиваемый промпт, опциональные чипы папок (toggle add/remove),
 * кнопки «Повторить» / «Скачать оригинал» — рендерятся по наличию колбэков.
 */

// Bottom-sheet drag thresholds (mobile-only PreviewInfoCard).
const DRAG_TOGGLE_PX = 60;
const DRAG_TOGGLE_VELOCITY = 0.4; // px/ms
// Высота видимой полоски в свёрнутом состоянии (handle + padding).
const COLLAPSED_PEEK_PX = 24;
const SHEET_TRANSITION = "transform 220ms cubic-bezier(.22,1,.36,1)";

// Apple-TV-стиль 3D-наклон картинки при наведении (desktop-only). Угол
// максимален у краёв картинки, в центре — почти плоско. Подъём (scale) даёт
// лёгкое ощущение «всплытия» под курсором. Transition сглаживает и следование
// за курсором, и возврат в плоскость на mouseleave.
const TILT_MAX_DEG = 5;
const TILT_SCALE = 1.02;
const TILT_PERSPECTIVE_PX = 1000;
const TILT_TRANSITION = "transform 150ms ease-out";

export type PreviewOutput = {
  id: string;
  url: string;
  /** Картинка для backdrop blur и thumbnail-strip. Для image — own thumb (или
   *  сам url, если thumb'а нет); для video — thumb; для audio — null. */
  thumbnailUrl?: string | null;
};

export type PreviewFolders = {
  list: GalleryFolder[];
  /** Какие папки сейчас отмечены (из `job.folderIds`). */
  selectedIds: string[];
  onToggle: (folderId: string) => void;
  /** Создать новую папку (открывает диалог ввода имени). */
  onCreate?: (name: string) => void;
};

export type PreviewInfo = {
  title: string;
  /** Путь к монохромной иконке модели рядом с заголовком (если есть). */
  iconPath?: string | null;
  /** ISO-дата для чипа в шапке. */
  dateIso?: string | null;
  /** Уже отформатированное значение токенов — модалка не форматирует. */
  tokensValue?: string | null;
  prompt?: string | null;
  /** Мультишот (Kling): промпты живут по шотам, top-level `prompt` пустой. Если
   *  список непустой — секция промпта рендерит список шотов вместо одиночного. */
  shots?: ShotEntry[];
  /** Настройки генерации (label/value), уже отрезолвленные caller'ом. */
  settings?: SettingRow[];
  /** Избранное: текущее состояние + тоггл. Кнопка-сердечко рендерится только
   *  если задан `onToggleFavorite`. */
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  /** Удаление джобы (на ответственности колбэка: confirm + закрытие модалки). */
  onDelete?: () => void;
  /** Открыть текущий output в другом инструменте. Рендерятся по наличию колбэка
   *  (image-output: animate/reference/upscale; video-output: только upscale). */
  onAnimate?: () => void;
  onReference?: () => void;
  onUpscale?: () => void;
  /** Закрытие модалки — на ответственности колбэка (нужно, чтобы caller мог
   *  показать toast при невалидной секции и оставить модалку открытой). */
  onRepeat?: () => void;
  /** Не закрывает модалку (скачивание открывается в новой вкладке). */
  onDownload?: () => void;
  /** Управление папками — только в галерее. Default-папка («Избранное»)
   *  отфильтровывается, ей управляют отдельной кнопкой-сердечком на карточке. */
  folders?: PreviewFolders;
};

export type GenerationPreviewModalProps = {
  outputs: PreviewOutput[];
  activeIdx: number;
  onActiveIdxChange: (idx: number) => void;
  /** "image" | "video" | "audio". */
  section: string;
  onClose: () => void;
  info?: PreviewInfo;
};

export function GenerationPreviewModal({
  outputs,
  activeIdx,
  onActiveIdxChange,
  section,
  onClose,
  info,
}: GenerationPreviewModalProps) {
  const { t } = useTranslation();
  // Десктоп-layout с >=lg (1024px). Планшеты в портрете получают мобильную
  // верстку: медиа сверху, инфо-карточка снизу.
  const isMobile = useIsMobile(1024);

  const active = outputs[activeIdx] ?? outputs[0];
  const hasMultiple = outputs.length > 1;

  // На мобилке инфо-карточка рендерится как bottom-sheet: по умолчанию свёрнута
  // (видна только handle-полоска), раскрывается тапом/свайпом по handle'у.
  const [infoExpanded, setInfoExpanded] = useState(false);

  const backdropUrl = !active
    ? null
    : section === "audio"
      ? null
      : section === "video"
        ? (active.thumbnailUrl ?? null)
        : (active.thumbnailUrl ?? active.url);

  // step через ref, чтобы keydown-listener не переподписывался на каждый клик.
  const step = (delta: number) => {
    const n = outputs.length;
    if (n <= 1) return;
    onActiveIdxChange((((activeIdx + delta) % n) + n) % n);
  };
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") stepRef.current(-1);
      else if (e.key === "ArrowRight") stepRef.current(1);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // Prefetch prev/next в multi-output, чтобы стрелки переключали без задержки.
  // Только для image — для video/audio полный preload через `new Image()` не
  // имеет смысла (это не картинки).
  useEffect(() => {
    if (section !== "image" || outputs.length <= 1) return;
    const n = outputs.length;
    const next = outputs[(activeIdx + 1) % n];
    const prev = outputs[(activeIdx - 1 + n) % n];
    if (next?.url) preloadImage(next.url);
    if (prev?.url && prev.id !== next?.id) preloadImage(prev.url);
  }, [activeIdx, outputs, section]);

  if (!active) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4 lg:p-8 overflow-hidden"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop: замыленная копия медиа во весь экран. Картинка должна
          оставаться различимой (цвета, формы) — затемнение лёгкое, а сильное
          размытие даёт boke-эффект. Поверх — мягкая чёрная подложка для
          контраста с инфо-карточкой. Для audio (нет backdropUrl) подкладка
          плотнее, чтобы не было «серой стены». */}
      {backdropUrl ? (
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none bg-center bg-cover"
          style={{
            backgroundImage: `url("${backdropUrl}")`,
            filter: "blur(40px) brightness(0.85)",
            transform: "scale(1.1)",
          }}
        />
      ) : null}
      <div
        aria-hidden
        className={clsx(
          "absolute inset-0 pointer-events-none backdrop-blur-sm",
          backdropUrl ? "bg-black/35" : "bg-black/75",
        )}
      />

      {/* Крестик уровня overlay — когда нет инфо-карточки (она держит свой
          крестик в шапке), либо на мобилке когда bottom-sheet свёрнут (хедер
          карточки за нижним краем экрана и не виден). */}
      {(!info || (isMobile && !infoExpanded)) && (
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="absolute top-4 right-4 lg:top-6 lg:right-6 z-50 btn btn-ghost btn-icon"
        >
          <X size={20} />
        </button>
      )}

      {/* Затемнение поверх медиа, когда мобильный bottom-sheet раскрыт. Тап по
          нему сворачивает панель (не закрывает модалку). */}
      {isMobile && info && infoExpanded && (
        <div
          aria-hidden
          onClick={(e) => {
            e.stopPropagation();
            setInfoExpanded(false);
          }}
          className="absolute inset-0 bg-black/40 z-10 transition-opacity"
        />
      )}

      {/* Внутренний контейнер НЕ останавливает propagation — иначе кликнуть в
          летербокс/гэп для закрытия было бы нельзя (он заполняет весь viewport).
          stopPropagation навешен точечно на сам контент: медиа, навигацию,
          thumbnail strip, инфо-карточку. */}
      {/* Без overflow-hidden: иначе 3D-наклон/тень картинки по краям обрезаются.
          Скейл фона-backdrop держит крайний root (он fixed → за viewport не
          вылезет). */}
      <div className="relative w-full h-full flex flex-col lg:flex-row gap-4 lg:gap-8">
        {/* Media column: media + thumbnails-strip снизу. На мобилке с инфо-
            карточкой добавляем pb, чтобы thumb-strip и низ медиа не уходили
            под handle-полоску bottom-sheet'а (peek 24px + ~8px breathing). */}
        <div className={clsx("flex-1 min-h-0 flex flex-col gap-3", isMobile && info && "pb-8")}>
          <div className="flex-1 min-h-0 flex items-center justify-center relative">
            {section === "video" ? (
              <video
                key={active.id}
                src={active.url}
                controls
                playsInline
                preload="metadata"
                onClick={(e) => e.stopPropagation()}
                className="max-w-full max-h-full object-contain rounded-[var(--radius)] shadow-2xl"
              />
            ) : section === "audio" ? (
              <div
                className="flex flex-col items-center gap-6 p-8"
                onClick={(e) => e.stopPropagation()}
              >
                <Music2 size={96} className="text-white/70" />
                <audio key={active.id} src={active.url} controls className="w-full max-w-md" />
              </div>
            ) : (
              <ProgressiveImage
                key={active.id}
                src={active.url}
                thumbnailUrl={active.thumbnailUrl ?? null}
                tiltEnabled={!isMobile}
              />
            )}

            {hasMultiple && (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    step(-1);
                  }}
                  aria-label={t("common.back")}
                  className="absolute left-3 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full flex items-center justify-center border transition-opacity opacity-70 hover:opacity-100"
                  style={{
                    background: "rgba(0,0,0,0.5)",
                    backdropFilter: "blur(8px)",
                    borderColor: "var(--border-strong)",
                    color: "var(--text)",
                  }}
                >
                  <ChevronLeft size={20} />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    step(1);
                  }}
                  aria-label={t("common.next")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full flex items-center justify-center border transition-opacity opacity-70 hover:opacity-100"
                  style={{
                    background: "rgba(0,0,0,0.5)",
                    backdropFilter: "blur(8px)",
                    borderColor: "var(--border-strong)",
                    color: "var(--text)",
                  }}
                >
                  <ChevronRight size={20} />
                </button>
              </>
            )}
          </div>

          {hasMultiple && (
            <div
              className="flex items-center gap-2 overflow-x-auto [scrollbar-width:thin] shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              {outputs.map((o, i) => {
                const thumb = o.thumbnailUrl ?? (section === "image" ? o.url : null);
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => onActiveIdxChange(i)}
                    className={clsx(
                      "shrink-0 w-16 h-16 rounded overflow-hidden border-2 transition-colors",
                      i === activeIdx
                        ? "border-[var(--accent)]"
                        : "border-transparent hover:border-[var(--border-strong)]",
                    )}
                  >
                    {thumb ? (
                      <img src={thumb} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-bg-elevated flex items-center justify-center text-text-hint">
                        <Music2 size={20} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {info && (
          <PreviewInfoCard
            info={info}
            isMobile={isMobile}
            onClose={onClose}
            expanded={infoExpanded}
            onToggleExpanded={() => setInfoExpanded((v) => !v)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Прогрессивная картинка: thumb рисуется фоном (`contain`), full-`<img>` поверх
 * с `opacity-0` фейдит в `opacity-100` после `decode()`. Element-box full-`<img>`
 * совпадает с визуальной областью картинки (shadow/rounded по её краям), клик по
 * летербоксу вокруг проваливается к корневому onClose (stopPropagation только на
 * самом `<img>`).
 *
 * Apple-TV-наклон (`tiltEnabled`, desktop): узел ловит mousemove, считает
 * нормализованное смещение курсора от центра bounding-box'а картинки и пишет
 * CSS-переменные наклона прямо в DOM через ref (без re-render'а — как drag
 * bottom-sheet'а), `transition` сглаживает следование и возврат. Край под
 * курсором всегда «подаётся» к зрителю (растёт по экрану) → курсор не
 * выскакивает за узел, лишних mouseleave нет даже без отдельного wrapper'а.
 * Вне картинки и на mouseleave — возврат в плоскость.
 */
function ProgressiveImage({
  src,
  thumbnailUrl,
  tiltEnabled,
}: {
  src: string;
  thumbnailUrl: string | null;
  tiltEnabled: boolean;
}) {
  const hasThumb = !!thumbnailUrl && thumbnailUrl !== src;
  const [fullLoaded, setFullLoaded] = useState(false);

  // Эффект выключаем на тач/мобиле и при prefers-reduced-motion.
  const enableTilt =
    tiltEnabled &&
    typeof window !== "undefined" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const tiltRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const rafRef = useRef<number | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  const applyTilt = (rx: number, ry: number, scale: number) => {
    const el = tiltRef.current;
    if (!el) return;
    el.style.setProperty("--tilt-rx", `${rx}deg`);
    el.style.setProperty("--tilt-ry", `${ry}deg`);
    el.style.setProperty("--tilt-scale", `${scale}`);
  };

  const resetTilt = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    applyTilt(0, 0, 1);
  };

  // Отменяем pending rAF при размонтировании (key={output.id} ремаунтит при
  // смене картинки → наклон сбрасывается сам).
  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const onMouseMove = (e: ReactMouseEvent) => {
    pointerRef.current = { x: e.clientX, y: e.clientY };
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const p = pointerRef.current;
      const img = imgRef.current;
      if (!p || !img) return;
      const r = img.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const nx = (p.x - (r.left + r.width / 2)) / (r.width / 2);
      const ny = (p.y - (r.top + r.height / 2)) / (r.height / 2);
      // Курсор вне картинки (в летербоксе) — в плоскость: эффект живёт только
      // над самим изображением.
      if (nx < -1 || nx > 1 || ny < -1 || ny > 1) {
        applyTilt(0, 0, 1);
        return;
      }
      // Край под курсором «подаётся» к зрителю (поверхность смотрит на курсор).
      applyTilt(ny * TILT_MAX_DEG, -nx * TILT_MAX_DEG, TILT_SCALE);
    });
  };

  const handleLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    img
      .decode()
      .then(() => setFullLoaded(true))
      .catch(() => setFullLoaded(true));
  };

  return (
    <div
      ref={tiltRef}
      className="w-full h-full flex items-center justify-center"
      onMouseMove={enableTilt ? onMouseMove : undefined}
      onMouseLeave={enableTilt ? resetTilt : undefined}
      style={{
        // Thumb — background самого tilt-узла (background всегда рисуется ПОЗАДИ
        // контента), `contain` апскейлит его до места узла. Показываем только
        // ДО загрузки full-картинки: иначе квадратный thumb лежит ровно в том же
        // прямоугольнике, что и <img>, и заполняет его скруглённые углы сзади +
        // прячет под собой тень. После загрузки фон убираем → за rounded-углами
        // и под shadow остаётся прозрачный backdrop, карточка видна целиком.
        ...(hasThumb && !fullLoaded
          ? {
              backgroundImage: `url("${thumbnailUrl}")`,
              backgroundSize: "contain",
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
            }
          : null),
        ...(enableTilt
          ? {
              transform: `perspective(${TILT_PERSPECTIVE_PX}px) rotateX(var(--tilt-rx, 0deg)) rotateY(var(--tilt-ry, 0deg)) scale(var(--tilt-scale, 1))`,
              transformOrigin: "center",
              transition: TILT_TRANSITION,
              willChange: "transform",
            }
          : null),
      }}
    >
      <img
        ref={imgRef}
        src={src}
        alt=""
        fetchPriority="high"
        decoding="async"
        onLoad={hasThumb ? handleLoad : undefined}
        onClick={(e) => e.stopPropagation()}
        className={clsx(
          // max-w-full max-h-full (без w/h-full) — element-box img совпадает
          // с visible-image, поэтому shadow/rounded ложатся по краям картинки,
          // а его bounding-rect используется как якорь наклона.
          "max-w-full max-h-full object-contain rounded-[var(--radius)] shadow-2xl",
          hasThumb && "transition-opacity duration-300",
          hasThumb && !fullLoaded && "opacity-0",
        )}
      />
    </div>
  );
}

function MetaChip({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs"
      style={{ background: "var(--accent-lighter)", color: "var(--accent-light)" }}
    >
      {icon}
      {label}
    </span>
  );
}

function formatPreviewDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

function PreviewInfoCard({
  info,
  isMobile,
  onClose,
  expanded,
  onToggleExpanded,
}: {
  info: PreviewInfo;
  isMobile: boolean;
  onClose: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { t } = useTranslation();
  const hasMeta = Boolean(info.dateIso || info.tokensValue);
  const shots = info.shots ?? [];

  // Drag-state для мобильного bottom-sheet'а. На десктопе не используется.
  // dragY и стартовые значения живут в ref — touchmove апдейтит CSS-переменную
  // напрямую через ref'ом DOM, без re-render'ов компонента (важно для плавности
  // на больших инфо-карточках).
  const [dragging, setDragging] = useState(false);
  // Peek-анимация играет до первого взаимодействия с handle (тап/drag/expand).
  const [hasInteracted, setHasInteracted] = useState(false);
  const sheetRef = useRef<HTMLElement>(null);
  // maxOffset кэшируется на touchstart, чтобы touchmove не дёргал offsetHeight
  // и не форсил reflow на каждом тике.
  const dragStateRef = useRef({ startY: 0, startT: 0, dragY: 0, maxOffset: 0 });
  // Флаг: подавить ближайший click после touchend, если был реальный drag —
  // иначе мобильные браузеры пошлют синтетический click → лишний toggle.
  const skipNextClickRef = useRef(false);

  // Раскрытие извне (например, программно) тоже считается взаимодействием.
  useEffect(() => {
    if (expanded) setHasInteracted(true);
  }, [expanded]);

  function onHandleTouchStart(e: ReactTouchEvent) {
    const touch = e.touches[0];
    if (!touch) return;
    const sheetH = sheetRef.current?.offsetHeight ?? 0;
    dragStateRef.current = {
      startY: touch.clientY,
      startT: Date.now(),
      dragY: 0,
      // Максимальный сдвиг = высота sheet'а минус видимый peek. За эту границу
      // тянуть не пускаем — иначе sheet «отрывается» от края, появляется дыра.
      maxOffset: Math.max(0, sheetH - COLLAPSED_PEEK_PX),
    };
    setDragging(true);
    setHasInteracted(true);
  }

  function onHandleTouchMove(e: ReactTouchEvent) {
    const touch = e.touches[0];
    if (!touch || !sheetRef.current) return;
    const rawDy = touch.clientY - dragStateRef.current.startY;
    const { maxOffset } = dragStateRef.current;
    const clamped = expanded
      ? Math.max(0, Math.min(maxOffset, rawDy))
      : Math.max(-maxOffset, Math.min(0, rawDy));
    dragStateRef.current.dragY = clamped;
    // Прямая запись в CSS-переменную — без setState, без re-render'а.
    sheetRef.current.style.setProperty("--sheet-drag-y", `${clamped}px`);
  }

  function onHandleTouchEnd() {
    setDragging(false);
    const elapsed = Math.max(1, Date.now() - dragStateRef.current.startT);
    const totalDy = dragStateRef.current.dragY;
    const absDy = Math.abs(totalDy);
    const velocity = absDy / elapsed;
    if (absDy >= 5) {
      const triggered = absDy > DRAG_TOGGLE_PX || velocity > DRAG_TOGGLE_VELOCITY;
      if (triggered) {
        if (expanded && totalDy > 0) onToggleExpanded();
        else if (!expanded && totalDy < 0) onToggleExpanded();
      }
      skipNextClickRef.current = true;
    }
    dragStateRef.current.dragY = 0;
    // Активируем transition через ref ДО сброса var'а — иначе snap из drag-
    // position в resting происходит мгновенно (предыдущий render имел
    // transition: none из-за dragging=true). React следующим рендером
    // перезапишет ту же строку — без эффекта.
    if (sheetRef.current) {
      sheetRef.current.style.transition = SHEET_TRANSITION;
      sheetRef.current.style.setProperty("--sheet-drag-y", "0px");
    }
  }

  function onHandleClick(e: ReactMouseEvent) {
    e.stopPropagation();
    if (skipNextClickRef.current) {
      skipNextClickRef.current = false;
      return;
    }
    setHasInteracted(true);
    onToggleExpanded();
  }

  const content = (
    <>
      <div className="flex items-center gap-2 shrink-0 min-w-0">
        {info.iconPath && (
          <ModelAvatar
            className="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center bg-white/10 text-white"
            icon={info.iconPath}
            name={info.title}
            iconSize={16}
          />
        )}
        <h2 className="text-base font-semibold break-words m-0 min-w-0 flex-1">{info.title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="shrink-0 -mr-1 -mt-1 btn btn-ghost btn-icon"
        >
          <X size={18} />
        </button>
      </div>

      {hasMeta && (
        <div className="flex flex-wrap gap-1.5 shrink-0">
          {info.dateIso && (
            <MetaChip icon={<Calendar size={14} />} label={formatPreviewDate(info.dateIso)} />
          )}
          {info.tokensValue && (
            <MetaChip icon={<Coins size={14} />} label={`${info.tokensValue} ✦`} />
          )}
        </div>
      )}

      {/* Секция промпта: мультишот (список шотов) → одиночный промпт → ничего
          (пустой промпт прочерком больше не рисуем). */}
      {shots.length > 0 ? (
        <MultiShotSection shots={shots} />
      ) : info.prompt?.trim() ? (
        <SinglePromptSection prompt={info.prompt} />
      ) : null}

      {info.settings && info.settings.length > 0 && <SettingsSection rows={info.settings} />}

      {info.folders && <FoldersSection folders={info.folders} />}

      <div className="flex flex-col gap-2 mt-auto shrink-0">
        {info.onRepeat && (
          <Button
            size={isMobile ? "md" : "lg"}
            rightIcon={<ArrowRight />}
            onClick={info.onRepeat}
            fullWidth
          >
            {t("common.retry")}
          </Button>
        )}

        {/* Творческие продолжения — равные тайлы (иконка над подписью). */}
        {(info.onAnimate || info.onReference || info.onUpscale) && (
          <div className="flex gap-2">
            {info.onAnimate && (
              <ActionTile
                icon={<Clapperboard size={18} />}
                label={t("common.animate")}
                onClick={info.onAnimate}
              />
            )}
            {info.onReference && (
              <ActionTile
                icon={<Images size={18} />}
                label={t("common.reference")}
                onClick={info.onReference}
              />
            )}
            {info.onUpscale && (
              <ActionTile
                icon={<Maximize2 size={18} />}
                label={t("common.upscale")}
                onClick={info.onUpscale}
              />
            )}
          </div>
        )}

        {/* Утилиты — компактный ряд иконок с подписью, отделён линией. На мобилке
            показываем только иконки (подписи дублируют смысл и съедают экран). */}
        {(info.onDownload || info.onToggleFavorite || info.onDelete) && (
          <>
            <div className="border-t border-[color:var(--border)] mt-1" />
            <div
              className={clsx(
                "flex items-center gap-1",
                isMobile ? "justify-around" : "justify-start",
              )}
            >
              {info.onDownload && (
                <UtilityAction
                  icon={<Download size={16} />}
                  label={t("common.save")}
                  onClick={info.onDownload}
                  iconOnly={isMobile}
                />
              )}
              {info.onToggleFavorite && (
                <UtilityAction
                  icon={<Heart size={16} fill={info.isFavorite ? "currentColor" : "none"} />}
                  label={info.isFavorite ? t("common.inFavorites") : t("common.favorite")}
                  onClick={info.onToggleFavorite}
                  iconOnly={isMobile}
                />
              )}
              {info.onDelete && (
                <UtilityAction
                  icon={<Trash2 size={16} />}
                  label={t("common.delete")}
                  onClick={info.onDelete}
                  danger
                  iconOnly={isMobile}
                />
              )}
            </div>
          </>
        )}
      </div>
    </>
  );

  if (isMobile) {
    // Peek-анимация играет до первого взаимодействия. Пока класс активен —
    // не задаём инлайн transform: keyframes управляют позицией. Базовая
    // трансформа в классе совпадает с inline-resting → нет jump'а при снятии
    // класса после первого тапа.
    const playPeek = !hasInteracted && !expanded && !dragging;
    // Resting-positions: drag-offset берётся из CSS-переменной --sheet-drag-y,
    // которую touchmove пишет напрямую в DOM через ref (без re-render'а).
    const restingTransform = expanded
      ? "translateY(var(--sheet-drag-y, 0px))"
      : `translateY(calc(100% - ${COLLAPSED_PEEK_PX}px + var(--sheet-drag-y, 0px)))`;
    return (
      <aside
        ref={sheetRef}
        className={clsx(
          "fixed inset-x-0 bottom-0 z-[1100] flex flex-col text-white rounded-t-[20px] border-t overflow-hidden max-h-[85vh]",
          playPeek && "anim-sheet-peek",
        )}
        style={{
          background: "var(--bg-elevated)",
          borderColor: "var(--border-strong)",
          ...(playPeek
            ? {}
            : {
                transform: restingTransform,
                transition: dragging ? "none" : SHEET_TRANSITION,
              }),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Handle-зона: тап toggle, drag по порогам тоже toggle. touch-action:
            none — отключает нативный pull-to-refresh/скролл во время свайпа. */}
        <div
          className="shrink-0 pt-3 pb-2 px-4 select-none flex flex-col cursor-pointer"
          style={{ touchAction: "none" }}
          onTouchStart={onHandleTouchStart}
          onTouchMove={onHandleTouchMove}
          onTouchEnd={onHandleTouchEnd}
          onClick={onHandleClick}
        >
          {/* Полоска: при playPeek — пульсирует цветом (`anim-handle-pulse`),
              чтобы привлечь внимание к draggable-зоне без сильного движения
              самого sheet'а. */}
          <div
            className={clsx(
              "self-center w-12 h-1 rounded-full bg-[color:var(--border-strong)]",
              playPeek && "anim-handle-pulse",
            )}
          />
        </div>
        {/* Контент скроллится одним общим контейнером — секции внутри сами не
            ограничивают высоту на мобилке (`lg:max-h-...`). */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 flex flex-col gap-4">
          {content}
        </div>
      </aside>
    );
  }

  return (
    <aside
      className="relative shrink-0 w-full lg:w-[400px] card flex flex-col gap-4 text-white p-4 lg:p-6 min-h-0 overflow-hidden"
      style={{ background: "var(--bg-elevated)" }}
      onClick={(e) => e.stopPropagation()}
    >
      {content}
    </aside>
  );
}

/** Тайл «творческого» действия: иконка над короткой подписью, равная ширина. */
function ActionTile({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 min-w-0 flex flex-col items-center justify-center gap-1 py-2.5 rounded-[var(--radius)] bg-white/[0.06] text-text hover:bg-white/[0.1] transition-colors"
    >
      {icon}
      <span className="text-xs truncate max-w-full">{label}</span>
    </button>
  );
}

/** Компактное действие-утилита: иконка + подпись в строку, ghost-стиль.
 *  iconOnly — только иконка (без span) и без `flex-1`, ширина = padding'у; для
 *  мобилки, где подписи дублируют смысл. */
function UtilityAction({
  icon,
  label,
  onClick,
  danger,
  iconOnly,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  iconOnly?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded text-xs transition-colors",
        iconOnly ? "p-2.5" : "flex-1 min-w-0 px-2 py-2",
        danger ? "text-danger hover:text-text" : "text-text-secondary hover:text-text",
      )}
    >
      {icon}
      {!iconOnly && <span className="truncate">{label}</span>}
    </button>
  );
}

function PromptSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="text-xs uppercase tracking-wide shrink-0"
      style={{ color: "var(--text-secondary)" }}
    >
      {children}
    </div>
  );
}

/** Иконка-кнопка «копировать» с transient-состоянием «скопировано». */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);

  const copy = () => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    clearTimeout(timer.current ?? undefined);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? t("common.copied") : t("common.copy")}
      title={copied ? t("common.copied") : t("common.copy")}
      className={clsx(
        "shrink-0 inline-flex items-center justify-center p-1 rounded text-text-hint hover:text-text transition-colors",
        className,
      )}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

/** Одиночный промпт: line-clamp-3 + «Развернуть» на десктопе, скролл на мобиле. */
function SinglePromptSection({ prompt }: { prompt: string }) {
  const { t } = useTranslation();
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const promptRef = useRef<HTMLParagraphElement>(null);

  // Детект «реально ли промпт обрезан line-clamp'ом». Считаем один раз после
  // mount'а (промпт за время жизни модалки не меняется).
  useLayoutEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    setIsTruncated(el.scrollHeight - el.clientHeight > 1);
  }, [prompt]);

  return (
    <div className="flex flex-col gap-2 min-h-0 max-lg:shrink-0">
      <div className="flex items-center justify-between gap-2">
        <PromptSectionLabel>{t("prompts.prompt")}</PromptSectionLabel>
        <CopyButton text={prompt} />
      </div>
      <div className="flex flex-col gap-2 bg-white/[0.04] rounded-[var(--radius)] p-3">
        <p
          ref={promptRef}
          className={clsx(
            "text-sm leading-relaxed whitespace-pre-wrap break-words text-text-secondary m-0",
            // Мобилка/планшет (<lg): без ограничения — скроллится bottom-sheet
            // целиком, нет кнопки «Развернуть».
            // Десктоп (lg+): line-clamp-3 в свёрнутом, max-h+scroll в раскрытом.
            !promptExpanded && "lg:line-clamp-3",
            promptExpanded && "lg:overflow-y-auto lg:max-h-[40vh] lg:pr-1",
          )}
        >
          {prompt}
        </p>
        {isTruncated && (
          <button
            type="button"
            onClick={() => setPromptExpanded((v) => !v)}
            aria-expanded={promptExpanded}
            className="hidden lg:inline-flex self-start items-center gap-1 text-xs text-text-hint hover:text-text transition-colors"
          >
            <ChevronDown
              size={14}
              className={clsx("transition-transform", promptExpanded && "rotate-180")}
            />
            {promptExpanded ? t("common.collapse") : t("common.expand")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Мультишот (Kling): список блоков «Шот N · длительность» + промпт шота. */
function MultiShotSection({ shots }: { shots: ShotEntry[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 min-h-0 max-lg:shrink-0">
      <PromptSectionLabel>{t("prompts.prompt")}</PromptSectionLabel>
      <div className="flex flex-col gap-2 lg:overflow-y-auto lg:max-h-[40vh] lg:pr-1">
        {shots.map((shot, i) => (
          <div key={i} className="flex flex-col gap-1 bg-white/[0.04] rounded-[var(--radius)] p-3">
            <div className="flex items-center gap-2 text-xs text-text-hint">
              <span className="font-semibold">{t("generate.multishot.shotN", { n: i + 1 })}</span>
              <span>·</span>
              <span>{t("generate.multishot.seconds", { value: shot.duration })}</span>
              {shot.prompt && <CopyButton text={shot.prompt} className="ml-auto" />}
            </div>
            <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-text-secondary m-0">
              {shot.prompt || "—"}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Блок настроек генерации: label/value-строки. Advanced скрыты под «Показать все». */
function SettingsSection({ rows }: { rows: SettingRow[] }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasAdvanced = rows.some((r) => r.advanced);
  const visible = expanded ? rows : rows.filter((r) => !r.advanced);

  return (
    <div className="flex flex-col gap-2 shrink-0">
      <PromptSectionLabel>{t("common.settings")}</PromptSectionLabel>
      <div className="flex flex-col gap-1.5 bg-white/[0.04] rounded-[var(--radius)] p-3 lg:max-h-40 lg:overflow-y-auto">
        {visible.map((r) => (
          <div key={r.label} className="flex items-start justify-between gap-3 text-sm">
            <span className="text-text-secondary min-w-0 break-words">{r.label}</span>
            <span className="text-text break-words text-right">{r.value}</span>
          </div>
        ))}
      </div>
      {hasAdvanced && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="self-start inline-flex items-center gap-1 text-xs text-text-hint hover:text-text transition-colors"
        >
          <ChevronDown
            size={14}
            className={clsx("transition-transform", expanded && "rotate-180")}
          />
          {expanded ? t("common.collapse") : t("common.seeAll")}
        </button>
      )}
    </div>
  );
}

function FoldersSection({ folders }: { folders: PreviewFolders }) {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  // Default («Избранное») управляется кнопкой-сердечком на карточке — не выводим.
  const nonDefault = useMemo(() => folders.list.filter((f) => !f.isDefault), [folders.list]);
  // Секцию показываем, если есть пользовательские папки ЛИБО доступно создание.
  if (nonDefault.length === 0 && !folders.onCreate) return null;

  return (
    <div className="flex flex-col gap-2 shrink-0">
      <div className="text-xs uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
        {t("common.addToFolders")}
      </div>
      <div className="flex flex-wrap gap-1.5 lg:max-h-32 lg:overflow-y-auto">
        {nonDefault.map((f) => {
          const active = folders.selectedIds.includes(f.id);
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => folders.onToggle(f.id)}
              className={clsx(
                "px-2.5 py-1 rounded-full text-xs transition-colors max-w-full truncate",
                active
                  ? "bg-accent text-white"
                  : "bg-white/[0.06] text-text-secondary hover:text-text hover:bg-white/[0.1]",
              )}
              title={f.name}
            >
              {f.name}
            </button>
          );
        })}
        {folders.onCreate && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs transition-colors bg-white/[0.06] text-text-secondary hover:text-text hover:bg-white/[0.1]"
          >
            <FolderPlus size={12} />
            {t("common.newFolder")}
          </button>
        )}
      </div>
      {createOpen && folders.onCreate && (
        <FolderNameDialog
          title={t("common.newFolder")}
          submitLabel={t("common.newFolder")}
          pending={false}
          onSubmit={(name) => {
            folders.onCreate?.(name);
            setCreateOpen(false);
          }}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </div>
  );
}
