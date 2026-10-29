// Skills the recruiter can pick (at most 5): the model also suggests from it.
export const skillCatalog = [
  'REST API design',
  'Data validation',
  'Error handling',
  'Automated tests',
  'PostgreSQL',
  'Performance',
  'Application security',
  'Distributed systems',
  'Code architecture',
  'Git',
]

// How each catalog skill can be evaluated in a Deno HTTP API exercise (the
// scope preview of the form). Unknown skills fall back to the interview.
import type { Method } from '/web/types.ts'

export const skillMethods: Record<string, Method[]> = {
  'REST API design': ['Tests', 'Interview'],
  'Data validation': ['Tests', 'Code analysis'],
  'Error handling': ['Tests'],
  'Automated tests': ['Code analysis'],
  'PostgreSQL': ['Interview'],
  'Performance': ['Code analysis', 'Interview'],
  'Application security': ['Tests', 'Code analysis'],
  'Distributed systems': ['Interview'],
  'Code architecture': ['Code analysis'],
  'Git': ['Interview'],
}

/** a program reads and writes text: nothing about HTTP can be tested */
export const skillMethodsOf = (
  kind: 'api' | 'program',
): Record<string, Method[]> =>
  kind === 'program'
    ? { ...skillMethods, 'REST API design': ['Interview'] }
    : skillMethods
