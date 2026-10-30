// The browser side of the voice interview: the microphone as PCM 24 kHz sent
// over a WebSocket, the events of the interview, and the interviewer's words
// read aloud as they are written. Module-level signals, like the other stores.
import { signal } from '@preact/signals'
import { isEcho } from '/web/lib/echo.ts'
import type { TurnMetrics, VoiceEvent } from '/api/voice.ts'

export type Line = { who: 'ai' | 'you'; text: string; interrupted?: boolean }
/** the delays a listener feels, with the one only the browser knows */
export type Delays = TurnMetrics & { heardToVoiceMs?: number }

export const voice = {
  status: signal<'idle' | 'connecting' | 'live' | 'ended' | 'error'>('idle'),
  lines: signal<Line[]>([]),
  /** what the candidate is saying right now */
  partial: signal(''),
  /** what the interviewer is writing right now */
  writing: signal(''),
  /** the interviewer's voice is playing */
  speaking: signal(false),
  /** the candidate is speaking */
  listening: signal(false),
  delays: signal<Delays[]>([]),
  error: signal(''),
  /** microphone level, 0 to 1 */
  level: signal(0),
  /** how loud Oracle's own voice is now, 0 to 1 (0: the voice cannot be read) */
  amplitude: signal(0),
  /** the sentence being spoken and how far the voice is in it (lip sync) */
  speech: signal({ text: '', charIndex: 0, at: 0 }),
}

// 80 ms of 24 kHz mono 16-bit audio: the pace the transcription expects
const FRAME_SAMPLES = 1920

/** runs in the audio thread: resamples the microphone to 24 kHz PCM 16-bit */
const WORKLET = `
class Pcm extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / 24000
    this.pos = 0
    this.carry = new Float32Array(0)
    this.out = new Int16Array(${FRAME_SAMPLES})
    this.n = 0
  }
  process(inputs) {
    const input = inputs[0][0]
    if (!input) return true
    let level = 0
    for (let i = 0; i < input.length; i++) level = Math.max(level, Math.abs(input[i]))
    const samples = new Float32Array(this.carry.length + input.length)
    samples.set(this.carry)
    samples.set(input, this.carry.length)
    let pos = this.pos
    while (pos + 1 < samples.length) {
      const i = Math.floor(pos)
      const frac = pos - i
      const v = samples[i] * (1 - frac) + samples[i + 1] * frac
      this.out[this.n++] = Math.max(-1, Math.min(1, v)) * 32767
      if (this.n === ${FRAME_SAMPLES}) {
        const pcm = this.out.slice().buffer
        this.port.postMessage({ pcm, level }, [pcm])
        this.n = 0
      }
      pos += this.ratio
    }
    const keep = Math.floor(pos)
    this.carry = samples.slice(keep)
    this.pos = pos - keep
    return true
  }
}
registerProcessor('pcm', Pcm)
`

type Session = {
  socket: WebSocket
  context: AudioContext
  stream: MediaStream
}
let session: Session | undefined
/** where the voice made by the server is played, and measured */
let playback:
  | { context: AudioContext; gain: GainNode; analyser: AnalyserNode }
  | undefined

/* ---------- the interviewer's voice ---------- */

/** the server makes the voice (the browser's is the fallback) */
let serverVoice = false

let spokenBuffer = ''
/** what the interviewer said or is saying: the microphone may hear it back */
let said = ''
/**
 * Chrome drops an utterance nobody references and stops speaking in the
 * middle of a sentence: they are kept until they end.
 */
const playing = new Set<SpeechSynthesisUtterance>()
/** when the last turn of the candidate ended: the voice is timed from there */
let heardAt = 0
let awaitingVoice = false

const pickVoice = () => {
  const voices = speechSynthesis.getVoices().filter((v) =>
    v.lang.toLowerCase().startsWith('en')
  )
  return voices.find((v) => /natural|neural|google/i.test(v.name)) ??
    voices.find((v) => v.lang === 'en-US') ?? voices[0]
}

/** the first sound of an answer: the delay the candidate felt */
const voiceStarted = (text: string) => {
  voice.speaking.value = true
  voice.speech.value = { text, charIndex: 0, at: performance.now() }
  if (awaitingVoice && heardAt) {
    awaitingVoice = false
    const last = voice.delays.value.at(-1)
    if (last && last.heardToVoiceMs === undefined) {
      const heardToVoiceMs = Math.round(performance.now() - heardAt)
      voice.delays.value = [...voice.delays.value.slice(0, -1), {
        ...last,
        heardToVoiceMs,
      }]
    }
  }
}

