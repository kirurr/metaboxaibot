import { useState, useRef, useEffect } from "react";
import { ChevronDown, Check, Search } from "lucide-react";
import clsx from "clsx";
import type { ModelDto } from "@/api/chat";
import { ModelAvatar } from "@/components/common/ModelAvatar";

/** Имя модели для веба (familyName-бренд → webName без эмодзи). */
function selectorName(m: ModelDto): string {
  return m.familyName ?? m.webName;
}

/** Класс маленького бокса-аватара в дропдауне выбора модели. */
const AVATAR_BOX =
  "shrink-0 w-5 h-5 rounded-md flex items-center justify-center text-[11px] font-semibold bg-bg-elevated border border-border text-text-secondary";

interface Props {
  models: ModelDto[];
  currentModelId: string | null;
  onPick: (modelId: string) => void;
  disabled?: boolean;
}

export function ModelSelector({ models, currentModelId, onPick, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Фильтруем только текстовые модели (section=gpt)
  const gptModels = models.filter((m) => m.section === "gpt");
  const filtered = q
    ? gptModels.filter((m) =>
        `${selectorName(m)} ${m.provider} ${m.variantLabel ?? ""}`
          .toLowerCase()
          .includes(q.toLowerCase()),
      )
    : gptModels;

  const current = models.find((m) => m.id === currentModelId);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className={clsx(
          "inline-flex items-center gap-2 px-3 h-9 rounded-full text-sm font-medium transition-colors",
          "bg-bg-elevated border border-border hover:border-accent",
          disabled && "opacity-50 cursor-not-allowed",
        )}
      >
        {current && (
          <ModelAvatar
            className={AVATAR_BOX}
            icon={current.webIconPath}
            name={selectorName(current)}
            iconSize={13}
          />
        )}
        <span className="truncate max-w-[200px]">
          {current ? selectorName(current) : "Выберите модель"}
        </span>
        <ChevronDown size={14} className={clsx("transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          className="absolute right-0 md:right-auto md:left-0 top-full mt-2 w-80 max-h-[60vh] card shadow-lg overflow-hidden flex flex-col z-50"
          style={{ background: "var(--bg-elevated)" }}
        >
          <div className="p-2 border-b border-border">
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-hint"
              />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Поиск моделей"
                className="!pl-9 !h-9 !text-sm"
                autoFocus
              />
            </div>
          </div>
          <div className="overflow-y-auto py-1">
            {filtered.length === 0 && (
              <div className="p-4 text-center text-sm text-text-hint">Ничего не найдено</div>
            )}
            {filtered.map((m) => {
              const active = m.id === currentModelId;
              return (
                <button
                  key={m.id}
                  onClick={() => {
                    onPick(m.id);
                    setOpen(false);
                  }}
                  className={clsx(
                    "w-full text-left px-3 py-2.5 hover:bg-bg-secondary transition-colors flex items-start gap-2",
                    active && "bg-bg-secondary",
                  )}
                >
                  <ModelAvatar
                    className={clsx(AVATAR_BOX, "mt-0.5")}
                    icon={m.webIconPath}
                    name={selectorName(m)}
                    iconSize={13}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{selectorName(m)}</div>
                    <div className="text-xs text-text-hint mt-0.5 line-clamp-2">
                      {m.description}
                    </div>
                  </div>
                  {active && <Check size={16} className="text-accent shrink-0 mt-0.5" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
