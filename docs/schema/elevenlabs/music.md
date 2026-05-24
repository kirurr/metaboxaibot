# ElevenLabs — Eleven Music (direct API)

Direct ElevenLabs API. Endpoint family at `/docs/api-reference/...` (API ref page wasn't dumped — only product overview is captured here). Used by `KieElevenLabsAdapter` as **fallback** for `music-el` when KIE returns 5xx.

## Key limits

- **Duration**: min 3 seconds, max 5 minutes.
- **Prompt (`text`)**: official overview does **not** publish a hard char limit. Our DB shows EL rejecting prompts > 450 with `INPUT_VALIDATION` for the `sounds-el` flow; whether EL Music shares the 450 cap or has a higher one is **not confirmed** by these docs — we only have empirical evidence for sound effects.
- **Output formats**: MP3 (44.1 kHz, 128–192 kbps) or WAV.
- **API availability**: paid subscribers only.
- **Lyrics**: by default music includes lyrics; add `"instrumental only"` to prompt to suppress vocals.
- **Vocal timing cues** are accepted in prompt: `"lyrics begin at 15 seconds"`, `"instrumental only after 1:45"`.
- **Language**: multilingual lyrics; follow-up like `"make it Japanese"` switches language in UI.

## What the model takes as input (per overview, not API reference)

Natural-language prompt describing genre, mood, tempo, key, structure, vocal style.
Optional: explicit duration, lyrics text, BPM, key signature, multi-vocalist hints.

Examples that the docs treat as valid:

- `"Create an intense, fast-paced electronic track for a high-adrenaline video game scene. 130-150 bpm, driving synth arpeggios, punchy drums, distorted bass."`
- `"a cappella vocals in A major, 90 BPM, soulful and raw"`

## Relevance to our incident

KIE caталог содержит `elevenlabs/sound-effect-v2` но **не** содержит KIE-обёртки для Music. Значит наш `KieElevenLabsAdapter` для `music-el` либо использует другой (не-KIE) URL, либо переиспользует `sound-effect-v2`. Это нужно проверить в коде [packages/api/src/ai/audio/kie-elevenlabs.adapter.ts](../../../packages/api/src/ai/audio/kie-elevenlabs.adapter.ts) — мы этого ещё не делали.

## References

- ElevenLabs overview: `https://elevenlabs.io/docs/overview/capabilities/music`
- API ref (we do not have a dump of this page): `https://elevenlabs.io/docs/api-reference/...`
- KIE counterpart: **отсутствует** — у KIE Music endpoint'а нет.
