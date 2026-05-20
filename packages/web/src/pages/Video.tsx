import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { GenerateScene } from "@/components/generate/GenerateScene";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";
import { usePresetSetup } from "./usePresetSetup";
import NotFound from "./NotFound";

export default function Video() {
  const { t } = useTranslation();
  const allModels = useModelsStore((s) => s.models);
  const sectionModels = useMemo(() => modelsForCapability(allModels, "video"), [allModels]);

  const setup = usePresetSetup("video", sectionModels);

  if (setup.notFound) {
    return <NotFound />;
  }

  return (
    <GenerateScene
      title={setup.title ?? t("generate.videoTitle")}
      subtitle={setup.subtitle ?? t("generate.videoSubtitle")}
      promptPlaceholder={setup.promptPlaceholder ?? t("generate.videoPromptPlaceholder")}
      models={setup.models}
      hideModelPicker={setup.hideModelPicker}
      onReset={setup.resetPreset}
      presetSettingsByModel={setup.presetSettingsByModel}
      ambientSection="video"
    />
  );
}
