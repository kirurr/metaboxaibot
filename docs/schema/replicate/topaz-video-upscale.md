# topazlabs/video-upscale (Replicate)

Используется как fallback для primary-модели `video-upscale` (KIE `topaz/video-upscale`).

## Basic model info

Model name: `topazlabs/video-upscale`
Model description: Video Upscaling from Topaz Labs

## Model inputs

- `video` (required): Video file to upscale (string)
- `target_resolution` (optional): Target resolution (string) — `720p`, `1080p`, `4k`
- `target_fps` (optional): Target FPS (choose from 15-60fps) (integer)

## Model output schema

```json
{
  "type": "string",
  "title": "Output",
  "format": "uri"
}
```

Выход — один URI на готовое видео.

## Example input

```json
{
  "video": "https://replicate.delivery/pbxt/.../test.mp4",
  "target_fps": 60,
  "target_resolution": "4k"
}
```

## Notes

Поддерживает апскейл до 720p / 1080p / 4k и fps до 60.

В отличие от KIE `topaz/video-upscale` (где задаётся `upscale_factor` —
множитель 1/2/4), Replicate-версия принимает **абсолютное** целевое разрешение
`target_resolution`. Fallback-адаптер маппит выбранный множитель в разрешение:
`2 → 1080p`, `4 → 4k`. Это приближение — точный множитель на fallback теряется.

`target_fps` адаптер жёстко фиксирует на `30`: на 60fps стоимость Replicate
вдвое выше, а биллинг идёт по KIE-ставке primary — без пина 60fps-исходник
ушёл бы в минус.

Биллинг в AI Box при срабатывании fallback идёт по цене primary (KIE).
