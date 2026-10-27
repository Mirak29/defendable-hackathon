import { useEffect } from 'preact/hooks'
import { paths } from '/web/paths.ts'
import { navigate } from '/web/lib/router-signal.ts'
import {
  loadMe,
  me,
  meStatus,
  retryPreparation,
} from '/web/lib/candidate-store.ts'
import { startVoice, stopVoice, voice } from '/web/lib/voice-client.ts'
import { Spinner } from '/web/ui/spinner.tsx'
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

  if (!view) {
    return (
      <Shell>
        <Spinner tw='w-5 h-5 text-content-tertiary' />
      </Shell>
    )
  }

  const preparation = view.preparation
  const ready = preparation?.steps.at(-1)?.state === 'done'
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

  const talking = live === 'live' || live === 'connecting'
  return (
    <Shell>
      <section tw='card w-[720px] max-w-full p-6 flex flex-col gap-5'>
        <header tw='flex flex-col gap-1.5'>
          <h1 tw='m-0 text-[20px] font-semibold'>
            Interview about your code
          </h1>
          <p tw='m-0 text-[13.5px] text-content-secondary'>
            An AI interviewer asks you about what you built, out loud. Answer as
            you would to a colleague. Use headphones, and speak over it if you
            want to interrupt.
          </p>
        </header>

        <div tw='flex flex-wrap items-center gap-3'>
          {talking
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
            : live === 'ended'
            ? <span tw='badge badge-neutral'>Interview over, thank you.</span>
            : (
              <button
                type='button'
                data-test='interview-start'
                tw='btn btn-primary'
                onClick={startVoice}
              >
                <Mic tw='w-4 h-4' />
                {view.interviewStartedAt
                  ? 'Start the interview again'
                  : 'Start the interview'}
              </button>
            )}
          {voice.listening.value && (
            <span tw='badge badge-neutral'>Listening…</span>
          )}
          {voice.speaking.value && <span tw='badge badge-ai'>Speaking…</span>}
          <div
            aria-label='Microphone level'
            tw='h-2 w-32 rounded bg-surface-sunken overflow-hidden'
          >
            <div
              tw='h-2 bg-accent'
              style={{ width: `${Math.min(100, voice.level.value * 160)}%` }}
            />
          </div>
        </div>

        {voice.error.value && (
          <p role='alert' tw='m-0 text-err text-[13px]'>{voice.error.value}</p>
        )}

        <section
          aria-label='Conversation'
          data-test='interview-lines'
          tw='rounded-lg border border-border-primary bg-surface-sunken p-4 flex flex-col gap-3 min-h-[180px]'
        >
          {!voice.lines.value.length && !voice.writing.value && (
            <p tw='m-0 text-content-tertiary text-[13.5px]'>
              The conversation appears here.
            </p>
          )}
          {voice.lines.value.map((line, i) => (
            <p
              key={i}
              tw={[
                'm-0 max-w-[560px] text-[14px]',
                line.who === 'ai'
                  ? 'text-ai'
                  : 'text-content-primary self-end text-right',
              ]}
            >
              {line.text}
            </p>
          ))}
          {voice.writing.value && (
            <p tw='m-0 text-ai max-w-[560px] text-[14px]'>
              {voice.writing.value}
            </p>
          )}
          {voice.partial.value && (
            <p tw='m-0 italic text-content-secondary self-end text-[14px]'>
              {voice.partial.value}
            </p>
          )}
        </section>
      </section>
    </Shell>
  )
}
