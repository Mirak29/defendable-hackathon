import { signal } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import { paths } from '/web/paths.ts'
import { member } from '/web/lib/member-store.ts'
import type { InterviewLine, RecordingView, ReportView } from '/web/types.ts'
import { formatDateTime } from '/web/lib/format.ts'
import { useReplayAnnotations } from './replay-annotations.tsx'

const target = signal<{ id: string; atMs: number; nonce: number } | null>(null)
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
        tw='btn btn-ghost text-[12px] ml-2'
        onClick={() => {
          target.value = {
            id: line.recordingId!,
            atMs: line.atMs!,
            nonce: Date.now(),
          }
          document.getElementById('interview-replay')?.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          })
        }}
      >
        Replay this passage
      </button>
    )
    : null

export const ReplayQuote = ({ quote, v }: { quote: string; v: ReportView }) => {
  const normalized = (value: string) =>
    value.toLowerCase().replace(/\s+/g, ' ').trim()
  return (
    <ReplayLink
      line={v.transcript.find((line) =>
        line.who === 'candidate' &&
        normalized(line.text).includes(normalized(quote))
      )}
    />
  )
}

/** Original webcam video, with both voices. No emotion or gaze assessment. */
export const InterviewReplay = ({ v }: { v: ReportView }) => {
  const [recordings, setRecordings] = useState<RecordingView[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [position, setPosition] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const video = useRef<HTMLVideoElement>(null)
  const playerContainer = useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const changed = () =>
      setFullscreen(document.fullscreenElement === playerContainer.current)
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])
  const request = target.value
  const selected = recordings.find((r) => r.id === selectedId)
  const annotations = useReplayAnnotations(
    v,
    selected,
    position,
    video,
    endpoint(v.candidateId, selectedId),
  )
  useEffect(() => {
    const abort = new AbortController()
    available.value = []
    target.value = null
    setLoading(true)
    setError('')
    fetch(endpoint(v.candidateId), { signal: abort.signal }).then(
      async (response) => {
        if (!response.ok) throw Error('The recording list could not be loaded.')
        let list: RecordingView[] = await response.json()
        if (!list.length && member.peek()?.demo) {
          // Recover older recordings only when this browser can prove it was
          // the candidate. The server refuses other visitors and reassignment.
          const recovered = await fetch(`${endpoint(v.candidateId)}&claim=1`, {
            method: 'POST',
            signal: abort.signal,
          })
          if (recovered.ok) {
            const retry = await fetch(endpoint(v.candidateId), {
              signal: abort.signal,
            })
            if (!retry.ok) {
              throw Error('The recording list could not be loaded.')
            }
            list = await retry.json()
          }
        }
        setRecordings(list)
        available.value = list.filter((r) => r.bytes > 0).map((r) => r.id)
        setSelectedId(
          list.findLast((r) => r.status === 'complete')?.id ??
            list.at(-1)?.id ?? '',
        )
      },
    ).catch((error) => {
      if (!abort.signal.aborted) setError(String(error.message ?? error))
    }).finally(() => {
      if (!abort.signal.aborted) setLoading(false)
    })
    return () => {
      abort.abort()
      available.value = []
    }
  }, [v.candidateId, refresh])
  const seek = () => {
    if (!video.current || !request || request.id !== selectedId) return
    // Server event times are approximate. Include context before the passage.
    const seconds = Math.max(0, request.atMs / 1000 - 3)
    video.current.currentTime = Number.isFinite(video.current.duration)
      ? Math.min(seconds, video.current.duration)
      : seconds
  }
  useEffect(() => {
    if (!request || !recordings.some((r) => r.id === request.id)) return
    if (selectedId !== request.id) setSelectedId(request.id)
    else if (video.current?.readyState) seek()
  }, [request, selectedId, recordings])
  if (!loading && !error && !recordings.length) {
    if (!member.value?.demo) return null
    return (
      <section
        aria-label='Interview recording'
        tw='card p-4 flex flex-col gap-2'
      >
        <h2 tw='m-0 text-[17px] font-semibold'>Interview recording</h2>
        <p tw='m-0 text-[13px] text-content-secondary'>
          No replay is available in this demo session. Open the report in the
          browser session that created the invitation or completed this
          interview.
        </p>
      </section>
    )
  }
  return (
    <section
      id='interview-replay'
      aria-label='Interview recording'
      tw='card p-4 flex flex-col gap-3'
    >
      <h2 tw='m-0 text-[17px] font-semibold'>Interview recording</h2>
      <p tw='m-0 text-[13px] text-content-secondary'>
        Camera and audio from the candidate’s browser, including Oracle’s voice.
        Replay links use approximate positions. A pause or a camera incident is
        not evidence of dishonesty or lack of understanding.
      </p>
      {loading && <p role='status'>Loading recordings…</p>}
      {error && <p role='alert' tw='m-0 text-err text-[13px]'>{error}</p>}
      {(error || recordings.some((r) => r.status === 'recording')) && (
        <button
          type='button'
          tw='btn btn-secondary self-start'
          disabled={loading}
          onClick={() => setRefresh((n) => n + 1)}
        >
          Refresh recordings
        </button>
      )}
      {recordings.length > 1 && (
        <label tw='flex flex-col gap-1 text-[13px]'>
          Recording attempt
          <select
            tw='input'
            value={selectedId}
            onChange={(e) => {
              target.value = null
              setSelectedId(e.currentTarget.value)
              setError('')
              setConfirmDelete(false)
            }}
          >
            {recordings.map((r, i) => (
              <option key={r.id} value={r.id}>
                Attempt {i + 1} ·{' '}
                {formatDateTime(new Date(r.createdAt).toISOString())} ·{' '}
                {r.status}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && (
        <>
          {selected.bytes > 0
            ? (
              <div
                ref={playerContainer}
                style={{
                  position: 'relative',
                  background: '#000',
                  borderRadius: '8px',
                }}
              >
                <video
                  key={selected.id}
                  ref={video}
                  controls
                  playsInline
                  preload='metadata'
                  aria-label='Interview replay'
                  src={endpoint(v.candidateId, selected.id)}
                  onLoadedMetadata={seek}
                  onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
                  onError={() =>
                    setError(
                      'This recording could not be played. It may be incomplete or use a format this browser cannot play.',
                    )}
                  style={{
                    width: '100%',
                    maxHeight: fullscreen ? '100vh' : '420px',
                    background: '#000',
                    borderRadius: '8px',
                  }}
                />
                {annotations.overlay}
                {typeof document.documentElement.requestFullscreen ===
                    'function' && (
                  <button
                    type='button'
                    onClick={() => {
                      const action = fullscreen
                        ? document.exitFullscreen()
                        : playerContainer.current?.requestFullscreen()
                      action?.catch(() => {})
                    }}
                    style={{
                      position: 'absolute',
                      top: '10px',
                      right: '10px',
                      border: 0,
                      borderRadius: '6px',
                      padding: '6px 9px',
                      background: 'rgba(13,19,35,.85)',
                      color: '#fff',
                      fontSize: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    {fullscreen
                      ? 'Exit full screen'
                      : 'Full screen with annotations'}
                  </button>
                )}
              </div>
            )
            : <p>No video data was received for this attempt.</p>}
          {selected.bytes > 0 && selected.durationMs > 0 && (
            <label tw='flex flex-col gap-1 text-[12px]'>
              Replay position · {Math.floor(position)} s /{' '}
              {Math.ceil(selected.durationMs / 1000)} s
              <input
                type='range'
                min={0}
                max={selected.durationMs / 1000}
                step={0.1}
                value={position}
                onInput={(e) => {
                  if (video.current) {
                    video.current.currentTime = Number(e.currentTarget.value)
                  }
                }}
              />
            </label>
          )}
          <p tw='m-0 text-[12px] text-content-secondary'>
            {selected.status === 'complete'
              ? '✓ Recording saved'
              : '⚠ Incomplete recording or upload still in progress'}
            {' · Available until '}
            {formatDateTime(new Date(selected.expiresAt).toISOString())}
          </p>
          <p tw='m-0 text-[12px] text-content-tertiary'>
            {member.value?.demo
              ? 'This demo recording is private to your current login session. Signing out ends access. '
              : 'Only members of your company space can access this recording. '}
            Visual observations require the candidate’s separate agreement.
          </p>
          {selected.bytes > 0 && annotations.panel}
          {!confirmDelete
            ? (
              <button
                type='button'
                tw='btn btn-ghost self-start text-[12px]'
                onClick={() => setConfirmDelete(true)}
              >
                Delete this recording
              </button>
            )
            : (
              <div tw='flex flex-wrap items-center gap-2 text-[13px]'>
                <span>
                  Delete this recording permanently from the application?
                </span>
                <button
                  type='button'
                  tw='btn btn-secondary'
                  disabled={deleting}
                  onClick={async () => {
                    setDeleting(true)
                    try {
                      const response = await fetch(
                        endpoint(v.candidateId, selected.id),
                        { method: 'DELETE' },
                      )
                      if (!response.ok) {
                        throw Error('The recording could not be deleted.')
                      }
                      const remaining = recordings.filter((r) =>
                        r.id !== selected.id
                      )
                      setRecordings(remaining)
                      available.value = remaining.filter((r) => r.bytes > 0)
                        .map((r) => r.id)
                      setSelectedId(remaining.at(-1)?.id ?? '')
                      setConfirmDelete(false)
                    } catch (error) {
                      setError(
                        error instanceof Error ? error.message : String(error),
                      )
                    } finally {
                      setDeleting(false)
                    }
                  }}
                >
                  Confirm deletion
                </button>
                <button
                  type='button'
                  tw='btn btn-ghost'
                  disabled={deleting}
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
              </div>
            )}
        </>
      )}
    </section>
  )
}
