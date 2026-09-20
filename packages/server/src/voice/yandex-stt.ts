/**
 * One request to Yandex SpeechKit's short-recognition endpoint.
 *
 * Adapted from the manager-bot's client in the sibling product, which has been
 * carrying this traffic for a while: the same retriable-status set, the same
 * bounded exponential backoff with jitter, the same refusal to retry a refusal.
 * What is NOT carried over is its per-user hourly quota — that bot serves the
 * public and this one serves one operator, so a quota here would only ever fire
 * on the person it exists to help.
 *
 * The endpoint's limits are the reason everything upstream chunks: one request
 * takes at most thirty seconds and a megabyte of audio.
 */

import { createLogger } from '@archon/paths';
import type { YandexAudioFormat } from './audio-format';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server.voice.yandex');
  return cachedLog;
}

const DEFAULT_ENDPOINT = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize';

export interface YandexSttOptions {
  /** Service-account API key. Never logged, never put in a message. */
  readonly apiKey: string;
  readonly folderId: string;
  /** BCP-47, e.g. `ru-RU`. */
  readonly lang: string;
  readonly format: YandexAudioFormat;
  /** Required for `lpcm`, meaningless for the container formats. */
  readonly sampleRateHertz?: number;
  readonly signal?: AbortSignal;
  readonly retryAttempts?: number;
  readonly retryInitialDelayMs?: number;
  readonly timeoutMs?: number;
  /** Overridden only by tests; production always talks to Yandex. */
  readonly endpoint?: string;
}

export class YandexSttError extends Error {
  readonly status: number | undefined;
  readonly retriable: boolean;
  constructor(message: string, status: number | undefined, retriable: boolean) {
    super(message);
    this.name = 'YandexSttError';
    this.status = status;
    this.retriable = retriable;
  }
}

/** Congestion and outage, never a rejection: a 400 says the audio is wrong. */
function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal === undefined) return;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function buildUrl(endpoint: string, params: Record<string, string | undefined>): string {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value);
  }
  return url.toString();
}

interface RecognizeResponse {
  result?: string;
  error_code?: string;
  error_message?: string;
}

async function recognizeOnce(audio: Uint8Array, opts: YandexSttOptions): Promise<string> {
  const url = buildUrl(opts.endpoint ?? DEFAULT_ENDPOINT, {
    folderId: opts.folderId,
    lang: opts.lang,
    format: opts.format,
    sampleRateHertz:
      opts.format === 'lpcm' && opts.sampleRateHertz !== undefined
        ? String(opts.sampleRateHertz)
        : undefined,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? 20_000);
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) controller.abort();
    else
      opts.signal.addEventListener(
        'abort',
        () => {
          controller.abort();
        },
        { once: true }
      );
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Api-Key ${opts.apiKey}`,
        'Content-Type': 'application/octet-stream',
      },
      body: audio,
      signal: controller.signal,
    });
  } catch (err) {
    // A network failure carries no status, so treat it as worth another go.
    throw new YandexSttError(
      `speech recognition could not be reached: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      true
    );
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw new YandexSttError(
      `speech recognition failed: ${String(response.status)} ${bodyText.slice(0, 200)}`,
      response.status,
      isRetriableStatus(response.status)
    );
  }

  let parsed: RecognizeResponse;
  try {
    parsed = JSON.parse(bodyText) as RecognizeResponse;
  } catch {
    throw new YandexSttError(
      `speech recognition returned something that is not JSON: ${bodyText.slice(0, 200)}`,
      response.status,
      false
    );
  }
  if (parsed.error_code !== undefined || parsed.error_message !== undefined) {
    throw new YandexSttError(
      `speech recognition refused the audio: ${parsed.error_code ?? ''} ${parsed.error_message ?? ''}`.trim(),
      response.status,
      false
    );
  }
  return (parsed.result ?? '').trim();
}

/**
 * Recognise one chunk, retrying only what is worth retrying.
 *
 * The delay grows exponentially with a little jitter so several chunks failing
 * at once do not march back in lockstep, and an aborted signal ends the wait
 * rather than sleeping through a cancellation.
 */
export async function recognizeShort(
  audio: Uint8Array,
  opts: YandexSttOptions
): Promise<string> {
  const maxAttempts = (opts.retryAttempts ?? 2) + 1;
  const initialDelay = opts.retryInitialDelayMs ?? 500;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await recognizeOnce(audio, opts);
    } catch (err) {
      lastError = err;
      const retriable = err instanceof YandexSttError ? err.retriable : true;
      if (!retriable || attempt === maxAttempts) break;
      const jitter = Math.random() * 0.3 + 0.85;
      const delay = Math.round(initialDelay * Math.pow(2, attempt - 1) * jitter);
      getLog().warn({ attempt, delay }, 'voice.stt_retry');
      await sleep(delay, opts.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('speech recognition failed');
}
