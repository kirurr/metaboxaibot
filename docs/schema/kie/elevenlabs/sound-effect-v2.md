# elevenlabs/sound-effect-v2

KIE Market → ElevenLabs.
POST `https://api.kie.ai/api/v1/jobs/createTask` with `model: "elevenlabs/sound-effect-v2"`.

This is the endpoint used by our `sounds-el` model.

## Key limits

- **`text` — declared `maxLength: 5000` is FALSE. Real limit is `≤ 450` characters** (measured 2026-05-24, see "Empirical verification" below). KIE OpenAPI lies; their backend rejects with `code:500 "text exceeds maximum length"` at the same threshold as direct ElevenLabs `/v1/sound-generation` (450).
- `loop` boolean (default `false`).
- `duration_seconds` 0.5–22, step 0.1. If omitted — optimal duration is auto-inferred from prompt.
- `prompt_influence` 0–1, step 0.01, default `0.3`.
- `output_format` — enum (mp3 / pcm / ulaw / alaw / opus); default `mp3_44100_128`.

## ⚠️ KIE lies about the text limit

Their OpenAPI spec says `maxLength: 5000`. Direct probing on 2026-05-24 against `POST https://api.kie.ai/api/v1/jobs/createTask` with `model: elevenlabs/sound-effect-v2`:

| `text.length` | HTTP | KIE `code` | `msg`                           |
| ------------- | ---- | ---------- | ------------------------------- |
| 100           | 200  | 200        | success                         |
| 400           | 200  | 200        | success                         |
| **450**       | 200  | **200**    | **success** ← real boundary     |
| **500**       | 200  | **500**    | **text exceeds maximum length** |
| 600 – 5000    | 200  | 500        | text exceeds maximum length     |

Notes:

- HTTP is always `200`; the failure mode is `body.code = 500` + a specific `body.msg`. Generic 5xx classifiers based purely on HTTP status will miss this — must inspect the JSON envelope.
- This explains why a naive "5xx → fallback to direct ElevenLabs" path is pointless: the direct EL endpoint has the same 450 cap, so the fallback always fails on user-input grounds and emits a false on-call alert.

## Request shape

```json
{
  "model": "elevenlabs/sound-effect-v2",
  "callBackUrl": "https://your-domain.com/api/callback",
  "input": {
    "text": "thunder rolling over a rainy city",
    "loop": false,
    "duration_seconds": 5,
    "prompt_influence": 0.3,
    "output_format": "mp3_44100_128"
  }
}
```

## Response

`200` → `{ code, msg, data: { taskId, recordId } }`. Polling via `Get Task Details`.

## Error codes

`401`/`402`/`404`/`422`/`429`/`455`/`500`/`501`/`505`.

## OpenAPI Specification

```yaml
openapi: 3.0.0
info:
  title: Elevenlabs API
  version: 1.0.0
servers:
  - url: https://api.kie.ai
paths:
  /api/v1/jobs/createTask:
    post:
      summary: Generate content using elevenlabs/sound-effect-v2
      operationId: elevenlabs-sound-effect-v2
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [model]
              properties:
                model:
                  type: string
                  enum: [elevenlabs/sound-effect-v2]
                  default: elevenlabs/sound-effect-v2
                callBackUrl:
                  type: string
                  format: uri
                input:
                  type: object
                  required: [text]
                  properties:
                    text:
                      type: string
                      maxLength: 5000
                    loop:
                      type: boolean
                      default: false
                    duration_seconds:
                      type: number
                      minimum: 0.5
                      maximum: 22
                      description: If omitted, optimal duration auto-inferred from prompt.
                    prompt_influence:
                      type: number
                      minimum: 0
                      maximum: 1
                      default: 0.3
                    output_format:
                      type: string
                      enum:
                        - mp3_22050_32
                        - mp3_44100_32
                        - mp3_44100_64
                        - mp3_44100_96
                        - mp3_44100_128
                        - mp3_44100_192
                        - pcm_8000
                        - pcm_16000
                        - pcm_22050
                        - pcm_24000
                        - pcm_44100
                        - pcm_48000
                        - ulaw_8000
                        - alaw_8000
                        - opus_48000_32
                        - opus_48000_64
                        - opus_48000_96
                        - opus_48000_128
                        - opus_48000_192
                      default: mp3_44100_128
```
