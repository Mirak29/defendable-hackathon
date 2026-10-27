// The shape of Oracle's mouth from the sentence being spoken
// (voice-client.ts: `speech`). The mouth comes from the letters of the text,
// timed by the voice's word events when the voice gives them, by the clock
// otherwise. `open` goes from 0 (closed) to 1, `wide` from -1 (pursed) to 1.
import { voice } from '/web/lib/voice-client.ts'

export type Mouth = { open: number; wide: number }

export const REST: Mouth = { open: 0.02, wide: 0 }

/** the lips for one letter */
const visemeOf = (char: string): Mouth => {
  const c = char.toLowerCase()
  if (c === 'a') return { open: 0.95, wide: 0.2 }
  if (c === 'e') return { open: 0.55, wide: 0.7 }
  if (c === 'i') return { open: 0.35, wide: 0.9 }
  if (c === 'o') return { open: 0.75, wide: -0.6 }
  if ('uw'.includes(c)) return { open: 0.4, wide: -0.9 }
  if ('mbp'.includes(c)) return { open: 0.02, wide: 0 }
  if ('fv'.includes(c)) return { open: 0.14, wide: 0.2 }
  if ('sz'.includes(c)) return { open: 0.18, wide: 0.6 }
  if ('tdnlr'.includes(c)) return { open: 0.3, wide: 0.2 }
  if (/[a-z]/.test(c)) return { open: 0.3, wide: 0 }
  return REST
}

/** characters per second of a voice at rate 1.05, near enough to follow it */
export const CHARS_PER_SECOND = 15

/** the mouth now, from the sentence and how far the voice is in it */
export const mouthNow = (now: number): Mouth => {
  const { text, charIndex, at } = voice.speech.peek()
  if (!text || !voice.speaking.peek()) return REST
  const elapsed = (now - at) / 1000
  // a voice without word events stays at 0: the clock then drives the lips
  const clockOnly = charIndex === 0 && elapsed > 0.4
  const wordEnd = text.indexOf(' ', charIndex)
  const limit = clockOnly
    ? text.length - 1
    : (wordEnd < 0 ? text.length : wordEnd) - 1
  const position = Math.min(
    limit,
    charIndex + Math.floor(elapsed * CHARS_PER_SECOND),
  )
  return visemeOf(text[Math.max(0, position)] ?? ' ')
}
