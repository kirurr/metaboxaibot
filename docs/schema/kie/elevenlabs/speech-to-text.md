# elevenlabs/speech-to-text

KIE Market → ElevenLabs.
POST `https://api.kie.ai/api/v1/jobs/createTask` with `model: "elevenlabs/speech-to-text"`.

Transcribes an audio file. Used in our voice-prompt / transcribe flows.

## Key limits

- `audio_url` — required, file URL after upload.
- Accepted: `audio/mpeg`, `audio/wav`, `audio/x-wav`, `audio/aac`, `audio/mp4`, `audio/ogg`.
- **Max file size: 200 MB** (note: vs `audio-isolation` which is 10 MB).
- `language_code` ≤ 500 chars (empty → auto-detect).
- `tag_audio_events` boolean (laughter, applause, etc.).
- `diarize` boolean (annotate speakers).

## Request shape

```json
{
  "model": "elevenlabs/speech-to-text",
  "callBackUrl": "https://your-domain.com/api/callback",
  "input": {
    "audio_url": "https://file.aiquickdraw.com/.../1757157053357tn37vxc8.mp3",
    "language_code": "",
    "tag_audio_events": true,
    "diarize": true
  }
}
```

## Response

`200` → `{ code, msg, data: { taskId } }` (note: no `recordId` returned for STT).
Polling via `Get Task Details`.

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
      summary: Generate content using elevenlabs/speech-to-text
      operationId: elevenlabs-speech-to-text
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
                  enum: [elevenlabs/speech-to-text]
                  default: elevenlabs/speech-to-text
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
                        URL of the audio file to transcribe. Accepted: audio/mpeg,
                        audio/wav, audio/x-wav, audio/aac, audio/mp4, audio/ogg.
                        Max size 200MB.
                    language_code:
                      type: string
                      maxLength: 500
                    tag_audio_events:
                      type: boolean
                    diarize:
                      type: boolean
```
