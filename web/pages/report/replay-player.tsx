// The replay player. A recording made by the browser (MediaRecorder WebM) has
// no duration in its header: the native controls show no usable scrubber, so
// the track is drawn from the duration measured by the server.
// The playhead moves by direct style writes on animation frames; components
// re-render only when the line or moment they show changes.
import { signal, useComputed } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import type { ReplayMoment } from '/web/lib/replay-analysis-types.ts'
import {
  answerFrom,
  answerStart,
  clock,
  LEAD_MS,
  momentAt,
  percent,
  type Span,
  spanAt,
} from '/web/lib/replay-timeline.ts'
import {
  Captions,
  LoaderCircle,
  Maximize,
  Minimize,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from '/web/assets/icons.tsx'

/** playback position (ms), updated a few times a second */
export const playhead = signal(0)
/** a jump asked before the player of that recording was ready */
const pending = signal<{ id: string; atMs: number } | null>(null)
let mounted:
  | { id: string; seek: (ms: number, play: boolean) => void; focus: () => void }
  | undefined

/** jump to a position of a recording, from anywhere in the report */
export const replayAt = (id: string, atMs: number) => {
  if (mounted?.id === id) {
    mounted.seek(atMs - LEAD_MS, true)
    mounted.focus()
  } else {
    pending.value = { id, atMs }
    document.getElementById('interview-replay')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }
}
export const pendingReplay = pending

const RATES = [1, 1.25, 1.5, 2]
const KIND_LABEL: Record<ReplayMoment['kind'], string> = {
  'point-to-check': 'To verify',
  'strength': 'Solid explanation',
}
export const kindLabel = (m: ReplayMoment) => KIND_LABEL[m.kind]

const Control = (
  { label, onClick, children, pressed, wide }: {
    label: string
    onClick: () => void
    children: ComponentChildren
    pressed?: boolean
    /** only from the sm breakpoint: the row must fit a phone */
    wide?: boolean
  },
) => (
  <button
    type='button'
    aria-label={label}
    aria-pressed={pressed}
    title={label}
    onClick={onClick}
    tw={[
      'w-8 h-8 flex-none items-center justify-center rounded-md border-0 bg-transparent text-console-text cursor-pointer hover:bg-console-tab focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      wide ? 'hidden sm:inline-flex' : 'inline-flex',
    ]}
  >
    {children}
  </button>
)

const Clock = ({ durationMs }: { durationMs: number }) => (
  <span
    aria-hidden='true'
    tw='font-mono text-[12px] text-console-muted whitespace-nowrap'
    style={{ fontVariantNumeric: 'tabular-nums' }}
  >
    <span tw='text-console-text'>{clock(playhead.value)}</span>
    {' / '}
    {clock(durationMs)}
  </span>
)

const Caption = ({ spans }: { spans: Span[] }) => {
  const line = useComputed(() => spanAt(spans, playhead.value))
  const now = line.value
  if (!now) return null
  return (
    <div
      aria-hidden='true'
      style={{
        position: 'absolute',
        left: '50%',
        bottom: '14px',
        transform: 'translateX(-50%)',
        width: 'min(88%, 720px)',
        textAlign: 'center',
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          background: 'rgba(8,10,20,.78)',
          color: '#fff',
          borderRadius: '8px',
          padding: '6px 12px',
          fontSize: '14px',
          lineHeight: 1.45,
        }}
      >
        <strong
          style={{
            color: now.who === 'ai' ? 'oklch(0.8 0.12 310)' : '#fff',
            fontWeight: 600,
          }}
        >
          {now.who === 'ai' ? 'Oracle' : 'Candidate'}
          {' · '}
        </strong>
        {now.text}
      </span>
    </div>
  )
}

/** in full screen the list is hidden: the current moment is shown on the video */
const MomentBadge = ({ moments }: { moments: ReplayMoment[] }) => {
  const index = useComputed(() => momentAt(moments, playhead.value))
  const m = moments[index.value]
  if (!m) return null
  return (
    <div
      role='status'
      style={{
        position: 'absolute',
        left: '14px',
        top: '14px',
        maxWidth: '60%',
        background: 'rgba(8,10,20,.82)',
        color: '#fff',
        borderRadius: '8px',
        padding: '6px 10px',
        fontSize: '13px',
        borderLeft: '3px solid oklch(0.72 0.16 310)',
      }}
    >
      <span style={{ opacity: 0.75 }}>{kindLabel(m)} · AI ·</span>
      {m.title}
    </div>
  )
}

export const ReplayPlayer = (
  { id, src, durationMs, spans, moments, onError }: {
    id: string
    src: string
    durationMs: number
    spans: Span[]
    moments: ReplayMoment[]
    onError: (message: string) => void
  },
) => {
  const box = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const played = useRef<HTMLDivElement>(null)
  const knob = useRef<HTMLDivElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const [playing, setPlaying] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState(1)
  const [captions, setCaptions] = useState(true)
  const [full, setFull] = useState(false)

  const draw = (ms: number) => {
    const p = `${percent(ms, durationMs)}%`
    if (played.current) played.current.style.width = p
    if (knob.current) knob.current.style.left = p
    track.current?.setAttribute('aria-valuenow', String(Math.round(ms / 1000)))
    track.current?.setAttribute(
      'aria-valuetext',
      `${clock(ms)} of ${clock(durationMs)}`,
    )
  }
  const seek = (ms: number, play = false) => {
    const v = video.current
    if (!v) return
    const t = Math.min(Math.max(0, ms), Math.max(0, durationMs - 250))
    v.currentTime = t / 1000
    playhead.value = t
    draw(t)
    if (play) v.play().catch(() => {})
  }
  const toggle = () => {
    const v = video.current
    if (!v) return
    v.paused ? v.play().catch(() => {}) : v.pause()
  }
  const jumpAnswer = (step: 1 | -1) => {
    const target = answerFrom(spans, playhead.peek(), step)
    seek(target ? answerStart(target) : step === 1 ? durationMs : 0)
  }
  const toggleFull = () => {
    const action = document.fullscreenElement
      ? document.exitFullscreen()
      : box.current?.requestFullscreen()
    action?.catch(() => {})
  }

  useEffect(() => {
    playhead.value = 0
    draw(0)
    mounted = {
      id,
      seek: (ms, play) => seek(ms, play),
      focus: () => {
        const el = box.current
        if (!el) return
        el.focus({ preventScroll: true })
        // keep the video in sight: a jump from far down a list scrolls back
        const { top, bottom } = el.getBoundingClientRect()
        if (top < 64 || bottom > innerHeight + 120) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      },
    }
    const changed = () => setFull(document.fullscreenElement === box.current)
    document.addEventListener('fullscreenchange', changed)
    return () => {
      if (mounted?.id === id) mounted = undefined
      document.removeEventListener('fullscreenchange', changed)
    }
  }, [id, durationMs])

  // smooth playhead while playing, without re-rendering anything
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const loop = () => {
      const v = video.current
      if (v && !dragging.current) draw(v.currentTime * 1000)
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [playing, durationMs])

  const ready = () => {
    const jump = pending.peek()
    if (jump?.id === id) {
      pending.value = null
      seek(jump.atMs - LEAD_MS, true)
      box.current?.focus({ preventScroll: true })
    }
  }
  // a jump asked for this recording after it was ready
  useEffect(() => {
    const jump = pending.value
    if (jump?.id === id && video.current?.readyState) ready()
  }, [pending.value, id])

  const msAt = (x: number) => {
    const r = track.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (x - r.left) / r.width)) * durationMs
  }
  const showTip = (x: number, text: string) => {
    const t = tip.current
    const r = track.current?.getBoundingClientRect()
    if (!t || !r) return
    t.textContent = text
    t.style.opacity = '1'
    const half = t.offsetWidth / 2
    t.style.left = `${Math.min(r.width - half, Math.max(half, x - r.left))}px`
  }
  const hideTip = () => {
    if (tip.current) tip.current.style.opacity = '0'
  }
  const tipFor = (ms: number) => {
    const line = spanAt(spans, ms)
    return line
      ? `${clock(ms)} · ${line.who === 'ai' ? 'Oracle' : 'Candidate'}`
      : clock(ms)
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const t = playhead.peek()
    const actions: Record<string, () => void> = {
      ' ': toggle,
      k: toggle,
      ArrowLeft: () => seek(t - 5000),
      ArrowRight: () => seek(t + 5000),
      j: () => seek(t - 10000),
      l: () => seek(t + 10000),
      Home: () => seek(0),
      End: () => seek(durationMs),
      p: () => jumpAnswer(-1),
      n: () => jumpAnswer(1),
      c: () => setCaptions((on) => !on),
      m: () => setMuted((on) => !on),
      f: toggleFull,
    }
    const action = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key]
    if (!action) return
    e.preventDefault()
    action()
  }

  return (
    <div
      ref={box}
      tabIndex={0}
      onKeyDown={onKey}
      aria-label='Interview replay player. Space: play or pause. Arrows: 5 seconds. N and P: next or previous answer. C: captions. F: full screen.'
      tw='flex flex-col rounded-[12px] overflow-hidden bg-console-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent'
      style={full
        ? { height: '100%', borderRadius: 0 }
        : { scrollMarginTop: '76px' }}
    >
      <div
        tw='relative bg-black cursor-pointer'
        style={full
          ? { flex: '1 1 auto', minHeight: 0 }
          : { aspectRatio: '16 / 9', maxHeight: '420px' }}
        onClick={toggle}
      >
        <video
          key={id}
          ref={video}
          src={src}
          playsInline
          preload='metadata'
          muted={muted}
          aria-label='Interview recording'
          onLoadedMetadata={(e) => {
            e.currentTarget.playbackRate = rate
            ready()
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onWaiting={() => setWaiting(true)}
          onSeeking={() => setWaiting(true)}
          onSeeked={() => setWaiting(false)}
          onPlaying={() => setWaiting(false)}
          onTimeUpdate={(e) => {
            const ms = e.currentTarget.currentTime * 1000
            playhead.value = ms
            if (!playing && !dragging.current) draw(ms)
          }}
          onError={() =>
            onError(
              'This recording could not be played. It may be incomplete, or use a format this browser cannot play.',
            )}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: 'block',
          }}
        />
        {captions && <Caption spans={spans} />}
        {full && <MomentBadge moments={moments} />}
        {waiting && playing && (
          <LoaderCircle
            tw='w-8 h-8 text-white animate-spin'
            style={{
              position: 'absolute',
              left: 'calc(50% - 16px)',
              top: 'calc(50% - 16px)',
            }}
          />
        )}
        {!playing && !waiting && (
          <span
            aria-hidden='true'
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              width: '56px',
              height: '56px',
              borderRadius: '50%',
              background: 'rgba(8,10,20,.6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              backdropFilter: 'blur(4px)',
            }}
          >
            <Play tw='w-6 h-6' style={{ marginLeft: '3px' }} />
          </span>
        )}
      </div>
      <div tw='px-3 pt-2.5 pb-2 flex flex-col gap-1.5'>
        <div
          ref={track}
          role='slider'
          tabIndex={-1}
          aria-label='Position in the recording'
          aria-valuemin={0}
          aria-valuemax={Math.round(durationMs / 1000)}
          tw='relative h-5 cursor-pointer select-none'
          style={{ touchAction: 'none' }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            dragging.current = true
            draw(msAt(e.clientX))
          }}
          onPointerMove={(e) => {
            const ms = msAt(e.clientX)
            showTip(e.clientX, tipFor(ms))
            if (dragging.current) draw(ms)
          }}
          onPointerUp={(e) => {
            if (!dragging.current) return
            dragging.current = false
            seek(msAt(e.clientX))
          }}
          onPointerCancel={() => (dragging.current = false)}
          onPointerLeave={hideTip}
        >
          <div
            tw='absolute left-0 right-0 rounded-full overflow-hidden'
            style={{
              top: '7px',
              height: '6px',
              background: 'rgba(255,255,255,.12)',
            }}
          >
            {spans.filter((s) => s.who === 'candidate').map((s) => (
              <span
                key={s.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: `${percent(s.from, durationMs)}%`,
                  width: `${percent(s.to - s.from, durationMs)}%`,
                  background: 'rgba(255,255,255,.34)',
                }}
              />
            ))}
            <div
              ref={played}
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                width: 0,
                background: 'var(--color-accent)',
                opacity: 0.9,
              }}
            />
          </div>
          {moments.map((m, i) => (
            <button
              key={i}
              type='button'
              tabIndex={-1}
              aria-hidden='true'
              onPointerDown={(e) => e.stopPropagation()}
              onPointerMove={(e) => {
                e.stopPropagation()
                showTip(
                  e.clientX,
                  `${clock(m.atMs)} · ${kindLabel(m)} · ${m.title}`,
                )
              }}
              onClick={(e) => {
                e.stopPropagation()
                seek(m.atMs - LEAD_MS, true)
              }}
              tw='absolute p-0 cursor-pointer transition-transform hover:scale-125'
              style={{
                top: '4px',
                left: `calc(${percent(m.atMs, durationMs)}% - 6px)`,
                width: '12px',
                height: '12px',
                borderRadius: m.kind === 'strength' ? '50%' : '3px',
                transform: m.kind === 'strength' ? undefined : 'rotate(45deg)',
                background: 'oklch(0.72 0.16 310)',
                border: '2px solid var(--color-console-bg)',
              }}
            />
          ))}
          <div
            ref={knob}
            aria-hidden='true'
            style={{
              position: 'absolute',
              top: '3px',
              left: 0,
              width: '14px',
              height: '14px',
              marginLeft: '-7px',
              borderRadius: '50%',
              background: '#fff',
              boxShadow: '0 1px 4px rgba(0,0,0,.5)',
              pointerEvents: 'none',
            }}
          />
          <div
            ref={tip}
            aria-hidden='true'
            style={{
              position: 'absolute',
              bottom: '24px',
              left: 0,
              transform: 'translateX(-50%)',
              whiteSpace: 'nowrap',
              maxWidth: '320px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              background: 'rgba(8,10,20,.92)',
              color: '#fff',
              fontSize: '12px',
              padding: '3px 8px',
              borderRadius: '6px',
              opacity: 0,
              transition: 'opacity .12s',
              pointerEvents: 'none',
            }}
          />
        </div>
        <div tw='flex items-center gap-0.5'>
          <Control
            label={playing ? 'Pause (Space)' : 'Play (Space)'}
            onClick={toggle}
          >
            {playing
              ? <Pause tw='w-[18px] h-[18px]' />
              : <Play tw='w-[18px] h-[18px]' />}
          </Control>
          <Control label='Previous answer (P)' onClick={() => jumpAnswer(-1)}>
            <SkipBack tw='w-4 h-4' />
          </Control>
          <Control label='Next answer (N)' onClick={() => jumpAnswer(1)}>
            <SkipForward tw='w-4 h-4' />
          </Control>
          <Control
            wide
            label={muted ? 'Unmute (M)' : 'Mute (M)'}
            onClick={() => setMuted((on) => !on)}
          >
            {muted
              ? <VolumeX tw='w-[18px] h-[18px]' />
              : <Volume2 tw='w-[18px] h-[18px]' />}
          </Control>
          <span tw='ml-2'>
            <Clock durationMs={durationMs} />
          </span>
          <span tw='flex-1' />
          <button
            type='button'
            title='Playback speed'
            aria-label={`Playback speed ${rate}×`}
            onClick={() => {
              const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length]
              setRate(next)
              if (video.current) video.current.playbackRate = next
            }}
            tw='hidden sm:inline-block h-7 min-w-[44px] px-2 rounded-md border border-console-tab bg-transparent text-console-text font-mono text-[12px] cursor-pointer hover:bg-console-tab'
          >
            {rate}×
          </button>
          <Control
            label='Captions (C)'
            pressed={captions}
            onClick={() => setCaptions((on) => !on)}
          >
            <Captions
              tw={['w-[18px] h-[18px]', !captions && 'opacity-[.45]']}
            />
          </Control>
          {typeof document.documentElement.requestFullscreen === 'function' &&
            (
              <Control
                label={full ? 'Exit full screen (F)' : 'Full screen (F)'}
                onClick={toggleFull}
              >
                {full
                  ? <Minimize tw='w-[18px] h-[18px]' />
                  : <Maximize tw='w-[18px] h-[18px]' />}
              </Control>
            )}
        </div>
      </div>
    </div>
  )
}
