// Cleanify's presence: a soft light of a pure blue, calm and deep.
// It breathes slowly when nothing happens, gathers a little and brightens with
// the microphone while the candidate talks, drifts slowly while Cleanify thinks,
// and sends slow rings out with the voice while Cleanify speaks. Nothing snaps:
// every state eases in and out. Canvas 2D, a few blurred translucent blobs.
import { useEffect, useRef } from 'preact/hooks'
import { voice } from '/web/lib/voice-client.ts'
import { mouthNow } from '/web/lib/lip-sync.ts'

const TAU = Math.PI * 2
const POINTS = 96

/** the deep blue night the presence lives on */
export const STAGE_BACKGROUND =
  'radial-gradient(120% 90% at 50% 38%, #10213f 0%, #0a1528 52%, #050a15 100%)'

type Layer = {
  seed: number
  scale: number
  speed: number
  blur: number
  /** rgb of the center and of the edge */
  core: string
  edge: string
  alpha: number
}

const LAYERS: Layer[] = [
  // the wide soft body
  {
    seed: 0,
    scale: 1.05,
    speed: 0.7,
    blur: 0.05,
    core: '60,130,255',
    edge: '20,70,235',
    alpha: 0.46,
  },
  // the middle, brighter
  {
    seed: 2.1,
    scale: 0.86,
    speed: -0.9,
    blur: 0.035,
    core: '110,170,255',
    edge: '35,100,250',
    alpha: 0.54,
  },
  // the bright core
  {
    seed: 4.2,
    scale: 0.58,
    speed: 1.1,
    blur: 0.02,
    core: '200,225,255',
    edge: '90,155,255',
    alpha: 0.66,
  },
]

type Ring = { born: number; strength: number }

const lerp = (from: number, to: number, k: number) => from + (to - from) * k

/** a smooth noise that loops around the circle (whole numbers of waves) */
const wobble = (angle: number, t: number, seed: number) =>
  Math.sin(angle * 2 + t * 0.6 + seed) * 0.55 +
  Math.sin(angle * 3 - t * 0.8 + seed * 1.7) * 0.3 +
  Math.sin(angle * 4 + t * 1.1 + seed * 2.3) * 0.15

/** the strength of the voice now, from 0 to 1 */
const voiceNow = (now: number) => {
  const real = voice.amplitude.peek()
  // a voice with no signal to read (the browser's): the lips give the beat
  return real > 0
    ? real
    : voice.speaking.peek()
    ? mouthNow(now).open * (0.8 + 0.2 * Math.sin(now / 90))
    : 0
}

