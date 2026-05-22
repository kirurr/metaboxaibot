# bria/remove-background

> Bria AI's remove background model (RMBG 2.0).

Used in this repo as the **fallback** for the background-removal scenario.
Primary: fal `ideogram/remove-background`
([ideogram-remove-background.md](../fal/ideogram-remove-background.md)).

## Basic model info

- **Model name:** `bria/remove-background`
- **Description:** Bria AI's remove background model
- **Provider:** Replicate
- **Price:** $0.018 per output image (~55 images per $1)

Replicate model string: **`bria/remove-background`** — no version hash needed.
`replicate.run("bria/remove-background", { input })` resolves the latest
deployment (`POST /v1/models/bria/remove-background/predictions`), unlike
pinned community models that require `owner/name:version`.

## Inputs

| Field                    | Required | Type    | Description                                                               |
| ------------------------ | -------- | ------- | ------------------------------------------------------------------------- |
| `image`                  | optional | string  | Image file                                                                |
| `image_url`              | optional | string  | Image URL                                                                 |
| `preserve_alpha`         | optional | boolean | Preserve alpha channel. True → keep original transparency; false → opaque |
| `content_moderation`     | optional | boolean | Enable content moderation                                                 |
| `preserve_partial_alpha` | optional | boolean | [DEPRECATED] No longer used in V2 API — use `preserve_alpha`              |

One of `image` / `image_url` must be provided.

## Output schema

```json
{ "type": "string", "title": "Output", "format": "uri" }
```

Output is a bare image URL (transparent PNG).

## Example

### Input

```json
{
  "image": "https://replicate.delivery/pbxt/.../image.png",
  "content_moderation": false
}
```

### Output

```json
"https://replicate.delivery/xezq/.../tmpltht_m5k.png"
```

## Notes

- Output is a bare URL string with no width/height — per-MP billing (if any)
  relies on the worker measuring the output.
- RMBG 2.0 uses non-binary masks (256 transparency levels) for natural edges.
- Trained on licensed data — safe for commercial use.

## Model readme

> Bria RMBG 2.0 enables seamless removal of backgrounds from images, ideal for
> professional editing tasks. Trained exclusively on licensed data for safe and
> risk-free commercial use.
>
> While most background removal solutions use binary masks that create harsh,
> artificial looking edges, Bria RMBG 2.0 uses non-binary masks allowing for
> 256 levels of transparency, providing natural results that blend seamlessly
> with any background while preserving the fine details.
>
> - Source/weights: https://huggingface.co/briaai/RMBG-2.0
> - Benchmark: https://blog.bria.ai/benchmarking-blog/brias-new-state-of-the-art-remove-background-2.0-outperforms-the-competition
