import { useMemo } from "react";
import { AudioWaveform } from "lucide-react";
import {
  GeneratePanel,
  type GenDimension,
  type GenModel,
} from "@/components/generate/GeneratePanel";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";

// Audio-параметры не «упакованы» в каталоге так же чисто, как aspect/duration
// для image/video — голоса/языки лежат отдельно (см. /web/cartesia-voices,
// /web/elevenlabs-voices и т.п.). Пока показываем статичные опции; реальное
// подключение voice library будет следующим шагом.
const VOICES = ["Narrator (m)", "Narrator (f)", "Conversational", "Cinematic"];
const LANGUAGES = ["English", "Русский", "Español", "Deutsch"];
const FORMATS = ["mp3", "wav", "ogg"];

const DIMENSIONS: readonly GenDimension[] = [
  { key: "voice", label: "Voice", options: VOICES, defaultValue: VOICES[0] },
  { key: "language", label: "Language", options: LANGUAGES, defaultValue: LANGUAGES[0] },
  { key: "format", label: "Format", options: FORMATS, defaultValue: FORMATS[0] },
];

export default function Audio() {
  const allModels = useModelsStore((s) => s.models);

  const models = useMemo<GenModel[]>(() => {
    const seen = new Set<string>();
    const out: GenModel[] = [];
    for (const m of modelsForCapability(allModels, "audio")) {
      const key = m.familyId ?? m.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: m.id,
        name: m.familyName ?? m.name,
        description: m.descriptionOverride ?? m.description,
      });
    }
    return out;
  }, [allModels]);

  return (
    <GeneratePanel
      title="Audio"
      subtitle="Text-to-speech, voice cloning, music — pick a model and write a script."
      models={models}
      dimensions={DIMENSIONS}
      promptPlaceholder="British male narrator, warm tone — read this onboarding script…"
      previewIcon={<AudioWaveform size={28} />}
      previewTitle="Your audio will appear here"
      previewText="Generation results show up in this area. UI is a stub — backend wiring comes later."
    />
  );
}
