// The voice interview: a WebSocket between the browser and the server.
//
//   browser ──mic (PCM 24 kHz)──▶ server ──▶ Muse Voice Transcribe (realtime)
//   browser ◀── events ───────── server ◀── turns ── the model hears the end of
//                                  │                  each turn (ENDPOINTING)
//                                  └──▶ Muse Spark: the next question, streamed
//
// The key never reaches the browser. The model of the transcription detects
// when the candidate stops speaking; the interviewer answers at once, and the
// browser reads the answer aloud as it is written. When the candidate speaks
// over the interviewer (speech starts while the answer is being written), the
// answer is cancelled and what was said so far goes into the conversation.
import { ENV } from '@01edu/api/env'
import { converse, hasAiKey, llmConfig, type Message } from '/api/llm.ts'
import { log } from '/api/lib/log.ts'
import { isEcho } from '/web/lib/echo.ts'
import type { InterviewLine } from '/web/types.ts'
import { decodeSession } from '/api/member.ts'
import {
  END_MARKER,
  INTERVIEW_START,
  type InterviewFacts,
  interviewSystem,
} from '/api/prompts.ts'

/** mutable so tests can point the session at a local mock */
export const voiceConfig = {
  asrUrl: ENV('MODEL_ASR_URL', 'wss://api.meta.ai/v1/asr/realtime'),
  asrModel: ENV('MODEL_ASR_MODEL', 'muse-voice-transcribe-1.0'),
  /** audio waiting for the handshake, at most (24 kHz × 2 bytes × seconds) */
  maxBufferedBytes: 24_000 * 2 * 4,
  /** questions asked before the interviewer closes */
  questions: 6,
}

/** what the browser receives */
export type VoiceEvent =
  | { type: 'ready' }
  | { type: 'speech-start' }
  | { type: 'speech-end' }
  /** what is being said, replaced at each update */
  | { type: 'partial'; text: string }
  /** the final words of a turn of the candidate */
  | { type: 'heard'; turnId: number; text: string }
  | { type: 'ai-delta'; text: string }
  | { type: 'ai-done'; text: string; interrupted: boolean }
  | { type: 'metrics'; metrics: TurnMetrics }
  | { type: 'end' }
  | { type: 'error'; message: string }

/** the delays a listener feels, in ms, for one turn of the candidate */
export type TurnMetrics = {
  turnId: number
  /** the candidate stops speaking → the transcription of the turn is final */
  transcribeMs: number
  /** the transcription is final → the first word of the interviewer */
  modelFirstWordMs: number
  /** the candidate stops speaking → the first word of the interviewer */
  silenceToFirstWordMs: number
  /** the whole answer of the interviewer */
  answerMs: number
}

/** the words of the code the recogniser should expect (identifiers, routes) */
export const keywordsOf = (files: Record<string, string>) => {
  const counts = new Map<string, number>()
  for (const code of Object.values(files)) {
    for (const word of code.match(/[A-Za-z][A-Za-z0-9]{3,}/g) ?? []) {
      counts.set(word, (counts.get(word) ?? 0) + 1)
    }
  }
  const common = new Set([
    'this',
    'that',
    'with',
    'from',
    'const',
    'else',
    'null',
    'true',
    'false',
    'return',
    'function',
    'export',
    'import',
    'async',
    'await',
    'string',
    'number',
    'boolean',
    'unknown',
    'undefined',
    'throw',
    'catch',
    'class',
    'type',
    'interface',
    'extends',
    'string',
    'Promise',
    'Response',
    'Request',
    'Error',
  ])
  return [
    'Deno',
    'TypeScript',
    ...[...counts]
      // camelCase and PascalCase names are the ones worth teaching
      .filter(([w]) => !common.has(w) && /[a-z][A-Z]/.test(w))
      .sort((a, b) => b[1] - a[1])
      .map(([w]) => w),
  ].slice(0, 40)
}

/** a piece of text safe to send: the end marker may arrive in several pieces */
const markerGuard = () => {
  let held = ''
  return {
    push(delta: string) {
      const text = held + delta
      // keep back a tail that could still become the marker
      for (let n = Math.min(END_MARKER.length - 1, text.length); n > 0; n--) {
        if (END_MARKER.startsWith(text.slice(-n))) {
          held = text.slice(-n)
          return text.slice(0, -n).replace(END_MARKER, '')
        }
      }
      held = ''
      return text.replace(END_MARKER, '')
    },
  }
}

