import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  AudioWaveform,
  Code2,
  Image as ImageIcon,
  MessageSquare,
  Play,
  User as UserIcon,
} from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { ShaderHero } from "@/components/home/ShaderHero";
import { TiltedFeatured, type TiltedItem } from "@/components/home/TiltedFeatured";

const HOME_TOOLS = [
  {
    id: "chat",
    name: "Chat",
    desc: "Reasoning, writing, code. The everyday model.",
    tag: "Sonnet 4.5",
    icon: <MessageSquare size={22} />,
    route: "/chat",
  },
  {
    id: "image",
    name: "Image",
    desc: "Photoreal, illustration, product shots.",
    tag: "nano-banana-pro",
    icon: <ImageIcon size={22} />,
    route: "/image",
  },
  {
    id: "video",
    name: "Video",
    desc: "Cinematic shots, motion, avatars.",
    tag: "heygen · runway",
    icon: <Play size={22} />,
    route: "/video",
  },
  {
    id: "voice",
    name: "Voice",
    desc: "Text-to-speech, dubbing, narration.",
    tag: "cartesia",
    icon: <AudioWaveform size={22} />,
    route: "/audio",
  },
  {
    id: "avatar",
    name: "Avatar",
    desc: "Train a likeness once, generate forever.",
    tag: "flux-lora",
    icon: <UserIcon size={22} />,
    route: "/image",
  },
  {
    id: "code",
    name: "Code",
    desc: "Refactor, debug, scaffold whole files.",
    tag: "GPT-5",
    icon: <Code2 size={22} />,
    route: "/chat",
  },
];

// Превью-картинки c Unsplash — те же, что в `aibox_template/ai-box.html`,
// чтобы повторить визуальный ряд дизайна. Загружаются напрямую с CDN.
const FEATURED_GENS: TiltedItem[] = [
  {
    kind: "Video",
    model: "heygen",
    prompt: "Founder explainer · 28s · clean studio lighting · soft B-roll cuts to product UI",
    credits: "5.4k tok",
    img: "https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?w=800&q=80",
  },
  {
    kind: "Image",
    model: "nano-banana-pro",
    prompt: "Editorial portrait, hard light, 85mm, kodak portra grain",
    credits: "1.2k tok",
    img: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=800&q=80",
  },
  {
    kind: "Image",
    model: "flux-pro",
    prompt: "Hero shot for a minimalist espresso machine on travertine",
    credits: "0.9k tok",
    img: "https://images.unsplash.com/photo-1511920170033-f8396924c348?w=800&q=80",
  },
  {
    kind: "Audio",
    model: "cartesia",
    prompt: "British male narrator, warm, neutral pace · 1m 12s",
    credits: "0.2k tok",
    img: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=800&q=80",
  },
  {
    kind: "Chat",
    model: "Sonnet 4.5",
    prompt: "Restructure my Series A pitch to lead with the wedge, not the vision",
    credits: "2.1k tok",
    img: "https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=800&q=80",
  },
  {
    kind: "Video",
    model: "runway",
    prompt: "Cinematic dolly-in on a city skyline at golden hour, anamorphic flare",
    credits: "8.0k tok",
    img: "https://images.unsplash.com/photo-1496564203457-11bb12075d90?w=800&q=80",
  },
  {
    kind: "Image",
    model: "nano-banana-pro",
    prompt: "Brutalist concrete interior, soft north light, single figure walking, 4:3 ratio",
    credits: "1.4k tok",
    img: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=800&q=80",
  },
  {
    kind: "Image",
    model: "flux-pro",
    prompt: "Product comp for matte-black headphones on raw linen with single specular highlight",
    credits: "1.1k tok",
    img: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800&q=80",
  },
];

