# Ideogram Remove Background

> Remove backgrounds from existing images with Ideogram's remove background
> feature. Isolate subjects cleanly for compositing and creative reuse.

Used in this repo as the **primary** model for the background-removal scenario.
Fallback: Replicate `bria/remove-background`. OpenAPI schema:
[ideogram-remove-background.json](./ideogram-remove-background.json).

## Overview

- **Endpoint**: `https://fal.run/fal-ai/ideogram/remove-background`
- **Model ID**: `fal-ai/ideogram/remove-background`
- **Category**: image-to-image

## Pricing

- **$0.01 per request** (flat).

## Input Schema

- **`image_url`** (`string`, _required_) — image whose background is removed.
  Foreground subject preserved against a transparent background. JPEG, PNG,
  WebP supported, max file size 10 MB.
- **`sync_mode`** (`boolean`, _optional_) — default `false`; if true, media
  returned as a data URI.

### Required parameters example

```json
{
  "image_url": "https://v3.fal.media/files/rabbit/F6dvKPFL9VzKiM8asJOgm_MJj6yUB6rGjTsv_1YHIcA_image.webp"
}
```

## Output Schema

- **`image`** (`File`, _required_) — the foreground image with the background
  removed (transparent PNG). **Note:** singular `image` object, not an
  `images` array. `File`: `url`, `content_type`, `file_name`, `file_size`.

### Example response

```json
{
  "image": {
    "url": "https://v3b.fal.media/files/b/0a994215/rxdZME1tH4a2pmk0sKV-x_image.png"
  }
}
```

## cURL

```bash
curl --request POST \
  --url https://fal.run/fal-ai/ideogram/remove-background \
  --header "Authorization: Key $FAL_KEY" \
  --header "Content-Type: application/json" \
  --data '{
     "image_url": "https://v3.fal.media/files/rabbit/F6dvKPFL9VzKiM8asJOgm_MJj6yUB6rGjTsv_1YHIcA_image.webp"
   }'
```

## Resources

- [Model Playground](https://fal.ai/models/fal-ai/ideogram/remove-background)
- [API Documentation](https://fal.ai/models/fal-ai/ideogram/remove-background/api)
- [OpenAPI Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ideogram/remove-background)
