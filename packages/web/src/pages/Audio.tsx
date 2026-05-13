import { useMemo } from "react";
import { GenerateScene } from "@/components/generate/GenerateScene";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";
import type { WebModelDto } from "@/api/models";

export default function Audio() {
  const allModels = useModelsStore((s) => s.models);

  const models = useMemo<WebModelDto[]>(() => {
    const seen = new Set<string>();
    const out: WebModelDto[] = [];
    for (const m of modelsForCapability(allModels, "audio")) {
      const key = m.familyId ?? m.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    return out;
  }, [allModels]);

  return (
    <GenerateScene
      title="Создать аудио."
      subtitle="TTS, клонирование голоса, музыка — выберите модель и опишите сцену."
      promptPlaceholder="British male narrator, warm tone — read this onboarding script…"
      models={models}
    />
  );
}
