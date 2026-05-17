import { useMemo } from "react";
import { GenerateScene } from "@/components/generate/GenerateScene";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";

export default function Image() {
  const allModels = useModelsStore((s) => s.models);

  // Передаём весь список секции БЕЗ дедупа: GenerateScene сама группирует по
  // familyId для дропдауна моделей и достаёт siblings (по version/variant) для
  // chip'ов в блоке настроек.
  const models = useMemo(() => modelsForCapability(allModels, "image"), [allModels]);

  return (
    <GenerateScene
      title="Создать кадр."
      subtitle="Один промпт — все лучшие модели. Платите только за то, что реально сгенерировали."
      promptPlaceholder="Опишите сцену, которую представляете"
      models={models}
    />
  );
}
