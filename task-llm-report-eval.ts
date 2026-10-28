// `deno task llm:eval`: the report against fictional candidates whose right
// reading is known (fixtures/report-cases.ts): a strong one, an empty one, one
// who bluffs, one who talks well over empty code, a silent one, one who tries
// to give orders. The facts come from the real sandbox. Prints what each
// reading got wrong, and the share of cases read right.
//
//   deno task llm:eval [--models=muse-spark-1.3] [--efforts=low] [--runs=1]
//                      [--cases=strong,empty,bluffer,talker,silent,injection]
//
// Only fictional data: never a real candidate.
import { parseArgs } from 'jsr:@std/cli/parse-args'
import { ask, hasAiKey, llmConfig } from '/api/llm.ts'
import { checkTypes, runEvaluation } from '/api/sandbox.ts'
import { candidateBriefText } from '/api/reference.ts'
import { checkReading, parseReading } from '/api/report.ts'
import { REPORTER, reportPrompt, reportSchema } from '/api/prompts.ts'
import { demoAssessment } from '/fixtures/demo.ts'
import { type ReportCase, reportCases } from '/fixtures/report-cases.ts'

const args = parseArgs(Deno.args, {
  string: ['models', 'efforts', 'runs', 'cases'],
})
if (!hasAiKey()) {
  console.error('MODEL_API_KEY is empty: add it to .env')
  Deno.exit(1)
}

// the models are chosen here, not by step
llmConfig.openTasks = []
const models = (args.models ?? 'muse-spark-1.3').split(',')
const efforts = (args.efforts ?? 'low').split(',')
const runs = Number(args.runs ?? 1)
const wanted = args.cases?.split(',')
const cases = reportCases.filter((c) => !wanted || wanted.includes(c.id))

/** what the server would measure for this candidate: the real sandbox */
const measure = async (c: ReportCase) => {
  const [results, problems] = await Promise.all([
    runEvaluation(c.files, demoAssessment.tests),
    checkTypes(c.files),
  ])
  const tests = results.map((r) => {
    const t = demoAssessment.tests.find((x) => x.id === r.id)!
    return {
      id: r.id,
      title: t.title,
      visibility: t.visibility,
      passed: r.passed,
      expected: r.expected,
      received: r.received,
      request: r.request,
    }
  })
  return { tests, problems }
}

const facts = new Map<string, Awaited<ReturnType<typeof measure>>>()
for (const c of cases) facts.set(c.id, await measure(c))

const read = async (c: ReportCase, effort: string) => {
  const m = facts.get(c.id)!
  const turns = c.transcript.filter((l) => l.who === 'candidate').length
  const { data, trace } = await ask({
    task: 'eval-report',
    system: REPORTER,
    prompt: reportPrompt({
      brief: candidateBriefText(demoAssessment),
      skills: demoAssessment.skills.map((s) => ({
        name: s.name,
        importance: s.importance,
        methods: s.methods,
      })),
      tests: m.tests.map((t) => ({
        ...t,
        detail: `expected ${t.expected ?? '?'}, received ${t.received ?? '?'}`,
      })),
      typeErrors: m.problems.map((p) => `${p.file}: ${p.message}`),
      ownTests: 'none written',
      declaredTools: ['Claude'],
      files: c.files,
      transcript: c.transcript,
      interviewCompleted: true,
    }),
    schema: reportSchema,
    parse: parseReading,
    stream: true,
    maxTokens: 14_000,
    timeoutMs: 240_000,
    effort: effort as 'minimal' | 'low' | 'medium',
  })
  const reading = checkReading(data, {
    spec: demoAssessment,
    files: c.files,
    transcript: c.transcript,
    facts: {
      tests: m.tests,
      interviewCompleted: true,
      candidateTurns: turns,
    },
  })
  return { reading, ms: trace.latencyMs }
}

let total = 0
let right = 0
for (const model of models) {
  llmConfig.model = model
  llmConfig.fallback = ''
  for (const effort of efforts) {
    console.log(`\n== ${model} · ${effort}`)
    for (let run = 1; run <= runs; run++) {
      const done = await Promise.all(cases.map(async (c) => {
        try {
          const { reading, ms } = await read(c, effort)
          return { c, ms, reading, problems: c.judge(reading) }
        } catch (err) {
          return { c, ms: 0, reading: undefined, problems: [`FAILED: ${err}`] }
        }
      }))
      for (const d of done) {
        total++
        if (!d.problems.length) right++
        const states = d.reading?.skills.map((s) =>
          `${s.status[0]}/${s.confidence[0]}`
        ).join(' ')
        console.log(
          `${d.problems.length ? '✗' : '✓'} ${d.c.id.padEnd(10)} ${
            (d.ms / 1000).toFixed(1).padStart(5)
          } s  ${states ?? ''}  dropped ${d.reading?.discarded ?? '-'}`,
        )
        for (const p of d.problems) console.log(`    - ${p}`)
        if (d.reading && (args.cases || d.problems.length)) {
          console.log(`    understanding: ${d.reading.understanding.summary}`)
        }
      }
    }
  }
}
console.log(`\nread right: ${right}/${total}`)
