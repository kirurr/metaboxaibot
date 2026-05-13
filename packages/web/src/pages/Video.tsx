import { useMemo } from "react";
import { Play } from "lucide-react";
import {
  GeneratePanel,
  type GenDimension,
  type GenModel,
} from "@/components/generate/GeneratePanel";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";

const FALLBACK_ASPECTS = ["16:9", "9:16", "1:1", "4:5"];
const FALLBACK_DURATIONS = [5, 10, 20, 30];

export default function Video() {
  const allModels = useModelsStore((s) => s.models);

  const models = useMemo<GenModel[]>(() => {
    const seen = new Set<string>();
    const out: GenModel[] = [];
    for (const m of modelsForCapability(allModels, "video")) {
      const key = m.familyId ?? m.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: m.id,
        name: m.familyName ?? m.name,
        description: m.descriptionOverride ?? m.description,
      });
    }
    return out;
  }, [allModels]);

  // Aspect ratios + durations берём из выбранной модели если есть; durationRange
  // (continuous slider) пока деградируем в дискретные preset'ы — slider добавим
  // отдельной итерацией, когда backend будет принимать значение.
  const dimensions = useMemo(
    () =>
      (selectedId: string): readonly GenDimension[] => {
        const m = allModels.find((x) => x.id === selectedId);
        const aspectOptions =
          m?.supportedAspectRatios && m.supportedAspectRatios.length > 0
            ? m.supportedAspectRatios
            : FALLBACK_ASPECTS;
        const durations: number[] = m?.supportedDurations?.length
          ? m.supportedDurations
          : m?.durationRange
            ? // Преобразуем диапазон в 4 равно отстоящих presets, чтобы дать юзеру
              // конкретный выбор без полноценного slider'а.
              evenlySpaced(m.durationRange.min, m.durationRange.max, 4)
            : FALLBACK_DURATIONS;
        return [
          {
            key: "aspect",
            label: "Aspect ratio",
            options: aspectOptions,
            defaultValue: aspectOptions[0],
          },
          {
            key: "duration",
            label: "Duration",
            options: durations.map((s) => `${s}s`),
            defaultValue: `${durations[0]}s`,
          },
          {
            key: "quality",
            label: "Quality",
            options: ["Preview", "1080p"],
            defaultValue: "1080p",
          },
        ];
      },
    [allModels],
  );

  return (
    <GeneratePanel
      title="Video"
      subtitle="Cinematic shots, motion, avatars — pick a model and describe the scene."
      models={models}
      dimensions={dimensions}
      promptPlaceholder="Cinematic dolly-in on a city skyline at golden hour, anamorphic flare…"
      previewIcon={<Play size={28} />}
      previewTitle="Your video will appear here"
      previewText="Generation results show up in this area. UI is a stub — backend wiring comes later."
    />
  );
}

function evenlySpaced(min: number, max: number, count: number): number[] {
  if (count <= 1 || max <= min) return [min];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(min + step * i));
}
