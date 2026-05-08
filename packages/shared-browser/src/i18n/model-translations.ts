/** Per-model UI translations (name / description). Falls back to AIModel definition strings. */
export interface ModelTranslation {
  name?: string;
  description?: string;
  descriptionOverride?: string;
}

/** Per-setting UI translations (label / description / option labels). Falls back to ModelSettingDef strings. */
export interface SettingTranslation {
  label?: string;
  description?: string;
  /** Maps option value → localized label. */
  options?: Record<string, string>;
}

export const MODEL_TRANSLATIONS_EN: Record<string, ModelTranslation> = {
  // ── GPT ─────────────────────────────────────────────────────────────────────
  "gpt-5.4-pro": {
    name: "🧠 GPT 5.4 Pro",
    description:
      "The most powerful OpenAI model. Maximum accuracy and deep reasoning. Much more expensive than GPT 5.4 — for tasks demanding flawless precision.",
  },
  "gpt-5.4": {
    name: "💬 GPT 5.4",
    description:
      "Next-gen OpenAI flagship — smarter and faster than GPT 5 Pro. Best balance of intelligence, speed and cost in the lineup.",
  },
  "gpt-5-pro": {
    name: "💡 GPT 5 Pro",
    description:
      "Previous-gen OpenAI flagship. Highest reasoning level only — for the hardest tasks. More expensive than GPT 5.4.",
  },
  "gpt-5-nano": {
    name: "✨ GPT 5 Nano",
    description:
      "Lightest and cheapest in the GPT 5 lineup — instant responses for simple tasks. No image support.",
  },
  "o4-mini": {
    name: "🔬 GPT-o4 Mini",
    description:
      "Latest OpenAI reasoning model — chain-of-thought for complex tasks. Understands images, smarter than o3 Mini.",
  },
  "o3-mini": {
    name: "🔩 GPT-o3 Mini",
    description:
      "Previous compact OpenAI reasoning model. No image support — for text-based chain-of-thought tasks.",
  },
  "claude-opus": {
    name: "🎭 Claude 4.6 Opus",
    description:
      "Latest and most intelligent Anthropic model (version 4.6). Best for complex analytical and creative tasks. Understands images.",
  },
  "claude-opus-4-5": {
    name: "🃏 Claude 4.5 Opus",
    description:
      "Previous-gen Opus (version 4.5). Deep analysis and long texts. Slightly weaker reasoning than 4.6, but proven stability.",
  },
  "claude-sonnet": {
    name: "📜 Claude 4.6 Sonnet",
    description:
      "Latest Sonnet (version 4.6) — Anthropic's best price-to-quality ratio. Faster and cheaper than Opus, excellent for code, text and analysis.",
  },
  "claude-sonnet-4-5": {
    name: "🖊️ Claude 4.5 Sonnet",
    description:
      "Previous-gen Sonnet (version 4.5). Reliable workhorse, slightly weaker than 4.6. Great for code and writing.",
  },
  "claude-haiku": {
    name: "🍃 Claude 4.5 Haiku",
    description:
      "Anthropic's fastest and cheapest model. Instant responses for simple tasks, understands images. Weaker reasoning than Sonnet and Opus.",
  },
  "gemini-3-pro": {
    name: "💎 Gemini 3 Pro",
    description:
      "Google's flagship — context up to 1M tokens and multimodality. Supports web search. Base version of 3 Pro.",
  },
  "gemini-3.1-pro": {
    name: "💍 Gemini 3.1 Pro",
    description:
      "Updated Gemini 3 Pro (version 3.1) — better instruction following and more accurate answers. Same price as 3.0. Web search.",
  },
  "gemini-2-flash": {
    name: "🌟 Gemini 2.5 Flash",
    description:
      "Fast and affordable Google model with reasoning. Great price-to-quality, ~7× cheaper than Pro. Web search.",
  },
  "gemini-2-flash-lite": {
    name: "⭐ Gemini 2.5 Flash Lite",
    description:
      "Google's lightest and cheapest model. For simple tasks at minimal cost. No image support or web search.",
  },
  "deepseek-r1": {
    name: "🔍 DeepSeek R1",
    description:
      "Reasoning model from China — strong at math and code, thinks step by step. Slower than V3, but more accurate for complex tasks.",
  },
  "deepseek-v3": {
    name: "🐋 DeepSeek V3",
    description:
      "Fast DeepSeek model for general tasks and text generation. No step-by-step reasoning — faster than R1, but less accurate for complex tasks.",
  },
  "grok-4": {
    name: "🤖 Grok 4",
    description:
      "xAI flagship — maximum reasoning quality, 256K context. More expensive than Grok 4 Fast, but more accurate for complex tasks.",
  },
  "grok-4-fast": {
    name: "🏎️ Grok 4 Fast",
    description:
      "Accelerated Grok 4 from xAI. Context up to 2M tokens, ~10× cheaper than standard Grok 4. Fast responses with reasoning.",
  },
  "perplexity-sonar-pro": {
    name: "🌐 Perplexity Sonar Pro + Internet",
    description:
      "Powerful AI search with deep answers from the internet. More expensive than Sonar, but more thorough source analysis and detailed responses.",
  },
  "perplexity-sonar-research": {
    name: "🔭 Perplexity Sonar Deep Research",
    description:
      "Autonomous researcher — analyzes dozens of sources per query. Ideal for deep research, slower than regular Sonar.",
  },
  "perplexity-sonar": {
    name: "📡 Perplexity Sonar + Internet",
    description:
      "Fast and affordable AI search with real-time internet data. Basic version — for quick questions without deep analysis.",
  },
  "qwen-3-max-thinking": {
    name: "🧮 Qwen 3 Max Thinking",
    description:
      "Alibaba's largest reasoning model. Maximum quality in the Qwen lineup — for the hardest tasks. More expensive than Qwen 3 Thinking.",
  },
  "qwen-3-thinking": {
    name: "💭 Qwen 3 Thinking",
    description:
      "Alibaba's mid-size reasoning model — cheaper than Max, but strong at code and math. Best price-to-quality in the Qwen lineup.",
  },
  // ── Audio ────────────────────────────────────────────────────────────────────
  "tts-openai": {
    name: "🔊 Speech Synthesis (OpenAI)",
    description:
      "OpenAI text-to-speech. Fast generation, natural intonation. Cheaper than ElevenLabs, but fewer voices and no cloned voice support.",
  },
  "voice-clone": {
    name: "🎤 Voice Cloning",
    description:
      "Creates your voice profile in ElevenLabs from a short audio sample. Ready voice is available in ElevenLabs TTS and video avatars.",
  },
  "tts-el": {
    name: "🔊 Speech Synthesis (ElevenLabs)",
    description:
      "ElevenLabs text-to-speech — wide voice library + your cloned voices. Higher quality and expressiveness than OpenAI TTS, but more expensive.",
  },
  suno: {
    name: "🎵 Music Generation (Suno)",
    description:
      "Generates full music tracks with vocals and arrangement. Set style, mood and song lyrics. Up to 4 minutes. Slower than ElevenLabs, but with full vocals.",
  },
  "sounds-el": {
    name: "🔔 Sound Effects (ElevenLabs)",
    description:
      "Generates original sound effects from a description. Ideal for video, games and podcasts. English prompts recommended.",
  },
  "music-el": {
    name: "🎶 Music (ElevenLabs)",
    description:
      "Generates background music, ambient and atmospheres via ElevenLabs. Instrumental only (no vocals), up to 22 seconds. Faster than Suno. English prompts recommended.",
  },
  // ── Design ───────────────────────────────────────────────────────────────────
  "nano-banana-pro": {
    name: "🍌 Nano Banana PRO",
    description:
      "Generates realistic photos and lets you edit details with words. PRO — maximum quality up to 4K, more expensive than the standard version.",
  },
  "nano-banana-2": {
    name: "🍌 Nano Banana 2",
    description:
      "Generates and edits realistic photos from text commands. Standard — cheaper than PRO, supports more references and an extended set of aspect ratios.",
  },
  "nano-banana-1": {
    name: "🍌 Nano Banana",
    description:
      "Base version: generates and edits photos from text. Cheaper than PRO and v2, but without resolution choice and advanced settings.",
  },
  midjourney: {
    name: "🎨 MidJourney v7",
    description:
      "Creates the most beautiful and stylish images. Best choice for art, illustrations and striking visuals.",
  },
  "gpt-image-2": {
    name: "🖼️ GPT Image 2",
    description:
      "Latest GPT Image. Sharper text rendering and tighter prompt adherence than 1.5, with lower cost on larger sizes.",
  },
  "gpt-image-1.5": {
    name: "🖼️ GPT Image 1.5",
    description:
      "Best at understanding complex text prompts. Accurately renders what you describe, including text in images.",
  },
  "stable-diffusion": {
    name: "🌊 Stable Diffusion 3.5",
    description:
      "Generates detailed images in any style: from photorealism to anime and fantasy. English prompts only!",
  },
  "dall-e-3": {
    name: "🎯 DALL-E 3 Turbo",
    description:
      "Simple OpenAI generator. Understands prompts in any language — great for quick ideas.",
  },
  "ideogram-quality": {
    name: "✍️ Ideogram v3.0 Quality",
    description:
      "Best at rendering readable text in images. Ideal for logos, posters and ads. Quality — maximum detail and precision, slowest and most expensive option.",
  },
  "ideogram-balanced": {
    name: "✍️ Ideogram v3.0 Balanced",
    description:
      "Best at rendering readable text in images. Ideal for logos, posters and ads. Balanced — optimal quality-to-speed ratio, mid-range price.",
  },
  "ideogram-turbo": {
    name: "✍️ Ideogram v3.0 Turbo",
    description:
      "Best at rendering readable text in images. Ideal for logos, posters and ads. Turbo — fastest and cheapest option, slightly lower detail.",
  },
  "imagen-4-fast": {
    name: "🔮 Imagen 4 Fast",
    description:
      "Google Imagen 4 — high photorealism. Fast — cheapest and quickest option, no 2K support. Great for rapid iterations.",
  },
  "imagen-4": {
    name: "🔮 Imagen 4",
    description:
      "Google Imagen 4 — high photorealism. Standard — quality-to-price balance with 2K support. Optimal choice for most tasks.",
  },
  "imagen-4-ultra": {
    name: "🔮 Imagen 4 Ultra",
    description:
      "Google Imagen 4 — high photorealism. Ultra — maximum detail and rendering quality for professional tasks, 2K support.",
  },
  flux: {
    name: "⚡ FLUX.2",
    description:
      "Maximally realistic photos in seconds. Standard — fine-tuned generation control (steps, CFG, acceleration, LoRA). Cheaper than Pro, more parameters.",
  },
  "flux-pro": {
    name: "⚡ FLUX.2 Pro",
    description:
      "Professional FLUX.2 — maximum quality and prompt adherence. Fewer manual settings, but higher out-of-the-box results.",
  },
  "recraft-v3": {
    name: "🖌️ Recraft v3",
    description:
      "Previous-gen Recraft — wide selection of styles and sub-styles (realism, illustration, vector), artistic level control. Proven stability.",
  },
  "recraft-v4": {
    name: "🖌️ Recraft V4",
    description:
      "Recraft V4 Standard — new generation for design and marketing. Clean composition and precise text rendering. Cheaper than Pro, lower detail.",
  },
  "recraft-v4-pro": {
    name: "💠 Recraft V4 Pro",
    description:
      "Recraft V4 Pro — maximum resolution and detail for raster images. Ideal for demanding design projects, production-ready without edits.",
  },
  "recraft-v4-vector": {
    name: "📐 Recraft V4 Vector (SVG)",
    description:
      "Recraft V4 Vector — generates SVG vectors for logos, icons and illustrations. Scales to any size without quality loss. Cheaper than Pro Vector.",
  },
  "recraft-v4-pro-vector": {
    name: "📐 Recraft V4 Pro Vector (SVG)",
    description:
      "Recraft V4 Pro Vector — maximum SVG generation quality. For complex illustrations and branding requiring flawless detail and scalability.",
  },
  "seedream-5": {
    name: "🛍️ Seedream 5.0 (ByteDance)",
    description:
      "Perfect for product photos, clothing and catalogs. Version 5.0 — improved quality and realism compared to 4.5.",
  },
  "seedream-4.5": {
    name: "🛍️ Seedream 4.5",
    description:
      "Previous Seedream — slightly simpler than 5.0, but proven stability. Good for bulk product photo generation.",
  },
  // ── Video ────────────────────────────────────────────────────────────────────
  kling: {
    name: "🎥 Kling 3.0",
    description:
      "Generates videos up to 15 seconds with audio. Best at reproducing human movements. Standard version — faster and cheaper than Pro.",
  },
  "kling-motion": {
    name: "🎥 Kling Motion",
    description:
      "Transfers movements from a reference video onto any character from a photo. Standard — faster and cheaper than Pro. Ideal for portraits and simple animations.",
  },
  "kling-motion-pro": {
    name: "🎥 Kling Motion Pro",
    description:
      "Transfers movements from a reference video onto any character from a photo. Pro — higher transfer accuracy and detail.",
  },
  "kling-pro": {
    name: "🎥 Kling 3.0 Pro",
    description:
      "Generates videos up to 15 seconds with audio. Best at reproducing human movements. Pro version — higher detail and movement quality.",
  },
  "higgsfield-lite": {
    name: "🎬 Higgsfield Lite",
    description:
      "Realistic human animation — facial expressions, gestures and body movements. Lite — fastest and most affordable Higgsfield version.",
  },
  higgsfield: {
    name: "🎬 Higgsfield Turbo",
    description:
      "Realistic human animation — facial expressions, gestures and body movements. Turbo — quality-to-speed balance, higher detail than Lite.",
  },
  "higgsfield-preview": {
    name: "🎬 Higgsfield Preview",
    description:
      "Realistic human animation — facial expressions, gestures and body movements. Preview — flagship version with maximum quality, lighting and cinematic feel.",
    descriptionOverride:
      "Flagship version with maximum quality — most realistic lighting, detail and cinematic quality.",
  },
  "higgsfield-soul": {
    name: "🧬 Higgsfield Soul 2.0",
    description:
      "Image generation with your character (Soul ID). Create a character from 20+ photos — and generate any scene with their appearance. Supports styles, reference images and batch mode.",
  },
  veo: {
    name: "📽️ Veo 3.1",
    description:
      "Google video with audio and voices. Supports vertical format for Reels and Shorts. Standard — maximum quality, higher detail than Fast. You can set first and last frames — Veo generates a smooth transition between them.",
  },
  "veo-fast": {
    name: "📽️ Veo 3 Fast",
    description:
      "Fast and more affordable Veo 3 from Google. With audio and voices, slightly lower detail than Standard. Supports 4K. Send a photo with text — the video starts from your photo.",
  },
  sora: {
    name: "🌌 Sora 2",
    description:
      "The most realistic video from OpenAI. Objects move as in reality, with audio and correct physics. Send a photo with text — it becomes the first frame.",
  },
  runway: {
    name: "🛫 Runway Gen-4.5",
    description:
      "Full control over video: specify what and how should move, control the camera. The professional's choice.",
  },
  heygen: {
    name: "👤 HeyGen",
    description:
      "Popular among solo creators, influencers and small teams. For avatars, lip-sync and video translation in 175+ languages.",
  },
  seedance: {
    name: "💃 Seedance 1.5 Pro (ByteDance)",
    description:
      "Creates video with expressive movement and audio generation. Previous generation — proven stability, up to 12 seconds. Great for creative and stylized clips.",
  },
  "seedance-2": {
    name: "💃 Seedance 2.0 (ByteDance)",
    description:
      "Latest ByteDance video model — significantly higher quality and realism compared to 1.5. Built-in audio, up to 15 seconds, wide range of aspect ratios.",
  },
  "seedance-2-fast": {
    name: "💃 Seedance 2.0 Fast (ByteDance)",
    description:
      "Accelerated Seedance 2.0 — faster and ~20% cheaper than standard with similar quality. Built-in audio, up to 15 seconds.",
  },
  "luma-ray2": {
    name: "☀️ Luma: Ray 2",
    description:
      "Realistic video from Luma AI. Smooth movements, cinematic quality. Supports photo as the first frame.",
  },
  minimax: {
    name: "🎦 MiniMax Video-01",
    description:
      "Chinese video model with excellent character movement quality. Generates 6-second clips with high smoothness.",
  },
  pika: {
    name: "📸 Pika 2.2",
    description:
      "Fast videos with cool special effects: explosions, melting, compression. Perfect for TikTok and Reels.",
  },
  "hailuo-fast": {
    name: "🎞️ Hailuo 2.3 Fast",
    description:
      "Fast Hailuo 2.3 by MiniMax — ~40% cheaper than standard with similar quality. Slightly lower detail. Requires a photo as the first frame.",
  },
  hailuo: {
    name: "🎞️ Hailuo 2.3",
    description:
      "Standard Hailuo 2.3 by MiniMax — maximum quality, 1080p support and 10-second clips. Accepts a photo as the first frame.",
  },
  wan: {
    name: "🏯 Wan 2.7 (Alibaba)",
    description:
      "Alibaba video model with high movement quality and 1080p support. Supports image-to-video (with optional last frame and driving audio) and video continuation modes. Without media — text-to-video.",
  },
  "grok-imagine": {
    name: "🔮 Grok Imagine (text → video)",
    description:
      "xAI (Grok) video model, text-to-video mode. No reference images — generation by text prompt only.",
  },
  "grok-imagine-r2v": {
    name: "🔮 Grok Imagine (photo → video)",
    description:
      "xAI (Grok) video model, reference-to-video mode. Accepts up to 7 reference images — refer to them in the prompt via @image1, @image2, etc.",
  },
  "grok-imagine-image": {
    name: "🔮 Grok Imagine",
    description:
      "xAI (Grok) image generation. Text-to-image and image-to-image. Quality mode — higher precision and detail, Speed mode — faster generation with more variants.",
  },
};

