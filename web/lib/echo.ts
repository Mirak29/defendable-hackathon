// Is what the recogniser heard only the interviewer's own voice, played by the
// speakers and picked up again by the microphone? Without headphones it is: the
// words reach the transcription as if the candidate had spoken over them. Used
// by the server (to keep writing the answer) and by the browser (to keep
// speaking it): only real words of the candidate interrupt the interviewer.

const words = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean)

/** true when `heard` is nothing, or is made of what the interviewer said */
export const isEcho = (heard: string, said: string) => {
  const h = words(heard)
  if (!h.length) return true
  const s = words(said)
  // a run of the interviewer's words, as it was said
  if (` ${s.join(' ')} `.includes(` ${h.join(' ')} `)) return true
  // the recogniser rewrites a few words of what it hears: most must be known
  if (h.length >= 3) {
    const known = new Set(s)
    return h.filter((w) => known.has(w)).length / h.length >= 0.75
  }
  return false
}
