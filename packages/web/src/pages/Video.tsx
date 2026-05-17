import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { GenerateScene } from "@/components/generate/GenerateScene";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";

export default function Video() {
  const { t } = useTranslation();
  const allModels = useModelsStore((s) => s.models);
  const models = useMemo(() => modelsForCapability(allModels, "video"), [allModels]);

  return (
    <GenerateScene
      title={t("generate.videoTitle")}
      subtitle={t("generate.videoSubtitle")}
      promptPlaceholder={t("generate.videoPromptPlaceholder")}
      models={models}
    />
  );
}
