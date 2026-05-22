# Virtual Try-on

> Try on clothes virtually by combining person and clothing images.

Used in this repo as the **fallback** for the clothing try-on feature
(primary is [Hy-Wu Edit](./hy-wu-edit.md)). OpenAPI schema:
[virtual-try-on.json](./virtual-try-on.json).

## Overview

- **Endpoint**: `https://fal.run/fal-ai/image-apps-v2/virtual-try-on`
- **Model ID**: `fal-ai/image-apps-v2/virtual-try-on`
- **Category**: image-to-image
- **Tags**: fashion, try-on, virtual-try-on

## Pricing

- **$0.04 per image**

## Input Schema

Note: unlike Hy-Wu Edit, this model takes **named** person/clothing URLs and
**no prompt** — input shape differs from the generic `image_urls` + `prompt`.

- **`person_image_url`** (`string`, _required_) — person photo URL.
- **`clothing_image_url`** (`string`, _required_) — clothing photo URL.
- **`preserve_pose`** (`boolean`, _optional_) — default `true`.
- **`aspect_ratio`** (`AspectRatio`, _optional_) — aspect ratio for 4K output.
  `ratio` enum: `1:1`, `16:9`, `9:16`, `4:3`, `3:4` (default `1:1`; fashion
  default noted as `3:4`).

### Required parameters example

```json
{
  "person_image_url": "https://v3.fal.media/files/tiger/4vxSHizex4UWR5fdnPs1A.jpeg",
  "clothing_image_url": "https://v3b.fal.media/files/b/monkey/5ZWXSKUuk9EilI1apFCeu_1ecd050187f24b9aa1d2defb88d8d8ae.png"
}
```

### Full example

```json
{
  "person_image_url": "https://v3.fal.media/files/tiger/4vxSHizex4UWR5fdnPs1A.jpeg",
  "clothing_image_url": "https://v3b.fal.media/files/b/monkey/5ZWXSKUuk9EilI1apFCeu_1ecd050187f24b9aa1d2defb88d8d8ae.png",
  "preserve_pose": true
}
```

## Output Schema

- **`images`** (`list<Image>`, _required_) — person wearing the virtual
  clothing. `Image`: `url`, `content_type`, `file_name`, `file_size`,
  `width`, `height`.

### Example response

```json
{
  "images": [
    {
      "url": "https://v3b.fal.media/files/b/panda/9w6wt7vgxjfmiBIoo6bjF_cb0ba7a150c84f159e9d40af2d439401.png"
    }
  ]
}
```

## cURL

```bash
curl --request POST \
  --url https://fal.run/fal-ai/image-apps-v2/virtual-try-on \
  --header "Authorization: Key $FAL_KEY" \
  --header "Content-Type: application/json" \
  --data '{
     "person_image_url": "https://v3.fal.media/files/tiger/4vxSHizex4UWR5fdnPs1A.jpeg",
     "clothing_image_url": "https://v3b.fal.media/files/b/monkey/5ZWXSKUuk9EilI1apFCeu_1ecd050187f24b9aa1d2defb88d8d8ae.png"
   }'
```

## Resources

- [Model Playground](https://fal.ai/models/fal-ai/image-apps-v2/virtual-try-on)
- [API Documentation](https://fal.ai/models/fal-ai/image-apps-v2/virtual-try-on/api)
- [OpenAPI Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/image-apps-v2/virtual-try-on)
