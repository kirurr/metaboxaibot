# elevenlabs/text-to-speech-multilingual-v2

KIE Market → Music Models → ElevenLabs.
POST `https://api.kie.ai/api/v1/jobs/createTask` with `model: "elevenlabs/text-to-speech-multilingual-v2"`.

## Key limits

- **`text` ≤ 5000 characters** (required).
- `voice` — preset name or voice ID (~67 voices).
- `stability` 0–1 step 0.01 (default 0.5).
- `similarity_boost` 0–1 step 0.01 (default 0.75).
- `style` 0–1 step 0.01 (default 0).
- `speed` 0.7–1.2 step 0.01 (default 1).
- `timestamps` boolean.
- `previous_text` / `next_text` ≤ 5000 chars each (continuity hints).
- `language_code` ISO 639-1, ≤ 500 chars. **NOTE: enforcement only works on Turbo v2.5 and Flash v2.5; for multilingual-v2 supplying a language_code returns an error.**

## Request shape

```json
{
  "model": "elevenlabs/text-to-speech-multilingual-v2",
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

`401` Unauthorized · `402` Insufficient Credits · `404` Not Found ·
`408` Upstream stuck · `422` Validation · `429` Rate Limited · `433` Sub-key Usage Exceeds Limit ·
`455` Maintenance · `500` Server Error · `501` Generation Failed · `505` Feature Disabled.

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ""
  version: 1.0.0
paths:
  /api/v1/jobs/createTask:
    post:
      summary: elevenlabs/text-to-speech-multilingual-v2
      operationId: elevenlabs-text-to-speech-multilingual-v2
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
                  enum: [elevenlabs/text-to-speech-multilingual-v2]
                  default: elevenlabs/text-to-speech-multilingual-v2
                callBackUrl:
                  type: string
                  format: uri
                input:
                  type: object
                  required: [text, voice]
                  properties:
                    text:
                      type: string
                      maxLength: 5000
                    voice:
                      type: string
                      description: Preset name or voice ID.
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
                      description: >-
                        Only Turbo v2.5 and Flash v2.5 honor language_code.
                        For other models supplying it returns an error.
servers:
  - url: https://api.kie.ai
```
