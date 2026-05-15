import { useMemo, useState } from "react";
import { Check, Loader2, MoreHorizontal, Pencil, Plus, Search, Trash2, X } from "lucide-react";
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
 *
 * Для пользовательских аватаров (HeyGen, Soul) проп `userItems` рисует отдельную
 * секцию «Мои аватары» поверх каталога с кнопками rename/delete и плиткой
 * «Создать новый», которая открывает upload-модалку (`onCreate`).
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

/** Пользовательский аватар — расширение `MediaPickItem` со status + actions. */
export type MediaUserItem = MediaPickItem & {
  /** "creating" блокирует выбор (показываем спиннер); "failed"/"orphaned" — серым. */
  status: "creating" | "ready" | "failed" | "orphaned" | string;
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
  /** Опциональная верхняя секция пользовательских аватаров. */
  userItems?: readonly MediaUserItem[];
  userItemsLoading?: boolean;
  userItemsLabel?: string;
  /** Опциональная пустая строка для catalog-section (если catalog нерелевантен — например, Soul). */
  hideCatalog?: boolean;
  onCreate?: () => void;
  onRename?: (id: string, currentName: string) => void;
  onDelete?: (id: string) => void;
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
  userItems,
  userItemsLoading,
  userItemsLabel = "Мои аватары",
  hideCatalog = false,
  onCreate,
  onRename,
  onDelete,
}: MediaPickerProps) {
  const [search, setSearch] = useState("");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const isMulti = maxItems > 1;
  const showUserSection = !!userItems || !!onCreate;

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

  const filteredUserItems = useMemo(() => {
    if (!userItems) return [];
    const q = search.trim().toLowerCase();
    if (!q) return userItems;
    return userItems.filter((it) => it.name.toLowerCase().includes(q));
  }, [userItems, search]);

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

  function renderTile(it: MediaPickItem, opts?: { disabled?: boolean }) {
    const isSelected = selectedIds.includes(it.id);
    return (
      <button
        key={it.id}
        className={clsx(
          "media-pick-tile",
          isSelected && "is-selected",
          opts?.disabled && "is-disabled",
        )}
        onClick={() => !opts?.disabled && toggle(it)}
        type="button"
        disabled={opts?.disabled}
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
  }

  function renderUserTile(it: MediaUserItem) {
    const isReady = it.status === "ready";
    const isSelected = selectedIds.includes(it.id);
    const statusLabel =
      it.status === "creating"
        ? "Создаётся…"
        : it.status === "failed"
          ? "Не удалось"
          : it.status === "orphaned"
            ? "Недоступен"
            : null;
    return (
      <div
        key={it.id}
        className={clsx(
          "media-pick-tile media-pick-user-tile",
          isSelected && "is-selected",
          !isReady && "is-disabled",
        )}
      >
        <button
          className="media-pick-thumb-btn"
          onClick={() => isReady && toggle(it)}
          type="button"
          disabled={!isReady}
        >
          <div className="media-pick-thumb">
            {it.previewUrl ? (
              <img src={it.previewUrl} alt={it.name} loading="lazy" />
            ) : (
              <div className="media-pick-thumb-empty">—</div>
            )}
            {!isReady && (
              <div className="media-pick-overlay">
                {it.status === "creating" ? <Loader2 size={16} className="spin" /> : "!"}
              </div>
            )}
            {isReady && isSelected && (
              <div className="media-pick-check">
                <Check size={14} />
              </div>
            )}
          </div>
        </button>
        <div className="media-pick-user-row">
          <div className="media-pick-name" title={it.name}>
            {it.name}
          </div>
          {(onRename || onDelete) && (
            <div className="media-pick-actions">
              <button
                className="media-pick-actions-btn"
                onClick={() => setOpenMenuId(openMenuId === it.id ? null : it.id)}
                aria-label="Действия"
                type="button"
              >
                <MoreHorizontal size={14} />
              </button>
              {openMenuId === it.id && (
                <div className="media-pick-menu" onMouseLeave={() => setOpenMenuId(null)}>
                  {onRename && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenuId(null);
                        onRename(it.id, it.name);
                      }}
                    >
                      <Pencil size={12} /> Переименовать
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      className="is-danger"
                      onClick={() => {
                        setOpenMenuId(null);
                        onDelete(it.id);
                      }}
                    >
                      <Trash2 size={12} /> Удалить
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        {statusLabel && <div className="media-pick-meta">{statusLabel}</div>}
      </div>
    );
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

      {showUserSection && (
        <div className="media-picker-section">
          <div className="media-picker-section-head">
            <span>{userItemsLabel}</span>
            {onCreate && (
              <button type="button" className="media-picker-create-link" onClick={onCreate}>
                <Plus size={12} /> Создать
              </button>
            )}
          </div>
          <div className="media-picker-grid">
            {userItemsLoading && <div className="voice-picker-empty">Загрузка…</div>}
            {!userItemsLoading && filteredUserItems.length === 0 && (
              <div className="voice-picker-empty">
                {search ? "Ничего не найдено" : "Пока нет своих аватаров"}
              </div>
            )}
            {filteredUserItems.map((it) => renderUserTile(it))}
          </div>
        </div>
      )}

      {!hideCatalog && (
        <div className="media-picker-section">
          {showUserSection && <div className="media-picker-section-head">Каталог</div>}
          <div className="media-picker-grid">
            {isLoading && <div className="voice-picker-empty">Загрузка…</div>}
            {!isLoading && filtered.length === 0 && (
              <div className="voice-picker-empty">{search ? "Ничего не найдено" : "Пусто"}</div>
            )}
            {filtered.map((it) => renderTile(it))}
          </div>
        </div>
      )}
    </div>
  );
}
