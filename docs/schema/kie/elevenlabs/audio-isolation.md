# elevenlabs/audio-isolation

KIE Market → Music Models → ElevenLabs.
POST `https://api.kie.ai/api/v1/jobs/createTask` with `model: "elevenlabs/audio-isolation"`.

Removes background noise / isolates voice from an audio file.

## Key limits

- `audio_url` — required, file URL after upload (not raw content).
- Accepted types: `audio/mpeg`, `audio/wav`, `audio/x-wav`, `audio/aac`, `audio/mp4`, `audio/ogg`.
- **Max file size: 10 MB**.

## Request shape

```json
{
  "model": "elevenlabs/audio-isolation",
  "callBackUrl": "https://your-domain.com/api/callback",
  "input": {
    "audio_url": "https://file.aiquickdraw.com/.../1756964657418ljw1jbzr.mp3"
  }
}
```

## Response

`200` → `{ code, msg, data: { taskId, recordId } }`.
Polling via `Get Task Details`.

## Error codes

Same set as other KIE EL endpoints: 401/402/404/408/422/429/455/500/501/505.

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ""
  version: 1.0.0
paths:
  /api/v1/jobs/createTask:
    post:
      summary: elevenlabs/audio-isolation
      operationId: elevenlabs-audio-isolation
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
                  enum: [elevenlabs/audio-isolation]
                  default: elevenlabs/audio-isolation
                callBackUrl:
                  type: string
                  format: uri
                input:
                  type: object
                  required: [audio_url]
                  properties:
                    audio_url:
                      type: string
                      description: >-
                        URL of the audio file to isolate voice from.
                        Accepted: audio/mpeg, audio/wav, audio/x-wav, audio/aac,
                        audio/mp4, audio/ogg. Max size 10MB.
servers:
  - url: https://api.kie.ai
```
