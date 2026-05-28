import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AtSign } from "lucide-react";
import clsx from "clsx";
import type { Element } from "@/api/elements";

/** Императивный хэндл: вставка меншена извне (модальный @-пикер). */
export interface MentionTextareaHandle {
  insertMention: (name: string) => void;
  focus: () => void;
}

export interface MentionTextareaProps {
  value: string;
  onChange: (next: string) => void;
  /** Включены ли @-элементы у модели (promptRefs.elements). Если нет — обычный textarea. */
  elementsFeatureOn: boolean;
  /** Кандидаты для inline-подсказок (элементы пользователя). */
  candidates: Element[];
  /** id уже активных элементов — исключаются из подсказок. */
  activeElementIds: Set<string>;
  /** Достигнут лимит элементов модели — подсказки не показываем. */
  atCap: boolean;
  /** Выбор элемента из inline-dropdown: родитель открывает попап выбора картинок. */
  onSelectElement?: (el: Element) => void;
  className?: string;
  /** Класс для относительного wrapper'а (для главного промпта — gen-prompt-wrap). */
  wrapClassName?: string;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  /** Доп. узлы внутри wrapper'а (inline-кнопки tools у главного промпта). */
  children?: ReactNode;
}

/**
 * Textarea с inline `@`-меншенами элементов: детект незакрытого `@<word>` слева
 * от курсора, выпадающий список подсказок, вставка `@имя ` с возвратом каретки,
 * авто-рост под контент. Владеет своим ref и стейтом меншена — переиспользуется
 * и главным промптом, и каждым полем шота в мультишоте.
 */
export const MentionTextarea = forwardRef<MentionTextareaHandle, MentionTextareaProps>(
  function MentionTextarea(
    {
      value,
      onChange,
      elementsFeatureOn,
      candidates,
      activeElementIds,
      atCap,
      onSelectElement,
      className,
      wrapClassName,
      placeholder,
      maxLength,
      disabled,
      children,
    },
    ref,
  ) {
    const taRef = useRef<HTMLTextAreaElement | null>(null);
    const [mentionQuery, setMentionQuery] = useState<{ query: string; start: number } | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);

    // Авто-рост под контент (в пределах CSS min/max-height). Реагирует и на ввод,
    // и на программную подстановку (restore / вставку меншена).
    useEffect(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    }, [value]);

    // Подсказки: элементы по фильтру, без уже активных, при не-лимите.
    const matches = useMemo(() => {
      if (!mentionQuery || !elementsFeatureOn || atCap) return [];
      const q = mentionQuery.query.toLowerCase();
      return candidates
        .filter((el) => !activeElementIds.has(el.id) && el.name.toLowerCase().includes(q))
        .slice(0, 6);
    }, [mentionQuery, elementsFeatureOn, atCap, candidates, activeElementIds]);

    // Детект незакрытого `@<word>` слева от курсора. Зовём и на вводе, и при
    // перемещении каретки (клик/стрелки) — иначе stale-позиция вырезала бы чужой
    // кусок текста при выборе подсказки.
    function detect(ta: HTMLTextAreaElement) {
      if (!elementsFeatureOn) {
        setMentionQuery(null);
        return;
      }
      const caret = ta.selectionStart ?? ta.value.length;
      const m = ta.value.slice(0, caret).match(/(?:^|[^\w])@(\w*)$/);
      if (m) {
        setMentionQuery({ query: m[1], start: caret - m[1].length - 1 });
        setActiveIndex(0);
      } else {
        setMentionQuery(null);
      }
    }

    // Вставляет `@name `: заменяет набранный inline-`@`-токен (если есть), иначе
    // вставляет в позицию курсора. Возвращает фокус и каретку после вставки.
    function insert(name: string) {
      const ta = taRef.current;
      const ins = `@${name} `;
      const caret = ta?.selectionStart ?? value.length;
      let next: string;
      let newCaret: number;
      if (mentionQuery) {
        const before = value.slice(0, mentionQuery.start);
        const after = value.slice(caret);
        next = before + ins + after;
        newCaret = before.length + ins.length;
      } else {
        next = value.slice(0, caret) + ins + value.slice(caret);
        newCaret = caret + ins.length;
      }
      onChange(next);
      setMentionQuery(null);
      requestAnimationFrame(() => {
        ta?.focus();
        ta?.setSelectionRange(newCaret, newCaret);
      });
    }

    useImperativeHandle(ref, () => ({
      insertMention: (name: string) => insert(name),
      focus: () => taRef.current?.focus(),
    }));

    function pick(el: Element) {
      insert(el.name);
      onSelectElement?.(el);
    }

    // Клавиатура в inline-dropdown: ↑/↓ — навигация, Enter — выбор, Esc —
    // закрытие. Активно только пока dropdown открыт; иначе клавиши идут в textarea.
    function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
      if (!mentionQuery || matches.length === 0) return;
      const len = matches.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % len);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + len) % len);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const el = matches[Math.min(activeIndex, len - 1)];
        if (el) pick(el);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
      }
    }

    return (
      <div className={wrapClassName} style={{ position: "relative" }}>
        <textarea
          ref={taRef}
          className={className}
          placeholder={placeholder}
          value={value}
          maxLength={maxLength}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value);
            detect(e.target);
          }}
          // Перемещение каретки мышью/стрелками не триггерит onChange — ловим
          // отдельно, чтобы mentionQuery не «залип» на старой позиции.
          onClick={(e) => detect(e.currentTarget)}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            // Навигационные клавиши обрабатывает onKeyDown; здесь их пропускаем,
            // иначе detect переоткрыл бы dropdown (Esc) и сбрасывал подсветку (↑/↓).
            if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key)) return;
            detect(e.currentTarget);
          }}
          onBlur={() => {
            // Закрываем dropdown после клика по подсказке (mousedown успевает
            // отработать раньше blur), иначе — при уходе фокуса.
            window.setTimeout(() => setMentionQuery(null), 150);
          }}
        />
        {children}
        {/* Inline-`@` dropdown подсказок элементов. */}
        {mentionQuery && matches.length > 0 && (
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
            {matches.map((el, i) => (
              <li key={el.id}>
                <button
                  type="button"
                  // mousedown (не click): срабатывает до blur textarea.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(el);
                  }}
                  // Синхронизируем подсветку с мышью, чтобы ↑/↓ и hover не расходились.
                  onMouseEnter={() => setActiveIndex(i)}
                  className={clsx(
                    "flex w-full items-center gap-2 rounded-[var(--radius)] px-2 py-1.5 text-left text-sm text-text",
                    i === Math.min(activeIndex, matches.length - 1)
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
    );
  },
);
