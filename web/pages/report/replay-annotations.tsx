import { useEffect, useRef, useState } from 'preact/hooks'
import type { RefObject } from 'preact'
import type { RecordingView, ReportView } from '/web/types.ts'
import type {
  ReplayAnalysis,
  ReplayMoment,
} from '/web/lib/replay-analysis-types.ts'
import { sampleReplayFrames } from '/web/lib/replay-frames.ts'

const time = (ms: number) =>
  `${Math.floor(ms / 60_000)}:${
    String(Math.floor(ms / 1000) % 60).padStart(2, '0')
  }`
const label = (m: ReplayMoment) =>
  m.source === 'image'
    ? 'Visual observation · AI interpretation'
    : m.kind === 'strength'
    ? 'Strong moment · AI interpretation'
    : 'Point to verify · AI interpretation'

export const useReplayAnnotations = (
  report: ReportView,
  recording: RecordingView | undefined,
  position: number,
  player: RefObject<HTMLVideoElement>,
  endpoint: string,
) => {
  const [analysis, setAnalysis] = useState<ReplayAnalysis>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [show, setShow] = useState(true)
  const [includeImages, setIncludeImages] = useState(true)
  const operation = useRef<AbortController>()
  const id = recording?.id
  useEffect(() => {
    setAnalysis(undefined)
    setError('')
    setBusy(false)
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const response = await fetch(`${endpoint}&analysis=1`, {
          signal: abort.signal,
        })
        if (!response.ok) throw Error('Replay analysis could not be loaded.')
        const value: ReplayAnalysis = await response.json()
        if (abort.signal.aborted) return
        setAnalysis(value)
        if (value.status === 'pending') timer = setTimeout(load, 2000)
      } catch (e) {
        if (!abort.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e))
        }
      }
    }
    if (id) load()
    return () => {
      abort.abort()
      clearTimeout(timer)
      operation.current?.abort()
    }
  }, [id, endpoint])
  const seek = (atMs: number) => {
    if (player.current) {
      player.current.currentTime = Math.max(0, atMs / 1000 - 3)
      player.current.play().catch(() => {})
    }
  }
  const active = show
    ? analysis?.moments.findLast((m) =>
      position * 1000 >= m.atMs && position * 1000 < m.atMs + 7000
    )
    : undefined
  const analyze = async () => {
    if (!recording || busy) return
    const abort = new AbortController()
    operation.current = abort
    setBusy(true)
    setError('')
    try {
      const frames = analysis?.visualAllowed && includeImages
        ? await sampleReplayFrames(endpoint, recording.durationMs, abort.signal)
        : []
      const response = await fetch(`${endpoint}&analysis=1`, {
        method: 'POST',
        signal: abort.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ frames }),
      })
      const value = await response.json()
      if (!response.ok) throw Error(value.error ?? 'Replay analysis failed.')
      if (!abort.signal.aborted) setAnalysis(value)
    } catch (e) {
      if (!abort.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (!abort.signal.aborted) setBusy(false)
    }
  }
  return {
    overlay: active && (
      <aside
        aria-label='Current replay annotation'
        aria-live='off'
        style={{
          position: 'absolute',
          left: '12px',
          right: '12px',
          bottom: '52px',
          background: 'rgba(13,19,35,.94)',
          color: '#fff',
          padding: '12px',
          borderRadius: '8px',
          maxHeight: '130px',
          overflow: 'auto',
        }}
      >
        <div style={{ fontSize: '11px', opacity: 0.8 }}>
          {time(active.atMs)} · {label(active)}
        </div>
        <strong>{active.title}</strong>
        <p style={{ margin: '4px 0 0', fontSize: '13px' }}>{active.detail}</p>
      </aside>
    ),
    panel: (
      <div tw='flex flex-col gap-3'>
        <h3 tw='m-0 text-[15px] font-semibold'>Key moments</h3>
        <p tw='m-0 text-[12px] text-content-secondary'>
          AI annotations help you inspect the evidence. They do not establish
          cheating or decide the outcome. Transcript positions are approximate.
          Image observations cover sampled frames only.
        </p>
        {analysis?.status !== 'ready' && (
          <>
            {analysis?.visualAllowed
              ? (
                <label tw='flex items-start gap-2 text-[13px]'>
                  <input
                    type='checkbox'
                    checked={includeImages}
                    disabled={busy || analysis.status === 'pending'}
                    onChange={(e) => setIncludeImages(e.currentTarget.checked)}
                  />
                  Include up to 12 sampled images for visibility and image
                  quality. The candidate opted in.
                </label>
              )
              : (
                <p tw='m-0 text-[12px] text-content-secondary'>
                  No visual-analysis agreement was recorded. Only transcript and
                  code will be analyzed.
                </p>
              )}
            <button
              type='button'
              tw='btn btn-secondary self-start'
              disabled={busy || analysis?.status === 'pending' || !analysis ||
                recording?.status === 'recording'}
              onClick={analyze}
            >
              {busy || analysis?.status === 'pending'
                ? 'Analyzing key moments…'
                : 'Analyze key moments'}
            </button>
          </>
        )}
        {(error || analysis?.error) && (
          <p role='alert' tw='m-0 text-[13px] text-err'>
            {error || analysis?.error}
          </p>
        )}
        {analysis?.status === 'ready' && (
          <>
            <label tw='flex items-center gap-2 text-[13px]'>
              <input
                type='checkbox'
                checked={show}
                onChange={(e) => setShow(e.currentTarget.checked)}
              />Show annotations on video
            </label>
            <p tw='m-0 text-[12px] text-content-tertiary'>
              {analysis.trace?.model} · {analysis.moments.length} moments ·{' '}
              {analysis.sampledAtMs.length}{' '}
              sampled images. The original recording is unchanged. No
              image-based skill or honesty assessment.
            </p>
            {show && recording && (
              <div
                aria-label='Key moments timeline'
                style={{
                  position: 'relative',
                  height: '24px',
                  background: 'var(--color-surface-elevated)',
                  borderRadius: '6px',
                }}
              >
                {analysis.moments.map((m, i) => (
                  <button
                    key={i}
                    type='button'
                    aria-label={`${time(m.atMs)} ${m.title}`}
                    title={`${time(m.atMs)} · ${m.title}`}
                    onClick={() => seek(m.atMs)}
                    style={{
                      position: 'absolute',
                      left: `${
                        Math.min(
                          98,
                          m.atMs / Math.max(1, recording.durationMs) * 100,
                        )
                      }%`,
                      height: '22px',
                      minWidth: '8px',
                      width: '8px',
                      border: 0,
                      borderRadius: '3px',
                      cursor: 'pointer',
                      background: m.kind === 'strength'
                        ? '#26a69a'
                        : m.source === 'image'
                        ? '#8b87f5'
                        : '#efb547',
                    }}
                  />
                ))}
              </div>
            )}
            {!analysis.moments.length && (
              <p>
                No supported key moment was identified. This is not a finding
                about the candidate.
              </p>
            )}
            <ol tw='m-0 p-0 list-none flex flex-col gap-2'>
              {analysis.moments.map((m, i) => (
                <li
                  key={i}
                  tw='border border-border-primary rounded-lg p-3 text-[13px]'
                >
                  <button
                    type='button'
                    tw='btn btn-ghost text-left'
                    onClick={() => seek(m.atMs)}
                  >
                    {time(m.atMs)} · {m.title}
                  </button>
                  <div tw='text-[11px] text-content-tertiary'>{label(m)}</div>
                  <p>{m.detail}</p>
                  {m.quote && (
                    <blockquote tw='m-0 border-l-2 border-border-strong pl-3'>
                      {m.quote}
                    </blockquote>
                  )}
                  {m.code && (
                    <details>
                      <summary>
                        {m.code.path} · lines {m.code.from}–{m.code.to}
                      </summary>
                      <pre tw='overflow-auto text-[12px]'>{report.files[m.code.path]?.split('\n').slice(m.code.from - 1, m.code.to).join('\n')}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    ),
  }
}
