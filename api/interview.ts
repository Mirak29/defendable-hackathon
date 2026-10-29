// What the interviewer knows about a real candidate: the frozen code, and what
// the server found when it ran it (api/candidate.ts, prepareInterview).
import { json } from '/api/assessment.ts'
import {
  findCandidate,
  finishInterview,
  startInterview,
  type StoredResults,
} from '/api/candidate.ts'
import { candidateBriefText } from '/api/reference.ts'
import type { InterviewFacts } from '/api/prompts.ts'
import { Assessment, type CandidateRow } from '/api/schema.ts'
import { startReport } from '/api/report.ts'
import { voiceConfig } from '/api/voice.ts'
import type {
  AssessmentSpec,
  CandidateFiles,
  InterviewLine,
} from '/web/types.ts'

const candidateOf = (req: Request) =>
  findCandidate(req.headers.get('cookie')?.match(/dfd_candidate=([^;]+)/)?.[1])

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
      r.request
        ? ` for ${
          spec.kind === 'program' ? JSON.stringify(r.request) : `"${r.request}"`
        }`
        : ''
    }`
  })
  const { passed, failed } = results.own
  return {
    kind: spec.kind === 'program' ? 'program' : 'api',
    language: c.candidateLanguage === 'python' ? 'python' : 'typescript',
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

/**
 * Who may talk to the interviewer: a candidate whose code is submitted and
 * whose preparation is over, until the interview is closed.
 */
export const candidateVoice = {
  authorize: (req: Request) => {
    try {
      const c = candidateOf(req)
      return Promise.resolve(!c.candidateFinishedAt && !!factsOf(c))
    } catch {
      return Promise.resolve(false)
    }
  },
  facts: (req: Request) => Promise.resolve(factsOf(candidateOf(req))!),
  onStart: (req: Request) => startInterview(candidateOf(req)),
  onFinish: (
    req: Request,
    transcript: InterviewLine[],
    completed: boolean,
  ) => {
    if (!transcript.length) return
    const c = candidateOf(req)
    finishInterview(c, transcript, completed)
    // the interview is over: the report is written in the background
    if (completed) startReport(c.candidateId)
  },
}
