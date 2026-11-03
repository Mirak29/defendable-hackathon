import { signal } from '@preact/signals'

type Guide = { assessmentId: number; candidateId?: number }
const KEY = 'defendable-guided-demo-v1'
const restore = (): Guide | null => {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return saved && Number.isInteger(saved.assessmentId) &&
        saved.assessmentId > 0 &&
        (saved.candidateId === undefined ||
          (Number.isInteger(saved.candidateId) && saved.candidateId > 0))
      ? saved
      : null
  } catch {
    return null
  }
}
export const guidedDemo = signal<Guide | null>(restore())
export const setGuidedDemo = (guide: Guide | null) => {
  guidedDemo.value = guide
  try {
    if (guide) localStorage.setItem(KEY, JSON.stringify(guide))
    else localStorage.removeItem(KEY)
  } catch { /* The guide still works when browser storage is unavailable. */ }
}
export const rememberGuidedCandidate = (
  assessmentId: number,
  candidateId: number,
) => {
  if (guidedDemo.peek()?.assessmentId === assessmentId) {
    setGuidedDemo({ assessmentId, candidateId })
  }
}
