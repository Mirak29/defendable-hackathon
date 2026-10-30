// Can this machine keep up with Cleanify's voice? Loads the model the way the
// server does, then makes a few sentences and prints, for each, how long it
// took against how long it lasts: below 1 keeps up, below 0.5 is comfortable.
// Run it on the host before choosing its size: `deno task tts:bench`.
import { tts } from '/api/tts.ts'

const SENTENCES = [
  "Hi, I'm Cleanify, and this is just a calm chat about the code you wrote.",
  'What happens if the first line has a well-formed id but fails validation?',
  'Can you walk me through where in the loop that decision happens?',
  'Thanks for walking me through your code, a person will read our conversation.',
]

const started = performance.now()
tts.warmUp()
while (!tts.loaded()) {
  if (performance.now() - started > 120_000) {
    console.log('The voice did not load in 2 minutes (see the log above).')
    Deno.exit(1)
  }
  await new Promise((r) => setTimeout(r, 200))
}
console.log(
  `loaded in ${
    Math.round(performance.now() - started)
  } ms · ${navigator.hardwareConcurrency} logical cores`,
)

const factors: number[] = []
for (let round = 0; round < 2; round++) {
  for (const text of SENTENCES) {
    const t = performance.now()
    const sound = await tts.synthesize(text, () => true)
    const made = performance.now() - t
    // PCM 16-bit mono 24 kHz in base64: 2 bytes per sample
    const bytes = sound ? atob(sound).length : 0
    const length = (bytes / 2 / 24_000) * 1000
    if (!length) continue
    // the first round warms the machine up: only the second one counts
    if (round) factors.push(made / length)
    console.log(
      `round ${round + 1}: ${Math.round(made)} ms for ${
        Math.round(length)
      } ms of sound · factor ${(made / length).toFixed(2)}`,
    )
  }
}
const mean = factors.reduce((a, b) => a + b, 0) / (factors.length || 1)
console.log(`\nfactor, second round: ${mean.toFixed(2)}`)
console.log(
  mean < 0.5
    ? 'Comfortable: the next sentence is ready long before this one ends.'
    : mean < 1
    ? 'It keeps up for one interview, with little margin for two at once.'
    : 'Too slow: the voice would stutter. Take more cores.',
)
Deno.exit(0)
