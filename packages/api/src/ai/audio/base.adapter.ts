export interface AudioInput {
  /** Text to synthesize / describe (music prompt, sound description, etc.) */
  prompt: string;
  /** Optional: voice ID for TTS / voice-clone */
  voiceId?: string;
  /** Optional: source audio URL for voice cloning */
  sourceAudioUrl?: string;
  /** User-configured model settings (voice, speed, stability, etc.). Each adapter picks what it supports. */
  modelSettings?: Record<string, unknown>;
}

export interface AudioResult {
  /** Raw audio bytes — returned by sync providers (OpenAI TTS, ElevenLabs). */
  buffer?: Buffer;
  /** Provider URL — returned by async providers after polling. */
  url?: string;
  /** File extension: 'mp3' | 'wav' | 'ogg' */
  ext: string;
  /** MIME type: 'audio/mpeg' | 'audio/wav' | 'audio/ogg' */
  contentType: string;
  /**
   * Какой провайдер фактически выдал результат, если это не primary. Ставится
   * адаптером при фолбэке: `KieElevenLabsAdapter` помечает `"elevenlabs"`, когда
   * генерация на kie упала и сработал прямой ElevenLabs. Процессор пишет это
   * в audit-поле `actualProvider` `TokenTransaction`.
   */
  actualProvider?: string;
  /**
   * Optional: дополнительные треки, сгенерированные тем же запросом.
   * Suno за один запрос возвращает 2 трека — первый кладём в основной
   * `AudioResult`, остальные в `extras`. Worker сохраняет каждый как отдельный
   * `GenerationJobOutput` и шлёт пользователю отдельным сообщением.
   */
  extras?: Array<Omit<AudioResult, "extras">>;
}

/**
 * Sync adapter: generate() returns the result directly (buffer or URL).
 * Async adapter: submit() queues the job; poll() checks for completion.
 */
export interface AudioAdapter {
  readonly modelId: string;
  readonly isAsync: boolean;
  /** Sync generation. Only implemented on sync adapters. */
  generate?(input: AudioInput): Promise<AudioResult>;
  /** Submit async job. Returns provider-side job ID. */
  submit?(input: AudioInput): Promise<string>;
  /**
   * Poll async result. Returns null if still processing.
   *
   * Опциональный `input` нужен адаптерам с фолбэком: `KieElevenLabsAdapter` при
   * сбое kie генерит на прямом ElevenLabs из того же `AudioInput`. Async-адаптеры
   * без фолбэка (Suno) второй параметр игнорируют — сигнатура совместима.
   */
  poll?(jobId: string, input?: AudioInput): Promise<AudioResult | null>;
}
