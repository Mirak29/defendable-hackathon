import { useEffect, useRef, useState } from 'preact/hooks'
import { paths } from '/web/paths.ts'
import { navigate, url } from '/web/lib/router-signal.ts'
import {
  loadMe,
  me,
  meStatus,
  retryPreparation,
} from '/web/lib/candidate-store.ts'
import { startVoice, stopVoice, voice } from '/web/lib/voice-client.ts'
import { Spinner } from '/web/ui/spinner.tsx'
import { OracleOrb } from '/web/ui/oracle-orb.tsx'
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
  useEffect(() => {
    if (status === 'none') navigate({ href: paths.candidate, replace: true })
    else if (view && !view.submittedAt) {
      navigate({ href: paths.workspace, replace: true })
    } else if (view?.finishedAt) navigate({ href: paths.done, replace: true })
  }, [status, view?.submittedAt, view?.finishedAt])

  // the interviewer closed the interview: the server marks it finished
  useEffect(() => {
    if (live !== 'ended') return
    const timer = setTimeout(async () => {
      await loadMe()
      navigate({ href: paths.done })
    }, 6000)
    return () => clearTimeout(timer)
  }, [live])
  // leaving the page ends the call
  useEffect(() => () => stopVoice(), [])

  // Oracle starts by itself. The browser only lets a page speak after a click
  // of the person: coming from the editor (Submit) it has one, after a reload
  // it has not and one button asks for it.
  const ready = view?.preparation?.steps.at(-1)?.state === 'done' &&
    !view.finishedAt
  const started = useRef(false)
  const [needsGesture, setNeedsGesture] = useState(false)
  useEffect(() => {
    if (!ready || started.current || url.params.demo === '1') return
    started.current = true
    if (navigator.userActivation?.hasBeenActive) startVoice()
    else setNeedsGesture(true)
  }, [ready])

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
    ? 'Listening'
    : voice.speaking.value
    ? 'Speaking'
    : voice.writing.value
    ? 'Thinking'
    : live === 'connecting'
    ? 'Connecting'
    : live === 'ended'
    ? 'Interview over'
    : 'Ready'
  return (
    <div tw='h-screen flex flex-col bg-surface-page text-content-primary'>
      <header tw='h-12 flex-none flex items-center justify-between px-5 border-b border-border-primary'>
        <Logo />
        <span tw='text-[12.5px] text-content-tertiary'>
          Interview about your code
        </span>
      </header>
      <div tw='flex-1 min-h-0 flex flex-col lg:flex-row'>
        <section
          aria-label='Oracle'
          tw='relative flex-1 min-h-0 overflow-hidden'
          style={{ background: '#000' }}
        >
          <OracleOrb />
          <div tw='absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-6 pb-6 pt-16'>
            <span
              tw='font-display text-[18px] tracking-[0.04em]'
              style={{ color: '#e4e4e7' }}
            >
              Oracle
            </span>
            <span
              data-test='oracle-state'
              role='status'
              tw='badge'
              style={{
                background: 'rgba(255,255,255,.08)',
                color: '#b4b4bb',
                borderColor: 'rgba(255,255,255,.14)',
              }}
            >
              {state}
            </span>
            {voice.error.value && (
              <p role='alert' tw='m-0 text-err text-[13px] text-center'>
                {voice.error.value}
              </p>
            )}
            {(needsGesture || live === 'error' || demo) && live !== 'ended' && (
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
                      onClick={startVoice}
                    >
                      <Mic tw='w-4 h-4' />
                      {live === 'error'
                        ? 'Try again'
                        : needsGesture && !demo
                        ? 'Resume the interview'
                        : 'Start'}
                    </button>
                  )}
              </div>
            )}
          </div>
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
            tw='flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-3'
          >
            {!lines.length && !voice.writing.value && (
              <p tw='m-0 text-content-tertiary text-[13px]'>
                Oracle will start in a moment. The conversation appears here.
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
