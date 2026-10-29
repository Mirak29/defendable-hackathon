// The prompts must agree with the software that reads the answers: the JSON
// examples they show follow their own schema, and the grammar examples they
// give are read by the real test engine.
import { eq, test } from '/api/lib/test.ts'
import {
  INTERVIEWER,
  interviewerFor,
  interviewSystem,
  isCodeFile,
  judgePrompt,
  needAnalysisPrompt,
  needAnalysisSchema,
  prefillPrompt,
  prefillSchema,
  REPORTER,
  reporterFor,
  reportPrompt,
  scenarioPrompt,
  scenarioSchema,
  testsPrompt,
  testsSchema,
  verdictsSchema,
} from '/api/prompts.ts'
import {
  programJudgePrompt,
  programNeedAnalysisPrompt,
  programScenarioPrompt,
  programScenarioSchema,
  programTestsPrompt,
  programTestsSchema,
} from '/api/program-prompts.ts'
import { parseRequest, parseResponse, parseStep } from '/api/test-steps.ts'
import { skillCatalog } from '/web/lib/skills.ts'
import { demoAssessment, demoJobDescription } from '/fixtures/demo.ts'

const input = {
  jobDescription: demoJobDescription,
  level: 'intermediate',
  durationMin: 90,
  skills: ['REST API design', 'Data validation'],
  domain: 'Marketing links',
}