/* the voice of the server: sentences of PCM at the rate it announces in `ready`, played one after another */
let speechRate = 0
let playingFrom = 0
const sounds = new Set<AudioBufferSourceNode>()
let meter: ReturnType<typeof setInterval> | undefined
/** runs when the last sentence has been played (the end of an interview) */
let whenSilent: (() => void) | undefined

/** how loud the voice is now: it moves the presence of Oracle */
const measure = () => {
  const analyser = playback?.analyser
  if (!analyser) return
  samples ??= new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(samples)
  let sum = 0
  for (const s of samples) sum += s * s
  voice.amplitude.value = Math.min(1, Math.sqrt(sum / samples.length) * 4.5)
}
let samples: Float32Array<ArrayBuffer> | undefined

const stopMeter = () => {
  clearInterval(meter)
  meter = undefined
  voice.amplitude.value = 0
}

const stopSounds = () => {
  for (const sound of sounds) {
    sound.onended = null
    try {
      sound.stop()
    } catch { /* never started */ }
  }
  sounds.clear()
  playingFrom = 0
  stopMeter()
}

const playPcm = (text: string, base64: string) => {
  if (!playback || !speechRate) return
  const { context, gain } = playback
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i)
  const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1)
  const buffer = context.createBuffer(1, pcm.length, speechRate)
  const channel = buffer.getChannelData(0)
  for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768
  const sound = context.createBufferSource()
  sound.buffer = buffer
  sound.connect(gain)
  // right after the sentence before it, with no gap and no overlap
  const at = Math.max(context.currentTime + 0.02, playingFrom)
  playingFrom = at + buffer.duration
  sounds.add(sound)
  sound.onended = () => {
    sounds.delete(sound)
    if (sounds.size) return
    voice.speaking.value = false
    stopMeter()
    whenSilent?.()
  }
  if (context.state === 'suspended') context.resume()
  sound.start(at)
  if (!meter) meter = setInterval(measure, 40)
  setTimeout(() => {
    if (sounds.has(sound)) voiceStarted(text)
  }, Math.max(0, (at - context.currentTime) * 1000))
}

const speak = (text: string) => {
  const clean = text.trim()
  if (!clean) return
  const utterance = new SpeechSynthesisUtterance(clean)
  const chosen = pickVoice()
  if (chosen) utterance.voice = chosen
  utterance.lang = 'en-US'
  utterance.rate = 1.05
  utterance.onstart = () => voiceStarted(clean)
  // not every voice reports its words: the face then follows the clock
  utterance.onboundary = (e) => {
    voice.speech.value = {
      text: clean,
      charIndex: e.charIndex,
      at: performance.now(),
    }
  }
  utterance.onend = () => {
    if (!speechSynthesis.speaking && !speechSynthesis.pending) {
      voice.speaking.value = false
    }
  }
  playing.add(utterance)
  const release = () => playing.delete(utterance)
  utterance.addEventListener('end', release)
  utterance.addEventListener('error', release)
  speechSynthesis.speak(utterance)
}

/** words are spoken sentence by sentence, as soon as a sentence is complete */
const speakPieces = (delta: string, flush = false) => {
  spokenBuffer += delta
  for (;;) {
    const m = spokenBuffer.match(/^([\s\S]*?[.!?])\s+/)
    if (!m) break
    speak(m[1])
    spokenBuffer = spokenBuffer.slice(m[0].length)
  }
  if (flush) {
    speak(spokenBuffer)
    spokenBuffer = ''
  }
}

const silence = () => {
  spokenBuffer = ''
  stopSounds()
  speechSynthesis.cancel()
  playing.clear()
  voice.speaking.value = false
}

/* ---------- the events of the interview ---------- */

