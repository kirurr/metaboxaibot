# elevenlabs/text-to-speech-turbo-2-5

KIE Market → Music Models → ElevenLabs.
POST `https://api.kie.ai/api/v1/jobs/createTask` with `model: "elevenlabs/text-to-speech-turbo-2-5"`.

Fast TTS variant; `language_code` actually honored (unlike multilingual-v2).

## Key limits

- **`text` ≤ 5000 characters** (required).
- `voice` — preset name or voice ID.
- `stability` / `similarity_boost` / `style` 0–1.
- `speed` 0.7–1.2.
- `previous_text` / `next_text` ≤ 5000 chars.
- `language_code` ≤ 500 chars, **honored on Turbo v2.5 and Flash v2.5** (not on multilingual-v2).
- `timestamps` boolean.

## Request shape

```json
{
  "model": "elevenlabs/text-to-speech-turbo-2-5",
  "callBackUrl": "https://your-domain.com/api/callback",
  "input": {
    "text": "...",
    "voice": "Rachel",
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0,
    "speed": 1,
    "timestamps": false,
    "previous_text": "",
    "next_text": "",
    "language_code": ""
  }
}
```

## Response

`200` → `{ code, msg, data: { taskId, recordId } }`. Polling via `Get Task Details`.

## Error codes

`401`/`402`/`404`/`408`/`422`/`429`/`455`/`500`/`501`/`505`.

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ""
  version: 1.0.0
paths:
  /api/v1/jobs/createTask:
    post:
      summary: elevenlabs/text-to-speech-turbo-2-5
      operationId: elevenlabs-text-to-speech-turbo-2-5
      tags:
        - docs/en/Market/Music Models/ElevenLabs
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [model]
              properties:
                model:
                  type: string
                  enum: [elevenlabs/text-to-speech-turbo-2-5]
                  default: elevenlabs/text-to-speech-turbo-2-5
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
                    voice:
                      type: string
                    stability:
                      type: number
                      minimum: 0
                      maximum: 1
                      default: 0.5
                    similarity_boost:
                      type: number
                      minimum: 0
                      maximum: 1
                      default: 0.75
                    style:
                      type: number
                      minimum: 0
                      maximum: 1
                      default: 0
                    speed:
                      type: number
                      minimum: 0.7
                      maximum: 1.2
                      default: 1
                    timestamps:
                      type: boolean
                    previous_text:
                      type: string
                      maxLength: 5000
                    next_text:
                      type: string
                      maxLength: 5000
                    language_code:
                      type: string
                      maxLength: 500
                      description: Honored on Turbo v2.5 and Flash v2.5.
servers:
  - url: https://api.kie.ai
```
