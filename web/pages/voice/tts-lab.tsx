// A test page for Oracle's voice (not a screen of the product): the voice of the
// browser against Kokoro, an open neural voice (Apache 2.0) that runs in the
// browser of the candidate. Measures what it costs: the load, the time to
// make each sentence against the length of the sound, and the first sound.
// Kokoro is read from a CDN at run time: nothing of it is in the bundle.
import { useRef, useState } from 'preact/hooks'
import { Mic } from '/web/assets/icons.tsx'

const KOKORO_URL = ['https://cdn.jsdelivr.net/npm/', 'kokoro-js@1.2.1/+esm']
  .join('')
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'

const VOICES = [
  'af_heart',
  'af_bella',
  'af_nicole',
  'af_sarah',
  'af_sky',
  'bf_emma',
  'bf_isabella',
  'am_michael',
  'am_adam',
  'bm_george',
]

const SAMPLES = [
  `Hi, I'm Oracle. I'll ask you a few questions about the code you just wrote. How did you approach building this link service?`,
  `Mm, okay. On that URL check you mentioned, where in the code does it actually look at the protocol? Take your time.`,
  `Alright. If two requests try to create the same alias at the same time, what happens between your check and the save?`,
  `Thanks for walking me through it. That's all I wanted to ask, and a person will read the report.`,
]

type Row = {
  text: string
  synthMs: number
  audioMs: number
  firstMs?: number
}

// the pieces of Kokoro that this page uses
type Tts = {
  generate: (
    text: string,
    options: { voice: string },
  ) => Promise<{ audio: Float32Array; sampling_rate: number }>
}

const sentences = (text: string) =>
  text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)?.map((s) => s.trim()).filter(
    Boolean,
  ) ?? [text]

