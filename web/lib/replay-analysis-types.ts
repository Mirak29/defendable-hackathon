import type { AiTrace } from '/web/types.ts'

/** a passage worth replaying, read by the AI from the transcript and the code */
export type ReplayMoment = {
  atMs: number
  kind: 'point-to-check' | 'strength'
  title: string
  detail: string
  quote?: string
  lineIndex?: number
  code?: { path: string; from: number; to: number }
}
export type ReplayAnalysis = {
  status: 'idle' | 'pending' | 'ready' | 'failed'
  moments: ReplayMoment[]
  trace?: AiTrace
  error?: string
}
