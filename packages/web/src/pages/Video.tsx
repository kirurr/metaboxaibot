import { useMemo } from "react";
import { GenerateScene } from "@/components/generate/GenerateScene";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";
import type { WebModelDto } from "@/api/models";

export default function Video() {
  const allModels = useModelsStore((s) => s.models);

  const models = useMemo<WebModelDto[]>(() => {
    const seen = new Set<string>();
    const out: WebModelDto[] = [];
    for (const m of modelsForCapability(allModels, "video")) {
      const key = m.familyId ?? m.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    return out;
  }, [allModels]);

  return (
    <GenerateScene
      title="Создать видео."
      subtitle="Один промпт — все лучшие модели. Платите только за то, что реально сгенерировали."
      promptPlaceholder="Опишите сцену для генерации видео"
      models={models}
    />
  );
}
