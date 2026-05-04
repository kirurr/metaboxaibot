# Suno API Quickstart

> Get started with the Suno API to generate AI music, lyrics, and audio content in minutes.

Source: https://docs.kie.ai/suno-api/quickstart

## Welcome to Suno API

The Suno API enables you to create high-quality AI-generated music, lyrics, and audio content using state-of-the-art AI models. Whether you're building a music app, automating creative workflows, or developing audio content, the API provides comprehensive tools for music generation and audio processing.

### Capabilities

- **Generate Music** (`/suno-api/generate-music`) — create original music tracks with or without lyrics.
- **Extend Music** (`/suno-api/extend-music`) — extend existing music tracks seamlessly.
- **Generate Lyrics** (`/suno-api/generate-lyrics`) — create creative lyrics from text prompts.
- **Music Videos** (`/suno-api/create-music-video`) — convert audio tracks into visual music videos.
- **Upload & Cover** (`/suno-api/upload-and-cover-audio`) — transform uploaded audio into new styles.
- **Upload & Extend** (`/suno-api/upload-and-extend-audio`) — upload audio files and extend them.
- **Add Instrumental** (`/suno-api/add-instrumental`) — generate instrumental accompaniment for uploaded audio.
- **Add Vocals** (`/suno-api/add-vocals`) — add vocal singing to uploaded audio files.
- **Separate Vocals** (`/suno-api/separate-vocals`) — separate vocals and instrumentals from music.
- **Convert to WAV** (`/suno-api/convert-to-wav`) — convert audio to high-quality WAV format.
- **Get Lyrics** (`/suno-api/get-timestamped-lyrics`) — retrieve timestamped synchronized lyrics.

## Authentication

