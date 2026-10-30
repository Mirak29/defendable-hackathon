// What the interviewer knows in the voice lab: the Linkly demo solution, run
// for real in the sandbox (so a failed hidden test and the type check are
// facts, not an invention), turned into facts by the same `buildFacts` as a
// real interview.
import { APP_ENV, ENV } from '@01edu/api/env'
import { checkTypes, runEvaluation } from '/api/sandbox.ts'
import { buildFacts, candidateVoice } from '/api/interview.ts'
import {
  checkProgram,
  programCases,
  runProgramCases,
} from '/api/program-sandbox.ts'
import type { InterviewFacts } from '/api/prompts.ts'
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
    const [tests, problems] = await Promise.all([
      runProgramCases('python', files, programCases(programDemo.tests)),
      checkProgram('python', files),
    ])
    return buildFacts(programDemo, 'python', files, {
      tests,
      problems,
      own: { passed: 0, failed: 0 },
    })
  })()

export const labFacts = () =>
  cached ??= (async () => {
    const [tests, problems] = await Promise.all([
      runEvaluation(demoFiles, demoAssessment.tests),
      checkTypes(demoFiles),
    ])
    return buildFacts(demoAssessment, 'typescript', demoFiles, {
      tests,
      problems,
      own: { passed: 0, failed: 0 },
    })
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
