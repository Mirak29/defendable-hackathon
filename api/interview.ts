// What the interviewer knows about a real candidate: the frozen code, and what
// the server found when it ran it (api/candidate.ts, prepareInterview).
import { json } from '/api/assessment.ts'
import { type StoredResults } from '/api/candidate.ts'
import { candidateBriefText } from '/api/reference.ts'
import type { InterviewFacts } from '/api/prompts.ts'
import { Assessment, type CandidateRow } from '/api/schema.ts'
import { voiceConfig } from '/api/voice.ts'
import type { AssessmentSpec, CandidateFiles } from '/web/types.ts'

/** undefined while the preparation of the interview is not over */
export const factsOf = (c: CandidateRow): InterviewFacts | undefined => {
  const results = json<StoredResults>(c.candidateResults)
  if (!results) return
  const spec = json<AssessmentSpec>(
    Assessment.require(c.assessmentId).assessmentSpec,
  )!
  const failedTests = results.tests.filter((r) => !r.passed).map((r) => {
    const test = spec.tests.find((t) => t.id === r.id)
    return `${r.id} (${test?.visibility ?? '?'}) ${
      test?.title ?? ''
    }: expected ${r.expected ?? '?'}, received ${r.received ?? '?'}${
      r.request ? ` for "${r.request}"` : ''
    }`
  })
  const { passed, failed } = results.own
  return {
    brief: candidateBriefText(spec),
    files: json<CandidateFiles>(c.candidateFiles) ?? {},
    failedTests,
    passedCount: results.tests.filter((r) => r.passed).length,
    totalCount: results.tests.length,
    typeErrors: results.problems.map((p) => `${p.file}: ${p.message}`),
    ownTests: passed + failed
      ? `${passed} pass, ${failed} fail`
      : 'none written',
    questions: voiceConfig.questions,
  }
}