All API requests require authentication using a Bearer token. Get your API key from the [API Key Management Page](https://kie.ai/api-key).

> ⚠️ Keep your API key secure and never share it publicly. If compromised, reset it immediately.

### API Base URL

```
https://api.kie.ai
```

### Authentication Header

```http
Authorization: Bearer YOUR_API_KEY
```

## Quick Start Guide

### Step 1: Generate Your First Music Track

Start with a simple music generation request.

**cURL**

```bash
curl -X POST "https://api.kie.ai/api/v1/generate" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A calm and relaxing piano track with soft melodies",
    "customMode": false,
    "instrumental": true,
    "model": "V3_5",
    "callBackUrl": "https://your-app.com/callback"
  }'
```

**Node.js**

```javascript
async function generateMusic() {
  try {
    const response = await fetch("https://api.kie.ai/api/v1/generate", {
      method: "POST",
      headers: {
        Authorization: "Bearer YOUR_API_KEY",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "A calm and relaxing piano track with soft melodies",
        customMode: false,
        instrumental: true,
        model: "V3_5",
        callBackUrl: "https://your-app.com/callback",
      }),
    });

    const data = await response.json();

    if (response.ok && data.code === 200) {
      console.log("Task submitted:", data);
      console.log("Task ID:", data.data.taskId);
      return data.data.taskId;
    } else {
      console.error("Request failed:", data.msg || "Unknown error");
      return null;
    }
  } catch (error) {
    console.error("Error:", error.message);
    return null;
  }
}

generateMusic();
```

**Python**

```python
import requests

def generate_music():
    url = "https://api.kie.ai/api/v1/generate"
    headers = {
        "Authorization": "Bearer YOUR_API_KEY",
        "Content-Type": "application/json"
    }

    payload = {
        "prompt": "A calm and relaxing piano track with soft melodies",
        "customMode": False,
        "instrumental": True,
        "model": "V3_5",
        "callBackUrl": "https://your-app.com/callback"
    }

    try:
        response = requests.post(url, json=payload, headers=headers)
        result = response.json()

        if response.ok and result.get('code') == 200:
            print(f"Task submitted: {result}")
            print(f"Task ID: {result['data']['taskId']}")
            return result['data']['taskId']
        else:
            print(f"Request failed: {result.get('msg', 'Unknown error')}")
            return None
    except requests.exceptions.RequestException as e:
        print(f"Error: {e}")
        return None

generate_music()
```

### Step 2: Check Task Status

Use the returned task ID to check the generation status.

**cURL**

```bash
curl -X GET "https://api.kie.ai/api/v1/generate/record-info?taskId=YOUR_TASK_ID" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Node.js**

```javascript
async function checkTaskStatus(taskId) {
  try {
    const response = await fetch(
      `https://api.kie.ai/api/v1/generate/record-info?taskId=${taskId}`,
      {
        method: "GET",
        headers: {
          Authorization: "Bearer YOUR_API_KEY",
        },
      },
    );

    const result = await response.json();

    if (response.ok && result.code === 200) {
      const taskData = result.data;

      switch (taskData.status) {
        case "SUCCESS":
          console.log("All tracks generated successfully!");
          console.log("Audio tracks:", taskData.response.sunoData);
          return taskData.response;

        case "FIRST_SUCCESS":
          console.log("First track generation completed");
          if (taskData.response.sunoData && taskData.response.sunoData.length > 0) {
            console.log("Audio tracks:", taskData.response.sunoData);
          }
          return taskData.response;

        case "TEXT_SUCCESS":
          console.log("Lyrics/text generation successful");
          return taskData.response;

        case "PENDING":
          console.log("Task is pending...");
          return taskData.response;

        case "CREATE_TASK_FAILED":
          console.log("Task creation failed");
          if (taskData.errorMessage) {
            console.error("Error message:", taskData.errorMessage);
          }
          return taskData.response;

        case "GENERATE_AUDIO_FAILED":
          console.log("Audio generation failed");
          if (taskData.errorMessage) {
            console.error("Error message:", taskData.errorMessage);
          }
          return taskData.response;

        case "CALLBACK_EXCEPTION":
          console.log("Callback process error");
          if (taskData.errorMessage) {
            console.error("Error message:", taskData.errorMessage);
          }
          return taskData.response;

        case "SENSITIVE_WORD_ERROR":
          console.log("Content filtered due to sensitive words");
          if (taskData.errorMessage) {
            console.error("Error message:", taskData.errorMessage);
          }
          return taskData.response;

        default:
          console.log("Unknown status:", taskData.status);
          if (taskData.errorMessage) {
            console.error("Error message:", taskData.errorMessage);
          }
          return taskData.response;
      }
    } else {
      console.error("Query failed:", result.msg || "Unknown error");
      return null;
    }
  } catch (error) {
    console.error("Status check failed:", error.message);
    return null;
  }
}
```

**Python**

```python
import requests
import time

def check_task_status(task_id, api_key):
    url = f"https://api.kie.ai/api/v1/generate/record-info?taskId={task_id}"
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        response = requests.get(url, headers=headers)
        result = response.json()

        if response.ok and result.get('code') == 200:
            task_data = result['data']
            status = task_data['status']

            response_data = task_data['response']

            if status == 'SUCCESS':
                print("All tracks generated successfully!")
                for i, track in enumerate(response_data['sunoData']):
                    print(f"Track {i+1}: {track.get('audioUrl', 'Not completed')}")
                return response_data
            elif status == 'FIRST_SUCCESS':
                print("First track generation completed")
                if response_data.get('sunoData'):
                    for i, track in enumerate(response_data['sunoData']):
                        if track.get('audioUrl'):
                            print(f"Track {i+1}: {track['audioUrl']}")
                return response_data
            elif status == 'TEXT_SUCCESS':
                print("Lyrics/text generation successful")
                return response_data
            elif status == 'PENDING':
                print("Task is pending...")
                return response_data
            elif status == 'CREATE_TASK_FAILED':
                print("Task creation failed")
                if task_data.get('errorMessage'):
                    print(f"Error message: {task_data['errorMessage']}")
                return response_data
            elif status == 'GENERATE_AUDIO_FAILED':
                print("Audio generation failed")
                if task_data.get('errorMessage'):
                    print(f"Error message: {task_data['errorMessage']}")
                return response_data
            elif status == 'CALLBACK_EXCEPTION':
                print("Callback process error")
                if task_data.get('errorMessage'):
                    print(f"Error message: {task_data['errorMessage']}")
                return response_data
            elif status == 'SENSITIVE_WORD_ERROR':
                print("Content filtered due to sensitive words")
                if task_data.get('errorMessage'):
                    print(f"Error message: {task_data['errorMessage']}")
                return response_data
            else:
                print(f"Unknown status: {status}")
                if task_data.get('errorMessage'):
                    print(f"Error message: {task_data['errorMessage']}")
                return response_data
        else:
            print(f"Query failed: {result.get('msg', 'Unknown error')}")
            return None
    except requests.exceptions.RequestException as e:
        print(f"Status check failed: {e}")
        return None

def wait_for_completion(task_id, api_key):
    while True:
        result = check_task_status(task_id, api_key)
        if result is not None:
            return result
        time.sleep(30)
```

### Response Format

**Successful Response:**

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "taskId": "5c79****be8e"
  }
}
```

**Task Status Response:**

> ⚠️ Внимание: в этом ответе поля называются camelCase (`audioUrl`, `imageUrl`), а в примере колбэка ниже — `audio_url` (snake_case). Несогласованность в их доках; при интеграции сверяться с реальным ответом API.

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "taskId": "5c79****be8e",
    "status": "SUCCESS",
    "response": {
      "sunoData": [
        {
          "id": "e231****-****-****-****-****8cadc7dc",
          "audioUrl": "https://example.cn/****.mp3",
          "streamAudioUrl": "https://example.cn/****",
          "imageUrl": "https://example.cn/****.jpeg",
          "prompt": "A calm and relaxing piano track",
          "title": "Peaceful Piano",
          "tags": "calm, relaxing, piano",
          "duration": 198.44,
          "createTime": "2025-01-01 00:00:00"
        }
      ]
    }
  }
}
```

## Core Features

- **Text-to-Music** — generate music from text descriptions with AI.
- **Music Extension** — seamlessly extend existing audio tracks.
- **Lyrics Generation** — create structured lyrical content from creative prompts.
- **Audio Upload & Cover** — upload audio files and transform them into different musical styles.
- **Add Instrumental** — generate instrumental accompaniment for uploaded audio files.
- **Add Vocals** — add vocal singing to uploaded audio files with custom styles.
- **Vocal Separation** — isolate vocals, instrumentals, and other audio components.
- **Format Conversion** — support for WAV and other high-quality audio formats.
- **Music Videos** — create visual content synchronized with your audio tracks.
- **Audio Processing** — comprehensive tools for audio enhancement and manipulation.

## AI Models

> ⚠️ Внимание: во всех примерах в этой странице по умолчанию указан `model: 'V3_5'`, хотя в каталоге есть V5 и V5_5. Учитывать при выборе дефолта в нашей интеграции.

| Model      | Highlight             | Notes                                              |
| :--------- | :-------------------- | :------------------------------------------------- |
| `V3_5`     | Better song structure | Max 4 minutes, improved song organization          |
| `V4`       | Improved vocals       | Max 4 minutes, enhanced vocal quality              |
| `V4_5`     | Smart prompts         | Max 8 minutes, faster generation                   |
| `V4_5PLUS` | Richer sound          | Max 8 minutes, new creative ways                   |
| `V4_5ALL`  | Smart and fast        | Max 8 minutes, smarter prompts, faster generations |
| `V5`       | Faster generation     | Max 8 minutes, superior musicality, improved speed |
| `V5_5`     | Unleash Your Voice    | Custom models tailored to your unique taste        |

## Generation Modes

### Parameter Overview

| Parameter      | Type    | Required | Description                                                                        |
| :------------- | :------ | :------- | :--------------------------------------------------------------------------------- |
| `customMode`   | boolean | Yes      | Controls parameter complexity: `false` (Simple Mode) or `true` (Advanced Mode)     |
| `instrumental` | boolean | Yes      | Determines vocal presence: `true` (Instrumental only) or `false` (Includes lyrics) |

### Key Parameters

| Parameter | Type   | Required | Description                                      |
| :-------- | :----- | :------- | :----------------------------------------------- |
| `prompt`  | string | Yes      | Text description used to generate music          |
| `style`   | string | No       | Music style instructions (Custom Mode only)      |
| `title`   | string | No       | Title for the generated music (Custom Mode only) |

### Prompt Character Limits

- **Non-Custom Mode**: 500 characters
- **Custom Mode (V3_5 & V4)**: 3,000 characters
- **Custom Mode (V4_5, V4_5PLUS & V5)**: 5,000 characters

### Style Character Limits

- **V3_5 & V4**: 200 characters
- **V4_5, V4_5PLUS & V5**: 1,000 characters

### Title Character Limit

- **Maximum Length**: 80 characters

## Complete Workflow Example

**JavaScript**

```javascript
class SunoAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = "https://api.kie.ai/api/v1";
  }

  async generateMusic(prompt, options = {}) {
    const response = await fetch(`${this.baseUrl}/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        customMode: options.customMode || false,
        instrumental: options.instrumental || false,
        model: options.model || "V3_5",
        style: options.style,
        title: options.title,
        negativeTags: options.negativeTags,
        callBackUrl: options.callBackUrl || "https://your-app.com/callback",
      }),
    });

    const result = await response.json();
    if (!response.ok || result.code !== 200) {
      throw new Error(`Generation failed: ${result.msg || "Unknown error"}`);
    }

    return result.data.taskId;
  }

  async extendMusic(audioId, options = {}) {
    const response = await fetch(`${this.baseUrl}/generate/extend`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audioId,
        defaultParamFlag: options.defaultParamFlag || false,
        model: options.model || "V3_5",
        prompt: options.prompt,
        style: options.style,
        title: options.title,
        continueAt: options.continueAt,
        callBackUrl: options.callBackUrl || "https://your-app.com/callback",
      }),
    });

    const result = await response.json();
    if (!response.ok || result.code !== 200) {
      throw new Error(`Extension failed: ${result.msg || "Unknown error"}`);
    }

    return result.data.taskId;
  }

  async generateLyrics(prompt, callBackUrl) {
    const response = await fetch(`${this.baseUrl}/lyrics`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        callBackUrl,
      }),
    });

    const result = await response.json();
    if (!response.ok || result.code !== 200) {
      throw new Error(`Lyrics generation failed: ${result.msg || "Unknown error"}`);
    }

    return result.data.taskId;
  }

  async waitForCompletion(taskId, maxWaitTime = 600000) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const status = await this.getTaskStatus(taskId);

      switch (status.status) {
        case "SUCCESS":
          console.log("All tracks generated successfully!");
          return status.response;

        case "FIRST_SUCCESS":
          console.log("First track generation completed!");
          return status.response;

        case "TEXT_SUCCESS":
          console.log("Lyrics/text generation successful!");
          return status.response;

        case "PENDING":
          console.log("Task is pending...");
          break;

        case "CREATE_TASK_FAILED":
          throw new Error(status.errorMessage || "Task creation failed");

        case "GENERATE_AUDIO_FAILED":
          throw new Error(status.errorMessage || "Audio generation failed");

        case "CALLBACK_EXCEPTION":
          throw new Error(status.errorMessage || "Callback process error");

        case "SENSITIVE_WORD_ERROR":
          throw new Error(status.errorMessage || "Content filtered due to sensitive words");

        default:
          console.log(`Unknown status: ${status.status}`);
          if (status.errorMessage) {
            console.error("Error message:", status.errorMessage);
          }
          break;
      }

      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    throw new Error("Generation timeout");
  }

  async getTaskStatus(taskId) {
    const response = await fetch(`${this.baseUrl}/generate/record-info?taskId=${taskId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    const result = await response.json();
    if (!response.ok || result.code !== 200) {
      throw new Error(`Status check failed: ${result.msg || "Unknown error"}`);
    }

    return result.data;
  }
}

async function main() {
  const api = new SunoAPI("YOUR_API_KEY");

  try {
    console.log("Starting music generation...");
    const taskId = await api.generateMusic("A nostalgic folk song about childhood memories", {
      customMode: true,
      instrumental: false,
      model: "V4_5",
      style: "Folk, Acoustic, Nostalgic",
      title: "Childhood Dreams",
    });

    console.log(`Task ID: ${taskId}. Waiting for completion...`);
    const result = await api.waitForCompletion(taskId);

    console.log("Music generated successfully!");
    result.sunoData.forEach((track, index) => {
      console.log(`Track ${index + 1}:`);
      console.log(`  Title: ${track.title}`);
      console.log(`  Audio URL: ${track.audioUrl}`);
      console.log(`  Duration: ${track.duration}s`);
      console.log(`  Tags: ${track.tags}`);
    });

    const firstTrack = result.sunoData[0];
    console.log("\nExtending the first track...");
    const extendTaskId = await api.extendMusic(firstTrack.id, {
      defaultParamFlag: true,
      prompt: "Continue with a hopeful chorus",
      style: "Folk, Uplifting",
      title: "Childhood Dreams Extended",
      continueAt: 60,
      model: "V4_5",
    });

    const extendResult = await api.waitForCompletion(extendTaskId);
    console.log("Music extended successfully!");
    console.log("Extended track URL:", extendResult.sunoData[0].audioUrl);
  } catch (error) {
    console.error("Error:", error.message);
  }
}

main();
```

**Python**

```python
import requests
import time

class SunoAPI:
    def __init__(self, api_key):
        self.api_key = api_key
        self.base_url = 'https://api.kie.ai/api/v1'
        self.headers = {
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json'
        }

    def generate_music(self, prompt, **options):
        data = {
            'prompt': prompt,
            'customMode': options.get('customMode', False),
            'instrumental': options.get('instrumental', False),
            'model': options.get('model', 'V3_5'),
            'callBackUrl': options.get('callBackUrl', 'https://your-app.com/callback')
        }

        if options.get('style'):
            data['style'] = options['style']
        if options.get('title'):
            data['title'] = options['title']
        if options.get('negativeTags'):
            data['negativeTags'] = options['negativeTags']

        response = requests.post(f'{self.base_url}/generate',
                               headers=self.headers, json=data)
        result = response.json()

        if not response.ok or result.get('code') != 200:
            raise Exception(f"Generation failed: {result.get('msg', 'Unknown error')}")

        return result['data']['taskId']

    def extend_music(self, audio_id, **options):
        data = {
            'audioId': audio_id,
            'defaultParamFlag': options.get('defaultParamFlag', False),
            'model': options.get('model', 'V3_5'),
            'callBackUrl': options.get('callBackUrl', 'https://your-app.com/callback')
        }

        if options.get('prompt'):
            data['prompt'] = options['prompt']
        if options.get('style'):
            data['style'] = options['style']
        if options.get('title'):
            data['title'] = options['title']
        if options.get('continueAt'):
            data['continueAt'] = options['continueAt']

        response = requests.post(f'{self.base_url}/generate/extend',
                               headers=self.headers, json=data)
        result = response.json()

        if not response.ok or result.get('code') != 200:
            raise Exception(f"Extension failed: {result.get('msg', 'Unknown error')}")

        return result['data']['taskId']

    def generate_lyrics(self, prompt, callback_url):
        data = {
            'prompt': prompt,
            'callBackUrl': callback_url
        }

        response = requests.post(f'{self.base_url}/lyrics',
                               headers=self.headers, json=data)
        result = response.json()

        if not response.ok or result.get('code') != 200:
            raise Exception(f"Lyrics generation failed: {result.get('msg', 'Unknown error')}")

        return result['data']['taskId']

    def wait_for_completion(self, task_id, max_wait_time=600):
        start_time = time.time()

        while time.time() - start_time < max_wait_time:
            status = self.get_task_status(task_id)

            if status['status'] == 'SUCCESS':
                print("All tracks generated successfully!")
                return status['response']
            elif status['status'] == 'FIRST_SUCCESS':
                print("First track generation completed!")
                return status['response']
            elif status['status'] == 'TEXT_SUCCESS':
                print("Lyrics/text generation successful!")
                return status['response']
            elif status['status'] == 'PENDING':
                print("Task is pending...")
            elif status['status'] == 'CREATE_TASK_FAILED':
                raise Exception(status.get('errorMessage', 'Task creation failed'))
            elif status['status'] == 'GENERATE_AUDIO_FAILED':
                raise Exception(status.get('errorMessage', 'Audio generation failed'))
            elif status['status'] == 'CALLBACK_EXCEPTION':
                raise Exception(status.get('errorMessage', 'Callback process error'))
            elif status['status'] == 'SENSITIVE_WORD_ERROR':
                raise Exception(status.get('errorMessage', 'Content filtered due to sensitive words'))
            else:
                print(f"Unknown status: {status['status']}")
                if status.get('errorMessage'):
                    print(f"Error message: {status['errorMessage']}")

            time.sleep(10)

        raise Exception('Generation timeout')

    def get_task_status(self, task_id):
        response = requests.get(f'{self.base_url}/generate/record-info?taskId={task_id}',
                              headers={'Authorization': f'Bearer {self.api_key}'})
        result = response.json()

        if not response.ok or result.get('code') != 200:
            raise Exception(f"Status check failed: {result.get('msg', 'Unknown error')}")

        return result['data']

def main():
    api = SunoAPI('YOUR_API_KEY')

    try:
        print('Starting music generation...')
        task_id = api.generate_music(
            'A nostalgic folk song about childhood memories',
            customMode=True,
            instrumental=False,
            model='V4_5',
            style='Folk, Acoustic, Nostalgic',
            title='Childhood Dreams'
        )

        print(f'Task ID: {task_id}. Waiting for completion...')
        result = api.wait_for_completion(task_id)

        print('Music generated successfully!')
        for i, track in enumerate(result['sunoData']):
            print(f"Track {i + 1}:")
            print(f"  Title: {track['title']}")
            print(f"  Audio URL: {track['audioUrl']}")
            print(f"  Duration: {track['duration']}s")
            print(f"  Tags: {track['tags']}")

        first_track = result['sunoData'][0]
        print('\nExtending the first track...')
        extend_task_id = api.extend_music(
            first_track['id'],
            defaultParamFlag=True,
            prompt='Continue with a hopeful chorus',
            style='Folk, Uplifting',
            title='Childhood Dreams Extended',
            continueAt=60,
            model='V4_5'
        )

        extend_result = api.wait_for_completion(extend_task_id)
        print('Music extended successfully!')
        print(f"Extended track URL: {extend_result['sunoData'][0]['audioUrl']}")

    except Exception as error:
        print(f'Error: {error}')

if __name__ == '__main__':
    main()
```

## Advanced Features

### Boost Music Style (V4_5 Models)

Enhance your style descriptions for better results.

```javascript
const response = await fetch("https://api.kie.ai/api/v1/style/generate", {
  method: "POST",
  headers: {
    Authorization: "Bearer YOUR_API_KEY",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    content: "Pop, Mysterious",
  }),
});

