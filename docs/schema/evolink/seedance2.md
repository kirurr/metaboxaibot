> ## Documentation Index
>
> Fetch the complete documentation index at: https://docs.evolink.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# Seedance 2.0 Complete Parameter Guide

> Unified API for all Seedance 2.0 models, select a specific model via the `model` parameter

**3 Generation Modes:**

- **Text-to-Video**: Generate video from pure text descriptions, supports web search enhancement
- **Image-to-Video**: Use 1-2 images as first/last frames to drive video generation
- **Reference-to-Video**: Mixed multimodal reference from images, videos, and audio

Each mode has a standard and fast version, 6 models in total

- **Now supports AIGC realistic human materials**
- Asynchronous processing mode, use the returned task ID to [query task details](/en/api-manual/task-management/get-task-detail)
- Generated video links are valid for 24 hours, please save them promptly

## OpenAPI

````yaml /en/api-manual/video-series/seedance2.0/seedance-2.0-overview.json POST /v1/videos/generations
openapi: 3.1.0
info:
  title: Seedance 2.0 All Models API
  description: >-
    Unified API for all 6 Seedance 2.0 models, covering text-to-video,
    image-to-video, and multimodal reference-to-video in both standard and fast
    versions
  license:
    name: MIT
  version: 1.0.0
servers:
  - url: https://api.evolink.ai
    description: Production
security:
  - bearerAuth: []
tags:
  - name: Video Generation
    description: AI video generation endpoints
paths:
  /v1/videos/generations:
    post:
      tags:
        - Video Generation
      summary: Seedance 2.0 Video Generation (All Models)
      description: >-
        Unified API for all Seedance 2.0 models, select a specific model via the
        `model` parameter


        **3 Generation Modes:**

        - **Text-to-Video**: Generate video from pure text descriptions,
        supports web search enhancement

        - **Image-to-Video**: Use 1-2 images as first/last frames to drive video
        generation

        - **Reference-to-Video**: Mixed multimodal reference from images,
        videos, and audio


        Each mode has a standard and fast version, 6 models in total


        - **Now supports AIGC realistic human materials**

        - Asynchronous processing mode, use the returned task ID to [query task
        details](/en/api-manual/task-management/get-task-detail)

        - Generated video links are valid for 24 hours, please save them
        promptly
      operationId: createSeedance20VideoGeneration
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/VideoGenerationRequest"
            examples:
              text_to_video:
                summary: Text-to-Video
                value:
                  model: seedance-2.0-text-to-video
                  prompt: 一只猫在钢琴上弹奏月光奏鸣曲，电影感光影，特写镜头
                  duration: 8
                  quality: 720p
                  aspect_ratio: "16:9"
                  generate_audio: true
              image_to_video:
                summary: Image-to-Video (first frame driven)
                value:
                  model: seedance-2.0-image-to-video
                  prompt: 镜头缓缓推进，花瓣随风飘落
                  image_urls:
                    - https://example.com/flower.jpg
                  duration: 5
                  aspect_ratio: adaptive
                  generate_audio: true
              reference_to_video:
                summary: Multimodal reference (image + video + audio)
                value:
                  model: seedance-2.0-reference-to-video
                  prompt: 全程使用视频1的第一视角构图，全程使用音频1作为背景音乐。第一人称视角果茶宣传广告...
                  image_urls:
                    - https://example.com/ref1.jpg
                    - https://example.com/ref2.jpg
                  video_urls:
                    - https://example.com/reference.mp4
                  audio_urls:
                    - https://example.com/bgm.mp3
                  duration: 10
                  quality: 720p
                  aspect_ratio: "16:9"
                  generate_audio: true
              fast_text_to_video:
                summary: Fast Text-to-Video
                value:
                  model: seedance-2.0-fast-text-to-video
                  prompt: 城市日落延时摄影，金色光线洒满天际线
                  duration: 5
                  aspect_ratio: "21:9"
                  generate_audio: true
      responses:
        "200":
          description: Video generation task created successfully
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/VideoGenerationResponse"
        "400":
          description: Invalid request parameters
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
              example:
                error:
                  code: invalid_request
                  message: Invalid request parameters
                  type: invalid_request_error
        "401":
          description: Unauthenticated, token invalid or expired
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
              example:
                error:
                  code: unauthorized
                  message: Invalid or expired token
                  type: authentication_error
        "402":
          description: Insufficient quota, top-up required
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
              example:
                error:
                  code: insufficient_quota
                  message: Insufficient quota. Please top up your account.
                  type: insufficient_quota
        "403":
          description: Access denied
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
              example:
                error:
                  code: model_access_denied
                  message: Token does not have access to the specified model
                  type: invalid_request_error
        "429":
          description: Rate limit exceeded
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
              example:
                error:
                  code: rate_limit_exceeded
                  message: Too many requests, please try again later
                  type: rate_limit_error
        "500":
          description: Internal server error
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
              example:
                error:
                  code: internal_error
                  message: Internal server error
                  type: api_error
