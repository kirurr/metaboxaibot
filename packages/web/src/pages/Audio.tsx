import { useMemo } from "react";
import { GenerateScene } from "@/components/generate/GenerateScene";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";

export default function Audio() {
  const allModels = useModelsStore((s) => s.models);
  const models = useMemo(() => modelsForCapability(allModels, "audio"), [allModels]);

  return (
    <GenerateScene
      title="Создать аудио."
      subtitle="TTS, клонирование голоса, музыка — выберите модель и опишите сцену."
      promptPlaceholder="British male narrator, warm tone — read this onboarding script…"
      models={models}
    />
  );
}
