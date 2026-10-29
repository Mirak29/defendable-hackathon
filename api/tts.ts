// Oracle's voice, made on the server: Kokoro-82M (Apache-2.0) in full
// precision on the CPU. The browser downloads nothing: it receives each
// sentence as 16-bit PCM, 24 kHz, and plays it. Measured on 8 cores, a
// sentence takes about a third of its own length to make (README), so the next
// one is ready before the current one ends. When the model is not loaded (no
// weights yet, TTS=off, an error) the interview falls back to the browser's
// voice.
import { ENV } from '@01edu/api/env'
import { log } from '/api/lib/log.ts'

export const ttsConfig = {
  enabled: ENV('TTS', 'on') !== 'off',
  model: ENV('TTS_MODEL', 'onnx-community/Kokoro-82M-v1.0-ONNX'),
  voice: ENV('TTS_VOICE', 'af_heart'),
}

type Engine = {
  generate: (
    text: string,
    options: { voice: string },
  ) => Promise<{ audio: Float32Array; sampling_rate: number }>
}

let engine: Promise<Engine | undefined> | undefined
let loaded = false
/** one sentence at a time: the model already uses every core */
let queue: Promise<unknown> = Promise.resolve()

const load = async (): Promise<Engine | undefined> => {
  const started = performance.now()
  try {
    const { KokoroTTS } = await import('kokoro-js')
    const model = await KokoroTTS.from_pretrained(ttsConfig.model, {
      dtype: 'fp32',
      device: 'cpu',
    }) as unknown as Engine
    // the first run is the slow one: it happens before anybody waits for it
    await model.generate('Hello.', { voice: ttsConfig.voice })
    loaded = true
    log.info('tts-ready', { ms: Math.round(performance.now() - started) })
    return model
  } catch (err) {
    log.warn('tts-unavailable', { message: String(err) })
    return undefined
  }
}

/** loads the model in the background; true once it can speak */
const warmUp = (): Promise<boolean> => {
  if (!ttsConfig.enabled) return Promise.resolve(false)
  engine ??= load()
  return engine.then((e) => !!e)
}

const base64 = (bytes: Uint8Array) => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** float samples (-1 to 1) as little-endian 16-bit PCM, in base64 */
export const pcmBase64 = (samples: Float32Array) => {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 32767
  }
  return base64(new Uint8Array(pcm.buffer))
}

/**
 * The sound of a sentence (PCM 16-bit mono 24 kHz in base64), or undefined
 * when it cannot be made: the browser then reads it. `alive` is asked just
 * before the work starts, so a sentence nobody waits for any more costs nothing.
 */
const synthesize = (
  text: string,
  alive: () => boolean = () => true,
): Promise<string | undefined> => {
  const job = queue.then(async () => {
    if (!alive()) return undefined
    const model = await engine
    if (!model) return undefined
    try {
      const out = await model.generate(text, { voice: ttsConfig.voice })
      return pcmBase64(out.audio)
    } catch (err) {
      log.warn('tts-failed', { message: String(err) })
      return undefined
    }
  })
  queue = job.catch(() => {})
  return job
}

/** an object so a test can stand in for the model */
export const tts = { loaded: () => loaded, warmUp, synthesize }