const onEvent = (event: VoiceEvent) => {
  switch (event.type) {
    case 'ready':
      serverVoice = event.voice === 'server'
      speechRate = event.rate ?? 0
      // back after a reload: what was said is shown again
      voice.lines.value = (event.history ?? []).map((l) => ({
        who: l.who === 'ai' ? 'ai' : 'you',
        text: l.text,
        interrupted: l.interrupted,
      }))
      voice.status.value = 'live'
      break
    case 'speech':
      // the sound made by the server, or the text alone when it could not
      if (event.pcm) playPcm(event.text, event.pcm)
      else speak(event.text)
      break
    case 'speech-start':
      // a sound only: the interviewer stops when words that are not its own
      // arrive (below), not at a breath or at its own echo
      voice.listening.value = true
      break
    case 'speech-end':
      voice.listening.value = false
      heardAt = performance.now()
      awaitingVoice = true
      break
    case 'partial':
      voice.partial.value = event.text
      if ((voice.speaking.value || spokenBuffer) && !isEcho(event.text, said)) {
        silence()
      }
      break
    case 'heard':
      voice.partial.value = ''
      if (event.text) {
        const last = voice.lines.value.at(-1)
        // the turn goes on the one just before it: one line, not two
        voice.lines.value = event.merge && last?.who === 'you'
          ? [...voice.lines.value.slice(0, -1), {
            who: 'you',
            text: event.text,
          }]
          : [...voice.lines.value, { who: 'you', text: event.text }]
      }
      break
    case 'ai-delta':
      if (!voice.writing.value) said = ''
      said += event.text
      voice.writing.value += event.text
      if (!serverVoice) speakPieces(event.text)
      break
    case 'ai-done':
      if (!event.interrupted && !serverVoice) speakPieces('', true)
      voice.writing.value = ''
      if (event.text) {
        voice.lines.value = [...voice.lines.value, {
          who: 'ai',
          text: event.text,
          interrupted: event.interrupted,
        }]
      }
      break
    case 'metrics':
      voice.delays.value = [...voice.delays.value, event.metrics]
      break
    case 'end':
      voice.status.value = 'ended'
      break
    case 'error':
      voice.error.value = event.message
      voice.status.value = 'error'
      break
  }
}

/* ---------- start and stop ---------- */

export const startVoice = async () => {
  if (session) return
  voice.lines.value = []
  voice.delays.value = []
  voice.partial.value = ''
  voice.writing.value = ''
  voice.error.value = ''
  voice.status.value = 'connecting'
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    const context = new AudioContext()
    const module = URL.createObjectURL(
      new Blob([WORKLET], { type: 'text/javascript' }),
    )
    await context.audioWorklet.addModule(module)
    URL.revokeObjectURL(module)

    const url = new URL('api/voice', document.baseURI)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    socket.onmessage = (e) => onEvent(JSON.parse(e.data))
    socket.onclose = () => {
      if (voice.status.value === 'connecting') {
        voice.error.value = 'The interview could not be opened (signed in?).'
        voice.status.value = 'error'
      }
      // over by itself: the last sentence is still being spoken, let it end
      stopVoice(false, voice.status.value === 'ended')
    }

    const source = context.createMediaStreamSource(stream)
    const pcm = new AudioWorkletNode(context, 'pcm')
    pcm.port.onmessage = (e) => {
      voice.level.value = e.data.level
      if (socket.readyState === WebSocket.OPEN) socket.send(e.data.pcm)
    }
    source.connect(pcm)
    // the voice of the server: played here, and measured to move the presence
    const gain = context.createGain()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    gain.connect(analyser)
    analyser.connect(context.destination)
    serverVoice = false
    session = { socket, context, stream }
    playback = { context, gain, analyser }
    // the voices of the browser load late: ask once so the first sentence has one
    speechSynthesis.getVoices()
  } catch (err) {
    voice.error.value = err instanceof Error ? err.message : String(err)
    voice.status.value = 'error'
    stopVoice(false)
  }
}

export const stopVoice = (tell = true, keepVoice = false) => {
  if (!keepVoice) silence()
  const current = session
  session = undefined
  if (!current) return
  if (tell && current.socket.readyState === WebSocket.OPEN) {
    current.socket.send(JSON.stringify({ type: 'stop' }))
  }
  current.socket.close()
  current.stream.getTracks().forEach((t) => t.stop())
  // the last sentence of an interview that is over is still being played
  const closeContext = () => {
    whenSilent = undefined
    if (playback?.context === current.context) playback = undefined
    current.context.close().catch(() => {})
  }
  if (sounds.size) whenSilent = closeContext
  else closeContext()
  voice.listening.value = false
  voice.level.value = 0
  if (voice.status.value === 'live' || voice.status.value === 'connecting') {
    voice.status.value = 'idle'
  }
}