const RECENT_GENS = [
  {
    title: "Q3 board narrative",
    model: "Sonnet 4.5",
    time: "2h ago",
    ico: <MessageSquare size={18} />,
  },
  {
    title: "Espresso machine hero shot",
    model: "nano-banana-pro",
    time: "Yesterday",
    ico: <ImageIcon size={18} />,
  },
  { title: "Founder explainer · 28s", model: "heygen", time: "Yesterday", ico: <Play size={18} /> },
  {
    title: "Onboarding voiceover",
    model: "cartesia",
    time: "Mon",
    ico: <AudioWaveform size={18} />,
  },
  { title: "Cohort retention SQL", model: "GPT-5", time: "Mon", ico: <Code2 size={18} /> },
];

/**
 * Главная страница — анимированный шейдерный hero + список инструментов,
 * подборка и недавнее. Источник дизайна: `aibox_template/ai-box.html` (PageHome).
 * Hero вытягивается под прозрачный topnav через отрицательный `margin-top`.
 */
export default function Home() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  return (
    <div className="page" style={{ paddingTop: 0 }}>
      <section className="brand-hero">
        <ShaderHero />
        <div className="brand-hero-veil" />
        <div className="brand-hero-content">
          <span className="eyebrow">
            <span className="live-dot" /> All frontier AI · One workspace
          </span>
          <h1 className="brand-hero-title">AI Box</h1>
          <p className="brand-hero-sub">
            Один сервис — все ведущие модели для текста, изображений, видео и голоса. Без подписок
            на каждый продукт, без переключения вкладок. Платите токенами по факту использования.
          </p>
          <div className="brand-hero-cta">
            <button className="btn btn-primary" onClick={() => navigate("/chat")}>
              Начать чат <ArrowRight size={16} />
            </button>
            <button className="btn btn-ghost" onClick={() => navigate("/plans")}>
              Посмотреть тарифы
            </button>
          </div>
        </div>
      </section>

      <div className="home" style={{ paddingTop: isMobile ? 24 : 40 }}>
        <section className="rise d1">
          <div className="home-sec-head">
            <div>
              <h2>Jump into a tool.</h2>
              <p>Each one is one click away.</p>
            </div>
          </div>
          <div className="tools-grid">
            {HOME_TOOLS.map((t) => (
              <button key={t.id} className="tool-tile" onClick={() => navigate(t.route)}>
                <span className="ti-glow" />
                <div className="ti-ico">{t.icon}</div>
                <div className="ti-name">{t.name}</div>
                <div className="ti-desc">{t.desc}</div>
                <div className="ti-foot">
                  <span className="mono" style={{ fontSize: 11 }}>
                    {t.tag}
                  </span>
                  <span className="arr">
                    Open <ArrowRight size={13} />
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="rise d2">
          <div className="home-sec-head">
            <div>
              <h2>Featured today.</h2>
              <p>Curated generations — tap any to open the tool with this prompt.</p>
            </div>
            <button className="see-all" onClick={() => navigate("/history")}>
              Open gallery <ArrowRight size={14} />
            </button>
          </div>
          <TiltedFeatured
            items={FEATURED_GENS}
            arrow={<ArrowRight size={12} />}
            onTileClick={(g) => {
              const k = g.kind.toLowerCase();
              if (k === "image") navigate("/image");
              else if (k === "video") navigate("/video");
              else if (k === "audio") navigate("/audio");
              else navigate("/chat");
            }}
          />
        </section>

        <section className="rise d3">
          <div className="home-sec-head">
            <div>
              <h2>Pick up where you left off.</h2>
              <p>Your last five sessions, ready to continue.</p>
            </div>
            <button className="see-all" onClick={() => navigate("/history")}>
              All history <ArrowRight size={14} />
            </button>
          </div>
          <div className="recent-row">
            {RECENT_GENS.map((r, i) => (
              <button key={i} className="recent-card" onClick={() => navigate("/chat")}>
                <div className="thumb">{r.ico}</div>
                <div className="rc-body">
                  <div className="rc-title">{r.title}</div>
                  <div className="rc-meta">
                    <span className="rc-model">{r.model}</span>
                    <span className="dot" />
                    <span>{r.time}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
