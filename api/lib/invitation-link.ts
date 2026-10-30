// The personal link of a candidate, computed once on the server: the recruiter
// copies the same address the e-mail sends, the app's own URL included.
import { BASE_URL, ORIGIN } from '/api/lib/env.ts'
import { paths } from '/web/paths.ts'

/** the address a candidate opens: the app's own URL, then the page */
export const invitationLink = (invitation: string) =>
  `${ORIGIN}${
    BASE_URL === '/' ? '' : BASE_URL.replace(/\/$/, '')
  }${paths.candidate}?invitation=${invitation}`
