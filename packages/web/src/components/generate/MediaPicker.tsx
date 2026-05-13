import { useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";
import clsx from "clsx";

/**
 * Универсальный picker с сеткой превью (avatars / motions / soul styles).
 * Layout идентичен `VoicePicker`: на десктопе — sticky-панель справа от
 * `.gen-panel`, на mobile — bottom-sheet модалка (правила в .voice-picker* CSS
 * переиспользуем для consistency, но grid-контент специфичен).
 *
 * Single- или multi-select определяется через `maxItems`:
 *  - maxItems=1 (default) — single-select, выбор сразу закрывает picker
 *  - maxItems>1 — multi-select, item тогглится, picker закрывается явно
 */

export type MediaPickItem = {
  id: string;
  name: string;
  description?: string | null;
  /** URL превью; для motions — видео, для остальных — картинка. */
  previewUrl?: string | null;
  /** Доп. подпись справа от имени (например язык/категория). */
  meta?: string | null;
};

export type MediaPickerProps = {
  title: string;
  subtitle?: string;
  items: readonly MediaPickItem[];
  isLoading: boolean;
  /** Выбранные ID — массив для multi, длиной 0/1 для single. */
  selectedIds: readonly string[];
  /** Если задано >1 — multi-select up to N. По умолчанию 1 (single). */
  maxItems?: number;
  /** "image" — рендерить превью как <img>; "video" — <video> с loop+muted. */
  previewKind: "image" | "video";
  onChange: (selectedIds: string[]) => void;
  onClose: () => void;
};

export function MediaPicker({
  title,
  subtitle,
  items,
  isLoading,
  selectedIds,
  maxItems = 1,
  previewKind,
  onChange,
  onClose,
}: MediaPickerProps) {
  const [search, setSearch] = useState("");
  const isMulti = maxItems > 1;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        (it.description ?? "").toLowerCase().includes(q) ||
        (it.meta ?? "").toLowerCase().includes(q),
    );
  }, [items, search]);

  function toggle(item: MediaPickItem) {
    if (!isMulti) {
      onChange([item.id]);
      onClose();
      return;
    }
    const isOn = selectedIds.includes(item.id);
    if (isOn) {
      onChange(selectedIds.filter((id) => id !== item.id));
    } else if (selectedIds.length < maxItems) {
      onChange([...selectedIds, item.id]);
    }
  }

  return (
    <div className="voice-picker media-picker">
      <div className="voice-picker-head">
        <div>
          <div className="voice-picker-title">{title}</div>
          {subtitle && <div className="voice-picker-sub">{subtitle}</div>}
          {isMulti && (
            <div className="voice-picker-sub">
              Выбрано {selectedIds.length}/{maxItems}
            </div>
          )}
        </div>
        <button className="voice-picker-close" onClick={onClose} aria-label="Закрыть">
          <X size={16} />
        </button>
      </div>

      <div className="voice-picker-search">
        <Search size={14} />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск" />
      </div>

      <div className="media-picker-grid">
        {isLoading && <div className="voice-picker-empty">Загрузка…</div>}
        {!isLoading && filtered.length === 0 && (
          <div className="voice-picker-empty">{search ? "Ничего не найдено" : "Пусто"}</div>
        )}
        {filtered.map((it) => {
          const isSelected = selectedIds.includes(it.id);
          return (
            <button
              key={it.id}
              className={clsx("media-pick-tile", isSelected && "is-selected")}
              onClick={() => toggle(it)}
              type="button"
            >
              <div className="media-pick-thumb">
                {it.previewUrl ? (
                  previewKind === "video" ? (
                    <video
                      src={it.previewUrl}
                      muted
                      loop
                      playsInline
                      preload="metadata"
                      onMouseEnter={(e) => {
                        // Авто-плей на hover: легче, чем autoPlay сразу всех видео.
                        const v = e.currentTarget;
                        v.play().catch(() => {});
                      }}
                      onMouseLeave={(e) => {
                        const v = e.currentTarget;
                        v.pause();
                        v.currentTime = 0;
                      }}
                    />
                  ) : (
                    <img src={it.previewUrl} alt={it.name} loading="lazy" />
                  )
                ) : (
                  <div className="media-pick-thumb-empty">—</div>
                )}
                {isSelected && (
                  <div className="media-pick-check">
                    <Check size={14} />
                  </div>
                )}
              </div>
              <div className="media-pick-name" title={it.name}>
                {it.name}
              </div>
              {(it.meta || it.description) && (
                <div className="media-pick-meta">{it.meta ?? it.description}</div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
