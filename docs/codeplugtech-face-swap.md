# codeplugtech/face-swap

Third fallback for the face swap feature (`face-swap-classic`), after Hy-Wu Edit
(fal, primary) and `cdingram/face-swap` (Replicate, first fallback).

## Basic model info

- **Model name:** `codeplugtech/face-swap`
- **Description:** Advance Face Swap powered by pixalto.app
- **Provider:** Replicate

## Inputs

| Field         | Required | Type   | Description  |
| ------------- | -------- | ------ | ------------ |
| `input_image` | yes      | string | Target image |
| `swap_image`  | yes      | string | Swap image   |

## Output schema

```json
{
  "type": "string",
  "title": "Output",
  "format": "uri"
}
```

A `uri` format means the output is a file (image URL).

## Example

### Input

```json
{
  "swap_image": "https://replicate.delivery/pbxt/KYU956lXBNWkoblkuMb93b6CX8SFL2nrJTvv2T89Dm3DLhsW/swap%20img.jpg",
  "input_image": "https://replicate.delivery/pbxt/KYU95NKY092KYhmCDbLLOVHZqzSC27D5kQLHDb28YM6u8Il1/input.jpg"
}
```

### Output

```json
"https://replicate.delivery/pbxt/iFTAdiIoBwI0FRwsp2N5SKZAHVoC3aVf8KR35oXtPp3KCtPJA/1710223125.jpg"
```

Example run: https://replicate.com/p/bla7airbawfaf5dbzuamkbqmgq

## Replicate run

Full versioned model string (needed for the Replicate adapter `MODEL_IDS` map):

```
codeplugtech/face-swap:278a81e7ebb22db98bcba54de985d22cc1abeead2754eb1f2af717247be69b34
```

```js
import Replicate from "replicate";
const replicate = new Replicate();

const input = {
  swap_image: "https://.../swap.jpg",
  input_image: "https://.../input.jpg",
};

const output = await replicate.run(
  "codeplugtech/face-swap:278a81e7ebb22db98bcba54de985d22cc1abeead2754eb1f2af717247be69b34",
  { input },
);
console.log(output.url());
```

Auth via `REPLICATE_API_TOKEN`.

## Notes

- Same input shape as `cdingram/face-swap` (`input_image` = target, `swap_image`
  = face source) — maps directly from `mediaInputs.edit[0]` / `edit[1]`.
- Output is a bare image URL with no width/height — per-MP billing relies on the
  worker measuring the output (or falling back to `estimatedMegapixels`).
- Supports JPG, PNG, WEBP.

## Model readme

> # 🧠✨ AI Face Swap
>
> [Pixalto.app](https://pixalto.app)
>
> AI Face Swap is a deep-learning–powered application that swaps faces between
> images with high accuracy and realism. It uses modern computer vision models
> to detect faces, extract features, and blend them seamlessly into the target
> media.
>
> This project is ideal for:
>
> - Photo editing
> - Content creation
> - Entertainment apps
> - Face research & experimentation
>
> ## 🚀 Features
>
> - 🔍 Automatic face detection
> - 🔄 High-quality face swapping (image → image)
> - 🎨 Seamless blending & color correction
> - ⚙️ GPU-accelerated (CUDA)
> - 📁 Works with JPG, PNG, WEBP
> - 🧩 Easy to integrate into any project
>
> ## 🛠️ Tech Stack
>
> - Python 3.9+
> - PyTorch / TensorFlow
> - InsightFace / Face Recognition / Mediapipe
> - OpenCV
> - FastAPI / Flask (optional API mode)
