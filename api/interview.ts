// What the interviewer knows about a real candidate: the frozen code, and what
// the server found when it ran it (api/candidate.ts, prepareInterview).
import { json } from '/api/assessment.ts'
import {
  findCandidate,
  finishInterview,
  preparation,
  recordResume,
  startInterview,
  type StoredResults,
} from '/api/candidate.ts'
import { candidateBriefText } from '/api/reference.ts'
import type { InterviewFacts } from '/api/prompts.ts'
import { Assessment, Candidate, type CandidateRow } from '/api/schema.ts'
import { startReport } from '/api/report.ts'
import { voiceConfig, writeOpening } from '/api/voice.ts'
import { activeRecording } from '/api/recordings.ts'
import type {
  AssessmentSpec,
  CandidateFiles,
  InterviewLine,
} from '/web/types.ts'

const candidateOf = (req: Request) =>
  findCandidate(req.headers.get('cookie')?.match(/dfd_candidate=([^;]+)/)?.[1])

/**
 * What the interviewer is told about code that was run: the same for a
 * candidate and for the voice lab, so the lab tries the prompt of production.
 */
export const buildFacts = (
  spec: AssessmentSpec,
  language: InterviewFacts['language'],
  files: CandidateFiles,
  results: StoredResults,
): InterviewFacts => {
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
    language,
    brief: candidateBriefText(spec),
    files,
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

/** undefined while the preparation of the interview is not over */
export const factsOf = (c: CandidateRow): InterviewFacts | undefined => {
  const results = json<StoredResults>(c.candidateResults)
  if (!results) return
  const spec = json<AssessmentSpec>(
    Assessment.require(c.assessmentId).assessmentSpec,
  )!
  return {
    ...buildFacts(
      spec,
      c.candidateLanguage === 'python' ? 'python' : 'typescript',
      json<CandidateFiles>(c.candidateFiles) ?? {},
      results,
    ),
    previous: json<InterviewLine[]>(c.candidateInterview) ?? undefined,
    interviewStartedAt: c.candidateInterviewStartedAt ?? undefined,
    opening: results.opening,
  }
}

// the preparation writes the first words of the interviewer (api/candidate.ts)
preparation.opening = (candidateId) => {
  const facts = factsOf(Candidate.require(candidateId))
  return facts ? writeOpening(facts) : Promise.resolve(undefined)
}

/**
 * Who may talk to the interviewer: a candidate whose code is submitted and
 * whose preparation is over, until the interview is closed.
 */
export const candidateVoice = {
  authorize: (req: Request) => {
    try {
      const c = candidateOf(req)
      const recording = new URL(req.url).searchParams.get('recording') ?? ''
      return Promise.resolve(
        !c.candidateFinishedAt && !c.candidateRevokedAt && !!factsOf(c) &&
          !!activeRecording(c.candidateId, recording),
      )
    } catch {
      return Promise.resolve(false)
    }
  },
  facts: (req: Request) => Promise.resolve(factsOf(candidateOf(req))!),
  onStart: (req: Request) => {
    const c = candidateOf(req)
    // words were already said: this is a return, not a beginning
    if (json<InterviewLine[]>(c.candidateInterview)?.length) recordResume(c)
    startInterview(c)
  },
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
