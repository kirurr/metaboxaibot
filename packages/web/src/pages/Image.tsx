import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { GenerateScene } from "@/components/generate/GenerateScene";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";
import { usePresetSetup } from "./usePresetSetup";
import NotFound from "./NotFound";

export default function Image() {
  const { t } = useTranslation();
  const allModels = useModelsStore((s) => s.models);

  // Передаём весь список секции БЕЗ дедупа: GenerateScene сама группирует по
  // familyId для дропдауна моделей и достаёт siblings (по version/variant) для
  // chip'ов в блоке настроек.
  const sectionModels = useMemo(() => modelsForCapability(allModels, "image"), [allModels]);
  console.log(sectionModels);

  const setup = usePresetSetup("image", sectionModels);

  if (setup.notFound) {
    return <NotFound />;
  }

  return (
    <GenerateScene
      title={setup.title ?? t("generate.imageTitle")}
      subtitle={setup.subtitle ?? t("generate.imageSubtitle")}
      promptPlaceholder={setup.promptPlaceholder ?? t("generate.imagePromptPlaceholder")}
      models={setup.models}
      hideModelPicker={setup.hideModelPicker}
      onReset={setup.resetPreset}
      presetSettingsByModel={setup.presetSettingsByModel}
      ambientSection="image"
    />
  );
}
