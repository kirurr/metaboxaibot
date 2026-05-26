import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";
import type { WebModelDto } from "@/api/models";

/**
 * Капабилити-табы в TopNav: «Chat / Image / Video / Audio».
 * Для image/video/audio при наведении показывается mega-menu с двумя колонками
 * (Features + Models). Клик по любому пункту меню — переход на соответствующий
 * раздел (`/chat`, `/image`, `/video`, `/audio`).
 *
 * Колонка «Features» — статичная (use-case ярлыки, не настоящие модели).
 * Колонка «Models» — динамическая из `useModelsStore` (`/web/models`).
 *
 * Источник дизайна: `aibox_template/ai-box-pre-tilted.html` (CapabilityTabs).
 */

type Capability = {
  id: "text" | "image" | "video" | "audio";
  /** i18n-ключ для подписи капабилити (резолвится в рендере). */
  labelKey: string;
  route: string;
};

const CAPABILITIES: readonly Capability[] = [
  { id: "text", labelKey: "capabilities.chat", route: "/chat" },
  { id: "image", labelKey: "capabilities.image", route: "/image" },
  { id: "video", labelKey: "capabilities.video", route: "/video" },
  { id: "audio", labelKey: "capabilities.audio", route: "/audio" },
] as const;

type MenuItem = {
  /** i18n-ключи для name/desc. */
  nameKey: string;
  descKey: string;
  glyph?: string;
  letter?: string;
  badge?: "TOP" | "NEW";
  /** Индивидуальные ссылки */
  link?: string;
};

// Сколько моделей показываем в mega-menu максимум — чтобы не утопить колонку.
const MAX_MODELS_IN_MENU = 6;

/** Имя моделей в UI: для family-моделей подставляем familyName, иначе берём `name` как есть. */
function displayModelName(m: WebModelDto): string {
  return m.familyName ?? m.name;
}

/** Короткое описание для строки в mega-menu (приоритет: описание варианта → общее описание). */
function displayModelDesc(m: WebModelDto): string {
  return m.descriptionOverride ?? m.description;
}

/** Берём первую букву family или name — для квадратного «letter» аватара слева. */
function modelLetter(m: WebModelDto): string {
  return displayModelName(m).trim().slice(0, 1).toUpperCase() || "·";
}

