import { Play } from "lucide-react";
import { GeneratePanel } from "@/components/generate/GeneratePanel";

const MODELS = [
  { id: "runway", name: "Runway Gen-4" },
  { id: "heygen", name: "HeyGen" },
  { id: "kling-1.6", name: "Kling 1.6" },
  { id: "veo-3", name: "Veo 3" },
  { id: "sora-2", name: "Sora 2" },
] as const;

const DIMENSIONS = [
  {
    key: "aspect",
    label: "Aspect ratio",
    options: ["16:9", "9:16", "1:1", "4:5"],
    defaultValue: "16:9",
  },
  {
    key: "duration",
    label: "Duration",
    options: ["5s", "10s", "20s", "30s"],
    defaultValue: "5s",
  },
  {
    key: "quality",
    label: "Quality",
    options: ["Preview", "1080p"],
    defaultValue: "1080p",
  },
] as const;

export default function Video() {
  return (
    <GeneratePanel
      title="Video"
      subtitle="Cinematic shots, motion, avatars — pick a model and describe the scene."
      models={MODELS}
      dimensions={DIMENSIONS}
      promptPlaceholder="Cinematic dolly-in on a city skyline at golden hour, anamorphic flare…"
      previewIcon={<Play size={28} />}
      previewTitle="Your video will appear here"
      previewText="Generation results show up in this area. UI is a stub — backend wiring comes later."
    />
  );
}
