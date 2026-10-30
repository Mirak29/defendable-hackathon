// Oracle's voice, made on the server: Meta's MMS-TTS (facebook/mms-tts-eng,
// VITS, 36 M parameters, CC-BY-NC 4.0) in full precision on the CPU, through
// Transformers.js. The weights are the ONNX conversion of that Meta model
// published by Hugging Face (Xenova/mms-tts-eng). The browser downloads
// nothing: it receives each sentence as 16-bit PCM at the rate of the model
// (16 kHz, announced to it in the `ready` event) and plays it. When the model
// is not loaded (no weights yet, TTS=off, an error) the interview falls back
// to the browser's voice.
import { ENV } from '@01edu/api/env'
import { encodeBase64 } from 'jsr:@std/encoding/base64'
import { log } from '/api/lib/log.ts'
import { makeQueue } from '/api/lib/make-queue.ts'

const config = {
  enabled: ENV('TTS', 'on') !== 'off',
  model: ENV('TTS_MODEL', 'Xenova/mms-tts-eng'),
}

/** a sentence as samples (-1 to 1) at the rate of the model */
type Synthesizer = (text: string) => Promise<Float32Array>

let loading: Promise<void> | undefined
let engine: Synthesizer | undefined
/** samples per second of the sound the model makes */
let rate = 0
/** the weights were not on the disk: they were fetched from the network */
let downloaded = false
/** one sentence at a time: the model already uses every core */
const nextSlot = makeQueue(1)

const load = async () => {
  const started = performance.now()
  try {
    const { AutoTokenizer, VitsModel } = await import(
      '@huggingface/transformers'
    )
    // The weights are in the image: look at the disk only, so the server starts
    // on a machine without Internet. Only a machine that has no weights yet
    // (development) downloads them. The tokenizer and the model are loaded
    // directly: the `text-to-speech` pipeline also asks for a processor
    // configuration this repository does not have, which fails when offline.
    const options = { dtype: 'fp32', device: 'cpu' }
    const localFirst = <T>(from: (options: object) => Promise<T>) =>
      from({ ...options, local_files_only: true }).catch((err) => {
        log.info('tts-download', { reason: String(err) })
        downloaded = true
        return from(options)
      })
    const tokenizer = await localFirst((o) =>
      AutoTokenizer.from_pretrained(config.model, o)
    )
    const vits = await localFirst((o) =>
      VitsModel.from_pretrained(config.model, o)
    )
    const model: Synthesizer = async (text) =>
      (await vits(tokenizer(text))).waveform.data as Float32Array
    rate = (vits.config as unknown as { sampling_rate: number }).sampling_rate
    // the first run is the slow one: it happens before anybody waits for it
    await model('Hello.')
    engine = model
    log.info('tts-ready', { ms: Math.round(performance.now() - started) })
  } catch (err) {
    log.warn('tts-unavailable', { message: String(err) })
  }
}

/** loads the model in the background */
const warmUp = () => {
  if (config.enabled) loading ??= load()
}

const ONES = ('zero one two three four five six seven eight nine ten eleven ' +
  'twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen')
  .split(' ')
// no entry for 0 and 1: the two leading spaces
const TENS = '  twenty thirty forty fifty sixty seventy eighty ninety'.split(
  ' ',
)
const SCALES = [
  [1e9, 'billion'],
  [1e6, 'million'],
  [1e3, 'thousand'],
  [100, 'hundred'],
] as const

/** 42 → "forty two" (the model has no digits in its alphabet) */
const words = (n: number): string => {
  if (n < 20) return ONES[n]
  if (n < 100) {
    return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '')
  }
  const [size, name] = SCALES.find(([size]) => n >= size)!
  const rest = n % size
  return `${words(Math.floor(n / size))} ${name}${
    rest ? ` ${words(rest)}` : ''
  }`
}

/** "2024" → "two zero two four" */
const digits = (text: string) => [...text].map((d) => ONES[+d]).join(' ')

/**
 * The text as the model can say it: the alphabet of MMS-TTS has no digits and
 * no symbols, and it drops what it does not know ("401" would be skipped,
 * "user_id" would be read "userid").
 */
export const speakable = (text: string) =>
  text
    // 401, 2,500 and 0.25 are one number each; the comma of "401," is not
    .replace(/\d+(?:,\d{3})*(?:\.\d+)?/g, (token) => {
      const [whole, decimals] = token.replaceAll(',', '').split('.')
      const spoken = whole.length > 12 ? digits(whole) : words(Number(whole))
      return decimals ? `${spoken} point ${digits(decimals)}` : spoken
    })
    .replaceAll('%', ' percent')
    .replaceAll('&', ' and ')
    .replace(/[^A-Za-z' ,.!?;:-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** float samples (-1 to 1) as little-endian 16-bit PCM, in base64 */
const pcmBase64 = (samples: Float32Array) => {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 32767
  }
  return encodeBase64(new Uint8Array(pcm.buffer))
}

/**
 * The sound of a sentence (PCM 16-bit mono at `rate()`, in base64), or undefined
 * when it cannot be made: the browser then reads it. `alive` is asked just
 * before the work starts, so a sentence nobody waits for any more costs nothing.
 */
const synthesize = async (
  text: string,
  alive: () => boolean,
): Promise<string | undefined> => {
  using _slot = await nextSlot()
  if (!alive()) return undefined
  await loading
  if (!engine) return undefined
  try {
    return pcmBase64(await engine(speakable(text)))
  } catch (err) {
    log.warn('tts-failed', { message: String(err) })
    return undefined
  }
}

/** an object so a test can stand in for the model */
export const tts = {
  loaded: () => !!engine,
  rate: () => rate,
  downloaded: () => downloaded,
  warmUp,
  synthesize,
}