/** a small JSON Schema check: type, enum, required, properties, items */
const validate = (value, schema, path = '$') => {
  if (schema.enum && !schema.enum.includes(value)) {
    throw Error(`${path}: ${JSON.stringify(value)} not in ${schema.enum}`)
  }
  const kind = Array.isArray(value)
    ? 'array'
    : value === null
    ? 'null'
    : typeof value
  if (schema.type === 'integer' && !Number.isInteger(value)) {
    throw Error(`${path}: not an integer`)
  }
  if (schema.type && schema.type !== 'integer' && schema.type !== kind) {
    throw Error(`${path}: ${kind} instead of ${schema.type}`)
  }
  for (const key of schema.required ?? []) {
    if (!(key in value)) throw Error(`${path}: missing ${key}`)
  }
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    if (key in value) validate(value[key], sub, `${path}.${key}`)
  }
  if (schema.items) {
    value.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`))
  }
}

/** the JSON example that ends a prompt */
const example = (prompt) => {
  const last = prompt.trim().split('\n').at(-1)
  return JSON.parse(last.slice(last.indexOf('{')))
}

test('the JSON examples of the prompts follow their schemas', async (step) => {
  const cases = [
    ['need analysis', needAnalysisPrompt(input), needAnalysisSchema],
    ['scenario', scenarioPrompt(input, []), scenarioSchema],
    [
      'tests',
      testsPrompt({ routes: [], requirements: [], constraints: [] }),
      testsSchema,
    ],
    ['prefill', prefillPrompt('An offer', skillCatalog), prefillSchema],
    ['judge', judgePrompt('brief', 'code', 'failures'), verdictsSchema(['T3'])],
  ]
  for (const [name, prompt, schema] of cases) {
    await step(name, () => validate(example(prompt), schema.schema))
  }
})

test('the grammar of the tests prompt is the one the engine reads', async (step) => {
  await step('every "Valid:" line of the prompt parses', () => {
    const prompt = testsPrompt({
      routes: [],
      requirements: [],
      constraints: [],
    })
    const lines = prompt.split('\n').filter((l) => l.includes('Valid:'))
    eq(lines.length, 2)
    const [requests, responses] = lines.map((l) =>
      l.slice(l.indexOf('Valid:') + 6).split('|').map((x) => x.trim())
    )
    for (const r of requests) parseRequest(r)
    for (const r of responses) parseResponse(r)
    eq(parseRequest(requests[1]).repeat, 2)
    eq(parseResponse(responses[1]).expect.kind, 'non-empty')
    eq(parseResponse(responses[2]).expect.kind, 'header')
  })
  await step('the steps of the JSON example parse', () => {
    const prompt = testsPrompt({
      routes: [],
      requirements: [],
      constraints: [],
    })
    for (const t of example(prompt).tests) {
      for (const s of t.steps) parseStep(s)
    }
  })
  await step('the demo tests follow the same grammar', () => {
    for (const t of demoAssessment.tests) for (const s of t.steps) parseStep(s)
  })
})

test('the prompts say what the demo scenario shows', async (step) => {
  await step('the settings reach the prompt, verbatim', () => {
    const prompt = needAnalysisPrompt(input)
    eq(prompt.includes(demoJobDescription), true)
    eq(prompt.includes('REST API design | Data validation'), true)
    eq(prompt.includes('Marketing links'), true)
    eq(prompt.includes('90 minutes'), true)
  })
  await step(
    'a recruiter instruction is passed on to scenario and tests',
    () => {
      eq(
        scenarioPrompt(input, [], 'Add pagination').includes('Add pagination'),
        true,
      )
      eq(
        testsPrompt(
          { routes: [], requirements: [], constraints: [] },
          'More edge cases',
        )
          .includes('More edge cases'),
        true,
      )
    },
  )
  await step('hidden tests are asked to catch a classic shortcut', () => {
    const prompt = testsPrompt({
      routes: [],
      requirements: [],
      constraints: [],
    })
    eq(prompt.includes('classic shortcut'), true)
    eq(prompt.includes('javascript:alert(1)'), true)
    eq(prompt.includes('names the shortcut it catches'), true)
  })
  await step(
    'the interviewer is told to speak one clean question at a time',
    () => {
      eq(INTERVIEWER.includes('exactly one question mark'), true)
      eq(INTERVIEWER.includes('Never announce what you are going to ask'), true)
      eq(INTERVIEWER.includes('exactly once'), true)
      eq(INTERVIEWER.includes('One ask per turn'), true)
      eq(INTERVIEWER.includes('Never state what the code does'), true)
    },
  )
  await step('the demo scenario respects its own rules', () => {
    const names = demoAssessment.skills.map((s) => s.name)
    for (const r of demoAssessment.requirements) {
      for (const skill of r.skills) eq(names.includes(skill), true, r.id)
    }
    eq(
      demoAssessment.routes.length >= 3 && demoAssessment.routes.length <= 5,
      true,
    )
    eq(
      demoAssessment.requirements.length >= 4 &&
        demoAssessment.requirements.length <= 7,
      true,
    )
    eq(demoAssessment.tests.filter((t) => t.visibility === 'hidden').length, 3)
  })
})

test('the prompts of a program follow their schemas too', async (step) => {
  const empty = { io: {}, requirements: [], constraints: [] }
  const cases = [
    ['need analysis', programNeedAnalysisPrompt(input), needAnalysisSchema],
    ['scenario', programScenarioPrompt(input, []), programScenarioSchema],
    ['tests', programTestsPrompt(empty), programTestsSchema],
    [
      'judge',
      programJudgePrompt('brief', 'code', 'failures'),
      verdictsSchema(['T3']),
    ],
  ]
  for (const [name, prompt, schema] of cases) {
    await step(name, () => validate(example(prompt), schema.schema))
  }
  await step('the example of the tests is a real test: an output', () => {
    const [t] = example(programTestsPrompt(empty)).tests
    eq(t.output.trim().length > 0, true)
    eq(typeof t.input, 'string')
  })
  await step('the settings and the instruction reach the prompts', () => {
    const prompt = programScenarioPrompt(input, [], 'More edge cases')
    eq(prompt.includes(demoJobDescription), true)
    eq(prompt.includes('More edge cases'), true)
    eq(prompt.includes('standard input'), true)
    eq(programTestsPrompt(empty, 'Harder').includes('Harder'), true)
  })
  await step('a repeated identifier is written the same way twice', () => {
    const program = programTestsPrompt(empty)
    eq(program.includes('character for character'), true)
    eq(program.includes('never "xxx" then "XXX"'), true)
    const api = testsPrompt({ routes: [], requirements: [], constraints: [] })
    eq(api.includes('character for character'), true)
  })
  await step('a program is not told it is an API', () => {
    for (
      const p of [
        programNeedAnalysisPrompt(input),
        programScenarioPrompt(input, []),
      ]
    ) {
      eq(p.includes('HTTP API in TypeScript'), false)
    }
  })
})

test('the interviewer and the reporter know what the candidate wrote', async (step) => {
  const python = { kind: 'program', language: 'python' }
  await step('an API keeps the original words', () => {
    eq(interviewerFor({}), INTERVIEWER)
    eq(reporterFor({}), REPORTER)
    eq(interviewerFor({ kind: 'api', language: 'typescript' }), INTERVIEWER)
  })
  await step('a Python program is said as a Python program', () => {
    const interviewer = interviewerFor(python)
    eq(interviewer.includes('wrote the Python program of the brief'), true)
    eq(interviewer.includes('built the API of the brief'), false)
    eq(interviewer.includes('syntax check'), true)
    eq(interviewer.includes('the type check'), false)
    const reporter = reporterFor(python)
    eq(reporter.includes('wrote a small Python program'), true)
    eq(reporter.includes('built a small HTTP API'), false)
  })
  await step('the code at the root of a Python program is read', () => {
    eq(isCodeFile('main.py'), true)
    eq(isCodeFile('test_main.py'), true)
    eq(isCodeFile('src/app.ts'), true)
    eq(isCodeFile('deno.json'), false)
    eq(isCodeFile('README.md'), false)
    const prompt = reportPrompt({
      ...python,
      brief: 'brief',
      skills: [],
      tests: [],
      typeErrors: [],
      ownTests: 'none written',
      declaredTools: [],
      files: { 'main.py': 'print(1)', 'deno.json': '{}' },
      transcript: [],
      interviewCompleted: true,
    })
    eq(prompt.includes('### main.py'), true)
    eq(prompt.includes('### deno.json'), false)
    eq(prompt.includes('Syntax check: no error.'), true)
  })
  await step('the interview of a Python program names the syntax check', () => {
    const system = interviewSystem({
      ...python,
      brief: 'brief',
      files: { 'main.py': 'print(1)' },
      failedTests: [],
      passedCount: 1,
      totalCount: 1,
      typeErrors: ['main.py: invalid syntax'],
      questions: 6,
    })
    eq(system.includes('Syntax check:\n- main.py: invalid syntax'), true)
    eq(system.includes('### main.py'), true)
  })
})
