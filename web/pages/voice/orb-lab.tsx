// A test page for Oracle's presence (not a screen of the product): each state,
// with a made-up voice, to look at it without a microphone.
import { useEffect, useState } from 'preact/hooks'
import { voice } from '/web/lib/voice-client.ts'
import { OracleOrb, STAGE_BACKGROUND } from '/web/ui/oracle-orb.tsx'

type Mode = 'idle' | 'listening' | 'thinking' | 'speaking'

const MODES: [Mode, string][] = [
  ['idle', 'At rest'],
  ['listening', 'Listening'],
  ['thinking', 'Thinking'],
  ['speaking', 'Speaking'],
]

const reset = () => {
  voice.listening.value = false
  voice.speaking.value = false
  voice.writing.value = ''
  voice.level.value = 0
  voice.amplitude.value = 0
}

export const OrbLabPage = () => {
  const [mode, setMode] = useState<Mode>('idle')

  useEffect(() => {
    reset()
    if (mode === 'listening') voice.listening.value = true
    if (mode === 'thinking') voice.writing.value = '…'
    if (mode === 'speaking') voice.speaking.value = true
    // a voice made of words: loud, quiet, a pause, again
    const timer = setInterval(() => {
      const now = performance.now() / 1000
      const word = Math.max(0, Math.sin(now * 5.5)) *
        (0.55 + 0.45 * Math.sin(now * 1.3))
      const phrase = Math.sin(now * 0.7) > -0.55 ? 1 : 0.05
      if (mode === 'listening') voice.level.value = word * phrase * 0.42
      if (mode === 'speaking') voice.amplitude.value = word * phrase
    }, 40)
    return () => {
      clearInterval(timer)
      reset()
    }
  }, [mode])

  return (
    <main tw='h-screen flex flex-col'>
      <header tw='flex items-center gap-3 px-5 py-3 border-b border-border-primary'>
        <h1 tw='m-0 text-[16px] font-medium'>Oracle, in each state</h1>
        <div role='group' aria-label='State' tw='flex gap-1.5'>
          {MODES.map(([key, label]) => (
            <button
              key={key}
              type='button'
              data-test={`orb-${key}`}
              aria-pressed={mode === key}
              onClick={() => setMode(key)}
              tw={[
                'btn btn-sm',
                mode === key ? 'btn-primary' : 'btn-secondary',
              ]}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      <section
        tw='relative flex-1 min-h-0 overflow-hidden'
        style={{ background: STAGE_BACKGROUND }}
      >
        <OracleOrb />
      </section>
    </main>
  )
}
