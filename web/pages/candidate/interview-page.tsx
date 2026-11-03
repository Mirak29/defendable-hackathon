import { useEffect, useRef, useState } from 'preact/hooks'
import { paths } from '/web/paths.ts'
import { navigate, url } from '/web/lib/router-signal.ts'
import {
  loadMe,
  me,
  meStatus,
  retryPreparation,
} from '/web/lib/candidate-store.ts'
import {
  startRecordedVoice,
  startVoice,
  stopVoice,
  voice,
} from '/web/lib/voice-client.ts'
import { recording } from '/web/lib/interview-recording.ts'
import { GuidedDemo } from '/web/ui/guided-demo.tsx'
import { noCopy, trackIntegrity } from '/web/lib/integrity.ts'
import { Spinner } from '/web/ui/spinner.tsx'
import { OracleOrb, STAGE_BACKGROUND } from '/web/ui/oracle-orb.tsx'
import { Logo } from '/web/ui/topbar.tsx'
import { CircleCheck, CircleX, Mic } from '/web/assets/icons.tsx'
import type { ProgressState } from '/web/types.ts'

const STEPS = [
  'Your code is frozen',
  'Every test runs on your code',
  'The interviewer reads your code',
]

const StepRow = ({ label, state }: { label: string; state: ProgressState }) => (
  <li tw='flex items-center gap-2.5 text-[14px]'>
    {state === 'done'
      ? <CircleCheck tw='w-4 h-4 text-ok' />
      : state === 'error'
      ? <CircleX tw='w-4 h-4 text-err' />
      : state === 'run'
      ? <Spinner tw='w-4 h-4 text-accent' />
      : <span tw='w-4 h-4 rounded-full border border-border-strong' />}
    <span
      tw={state === 'wait' ? 'text-content-tertiary' : 'text-content-primary'}
    >
      {label}
    </span>
  </li>
)

type MicState = 'idle' | 'asking' | 'listening' | 'heard' | 'denied'

/**
 * The microphone tried in the waiting room: its level, and whether a voice was
 * heard. It starts by itself when the page already had a click (coming from
 * the editor); otherwise one button starts it (a browser only lets a page
 * listen and play after a click). `stop` frees it for the interview.
 */
const useMicCheck = (enabled: boolean) => {
  const [state, setState] = useState<MicState>('idle')
  const bar = useRef<HTMLSpanElement>(null)
  const running = useRef<() => void>()
  const stop = () => {
    running.current?.()
    running.current = undefined
  }
  const start = async () => {
    if (running.current) return
    setState('asking')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      const context = new AudioContext()
      await context.resume().catch(() => {})
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      context.createMediaStreamSource(stream).connect(analyser)
      const samples: Float32Array<ArrayBuffer> = new Float32Array(
        analyser.fftSize,
      )
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (const s of samples) sum += s * s
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 5)
        // the bar moves with the voice, without rendering the page again
        if (bar.current) bar.current.style.width = `${level * 100}%`
        if (level > 0.2) setState('heard')
      }, 80)
      running.current = () => {
        clearInterval(timer)
        stream.getTracks().forEach((t) => t.stop())
        context.close().catch(() => {})
      }
      setState((s) => s === 'heard' ? s : 'listening')
    } catch {
      setState('denied')
    }
  }
  useEffect(() => {
    if (enabled && navigator.userActivation?.hasBeenActive) start()
    return stop
  }, [enabled])
  return { state, bar, start, stop }
}

