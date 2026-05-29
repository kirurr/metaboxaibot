import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";
import type { WebModelDto } from "@/api/models";
import {
  CAPABILITIES,
  type Capability,
  FEATURE_MENUS,
  MAX_MODELS_IN_MENU,
  dedupByFamily,
  displayModelDesc,
  displayModelName,
} from "@/components/layout/capabilityData";
import { ModelAvatar } from "@/components/common/ModelAvatar";

/**
 * Капабилити-табы в TopNav: «Chat / Image / Video / Audio».
 * Для image/video/audio при наведении показывается mega-menu с двумя колонками
 * (Features + Models). Клик по любому пункту меню — переход на соответствующий
 * раздел (`/chat`, `/image`, `/video`, `/audio`).
 *
 * Колонка «Features» — статичная (use-case ярлыки, не настоящие модели).
 * Колонка «Models» — динамическая из `useModelsStore` (`/web/models`).
 *
 * Конфиг (`CAPABILITIES`, `FEATURE_MENUS`, хелперы моделей) вынесен в
 * `capabilityData.ts` и переиспользуется мобильным `GenerateSheet`-ом.
 *
 * Источник дизайна: `aibox_template/ai-box-pre-tilted.html` (CapabilityTabs).
 */

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
  // Preset-only модели (hiddenFromCarousel) в мега-меню не показываем — они
  // доступны только через свой URL-пресет.
  const modelsByCap = useMemo(() => {
    const pick = (cap: Capability["id"]): WebModelDto[] =>
      dedupByFamily(modelsForCapability(allModels, cap).filter((m) => !m.hiddenFromCarousel));
    return {
      text: pick("text"),
      image: pick("image"),
      video: pick("video"),
      audio: pick("audio"),
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
                              <ModelAvatar
                                className="mega-ico letter"
                                icon={m.webIconPath}
                                name={displayModelName(m)}
                              />
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
