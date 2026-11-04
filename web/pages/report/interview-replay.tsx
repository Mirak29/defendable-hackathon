// The interview replay of the report: the recording with both voices, its
// captions, the key moments found by the AI, and the conversation in sync.
import { signal, useComputed } from '@preact/signals'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { paths } from '/web/paths.ts'
import { member } from '/web/lib/member-store.ts'
import type { InterviewLine, RecordingView, ReportView } from '/web/types.ts'
import { formatDate } from '/web/lib/format.ts'
import {
  clock,
  LEAD_MS,
  type Span,
  spanAt,
  spansOf,
} from '/web/lib/replay-timeline.ts'
import {
  pendingReplay,
  playhead,
  replayAt,
  ReplayPlayer,
} from './replay-player.tsx'
import {
  type CodeView,
  KeyMoments,
  useReplayAnalysis,
} from './replay-annotations.tsx'
import {
  CalendarClock,
  CloudCheck,
  Lock,
  MessagesSquare,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  TriangleAlert,
} from '/web/assets/icons.tsx'

/** recordings with a video, for the replay links of the report */
const available = signal<string[]>([])
const endpoint = (candidate: number, id?: string) =>
  `${paths.recruiterRecording}?${new URLSearchParams({
    candidate: String(candidate),
    ...(id ? { id } : {}),
  })}`

export const ReplayLink = ({ line }: { line?: InterviewLine }) =>
  line?.recordingId && line.atMs !== undefined &&
    available.value.includes(line.recordingId)
    ? (
      <button
        type='button'
        aria-label={`Replay from ${clock(line.atMs)}`}
        title='Replay this passage'
        tw='ml-2 inline-flex items-center gap-1 h-[22px] px-2 rounded-md border border-border-primary bg-surface-elevated text-[11.5px] font-mono not-italic text-content-secondary cursor-pointer hover:bg-surface-hover hover:text-content-primary'
        style={{ verticalAlign: '1px' }}
        onClick={() => replayAt(line.recordingId!, line.atMs!)}
      >
        <Play tw='w-2.5 h-2.5' />
        {clock(line.atMs)}
      </button>
    )
    : null

const fold = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim()
export const ReplayQuote = ({ quote, v }: { quote: string; v: ReportView }) => (
  <ReplayLink
    line={v.transcript.find((line) =>
      line.who === 'candidate' && fold(line.text).includes(fold(quote))
    )}
  />
)

/** the transcript of this recording, following the playback */
const Conversation = ({ spans, id }: { spans: Span[]; id: string }) => {
  const list = useRef<HTMLOListElement>(null)
  const touched = useRef(0)
  const active = useComputed(() => spanAt(spans, playhead.value)?.index)
  useEffect(() => {
    const box = list.current
    const item = box?.querySelector<HTMLElement>(
      `[data-line="${active.value}"]`,
    )
    // follow the playback, unless the reader scrolled a moment ago
    if (!box || !item || Date.now() - touched.current < 4000) return
    box.scrollTo({
      top: item.offsetTop - box.clientHeight / 3,
      behavior: 'smooth',
    })
  }, [active.value])
  const manual = () => (touched.current = Date.now())
  return (
    <ol
      ref={list}
      onWheel={manual}
      onTouchMove={manual}
      tw='relative m-0 p-0 list-none flex flex-col gap-0.5 overflow-auto'
      style={{ maxHeight: '320px', overscrollBehavior: 'contain' }}
    >
      {spans.map((s) => (
        <li key={s.index} data-line={s.index}>
          <button
            type='button'
            onClick={() => replayAt(id, s.from + LEAD_MS - 500)}
            tw={[
              'w-full flex gap-2.5 px-2.5 py-1.5 rounded-lg border-0 text-left cursor-pointer text-[13px] leading-[1.5] transition-colors',
              active.value === s.index
                ? 'bg-accent-soft text-content-primary'
                : 'bg-transparent text-content-secondary hover:bg-surface-hover',
            ]}
          >
            <span
              tw='font-mono text-[11.5px] text-content-tertiary min-w-[38px] pt-px'
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {clock(s.from)}
            </span>
            <span tw='flex-1 min-w-0'>
              <strong
                tw={[
                  'font-semibold',
                  s.who === 'ai' ? 'text-ai' : 'text-content-primary',
                ]}
              >
                {s.who === 'ai' ? 'Oracle' : 'Candidate'}
              </strong>{' '}
              {s.text}
            </span>
          </button>
        </li>
      ))}
    </ol>
  )
}

type Tab = 'moments' | 'conversation'

