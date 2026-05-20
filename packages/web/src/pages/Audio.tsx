import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { GenerateScene } from "@/components/generate/GenerateScene";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";
import { usePresetSetup } from "./usePresetSetup";
import NotFound from "./NotFound";

export default function Audio() {
  const { t } = useTranslation();
  const allModels = useModelsStore((s) => s.models);
  const sectionModels = useMemo(() => modelsForCapability(allModels, "audio"), [allModels]);

  const setup = usePresetSetup("audio", sectionModels);

  if (setup.notFound) {
    return <NotFound />;
  }

  return (
    <GenerateScene
      title={setup.title ?? t("generate.audioTitle")}
      subtitle={setup.subtitle ?? t("generate.audioSubtitle")}
      promptPlaceholder={setup.promptPlaceholder ?? t("generate.audioPromptPlaceholder")}
      models={setup.models}
      hideModelPicker={setup.hideModelPicker}
      onReset={setup.resetPreset}
      presetSettingsByModel={setup.presetSettingsByModel}
    />
  );
}