export const SETTING_TRANSLATIONS_EN: Record<string, SettingTranslation> = {
  // ── LLM ──────────────────────────────────────────────────────────────────────
  temperature: {
    label: "Temperature",
    description:
      "Randomness of responses: lower = more precise and predictable, higher = more varied and creative.",
  },
  max_tokens: {
    label: "Max response length",
    description:
      "Maximum number of words the AI can write in one response. Increase for long texts.",
  },
  system_prompt: {
    label: "System prompt",
    description:
      "Hidden instruction the AI always follows: set a role, style or constraints for the entire dialog.",
  },
  search_recency_filter: {
    label: "Search recency",
    description: "Limit search to recent content: last hour, day, week or month.",
    options: { month: "Month", week: "Week", day: "Day", hour: "Hour" },
  },
  search_context_size: {
    label: "Search depth",
    description: "low — faster and cheaper, high — more sources and accurate but costlier.",
    options: { low: "Low", medium: "Medium", high: "High" },
  },
  search_domain_filter: {
    label: "Domain filter",
    description:
      "Restrict search to specific domains (comma-separated, e.g. wikipedia.org, bbc.com). Empty = no restriction.",
  },
  reasoning_effort: {
    label: "Reasoning depth",
    description:
      "How much effort the model spends thinking: low — fast, high — more thorough and accurate but slower.",
    options: { low: "Low", medium: "Medium", high: "High", xhigh: "Max" },
  },
  verbosity: {
    label: "Response detail",
    description:
      "Concise — brief answers, Standard — balanced, Detailed — detailed (for explanations and analysis).",
    options: { low: "Concise", medium: "Standard", high: "Detailed" },
  },
  extended_thinking: {
    label: "Extended thinking",
    description:
      "Model thinks longer before responding — more accurate for complex tasks but slower.",
  },
  enable_thinking: {
    label: "Thinking mode",
    description:
      "Model reasons before responding — more accurate for complex tasks but uses more output tokens.",
  },
  thinking_budget: {
    label: "Thinking budget",
    description: "How many tokens the model can spend on internal reasoning (0 = disabled).",
  },
  // ── Shared (media) ───────────────────────────────────────────────────────────
  num_images: {
    label: "Number of images",
    description:
      "Generate several variations in one request. You're only charged for the successful ones.",
  },
  aspect_ratio: {
    label: "Aspect ratio",
    description: "Shape of the output image: landscape, portrait or square.",
    options: {
      "1280:720": "Landscape 16:9",
      "720:1280": "Portrait 9:16",
      "1104:832": "Landscape 4:3",
      "832:1104": "Portrait 3:4",
      "960:960": "Square 1:1",
      "1584:672": "Wide 21:9",
    },
  },
  duration: {
    label: "Duration",
    description: "Duration of the video clip in seconds.",
    options: { "4": "4 s", "6": "6 s", "8": "8 s", "10": "10 s" },
  },
  seed: {
    label: "Seed",
    description: "Fixed seed for reproducibility. Empty = random each time.",
  },
  negative_prompt: {
    label: "Negative prompt",
    description: "What should NOT appear: list unwanted objects, styles or features.",
  },
  output_format: {
    label: "Output format",
    description: "Format of the resulting image.",
  },
  num_inference_steps: {
    label: "Generation steps",
    description:
      "Number of processing iterations: more steps = more detailed and higher quality, but slower.",
  },
  guidance_scale: {
    label: "Prompt guidance (CFG)",
    description:
      "How strictly the AI follows your text. High = literal, low = creative interpretation.",
  },
  cfg_scale: {
    label: "Prompt guidance (CFG)",
    description:
      "How accurately the video reflects your description: closer to 1 = strict, closer to 0 = more freedom.",
  },
  cfg: {
    label: "Prompt guidance (CFG)",
    description:
      "How strictly the AI follows your text. High = literal, low = creative interpretation.",
  },
  acceleration: {
    label: "Acceleration",
    description: "Generation speed: none = maximum quality, regular = balanced, high = fast.",
  },
  enable_prompt_expansion: {
    label: "Prompt expansion",
    description: "Automatically expands your prompt to improve the result.",
  },
  enhance_prompt: {
    label: "Prompt enhancement",
    description: "Automatically improves your prompt using AI for a more detailed result.",
  },
  prompt_extend: {
    label: "Prompt enhancement",
    description: "Automatically expands your prompt via LLM for a more detailed result.",
  },
  resolution: {
    label: "Resolution",
    description: "Quality / detail level of the output.",
  },
  custom_reference_id: {
    label: "Character (Soul ID)",
    description: "Select a created character. Required for generation.",
  },
  custom_reference_strength: {
    label: "Character strength",
    description:
      "How strongly the character's appearance affects the result (0 — weak, 1 — maximum).",
  },
  batch_size: {
    label: "Number of images",
    description: "How many variants to generate per request (1 or 4).",
  },
  style_id: {
    label: "Style (Soul Style)",
    description: "Choose a style for generation — defines mood, colors and aesthetics.",
  },
  style_strength: {
    label: "Style strength",
    description: "How strongly the style affects the result (0 — weak, 1 — maximum).",
  },
  generate_audio: {
    label: "Generate audio",
    description: "Enable automatic audio generation for the video.",
  },
  loop: {
    label: "Loop video",
    description: "Last frame smoothly transitions to first — perfect for seamless animations.",
  },
  motions: {
    label: "Motion presets",
    description: "Choose one or more camera motion presets. Multiple presets can be combined.",
  },
  person_generation: {
    label: "Person generation",
    description: "Whether people are allowed to appear in the video.",
    options: { dont_allow: "Not allowed", allow_adult: "Adults allowed" },
  },
  camera_horizontal: {
    label: "Camera: left / right",
    description: "Horizontal camera pan: negative = left, positive = right.",
  },
  camera_vertical: {
    label: "Camera: up / down",
    description: "Vertical camera pan: negative = down, positive = up.",
  },
  camera_zoom: {
    label: "Camera zoom",
    description: "Camera zoom: positive = zoom in, negative = zoom out.",
  },
  quality: {
    label: "Quality",
    description: "low — fast, medium — balanced, high — maximum. Affects price.",
  },
  size: {
    label: "Size",
    description: "Output image size. Affects price.",
  },
  output_compression: {
    label: "Compression",
    description: "Compression level for JPEG/WebP (0 = lossless, 100 = maximum). No effect on PNG.",
  },
  background: {
    label: "Background",
    description: "transparent — transparent background (PNG/WebP only), opaque — solid.",
  },
  moderation: {
    label: "Moderation",
    description: "low — relaxed content filtering, auto — standard.",
  },
  prompt_strength: {
    label: "Prompt strength (img2img)",
    description:
      "Degree of modification in img2img. 0.1 = minimal changes, 1.0 = full replacement.",
  },
  go_fast: {
    label: "Fast mode",
    description: "fp8 quantization instead of bf16. Faster, slightly lower quality.",
  },
  output_quality: {
    label: "Output quality",
    description: "Compression quality (0–100). No effect on PNG.",
  },
  extra_lora: {
    label: "Extra LoRA",
    description: "URL or path to LoRA weights (HuggingFace, CivitAI, Replicate, .safetensors).",
  },
  lora_scale: {
    label: "LoRA strength",
    description: "Intensity of the primary LoRA. Optimal: 0–1.",
  },
  extra_lora_scale: {
    label: "Extra LoRA strength",
    description: "Intensity of the additional LoRA. Optimal: 0–1.",
  },
  disable_safety_checker: {
    label: "Disable safety filter",
    description: "Disable content safety checks.",
  },
  enable_web_search: {
    label: "Web search",
    description: "Allow the model to access the internet to refine prompt details. Affects price.",
  },
  thinking_level: {
    label: "Thinking level",
    description:
      "Minimal — slight instruction-following boost, High — deep prompt analysis. Disabled = no extra thinking. Affects price.",
    options: { "": "Disabled" },
  },
  mode: {
    label: "Generation mode",
    description: "Fun — more creative and playful interpretation, Normal — balanced approach.",
    options: { fun: "Fun", normal: "Normal" },
  },
  enable_pro: {
    label: "Mode",
    description:
      "Speed — fast generation (6 variants), Quality — higher precision and detail (4 variants). Affects price.",
    options: { false: "Speed", true: "Quality" },
  },
  // ── Design-specific ───────────────────────────────────────────────────────────
  style_type: {
    label: "Style",
    description: "Artistic direction for the image.",
  },
  style_preset: {
    label: "Art preset",
    description: "Ready-made artistic style for the image (V3 models only).",
  },
  magic_prompt_option: {
    label: "Magic Prompt",
    description: "Automatically enhances your prompt for a more beautiful and detailed result.",
  },
  image_size: {
    label: "Resolution",
    description: "1K — standard, 2K — higher. Affects generation time.",
  },
  safety_filter_level: {
    label: "Safety filter",
    description:
      "block_only_high — most lenient, block_medium_and_above — moderate, block_low_and_above — strict.",
    options: {
      block_only_high: "Lenient",
      block_medium_and_above: "Moderate",
      block_low_and_above: "Strict",
    },
  },
  style: {
    label: "Style",
    description: "Artistic direction: realistic photos, digital illustrations or vector graphics.",
    options: {
      realistic_image: "Realistic",
      digital_illustration: "Illustration",
      vector_illustration: "Vector",
    },
  },
  substyle: {
    label: "Sub-style",
    description: "Refines the artistic style. Depends on the selected style.",
    options: { "": "— none —" },
  },
  no_text: {
    label: "No text",
    description: "Prevent the model from adding text, inscriptions or lettering to the image.",
  },
  artistic_level: {
    label: "Artistic level",
    description: "0 — close to reality, 5 — maximally stylized and artistic.",
  },
  strength: {
    label: "Modification strength",
    description:
      "Used when editing an image. 0 — barely change the original, 1 — follow only the prompt.",
  },
  // ── Audio-specific ────────────────────────────────────────────────────────────
  model: {
    label: "TTS model",
    description:
      "tts-1 — standard quality, tts-1-hd — high quality, gpt-4o-mini-tts — style-controlled via instructions. Affects price.",
  },
  model_id: {
    label: "Synthesis model",
    description:
      "multilingual_v2 — maximum quality (costlier), turbo_v2_5 — 2× faster and cheaper.",
    options: {
      eleven_multilingual_v2: "Multilingual v2 (max quality)",
      eleven_turbo_v2_5: "Turbo v2.5 (faster, cheaper)",
    },
  },
  voice: {
    label: "Voice",
    description:
      "Timbre and style. Alloy and Echo — neutral, Onyx — deep male, Nova and Shimmer — female.",
  },
  voice_id: {
    label: "Voice",
    description: "Choose a voice from the official library or your cloned voices.",
  },
  speed: {
    label: "Speech speed",
    description: "Narration pace: 1.0 = normal speed, lower = slower, higher = faster.",
  },
  format: {
    label: "Audio format",
    description: "MP3 — universal and compact, FLAC — lossless, Opus — for streaming.",
  },
  instructions: {
    label: "Voice instructions",
    description:
      "Only for gpt-4o-mini-tts: specify tone, emotion and speech style. E.g. 'Speak slowly and solemnly'.",
  },
  remove_background_noise: {
    label: "Remove background noise",
    description:
      "Removes background noise before cloning. Do not use if the recording is already clean.",
  },
  stability: {
    label: "Stability",
    description:
      "Voice consistency: high = even and monotone, low = more expressive and emotional.",
  },
  similarity_boost: {
    label: "Similarity boost",
    description: "How precisely the selected voice's timbre is reproduced.",
  },
  use_speaker_boost: {
    label: "Speaker Boost",
    description: "Enhances voice quality and clarity.",
  },
  model_version: {
    label: "Model version",
    description:
      "V4 — basic, V4.5 — recommended (up to 8 min, stable quality), V4.5+ — higher detail, V5 — new generation, V5.5 — latest (experimental).",
    options: { V4_5: "V4.5 (recommended)", V5_5: "V5.5 (latest)" },
  },
  make_instrumental: {
    label: "Instrumental only",
    description: "Generate music without vocals — instrumental track only.",
  },
  lyrics: {
    label: "Song lyrics",
    description: "Ready-made song text. If provided — the model won't generate its own lyrics.",
  },
  duration_seconds: {
    label: "Duration (sec)",
    description: "Specific duration in seconds.",
  },
  prompt_influence: {
    label: "Prompt influence",
    description:
      "How closely the output follows the description (0.0–1.0). Lower = more variation.",
  },
  auto_translate_prompt: {
    label: "Auto-translate prompt",
    description:
      "This model works best (or only) with English prompts. We can translate yours for an additional fee.",
  },
  character_orientation: {
    label: "Character orientation",
    description:
      "Whose orientation the character will follow in the result. 'From video' — matches the reference video orientation (recommended). 'From image' — matches the source photo orientation.",
    options: { video: "From video", image: "From image" },
  },
  background_source: {
    label: "Background source",
    description:
      "Where to take the background for the output video. 'From video' — background from the reference video. 'From image' — background from the source photo.",
    options: { input_video: "From video", input_image: "From image" },
  },
  nsfw_checker: {
    label: "NSFW filter",
    description: "When disabled — content filtering by the provider is turned off.",
  },
  context_window: {
    label: "Context window",
    description:
      "Maximum dialog history size in tokens. Older messages are automatically dropped to fit within this limit.",
  },
  // ── Video avatar ──────────────────────────────────────────────────────────────
  avatar_id: {
    label: "Avatar",
    description: "Choose an official HeyGen avatar or upload your own photo.",
  },
  background_color: { label: "Background color" },
  expressiveness: {
    label: "Expressiveness",
    description: "For photo avatars only.",
    options: { low: "Low", medium: "Medium", high: "High" },
  },
  motion_prompt: {
    label: "Motion description",
    description: "For photo avatars only.",
  },
  voice_settings_enabled: { label: "Configure voice" },
  voice_speed: { label: "Speech speed" },
  voice_pitch: { label: "Voice pitch" },
  voice_locale: { label: "Voice language" },
};

