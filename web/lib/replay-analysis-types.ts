import type { AiTrace } from '/web/types.ts'

export type ReplayFrame = { atMs: number; image: string }
export type ReplayMoment = {
  atMs: number
  kind: 'point-to-check' | 'strength' | 'camera-obscured' | 'frame-unreadable'
  title: string
  detail: string
  source: 'transcript' | 'image'
  quote?: string
  lineIndex?: number
  code?: { path: string; from: number; to: number }
}
export type ReplayAnalysis = {
  status: 'idle' | 'pending' | 'ready' | 'failed'
  visualAllowed: boolean
  moments: ReplayMoment[]
  sampledAtMs: number[]
  trace?: AiTrace
  error?: string
}
