import { useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";

/**
 * Капабилити-табы в TopNav: «Chat / Image / Video / Audio».
 * Для image/video/audio при наведении показывается mega-menu с двумя колонками
 * (Features + Models). Клик по любому пункту меню — переход на соответствующий
 * раздел (`/chat`, `/image`, `/video`, `/audio`). Сейчас все элементы — заглушки
 * под будущую динамическую загрузку моделей/режимов.
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

const MODEL_MENUS: Record<string, MenuItem[]> = {
  image: [
    {
      name: "nano-banana-pro",
      desc: "Фотореализм, продакт-съёмка, портреты.",
      letter: "N",
      badge: "TOP",
    },
    { name: "Flux Pro", desc: "Тонкая работа со светом и текстурами.", letter: "F" },
    { name: "Flux LoRA", desc: "Обучение на вашем лице или бренде.", letter: "L", badge: "NEW" },
    { name: "Ideogram v3", desc: "Сильно в типографике, логотипах, постерах.", letter: "I" },
    { name: "Midjourney v7", desc: "Стилизованные кадры, кино, иллюстрация.", letter: "M" },
  ],
  video: [
    {
      name: "Runway Gen-4",
      desc: "Кинематография, плавные камеры, сложные композиции.",
      letter: "R",
      badge: "TOP",
    },
    { name: "HeyGen", desc: "Говорящие аватары и дубляж в липсинк.", letter: "H" },
    { name: "Kling 1.6", desc: "Сложная физика и реалистичная природа.", letter: "K" },
    { name: "Veo 3", desc: "Нативные 1080p, высокая детализация.", letter: "V", badge: "NEW" },
    { name: "Sora 2", desc: "OpenAI — самая продвинутая видео-модель.", letter: "S" },
  ],
  audio: [
    {
      name: "Cartesia Sonic",
      desc: "TTS с реалистичной интонацией.",
      letter: "C",
      badge: "TOP",
    },
    { name: "ElevenLabs v3", desc: "Клон голоса и многоязычный дубляж.", letter: "E" },
    { name: "Suno v4", desc: "Музыка целиком с вокалом по промпту.", letter: "S", badge: "NEW" },
    { name: "Whisper Large", desc: "Распознавание речи, транскрибация.", letter: "W" },
  ],
};

function isActiveRoute(capRoute: string, currentPath: string): boolean {
  if (capRoute === "/chat") return currentPath.startsWith("/chat");
  return currentPath === capRoute;
}

export function CapabilityTabs() {
  const navigate = useNavigate();
  const location = useLocation();
  const [hovered, setHovered] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const openMenu = (id: string) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setHovered(id);
  };
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHovered(null), 140);
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

  function pick(cap: Capability) {
    setHovered(null);
    navigate(cap.route);
  }

  return (
    <div className="cap-tabs" onMouseLeave={scheduleClose}>
      {CAPABILITIES.map((c) => {
        const features = FEATURE_MENUS[c.id] ?? [];
        const models = MODEL_MENUS[c.id] ?? [];
        const isMega = c.id !== "text" && features.length > 0;
        const showMenu = hovered === c.id && isMega;
        const active = isActiveRoute(c.route, location.pathname);
        return (
          <div key={c.id} className="cap-wrap" onMouseEnter={() => openMenu(c.id)}>
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
                    {models.map((m, i) => (
                      <button key={i} className="mega-item" onClick={() => pick(c)}>
                        <span className="mega-ico letter">{m.letter ?? m.name[0]}</span>
                        <span className="mega-body">
                          <span className="mega-name">
                            {m.name}
                            {m.badge && (
                              <span className={"mega-badge " + m.badge.toLowerCase()}>
                                {m.badge}
                              </span>
                            )}
                          </span>
                          <span className="mega-desc">{m.desc}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
