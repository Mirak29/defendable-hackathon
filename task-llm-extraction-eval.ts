// `deno task llm:extraction-eval`: the prefill of the form and the reading of a
// CV, each model at each reasoning effort, against inputs whose right answer is
// known (fixtures/extraction-cases.ts). Prints, per model and effort, how many
// cases were answered right, the time and the tokens.
//
//   deno task llm:extraction-eval [--tasks=prefill,cv] [--runs=3]
//       [--models=muse-spark-1.3,muse-spark-1.2,meta-models/muse-spark-open-1026]
//       [--efforts=minimal,low,medium] [--show]
//
// Only fictional data: never a real person.
import { parseArgs } from 'jsr:@std/cli/parse-args'
import { type Effort, hasAiKey, llmConfig } from '/api/llm.ts'
import { prefillFromDescription } from '/api/assessment.ts'
import { askCvFields } from '/api/cv.ts'
import { cvCases, prefillCases } from '/fixtures/extraction-cases.ts'

const args = parseArgs(Deno.args, {
  boolean: ['show'],
  string: ['tasks', 'models', 'efforts', 'runs'],
})
if (!hasAiKey()) {
  console.error('MODEL_API_KEY is empty: add it to .env')
  Deno.exit(1)
}

// the models are chosen here, not by step
llmConfig.openTasks = []
llmConfig.fallback = ''
const tasks = (args.tasks ?? 'prefill,cv').split(',')
const models = (args.models ??
  'muse-spark-1.3,muse-spark-1.2,meta-models/muse-spark-open-1026').split(',')
const efforts = (args.efforts ?? 'minimal,low,medium').split(',') as Effort[]
const runs = Number(args.runs ?? 3)

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}

type Outcome = { problems: string[]; ms: number; tokens: number }

const prefillOnce = async (
  c: typeof prefillCases[number],
): Promise<Outcome> => {
  const started = performance.now()
  try {
    const r = await prefillFromDescription(c.offer)
    const problems: string[] = []
    if (![c.level].flat().includes(r.level)) {
      problems.push(`level ${r.level}, not ${[c.level].flat().join(' or ')}`)
    }
    for (const s of c.must) {
      if (!r.skills.includes(s)) problems.push(`misses ${s}`)
    }
    for (const s of c.mustNot) {
      if (r.skills.includes(s)) problems.push(`picks ${s}`)
    }
    return {
      problems,
      ms: r.trace.latencyMs,
      tokens: r.trace.tokensIn + r.trace.tokensOut,
    }
  } catch (err) {
    return {
      problems: [`FAILED: ${String(err).slice(0, 100)}`],
      ms: performance.now() - started,
      tokens: 0,
    }
  }
}

const same = (a: unknown, b: string) =>
  typeof a === 'string' && a.trim().toLowerCase() === b.toLowerCase()

const cvOnce = async (
  c: typeof cvCases[number],
  effort: Effort,
): Promise<Outcome> => {
  const started = performance.now()
  try {
    const { data, trace } = await askCvFields(
      c.text,
      effort as 'minimal' | 'low' | 'medium',
    )
    const e = c.expected
    const problems: string[] = []
    if (!same(data.firstName, e.firstName)) {
      problems.push(`first name "${data.firstName}"`)
    }
    if (!same(data.lastName, e.lastName)) {
      problems.push(`last name "${data.lastName}"`)
    }
    if (!same(data.email, e.email)) problems.push(`e-mail "${data.email}"`)
    if (e.profile) {
      if (!data.profileUrl?.toLowerCase().includes(e.profile.toLowerCase())) {
        problems.push(`profile "${data.profileUrl}"`)
      }
    } else if (data.profileUrl) {
      problems.push(`profile "${data.profileUrl}" is made up`)
    }
    return {
      problems,
      ms: trace.latencyMs,
      tokens: trace.tokensIn + trace.tokensOut,
    }
  } catch (err) {
    return {
      problems: [`FAILED: ${String(err).slice(0, 100)}`],
      ms: performance.now() - started,
      tokens: 0,
    }
  }
}

const summary: string[] = []
for (const task of tasks) {
  const cases = task === 'prefill' ? prefillCases : cvCases
  console.log(`\n######## ${task}: ${cases.length} cases × ${runs} runs`)
  for (const model of models) {
    llmConfig.model = model
    for (const effort of efforts) {
      llmConfig.efforts = task === 'prefill' ? { prefill: effort } : {}
      const times: number[] = []
      let tokens = 0
      let right = 0
      let total = 0
      const failures: string[] = []
      for (let run = 1; run <= runs; run++) {
        const done = await Promise.all(cases.map(async (c) => ({
          c,
          out: task === 'prefill'
            ? await prefillOnce(c as typeof prefillCases[number])
            : await cvOnce(c as typeof cvCases[number], effort),
        })))
        for (const { c, out } of done) {
          total++
          if (!out.problems.length) right++
          else failures.push(`${c.id}: ${out.problems.join(', ')}`)
          times.push(out.ms)
          tokens += out.tokens
        }
      }
      const line = `${model.padEnd(36)} ${effort.padEnd(8)} right ${
        String(right).padStart(2)
      }/${total} · median ${
        (percentile(times, 0.5) / 1000).toFixed(1)
      } s · p95 ${(percentile(times, 0.95) / 1000).toFixed(1)} s · ${
        Math.round(tokens / total)
      } tokens/call`
      console.log(line)
      summary.push(`${task} ${line}`)
      if (args.show || failures.length) {
        const counts = new Map<string, number>()
        for (const f of failures) counts.set(f, (counts.get(f) ?? 0) + 1)
        for (const [f, n] of counts) console.log(`    ${n}× ${f}`)
      }
    }
  }
}
console.log('\n######## summary')
for (const line of summary) console.log(line)
Deno.exit(0)
