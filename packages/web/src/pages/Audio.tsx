import { AudioWaveform } from "lucide-react";
import { GeneratePanel } from "@/components/generate/GeneratePanel";

const MODELS = [
  { id: "cartesia", name: "Cartesia Sonic" },
  { id: "elevenlabs-v3", name: "ElevenLabs v3" },
  { id: "suno-v4", name: "Suno v4" },
  { id: "whisper-l", name: "Whisper Large" },
] as const;

const DIMENSIONS = [
  {
    key: "voice",
    label: "Voice",
    options: ["Narrator (m)", "Narrator (f)", "Conversational", "Cinematic"],
    defaultValue: "Narrator (m)",
  },
  {
    key: "language",
    label: "Language",
    options: ["English", "Русский", "Español", "Deutsch"],
    defaultValue: "English",
  },
  {
    key: "format",
    label: "Format",
    options: ["mp3", "wav", "ogg"],
    defaultValue: "mp3",
  },
] as const;

export default function Audio() {
  return (
    <GeneratePanel
      title="Audio"
      subtitle="Text-to-speech, voice cloning, music — pick a model and write a script."
      models={MODELS}
      dimensions={DIMENSIONS}
      promptPlaceholder="British male narrator, warm tone — read this onboarding script…"
      previewIcon={<AudioWaveform size={28} />}
      previewTitle="Your audio will appear here"
      previewText="Generation results show up in this area. UI is a stub — backend wiring comes later."
    />
  );
}
