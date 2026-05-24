# elevenlabs/text-to-dialogue-v3

KIE Market → Music Models → ElevenLabs.
POST `https://api.kie.ai/api/v1/jobs/createTask` with `model: "elevenlabs/text-to-dialogue-v3"`.

## Key limits

- **Total dialogue text combined: ≤ 5000 characters** across all items in the `dialogue` array.
- `stability` enum: `0`, `0.5`, `1` (default `0.5`).
- Voice = preset name (e.g. `Rachel`) OR voice ID from the catalogued list (~67 voices).
- `language_code` optional (auto-detect when empty).

## Request shape

```json
{
  "model": "elevenlabs/text-to-dialogue-v3",
  "callBackUrl": "https://your-domain.com/api/callback",
  "input": {
    "dialogue": [
      { "text": "...", "voice": "EkK5I93UQWFDigLMpZcX" },
      { "text": "...", "voice": "Z3R5wn05IrDiVCyEkUrK" }
    ],
    "stability": 0.5
  }
}
```

## Response

`200` → `{ code, msg, data: { taskId, recordId } }`.
Polling via `Get Task Details` (`/market/common/get-task-detail`).

## Error codes

`401` Unauthorized · `402` Insufficient Credits · `404` Not Found ·
`408` Upstream stuck (>10 min) · `422` Validation Error · `429` Rate Limited ·
`455` Maintenance · `500` Server Error · `501` Generation Failed · `505` Feature Disabled.

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ""
  description: ""
  version: 1.0.0
paths:
  /api/v1/jobs/createTask:
    post:
      summary: elevenlabs/text-to-dialogue-v3
      operationId: elevenlabs-text-to-dialogue-v3
      tags:
        - docs/en/Market/Music Models/ElevenLabs
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [model, input]
              properties:
                model:
                  type: string
                  enum: [elevenlabs/text-to-dialogue-v3]
                  default: elevenlabs/text-to-dialogue-v3
                callBackUrl:
                  type: string
                  format: uri
                input:
                  type: object
                  required: [dialogue]
                  properties:
                    dialogue:
                      type: array
                      description: >-
                        Array of dialogue items. Total character count of all
                        text fields combined must not exceed 5000 characters.
                      items:
                        type: object
                        required: [text, voice]
                        properties:
                          text:
                            type: string
                            description: >-
                              The dialogue text content. Combined with other
                              entries' text must not exceed 5000 characters.
                          voice:
                            type: string
                            description: >-
                              Preset voice name (e.g. Rachel, Adam) or voice ID.
                              Preview at https://static.aiquickdraw.com/elevenlabs/voice/<voice_id>.mp3
                    stability:
                      type: number
                      enum: [0, 0.5, 1]
                      default: 0.5
                    language_code:
                      type: string
                      description: ISO 639-1; empty/omit for auto-detect.
servers:
  - url: https://api.kie.ai
```