export class VoiceInterview {
  #send: (event: VoiceEvent) => void
  #facts: InterviewFacts
  #asr?: WebSocket
  #ready = false
  #closed = false
  #queue: Uint8Array<ArrayBuffer>[] = []
  #queued = 0
  #history: Message[] = []
  #running: Promise<void> = Promise.resolve()
  #controller?: AbortController
  /** the interviewer is writing an answer */
  #busy = false
  /** what the interviewer says in this turn, to tell an echo from a voice */
  #said = ''
  #interrupted = false
  #asked = 0
  #speechEndAt = 0
  #transcriptAt = 0

  constructor(facts: InterviewFacts, send: (event: VoiceEvent) => void) {
    this.#facts = facts
    this.#send = send
  }

  /** opens the transcription; the first question comes when it is ready */
  start() {
    if (!hasAiKey()) {
      this.#send({ type: 'error', message: 'No MODEL_API_KEY on the server.' })
      return
    }
    const asr = new WebSocket(`${voiceConfig.asrUrl}`)
    asr.binaryType = 'arraybuffer'
    this.#asr = asr
    asr.onopen = () => {
      asr.send(JSON.stringify({
        authorization: { accessToken: `Bearer ${llmConfig.key}` },
        audioEncoding: 'PCM_24KHZ',
        model: voiceConfig.asrModel,
        mode: 'ENDPOINTING',
        partialMode: 'CUMULATIVE',
        emitAudioProgress: false,
        languageBias: ['English'],
        keywords: keywordsOf(this.#facts.files),
      }))
    }
    asr.onmessage = (e) => {
      if (typeof e.data !== 'string') return
      try {
        this.#onAsr(JSON.parse(e.data))
      } catch (err) {
        log.warn('voice-asr-message', { message: String(err) })
      }
    }
    asr.onerror = () => this.#fail('The transcription is unreachable.')
    asr.onclose = (e) => {
      if (this.#closed) return
      this.#ready = false
      if (e.code !== 1000) {
        this.#fail(`The transcription closed (${e.code} ${e.reason}).`)
      }
    }
  }

  /** a frame of the microphone: PCM 16-bit mono 24 kHz */
  audio(bytes: Uint8Array<ArrayBuffer>) {
    if (this.#closed) return
    if (this.#ready && this.#asr?.readyState === WebSocket.OPEN) {
      this.#asr.send(bytes)
      return
    }
    // before the handshake: keep a few seconds, drop the oldest
    this.#queue.push(bytes)
    this.#queued += bytes.length
    while (this.#queued > voiceConfig.maxBufferedBytes) {
      this.#queued -= this.#queue.shift()!.length
    }
  }

  close() {
    this.#closed = true
    this.#controller?.abort()
    try {
      this.#asr?.send(JSON.stringify({ type: 'endStream' }))
      this.#asr?.close(1000)
    } catch { /* already closed */ }
  }

  #fail(message: string) {
    if (this.#closed) return
    this.#send({ type: 'error', message })
  }

  #onAsr(msg: Record<string, unknown>) {
    // the acknowledgement of the handshake: the only frame without a type
    if (!('type' in msg) && typeof msg.sessionId === 'string') {
      this.#ready = true
      for (const frame of this.#queue) this.#asr!.send(frame)
      this.#queue = []
      this.#queued = 0
      this.#send({ type: 'ready' })
      this.#running = this.#answer(INTERVIEW_START)
      return
    }
    switch (msg.type) {
      case 'speechStart':
        // a sound is not yet a voice: a breath, a click, the room, or the
        // interviewer itself through the speakers. It stops nothing.
        this.#send({ type: 'speech-start' })
        break
      case 'transcript':
        if (!msg.final) {
          const heard = String(msg.transcript ?? '')
          this.#send({ type: 'partial', text: heard })
          // words that are not the interviewer's own: the candidate speaks
          // over it, and it stops
          if (this.#busy && this.#controller && !isEcho(heard, this.#said)) {
            this.#interrupted = true
            this.#controller.abort()
          }
        }
        break
      case 'speechEnd':
        this.#speechEndAt = performance.now()
        this.#send({ type: 'speech-end' })
        break
      case 'speechComplete':
        this.#transcriptAt = performance.now()
        this.#running = this.#heard(
          Number(msg.turnId ?? 0),
          String(msg.transcript ?? '').trim(),
        )
        break
      case 'error':
        this.#fail(String(msg.message ?? 'Transcription error.'))
        break
    }
  }

  /** a finished turn of the candidate: the interviewer answers */
  async #heard(turnId: number, text: string) {
    // the answer cut short by this turn is in the history before the turn is
    await this.#running
    const wasInterrupted = this.#interrupted
    this.#interrupted = false
    if (!text && !wasInterrupted) return
    this.#send({ type: 'heard', turnId, text })
    this.#running = this.#answer(
      text || '(Something was said but it was not understandable.)',
      turnId,
    )
    await this.#running
  }

