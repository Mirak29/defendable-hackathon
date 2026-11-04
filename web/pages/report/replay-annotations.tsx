// Key moments of a replay: an AI reading of the transcript and the code that
// points to passages worth replaying. It decides nothing.
import { useComputed } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { FunctionComponent } from 'preact'
import type { CodeRef, RecordingView } from '/web/types.ts'
import type {
  ReplayAnalysis,
  ReplayMoment,
} from '/web/lib/replay-analysis-types.ts'
import { clock, LEAD_MS, momentAt } from '/web/lib/replay-timeline.ts'
import { kindLabel, playhead, replayAt } from './replay-player.tsx'
import {
  BadgeCheck,
  ChevronDown,
  CircleHelp,
  RotateCcw,
  Sparkles,
} from '/web/assets/icons.tsx'

/** measured on muse-spark-1.3: about 15 s for a 4-minute interview */
const EXPECTED_S = 15

export type CodeView = FunctionComponent<
  { ref_: CodeRef; files: Record<string, string> }
>

export const useReplayAnalysis = (
  endpoint: string,
  recording: RecordingView | undefined,
) => {
  const [analysis, setAnalysis] = useState<ReplayAnalysis>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [startedAt, setStartedAt] = useState(0)
  const operation = useRef<AbortController>()
  const id = recording?.id
  useEffect(() => {
    setAnalysis(undefined)
    setError('')
    setBusy(false)
    if (!id) return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const response = await fetch(`${endpoint}&analysis=1`, {
          signal: abort.signal,
        })
        if (!response.ok) throw Error('Key moments could not be loaded.')
        const value: ReplayAnalysis = await response.json()
        if (abort.signal.aborted) return
        setAnalysis(value)
        if (value.status === 'pending') {
          setStartedAt((at) => at || Date.now())
          timer = setTimeout(load, 2000)
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e))
        }
      }
    }
    load()
    return () => {
      abort.abort()
      clearTimeout(timer)
      operation.current?.abort()
    }
  }, [id, endpoint])
  const analyze = async () => {
    if (!recording || busy) return
    const abort = new AbortController()
    operation.current = abort
    setBusy(true)
    setError('')
    setStartedAt(Date.now())
    try {
      const response = await fetch(`${endpoint}&analysis=1`, {
        method: 'POST',
        signal: abort.signal,
      })
      const value = await response.json()
      if (!response.ok) throw Error(value.error ?? 'Key moments failed.')
      if (!abort.signal.aborted) setAnalysis(value)
    } catch (e) {
      if (!abort.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (!abort.signal.aborted) setBusy(false)
    }
  }
  return { analysis, busy, error, analyze, startedAt }
}
export type ReplayAnalysisState = ReturnType<typeof useReplayAnalysis>

const Elapsed = ({ from }: { from: number }) => {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const s = Math.max(0, Math.round((now - from) / 1000))
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      {s} s{s < EXPECTED_S ? ` · usually about ${EXPECTED_S} s` : ''}
    </span>
  )
}

const KindIcon = ({ m }: { m: ReplayMoment }) =>
  m.kind === 'strength'
    ? <BadgeCheck tw='w-4 h-4 flex-none text-ai' />
    : <CircleHelp tw='w-4 h-4 flex-none text-ai' />

const Moment = (
  { m, recordingId, active, open, onOpen, files, Code }: {
    m: ReplayMoment
    recordingId: string
    active: boolean
    open: boolean
    onOpen: () => void
    files: Record<string, string>
    Code: CodeView
  },
) => (
  <li
    tw={[
      'rounded-[10px] border transition-colors',
      active ? 'border-ai-line bg-ai-soft' : 'border-transparent',
    ]}
  >
    <button
      type='button'
      aria-expanded={open}
      onClick={() => {
        replayAt(recordingId, m.atMs)
        onOpen()
      }}
      tw='w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[10px] border-0 bg-transparent text-left cursor-pointer text-content-primary hover:bg-surface-hover'
    >
      <span
        tw='font-mono text-[12px] text-content-secondary min-w-[38px]'
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {clock(m.atMs)}
      </span>
      <KindIcon m={m} />
      <span tw='flex-1 min-w-0 flex flex-col'>
        <span
          tw={['text-[13.5px] font-medium', !open && 'truncate']}
        >
          {m.title}
        </span>
        <span tw='text-[11.5px] text-content-tertiary'>{kindLabel(m)}</span>
      </span>
      <ChevronDown
        tw={[
          'w-4 h-4 flex-none text-content-tertiary transition-transform',
          open && 'rotate-180',
        ]}
      />
    </button>
    {open && (
      <div tw='pl-3 sm:pl-[62px] pr-3 pb-3 flex flex-col gap-2'>
        <p tw='m-0 text-[13px] text-content-secondary leading-[1.5]'>
          {m.detail}
        </p>
        {m.quote && (
          <blockquote tw='m-0 pl-3 border-l-2 border-ai-line text-[13px] italic'>
            “{m.quote}”
          </blockquote>
        )}
        {m.code && (
          <Code
            ref_={{
              file: m.code.path,
              from: m.code.from,
              to: m.code.to,
              note: '',
            }}
            files={files}
          />
        )}
      </div>
    )}
  </li>
)

