// What the interviewer knows in the voice lab: the Linkly demo solution, run
// for real in the sandbox (so a failed hidden test and the type check are
// facts, not an invention). A real interview builds the same facts from the
// code a candidate submitted.
import { APP_ENV, ENV } from '@01edu/api/env'
import { checkTypes, runEvaluation } from '/api/sandbox.ts'
import { candidateVoice } from '/api/interview.ts'
import {
  checkProgram,
  programCases,
  runProgramCases,
} from '/api/program-sandbox.ts'
import { candidateBriefText } from '/api/reference.ts'
import type { InterviewFacts } from '/api/prompts.ts'
import { voiceConfig } from '/api/voice.ts'
import { demoAssessment } from '/fixtures/demo.ts'
import { demoFiles } from '/fixtures/demo-files.ts'
import { programDemo, pythonSolution } from '/fixtures/program-demo.ts'

let cached: Promise<InterviewFacts> | undefined
let cachedProgram: Promise<InterviewFacts> | undefined

/**
 * The same, for a Python program that accepts a product written with capital
 * letters: the hidden test about it fails, a fact the interviewer must not
 * name before the candidate does.
 */
export const labProgramFacts = () =>
  cachedProgram ??= (async () => {
    const files = {
      ...pythonSolution,
      'main.py': pythonSolution['main.py'].replace('[a-z]+', '[a-zA-Z]+'),
    }
    const cases = programCases(programDemo.tests)
    const [results, problems] = await Promise.all([
      runProgramCases('python', files, cases),
      checkProgram('python', files),
    ])
    const failedTests = results.filter((r) => !r.passed).map((r) => {
      const test = programDemo.tests.find((t) => t.id === r.id)!
      return `${r.id} (${test.visibility}) ${test.title}: expected ${
        JSON.stringify(r.expected)
      }, received ${JSON.stringify(r.received)} for ${
        JSON.stringify(r.request)
      }`
    })
    return {
      kind: 'program' as const,
      language: 'python' as const,
      brief: candidateBriefText(programDemo),
      files,
      failedTests,
      passedCount: results.filter((r) => r.passed).length,
      totalCount: results.length,
      typeErrors: problems.map((p) => `${p.file}: ${p.message}`),
      questions: voiceConfig.questions,
    }
  })()

export const labFacts = () =>
  cached ??= (async () => {
    const [results, problems] = await Promise.all([
      runEvaluation(demoFiles, demoAssessment.tests),
      checkTypes(demoFiles),
    ])
    const failedTests = results.filter((r) => !r.passed).map((r) => {
      const test = demoAssessment.tests.find((t) => t.id === r.id)!
      return `${r.id} (${test.visibility}) ${test.title}: expected ${
        r.expected ?? '?'
      }, received ${r.received ?? '?'}${r.request ? ` for "${r.request}"` : ''}`
    })
    return {
      brief: candidateBriefText(demoAssessment),
      files: demoFiles,
      failedTests,
      passedCount: results.filter((r) => r.passed).length,
      totalCount: results.length,
      typeErrors: problems.map((p) => `${p.file}: ${p.message}`),
      questions: voiceConfig.questions,
    }
  })()

/**
 * The lab is a tool of the team, not of the visitors: off in production unless
 * VOICE_LAB=on, so the public demo account cannot open interviews on the
 * project's model keys.
 */
export const labConfig = {
  enabled: ENV('VOICE_LAB', APP_ENV === 'prod' ? 'off' : 'on') !== 'off',
}

/**
 * Who /api/voice is for: a candidate whose interview is ready talks about
 * their own code; otherwise the lab, when it is on (a member session is still
 * required there). A leftover candidate cookie, from a link opened earlier in
 * this browser, no longer locks the lab.
 */
export const voiceOptionsFor = async (req: Request) =>
  await candidateVoice.authorize(req)
    ? candidateVoice
    : labConfig.enabled
    ? { facts: labFacts }
    : undefined