  /** one turn of the interviewer, streamed to the browser while it is written */
  async #answer(userText: string, turnId?: number) {
    this.#history.push({ role: 'user', content: userText })
    const controller = new AbortController()
    this.#controller = controller
    this.#busy = true
    this.#said = ''
    const guard = markerGuard()
    let firstWordAt = 0
    const started = performance.now()
    try {
      const result = await converse({
        task: 'interview',
        model: llmConfig.interviewModel,
        system: interviewSystem(this.#facts),
        messages: this.#history,
        effort: 'minimal',
        maxTokens: 1_200,
        signal: controller.signal,
        onDelta: (delta) => {
          const safe = guard.push(delta)
          if (!safe) return
          this.#said += safe
          if (!firstWordAt) firstWordAt = performance.now()
          this.#send({ type: 'ai-delta', text: safe })
        },
      })
      const interrupted = controller.signal.aborted
      const ended = result.text.includes(END_MARKER)
      const spoken = result.text.replace(END_MARKER, '').trim()
      this.#history.push({
        role: 'assistant',
        content: interrupted
          ? `${spoken} [the candidate interrupted here]`
          : spoken,
      })
      this.#send({ type: 'ai-done', text: spoken, interrupted })
      if (!interrupted) this.#asked++
      if (turnId !== undefined && firstWordAt) {
        this.#send({
          type: 'metrics',
          metrics: {
            turnId,
            transcribeMs: Math.round(this.#transcriptAt - this.#speechEndAt),
            modelFirstWordMs: Math.round(firstWordAt - this.#transcriptAt),
            silenceToFirstWordMs: Math.round(firstWordAt - this.#speechEndAt),
            answerMs: Math.round(performance.now() - started),
          },
        })
      }
      // the marker, or a safety stop if the model forgets to finish
      if (!interrupted && (ended || this.#asked > voiceConfig.questions + 1)) {
        this.#send({ type: 'end' })
        this.close()
      }
    } catch (err) {
      log.warn('voice-answer-failed', { message: String(err) })
      this.#fail(err instanceof Error ? err.message : String(err))
    } finally {
      this.#busy = false
    }
  }
}

/** the upgrade of a request: who may talk, and what the interviewer knows */
export const handleVoice = async (
  req: Request,
  options: {
    facts: (req: Request) => Promise<InterviewFacts>
    authorize?: (req: Request) => Promise<boolean>
    /** the interview opens */
    onStart?: (req: Request) => void
    /** the interview is over: what was said, and whether the interviewer closed it */
    onFinish?: (
      req: Request,
      transcript: InterviewLine[],
      completed: boolean,
    ) => void
  },
): Promise<Response> => {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('A WebSocket is expected.', { status: 426 })
  }
  // same host only: a page of another site cannot open the interview
  const origin = req.headers.get('origin')
  if (origin && new URL(origin).host !== new URL(req.url).host) {
    return new Response('Origin not allowed.', { status: 403 })
  }
  const authorize = options.authorize ?? (async (r: Request) => {
    const token = r.headers.get('cookie')?.match(/dfd_session=([^;]+)/)?.[1]
    return !!await decodeSession(token)
  })
  if (!await authorize(req)) {
    return new Response('Sign-in required.', { status: 401 })
  }
  const facts = await options.facts(req)
  // the headers of a request cannot be read once it is upgraded
  const asked = new Request(req.url, { headers: new Headers(req.headers) })
  const { socket, response } = Deno.upgradeWebSocket(req)
  socket.binaryType = 'arraybuffer'
  const transcript: InterviewLine[] = []
  let completed = false
  const interview = new VoiceInterview(facts, (event) => {
    if (event.type === 'heard') {
      transcript.push({ who: 'candidate', text: event.text })
    } else if (event.type === 'ai-done' && event.text) {
      transcript.push({
        who: 'ai',
        text: event.text,
        interrupted: event.interrupted || undefined,
      })
    } else if (event.type === 'end') completed = true
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event))
    // the end is final even if the browser keeps the socket open
    if (event.type === 'end') finish()
  })
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    options.onFinish?.(asked, transcript, completed)
  }
  socket.onopen = () => {
    options.onStart?.(asked)
    interview.start()
  }
  socket.onmessage = (e) => {
    if (typeof e.data === 'string') {
      if (e.data.includes('"stop"')) interview.close()
      return
    }
    interview.audio(new Uint8Array(e.data as ArrayBuffer))
  }
  socket.onclose = () => {
    interview.close()
    finish()
  }
  return response
}