export const KeyMoments = (
  { state, recording, files, Code }: {
    state: ReplayAnalysisState
    recording: RecordingView
    files: Record<string, string>
    Code: CodeView
  },
) => {
  const { analysis, busy, error, analyze, startedAt } = state
  const [open, setOpen] = useState(-1)
  const moments = analysis?.moments ?? []
  const active = useComputed(() => momentAt(moments, playhead.value))
  const pending = busy || analysis?.status === 'pending'
  const failure = error || analysis?.error

  if (analysis?.status === 'ready') {
    if (!moments.length) {
      return (
        <p tw='m-0 px-1 py-6 text-center text-[13px] text-content-secondary'>
          No passage stood out against the code. This says nothing about the
          candidate: the replay and the transcript are complete.
        </p>
      )
    }
    return (
      <div tw='flex flex-col gap-2'>
        <ol
          tw='m-0 p-0 list-none flex flex-col gap-0.5 overflow-auto'
          style={{ maxHeight: '320px', overscrollBehavior: 'contain' }}
        >
          {moments.map((m, i) => (
            <Moment
              key={`${m.atMs}-${i}`}
              m={m}
              recordingId={recording.id}
              active={active.value === i}
              open={open === i}
              onOpen={() => setOpen(open === i ? -1 : i)}
              files={files}
              Code={Code}
            />
          ))}
        </ol>
        <p tw='m-0 px-1 text-[11.5px] text-content-tertiary flex items-start gap-1.5'>
          <Sparkles tw='w-3 h-3 flex-none mt-0.5 text-ai' />
          <span>
            AI interpretation by{' '}
            {analysis.trace?.model ?? 'the model'}, from the transcript and the
            code. It points to passages and decides nothing. A jump starts
            {` ${LEAD_MS / 1000} s`} early.
          </span>
        </p>
      </div>
    )
  }

  if (pending) {
    return (
      <div role='status' tw='flex flex-col gap-3 py-2'>
        <p tw='m-0 px-1 text-[13px] text-content-secondary flex items-center gap-2'>
          <Sparkles tw='w-4 h-4 text-ai animate-pulse' />
          <span>
            Reading the transcript against the code ·{' '}
            <Elapsed from={startedAt || Date.now()} />
          </span>
        </p>
        {[62, 48, 55].map((w) => (
          <div key={w} tw='flex items-center gap-3 px-2.5'>
            <span tw='w-[38px] h-3 rounded bg-surface-hover animate-pulse' />
            <span
              tw='h-3 rounded bg-surface-hover animate-pulse'
              style={{ width: `${w}%` }}
            />
          </div>
        ))}
      </div>
    )
  }

  const uploading = recording.status === 'recording'
  return (
    <div tw='flex flex-col items-start gap-3 px-1 py-3'>
      <p tw='m-0 text-[13px] text-content-secondary max-w-[560px] leading-[1.5]'>
        <Sparkles tw='inline w-3.5 h-3.5 mr-1.5 text-ai align-[-2px]' />
        Muse Spark reads the transcript against the submitted code and marks the
        passages worth replaying: claims to verify, and explanations that match
        the code.
      </p>
      {failure && <p role='alert' tw='m-0 text-[13px] text-err'>{failure}</p>}
      <button
        type='button'
        tw='btn btn-secondary h-9 px-3.5'
        disabled={!analysis || uploading}
        onClick={analyze}
      >
        {failure
          ? <RotateCcw tw='w-4 h-4' />
          : <Sparkles tw='w-4 h-4 text-ai' />}
        {failure ? 'Try again' : 'Find key moments'}
      </button>
      {uploading && (
        <p tw='m-0 text-[12px] text-content-tertiary'>
          Available once the recording upload has finished.
        </p>
      )}
    </div>
  )
}