/** fills its parent, which must be positioned */
export const CleanifyOrb = () => {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = host.current
    const cv = canvas.current
    const ctx = cv?.getContext('2d')
    if (!el || !cv || !ctx) return

    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
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
    if (!calm) addEventListener('pointermove', onMove)

    const state = { listen: 0, think: 0, speak: 0, level: 0, clock: 0 }
    const rings: Ring[] = []
    let lastRing = 0
    let last = performance.now()
    let frame = 0
    const motion = calm ? 0.35 : 1

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const speaking = voice.speaking.peek()
      const listening = voice.listening.peek()
      const thinking = !!voice.writing.peek() && !speaking

      // each state eases in and out: it never snaps
      state.listen = lerp(state.listen, listening ? 1 : 0, 0.06)
      state.think = lerp(state.think, thinking ? 1 : 0, 0.04)
      state.level = lerp(state.level, listening ? voice.level.peek() : 0, 0.2)
      state.speak = lerp(state.speak, speaking ? voiceNow(now) : 0, 0.22)
      // slow at rest, a little livelier with the voice
      state.clock += dt * (0.8 + state.think * 0.6 + state.speak * 0.6) * motion
      const t = state.clock

      pointer.x = lerp(pointer.x, pointer.tx, 0.03)
      pointer.y = lerp(pointer.y, pointer.ty, 0.03)

      const size = Math.min(width, height)
      const base = size * 0.25
      const heard = Math.min(1, state.level * 2.2)
      const breath = Math.sin(t * 0.9) * 0.028 * motion
      // listening: it gathers, then widens with the voice of the candidate
      const gather = 1 - state.listen * 0.06 + heard * 0.1 * motion
      const swell = (1 + breath + state.speak * 0.13 * motion) * gather
      const bend = (0.03 + state.think * 0.025 + heard * 0.08 +
        state.speak * 0.1) * motion
      const cx = width / 2 + pointer.x * base * 0.1
      const cy = height * 0.44 + pointer.y * base * 0.1
      const energy = Math.min(1, heard * 0.7 + state.speak + state.think * 0.25)

      ctx.globalCompositeOperation = 'source-over'
      ctx.filter = 'none'
      ctx.clearRect(0, 0, width, height)

      // the glow on the stage, stronger when something happens
      const halo = ctx.createRadialGradient(
        cx,
        cy,
        base * 0.3,
        cx,
        cy,
        base * 3.4,
      )
      halo.addColorStop(0, `rgba(40,110,255,${0.12 + 0.2 * energy})`)
      halo.addColorStop(0.5, `rgba(20,70,235,${0.05 + 0.08 * energy})`)
      halo.addColorStop(1, 'rgba(20,70,235,0)')
      ctx.fillStyle = halo
      ctx.fillRect(0, 0, width, height)

      // rings leave with the voice, slow and thin
      if (
        speaking && state.speak > 0.14 &&
        now - lastRing > 520 - state.speak * 240
      ) {
        rings.push({ born: now, strength: 0.14 + state.speak * 0.3 })
        lastRing = now
      }
      ctx.globalCompositeOperation = 'lighter'
      for (let i = rings.length - 1; i >= 0; i--) {
        const age = (now - rings[i].born) / 2800
        if (age >= 1) {
          rings.splice(i, 1)
          continue
        }
        ctx.beginPath()
        ctx.arc(cx, cy, base * (1.1 + age * 1.1), 0, TAU)
        ctx.strokeStyle = `rgba(150,200,255,${
          rings[i].strength * (1 - age) ** 2
        })`
        ctx.lineWidth = 1.3
        ctx.stroke()
      }
      // listening: a soft ring close to the form, brighter with the voice
      if (state.listen > 0.02) {
        ctx.beginPath()
        ctx.arc(cx, cy, base * (1.2 + heard * 0.16), 0, TAU)
        ctx.strokeStyle = `rgba(170,210,255,${
          state.listen * (0.1 + heard * 0.4)
        })`
        ctx.lineWidth = 1.5
        ctx.stroke()
      }

      for (const layer of LAYERS) {
        const radius = base * layer.scale * swell
        ctx.filter = calm ? 'none' : `blur(${Math.round(size * layer.blur)}px)`
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
        // the light sits toward the pointer, and drifts while Cleanify thinks
        const drift = state.think * Math.sin(t * 0.8 + layer.seed) * 0.18
        const fx = cx - (pointer.x * 0.2 + drift) * radius
        const fy = cy - (pointer.y * 0.2 - drift * 0.6) * radius
        const body = ctx.createRadialGradient(
          fx,
          fy,
          radius * 0.04,
          cx,
          cy,
          radius * 1.2,
        )
        const glow = layer.alpha * (0.88 + 0.12 * energy)
        body.addColorStop(0, `rgba(${layer.core},${glow})`)
        body.addColorStop(0.55, `rgba(${layer.edge},${glow * 0.55})`)
        body.addColorStop(1, `rgba(${layer.edge},0)`)
        ctx.fillStyle = body
        ctx.fill()
      }
      ctx.filter = 'none'

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
    >
      <canvas ref={canvas} tw='w-full h-full block' />
    </div>
  )
}
