import { eq, test } from '/api/lib/test.ts'
import {
  answerFrom,
  answerStart,
  clock,
  estimateDuration,
  momentAt,
  percent,
  spanAt,
  spansOf,
} from './replay-timeline.ts'

const lines = [
  { who: 'ai', text: 'Question one', recordingId: 'r', atMs: 2000 },
  {
    who: 'candidate',
    text: 'Answer one',
    recordingId: 'r',
    atMs: 10000,
    at: 50000,
    endAt: 58000,
  },
  { who: 'ai', text: 'Question two', recordingId: 'r', atMs: 30000 },
  { who: 'candidate', text: 'Other attempt', recordingId: 'x', atMs: 1000 },
  { who: 'candidate', text: 'No position', recordingId: 'r' },
  { who: 'candidate', text: 'Answer two', recordingId: 'r', atMs: 40000 },
]

test('replay timeline: lines placed in their recording, current line, jumps', async (step) => {
  const spans = spansOf(lines, 'r', 60000)
  await step(
    'only the lines of this recording with a position, in order',
    () => {
      eq(spans.map((s) => s.text), [
        'Question one',
        'Answer one',
        'Question two',
        'Answer two',
      ])
      eq(spans.map((s) => s.index), [0, 1, 2, 5])
    },
  )
  await step(
    'a measured line ends at its last word, the others at the next line',
    () => {
      eq(spans[1].to, 18000)
      eq(spans[0].to, 10000)
      eq(spans[3].to, 60000)
    },
  )
  await step('the current line, with a short hold after the last word', () => {
    eq(spanAt(spans, 0), undefined)
    eq(spanAt(spans, 12000)?.text, 'Answer one')
    eq(spanAt(spans, 18500)?.text, 'Answer one')
    eq(spanAt(spans, 25000), undefined)
  })
  await step('next and previous answers skip the questions', () => {
    eq(answerFrom(spans, 0, 1)?.text, 'Answer one')
    eq(answerFrom(spans, 12000, 1)?.text, 'Answer two')
    // well inside an answer: back to its start, like a media player
    eq(answerFrom(spans, 45000, -1)?.text, 'Answer two')
    // just after the start of an answer: previous means the one before
    eq(answerFrom(spans, 41000, -1)?.text, 'Answer one')
    eq(answerFrom(spans, 50000, 1), undefined)
    // pressing "next" again from where a jump landed goes further
    const first = answerFrom(spans, 0, 1)
    eq(answerFrom(spans, answerStart(first), 1)?.text, 'Answer two')
    // and "previous" right after a landing goes to the answer before
    const second = answerFrom(spans, answerStart(first), 1)
    eq(answerFrom(spans, answerStart(second) + 300, -1)?.text, 'Answer one')
  })
  await step(
    'a moment is current from just before it until a while after',
    () => {
      const moments = [{ atMs: 10000 }, { atMs: 40000 }]
      eq(momentAt(moments, 5000), -1)
      eq(momentAt(moments, 9000), 0)
      eq(momentAt(moments, 17000), 0)
      eq(momentAt(moments, 19000), -1)
      eq(momentAt(moments, 41000), 1)
    },
  )
  await step(
    'an unclosed recording gets its length from the transcript',
    () => {
      // Answer two at 40 s, no measured end: 42 s. Answer one ends at 18 s.
      eq(estimateDuration(lines, 'r'), 42000)
      eq(estimateDuration(lines, 'x'), 3000)
      eq(estimateDuration(lines, 'none'), 0)
    },
  )
  await step('clock and position on the track', () => {
    eq(clock(0), '0:00')
    eq(clock(61999), '1:01')
    eq(clock(-5), '0:00')
    eq(percent(30000, 60000), 50)
    eq(percent(90000, 60000), 100)
    eq(percent(10, 0), 0)
  })
})
