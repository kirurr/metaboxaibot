import { Image as ImageIcon } from "lucide-react";
import { GeneratePanel } from "@/components/generate/GeneratePanel";

const MODELS = [
  { id: "nano-banana-pro", name: "nano-banana-pro" },
  { id: "flux-pro", name: "Flux Pro" },
  { id: "flux-lora", name: "Flux LoRA" },
  { id: "ideogram-v3", name: "Ideogram v3" },
  { id: "mj-v7", name: "Midjourney v7" },
] as const;

const DIMENSIONS = [
  {
    key: "aspect",
    label: "Aspect ratio",
    options: ["1:1", "16:9", "9:16", "4:5", "3:2"],
    defaultValue: "1:1",
  },
  {
    key: "quality",
    label: "Quality",
    options: ["Draft", "Standard", "High"],
    defaultValue: "Standard",
  },
  {
    key: "count",
    label: "Variants",
    options: ["1", "2", "4"],
    defaultValue: "1",
  },
] as const;

export default function Image() {
  return (
    <GeneratePanel
      title="Image"
      subtitle="Pick a model, set the look, write the prompt."
      models={MODELS}
      dimensions={DIMENSIONS}
      promptPlaceholder="Editorial portrait, hard light, 85mm, kodak portra grain…"
      previewIcon={<ImageIcon size={28} />}
      previewTitle="Your image will appear here"
      previewText="Generation results show up in this area. UI is a stub — backend wiring comes later."
    />
  );
}
