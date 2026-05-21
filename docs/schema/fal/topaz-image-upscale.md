# fal-ai/topaz/upscale/image (Fal)

Topaz image upscale через Fal. Кандидат на замену Replicate `topazlabs/image-upscale`
как fallback для primary-модели `image-upscale` (KIE `topaz/image-upscale`).

## Endpoint

- HTTP: `POST https://fal.run/fal-ai/topaz/upscale/image`
- Endpoint ID: `fal-ai/topaz/upscale/image`
- Kind: image-to-image, async (queue)
- OpenAPI: https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/topaz/upscale/image
- Playground: https://fal.ai/models/fal-ai/topaz/upscale/image

## Input

| Параметр                      | Тип     | Обяз. | По умолч.     | Описание                                                                                |
| ----------------------------- | ------- | ----- | ------------- | --------------------------------------------------------------------------------------- |
| `image_url`                   | string  | да    | —             | URL картинки для апскейла                                                               |
| `model`                       | enum    | нет   | `Standard V2` | Модель улучшения (см. ниже)                                                             |
| `upscale_factor`              | float   | нет   | `2`           | Множитель 1–4; 2.0 = ×2 по ширине и высоте                                              |
| `crop_to_fill`                | boolean | нет   | `false`       | Обрезка под заполнение                                                                  |
| `output_format`               | enum    | нет   | `jpeg`        | `jpeg` или `png`                                                                        |
| `subject_detection`           | enum    | нет   | `All`         | `All` / `Foreground` / `Background` (standard enhance, Recovery V2)                     |
| `face_enhancement`            | boolean | нет   | `true`        | Улучшение лиц (standard enhance, Recovery V2)                                           |
| `face_enhancement_creativity` | float   | нет   | `0`           | Креативность улучшения лиц 0–1                                                          |
| `face_enhancement_strength`   | float   | нет   | `0.8`         | Сила улучшения лиц 0–1                                                                  |
| `sharpen`                     | float   | нет   | по модели     | Резкость 0–1 (Standard V2, Low Res V2, CGI, High Fidelity V2, Text Refine, Redefine)    |
| `denoise`                     | float   | нет   | по модели     | Шумоподавление 0–1 (те же модели)                                                       |
| `fix_compression`             | float   | нет   | по модели     | Удаление артефактов сжатия 0–1 (Standard V2, Low Res V2, High Fidelity V2, Text Refine) |
| `strength`                    | float   | нет   | —             | Сила улучшения 0.01–1 (**только Text Refine**)                                          |
| `creativity`                  | integer | нет   | —             | Креативность генеративного апскейла 1–6 (**только Redefine**)                           |
| `texture`                     | integer | нет   | —             | Детализация текстур 1–5 (**только Redefine**)                                           |
| `prompt`                      | string  | нет   | —             | Текстовый промпт для генеративного апскейла, ≤1024 симв. (**только Redefine**)          |
| `autoprompt`                  | boolean | нет   | —             | Авто-генерация промпта (**только Redefine**)                                            |
| `detail`                      | float   | нет   | —             | Восстановление деталей 0–1 (**только Recovery V2**)                                     |

### `model` enum

- `Standard V2` — дефолт, универсальный не-генеративный апскейл.
- `Low Resolution V2` — для низкокачественных исходников.
- `CGI` — рендеры / 3D.
- `High Fidelity V2` — максимальное сохранение деталей.
- `Text Refine` — улучшение текста на изображении.
- `Recovery` / `Recovery V2` — восстановление сильно деградированных фото.
- `Standard MAX` / `Wonder` — расширенные не-генеративные модели.
- `Redefine` — **генеративный апскейл**: параметры `creativity` (1–6, «higher
  values produce more creative/hallucinated details»), `texture`, `prompt`,
  `autoprompt`. Именно он дорисовывает детали. Для чистого апскейла не брать.

## Output

```json
{
  "image": {
    "url": "https://v3.fal.media/files/.../z9RV14K95DvU.png",
    "content_type": "image/png",
    "file_name": "z9RV14K95DvU.png",
    "file_size": 4404019
  }
}
```

`image` — готовый File с URL. Скачивать/перезаливать не нужно.

## Pricing

По мегапикселям результата: **$0.08** до 24 MP, **$0.16** до 48 MP,
**$0.32** до 96 MP, вплоть до **$1.36** для 512 MP. Подробнее: https://fal.ai/pricing

## Limitations

- `upscale_factor`: 1–4
- `output_format`: `jpeg` / `png`
- `subject_detection`: `All` / `Foreground` / `Background`
- `face_enhancement_creativity` / `face_enhancement_strength` / `sharpen` /
  `denoise` / `fix_compression` / `detail`: 0–1
- `strength`: 0.01–1
- `creativity`: 1–6
- `texture`: 1–5

## Notes (интеграция в AI Box)

- `upscale_factor` — **множитель 1–4, ровно как у KIE** `topaz/image-upscale`.
  Фактор от сцены идёт 1:1, без replicate-шного маппинга в `2x`/`4x`/`6x`.
- **Против «дорисовки ИИ-говна»:** дефолтная `Standard V2` — НЕ генеративная.
  Галлюцинации даёт только `Redefine` (модель `creativity` 1–6). Для чистого
  апскейла оставлять `Standard V2` и не трогать `creativity`.
- `face_enhancement` по умолчанию `true`, но `face_enhancement_creativity` по
  умолчанию `0` — лица улучшаются без креативной дорисовки. Так и держать.
- Клиент — `@fal-ai/client` (`fal.queue.submit` / `.status` / `.result`),
  как в существующих `packages/api/src/ai/{image,video}/fal.adapter.ts`.

## Документация Fal

Полный индекс доки Fal: https://fal.ai/docs/llms.txt
