// The generation of a "program" assessment on the real routes, with a mock of
// the model that answers each kind of prompt: the checks and the reference
// solution are real, and run in the sandbox.
import { eq, test } from '/api/lib/test.ts'
import { llmConfig } from '/api/llm.ts'
import { routeHandler } from '/api/routes.ts'
import { demoAssessment } from '/fixtures/demo.ts'
import { computeChecks } from '/web/lib/assessment-checks.ts'

const call = async (method, path, input, token) => {
  const url = new URL(`http://localhost${path}`)
  if (method === 'GET') {
    for (const [k, v] of Object.entries(input ?? {})) {
      url.searchParams.set(k, String(v))
    }
  }
  try {
    return await routeHandler({
      req: new Request(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify(input ?? {}) : undefined,
      }),
      url,
      cookies: token ? { dfd_session: token } : {},
      trace: Date.now(),
    })
  } catch (error) {
    if (error.response instanceof Response) return error.response
    throw error
  }
}

const signup = async (name) => {
  const res = await call('POST', '/api/signup', {
    companyName: name,
    name: 'Test',
    email: `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}@gmail.com`,
    password: 'Strong-password-1',
  })
  return res.headers.get('set-cookie').match(/dfd_session=([^;]+)/)[1]
}

const input = {
  jobDescription:
    'We are hiring an intermediate developer for the stock service of our shops. They parse the movements of each day, validate every line and report the final quantities.',
  level: 'intermediate',
  durationMin: 90,
  skills: demoAssessment.skills.map((s) => s.name),
  kind: 'program',
  languages: ['typescript', 'python'],
}

const settled = async (id, token) => {
  for (let i = 0; i < 600; i++) {
    const state = await (await call('GET', '/api/assessment', { id }, token))
      .json()
    if (state.status !== 'generating') return state
    await new Promise((r) => setTimeout(r, 100))
  }
  throw Error('the generation did not finish')
}

const scenario = {
  title: 'Stock reconciliation',
  company: 'Stockly',
  context: 'Stockly tracks the stock of small shops.',
  mission: 'Your mission: write the program that reports the final stock.',
  candidateBrief: {
    context: 'Stockly tracks the stock of small shops. You join the team.',
    mission:
      'Write a program that reads stock movements, one per line, and writes the final quantity of each product, sorted by name. Ignore invalid lines.',
  },
  constraints: [
    'A movement is "IN <product> <quantity>" or "OUT <product> <quantity>", a product is made of lowercase letters, a quantity is a positive integer.',
    'Products are written in alphabetical order, one per line as "<product> <quantity>".',
    'A product whose final quantity is 0 is not written.',
    'A line that is not a valid movement is ignored.',
    'The program reads the whole standard input and writes only the result on the standard output.',
  ],
  io: {
    input: 'Zero or more lines, each one a stock movement.',
    output: 'One line per product with a non-zero quantity, sorted.',
  },
  requirements: [
    [
      'R1',
      'Final quantities',
      'The lines "IN apple 5" and "OUT apple 2" give "apple 3".',
    ],
    ['R2', 'Sorted output', 'Products are written in alphabetical order.'],
    [
      'R3',
      'Zero is not written',
      'A product whose quantity is 0 is not written.',
    ],
    ['R4', 'Invalid lines', 'A line that is not a valid movement is ignored.'],
  ].map(([id, title, statement]) => ({
    id,
    title,
    statement,
    why: 'Shows the handling of the rule.',
    skills: ['Data validation'],
  })),
}

const testOf = (id, visibility, ids, stdin, stdout, title = `Case ${id}`) => ({
  id,
  title,
  condition: 'a small input',
  expected: 'the stock',
  visibility,
  requirementIds: ids,
  input: stdin,
  output: stdout,
})

const tests = [
  testOf('T1', 'public', ['R1'], 'IN apple 5\nOUT apple 2\n', 'apple 3\n'),
  testOf(
    'T2',
    'public',
    ['R2'],
    'IN pear 4\nIN apple 1\n',
    'apple 1\npear 4\n',
  ),
  testOf(
    'T3',
    'public',
    ['R3'],
    'IN apple 2\nOUT apple 2\nIN fig 1\n',
    'fig 1\n',
  ),
  testOf('T4', 'public', ['R4'], 'hello\nIN kiwi 3\nIN kiwi x\n', 'kiwi 3\n'),
  testOf(
    'T5',
    'hidden',
    ['R2', 'R4'],
    'IN b 1\nIN a 1\nIN B 1\nIN a 1\n',
    'a 2\nb 1\n',
  ),
  testOf('T6', 'hidden', ['R1'], 'OUT apple 3\nIN apple 5\n', 'apple 2\n'),
]

const referenceSolution =
  `const input = await new Response(Deno.stdin.readable).text();
const stock = new Map<string, number>();
for (const line of input.split("\\n")) {
  const m = line.trim().match(/^(IN|OUT) ([a-z]+) ([1-9][0-9]*)$/);
  if (!m) continue;
  const q = Number(m[3]);
  stock.set(m[2], (stock.get(m[2]) ?? 0) + (m[1] === "IN" ? q : -q));
}
const lines = [...stock].filter(([, q]) => q !== 0)
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([p, q]) => \`\${p} \${q}\`);
console.log(lines.join("\\n"));`