export const TtsLabPage = () => {
  const [text, setText] = useState(SAMPLES[0])
  const [voice, setVoice] = useState('af_heart')
  const [device, setDevice] = useState<'wasm' | 'webgpu' | 'webgpu16'>(
    'wasm',
  )
  const [status, setStatus] = useState<
    'idle' | 'loading' | 'ready' | 'speaking' | 'error'
  >('idle')
  const [progress, setProgress] = useState(0)
  const [loadMs, setLoadMs] = useState<number>()
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState('')
  const tts = useRef<Tts>()
  const context = useRef<AudioContext>()

  const webgpu = 'gpu' in navigator

  const load = async () => {
    setStatus('loading')
    setError('')
    setProgress(0)
    const started = performance.now()
    try {
      const { KokoroTTS } = await import(KOKORO_URL)
      const files = new Map<string, number>()
      tts.current = await KokoroTTS.from_pretrained(MODEL, {
        // 92 MB quantized on the CPU, 163 MB in half precision or 326 MB in full
        // precision on WebGPU
        dtype: device === 'webgpu'
          ? 'fp32'
          : device === 'webgpu16'
          ? 'fp16'
          : 'q8',
        device: device === 'wasm' ? 'wasm' : 'webgpu',
        progress_callback: (p: { file?: string; progress?: number }) => {
          if (p.file && typeof p.progress === 'number') {
            files.set(p.file, p.progress)
            const all = [...files.values()]
            setProgress(all.reduce((a, b) => a + b, 0) / all.length)
          }
        },
      })
      setLoadMs(Math.round(performance.now() - started))
      setStatus('ready')
    } catch (err) {
      setError(String(err))
      setStatus('error')
    }
  }

  const speak = async () => {
    if (!tts.current) return
    setStatus('speaking')
    setRows([])
    context.current ??= new AudioContext()
    const ctx = context.current
    await ctx.resume()
    const started = performance.now()
    let playAt = ctx.currentTime
    let first: number | undefined
    for (const sentence of sentences(text)) {
      const t0 = performance.now()
      const out = await tts.current.generate(sentence, { voice })
      const synthMs = Math.round(performance.now() - t0)
      const buffer = ctx.createBuffer(1, out.audio.length, out.sampling_rate)
      buffer.copyToChannel(out.audio as Float32Array<ArrayBuffer>, 0)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      // the next sentence is made while this one plays
      playAt = Math.max(playAt, ctx.currentTime + 0.02)
      source.start(playAt)
      playAt += buffer.duration
      first ??= Math.round(performance.now() - started)
      setRows((rows) => [...rows, {
        text: sentence,
        synthMs,
        audioMs: Math.round(buffer.duration * 1000),
        firstMs: rows.length ? undefined : first,
      }])
    }
    setStatus('ready')
  }

  const speakWithBrowser = () => {
    speechSynthesis.cancel()
    for (const sentence of sentences(text)) {
      const u = new SpeechSynthesisUtterance(sentence)
      u.lang = 'en-US'
      u.rate = 1.05
      speechSynthesis.speak(u)
    }
  }

  const total = rows.reduce(
    (n, r) => ({ synth: n.synth + r.synthMs, audio: n.audio + r.audioMs }),
    { synth: 0, audio: 0 },
  )

  return (
    <main tw='max-w-[900px] w-full mx-auto px-5 py-10 flex flex-col gap-5'>
      <header tw='flex flex-col gap-2'>
        <h1 tw='text-[24px] font-medium m-0'>Voice test</h1>
        <p tw='text-content-secondary m-0'>
          The voice of your browser against Kokoro, an open neural voice that
          runs on this machine. Use headphones. The factor is the time to make a
          sentence over its length: below 1, the voice keeps up.
        </p>
      </header>

      <textarea
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
        rows={4}
        data-test='tts-text'
        tw='input'
      />
      <div tw='flex flex-wrap gap-2'>
        {SAMPLES.map((s, i) => (
          <button
            key={s}
            type='button'
            tw='btn btn-secondary btn-sm'
            onClick={() => setText(s)}
          >
            Line {i + 1}
          </button>
        ))}
      </div>

      <div tw='flex flex-wrap items-center gap-3'>
        <button
          type='button'
          data-test='tts-browser'
          tw='btn btn-secondary'
          onClick={speakWithBrowser}
        >
          Browser voice
        </button>
        <label tw='text-[13px] flex items-center gap-2'>
          Device
          <select
            value={device}
            disabled={status === 'loading' || status === 'speaking' ||
              status === 'ready'}
            onChange={(e) => setDevice(e.currentTarget.value as 'wasm')}
            tw='input h-8 py-0'
          >
            <option value='wasm'>CPU (WASM, 92 MB)</option>
            <option value='webgpu16' disabled={!webgpu}>
              WebGPU half precision (163 MB){webgpu ? '' : ' not available'}
            </option>
            <option value='webgpu' disabled={!webgpu}>
              WebGPU (326 MB){webgpu ? '' : ' not available'}
            </option>
          </select>
        </label>
        <label tw='text-[13px] flex items-center gap-2'>
          Voice
          <select
            value={voice}
            onChange={(e) => setVoice(e.currentTarget.value)}
            tw='input h-8 py-0'
          >
            {VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        {status === 'idle' || status === 'error'
          ? (
            <button
              type='button'
              data-test='tts-load'
              tw='btn btn-primary'
              onClick={load}
            >
              Load Kokoro
            </button>
          )
          : (
            <button
              type='button'
              data-test='tts-speak'
              tw='btn btn-primary'
              disabled={status !== 'ready'}
              onClick={speak}
            >
              <Mic tw='w-4 h-4' />
              {status === 'loading'
                ? `Loading… ${Math.round(progress)}%`
                : status === 'speaking'
                ? 'Speaking…'
                : 'Speak with Kokoro'}
            </button>
          )}
      </div>

      {error && <p role='alert' tw='m-0 text-err break-all'>{error}</p>}

      <dl
        data-test='tts-facts'
        tw='m-0 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[13px]'
      >
        <div tw='card px-3 py-2'>
          <dt tw='text-content-tertiary'>Load</dt>
          <dd data-test='tts-load-ms' tw='m-0 font-mono'>
            {loadMs ? `${(loadMs / 1000).toFixed(1)} s` : '…'}
          </dd>
        </div>
        <div tw='card px-3 py-2'>
          <dt tw='text-content-tertiary'>First sound</dt>
          <dd data-test='tts-first-ms' tw='m-0 font-mono'>
            {rows[0]?.firstMs ? `${rows[0].firstMs} ms` : '…'}
          </dd>
        </div>
        <div tw='card px-3 py-2'>
          <dt tw='text-content-tertiary'>Factor (all)</dt>
          <dd data-test='tts-factor' tw='m-0 font-mono'>
            {total.audio ? (total.synth / total.audio).toFixed(2) : '…'}
          </dd>
        </div>
        <div tw='card px-3 py-2'>
          <dt tw='text-content-tertiary'>This machine</dt>
          <dd tw='m-0 font-mono'>
            {navigator.hardwareConcurrency} cores
            {'deviceMemory' in navigator
              ? ` · ${
                (navigator as Navigator & { deviceMemory: number }).deviceMemory
              } GB`
              : ''}
          </dd>
        </div>
      </dl>

      <table tw='w-full text-[13px] border-collapse'>
        <thead>
          <tr tw='text-left text-content-secondary'>
            <th tw='py-1 pr-3'>Sentence</th>
            <th tw='py-1 pr-3'>Made in</th>
            <th tw='py-1 pr-3'>Sound</th>
            <th tw='py-1 pr-3'>Factor</th>
          </tr>
        </thead>
        <tbody data-test='tts-rows'>
          {rows.map((r) => (
            <tr key={r.text} tw='border-t border-border-primary'>
              <td tw='py-1 pr-3'>{r.text}</td>
              <td tw='py-1 pr-3 font-mono'>{r.synthMs} ms</td>
              <td tw='py-1 pr-3 font-mono'>{r.audioMs} ms</td>
              <td tw='py-1 pr-3 font-mono'>
                {(r.synthMs / r.audioMs).toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
