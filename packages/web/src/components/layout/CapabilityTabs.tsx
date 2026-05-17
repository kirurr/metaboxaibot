import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";
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

type Capability = { id: "text" | "image" | "video" | "audio"; label: string; route: string };

const CAPABILITIES: readonly Capability[] = [
  { id: "text", label: "Chat", route: "/chat" },
  { id: "image", label: "Image", route: "/image" },
  { id: "video", label: "Video", route: "/video" },
  { id: "audio", label: "Audio", route: "/audio" },
] as const;

type MenuItem = {
  name: string;
  desc: string;
  glyph?: string;
  letter?: string;
  badge?: "TOP" | "NEW";
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
    { name: "Generate Image", desc: "Создавайте AI-картинки с нуля.", glyph: "▢" },
    { name: "Product Shots", desc: "Фотореалистичные продакт-снимки.", glyph: "◈" },
    { name: "Edit Photo", desc: "Правьте свет, фон, детали одним кликом.", glyph: "◯" },
    { name: "Upscale", desc: "Повышение разрешения до 4k.", glyph: "▲" },
    { name: "LoRA Training", desc: "Обучите модель на своём лице.", glyph: "✪" },
    { name: "Style Transfer", desc: "Перенос стиля одного фото на другое.", glyph: "◇" },
    { name: "Background Edit", desc: "Замена и ретушь фона.", glyph: "▦" },
  ],
  video: [
    { name: "Create Video", desc: "Генерируйте AI-видео по промпту.", glyph: "▷" },
    { name: "Cinema Studio", desc: "Кинематография с AI-режиссёром.", glyph: "▣", badge: "TOP" },
    { name: "Mixed Media", desc: "Смешанные проекты: фото + видео + аудио.", glyph: "◫" },
    { name: "Edit Video", desc: "Правьте сцены, планы, элементы.", glyph: "▥" },
    { name: "Lipsync Studio", desc: "Говорящие клипы из фото.", glyph: "◎" },
    { name: "Sketch to Video", desc: "Набросок превращается в видео.", glyph: "✏" },
    { name: "Video Upscale", desc: "Улучшение качества видео.", glyph: "▱" },
    { name: "Avatar Factory", desc: "Соберите UGC-видео с аватаром.", glyph: "◍", badge: "NEW" },
  ],
  audio: [
    { name: "Text to Speech", desc: "Превратите текст в реалистичную речь.", glyph: "◀" },
    {
      name: "Voice Cloning",
      desc: "Клонируйте любой голос за 30 секунд.",
      glyph: "○",
      badge: "TOP",
    },
    { name: "Music Generation", desc: "Полные треки с вокалом по промпту.", glyph: "♫" },
    { name: "Dubbing", desc: "Многоязычный дубляж в липсинк.", glyph: "◯" },
    { name: "Transcription", desc: "Распознавание речи в текст.", glyph: "▤" },
    { name: "Audio Cleanup", desc: "Шумоподавление и реставрация.", glyph: "△" },
    { name: "Voice Library", desc: "500+ готовых голосов.", glyph: "▼" },
  ],
};

function isActiveRoute(capRoute: string, currentPath: string): boolean {
  if (capRoute === "/chat") return currentPath.startsWith("/chat");
  return currentPath === capRoute;
}

export function CapabilityTabs() {
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
      const list = modelsForCapability(allModels, cap);
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

  function pick(cap: Capability, modelId?: string) {
    setHovered(null);
    // Передаём modelId как ?model=...: если юзер уже в этом разделе и кликает
    // другую модель в mega-menu, route не меняется и страница без query-param
    // не узнала бы о смене. GenerateScene читает `?model=` и синкает modelId.
    const target = modelId ? `${cap.route}?model=${encodeURIComponent(modelId)}` : cap.route;
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
                <span>{c.label}</span>
              </button>
              {showMenu && (
                <div
                  className="mega-menu"
                  ref={menuRef}
                  onMouseEnter={() => openMenu(c.id)}
                  onMouseLeave={scheduleClose}
                >
                  <div className="mega-col">
                    <div className="mega-col-head">Features</div>
                    <div className="mega-list">
                      {features.map((f, i) => (
                        <button key={i} className="mega-item" onClick={() => pick(c)}>
                          <span className="mega-ico">{f.glyph}</span>
                          <span className="mega-body">
                            <span className="mega-name">
                              {f.name}
                              {f.badge && (
                                <span className={"mega-badge " + f.badge.toLowerCase()}>
                                  {f.badge}
                                </span>
                              )}
                            </span>
                            <span className="mega-desc">{f.desc}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mega-col">
                    <div className="mega-col-head">Models</div>
                    <div className="mega-list">
                      {models.length === 0 ? (
                        <div className="mega-empty">Загрузка моделей…</div>
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
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
