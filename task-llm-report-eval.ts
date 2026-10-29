// `deno task llm:eval`: the report against fictional candidates whose right
// reading is known (fixtures/report-cases.ts): a strong one, an empty one, one
// who bluffs, one who talks well over empty code, a silent one, one who tries
// to give orders. The facts come from the real sandbox. Prints what each
// reading got wrong, and the share of cases read right.
//
//   deno task llm:eval [--models=muse-spark-1.3] [--efforts=low] [--runs=1]
//                      [--cases=strong,empty,bluffer,talker,silent,injection]
//                      [--support]   also measure the second check of the evidence
//
// Only fictional data: never a real candidate.
import { parseArgs } from 'jsr:@std/cli/parse-args'
import { ask, type Effort, hasAiKey, llmConfig } from '/api/llm.ts'
import { checkTypes, runEvaluation } from '/api/sandbox.ts'
import {
  checkProgram,
  programCases,
  runProgramCases,
} from '/api/program-sandbox.ts'
import { candidateBriefText } from '/api/reference.ts'
import {
  askSupport,
  checkReading,
  parseReading,
  supportItems,
} from '/api/report.ts'
import type { SkillReading } from '/web/types.ts'
import { reporterFor, reportPrompt, reportSchema } from '/api/prompts.ts'
import { demoAssessment } from '/fixtures/demo.ts'
import { type ReportCase, reportCases } from '/fixtures/report-cases.ts'

const args = parseArgs(Deno.args, {
  string: ['models', 'efforts', 'runs', 'cases'],
  boolean: ['support'],
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

/** the assessment of a case: the Linkly API, or a program */
const specOf = (c: ReportCase) => c.spec ?? demoAssessment

/** what the server would measure for this candidate: the real sandbox */
const measure = async (c: ReportCase) => {
  const spec = specOf(c)
  const program = spec.kind === 'program'
  const [results, problems] = await Promise.all([
    program
      ? runProgramCases(
        c.language ?? 'typescript',
        c.files,
        programCases(spec.tests),
      )
      : runEvaluation(c.files, spec.tests),
    program
      ? checkProgram(c.language ?? 'typescript', c.files)
      : checkTypes(c.files),
  ])
  const tests = results.map((r) => {
    const t = spec.tests.find((x) => x.id === r.id)!
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
  const spec = specOf(c)
  const subject = {
    kind: spec.kind === 'program' ? 'program' as const : 'api' as const,
    language: c.language ?? 'typescript' as const,
  }
  const turns = c.transcript.filter((l) => l.who === 'candidate').length
  const { data, trace } = await ask({
    task: 'eval-report',
    system: reporterFor(subject),
    prompt: reportPrompt({
      ...subject,
      brief: candidateBriefText(spec),
      skills: spec.skills.map((s) => ({
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
    effort: effort as Effort,
  })
  const evidence = {
    spec,
    files: c.files,
    transcript: c.transcript,
    facts: {
      tests: m.tests,
      interviewCompleted: true,
      candidateTurns: turns,
    },
  }
  const reading = checkReading(data, evidence)
  return { reading, ms: trace.latencyMs, evidence }
}

/* ---------- the second check ---------- */

type Evidence = Awaited<ReturnType<typeof read>>['evidence']

/** how the second check judges each skill of a reading */
const judge = async (skills: SkillReading[], ev: Evidence) => {
  const items = supportItems(skills, ev)
  const verdicts = new Map<string, { support: string; reason: string }>()
  if (!items.length) return verdicts
  const { data } = await askSupport(items)
  for (const i of items) {
    const v = data[foldName(i.skill)]
    verdicts.set(i.skill, {
      support: v?.support ?? 'missing',
      reason: v?.reason ?? '',
    })
  }
  return verdicts
}
const foldName = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim()

const withEvidence = (a: SkillReading, b: SkillReading): SkillReading => ({
  ...a,
  quotes: b.quotes,
  code: b.code,
  tests: b.tests,
})

/** counts of each verdict, for one kind of reading */
const count = () => ({ yes: 0, partly: 0, no: 0, missing: 0 })
type Count = ReturnType<typeof count>

/**
 * The right readings should be backed; readings falsified on purpose should be
 * doubted: the evidence of another skill, or a status the evidence cannot carry.
 */
const measureSupport = async (
  done: {
    c: ReportCase
    reading?: Awaited<ReturnType<typeof read>>['reading']
    evidence?: Evidence
  }[],
) => {
  const real = count()
  const swapped = count()
  const inflated = count()
  const doubted: string[] = []
  const add = (to: Count, verdict: string) => {
    to[verdict as keyof Count]++
  }
  await Promise.all(done.map(async ({ c, reading, evidence }) => {
    if (!reading || !evidence) return
    const read = reading.skills.filter((s) => s.status !== 'Not assessed')
    try {
      for (const [skill, v] of await judge(reading.skills, evidence)) {
        add(real, v.support)
        if (v.support !== 'yes') {
          doubted.push(`${c.id} · ${skill} (${v.support}): ${v.reason}`)
        }
      }
      // the evidence of the next skill, under the claims of this one
      if (read.length >= 2) {
        const mixed = read.map((s, i) =>
          withEvidence(s, read[(i + 1) % read.length])
        )
        for (const v of (await judge(mixed, evidence)).values()) {
          add(swapped, v.support)
        }
      }
      // a status and a summary the evidence cannot carry
      const raised = read.filter((s) => s.status !== 'Demonstrated').map((
        s,
      ) => ({
        ...s,
        status: 'Demonstrated' as const,
        confidence: 'high' as const,
        summary:
          'They clearly understand this skill and explained it very well.',
      }))
      if (raised.length) {
        for (const v of (await judge(raised, evidence)).values()) {
          add(inflated, v.support)
        }
      }
    } catch (err) {
      console.log(`  the second check failed on ${c.id}: ${err}`)
    }
  }))
  const line = (label: string, k: Count) => {
    const n = k.yes + k.partly + k.no + k.missing
    const p = (x: number) => `${Math.round(100 * x / (n || 1))}%`
    console.log(
      `${label.padEnd(44)} yes ${String(k.yes).padStart(3)} (${
        p(k.yes)
      })  partly ${String(k.partly).padStart(3)} (${p(k.partly)})  no ${
        String(k.no).padStart(3)
      } (${p(k.no)})  of ${n}`,
    )
  }
  console.log(`\n== second check of the evidence`)
  line('right readings (should be "yes")', real)
  line('evidence swapped between skills (should doubt)', swapped)
  line('status raised to Demonstrated (should doubt)', inflated)
  for (const d of doubted) console.log(`  ${d}`)
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
          const { reading, ms, evidence } = await read(c, effort)
          return { c, ms, reading, evidence, problems: c.judge(reading) }
        } catch (err) {
          return {
            c,
            ms: 0,
            reading: undefined,
            evidence: undefined,
            problems: [`FAILED: ${err}`],
          }
        }
      }))
      if (args.support) await measureSupport(done)
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