/** one line of the waiting room: an icon and a label, never a color alone */
const RoomRow = (
  { state, label, children }: {
    state: 'done' | 'run' | 'todo' | 'error'
    label: string
    children?: preact.ComponentChildren
  },
) => (
  <li tw='flex items-start gap-2.5 text-left text-[14px]'>
    {state === 'run'
      ? <Spinner tw='w-4 h-4 mt-0.5 flex-none' />
      : state === 'done'
      ? <CircleCheck tw='w-4 h-4 mt-0.5 flex-none text-ok' />
      : state === 'error'
      ? <CircleX tw='w-4 h-4 mt-0.5 flex-none text-err' />
      : (
        <span
          tw='w-4 h-4 mt-0.5 flex-none rounded-full'
          style={{ border: '1.5px solid rgba(143,176,238,.6)' }}
        />
      )}
    <span tw='flex-1 flex flex-col gap-1.5'>
      {label}
      {children}
    </span>
  </li>
)

const Shell = ({ children }: { children: preact.ComponentChildren }) => (
  <main tw='min-h-screen flex flex-col items-center justify-center gap-6 px-4 py-12'>
    <Logo />
    {children}
  </main>
)

/** The spoken interview about the candidate's own code */
export const InterviewPage = () => {
  const view = me.value
  const status = meStatus.value
  const live = voice.status.value
  const captureStatus = recording.status.value
  const [recordingAccepted, setRecordingAccepted] = useState(false)
  const [visualAnalysisAccepted, setVisualAnalysisAccepted] = useState(false)
  // An interview that Oracle closes live is marked finished at once: the page
  // then waits for its last words (below) instead of leaving here.
  const closingLive = live === 'live' || live === 'ended'
  useEffect(() => {
    if (status === 'none') navigate({ href: paths.candidate, replace: true })
    else if (view && !view.submittedAt) {
      navigate({ href: paths.workspace, replace: true })
    } else if (
      (view?.finishedAt && !closingLive ||
        view?.interviewStartedAt && live === 'idle') &&
      captureStatus !== 'recording' && captureStatus !== 'saving'
    ) {
      navigate({ href: paths.done, replace: true })
    }
  }, [
    status,
    view?.submittedAt,
    view?.finishedAt,
    view?.interviewStartedAt,
    live,
    captureStatus,
    closingLive,
  ])

  // The interviewer closed the interview: the server marks it finished. The
  // page stays until its last words are said, then a moment more.
  const speaking = voice.speaking.value
  useEffect(() => {
    if (live !== 'ended' || speaking) return
    stopVoice(false, true)
    if (
      captureStatus === 'recording' || captureStatus === 'saving' ||
      captureStatus === 'error'
    ) return
    const timer = setTimeout(async () => {
      await loadMe()
      navigate({ href: paths.done })
    }, 2500)
    return () => clearTimeout(timer)
  }, [live, speaking, captureStatus])
  // leaving the page ends the call
  useEffect(() => () => stopVoice(), [])
  // the conditions of the interview, reported as facts
  useEffect(() => trackIntegrity('interview'), [])

  // A waiting room before the interview: the microphone is tried, then the
  // candidate starts it. Oracle's first words were written during the
  // preparation, so it speaks as soon as they click; the 10 minutes start then.
  const ready = view?.preparation?.steps.at(-1)?.state === 'done' &&
    (!view.finishedAt || closingLive)
  const mic = useMicCheck(!!ready && live === 'idle')
  const begin = () => {
    mic.stop()
    if (url.params.demo === '1') startVoice()
    else startRecordedVoice(visualAnalysisAccepted)
  }
  useEffect(() => {
    if (captureStatus !== 'recording' && captureStatus !== 'saving') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    addEventListener('beforeunload', warn)
    return () => removeEventListener('beforeunload', warn)
  }, [captureStatus])

  // the conversation follows its latest message
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [
    voice.lines.value.length,
    voice.writing.value,
    voice.partial.value,
  ])

  if (!view) {
    return (
      <Shell>
        <Spinner tw='w-5 h-5 text-content-tertiary' />
      </Shell>
    )
  }

  const preparation = view.preparation
  if (!ready) {
    return (
      <Shell>
        <section
          data-test='preparation'
          tw='card w-[480px] max-w-full p-6 flex flex-col gap-4'
        >
          <h1 tw='m-0 text-[18px] font-semibold'>
            {preparation?.error ? 'Something went wrong' : 'Getting ready'}
          </h1>
          {!preparation?.error && (
            <p tw='m-0 text-[13px] text-content-secondary'>
              Nothing to do here, it takes a few seconds. Then Oracle will talk
              with you about the code you wrote.
            </p>
          )}
          <ul tw='list-none m-0 p-0 flex flex-col gap-2.5'>
            {STEPS.map((label, i) => (
              <StepRow
                key={label}
                label={label}
                state={preparation?.steps[i]?.state ?? 'wait'}
              />
            ))}
          </ul>
          {preparation?.error && (
            <>
              <p role='alert' tw='m-0 text-err text-[13px]'>
                {preparation.error}
              </p>
              <button
                type='button'
                tw='btn btn-secondary self-start'
                onClick={retryPreparation}
              >
                Try again
              </button>
            </>
          )}
        </section>
      </Shell>
    )
  }

  const demo = url.params.demo === '1'
  const talking = live === 'live' || live === 'connecting'
  const lines = voice.lines.value
  const state = voice.listening.value
    ? "I'm listening"
    : voice.speaking.value
    ? 'Speaking'
    : voice.writing.value
    ? 'Thinking about it'
    : live === 'connecting'
    ? 'Connecting'
    : live === 'ended'
    ? 'Thank you, that was the last question'
    : live === 'live'
    ? 'Take your time'
    : 'Waiting for you'
  // what Oracle says now, in writing: a voice alone is easy to lose
  const caption = voice.writing.value ||
    (voice.speaking.value ? lines.findLast((l) => l.who === 'ai')?.text : '') ||
    ''
  const asking = !talking && live !== 'ended'
  return (
    <div tw='h-screen flex flex-col bg-surface-page text-content-primary'>
      <header tw='h-12 flex-none flex items-center justify-between px-5 border-b border-border-primary'>
        <Logo />
        <span tw='text-[12.5px] text-content-tertiary'>
          {captureStatus === 'recording'
            ? '● Camera and audio recording'
            : captureStatus === 'saving'
            ? 'Saving the recording…'
            : 'A conversation about your code'}
        </span>
      </header>
      {asking && <GuidedDemo />}
      <div tw='flex-1 min-h-0 flex flex-col lg:flex-row'>
        <section
          aria-label='Oracle'
          tw='relative flex-1 min-h-0 overflow-hidden'
          style={{ background: STAGE_BACKGROUND }}
        >
          <OracleOrb />
          <div
            tw='absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 px-6 pb-8 pt-16'
            style={{
              paddingLeft: recording.preview.value
                ? 'clamp(120px, 18vw, 200px)'
                : undefined,
            }}
          >
            {!asking && (
              <p
                aria-live='polite'
                {...noCopy}
                tw='m-0 max-w-[620px] min-h-[84px] text-center text-[18px] leading-[1.5] select-none'
                style={{ color: '#dbe7ff' }}
              >
                {caption}
              </p>
            )}
            {asking && (
              <div
                tw='w-[440px] max-w-full rounded-2xl p-5 flex flex-col gap-3 text-center'
                style={{
                  background: 'rgba(8,16,36,.72)',
                  border: '1px solid rgba(120,170,255,.22)',
                  color: '#dbe7ff',
                }}
              >
                <h2 tw='m-0 text-[17px] font-semibold'>
                  {live === 'error'
                    ? 'We could not open the conversation'
                    : 'Ready when you are'}
                </h2>
                <p
                  tw='m-0 text-[14px] leading-[1.55]'
                  style={{ opacity: 0.85 }}
                >
                  {live === 'error'
                    ? 'Check your camera, microphone and connection, then try again.'
                    : 'Oracle has read your code and will talk it through with you, out loud. There are no trick questions, you can take your time, and a person reads the result afterwards.'}
                </p>
                {live !== 'error' && (
                  <ul
                    data-test='waiting-room'
                    tw='list-none m-0 p-0 flex flex-col gap-2.5'
                  >
                    <RoomRow state='done' label='Oracle has read your code' />
                    <RoomRow
                      state={mic.state === 'heard'
                        ? 'done'
                        : mic.state === 'denied'
                        ? 'error'
                        : mic.state === 'idle'
                        ? 'todo'
                        : 'run'}
                      label={mic.state === 'heard'
                        ? 'Your microphone works'
                        : mic.state === 'denied'
                        ? 'The microphone is blocked: allow it in your browser, then reload the page'
                        : mic.state === 'idle'
                        ? 'Your microphone is not tested yet'
                        : 'Say a few words to test your microphone'}
                    >
                      {(mic.state === 'listening' || mic.state === 'heard') && (
                        <span
                          tw='block h-1.5 rounded-full overflow-hidden'
                          style={{ background: 'rgba(120,170,255,.18)' }}
                        >
                          <span
                            ref={mic.bar}
                            tw='block h-full rounded-full'
                            style={{
                              width: '0%',
                              background: '#8fb0ee',
                              transition: 'width 80ms linear',
                            }}
                          />
                        </span>
                      )}
                      {mic.state === 'idle' && (
                        <button
                          type='button'
                          data-test='mic-test'
                          tw='btn btn-secondary h-8 px-3 text-[13px] self-start'
                          onClick={mic.start}
                        >
                          <Mic tw='w-3.5 h-3.5' />
                          Test my microphone
                        </button>
                      )}
                    </RoomRow>
                  </ul>
                )}
                <p tw='m-0 text-[12.5px]' style={{ opacity: 0.65 }}>
                  Your camera, microphone and Oracle’s voice will be recorded
                  for replay by the recruiting team. The recording is available
                  for 30 days. Images are sent to Muse Spark only if you
                  separately opt in below, to review camera visibility and image
                  quality. No emotion, gaze, personality or honesty assessment.
                  Use headphones. If you cannot use a camera, contact the
                  recruiter for an adjustment before starting. Once the
                  interview starts, closing or refreshing this page, or losing
                  the connection, ends it permanently. Switching tabs does not
                  end it.
                </p>
                {!demo && (
                  <label tw='flex items-start gap-2 text-left text-[13px]'>
                    <input
                      type='checkbox'
                      checked={visualAnalysisAccepted}
                      onChange={(e) =>
                        setVisualAnalysisAccepted(e.currentTarget.checked)}
                    />
                    Optional: I allow up to 12 sampled camera images to be sent
                    to Muse Spark via the configured Meta or Baseten provider
                    for visibility and image-quality observations. I can take
                    the interview without agreeing to this.
                  </label>
                )}
                {!demo && (
                  <label tw='flex items-start gap-2 text-left text-[13px]'>
                    <input
                      type='checkbox'
                      checked={recordingAccepted}
                      onChange={(e) =>
                        setRecordingAccepted(e.currentTarget.checked)}
                    />
                    I agree to the camera and audio recording described above.
                  </label>
                )}
              </div>
            )}
            <div tw='flex flex-col items-center gap-1'>
              <span
                tw='font-display text-[16px] tracking-[0.04em]'
                style={{ color: '#e8f0ff' }}
              >
                Oracle
              </span>
              <span
                data-test='oracle-state'
                role='status'
                tw='text-[13px]'
                style={{ color: '#8fb0ee' }}
              >
                {state}
              </span>
            </div>
            {voice.error.value && (
              <p role='alert' tw='m-0 text-err text-[13px] text-center'>
                {voice.error.value}
              </p>
            )}
            {captureStatus === 'saving' && (
              <p role='status' tw='m-0 text-[13px]'>
                Saving the recording. Keep this page open.
              </p>
            )}
            {live === 'ended' && captureStatus === 'error' && (
              <div tw='flex flex-col gap-2 text-[13px]'>
                <p role='alert'>
                  {recording.error.value} The replay may be incomplete.
                </p>
                <button
                  type='button'
                  tw='btn btn-secondary'
                  onClick={() => navigate({ href: paths.done })}
                >
                  Finish with a recording warning
                </button>
              </div>
            )}
            {live !== 'ended' && (
              <div tw='flex gap-2'>
                {talking && demo
                  ? (
                    <button
                      type='button'
                      data-test='interview-stop'
                      tw='btn btn-secondary'
                      onClick={() => stopVoice()}
                    >
                      Stop
                    </button>
                  )
                  : !talking && (
                    <button
                      type='button'
                      data-test='interview-start'
                      tw='btn btn-primary'
                      disabled={mic.state === 'denied' ||
                        (!demo &&
                          (!recordingAccepted || captureStatus === 'saving'))}
                      onClick={begin}
                    >
                      <Mic tw='w-4 h-4' />
                      {live === 'error' ? 'Try again' : 'Start the interview'}
                    </button>
                  )}
              </div>
            )}
          </div>
          {recording.preview.value && (
            <div
              tw='absolute bottom-3 left-3 rounded-xl overflow-hidden border border-border-strong bg-surface-elevated shadow-lg'
              style={{ width: 'clamp(100px, 16vw, 180px)' }}
            >
              <video
                aria-label='Your camera preview'
                autoPlay
                muted
                playsInline
                ref={(element) => {
                  if (
                    element && element.srcObject !== recording.preview.value
                  ) element.srcObject = recording.preview.value ?? null
                }}
                style={{
                  width: '100%',
                  aspectRatio: '4 / 3',
                  objectFit: 'cover',
                  transform: 'scaleX(-1)',
                  display: 'block',
                }}
              />
              <div tw='px-2 py-1 text-[11px]'>
                You · {captureStatus === 'recording' ? 'Recording' : 'Saving'}
              </div>
            </div>
          )}
        </section>

        <aside
          aria-label='Conversation'
          tw='lg:w-[400px] h-[42vh] lg:h-auto flex-none flex flex-col border-t lg:border-t-0 lg:border-l border-border-primary bg-surface-elevated'
        >
          <div tw='px-4 py-3 border-b border-border-primary text-[13px] font-semibold'>
            Conversation
          </div>
          <div
            ref={scroller}
            data-test='interview-lines'
            {...noCopy}
            tw='flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-3 select-none'
          >
            {!lines.length && !voice.writing.value && (
              <p tw='m-0 text-content-tertiary text-[13px]'>
                Oracle starts as soon as you click Start. Everything said is
                written here, so you can follow along.
              </p>
            )}
            {lines.map((line, i) => (
              <Bubble key={i} who={line.who} text={line.text} />
            ))}
            {voice.writing.value && (
              <Bubble who='ai' text={voice.writing.value} live />
            )}
            {voice.partial.value && (
              <Bubble who='you' text={voice.partial.value} live />
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

/** one message of the conversation */
const Bubble = (
  { who, text, live }: { who: 'ai' | 'you'; text: string; live?: boolean },
) => (
  <div
    tw={['flex flex-col gap-1', who === 'you' ? 'items-end' : 'items-start']}
  >
    <span tw='text-[11px] text-content-tertiary'>
      {who === 'ai' ? 'Oracle' : 'You'}
    </span>
    <p
      tw={[
        'm-0 max-w-[88%] px-3 py-2 rounded-xl text-[14px] leading-[1.5]',
        who === 'ai'
          ? 'bg-ai-soft text-content-primary rounded-tl-sm'
          : 'bg-accent text-on-accent rounded-tr-sm',
        live && 'opacity-[.75]',
      ]}
    >
      {text}
    </p>
  </div>
)