const FEATURE_MENUS: Record<string, MenuItem[]> = {
  image: [
    {
      nameKey: "capabilities.features.image.generate.name",
      descKey: "capabilities.features.image.generate.desc",
      glyph: "▢",
    },
    // Плейсхолдеры без пресета/реализации — временно скрыты (вели просто на /image).
    // {
    //   nameKey: "capabilities.features.image.product.name",
    //   descKey: "capabilities.features.image.product.desc",
    //   glyph: "◈",
    // },
    // {
    //   nameKey: "capabilities.features.image.edit.name",
    //   descKey: "capabilities.features.image.edit.desc",
    //   glyph: "◯",
    // },
    {
      nameKey: "capabilities.features.image.upscale.name",
      descKey: "capabilities.features.image.upscale.desc",
      glyph: "▲",
      link: "upscale",
    },
    // {
    //   nameKey: "capabilities.features.image.lora.name",
    //   descKey: "capabilities.features.image.lora.desc",
    //   glyph: "✪",
    // },
    // {
    //   nameKey: "capabilities.features.image.style.name",
    //   descKey: "capabilities.features.image.style.desc",
    //   glyph: "◇",
    // },
    {
      nameKey: "capabilities.features.image.background.name",
      descKey: "capabilities.features.image.background.desc",
      glyph: "▦",
      link: "bg-removal",
    },
    {
      nameKey: "capabilities.features.image.faceSwap.name",
      descKey: "capabilities.features.image.faceSwap.desc",
      glyph: "◑",
      link: "face-swap",
    },
    {
      nameKey: "capabilities.features.image.clothingTryon.name",
      descKey: "capabilities.features.image.clothingTryon.desc",
      glyph: "❖",
      link: "clothing-tryon",
    },
    {
      nameKey: "capabilities.features.image.objectRemoval.name",
      descKey: "capabilities.features.image.objectRemoval.desc",
      glyph: "⊘",
      link: "object-removal",
    },
  ],
  video: [
    {
      nameKey: "capabilities.features.video.create.name",
      descKey: "capabilities.features.video.create.desc",
      glyph: "▷",
    },
    {
      nameKey: "capabilities.features.video.animate.name",
      descKey: "capabilities.features.video.animate.desc",
      glyph: "◉",
      link: "photo-animate",
    },
    // Плейсхолдеры без пресета/реализации — временно скрыты (вели просто на /video).
    // {
    //   nameKey: "capabilities.features.video.cinema.name",
    //   descKey: "capabilities.features.video.cinema.desc",
    //   glyph: "▣",
    //   badge: "TOP",
    // },
    // {
    //   nameKey: "capabilities.features.video.mixed.name",
    //   descKey: "capabilities.features.video.mixed.desc",
    //   glyph: "◫",
    // },
    // {
    //   nameKey: "capabilities.features.video.edit.name",
    //   descKey: "capabilities.features.video.edit.desc",
    //   glyph: "▥",
    // },
    // {
    //   nameKey: "capabilities.features.video.lipsync.name",
    //   descKey: "capabilities.features.video.lipsync.desc",
    //   glyph: "◎",
    // },
    // {
    //   nameKey: "capabilities.features.video.sketch.name",
    //   descKey: "capabilities.features.video.sketch.desc",
    //   glyph: "✏",
    // },
    {
      nameKey: "capabilities.features.video.upscale.name",
      descKey: "capabilities.features.video.upscale.desc",
      glyph: "▱",
      link: "video-upscale",
    },
    // {
    //   nameKey: "capabilities.features.video.avatar.name",
    //   descKey: "capabilities.features.video.avatar.desc",
    //   glyph: "◍",
    //   badge: "NEW",
    // },
  ],
  audio: [
    {
      nameKey: "capabilities.features.audio.tts.name",
      descKey: "capabilities.features.audio.tts.desc",
      glyph: "◀",
      link: "tts",
    },
    {
      nameKey: "capabilities.features.audio.clone.name",
      descKey: "capabilities.features.audio.clone.desc",
      glyph: "○",
      badge: "TOP",
      link: "clone",
    },
    {
      nameKey: "capabilities.features.audio.music.name",
      descKey: "capabilities.features.audio.music.desc",
      glyph: "♫",
      link: "music",
    },
    {
      nameKey: "capabilities.features.audio.dubbing.name",
      descKey: "capabilities.features.audio.dubbing.desc",
      glyph: "◯",
    },
    {
      nameKey: "capabilities.features.audio.transcribe.name",
      descKey: "capabilities.features.audio.transcribe.desc",
      glyph: "▤",
    },
    {
      nameKey: "capabilities.features.audio.cleanup.name",
      descKey: "capabilities.features.audio.cleanup.desc",
      glyph: "△",
    },
    {
      nameKey: "capabilities.features.audio.library.name",
      descKey: "capabilities.features.audio.library.desc",
      glyph: "▼",
    },
  ],
};

function isActiveRoute(capRoute: string, currentPath: string): boolean {
  if (capRoute === "/chat") return currentPath.startsWith("/chat");
  return currentPath === capRoute;
}

