import { useMemo } from "react";
import { Image as ImageIcon } from "lucide-react";
import {
  GeneratePanel,
  type GenDimension,
  type GenModel,
} from "@/components/generate/GeneratePanel";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";

const FALLBACK_ASPECTS = ["1:1", "16:9", "9:16", "4:5", "3:2"];

export default function Image() {
  const allModels = useModelsStore((s) => s.models);

  // Дедуп по семье (Flux Pro / Flux LoRA — одно семейство, не два пункта в селекте).
  const models = useMemo<GenModel[]>(() => {
    const seen = new Set<string>();
    const out: GenModel[] = [];
    for (const m of modelsForCapability(allModels, "image")) {
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

  // Aspect ratios — динамические: если у выбранной модели supportedAspectRatios
  // не пустой, берём её; иначе fallback'аем на общий набор.
  const dimensions = useMemo(
    () =>
      (selectedId: string): readonly GenDimension[] => {
        const m = allModels.find((x) => x.id === selectedId);
        const aspectOptions =
          m?.supportedAspectRatios && m.supportedAspectRatios.length > 0
            ? m.supportedAspectRatios
            : FALLBACK_ASPECTS;
        return [
          {
            key: "aspect",
            label: "Aspect ratio",
            options: aspectOptions,
            defaultValue: aspectOptions[0],
          },
          {
            key: "quality",
            label: "Quality",
            options: ["Draft", "Standard", "High"],
            defaultValue: "Standard",
          },
          {
            key: "count",
            label: "Variants",
            options: ["1", "2", "4"],
            defaultValue: "1",
          },
        ];
      },
    [allModels],
  );

  return (
    <GeneratePanel
      title="Image"
      subtitle="Pick a model, set the look, write the prompt."
      models={models}
      dimensions={dimensions}
      promptPlaceholder="Editorial portrait, hard light, 85mm, kodak portra grain…"
      previewIcon={<ImageIcon size={28} />}
      previewTitle="Your image will appear here"
      previewText="Generation results show up in this area. UI is a stub — backend wiring comes later."
    />
  );
}
