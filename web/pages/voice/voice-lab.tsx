// A test page for the voice interview (not a screen of the product): the demo
// candidate's code is the subject. Shows what is heard, what is written and
// spoken, and the delays of every turn.
import { A } from '/web/lib/router-signal.ts'
import { memberStatus } from '/web/lib/member-store.ts'
import { startVoice, stopVoice, voice } from '/web/lib/voice-client.ts'
import { paths } from '/web/paths.ts'
import { Mic } from '/web/assets/icons.tsx'
import { useState } from 'preact/hooks'

const ms = (value?: number) => value === undefined ? '…' : `${value} ms`

const labels: Record<string, string> = {
  idle: 'Ready',
  connecting: 'Connecting…',
  live: 'Live',
  ended: 'Interview over',
  error: 'Error',
}

/** the whole session as text, to paste in a message */
const sessionText = () => {
  const lines = voice.lines.value.map((l) =>
    `${l.who === 'ai' ? 'Interviewer' : 'You'}${
      l.interrupted ? ' (interrupted)' : ''
    }: ${l.text}`
  )
  const rows = voice.delays.value.map((d) =>
    [
      `turn ${d.turnId}`,
      `silence→first word ${ms(d.silenceToFirstWordMs)}`,
      `transcription ${ms(d.transcribeMs)}`,
      `model first word ${ms(d.modelFirstWordMs)}`,
      `whole answer ${ms(d.answerMs)}`,
      `heard→voice ${ms(d.heardToVoiceMs)}`,
    ].join(' | ')
  )
  return [...lines, '', 'Delays per turn', ...rows].join('\n')
}

export const VoiceLabPage = () => {
  const [copied, setCopied] = useState(false)
  const status = voice.status.value
  const live = status === 'live' || status === 'connecting'
  if (memberStatus.value !== 'in') {
    return (
      <main tw='max-w-[720px] w-full mx-auto px-5 py-16 flex flex-col gap-4'>
        <h1 tw='text-[24px] font-medium m-0'>Voice lab</h1>
        <p tw='text-content-secondary m-0'>
          The interview needs a session: sign in first (the demo account is
          enough).
        </p>
        <A href={paths.login} tw='btn btn-primary self-start'>Sign in</A>
      </main>
    )
  }
  return (
    <main tw='max-w-[900px] w-full mx-auto px-5 py-10 flex flex-col gap-6'>
      <header tw='flex flex-col gap-2'>
        <h1 tw='text-[24px] font-medium m-0'>Voice lab</h1>
        <p tw='text-content-secondary m-0'>
          Talk with the AI interviewer about the demo candidate's code (a short
          link service). Use headphones: the microphone would hear the
          interviewer. Speak over it to interrupt.
        </p>
      </header>

      <div tw='flex flex-wrap items-center gap-3'>
        {live
          ? (
            <button
              type='button'
              data-test='voice-stop'
              tw='btn btn-secondary'
              onClick={() => stopVoice()}
            >
              Stop
            </button>
          )
          : (
            <button
              type='button'
              data-test='voice-start'
              tw='btn btn-primary'
              onClick={startVoice}
            >
              <Mic tw='w-4 h-4' />
              Start the interview
            </button>
          )}
        <span
          data-test='voice-status'
          tw={[
            'badge',
            status === 'live' ? 'badge-neutral' : '',
          ]}
        >
          {labels[status]}
        </span>
        {voice.listening.value && (
          <span tw='badge badge-neutral'>Listening…</span>
        )}
        {voice.speaking.value && <span tw='badge badge-ai'>Speaking…</span>}
        <button
          type='button'
          data-test='voice-copy'
          tw='btn btn-secondary'
          disabled={!voice.lines.value.length}
          onClick={async () => {
            await navigator.clipboard.writeText(sessionText())
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}
        >
          {copied ? 'Copied' : 'Copy the session'}
        </button>
        <div
          aria-label='Microphone level'
          tw='h-2 w-40 rounded bg-surface-sunken overflow-hidden'
        >
          <div
            tw='h-2 bg-accent'
            style={{ width: `${Math.min(100, voice.level.value * 160)}%` }}
          />
        </div>
      </div>

      {voice.error.value && (
        <p role='alert' tw='m-0 text-err'>{voice.error.value}</p>
      )}

      <section
        aria-label='Conversation'
        data-test='voice-lines'
        tw='card p-5 flex flex-col gap-3 min-h-[200px]'
      >
        {!voice.lines.value.length && !voice.writing.value && (
          <p tw='m-0 text-content-tertiary'>
            The conversation appears here.
          </p>
        )}
        {voice.lines.value.map((line, i) => (
          <p
            key={i}
            tw={[
              'm-0 max-w-[720px]',
              line.who === 'ai' ? 'text-ai' : 'text-content-primary self-end',
            ]}
          >
            <strong tw='font-semibold'>
              {line.who === 'ai' ? 'Interviewer' : 'You'}
              {line.interrupted ? ' (interrupted)' : ''}:{' '}
            </strong>
            {line.text}
          </p>
        ))}
        {voice.writing.value && (
          <p tw='m-0 text-ai max-w-[720px]'>
            <strong tw='font-semibold'>Interviewer:</strong>
            {voice.writing.value}
          </p>
        )}
        {voice.partial.value && (
          <p tw='m-0 italic text-content-secondary self-end'>
            {voice.partial.value}
          </p>
        )}
      </section>

      <section aria-label='Delays' tw='flex flex-col gap-2'>
        <h2 tw='text-[16px] font-medium m-0'>Delays per turn</h2>
        <p tw='text-[13px] text-content-secondary m-0'>
          After you stop speaking: transcription final, first word of the model,
          the whole answer, and the voice starting in the browser.
        </p>
        <table data-test='voice-delays' tw='w-full text-[13px] border-collapse'>
          <thead>
            <tr tw='text-left text-content-secondary'>
              <th tw='py-1 pr-3'>Turn</th>
              <th tw='py-1 pr-3'>Silence → first word</th>
              <th tw='py-1 pr-3'>Transcription</th>
              <th tw='py-1 pr-3'>Model first word</th>
              <th tw='py-1 pr-3'>Whole answer</th>
              <th tw='py-1 pr-3'>Heard → voice</th>
            </tr>
          </thead>
          <tbody>
            {voice.delays.value.map((d) => (
              <tr key={d.turnId} tw='border-t border-border-primary'>
                <td tw='py-1 pr-3'>{d.turnId}</td>
                <td tw='py-1 pr-3 font-mono'>{ms(d.silenceToFirstWordMs)}</td>
                <td tw='py-1 pr-3 font-mono'>{ms(d.transcribeMs)}</td>
                <td tw='py-1 pr-3 font-mono'>{ms(d.modelFirstWordMs)}</td>
                <td tw='py-1 pr-3 font-mono'>{ms(d.answerMs)}</td>
                <td tw='py-1 pr-3 font-mono'>{ms(d.heardToVoiceMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  )
}
