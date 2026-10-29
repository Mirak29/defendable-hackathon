// What the browser tells the server about the conditions of the session: the
// page was left, a second display is connected, the words of the interviewer
// were copied. Facts for the report, never a verdict: the reasons are often
// innocent (a call, a notification, a laptop on a dock).
import { api } from '/web/lib/api.ts'
import type { IntegrityPhase } from '/web/types.ts'

/** a shorter absence is a dialog or a permission prompt, not a departure */
const MIN_LEAVE_MS = 1500

const send = (body: {
  kind: 'page-leave' | 'copy' | 'screens'
  phase: IntegrityPhase
  ms?: number
  extended?: boolean
}) => {
  try {
    api['POST/api/candidate/integrity'].fetch({
      ms: null,
      extended: null,
      ...body,
    }).catch(() => {})
  } catch { /* the report simply has one fact less */ }
}

/** Chromium's screen: `isExtended` and a `change` event, absent elsewhere */
type ChromiumScreen = EventTarget & { isExtended?: boolean }
const display = screen as unknown as ChromiumScreen

const extendedScreen = () => {
  const extended = display.isExtended
  return typeof extended === 'boolean' ? extended : undefined
}

/** counts the absences and reports the displays; returns what stops it */
export const trackIntegrity = (phase: IntegrityPhase) => {
  let leftAt = 0
  const left = () => {
    leftAt ||= Date.now()
  }
  const back = () => {
    if (!leftAt) return
    const ms = Date.now() - leftAt
    leftAt = 0
    if (ms >= MIN_LEAVE_MS) send({ kind: 'page-leave', phase, ms })
  }
  const onVisibility = () => document.hidden ? left() : back()
  const screens = () => {
    const extended = extendedScreen()
    if (extended !== undefined) send({ kind: 'screens', phase, extended })
  }
  addEventListener('blur', left)
  addEventListener('focus', back)
  document.addEventListener('visibilitychange', onVisibility)
  display.addEventListener?.('change', screens)
  screens()
  return () => {
    removeEventListener('blur', left)
    removeEventListener('focus', back)
    document.removeEventListener('visibilitychange', onVisibility)
    display.removeEventListener?.('change', screens)
    back()
  }
}

/** the words of the interviewer are not to be copied: the attempt is counted */
export const noCopy = {
  onCopy: (e: Event) => refuse(e),
  onCut: (e: Event) => refuse(e),
  onDragStart: (e: Event) => e.preventDefault(),
  onContextMenu: (e: Event) => e.preventDefault(),
}

const refuse = (e: Event) => {
  e.preventDefault()
  send({ kind: 'copy', phase: 'interview' })
}
