// Where things are in a replay: who speaks when, which moment is current, what
// comes next. Pure functions, shared by the player and its lists.
import type { InterviewLine } from '/web/types.ts'
import type { ReplayMoment } from './replay-analysis-types.ts'

/** a jump starts a little before the passage: positions are approximate */
export const LEAD_MS = 1500
/** how long a moment stays "current" after its position */
export const MOMENT_MS = 8000
/** a caption stays on screen this long after the last word */
const HOLD_MS = 1200

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const percent = (ms: number, durationMs: number) =>
  durationMs > 0 ? Math.min(100, Math.max(0, ms / durationMs * 100)) : 0

/** a line of the transcript placed in one recording */
export type Span = {
  index: number
  who: InterviewLine['who']
  text: string
  from: number
  to: number
}

/**
 * The lines of one recording, in order. A line ends at its last word when the
 * server measured it (`at`, `endAt`), else where the next line starts.
 */
export const spansOf = (
  lines: InterviewLine[],
  recordingId: string,
  durationMs: number,
): Span[] => {
  const spans = lines.flatMap((line, index) =>
    line.recordingId === recordingId && Number.isFinite(line.atMs)
      ? [{
        index,
        who: line.who,
        text: line.text,
        from: Math.max(0, line.atMs!),
        to: line.at !== undefined && line.endAt !== undefined &&
            line.endAt > line.at
          ? line.atMs! + line.endAt - line.at
          : NaN,
      }]
      : []
  ).sort((a, b) => a.from - b.from)
  const end = durationMs > 0 ? durationMs : Infinity
  spans.forEach((span, i) => {
    const next = spans[i + 1]?.from ?? end
    if (!Number.isFinite(span.to)) span.to = next
    span.to = Math.max(span.from, Math.min(span.to, end))
  })
  return spans
}

/**
 * The length of a recording the server has not closed yet (its duration is 0
 * until then): the end of the last line placed in it, plus a short margin.
 */
export const estimateDuration = (
  lines: InterviewLine[],
  recordingId: string,
) =>
  lines.reduce(
    (end, line) =>
      line.recordingId === recordingId && Number.isFinite(line.atMs)
        ? Math.max(
          end,
          line.atMs! + (line.at !== undefined && line.endAt !== undefined
            ? Math.max(0, line.endAt - line.at)
            : 0) +
            2000,
        )
        : end,
    0,
  )

/** the line heard at `ms` (the latest one when two overlap), if any */
export const spanAt = (spans: Span[], ms: number) =>
  spans.findLast((s) => ms >= s.from && ms < s.to + HOLD_MS)

/** where a jump to an answer lands: just before its first words */
export const answerStart = (s: Span) => Math.max(0, s.from - LEAD_MS / 2)

/**
 * The candidate's next or previous answer, from `ms`. Compared on the landing
 * position, so pressing "next" again from a landing goes further. "Previous"
 * well inside an answer goes back to its start, like a media player.
 */
export const answerFrom = (spans: Span[], ms: number, step: 1 | -1) => {
  const answers = spans.filter((s) => s.who === 'candidate')
  return step === 1
    ? answers.find((s) => answerStart(s) > ms + 250)
    : answers.findLast((s) => answerStart(s) < ms - 2000)
}

/** the moment being replayed: from a little before it to a while after */
export const momentAt = (moments: ReplayMoment[], ms: number) =>
  moments.findLastIndex((m) =>
    ms >= m.atMs - LEAD_MS && ms < m.atMs + MOMENT_MS
  )