const result = await response.json();
console.log("Enhanced style:", result.data.result);
```

### Audio Processing Features

**Convert to WAV**

```javascript
const response = await fetch("https://api.kie.ai/api/v1/wav/generate", {
  method: "POST",
  headers: {
    Authorization: "Bearer YOUR_API_KEY",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    taskId: "YOUR_TASK_ID",
    audioId: "YOUR_AUDIO_ID",
    callBackUrl: "https://your-app.com/callback",
  }),
});
```

**Separate Vocals**

```javascript
const response = await fetch("https://api.kie.ai/api/v1/vocal-removal/generate", {
  method: "POST",
  headers: {
    Authorization: "Bearer YOUR_API_KEY",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    taskId: "YOUR_TASK_ID",
    audioId: "YOUR_AUDIO_ID",
    callBackUrl: "https://your-app.com/callback",
  }),
});
```

**Create Music Video**

```javascript
const response = await fetch("https://api.kie.ai/api/v1/mp4/generate", {
  method: "POST",
  headers: {
    Authorization: "Bearer YOUR_API_KEY",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    taskId: "YOUR_TASK_ID",
    audioId: "YOUR_AUDIO_ID",
    author: "Your Name",
    domainName: "your-app.com",
    callBackUrl: "https://your-app.com/callback",
  }),
});
```

### Async Processing with Callbacks

Set up webhook callbacks for automatic notifications.

```javascript
const taskId = await api.generateMusic("Upbeat electronic dance music", {
  customMode: false,
  instrumental: true,
  model: "V4_5",
  callBackUrl: "https://your-server.com/suno-callback",
});