/** Map of locale code → model translations. Russian falls back to model definition strings. */
export const MODEL_TRANSLATIONS: Record<string, Record<string, ModelTranslation>> = {
  en: MODEL_TRANSLATIONS_EN,
  ru: {},
};

/**
 * Russian-only entries для настроек, которые были удалены из текущих
 * ModelSettingDef'ов (например, после смены провайдера у модели), но всё ещё
 * встречаются в исторических `modelSettings` старых джобов в галерее. Без
 * этих записей модалка показывала бы сырое имя ключа.
 *
 * Английские переводы для этих ключей живут в SETTING_TRANSLATIONS_EN
 * (они там нужны и для активных моделей).
 */
const SETTING_TRANSLATIONS_RU: Record<string, SettingTranslation> = {
  // Удалены из Nano Banana при переезде на kie (kie не поддерживает).
  enable_web_search: {
    label: "Поиск в интернете",
    description:
      "Разрешить модели обращаться к интернету для уточнения деталей промпта. Влияет на цену.",
  },
  thinking_level: {
    label: "Уровень размышлений",
    description:
      "Минимальный — небольшой буст следования инструкции, Высокий — глубокий анализ промпта. Отключено = без дополнительных рассуждений. Влияет на цену.",
    options: { "": "Отключено" },
  },
};

/**
 * Map of locale code → setting translations. Russian translations для активных
 * настроек живут в `ModelSettingDef.label/description` (модели уже на русском).
 * Здесь только сиротские ключи — см. SETTING_TRANSLATIONS_RU выше.
 */
export const SETTING_TRANSLATIONS: Record<string, Record<string, SettingTranslation>> = {
  en: SETTING_TRANSLATIONS_EN,
  ru: SETTING_TRANSLATIONS_RU,
};

/**
 * Returns localised display strings for a model.
 * Falls back to the raw model definition strings when no translation exists.
 */
export function resolveModelDisplay(
  modelId: string,
  lang: string,
  fallback: { name: string; description?: string | null; descriptionOverride?: string | null },
): { name: string; description: string } {
  // Only use translations for the requested locale — no cross-locale fallback.
  // If the locale has no entry, fall back to the model definition strings (fallback),
  // which are already in the correct language (e.g. Russian for ru locale).
  const mt = MODEL_TRANSLATIONS[lang]?.[modelId];
  const name = mt?.name ?? fallback.name;
  const description =
    mt?.descriptionOverride ??
    fallback.descriptionOverride ??
    mt?.description ??
    fallback.description ??
    "";
  return { name, description };
}
