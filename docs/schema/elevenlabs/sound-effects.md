# ElevenLabs — Sound Effects (direct API)

Direct ElevenLabs API. Endpoint: `POST /v1/sound-generation` (per official docs page `/docs/api-reference/text-to-sound-effects/convert`).
Used by `KieElevenLabsAdapter` as **fallback** when KIE `elevenlabs/sound-effect-v2` returns 5xx.

## Key limits

- **Duration**: 0.1 – 30 seconds (default: auto, determined from prompt).
- **`text` (prompt)**: official overview doc does **not** publish a hard char limit, but the API returns `INPUT_VALIDATION` with message `"max 450 chars"` on long prompts. Empirical limit = **450 characters**. KIE wrapper accepts up to 5000; the direct EL endpoint does not.
- **Looping**: optional, designed for seamless repeat playback (atmospheric/ambient use).
- **Prompt influence**: 0–1. Higher = more literal interpretation.

## Pricing note

40 credits per second when duration is specified.

## Output formats

- **MP3** for all effects.
- **WAV at 48 kHz** for non-looping effects.

## Prompt guidance (relevant for validation messages)

Simple effects: `"Glass shattering on concrete"`, `"Thunder rumbling in the distance"`.
Complex sequences: `"Footsteps on gravel, then a metallic door opens"`.

## Relevance to our incident

Our `KieElevenLabsAdapter` for `sounds-el`:

1. Submit to KIE `elevenlabs/sound-effect-v2` — accepts text ≤ 5000.
2. On KIE 5xx, falls back to **this** direct `POST /v1/sound-generation` — rejects text > 450.

User promts of 1422–3855 chars pass KIE limit but blow up on direct EL → `onElFallback(true)` → fake `Fallback FAILED` alert.

## References

- ElevenLabs API reference: `https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert`
- KIE counterpart: [docs/schema/kie/elevenlabs/sound-effect-v2.md](../kie/elevenlabs/sound-effect-v2.md)