export function CapabilityTabs() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const allModels = useModelsStore((s) => s.models);
  const [hovered, setHovered] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Группируем модели по capability один раз на изменение каталога — все 4 ключа,
  // даже если для секции каталог пока пустой (загрузка не завершена). Семейства
  // дедупим (Flux Pro/LoRA/etc. → одна строка с familyName), чтобы колонка не
  // утопала: семейство — это бренд, варианты выбираются уже внутри страницы.
  const modelsByCap = useMemo(() => {
    const dedup = (cap: Capability["id"]): WebModelDto[] => {
      // Preset-only модели (hiddenFromCarousel) в мега-меню не показываем —
      // они доступны только через свой URL-пресет.
      const list = modelsForCapability(allModels, cap).filter((m) => !m.hiddenFromCarousel);
      const seenFamilies = new Set<string>();
      const out: WebModelDto[] = [];
      for (const m of list) {
        if (m.familyId) {
          if (seenFamilies.has(m.familyId)) continue;
          seenFamilies.add(m.familyId);
        }
        out.push(m);
      }
      return out;
    };
    return {
      text: dedup("text"),
      image: dedup("image"),
      video: dedup("video"),
      audio: dedup("audio"),
    } satisfies Record<Capability["id"], WebModelDto[]>;
  }, [allModels]);

  const openMenu = (id: string, hasMenu = true) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    // Не переключаем `hovered` на cap без mega-меню (например Chat). Иначе при
    // hover'е на edge соседней кнопки курсор задевает её cap-wrap, сбрасывает
    // hovered → showMenu для текущего раздела становится false → попап
    // моргает/исчезает на пересечении gap'а между cap-wrap'ами.
    if (hasMenu) setHovered(id);
  };
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    // 220ms — даём юзеру шанс вернуть курсор в hover-зону, если он промахнулся
    // мимо bridge'а на вертикальном overshoot'е.
    closeTimer.current = setTimeout(() => setHovered(null), 220);
  };

  // Сдвиг popup, чтобы не вылезал за края viewport'а.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    el.style.setProperty("--mm-shift", "0px");
    const r = el.getBoundingClientRect();
    const margin = 12;
    let shift = 0;
    if (r.right > window.innerWidth - margin) shift = -(r.right - (window.innerWidth - margin));
    else if (r.left < margin) shift = margin - r.left;
    if (shift) el.style.setProperty("--mm-shift", shift + "px");
  }, [hovered]);

  function pick(cap: Capability, modelId?: string, link: string = "") {
    setHovered(null);
    // Передаём modelId как ?model=...: если юзер уже в этом разделе и кликает
    // другую модель в mega-menu, route не меняется и страница без query-param
    // не узнала бы о смене. GenerateScene читает `?model=` и синкает modelId.
    const target = modelId
      ? `${cap.route}/${link}?model=${encodeURIComponent(modelId)}`
      : `${cap.route}/${link}`;
    navigate(target);
  }

  return (
    // Wrapper-зона с padding'ом ±10px по периметру: расширяет hover-area вокруг
    // cap-tabs так, чтобы вертикальный overshoot мышью (выход курсора на 1-5px
    // выше/ниже кнопок) не считался "leave". Margin компенсирует визуально —
    // layout не меняется.
    <div className="cap-tabs-zone" onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
      <div className="cap-tabs">
        {CAPABILITIES.map((c) => {
          const features = FEATURE_MENUS[c.id] ?? [];
          const models = modelsByCap[c.id] ?? [];
          const isMega = c.id !== "text" && features.length > 0;
          const showMenu = hovered === c.id && isMega;
          const active = isActiveRoute(c.route, location.pathname);
          return (
            <div key={c.id} className="cap-wrap" onMouseEnter={() => openMenu(c.id, isMega)}>
              <button className={clsx("cap", active && "on")} onClick={() => pick(c)}>
                <span className="cap-dot" />
                <span>{t(c.labelKey)}</span>
              </button>
              {showMenu && (
                <div
                  className={clsx(
                    "mega-menu",
                    // Для аудио не показываем список моделей
                    c.id === "audio" && "!w-[min(400px,_calc(100vw-24px))]",
                  )}
                  ref={menuRef}
                  onMouseEnter={() => openMenu(c.id)}
                  onMouseLeave={scheduleClose}
                >
                  <div
                    className={clsx(
                      "mega-col",
                      // Для аудио не показываем список моделей
                      c.id === "audio" && "!col-span-2",
                    )}
                  >
                    <div className="mega-col-head">{t("capabilities.columns.features")}</div>
                    <div className="mega-list">
                      {features.map((f, i) => (
                        <button
                          key={i}
                          className="mega-item"
                          onClick={() => pick(c, undefined, f.link)}
                        >
                          <span className="mega-ico">{f.glyph}</span>
                          <span className="mega-body">
                            <span className="mega-name">
                              {t(f.nameKey)}
                              {f.badge && (
                                <span className={"mega-badge " + f.badge.toLowerCase()}>
                                  {t(`capabilities.features.badge.${f.badge}`)}
                                </span>
                              )}
                            </span>
                            <span className="mega-desc">{t(f.descKey)}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Для аудио не показываем список моделей */}
                  {c.id !== "audio" && (
                    <div className="mega-col">
                      <div className="mega-col-head">{t("capabilities.columns.models")}</div>
                      <div className="mega-list">
                        {models.length === 0 ? (
                          <div className="mega-empty">{t("capabilities.columns.loading")}</div>
                        ) : (
                          models.slice(0, MAX_MODELS_IN_MENU).map((m) => (
                            <button key={m.id} className="mega-item" onClick={() => pick(c, m.id)}>
                              <span className="mega-ico letter">{modelLetter(m)}</span>
                              <span className="mega-body">
                                <span className="mega-name">{displayModelName(m)}</span>
                                <span className="mega-desc">{displayModelDesc(m)}</span>
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
