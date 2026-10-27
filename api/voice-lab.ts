// What the interviewer knows in the voice lab: the Linkly demo solution, run
// for real in the sandbox (so a failed hidden test and the type check are
// facts, not an invention). A real interview builds the same facts from the
// code a candidate submitted.
import { checkTypes, runEvaluation } from '/api/sandbox.ts'
import { candidateBriefText } from '/api/reference.ts'
import type { InterviewFacts } from '/api/prompts.ts'
import { voiceConfig } from '/api/voice.ts'
import { demoAssessment } from '/fixtures/demo.ts'
import { demoFiles } from '/fixtures/demo-files.ts'

let cached: Promise<InterviewFacts> | undefined

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
