import { useMemo } from "react";
import { GenerateScene } from "@/components/generate/GenerateScene";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";
import type { WebModelDto } from "@/api/models";

export default function Image() {
  const allModels = useModelsStore((s) => s.models);

  // Дедуп по family (Flux Pro / Flux LoRA — одна строка).
  const models = useMemo<WebModelDto[]>(() => {
    const seen = new Set<string>();
    const out: WebModelDto[] = [];
    for (const m of modelsForCapability(allModels, "image")) {
      const key = m.familyId ?? m.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    return out;
  }, [allModels]);

  return (
    <GenerateScene
      title="Создать кадр."
      subtitle="Один промпт — все лучшие модели. Платите только за то, что реально сгенерировали."
      promptPlaceholder="Опишите сцену, которую представляете"
      models={models}
    />
  );
}
