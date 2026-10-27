// Oracle as a luminous orb, like the voice modes of assistants: it breathes
// when idle, swells and ripples with the microphone while the candidate talks,
// swirls slowly while Oracle thinks, and pulses with the sentence Oracle
// speaks. It follows the pointer a little. Canvas 2D: a few translucent blobs,
// each a circle whose radius is bent by a looping noise, added together.
import { useEffect, useRef } from 'preact/hooks'
import { voice } from '/web/lib/voice-client.ts'
import { mouthNow } from '/web/lib/lip-sync.ts'

const TAU = Math.PI * 2
const POINTS = 120

type Layer = {
  seed: number
  scale: number
  speed: number
  /** rgb of the center, the body and the edge */
  core: string
  mid: string
  edge: string
}

const LAYERS: Layer[] = [
  {
    seed: 0,
    scale: 1,
    speed: 1,
    core: '255,255,255',
    mid: '167,152,255',
    edge: '108,92,231',
  },
  {
    seed: 2.1,
    scale: 0.92,
    speed: -0.8,
    core: '214,204,255',
    mid: '124,104,244',
    edge: '70,52,200',
  },
  {
    seed: 4.2,
    scale: 0.82,
    speed: 1.25,
    core: '170,205,255',
    mid: '96,128,255',
    edge: '60,72,210',
  },
]

const lerp = (from: number, to: number, k: number) => from + (to - from) * k

/** a smooth noise that loops around the circle (whole numbers of waves) */
const wobble = (angle: number, t: number, seed: number) =>
  Math.sin(angle * 2 + t * 0.7 + seed) * 0.5 +
  Math.sin(angle * 3 - t * 0.9 + seed * 1.7) * 0.3 +
  Math.sin(angle * 5 + t * 1.3 + seed * 2.3) * 0.2

/** fills its parent, which must be positioned */
export const OracleOrb = () => {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = host.current
    const cv = canvas.current
    const ctx = cv?.getContext('2d')
    if (!el || !cv || !ctx) return

    let width = 1
    let height = 1
    const resize = () => {
      const dpr = Math.min(devicePixelRatio, 2)
      width = el.clientWidth || 1
      height = el.clientHeight || 1
      cv.width = Math.round(width * dpr)
      cv.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(el)

    // the pointer, from -1 to 1 around the center of the stage
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 }
    const onMove = (e: PointerEvent) => {
      const box = el.getBoundingClientRect()
      pointer.tx = Math.max(
        -1,
        Math.min(1, (e.clientX - (box.left + box.width / 2)) / innerWidth * 2),
      )
      pointer.ty = Math.max(
        -1,
        Math.min(1, (e.clientY - (box.top + box.height / 2)) / innerHeight * 2),
      )
    }
    addEventListener('pointermove', onMove)

    const state = { listen: 0, think: 0, speak: 0, level: 0, clock: 0 }
    let last = performance.now()
    let frame = 0

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const speaking = voice.speaking.peek()
      const listening = voice.listening.peek()
      const thinking = !!voice.writing.peek() && !speaking

      // each state eases in and out: the orb never snaps
      state.listen = lerp(state.listen, listening ? 1 : 0, 0.08)
      state.think = lerp(state.think, thinking ? 1 : 0, 0.05)
      state.level = lerp(state.level, listening ? voice.level.peek() : 0, 0.25)
      // the voice has no signal to read: the shape of the lips gives the beat
      const beat = speaking
        ? mouthNow(now).open * (0.8 + 0.2 * Math.sin(now / 90))
        : 0
      state.speak = lerp(state.speak, beat, 0.3)
      // swirling is faster while thinking
      state.clock += dt * (1 + state.think * 1.6 + state.speak * 0.8)
      const t = state.clock

      pointer.x = lerp(pointer.x, pointer.tx, 0.04)
      pointer.y = lerp(pointer.y, pointer.ty, 0.04)

      const size = Math.min(width, height)
      const base = size * 0.24
      const voiceLevel = Math.min(1, state.level * 2.2)
      const swell = 1 + Math.sin(t * 1.1) * 0.025 + voiceLevel * 0.16 +
        state.speak * 0.2
      const bend = 0.04 + state.think * 0.05 + voiceLevel * 0.14 +
        state.speak * 0.2
      const cx = width / 2 + pointer.x * base * 0.12
      const cy = height * 0.46 + pointer.y * base * 0.12

      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)

      // the glow around, stronger when something is happening
      const energy = Math.min(1, voiceLevel + state.speak + state.think * 0.4)
      const halo = ctx.createRadialGradient(
        cx,
        cy,
        base * 0.4,
        cx,
        cy,
        base * 3,
      )
      halo.addColorStop(0, `rgba(108,92,231,${0.22 + 0.25 * energy})`)
      halo.addColorStop(1, 'rgba(108,92,231,0)')
      ctx.fillStyle = halo
      ctx.fillRect(0, 0, width, height)

      ctx.globalCompositeOperation = 'lighter'
      for (const layer of LAYERS) {
        const radius = base * layer.scale * swell
        ctx.beginPath()
        for (let i = 0; i <= POINTS; i++) {
          const a = (i / POINTS) * TAU
          const r = radius * (1 + bend * wobble(a, t * layer.speed, layer.seed))
          const x = cx + Math.cos(a) * r
          const y = cy + Math.sin(a) * r
          if (i) ctx.lineTo(x, y)
          else ctx.moveTo(x, y)
        }
        ctx.closePath()
        // the light sits toward the pointer
        const fx = cx - pointer.x * radius * 0.22
        const fy = cy - pointer.y * radius * 0.22
        const body = ctx.createRadialGradient(
          fx,
          fy,
          radius * 0.05,
          cx,
          cy,
          radius * 1.25,
        )
        body.addColorStop(0, `rgba(${layer.core},0.85)`)
        body.addColorStop(0.45, `rgba(${layer.mid},0.5)`)
        body.addColorStop(1, `rgba(${layer.edge},0)`)
        ctx.fillStyle = body
        ctx.fill()
      }

      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frame)
      removeEventListener('pointermove', onMove)
      observer.disconnect()
    }
  }, [])

  return (
    <div
      ref={host}
      aria-hidden='true'
      tw='absolute inset-0'
      style={{ background: '#000' }}
    >
      <canvas
        ref={canvas}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  )
}
