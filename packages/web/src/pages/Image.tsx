import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { GenerateScene } from "@/components/generate/GenerateScene";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";

export default function Image() {
  const { t } = useTranslation();
  const allModels = useModelsStore((s) => s.models);

  // Передаём весь список секции БЕЗ дедупа: GenerateScene сама группирует по
  // familyId для дропдауна моделей и достаёт siblings (по version/variant) для
  // chip'ов в блоке настроек.
  const models = useMemo(() => modelsForCapability(allModels, "image"), [allModels]);

  return (
    <GenerateScene
      title={t("generate.imageTitle")}
      subtitle={t("generate.imageSubtitle")}
      promptPlaceholder={t("generate.imagePromptPlaceholder")}
      models={models}
    />
  );
}
