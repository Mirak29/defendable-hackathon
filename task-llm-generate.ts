// `deno task llm:generate`: one real generation (job offer → assessment) with
// the Meta models, through the real code: prompts, validators, sandbox, fair
// reference solution. Prints each step (model, time, tokens, cost), the
// checks, and what the fairness review excluded. Nothing is kept (in-memory
// database).
//
//   deno task llm:generate [--runs=1] [--model=muse-wonder-1.0]
//                          [--fallback=] [--file=job-offer.txt] [--out=generated]
//                          [--level=senior] [--duration=120] [--skills="A,B,C"]
// --out writes each run as a readable file (generated/run-1.md and .json):
// the brief, the requirements, the tests and the reference solution.
import { parseArgs } from 'jsr:@std/cli/parse-args'
import { createAssessment, getAssessment } from '/api/assessment.ts'
import { hasAiKey, llmConfig } from '/api/llm.ts'
import { demoJobDescription } from '/fixtures/demo.ts'
import { computeChecks } from '/web/lib/assessment-checks.ts'

const args = parseArgs(Deno.args, {
  string: ['model', 'fallback', 'file', 'out', 'level', 'skills', 'duration'],
  default: {
    runs: 1,
    level: 'intermediate',
    duration: '90',
    skills:
      'REST API design,Data validation,Error handling,Automated tests,PostgreSQL',
  },
})
if (!hasAiKey()) {
  console.error('MODEL_API_KEY is empty: add it to .env')
  Deno.exit(1)
}
if (args.model) llmConfig.model = args.model
if (args.fallback !== undefined) llmConfig.fallback = args.fallback

// USD per million tokens (input, output): docs/pricing
const PRICE: Record<string, [number, number]> = {
  'muse-spark-1.3': [1.25, 4.25],
  'muse-spark-1.2': [1.25, 4.25],
  'muse-wonder-1.0': [4, 20],
  'muse-spark-1.3-contributor': [0.1, 0.2],
}
const [pin, pout] = PRICE[llmConfig.model] ?? [0, 0]
const cost = (tin: number, tout: number) => (tin * pin + tout * pout) / 1e6

const jobDescription = args.file
  ? await Deno.readTextFile(args.file)
  : demoJobDescription

type State = ReturnType<typeof getAssessment>

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join('\n')

/** a run as files: JSON for tools, Markdown to read like a recruiter */
const writeRun = async (
  dir: string,
  run: number,
  state: State,
  checks: { label: string; ok: boolean }[],
) => {
  await Deno.mkdir(dir, { recursive: true })
  await Deno.writeTextFile(
    `${dir}/run-${run}.json`,
    JSON.stringify(state, null, 2),
  )
  const { spec } = state
  const skills = spec.skills.map((s) =>
    `${s.name} (${s.importance}: ${s.methods.join(', ')})`
  ).join('; ')
  const tests = spec.tests.map((t) => {
    const steps = t.steps.map((s) => `    ${s.request}  =>  ${s.response}`)
    return [
      `### ${t.id} ${t.title} (${t.visibility}) -> ${
        t.requirementIds.join(', ')
      }`,
      `${t.condition} · expected ${t.expected}`,
      ...steps,
    ].join('\n')
  })
  const fence = '```'
  const md = [
    `# ${spec.title} — ${spec.company}`,
    `Level ${spec.level}, ${spec.durationMin} min · skills: ${skills}`,
    `## What the candidate reads\n**Context.** ${spec.candidateBrief.context}\n\n**Mission.** ${spec.candidateBrief.mission}`,
    `## Constraints\n${bullets(spec.constraints)}`,
    `## Routes\n${
      bullets(spec.routes.map((r) =>
        `${r.method} ${r.path} — ${r.description} (${r.codes.join(', ')})`
      ))
    }`,
    `## Requirements\n${
      spec.requirements.map((r) =>
        `- **${r.id} ${r.title}** [${
          r.skills.join(', ')
        }]: ${r.statement}\n  _why: ${r.why}_`
      ).join('\n')
    }`,
    `## Tests\n${tests.join('\n\n')}`,
    `## Checks\n${
      bullets(checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}`))
    }`,
    state.reference
      ? `## Reference solution\n${fence}ts\n${state.reference.code}\n${fence}`
      : '',
  ].join('\n\n')
  await Deno.writeTextFile(`${dir}/run-${run}.md`, md)
  console.log(`  written: ${dir}/run-${run}.md`)
}

console.log(`model ${llmConfig.model}, fallback ${llmConfig.fallback || '-'}`)
for (let run = 1; run <= Number(args.runs); run++) {
  const started = performance.now()
  const { id } = createAssessment({
    jobDescription,
    level: args.level as 'junior' | 'intermediate' | 'senior',
    durationMin: Number(args.duration),
    skills: args.skills.split(',').map((x) => x.trim()),
  })
  let state = getAssessment(id)
  while (state.status === 'generating') {
    await new Promise((r) => setTimeout(r, 500))
    state = getAssessment(id)
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  console.log(`\n── run ${run}: ${state.status} in ${seconds} s`)
  let tin = 0
  let tout = 0
  for (const t of state.generation?.steps ?? []) {
    if (!t.trace) continue
    console.log(
      `  ${t.state.padEnd(5)} ${t.trace.model.padEnd(18)} ${
        String(t.trace.latencyMs).padStart(7)
      } ms  ${t.trace.tokensIn}→${t.trace.tokensOut}${
        t.trace.failures?.length ? `  (${t.trace.failures.length} failed)` : ''
      }`,
    )
  }
  // the trace of step 4 is the last of the reference traces: counted once
  for (const t of state.reference?.traces ?? []) {
    tin += t.tokensIn
    tout += t.tokensOut
    console.log(
      `  ref   ${t.model.padEnd(18)} ${
        String(t.latencyMs).padStart(7)
      } ms  ${t.tokensIn}→${t.tokensOut}`,
    )
  }
  for (const t of (state.generation?.steps ?? []).slice(0, 3)) {
    tin += t.trace?.tokensIn ?? 0
    tout += t.trace?.tokensOut ?? 0
  }
  console.log(
    `  tokens ${tin}→${tout}  ≈ $${cost(tin, tout).toFixed(3)} `,
  )
  if (state.status !== 'draft') {
    console.log(`  error: ${state.generation?.error}`)
    for (const f of state.generation?.failures ?? []) {
      console.log(`   - ${f.model}: ${f.reason} ${f.detail ?? ''}`)
    }
    continue
  }
  const deleted = new Set(state.deletedTests)
  const { checks, blocked } = computeChecks(
    state.spec,
    deleted,
    state.starterFails,
    state.reference,
  )
  console.log(
    `  ${state.spec.title} · ${state.spec.routes.length} routes · ${state.spec.requirements.length} requirements · ${state.spec.tests.length} tests (${
      state.spec.tests.filter((t) => t.visibility === 'hidden').length
    } hidden)`,
  )
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}`)
  for (const e of state.reference?.excluded ?? []) {
    console.log(`  excluded ${e.id}: ${e.reason}`)
  }
  console.log(`  approvable: ${blocked ? 'NO' : 'yes'}`)
  if (args.out) await writeRun(args.out, run, state, checks)
}
Deno.exit(0)
