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
import { tts } from '/api/tts.ts'
import type { InterviewLine } from '/web/types.ts'
import { decodeSession } from '/api/member.ts'
import {
  END_MARKER,
  INTERVIEW_RESUME,
  INTERVIEW_START,
  INTERVIEW_TIME_UP,
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
  /**
   * After a turn of the candidate, the interviewer writes its answer at once
   * but only starts to speak after this delay. A candidate who takes up the
   * thread within it is still answering: the two turns become one. Most of it
   * is spent waiting for the model anyway.
   */
  holdMs: Number(ENV('VOICE_HOLD_MS', '900')),
  /**
   * How long the interview lasts, from the first time it opened: reloading the
   * page does not restart it. After that the interviewer closes at the next
   * turn of the candidate, or `graceMs` later at the latest.
   */
  interviewMs: Number(ENV('INTERVIEW_MS', String(10 * 60_000))),
  graceMs: Number(ENV('INTERVIEW_GRACE_MS', '45000')),
  /** a candidate who is still speaking is heard out, at most this long */
  patienceMs: 60_000,
}

/**
 * A turn the transcription could not make sense of ("15", "uh"): the
 * interviewer asks again instead of moving on.
 */
export const isUnclear = (text: string) =>
  !/[a-z]{3,}/i.test(text) && !/^(yes|no|ok|okay|yeah|yep|nope)\b/i.test(text)

const NOT_UNDERSTOOD = (text: string) =>
  `(The transcription could not make out the candidate's answer: "${text}". Say in one short sentence that you did not catch it and ask them to say it again. Do not move on and do not close the interview.)`

/** what the browser receives */
export type VoiceEvent =
  /** `voice`: who reads the interviewer's words aloud; `history`: what was already said before a reload */
  | {
    type: 'ready'
    voice: 'server' | 'browser'
    /** samples per second of the sound of a `speech` event, when `voice` is `server` */
    rate?: number
    history?: InterviewLine[]
  }
  /** a sentence of the interviewer, with its sound (PCM 16-bit mono at the `rate` of `ready`, in base64) unless it could not be made: the browser reads it then */
  | { type: 'speech'; text: string; pcm?: string }
  | { type: 'speech-start' }
  | { type: 'speech-end' }
  /** what is being said, replaced at each update */
  | { type: 'partial'; text: string }
  /** the final words of a turn of the candidate */
  | { type: 'heard'; turnId: number; text: string; merge?: boolean }
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

/**
 * The next piece of speech in written words, and what remains: a sentence of
 * a few words ("Hi Sam." goes with what follows). With `early` (the first
 * piece of an answer) a comma ends it too, so that the first sound does not
 * wait for the end of a long sentence; later ones are made faster than they
 * are played, and whole sentences keep the voice natural.
 */
