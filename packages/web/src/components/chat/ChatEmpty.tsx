import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import type { WebModelDto } from "@/api/models";
import { ModelAvatar } from "@/components/common/ModelAvatar";
import { modelDesc, modelDisplayName, modelRate } from "./chatHelpers";

export const ChatEmpty = memo(function ChatEmpty({
  selectedModel,
  chatModels,
  modelId,
  onSelectModel,
  starterPrompts,
  onPickPrompt,
}: {
  selectedModel: WebModelDto | undefined;
  chatModels: WebModelDto[];
  modelId: string;
  onSelectModel: (id: string) => void;
  starterPrompts: string[];
  onPickPrompt: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [modelOpen, setModelOpen] = useState(false);
  const modelPickRef = useRef<HTMLDivElement | null>(null);

  // Model-pick popover outside-click.
  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modelPickRef.current && !modelPickRef.current.contains(e.target as Node)) {
        setModelOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modelOpen]);

  return (
    <div className="chat-empty">
      {/* <div className="ce-mark"> */}
      {/*   <Sparkles size={28} /> */}
      {/* </div> */}
      <div
        ref={modelPickRef}
        className={clsx("ce-model-card", modelOpen && "is-open")}
        onClick={() => setModelOpen(!modelOpen)}
      >
        <div className="ce-mc-row">
          <ModelAvatar
            className="ce-mc-ico"
            icon={selectedModel?.webIconPath ?? null}
            name={selectedModel ? modelDisplayName(selectedModel) : "·"}
            iconSize={15}
          />
          <span className="ce-mc-name">
            {selectedModel ? modelDisplayName(selectedModel) : t("common.loading")}
          </span>
          <ChevronDown size={14} className="ce-mc-chevron" />
        </div>
        {selectedModel && modelDesc(selectedModel) && (
          <div className="ce-mc-desc">{modelDesc(selectedModel)}</div>
        )}
        {modelOpen && (
          <div className="mp-pop" onClick={(e) => e.stopPropagation()}>
            {chatModels.map((m) => (
              <button
                key={m.id}
                className={clsx("mp-row", m.id === modelId && "on")}
                onClick={() => {
                  onSelectModel(m.id);
                  setModelOpen(false);
                }}
              >
                <span className="mp-row-name">
                  <ModelAvatar
                    className="ce-mc-ico"
                    icon={m.webIconPath}
                    name={modelDisplayName(m)}
                    iconSize={15}
                  />
                  {modelDisplayName(m)}
                  {m.id === modelId && <Check size={12} />}
                </span>
                <span className="mp-row-rate mono">{modelRate(m, t)}</span>
                <span className="mp-row-desc">{modelDesc(m)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <h2>{t("chat.startNew")}</h2>
      <p>{t("chat.startNewHint")}</p>
      <div className="ce-suggest">
        {starterPrompts.map((s) => (
          <button key={s} onClick={() => onPickPrompt(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
});