// Your callback endpoint will receive:
app.post("/suno-callback", (req, res) => {
  const { code, data } = req.body;

  if (code === 200 && data.callbackType === "complete") {
    console.log("Music ready:", data.data);
    data.data.forEach((track) => {
      console.log("Track:", track.audio_url);
    });
  }

  res.status(200).json({ status: "received" });
});
```

> See `/suno-api/generate-music-callbacks` for the complete guide to implementing and handling Suno API callbacks.

## Status Codes & Task States

| Status                  | Description                                             |
| :---------------------- | :------------------------------------------------------ |
| `PENDING`               | Task is waiting to be processed or currently generating |
| `TEXT_SUCCESS`          | Lyrics/text generation completed successfully           |
| `FIRST_SUCCESS`         | First track generation completed                        |
| `SUCCESS`               | All tracks generated successfully                       |
| `CREATE_TASK_FAILED`    | Failed to create task                                   |
| `GENERATE_AUDIO_FAILED` | Failed to generate audio                                |
| `SENSITIVE_WORD_ERROR`  | Content filtered due to sensitive words                 |

## Best Practices

### Prompt Engineering

- Be specific about genre, mood, and instruments.
- Use descriptive adjectives for better style control.
- Include tempo and energy level descriptions.
- Reference musical eras or specific artists for style guidance.

### Model Selection

- `V3_5` — best for structured songs with clear verse/chorus patterns.
- `V4` — choose when vocal quality is most important.
- `V4_5` — use for faster generation and smart prompt handling.
- `V4_5PLUS` — select for the highest quality and longest tracks.
- `V5` — faster generation with superior musicality and improved speed.

### Performance Optimization

- Use callbacks instead of frequent polling.
- Start with non-custom mode for simpler requirements.
- Implement proper error handling for failed generations.
- Cache generated content since files expire after 14 days.

### Content Guidelines

- Avoid copyrighted material in prompts.
- Use original lyrics and musical descriptions.
- Be mindful of content policies for lyrical content.
- Test prompt variations to avoid sensitive word filters.

## Error Handling

> ⚠️ Внимание: в примерах ниже используется `error.data.code` — у обычного `fetch` исключение такого shape не имеет. Это код из их доков, в нашей обвязке так писать нельзя — обрабатывать ошибки по `response.status` / телу ответа.

**Content Policy Violations (Code 400)**

```javascript
try {
  const taskId = await api.generateMusic("copyrighted song lyrics");
} catch (error) {
  if (error.data.code === 400) {
    console.log("Please use original content only");
  }
}
```

**Insufficient Credits (Code 402)**

```javascript
try {
  const taskId = await api.generateMusic("original composition");
} catch (error) {
  if (error.data.code === 402) {
    console.log("Please add more credits to your account");
  }
}
```

**Rate Limiting (Code 429)**

```javascript
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateWithRetry(prompt, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await api.generateMusic(prompt, options);
    } catch (error) {
      if (error.data.code === 429 && i < maxRetries - 1) {
        await delay(Math.pow(2, i) * 1000); // Exponential backoff
        continue;
      }
      throw error;
    }
  }
}
```

## Support

- **Email**: [support@kie.ai](mailto:support@kie.ai)
- **Documentation**: [docs.kie.ai](https://docs.kie.ai)
- **API Status**: see status page for real-time API health

---

Ready to start creating? [Get your API key](https://kie.ai/api-key).