components:
  schemas:
    VideoGenerationRequest:
      type: object
      required:
        - model
        - prompt
      properties:
        model:
          type: string
          description: >-
            Video generation model name


            | Model ID | Mode | Speed |

            |:--------|:-----|:-----|

            | `seedance-2.0-text-to-video` | Text-to-Video | Standard |

            | `seedance-2.0-image-to-video` | Image-to-Video | Standard |

            | `seedance-2.0-reference-to-video` | Multimodal Reference |
            Standard |

            | `seedance-2.0-fast-text-to-video` | Text-to-Video | Fast |

            | `seedance-2.0-fast-image-to-video` | Image-to-Video | Fast |

            | `seedance-2.0-fast-reference-to-video` | Multimodal Reference |
            Fast |
          enum:
            - seedance-2.0-text-to-video
            - seedance-2.0-image-to-video
            - seedance-2.0-reference-to-video
            - seedance-2.0-fast-text-to-video
            - seedance-2.0-fast-image-to-video
            - seedance-2.0-fast-reference-to-video
          example: seedance-2.0-text-to-video
        prompt:
          type: string
          description: >-
            Text prompt describing the desired video. Supports both Chinese and
            English, recommended no more than 500 characters for Chinese or 1000
            words for English


            **Prompt usage for different models:**

            - **Text-to-Video**: Pure text description, does not support using
            `image_urls`, `video_urls`, `audio_urls` in the prompt

            - **Image-to-Video**: Pure text description, does not support using
            `video_urls`, `audio_urls` in the prompt

            - **Reference-to-Video**: You can use natural language to specify
            the purpose of each material, e.g., "use image 1 as the first
            frame", "use the camera movement from video 1 throughout", "use
            audio 1 as background music"
          example: 一只猫在钢琴上弹奏月光奏鸣曲，电影感光影，特写镜头
        image_urls:
          type: array
          description: >-
            Image URL array


            **Applicable models and quantity limits:**

            - **Text-to-Video**: Not supported

            - **Image-to-Video**: Required, **1-2 images**

            - **Reference-to-Video**: Optional, **0-9 images**


            **Image-to-Video image behavior:**


            | Image Count | Behavior | Role |

            |:--------:|------|------|

            | 1 | First frame image-to-video | Automatically set as
            `first_frame` |

            | 2 | First and last frame image-to-video | 1st image ->
            `first_frame`, 2nd image -> `last_frame` |


            **Reference-to-Video image roles:**

            - Style reference, product image, character appearance, first/last
            frame (specified via prompt)


            **Image requirements:**

            - Supported formats: `.jpeg`, `.png`, `.webp`

            - Aspect ratio (width/height): `0.4` ~ `2.5`

            - Width/height pixels: `300` ~ `6000` px

            - Max size per image: `30MB`

            - Total request body size must not exceed `64MB`

            - When providing first and last frames, both images can be
            identical. If aspect ratios differ, the first frame takes priority
            and the last frame will be automatically cropped to match

            - Image URLs must be directly accessible by the server
          items:
            type: string
            format: uri
          maxItems: 9
          example:
            - https://example.com/image1.jpg
        video_urls:
          type: array
          description: >-
            Reference video URL array


            **Only applicable to Reference-to-Video models**, other models do
            not support this parameter


            **Quantity limit:** 0-3 videos


            **Role description:**

            - Camera movement reference, motion reference, original video for
            editing/extension


            **Video requirements:**

            - Supported formats: `.mp4`, `.mov`

            - Resolution: 480p, 720p, 1080p

            - Duration per video: `2` ~ `15` seconds, max 3 videos, total
            duration of all videos <= `15` seconds

            - Aspect ratio (width/height): `0.4` ~ `2.5`

            - Width/height pixels: `300` ~ `6000` px

            - Frame pixels (width x height): `409,600` ~ `2,086,876` (e.g.,
            640x640 ~ 2206x946)

            - Max size per video: `50MB`

            - Frame rate: `24` ~ `60` FPS

            - Using video references will increase costs (input video duration
            is counted in billing)

            - Video URLs must be directly accessible by the server


            **Note:** You cannot provide only `audio_urls`; at least 1 image
            (`image_urls`) or 1 video (`video_urls`) must be included
          items:
            type: string
            format: uri
          maxItems: 3
          example:
            - https://example.com/reference.mp4
        audio_urls:
          type: array
          description: >-
            Reference audio URL array


            **Only applicable to Reference-to-Video models**, other models do
            not support this parameter


            **Quantity limit:** 0-3 clips


            **Role description:**

            - Background music, sound effects, voice/dialogue reference


            **Audio requirements:**

            - Supported formats: `.wav`, `.mp3`

            - Duration per clip: `2` ~ `15` seconds, max 3 clips, total duration
            of all audio <= `15` seconds

            - Max size per clip: `15MB`

            - Audio URLs must be directly accessible by the server


            **Note:** Audio cannot be provided alone; at least 1 image or 1
            video must be included
          items:
            type: string
            format: uri
          maxItems: 3
          example:
            - https://example.com/bgm.mp3
        duration:
          type: integer
          description: |-
            Output video duration (seconds), defaults to `5` seconds

            - Supports any integer value between `4`-`15` seconds
            - Duration directly affects billing
            - Applicable to all 6 models
          default: 5
          minimum: 4
          maximum: 15
          example: 8
        quality:
          type: string
          description: >-
            Video resolution, defaults to `720p`


            **Options:**

            - `480p`: Lower clarity, lower cost

            - `720p`: Standard clarity, this is the default

            - `1080p`: Ultra HD clarity, **only supported by standard models**
            (Text-to-Video, Image-to-Video, Reference-to-Video); the 3 Fast
            models are not supported


            `480p` and `720p` apply to all 6 models
          enum:
            - 480p
            - 720p
            - 1080p
          default: 720p
          example: 720p
        aspect_ratio:
          type: string
          description: >-
            Video aspect ratio, defaults to `16:9`


            **Options:**

            - `16:9` (landscape), `9:16` (portrait), `1:1` (square), `4:3`,
            `3:4`, `21:9` (ultrawide)

            - `adaptive`: Automatically select the best ratio


            **`adaptive` behavior per model:**

            - **Text-to-Video**: Automatically selected based on prompt content

            - **Image-to-Video**: Automatically adapts based on first frame
            image aspect ratio

            - **Reference-to-Video**: Priority: video material ratio > image
            material ratio > prompt inference


            **Pixel values per resolution:**


            | Aspect Ratio | 480p | 720p | 1080p |

            |:------:|:----:|:----:|:-----:|

            | 16:9 | 864×496 | 1280×720 | 1920×1080 |

            | 4:3 | 752×560 | 1112×834 | 1664×1248 |

            | 1:1 | 640×640 | 960×960 | 1440×1440 |

            | 3:4 | 560×752 | 834×1112 | 1248×1664 |

            | 9:16 | 496×864 | 720×1280 | 1080×1920 |

            | 21:9 | 992×432 | 1470×630 | 2206×946 |


            *1080p only supported by standard models*
          enum:
            - "16:9"
            - "9:16"
            - "1:1"
            - "4:3"
            - "3:4"
            - "21:9"
            - adaptive
          default: "16:9"
          example: "16:9"
        generate_audio:
          type: boolean
          description: >-
            Whether to generate synchronized audio, defaults to `true`


            - `true`: Video includes synchronized audio (voice, sound effects,
            background music) at no additional charge

            - `false`: Output silent video


            Applicable to all 6 models
          default: true
          example: true
        model_params:
          type: object
          description: >-
            Model extension parameters


            **Only applicable to Text-to-Video models** (standard and fast
            versions)
          properties:
            web_search:
              type: boolean
              description: >-
                Web search, defaults to `false`


                **Only applicable to Text-to-Video models**
                (`seedance-2.0-text-to-video` and
                `seedance-2.0-fast-text-to-video`)


                **Details:**

                - When enabled, the model autonomously decides whether to search
                internet content (e.g., products, weather) based on the prompt,
                improving timeliness

                - May increase latency

                - Charges only apply when a search is actually triggered;
                multiple searches may occur after enabling
              default: false
              example: false
        callback_url:
          type: string
          description: >-
            HTTPS callback URL for task completion


            **Callback timing:**

            - Triggered when the task is completed, failed, or cancelled

            - Sent after billing confirmation is complete


            **Security restrictions:**

            - Only HTTPS protocol is supported

            - Callbacks to private IP addresses are prohibited (127.0.0.1,
            10.x.x.x, 172.16-31.x.x, 192.168.x.x, etc.)

            - URL length must not exceed `2048` characters


            **Callback mechanism:**

            - Timeout: `10` seconds

            - Up to `3` retries after failure (at `1`/`2`/`4` seconds after
            failure respectively)

            - Callback response body format is consistent with the task query
            endpoint response format

            - A 2xx status code is considered successful; other status codes
            trigger retries


            Applicable to all 6 models
          format: uri
          example: https://your-domain.com/webhooks/video-task-completed
    VideoGenerationResponse:
      type: object
      properties:
        created:
          type: integer
          description: Task creation timestamp
          example: 1761313744
        id:
          type: string
          description: Task ID
          example: task-unified-1774857405-abc123
        model:
          type: string
          description: Actual model name used
          example: seedance-2.0-text-to-video
        object:
          type: string
          enum:
            - video.generation.task
          description: Specific type of the task
        progress:
          type: integer
          description: Task progress percentage (0-100)
          minimum: 0
          maximum: 100
          example: 0
        status:
          type: string
          description: Task status
          enum:
            - pending
            - processing
            - completed
            - failed
          example: pending
        task_info:
          $ref: "#/components/schemas/VideoTaskInfo"
          description: Video task details
        type:
          type: string
          enum:
            - text
            - image
            - audio
            - video
          description: Output type of the task
          example: video
        usage:
          $ref: "#/components/schemas/VideoUsage"
          description: Usage and billing information
    ErrorResponse:
      type: object
      properties:
        error:
          type: object
          properties:
            code:
              type: string
              description: Error code identifier
            message:
              type: string
              description: Error description message
            type:
              type: string
              description: Error type
    VideoTaskInfo:
      type: object
      properties:
        can_cancel:
          type: boolean
          description: Whether the task can be cancelled
          example: true
        estimated_time:
          type: integer
          description: Estimated completion time (seconds)
          minimum: 0
          example: 165
        video_duration:
          type: integer
          description: Video duration (seconds)
          example: 8
    VideoUsage:
      type: object
      description: Usage and billing information
      properties:
        billing_rule:
          type: string
          description: Billing rule
          enum:
            - per_call
            - per_token
            - per_second
          example: per_second
        credits_reserved:
          type: number
          description: Estimated credits consumed
          minimum: 0
          example: 50
        user_group:
          type: string
          description: User group category
          example: default
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      description: >-
        ##All endpoints require Bearer Token authentication##


        **Get API Key:**


        Visit the [API Key Management Page](https://evolink.ai/dashboard/keys)
        to obtain your API Key


        **Add to request header:**

        ```

        Authorization: Bearer YOUR_API_KEY

        ```
````
