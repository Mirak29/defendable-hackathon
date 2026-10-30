// What is said and at which rate: MMS-TTS has no digits in its alphabet and
// speaks at 16 kHz, the interview plays 24 kHz.
import { eq, test } from '/api/lib/test.ts'
import { resample, speakable } from '/api/tts.ts'

test('speakable', async (step) => {
  await step('digits are written as words', () => {
    eq(
      speakable('Status 401, after 10 seconds'),
      'Status four hundred one, after ten seconds',
    )
    eq(speakable('12 files'), 'twelve files')
    eq(
      speakable('about 2,500 requests'),
      'about two thousand five hundred requests',
    )
    eq(speakable('1000000 users'), 'one million users')
  })

  await step('decimals are read digit by digit', () => {
    eq(speakable('0.25 s'), 'zero point two five s')
  })

  await step('symbols the model drops are spelled out', () => {
    eq(
      speakable('90% of tests & checks'),
      'ninety percent of tests and checks',
    )
  })

  await step('symbols the model does not know become spaces', () => {
    eq(speakable('Is user_id in POST /links?'), 'Is user id in POST links?')
    eq(speakable('a == b (camelCase)'), 'a b camelCase')
  })

  await step('hundreds and thousands share one rule', () => {
    eq(speakable('100'), 'one hundred')
    eq(speakable('21'), 'twenty one')
    eq(speakable('100000'), 'one hundred thousand')
    eq(speakable('1,500,000'), 'one million five hundred thousand')
  })

  await step('plain text is left alone', () => {
    eq(
      speakable('Can you walk me through the loop?'),
      'Can you walk me through the loop?',
    )
  })

  await step('a very long number is read digit by digit', () => {
    eq(
      speakable('1234567890123'),
      'one two three four five six seven eight nine zero one two three',
    )
  })
})

test('resample', async (step) => {
  const sine = (hz, rate, seconds) =>
    Float32Array.from(
      { length: Math.floor(rate * seconds) },
      (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * i / rate),
    )

  await step('16 kHz to 24 kHz keeps a 440 Hz tone', () => {
    const out = resample(sine(440, 16_000, 0.5), 16_000, 24_000)
    eq(out.length, 12_000)
    let worst = 0
    // away from the edges, where the filter has no samples on one side
    for (let i = 100; i < out.length - 100; i++) {
      const expected = 0.5 * Math.sin(2 * Math.PI * 440 * i / 24_000)
      worst = Math.max(worst, Math.abs(out[i] - expected))
    }
    eq(worst < 0.01, true, `worst error ${worst}`)
  })

  await step('the same rate returns the samples as they are', () => {
    const input = sine(300, 24_000, 0.1)
    eq(resample(input, 24_000, 24_000), input)
  })
})
