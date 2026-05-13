import { useMemo, useState } from "react";
import { GenerateScene, type SceneChip } from "@/components/generate/GenerateScene";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";

// Палитра градиентов для дрифтящей фоновой сетки — лёгкие тёмные тона, чтобы
// hero и dock читались поверх. Порт из `aibox_template/ai-box.html`.
const BG_TILES = [
  "linear-gradient(135deg,#3a4a6b 0%,#0d0d15 100%)",
  "radial-gradient(circle at 30% 40%,#a86b3a 0%,#0a0a10 70%)",
  "linear-gradient(160deg,#2d1b3d 0%,#0a1428 100%)",
  "radial-gradient(circle at 70% 30%,#6b8caf 0%,#0d1218 75%)",
  "linear-gradient(135deg,#8a3a5a 0%,#1a0a14 100%)",
  "radial-gradient(circle at 40% 60%,#3a8a6b 0%,#0a1a14 70%)",
  "linear-gradient(135deg,#5a4a8a 0%,#0f0a1f 100%)",
  "radial-gradient(circle at 60% 50%,#c4a76b 0%,#1a1408 75%)",
  "linear-gradient(180deg,#1a3a5a 0%,#08101a 100%)",
  "radial-gradient(circle at 50% 30%,#a44a3a 0%,#1a0a08 70%)",
  "linear-gradient(135deg,#3a5a8a 0%,#0a1428 100%)",
  "radial-gradient(circle at 30% 70%,#6b3a8a 0%,#140a1f 75%)",
];

const HERO_IMAGES = [
  "https://images.unsplash.com/photo-1518837695005-2083093ee35b?w=600&q=70",
  "https://images.unsplash.com/photo-1497436072909-60f360e1d4b1?w=600&q=70",
  "https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=600&q=70",
  "https://images.unsplash.com/photo-1418065460487-3e41a6c84dc5?w=600&q=70",
  "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?w=600&q=70",
  "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=600&q=70",
  "https://images.unsplash.com/photo-1447752875215-b2761acb3c5d?w=600&q=70",
];

const FALLBACK_ASPECTS = [
  "Auto",
  "1:1",
  "3:4",
  "4:3",
  "2:3",
  "3:2",
  "9:16",
  "16:9",
  "5:4",
  "4:5",
  "21:9",
];

const QUALITY_OPTS = [
  { value: "1K", label: "1K", desc: "Быстро, эскиз" },
  { value: "2K", label: "2K", desc: "Баланс ×2" },
  { value: "4K", label: "4K", desc: "Печатный ×4" },
] as const;

export default function Image() {
  const allModels = useModelsStore((s) => s.models);
  const [count, setCount] = useState(2);

  // Дедуп по family (Flux Pro / Flux LoRA — одна строка).
  const models = useMemo(() => {
    const seen = new Set<string>();
    const out = [];
    for (const m of modelsForCapability(allModels, "image")) {
      const key = m.familyId ?? m.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    return out;
  }, [allModels]);

  // Aspect ratios — динамические. Перевычисляются при смене модели, но т.к. модель
  // живёт внутри GenerateScene, мы используем общий fallback (все модели картинок
  // в каталоге поддерживают примерно одинаковый набор).
  const chips = useMemo<SceneChip[]>(
    () => [
      {
        type: "aspect",
        options: FALLBACK_ASPECTS,
        defaultValue: "3:4",
      },
      {
        type: "list",
        key: "quality",
        popTitle: "Качество",
        options: QUALITY_OPTS,
        defaultValue: "2K",
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
    [],
  );

  return (
    <GenerateScene
      eyebrow={`AI Image · ${models.length || "—"} моделей`}
      title="Создать кадр."
      subtitle="Один промпт — все лучшие модели. Платите только за то, что реально сгенерировали."
      promptPlaceholder="Опишите сцену, которую представляете"
      models={models}
      chips={chips}
      count={{ value: count, max: 4, onChange: setCount }}
      bgTiles={BG_TILES}
      heroImages={HERO_IMAGES}
    />
  );
}