/** The camera and both voices. No emotion, gaze or honesty assessment. */
export const InterviewReplay = (
  { v, Code }: { v: ReportView; Code: CodeView },
) => {
  const [recordings, setRecordings] = useState<RecordingView[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [tab, setTab] = useState<Tab>('moments')
  const selected = recordings.find((r) => r.id === selectedId)
  const analysis = useReplayAnalysis(
    endpoint(v.candidateId, selectedId),
    selected,
  )
  const spans = useMemo(
    () =>
      selected ? spansOf(v.transcript, selected.id, selected.durationMs) : [],
    [v.transcript, selected],
  )

  useEffect(() => {
    const abort = new AbortController()
    available.value = []
    setLoading(true)
    setError('')
    const list = async () => {
      const response = await fetch(endpoint(v.candidateId), {
        signal: abort.signal,
      })
      if (!response.ok) throw Error('The recordings could not be loaded.')
      return await response.json() as RecordingView[]
    }
    ;(async () => {
      let found = await list()
      if (!found.length && member.peek()?.demo) {
        // Recover older recordings only when this browser can prove it was
        // the candidate. The server refuses other visitors and reassignment.
        const claimed = await fetch(`${endpoint(v.candidateId)}&claim=1`, {
          method: 'POST',
          signal: abort.signal,
        })
        if (claimed.ok) found = await list()
      }
      if (abort.signal.aborted) return
      setRecordings(found)
      available.value = found.filter((r) => r.bytes > 0).map((r) => r.id)
      setSelectedId(
        found.findLast((r) => r.status === 'complete')?.id ??
          found.at(-1)?.id ?? '',
      )
    })().catch((e) => {
      if (!abort.signal.aborted) setError(String(e?.message ?? e))
    }).finally(() => {
      if (!abort.signal.aborted) setLoading(false)
    })
    return () => {
      abort.abort()
      available.value = []
    }
  }, [v.candidateId, refresh])

  // a replay link of another attempt selects it; its player then jumps
  const asked = pendingReplay.value
  useEffect(() => {
    if (
      asked && asked.id !== selectedId &&
      recordings.some((r) => r.id === asked.id)
    ) setSelectedId(asked.id)
  }, [asked, selectedId, recordings])

  if (!loading && !error && !recordings.length) {
    if (!member.value?.demo) return null
    return (
      <section aria-label='Interview replay' tw='card p-4 flex flex-col gap-2'>
        <h2 tw='m-0 text-[17px] font-semibold'>Interview replay</h2>
        <p tw='m-0 text-[13px] text-content-secondary'>
          No replay is available in this demo session. Open the report in the
          browser session that created the invitation or completed this
          interview.
        </p>
      </section>
    )
  }

  const remove = async () => {
    if (!selected) return
    setDeleting(true)
    try {
      const response = await fetch(endpoint(v.candidateId, selected.id), {
        method: 'DELETE',
      })
      if (!response.ok) throw Error('The recording could not be deleted.')
      const remaining = recordings.filter((r) => r.id !== selected.id)
      setRecordings(remaining)
      available.value = remaining.filter((r) => r.bytes > 0).map((r) => r.id)
      setSelectedId(remaining.at(-1)?.id ?? '')
      setConfirmDelete(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleting(false)
    }
  }

  const moments = analysis.analysis?.status === 'ready'
    ? analysis.analysis.moments
    : []
  const tabs: [Tab, string, number | undefined][] = [
    ['moments', 'Key moments', moments.length || undefined],
    ['conversation', 'Conversation', spans.length || undefined],
  ]
  return (
    <section
      id='interview-replay'
      aria-label='Interview replay'
      tw='card p-4 sm:p-5 flex flex-col gap-4'
      style={{ scrollMarginTop: '72px' }}
    >
      <header tw='flex items-start gap-3 flex-wrap'>
        <div tw='flex flex-col gap-0.5 flex-1 min-w-[220px]'>
          <h2 tw='m-0 text-[17px] font-semibold'>Interview replay</h2>
          <p tw='m-0 text-[12.5px] text-content-secondary'>
            Camera and both voices, as recorded in the candidate’s browser. A
            pause or a camera incident is not evidence of anything.
          </p>
        </div>
        {recordings.length > 1 && (
          <div
            role='group'
            aria-label='Recording attempt'
            tw='flex gap-1 flex-wrap'
          >
            {recordings.map((r, i) => (
              <button
                key={r.id}
                type='button'
                aria-pressed={r.id === selectedId}
                title={`${
                  formatDate(new Date(r.createdAt).toISOString())
                } · ${r.status}`}
                onClick={() => {
                  setSelectedId(r.id)
                  setError('')
                  setConfirmDelete(false)
                }}
                tw={[
                  'h-7 px-2.5 rounded-md border text-[12px] cursor-pointer inline-flex items-center gap-1',
                  r.id === selectedId
                    ? 'bg-accent-soft border-accent text-accent-text'
                    : 'bg-transparent border-border-primary text-content-secondary hover:bg-surface-hover',
                ]}
              >
                Attempt {i + 1}
                {r.status !== 'complete' && (
                  <TriangleAlert
                    tw='w-3 h-3 text-warn'
                    aria-label='incomplete'
                  />
                )}
              </button>
            ))}
          </div>
        )}
      </header>

      {loading && (
        <div
          tw='rounded-[12px] bg-surface-sunken animate-pulse'
          style={{ aspectRatio: '16 / 9', maxHeight: '420px' }}
        />
      )}
      {error && (
        <p
          role='alert'
          tw='m-0 text-[13px] text-err flex items-center gap-2 flex-wrap'
        >
          {error}
          <button
            type='button'
            tw='btn btn-ghost h-7 px-2 text-[12.5px]'
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw tw='w-3.5 h-3.5' /> Retry
          </button>
        </p>
      )}

      {selected && (selected.bytes > 0
        ? (
          <ReplayPlayer
            key={selected.id}
            id={selected.id}
            src={endpoint(v.candidateId, selected.id)}
            durationMs={selected.durationMs}
            spans={spans}
            moments={moments}
            onError={setError}
          />
        )
        : (
          <p tw='m-0 px-4 py-8 rounded-[12px] bg-surface-sunken text-center text-[13px] text-content-secondary'>
            No video was received for this attempt.
          </p>
        ))}

      {selected && selected.bytes > 0 && (
        <div tw='flex flex-col gap-2'>
          <div
            role='tablist'
            aria-label='Replay panels'
            tw='flex gap-1 border-b border-border-primary'
          >
            {tabs.map(([key, label, count]) => (
              <button
                key={key}
                type='button'
                role='tab'
                id={`replay-tab-${key}`}
                aria-selected={tab === key}
                aria-controls='replay-panel'
                onClick={() => setTab(key)}
                tw={[
                  'h-9 px-3 border-0 border-b-2 bg-transparent text-[13px] font-medium cursor-pointer inline-flex items-center gap-1.5',
                  tab === key
                    ? 'border-accent text-content-primary'
                    : 'border-transparent text-content-tertiary hover:text-content-primary',
                ]}
                style={{ marginBottom: '-1px' }}
              >
                {key === 'moments'
                  ? <Sparkles tw='w-3.5 h-3.5 text-ai' />
                  : <MessagesSquare tw='w-3.5 h-3.5' />}
                {label}
                {count !== undefined && (
                  <span tw='text-[11.5px] text-content-tertiary font-mono'>
                    {count}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div
            id='replay-panel'
            role='tabpanel'
            aria-labelledby={`replay-tab-${tab}`}
          >
            {tab === 'moments'
              ? (
                <KeyMoments
                  state={analysis}
                  recording={selected}
                  files={v.files}
                  Code={Code}
                />
              )
              : <Conversation spans={spans} id={selected.id} />}
          </div>
        </div>
      )}

      {selected && (
        <footer tw='pt-3 border-t border-border-primary flex items-center gap-x-4 gap-y-2 flex-wrap text-[12px] text-content-tertiary'>
          {selected.status === 'complete'
            ? (
              <span tw='inline-flex items-center gap-1.5'>
                <CloudCheck tw='w-3.5 h-3.5 text-ok' /> Recording complete
              </span>
            )
            : (
              <span tw='inline-flex items-center gap-1.5 text-warn'>
                <TriangleAlert tw='w-3.5 h-3.5' />
                {selected.status === 'recording'
                  ? 'Upload in progress'
                  : 'Recording interrupted'}
                {selected.status === 'recording' && (
                  <button
                    type='button'
                    tw='btn btn-ghost h-6 px-1.5 text-[12px]'
                    onClick={() => setRefresh((n) => n + 1)}
                  >
                    <RefreshCw tw='w-3 h-3' /> Refresh
                  </button>
                )}
              </span>
            )}
          <span tw='inline-flex items-center gap-1.5'>
            <CalendarClock tw='w-3.5 h-3.5' />
            Kept until {formatDate(new Date(selected.expiresAt).toISOString())}
          </span>
          <span tw='inline-flex items-center gap-1.5'>
            <Lock tw='w-3.5 h-3.5' />
            {member.value?.demo
              ? 'This login session only'
              : 'Your company space only'}
          </span>
          <span tw='flex-1' />
          {!confirmDelete
            ? (
              <button
                type='button'
                tw='btn btn-ghost h-7 px-2 text-[12px]'
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 tw='w-3.5 h-3.5' /> Delete recording
              </button>
            )
            : (
              <span
                role='alert'
                tw='inline-flex items-center gap-2 text-content-primary'
              >
                Delete this recording for good?
                <button
                  type='button'
                  tw='btn btn-danger h-7 px-2.5 text-[12px]'
                  disabled={deleting}
                  onClick={remove}
                >
                  Delete
                </button>
                <button
                  type='button'
                  tw='btn btn-ghost h-7 px-2 text-[12px]'
                  disabled={deleting}
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
              </span>
            )}
        </footer>
      )}
    </section>
  )
}
