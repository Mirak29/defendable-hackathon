// Do the hidden tests catch the shortcut they name? A hidden test says in its
// "condition" which classic flaw it catches ("a script URL that new URL() would
// accept"). Here a model writes, from the correct reference solution, a variant
// that takes exactly that shortcut while still passing every public test; the
// sandbox runs it. A hidden test that fails on its variant does its job
// ("caught"); one that passes on it does not ("missed"), and the generation
// rewrites it. When no valid variant can be written, nothing is said
// ("unclear"): a model that cannot write the flaw proves nothing about the test.
import { ask } from '/api/llm.ts'
import { CODE_RULES, TRAP_SETTER, trapPrompt } from '/api/prompts.ts'
import { PROGRAM_CODE_RULES } from '/api/program-prompts.ts'
import {
  candidateBriefText,
  parseCode,
  parseProgramCode,
} from '/api/reference.ts'
import { runEvaluation } from '/api/sandbox.ts'
import { programCases, runProgramCases } from '/api/program-sandbox.ts'
import { log } from '/api/lib/log.ts'
import type {
  AssessmentSpec,
  CandidateFiles,
  ReferenceCheck,
  TestCase,
  TestResult,
} from '/web/types.ts'

export type Trap = NonNullable<ReferenceCheck['traps']>[number]

const stepsText = (spec: AssessmentSpec, t: TestCase) =>
  t.steps.map((s) =>
    spec.kind === 'program'
      ? `input ${JSON.stringify(s.request)} → expected output ${
        JSON.stringify(s.response)
      }`
      : `${s.request} → ${s.response}`
  ).join(' then ')

/** the file of the solution and how the tests run on it */
const runnerOf = (spec: AssessmentSpec, starter: CandidateFiles) => {
  const program = spec.kind === 'program'
  return {
    parse: program ? parseProgramCode : parseCode,
    rules: program ? PROGRAM_CODE_RULES : CODE_RULES,
    run: (code: string): Promise<TestResult[]> =>
      program
        ? runProgramCases(
          'typescript',
          { ...starter, 'src/main.ts': code },
          programCases(spec.tests),
        )
        : runEvaluation({ ...starter, 'src/app.ts': code }, spec.tests),
  }
}

/** one verdict per hidden test the reference solution passes */
export const checkTraps = async (
  spec: AssessmentSpec,
  starter: CandidateFiles,
  reference: { code: string; results: { id: string; passed: boolean }[] },
  excluded: ReadonlySet<string> = new Set(),
): Promise<Trap[]> => {
  const { parse, rules, run } = runnerOf(spec, starter)
  const brief = candidateBriefText(spec)
  const kept = spec.tests.filter((t) => !excluded.has(t.id))
  const publicIds = kept.filter((t) => t.visibility === 'public').map((t) =>
    t.id
  )
  const passedByReference = new Set(
    reference.results.filter((r) => r.passed).map((r) => r.id),
  )

  const check = async (t: TestCase): Promise<Trap> => {
    // a test the reference itself fails is judged by the fairness check
    if (!passedByReference.has(t.id)) return { id: t.id, verdict: 'unclear' }
    let feedback: string | undefined
    let last: Trap['verdict'] = 'unclear'
    for (let attempt = 0; attempt < 2; attempt++) {
      const variant = await ask({
        task: 'trap',
        system: TRAP_SETTER,
        prompt: trapPrompt(
          brief,
          reference.code,
          { id: t.id, condition: t.condition, steps: stepsText(spec, t) },
          rules,
          feedback,
        ),
        parse,
        json: false,
        stream: true,
        maxTokens: 12_000,
        effort: 'medium',
      })
      if (variant.data.trim() === reference.code.trim()) {
        feedback =
          'it is identical to the correct solution: change one decision'
        last = 'unclear'
        continue
      }
      const results = await run(variant.data)
      const byId = new Map(results.map((r) => [r.id, r]))
      const failedPublic = publicIds.filter((id) => !byId.get(id)?.passed)
      if (failedPublic.length) {
        feedback = `it fails the public tests ${
          failedPublic.join(', ')
        }: it must pass all of them`
        last = 'unclear'
        continue
      }
      if (byId.get(t.id) && !byId.get(t.id)!.passed) {
        return { id: t.id, verdict: 'caught' }
      }
      feedback =
        `it still passes the hidden test ${t.id}: the flaw must change its answer for that input`
      last = 'missed'
    }
    return { id: t.id, verdict: last }
  }

  const hidden = kept.filter((t) => t.visibility === 'hidden')
  return await Promise.all(hidden.map((t) =>
    check(t).catch((err): Trap => {
      log.warn('trap-check-failed', { id: t.id, message: String(err) })
      return { id: t.id, verdict: 'unclear' }
    })
  ))
}
