import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { GenerateScene } from "@/components/generate/GenerateScene";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";

export default function Audio() {
  const { t } = useTranslation();
  const allModels = useModelsStore((s) => s.models);
  const models = useMemo(() => modelsForCapability(allModels, "audio"), [allModels]);

  return (
    <GenerateScene
      title={t("generate.audioTitle")}
      subtitle={t("generate.audioSubtitle")}
      promptPlaceholder={t("generate.audioPromptPlaceholder")}
      models={models}
    />
  );
}
