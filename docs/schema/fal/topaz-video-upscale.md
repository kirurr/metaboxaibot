# fal-ai/topaz/upscale/video (Fal)

Topaz video upscale через Fal. Кандидат на замену Replicate `topazlabs/video-upscale`
как fallback для primary-модели `video-upscale` (KIE `topaz/video-upscale`).

## Endpoint

- HTTP: `POST https://fal.run/fal-ai/topaz/upscale/video`
- Endpoint ID: `fal-ai/topaz/upscale/video`
- Kind: video-to-video, async (queue)
- OpenAPI: https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/topaz/upscale/video
- Playground: https://fal.ai/models/fal-ai/topaz/upscale/video

## Input

| Параметр         | Тип     | Обяз. | По умолч. | Описание                                                       |
| ---------------- | ------- | ----- | --------- | -------------------------------------------------------------- |
| `video_url`      | string  | да    | —         | URL видео для апскейла                                         |
| `model`          | enum    | нет   | `Proteus` | Модель улучшения (см. ниже)                                    |
| `upscale_factor` | float   | нет   | `2`       | Множитель 1–4; 2.0 = ×2 по ширине и высоте                     |
| `target_fps`     | integer | нет   | —         | Целевой FPS 16–60; если задан — включается интерполяция кадров |
| `compression`    | float   | нет   | по модели | Удаление артефактов сжатия (0–1)                               |
| `noise`          | float   | нет   | по модели | Шумоподавление (0–1)                                           |
| `halo`           | float   | нет   | по модели | Подавление ореолов (0–1)                                       |
| `grain`          | float   | нет   | по модели | Зернистость плёнки (0–0.1, шаг 0.01)                           |
| `recover_detail` | float   | нет   | —         | Восстановление исходной детализации (0–1)                      |
| `H264_output`    | boolean | нет   | `false`   | H264 вместо H265 на выходе                                     |

### `model` enum

- `Proteus` — дефолт, лучший для большинства видео.
- `Artemis HQ` / `Artemis MQ` / `Artemis LQ` — denoise + sharpen.
- `Nyx` / `Nyx Fast` / `Nyx XL` / `Nyx HF` — выделенное шумоподавление.
- `Gaia HQ` / `Gaia CG` — рендер / CGI контент.
- `Gaia 2` — анимация и motion graphics (только ×2); **стоит вполовину дешевле**.
- `Starlight Precise 1/2/2.5`, `Starlight HQ/Mini/Sharp/Fast 1/2` —
  **генеративный diffusion-апскейл** (дорисовывает детали). Для чистого
  апскейла без галлюцинаций не использовать.

## Output

```json
{ "video": { "url": "https://v3.fal.media/files/.../upscaled.mp4" } }
```

`video` — готовый File с URL. Скачивать/перезаливать не нужно.

## Pricing

За каждую секунду видео: **$0.01** до 720p, **$0.02** для 720p→1080p,
**$0.08** для выхода выше 1080p. Цена ×2 для 60fps. Модель `Gaia 2` —
половина цены. Подробнее: https://fal.ai/pricing

## Limitations

- `upscale_factor`: 1–4
- `target_fps`: 16–60
- `compression` / `noise` / `halo` / `recover_detail`: 0–1
- `grain`: 0–0.1

## Notes (интеграция в AI Box)

- `upscale_factor` — **множитель 1–4, ровно как у KIE** `topaz/video-upscale`.
  В отличие от Replicate (абсолютный `target_resolution` 720p/1080p/4k с
  потолком 4k и маппингом фактор→разрешение) — Fal принимает фактор от сцены
  напрямую 1:1. Никакого `videoResolutionTier`-приближения не нужно.
- `model` по умолчанию `Proteus` — не-генеративный, без дорисовки деталей.
  Семейство `Starlight` — генеративное; для апскейла без галлюцинаций не брать.
- Клиент — `@fal-ai/client` (`fal.queue.submit` / `.status` / `.result`),
  как в существующих `packages/api/src/ai/{image,video}/fal.adapter.ts`.

## Документация Fal

Полный индекс доки Fal: https://fal.ai/docs/llms.txt
