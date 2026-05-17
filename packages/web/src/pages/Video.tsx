import { useMemo } from "react";
import { GenerateScene } from "@/components/generate/GenerateScene";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";

export default function Video() {
  const allModels = useModelsStore((s) => s.models);
  const models = useMemo(() => modelsForCapability(allModels, "video"), [allModels]);

  return (
    <GenerateScene
      title="Создать видео."
      subtitle="Один промпт — все лучшие модели. Платите только за то, что реально сгенерировали."
      promptPlaceholder="Опишите сцену для генерации видео"
      models={models}
    />
  );
}