const withModel = async (fn, extraTests = []) => {
  const calls = []
  const answer = (prompt) => {
    if (prompt.includes('Analyse the need')) {
      return JSON.stringify({
        level: 'intermediate',
        domain: 'Warehouse stock',
        skills: demoAssessment.skills,
      })
    }
    if (prompt.includes('Write the scenario of a small, realistic program')) {
      return JSON.stringify(scenario)
    }
    if (prompt.includes('Write 8 to 12 evaluation tests')) {
      return JSON.stringify({ tests: [...tests, ...extraTests] })
    }
    if (prompt.includes('decide who is wrong')) {
      return JSON.stringify({
        verdicts: [{
          id: 'T7',
          fault: 'test',
          evidence: 'none',
          reason: 'The brief never says that two movements make three.',
        }],
      })
    }
    if (prompt.includes('Write the solution of this brief')) {
      return '```ts\n' + referenceSolution + '\n```'
    }
    return '{}'
  }
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const body = await req.json()
    const prompt = body.messages.at(-1).content
    calls.push({ prompt, stream: body.stream })
    const content = answer(prompt)
    if (body.stream) {
      const chunk = (c) => `data: ${JSON.stringify(c)}\n\n`
      return new Response(
        chunk({ choices: [{ delta: { content } }] }) +
          chunk({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          }) + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    return Response.json({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    })
  })
  const saved = structuredClone(llmConfig)
  Object.assign(llmConfig, {
    key: 'test-key',
    baseUrl: `http://localhost:${server.addr.port}/v1`,
    open: { key: '', baseUrl: '' },
    retryDelayMs: 0,
  })
  try {
    return await fn(calls)
  } finally {
    Object.assign(llmConfig, saved)
    await server.shutdown()
  }
}

test('program generation: a draft the checks accept', async (step) => {
  const token = await signup('ProgramGen')
  let state
  await withModel(async (calls) => {
    await step(
      'four steps, a reference solution, a program draft',
      async () => {
        const res = await call('POST', '/api/assessment', input, token)
        eq(res.status, 200)
        state = await settled((await res.json()).id, token)
        eq(state.status, 'draft')
        eq(state.generation.steps.map((s) => s.state), [
          'done',
          'done',
          'done',
          'done',
        ])
        eq(state.spec.kind, 'program')
        eq(state.spec.languages, ['typescript', 'python'])
        eq(state.spec.routes, [])
        eq(state.spec.io.output.length > 0, true)
        eq(state.spec.format.startsWith('Program'), true)
        eq(state.input.kind, 'program')
      },
    )

    await step(
      'a test is an input and an output, the same for every language',
      () => {
        eq(state.spec.tests.length, 6)
        const [first] = state.spec.tests
        eq(first.route, 'program')
        eq(first.steps, [{
          request: 'IN apple 5\nOUT apple 2\n',
          // a model's trailing line break is dropped: the comparison ignores it
          response: 'apple 3',
        }])
      },
    )

    await step(
      'the starter fails every test, the reference passes them all',
      () => {
        eq(state.starterFails, true)
        eq(state.reference.results.every((r) => r.passed), true)
        eq(state.reference.excluded, [])
        const { checks, blocked } = computeChecks(
          state.spec,
          new Set(),
          state.starterFails,
          state.reference,
        )
        eq(blocked, false)
        eq(
          checks.some((c) =>
            c.label === 'Every test is linked to a requirement'
          ),
          true,
        )
      },
    )

    await step('the prompts were those of a program', () => {
      const first = calls.map((c) => c.prompt).join('\n')
      eq(first.includes('standard input'), true)
      eq(first.includes('HTTP evaluation tests'), false)
    })
  })

  await step(
    'approval is allowed, and the candidate chooses a language',
    async () => {
      const res = await call('POST', '/api/assessment/approve', {
        id: state.id,
      }, token)
      eq(res.status, 200)
      const invited = await call('POST', '/api/candidate/invite', {
        assessment: state.id,
        firstName: 'Awa',
        lastName: 'Diop',
        email: `awa-${crypto.randomUUID().slice(0, 6)}@gmail.com`,
      }, token)
      eq(invited.status, 200)
      const view = await (await call('GET', '/api/invitation', {
        invitation: (await invited.json()).invitation,
      })).json()
      eq(view.kind, 'program')
      eq(view.languages, ['typescript', 'python'])
    },
  )
})

test('program generation: a test the brief does not justify is excluded', async (step) => {
  const token = await signup('ProgramJudge')
  // the expected output is wrong for its input
  const unfair = testOf(
    'T7',
    'public',
    ['R1'],
    'IN apple 1\nIN apple 1\n',
    'apple 3\n',
    'Two movements make three',
  )
  await withModel(async () => {
    await step('the reference fails it, the judge removes it', async () => {
      const res = await call('POST', '/api/assessment', input, token)
      const state = await settled((await res.json()).id, token)
      eq(state.status, 'draft')
      eq(state.reference.excluded.map((e) => e.id), ['T7'])
      eq(state.reference.results.find((r) => r.id === 'T7').passed, false)
      eq(state.deletedTests, ['T7'])
    })
  }, [unfair])
})

test('program generation: an API assessment is unchanged', async (step) => {
  const token = await signup('ProgramApi')
  await step('no kind: an API, the format of before', async () => {
    const res = await call('POST', '/api/assessment', {
      ...input,
      kind: undefined,
      languages: undefined,
    }, token)
    const state = await settled((await res.json()).id, token)
    eq(state.spec.kind, undefined)
    eq(state.spec.format, 'HTTP API in TypeScript (Deno)')
    eq(state.spec.routes.length > 0, true)
  })
})