export const nextPiece = (
  text: string,
  early = false,
): [string, string] | undefined => {
  for (const m of text.matchAll(/([.!?,;:])\s/g)) {
    const piece = text.slice(0, m.index + 1)
    const sentence = '.!?'.includes(m[1])
    if (sentence ? piece.length >= 12 : early && piece.length >= 14) {
      return [piece, text.slice(m.index + 2).replace(/^\s+/, '')]
    }
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
  /** the words of a turn whose answer was withdrawn: the next turn adds to it */
  #carry = ''
  /** while the answer is held back: withdraws it if the candidate goes on */
  #withdraw?: () => void
  /** the sentences of the interviewer are made here, not in the browser */
  #serverVoice = false
  /** words written but not yet a whole sentence */
  #unspoken = ''
  /** a piece of this answer was already made */
  #spokeYet = false
  /** changes when what was being said is dropped: late sentences are lost */
  #epoch = 0
  #sentences: Promise<void> = Promise.resolve()
  #asked = 0
  #speechEndAt = 0
  #transcriptAt = 0

  /** what the interviewer is told when the interview opens */
  #opening: string
  /** when the time of the interview is over (ms) */
  #deadline: number
  /** a voice is heard now (speech-start received, no speech-end yet) */
  #speaking = false
  #timer?: ReturnType<typeof setTimeout>

  constructor(facts: InterviewFacts, send: (event: VoiceEvent) => void) {
    this.#facts = facts
    this.#send = send
    this.#deadline = (facts.interviewStartedAt ?? Date.now()) +
      voiceConfig.interviewMs
    this.#opening = facts.previous?.length
      ? this.#restore(facts.previous)
      : INTERVIEW_START
  }

  /**
   * The candidate is back (page reloaded): the interviewer knows what was
   * said and goes on, instead of starting over and asking the same questions.
   * Returns what it is told when the interview reopens.
   */
  #restore(previous: InterviewLine[]) {
    const lines = [...previous]
    // the candidate spoke last and was not answered yet
    const unanswered = lines.at(-1)?.who === 'candidate'
      ? lines.pop()!.text
      : ''
    this.#history.push({ role: 'user', content: INTERVIEW_START })
    for (const line of lines) {
      if (line.who === 'candidate') {
        this.#history.push({ role: 'user', content: line.text })
        continue
      }
      this.#history.push({
        role: 'assistant',
        content: line.interrupted
          ? `${line.text} [the candidate interrupted here]`
          : line.text,
      })
      if (!line.interrupted) this.#asked++
    }
    return INTERVIEW_RESUME(unanswered)
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

  /**
   * The time is over for good: the interviewer closes after what it is
   * saying. By politeness, a candidate who is speaking is heard out first (their
   * turn then ends in the closing, see `#heard`).
   */
  #timeUp(waited = 0) {
    if (this.#closed) return
    if (this.#speaking && waited < voiceConfig.patienceMs) {
      this.#timer = setTimeout(() => this.#timeUp(waited + 1_000), 1_000)
      return
    }
    this.#running = this.#running.then(() =>
      this.#closed ? undefined : this.#closeTurn()
    )
  }

  /** the interviewer's closing words, with nothing left to answer */
  #closeTurn() {
    return this.#answer(INTERVIEW_TIME_UP(), undefined, undefined, true)
  }

  close() {
    this.#closed = true
    clearTimeout(this.#timer)
    this.#dropSpeech()
    this.#withdraw?.()
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
      this.#serverVoice = tts.loaded()
      this.#send({
        type: 'ready',
        voice: this.#serverVoice ? 'server' : 'browser',
        rate: this.#serverVoice ? tts.rate() : undefined,
        history: this.#facts.previous,
      })
      // back after the time was over: it closes at once
      const left = this.#deadline - Date.now()
      this.#timer = setTimeout(
        () => this.#timeUp(),
        Math.max(0, left) + voiceConfig.graceMs,
      )
      this.#running = left > 0 ? this.#answer(this.#opening) : this.#closeTurn()
      return
    }
    switch (msg.type) {
      case 'speechStart':
        // a sound is not yet a voice: a breath, a click, the room, or the
        // interviewer itself through the speakers. It stops nothing.
        this.#speaking = true
        this.#send({ type: 'speech-start' })
        break
      case 'transcript':
        if (!msg.final) {
          const heard = String(msg.transcript ?? '')
          this.#send({ type: 'partial', text: heard })
          if (this.#withdraw && heard.trim()) {
            // the interviewer has not spoken yet: the candidate is still
            // answering, so what was written is dropped
            this.#withdraw()
          } else if (
            // words that are not the interviewer's own: the candidate speaks
            // over it, and it stops
            this.#busy && this.#controller && !isEcho(heard, this.#said)
          ) {
            this.#interrupted = true
            this.#dropSpeech()
            this.#controller.abort()
          }
        }
        break
      case 'speechEnd':
        this.#speaking = false
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
    if (this.#closed) return
    const wasInterrupted = this.#interrupted
    this.#interrupted = false
    if (!text && !wasInterrupted) return
    // the words of a turn withdrawn just before, which this one goes on with
    const merge = !!this.#carry && !!text
    const full = merge ? `${this.#carry} ${text}` : text || this.#carry
    this.#carry = ''
    this.#send({ type: 'heard', turnId, text: full, merge })
    // the time is over: this turn is answered by the closing
    const over = Date.now() >= this.#deadline
    this.#running = this.#answer(
      over
        ? INTERVIEW_TIME_UP(full)
        : !full
        ? '(Something was said but it was not understandable.)'
        : isUnclear(full)
        ? NOT_UNDERSTOOD(full)
        : full,
      turnId,
      full,
      over,
    )
    await this.#running
  }

  #deliver(text: string) {
    this.#send({ type: 'ai-delta', text })
    this.#say(text)
  }

  /** what was being said is dropped: sentences still in the making are lost */
  #dropSpeech() {
    this.#epoch++
    this.#unspoken = ''
    this.#spokeYet = false
  }

  /**
   * Speech is made as soon as a piece is whole, in order, while the one before
   * is playing (see `nextPiece`).
   */
  #say(delta: string, flush = false) {
    if (!this.#serverVoice) return
    this.#unspoken += delta
    const pieces: string[] = []
    for (
      let next = nextPiece(this.#unspoken, !this.#spokeYet);
      next;
      next = nextPiece(this.#unspoken)
    ) {
      pieces.push(next[0])
      this.#unspoken = next[1]
      this.#spokeYet = true
    }
    // the end of the answer: what remains is the last piece
    if (flush) {
      if (this.#unspoken.trim()) pieces.push(this.#unspoken.trim())
      this.#unspoken = ''
    }
    const epoch = this.#epoch
    for (const text of pieces) {
      const sound = tts.synthesize(text, () => epoch === this.#epoch)
      this.#sentences = this.#sentences.then(async () => {
        const pcm = await sound
        // dropped (the candidate spoke over it) or over: nobody hears it
        if (epoch !== this.#epoch || this.#closed) return
        this.#send({ type: 'speech', text, pcm })
      })
    }
  }

  /** one turn of the interviewer, streamed to the browser while it is written */
  async #answer(
    userText: string,
    turnId?: number,
    heardText = userText,
    closing = false,
  ) {
    this.#history.push({ role: 'user', content: userText })
    this.#dropSpeech()
    const controller = new AbortController()
    this.#controller = controller
    this.#busy = true
    this.#said = ''
    const guard = markerGuard()
    let firstWordAt = 0
    const started = performance.now()
    // the answer is written at once but held back for a moment (see holdMs)
    const held: string[] = []
    let open = turnId === undefined || voiceConfig.holdMs <= 0
    let withdrawn = false
    let opened!: () => void
    const gate = new Promise<void>((resolve) => (opened = resolve))
    const release = () => {
      if (open) return
      open = true
      this.#withdraw = undefined
      if (held.length) firstWordAt ||= performance.now()
      for (const text of held.splice(0)) this.#deliver(text)
      opened()
    }
    const timer = open ? undefined : setTimeout(release, voiceConfig.holdMs)
    if (open) opened()
    else {
      this.#withdraw = () => {
        withdrawn = true
        this.#withdraw = undefined
        clearTimeout(timer)
        controller.abort()
        opened()
      }
    }
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
          if (open) {
            firstWordAt ||= performance.now()
            this.#deliver(safe)
          } else held.push(safe)
        },
      })
      await gate
      // cut before its first word, after the hold: nothing was said either
      if (withdrawn || (controller.signal.aborted && !this.#said.trim())) {
        // the candidate went on: nothing of this answer was said or kept
        this.#history.pop()
        this.#carry = heardText
        this.#said = ''
        return
      }
      firstWordAt ||= performance.now()
      const ended = result.text.includes(END_MARKER) && !isUnclear(heardText)
      const interrupted = controller.signal.aborted
      const spoken = result.text.replace(END_MARKER, '').trim()
      this.#history.push({
        role: 'assistant',
        content: interrupted
          ? `${spoken} [the candidate interrupted here]`
          : spoken,
      })
      if (!interrupted) this.#say('', true)
      this.#send({ type: 'ai-done', text: spoken, interrupted })
      if (!interrupted && !isUnclear(heardText)) this.#asked++
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
      if (
        !interrupted &&
        (ended || closing || this.#asked > voiceConfig.questions + 1)
      ) {
        // the last words are still being made: they are heard before the end
        await this.#sentences
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

/** the host of an Origin header; a malformed one ("null") matches no host */
const hostOf = (origin: string) => {
  try {
    return new URL(origin).host
  } catch {
    return undefined
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
  if (origin && hostOf(origin) !== new URL(req.url).host) {
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
  // what was said before a reload stays in the transcript
  const transcript: InterviewLine[] = [...(facts.previous ?? [])]
  let completed = false
  const interview = new VoiceInterview(facts, (event) => {
    if (event.type === 'heard') {
      const last = transcript.at(-1)
      if (event.merge && last?.who === 'candidate') last.text = event.text
      else transcript.push({ who: 'candidate', text: event.text })
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
