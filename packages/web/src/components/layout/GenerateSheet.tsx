import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";
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
 * Мобильный bottom-sheet, открываемый центральной FAB-кой «Генерировать» в
 * BottomNav. Воспроизводит логику desktop-ового `CapabilityTabs`, но в форм-
 * факторе листа с табами Image / Video / Audio и крупными touch-friendly
 * рядами. Конфиг (FEATURE_MENUS, помощники моделей) общий — см.
 * `capabilityData.ts`.
 *
 * Закрытие: backdrop-tap, X в хедере, swipe-down по drag-handle/хедеру,
 * Escape, навигация (после клика по feature/модели).
 */

type Tab = "image" | "video" | "audio";

const DRAG_CLOSE_PX = 100;
const DRAG_CLOSE_VELOCITY = 0.6; // px/ms

export function GenerateSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const allModels = useModelsStore((s) => s.models);
  const [tab, setTab] = useState<Tab>("image");
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);
  const startT = useRef(0);

  // Дедуп и hidden-фильтр — как в desktop CapabilityTabs.
  const models = useMemo(
    () => dedupByFamily(modelsForCapability(allModels, tab).filter((m) => !m.hiddenFromCarousel)),
    [allModels, tab],
  );
  const features = FEATURE_MENUS[tab] ?? [];
  const capability = useMemo<Capability>(
    () => CAPABILITIES.find((c) => c.id === tab) ?? CAPABILITIES[1]!,
    [tab],
  );

  // Body scroll lock + Escape — только пока sheet открыт.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  // Сбрасываем drag-offset, если sheet был закрыт извне (например, route-change).
  useEffect(() => {
    if (!open) setDragY(0);
  }, [open]);

  if (!open) return null;

  function pick(link: string, modelId?: string) {
    const target = modelId
      ? `${capability.route}/${link}?model=${encodeURIComponent(modelId)}`
      : `${capability.route}/${link}`;
    onClose();
    navigate(target);
  }

  function onTouchStart(e: React.TouchEvent) {
    const touch = e.touches[0];
    if (!touch) return;
    startY.current = touch.clientY;
    startT.current = Date.now();
    setDragging(true);
  }

  function onTouchMove(e: React.TouchEvent) {
    const touch = e.touches[0];
    if (!touch) return;
    const dy = touch.clientY - startY.current;
    // Тянем только вниз — clamp к 0, чтобы не было резинового вверх-эффекта.
    setDragY(Math.max(0, dy));
  }

  function onTouchEnd() {
    setDragging(false);
    const elapsed = Math.max(1, Date.now() - startT.current);
    const velocity = dragY / elapsed;
    if (dragY > DRAG_CLOSE_PX || velocity > DRAG_CLOSE_VELOCITY) {
      onClose();
    } else {
      setDragY(0);
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[110]"
        style={{
          background: "rgba(0,0,0,0.55)",
          backdropFilter: "blur(2px)",
          animation: "page-in 220ms cubic-bezier(0.4, 0, 0.2, 1)",
        }}
        onClick={onClose}
      />
      <div
        className="fixed inset-x-0 bottom-0 z-[111] flex flex-col rounded-t-[20px] border-t overflow-hidden"
        style={{
          background: "var(--bg-elevated)",
          borderColor: "var(--border-strong)",
          // Фиксированная высота — чтобы при переключении табов (например на
          // audio с меньшим набором пресетов) sheet не «прыгал» по высоте.
          height: "78vh",
          transform: `translateY(${dragY}px)`,
          transition: dragging ? "none" : "transform 220ms cubic-bezier(.22,1,.36,1)",
          animation: dragging ? undefined : "voicePickerIn 220ms cubic-bezier(.22,1,.36,1)",
        }}
      >
        {/* Header (drag-handle + title + X) — touch-зона свайпа */}
        <div
          className="flex flex-col items-stretch px-4 pt-3 pb-2 select-none"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <div
            className="self-center w-9 h-1 rounded-full mb-3"
            style={{ background: "var(--border-strong)" }}
          />
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
              {t("nav.bottom.generate")}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close", { defaultValue: "Close" })}
              className="h-9 w-9 rounded-full flex items-center justify-center border transition-colors"
              style={{
                background: "rgba(255,255,255,0.04)",
                borderColor: "var(--border-strong)",
                color: "var(--text-secondary)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--text-secondary)";
              }}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Segmented tabs: Image / Video / Audio.
            `px-2 pb-3` снаружи + `gap-0.5 p-1` внутри + text-[13px] —
            компактные отступы, чтобы «Изображения» (самое широкое слово)
            влезало даже на 320px-устройствах. */}
        <div className="px-2 pb-3">
          <div
            className="flex gap-0.5 p-1 rounded-full"
            style={{ background: "var(--bg-secondary)" }}
          >
            {(["image", "video", "audio"] as const).map((id) => {
              const isActive = tab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className="flex-1 h-9 rounded-full text-[13px] font-medium whitespace-nowrap transition-colors"
                  style={
                    isActive
                      ? { background: "var(--accent)", color: "var(--text-on-accent)" }
                      : { color: "var(--text-secondary)" }
                  }
                >
                  {t(`capabilities.${id}`)}
                </button>
              );
            })}
          </div>
        </div>

        {/* Scrollable content */}
        <div
          className="flex-1 overflow-y-auto px-4 space-y-5"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)" }}
        >
          <section>
            <div
              className="text-xs uppercase tracking-wide mb-2"
              style={{ color: "var(--text-hint)" }}
            >
              {t("capabilities.columns.features")}
            </div>
            <div className="flex flex-col gap-1">
              {features.map((f, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => pick(f.link ?? "")}
                  className="flex items-start gap-3 p-3 rounded-[14px] text-left transition-colors"
                  style={{ background: "var(--bg-secondary)" }}
                >
                  <span
                    className="shrink-0 w-10 h-10 rounded-[10px] flex items-center justify-center text-lg"
                    style={{
                      background: "var(--accent-lighter)",
                      color: "var(--accent-light)",
                    }}
                  >
                    {f.glyph}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium" style={{ color: "var(--text)" }}>
                      {t(f.nameKey)}
                      {f.badge && (
                        <span className={"mega-badge ml-2 " + f.badge.toLowerCase()}>
                          {t(`capabilities.features.badge.${f.badge}`)}
                        </span>
                      )}
                    </span>
                    <span
                      className="block text-xs mt-0.5"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {t(f.descKey)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          {/* Колонка моделей — скрываем для audio (как в desktop CapabilityTabs). */}
          {tab !== "audio" && (
            <section>
              <div
                className="text-xs uppercase tracking-wide mb-2"
                style={{ color: "var(--text-hint)" }}
              >
                {t("capabilities.columns.models")}
              </div>
              <div className="flex flex-col gap-1">
                {models.length === 0 ? (
                  <div className="text-xs px-3 py-4" style={{ color: "var(--text-hint)" }}>
                    {t("capabilities.columns.loading")}
                  </div>
                ) : (
                  models.slice(0, MAX_MODELS_IN_MENU).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => pick("", m.id)}
                      className="flex items-start gap-3 p-3 rounded-[14px] text-left transition-colors"
                      style={{ background: "var(--bg-secondary)" }}
                    >
                      <ModelAvatar
                        className="shrink-0 w-10 h-10 rounded-[10px] flex items-center justify-center text-base font-semibold"
                        style={{
                          background: "var(--accent-lighter)",
                          color: "var(--accent-light)",
                        }}
                        icon={m.webIconPath}
                        name={displayModelName(m)}
                        iconSize={24}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className="block text-sm font-medium truncate"
                          style={{ color: "var(--text)" }}
                        >
                          {displayModelName(m)}
                        </span>
                        <span
                          className="block text-xs mt-0.5 line-clamp-2"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          {displayModelDesc(m)}
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
