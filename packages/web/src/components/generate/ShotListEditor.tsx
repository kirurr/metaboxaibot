import { Minus, Plus, Trash2 } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import {
  MULTISHOT_MAX_SHOTS,
  MULTISHOT_PROMPT_MAX_LENGTH,
  MULTISHOT_SHOT_DURATION_MAX,
  MULTISHOT_SHOT_DURATION_MIN,
  MULTISHOT_TOTAL_DURATION_MAX,
  MULTISHOT_TOTAL_DURATION_MIN,
  sumShotDuration,
  type ShotEntry,
} from "@/utils/multishot";

const DEFAULT_SHOT_DURATION = 5;

/**
 * Inline-редактор мультишота (Kling): список блоков «промпт + длительность»,
 * кнопка «+» добавляет шот (до 5). Значение — `Array<{prompt,duration}>` —
 * живёт в `settingValues.shots` и едет на бэк generic-каналом settings.
 * В этом режиме одиночный промпт и слайдер общей длительности скрыты.
 */
export function ShotListEditor({
  shots,
  onChange,
}: {
  shots: ShotEntry[];
  onChange: (next: ShotEntry[]) => void;
}) {
  const { t } = useTranslation();

  // Гарантируем хотя бы один шот для редактирования (пустой список бессмыслен).
  const list = shots.length > 0 ? shots : [{ prompt: "", duration: DEFAULT_SHOT_DURATION }];
  const total = sumShotDuration(list);
  const totalInvalid = total < MULTISHOT_TOTAL_DURATION_MIN || total > MULTISHOT_TOTAL_DURATION_MAX;
  const canAdd = list.length < MULTISHOT_MAX_SHOTS;

  function patchShot(i: number, patch: Partial<ShotEntry>) {
    onChange(list.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function setDuration(i: number, value: number) {
    const clamped = Math.min(
      MULTISHOT_SHOT_DURATION_MAX,
      Math.max(MULTISHOT_SHOT_DURATION_MIN, value),
    );
    patchShot(i, { duration: clamped });
  }
  function addShot() {
    if (canAdd) onChange([...list, { prompt: "", duration: DEFAULT_SHOT_DURATION }]);
  }
  function removeShot(i: number) {
    onChange(list.filter((_, idx) => idx !== i));
  }

  return (
    <div className="gen-shotlist">
      {list.map((shot, i) => (
        <div className="gen-shot" key={i}>
          <div className="gen-shot-head">
            <span className="gen-shot-title">{t("generate.multishot.shotN", { n: i + 1 })}</span>
            {list.length > 1 && (
              <button
                type="button"
                className="gen-shot-remove"
                onClick={() => removeShot(i)}
                title={t("generate.multishot.removeShot")}
                aria-label={t("generate.multishot.removeShot")}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
          <textarea
            className="gen-prompt gen-shot-prompt"
            placeholder={t("generate.multishot.shotPlaceholder")}
            value={shot.prompt}
            maxLength={MULTISHOT_PROMPT_MAX_LENGTH}
            onChange={(e) => patchShot(i, { prompt: e.target.value })}
          />
          <div className="gen-shot-dur">
            <span className="gen-shot-dur-label">{t("generate.multishot.duration")}</span>
            <div className="gen-stepper">
              <button
                type="button"
                className="gen-stepper-btn"
                onClick={() => setDuration(i, shot.duration - 1)}
                disabled={shot.duration <= MULTISHOT_SHOT_DURATION_MIN}
                aria-label={t("generate.multishot.durationMinus")}
              >
                <Minus size={14} />
              </button>
              <span className="gen-stepper-val">
                {t("generate.multishot.seconds", { value: shot.duration })}
              </span>
              <button
                type="button"
                className="gen-stepper-btn"
                onClick={() => setDuration(i, shot.duration + 1)}
                disabled={shot.duration >= MULTISHOT_SHOT_DURATION_MAX}
                aria-label={t("generate.multishot.durationPlus")}
              >
                <Plus size={14} />
              </button>
            </div>
          </div>
        </div>
      ))}

      <div className="gen-shotlist-footer">
        <button
          type="button"
          className="gen-shot-add"
          onClick={addShot}
          disabled={!canAdd}
          title={
            canAdd ? undefined : t("generate.multishot.maxShotsHint", { max: MULTISHOT_MAX_SHOTS })
          }
        >
          <Plus size={16} />
          <span>{t("generate.multishot.addShot")}</span>
        </button>
        <span className={clsx("gen-shot-total", totalInvalid && "is-invalid")}>
          {t("generate.multishot.total", {
            total,
            min: MULTISHOT_TOTAL_DURATION_MIN,
            max: MULTISHOT_TOTAL_DURATION_MAX,
          })}
        </span>
      </div>
    </div>
  );
}
