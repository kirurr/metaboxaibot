import { useMemo, useState } from "react";
import { GenerateScene, type SceneChip } from "@/components/generate/GenerateScene";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";

const BG_TILES = [
  "linear-gradient(135deg,#1a3a5a 0%,#08101a 100%)",
  "radial-gradient(circle at 30% 40%,#3a4a6b 0%,#0a0a10 75%)",
  "linear-gradient(160deg,#5a3a8a 0%,#0f0a1f 100%)",
  "radial-gradient(circle at 70% 30%,#6b8caf 0%,#0d1218 75%)",
  "linear-gradient(135deg,#2d1b3d 0%,#0a1428 100%)",
  "radial-gradient(circle at 40% 60%,#3a8a8a 0%,#0a1a1a 70%)",
  "linear-gradient(135deg,#8a3a5a 0%,#1a0a14 100%)",
  "radial-gradient(circle at 60% 50%,#a86b3a 0%,#1a1408 75%)",
  "linear-gradient(180deg,#1a3a5a 0%,#08101a 100%)",
  "radial-gradient(circle at 50% 30%,#a44a8a 0%,#1a0a18 70%)",
  "linear-gradient(135deg,#3a5a8a 0%,#0a1428 100%)",
  "radial-gradient(circle at 30% 70%,#6b3a8a 0%,#140a1f 75%)",
];

const HERO_IMAGES = [
  "https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?w=600&q=70",
  "https://images.unsplash.com/photo-1496564203457-11bb12075d90?w=600&q=70",
  "https://images.unsplash.com/photo-1518837695005-2083093ee35b?w=600&q=70",
  "https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=600&q=70",
  "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?w=600&q=70",
  "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=600&q=70",
];

const FALLBACK_ASPECTS = ["16:9", "9:16", "1:1", "4:5", "3:4"];
const FALLBACK_DURATIONS = [5, 10, 20, 30];

const QUALITY_OPTS = [
  { value: "preview", label: "Preview", desc: "720p, draft" },
  { value: "1080p", label: "1080p", desc: "HD" },
] as const;

function durationsToOpts(durations: number[]) {
  return durations.map((d) => ({ value: `${d}s`, label: `${d}s` }));
}

export default function Video() {
  const allModels = useModelsStore((s) => s.models);
  const [count, setCount] = useState(1);

  const models = useMemo(() => {
    const seen = new Set<string>();
    const out = [];
    for (const m of modelsForCapability(allModels, "video")) {
      const key = m.familyId ?? m.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    return out;
  }, [allModels]);

  // Унифицированный список длительностей — берём пересечение пресетов всех
  // моделей, чтобы чип никогда не предлагал того, что вообще не поддерживается.
  // Если объединение пустое — fallback.
  const durations = useMemo(() => {
    const seen = new Set<number>();
    for (const m of models) {
      for (const d of m.supportedDurations ?? []) seen.add(d);
    }
    return seen.size > 0 ? Array.from(seen).sort((a, b) => a - b) : FALLBACK_DURATIONS;
  }, [models]);

  const chips = useMemo<SceneChip[]>(
    () => [
      {
        type: "aspect",
        options: FALLBACK_ASPECTS,
        defaultValue: "16:9",
      },
      {
        type: "list",
        key: "duration",
        popTitle: "Длительность",
        options: durationsToOpts(durations),
        defaultValue: `${durations[0]}s`,
        icon: (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <polyline points="12 7 12 12 15 14" />
          </svg>
        ),
      },
      {
        type: "list",
        key: "quality",
        popTitle: "Качество",
        options: QUALITY_OPTS,
        defaultValue: "1080p",
        icon: (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" />
          </svg>
        ),
      },
    ],
    [durations],
  );

  return (
    <GenerateScene
      eyebrow={`AI Video · ${models.length || "—"} моделей`}
      title="Создать видео."
      subtitle="Один промпт — все лучшие модели. Платите только за то, что реально сгенерировали."
      promptPlaceholder="Опишите сцену для генерации видео"
      models={models}
      chips={chips}
      count={{ value: count, max: 4, onChange: setCount }}
      bgTiles={BG_TILES}
      heroImages={HERO_IMAGES}
    />
  );
}
