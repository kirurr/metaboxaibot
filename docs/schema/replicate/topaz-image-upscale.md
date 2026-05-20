# topazlabs/image-upscale (Replicate)

Используется как fallback для primary-модели `image-upscale` (KIE `topaz/image-upscale`).

## Basic model info

Model name: `topazlabs/image-upscale`
Model description: Professional-grade image upscaling, from Topaz Labs

## Model inputs

- `image` (required): Image to enhance (string)
- `enhance_model` (optional): Model to use: Standard V2 (general purpose), Low Resolution V2 (for low-res images), CGI (for digital art), High Fidelity V2 (preserves details), Text Refine (optimized for text) (string)
- `upscale_factor` (optional): How much to upscale the image (string) — значения вида `2x`, `4x`, `6x`; максимум `6x`
- `output_format` (optional): Output format (string)
- `subject_detection` (optional): Subject detection (string)
- `face_enhancement` (optional): Enhance faces in the image (boolean)
- `face_enhancement_creativity` (optional): Choose the level of creativity for face enhancement from 0 to 1. Defaults to 0, and is ignored if face_enhancement is false. (number)
- `face_enhancement_strength` (optional): Control how sharp the enhanced faces are relative to the background from 0 to 1. Defaults to 0.8, and is ignored if face_enhancement is false. (number)

## Model output schema

```json
{
  "type": "string",
  "title": "Output",
  "format": "uri"
}
```

Выход — один URI на готовое изображение.

## Example input

```json
{
  "image": "https://replicate.delivery/pbxt/.../topaz.png",
  "enhance_model": "CGI",
  "output_format": "jpg",
  "upscale_factor": "2x",
  "face_enhancement": false,
  "subject_detection": "None"
}
```

## Pricing (per Topaz Labs readme)

Цена за единицу зависит от мегапикселей выходного изображения:

| Output MP | Units | Cost  |
| --------- | ----- | ----- |
| 12        | 1     | $0.05 |
| 24        | 1     | $0.05 |
| 36        | 2     | $0.10 |
| 48        | 2     | $0.10 |
| 60        | 3     | $0.15 |
| 96        | 4     | $0.20 |
| 132       | 5     | $0.24 |
| 168       | 6     | $0.29 |
| 336       | 11    | $0.53 |
| 512       | 17    | $0.82 |

Масштаб — до 6x. Биллинг в AI Box при срабатывании fallback всё равно идёт по
цене primary (KIE), цена Replicate здесь — справочная.
