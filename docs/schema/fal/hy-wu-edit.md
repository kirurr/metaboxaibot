# Hy Wu Edit

> Image editing with HY-WU. Transfer outfits, swap faces, and blend textures
> instantly—no finetuning needed, just describe what you want and provide
> reference images.

Used in this repo as the primary model for **face swap** and **clothing
try-on** (image-to-image). OpenAPI schema: [hy-wu-edit.json](./hy-wu-edit.json).

## Overview

- **Endpoint**: `https://fal.run/fal-ai/hy-wu-edit`
- **Model ID**: `fal-ai/hy-wu-edit`
- **Category**: image-to-image
- **Kind**: inference

## Pricing

Your request will cost **$0.1 per MP**, thinking costs **$0.15 per MP**.

## Input Schema

- **`prompt`** (`string`, _required_) — text prompt describing the desired
  edit. Supports English and Chinese. Use specific instructions like
  "Replace the clothing on figure 1 with the outfit from figure 2".
- **`image_urls`** (`list<string>`, _required_) — URLs of input images.
  Typically 2 (base + reference), up to 3 supported.
- **`image_size`** (`ImageSize | Enum`, _optional_) — default `auto` (model
  determines size). Enum: `auto`, `square_hd`, `square`, `portrait_4_3`,
  `portrait_16_9`, `landscape_4_3`, `landscape_16_9`.
- **`num_inference_steps`** (`integer`, _optional_) — default `30`, range 1–100.
- **`seed`** (`integer`, _optional_) — random seed; if none, random.
- **`num_images`** (`integer`, _optional_) — default `1`, range 1–4.
- **`enable_thinking`** (`boolean`, _optional_) — default `true`. Model reasons
  about the edit before generating: higher quality, longer inference, $0.15/MP.
- **`enable_safety_checker`** (`boolean`, _optional_) — default `true`.
- **`output_format`** (`OutputFormatEnum`, _optional_) — default `png`;
  options `jpeg`, `png`.
- **`sync_mode`** (`boolean`, _optional_) — default `false`; if true, media
  returned as data URI.

### Required parameters example

```json
{
  "prompt": "Using image 1 as the base image, replace the outfit with the clothing from image 2 while keeping the subject, pose, and background unchanged.",
  "image_urls": [
    "https://v3b.fal.media/files/b/0a933dff/BE-FgBximAbCJzZSgDNNw_input_1_1.png",
    "https://v3b.fal.media/files/b/0a933dff/fNUqzO_Lxwvr-_-4BLeCV_input_1_2.png"
  ]
}
```

### Full example

```json
{
  "prompt": "Using image 1 as the base image, replace the outfit with the clothing from image 2 while keeping the subject, pose, and background unchanged.",
  "image_urls": [
    "https://v3b.fal.media/files/b/0a933dff/BE-FgBximAbCJzZSgDNNw_input_1_1.png",
    "https://v3b.fal.media/files/b/0a933dff/fNUqzO_Lxwvr-_-4BLeCV_input_1_2.png"
  ],
  "image_size": "auto",
  "num_inference_steps": 30,
  "num_images": 1,
  "enable_thinking": true,
  "enable_safety_checker": true,
  "output_format": "png"
}
```

## Output Schema

- **`images`** (`list<Image>`, _required_) — generated/edited images.
- **`seed`** (`integer`, _required_) — seed used for generation.
- **`timings`** (`Timings`, _optional_) — performance timing breakdown.

`Image`: `url`, `content_type`, `file_name`, `file_size`, `width`, `height`.

### Example response

```json
{
  "images": [
    {
      "url": "",
      "content_type": "image/png",
      "file_name": "z9RV14K95DvU.png",
      "file_size": 4404019,
      "width": 1024,
      "height": 1024
    }
  ],
  "timings": {}
}
```

## cURL

```bash
curl --request POST \
  --url https://fal.run/fal-ai/hy-wu-edit \
  --header "Authorization: Key $FAL_KEY" \
  --header "Content-Type: application/json" \
  --data '{
     "prompt": "Using image 1 as the base image, replace the outfit with the clothing from image 2 while keeping the subject, pose, and background unchanged.",
     "image_urls": [
       "https://v3b.fal.media/files/b/0a933dff/BE-FgBximAbCJzZSgDNNw_input_1_1.png",
       "https://v3b.fal.media/files/b/0a933dff/fNUqzO_Lxwvr-_-4BLeCV_input_1_2.png"
     ]
   }'
```

## Resources

- [Model Playground](https://fal.ai/models/fal-ai/hy-wu-edit)
- [API Documentation](https://fal.ai/models/fal-ai/hy-wu-edit/api)
- [OpenAPI Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/hy-wu-edit)
