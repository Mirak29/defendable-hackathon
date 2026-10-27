// Generation of an assessment, on the real routes: with the recorded answers
// (no key), and with a mock of the Meta Model API that plays a model writing
// the Linkly assessment and a correct reference solution.
import { eq, test } from '/api/lib/test.ts'
import { routeHandler } from '/api/routes.ts'
import { llmConfig } from '/api/llm.ts'
import { demoAssessment } from '/fixtures/demo.ts'
import { demoFiles } from '/fixtures/demo-files.ts'

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
    'We are hiring an intermediate backend TypeScript developer for our marketing link service. They design REST APIs, validate incoming data and handle errors cleanly.',
  level: 'intermediate',
  durationMin: 90,
  skills: demoAssessment.skills.map((s) => s.name),
}

/** the assessment once the job is over */
const settled = async (id, token) => {
  for (let i = 0; i < 600; i++) {
    const res = await call('GET', '/api/assessment', { id }, token)
    const state = await res.json()
    if (state.status !== 'generating') return state
    await new Promise((r) => setTimeout(r, 100))
  }
  throw Error('the generation did not finish')
}

/** the demo solution in one file, without import: what the brief asks for */
const referenceSolution = ['validation', 'links_repository', 'app']
  .map((name) =>
    demoFiles[`src/${name}.ts`].replace(
      /^import[\s\S]*?from\s+["'][^"']+["'];?\n/gm,
      '',
    )
  ).join('\n')
  // the demo candidate accepts "javascript:" URLs (the hidden test T9 fails on
  // it, on purpose): a correct reference solution refuses them
  .replace(
    'new URL(value);\n    return true;',
    'const { protocol } = new URL(value);\n    return protocol === "http:" || protocol === "https:";',
  )
if (!referenceSolution.includes('protocol ===')) {
  throw Error('the demo solution changed: fix the reference of this test')
}

/** a mock of the API: one answer per kind of prompt */
const withModel = async (fn, extraTests) => {
  const calls = []
  const answer = (prompt) => {
    if (prompt.includes('Analyse the need')) {
      return JSON.stringify({
        level: 'intermediate',
        domain: 'Marketing links',
        skills: demoAssessment.skills,
      })
    }
    if (prompt.includes('Write the scenario')) {
      const { tests: _tests, skills: _skills, ...scenario } = demoAssessment
      return JSON.stringify(scenario)
    }
    if (prompt.includes('Write 8 to 12 HTTP evaluation tests')) {
      // a test the brief does not justify: it asks for a 418 nobody wrote
      const unfair = [...demoAssessment.tests, ...(extraTests ?? [])]
      return JSON.stringify({ tests: unfair })
    }
    if (prompt.includes('decide who is wrong')) {
      return JSON.stringify({
        verdicts: [{
          id: 'T12',
          fault: 'test',
          evidence: 'none',
          reason: 'The brief never says a deleted link answers 418.',
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
    calls.push({ task: prompt.slice(0, 40), stream: body.stream })
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
  const saved = { ...llmConfig }
  Object.assign(llmConfig, {
    key: 'test-key',
    baseUrl: `http://localhost:${server.addr.port}/v1`,
    retryDelayMs: 0,
  })
  try {
    return await fn(calls)
  } finally {
    Object.assign(llmConfig, saved)
    await server.shutdown()
  }
}

test('assessment: the routes refuse what the form refuses', async (step) => {
  const token = await signup('Forms')
  const refused = async (patch) =>
    (await call('POST', '/api/assessment', { ...input, ...patch }, token))
      .status
  await step('a short description, no skill, a wrong duration', async () => {
    eq(await refused({ jobDescription: 'too short' }), 400)
    eq(await refused({ skills: [] }), 400)
    eq(await refused({ skills: ['a', 'b', 'c', 'd', 'e', 'f'] }), 400)
    eq(await refused({ durationMin: 45 }), 400)
  })
  await step('every route needs a session', async () => {
    eq((await call('GET', '/api/assessments')).status, 401)
    eq((await call('POST', '/api/assessment', input)).status, 401)
  })
})

test('assessment: without a key the recorded answers are used', async (step) => {
  const token = await signup('Recorded')
  let state
  await step('the job ends as a draft of the demo assessment', async () => {
    const res = await call('POST', '/api/assessment', input, token)
    eq(res.status, 200)
    state = await settled((await res.json()).id, token)
    eq(state.status, 'draft')
    eq(state.spec.title, demoAssessment.title)
    eq(state.generation.steps.map((s) => s.state).slice(0, 3), [
      'done',
      'done',
      'done',
    ])
    eq(state.generation.steps[0].trace.replay, true)
    // the sandbox ran the starter code against the tests
    eq(state.starterFails, true)
    // no model, no reference solution: the review shows it
    eq(state.reference, undefined)
  })
  await step('approval freezes it and creates the candidate link', async () => {
    const res = await call(
      'POST',
      '/api/assessment/approve',
      { id: state.id },
      token,
    )
    eq(res.status, 200)
    const approved = await res.json()
    eq(approved.status, 'approved')
    eq(approved.invitation.length, 10)
    // an approved assessment cannot change any more
    const again = await call(
      'POST',
      '/api/assessment/update',
      { id: state.id, title: 'Other' },
      token,
    )
    eq(again.status, 409)
  })
})

test('assessment: generated by a model', async (step) => {
  const token = await signup('Model')
  let state
  await withModel(async (calls) => {
    await step('four steps, a fair reference solution, a draft', async () => {
      const res = await call('POST', '/api/assessment', input, token)
      state = await settled((await res.json()).id, token)
      eq(state.status, 'draft')
      eq(state.generation.steps.map((s) => s.state), [
        'done',
        'done',
        'done',
        'done',
      ])
      eq(state.generation.steps[1].trace.model, 'Muse Spark 1.3')
      eq(state.starterFails, true)
      // a solution written from the brief passes every test: nothing excluded
      eq(state.reference.results.every((r) => r.passed), true)
      eq(state.reference.excluded, [])
      eq(state.spec.tests.length, demoAssessment.tests.length)
    })
    await step('long steps are streamed, the short one is not', () => {
      const byTask = Object.fromEntries(calls.map((c) => [c.task, c.stream]))
      eq(Object.values(byTask).filter(Boolean).length >= 3, true)
    })
  })

  await step('approval is allowed: no check blocks it', async () => {
    const res = await call(
      'POST',
      '/api/assessment/approve',
      { id: state.id },
      token,
    )
    eq(res.status, 200)
  })
})

test('assessment: an unfair test is excluded by the judge', async (step) => {
  const token = await signup('Judge')
  const unfair = {
    id: 'T12',
    title: 'Teapot after deletion',
    route: 'DELETE /links/:alias',
    condition: 'a deleted link answers 418',
    expected: '418',
    visibility: 'public',
    requirementIds: ['R5'],
    steps: [
      {
        request: 'POST /links {"url":"https://a.com","alias":"tea"}',
        response: '201',
      },
      { request: 'DELETE /links/tea', response: '204' },
      { request: 'GET /tea', response: '418' },
    ],
  }
  let state
  await withModel(async (calls) => {
    await step('the reference fails it, the judge excludes it', async () => {
      const res = await call('POST', '/api/assessment', input, token)
      state = await settled((await res.json()).id, token)
      eq(state.status, 'draft')
      eq(state.reference.results.filter((r) => !r.passed).map((r) => r.id), [
        'T12',
      ])
      eq(state.reference.excluded.map((e) => e.id), ['T12'])
      eq(state.reference.excluded[0].reason.includes('418'), true)
      eq(state.deletedTests, ['T12'])
      eq(calls.some((c) => c.task.includes('Brief as')), false)
    })
  }, [unfair])
  await step(
    'the draft is approvable: the unfair test is dropped',
    async () => {
      const res = await call('POST', '/api/assessment/approve', {
        id: state.id,
      }, token)
      eq(res.status, 200)
      const approved = await res.json()
      eq(approved.spec.tests.some((t) => t.id === 'T12'), false)
    },
  )
})

test('assessment: the model gets it wrong', async (step) => {
  const token = await signup('Wrong')
  await step(
    'a model that answers garbage fails with a readable error',
    async () => {
      const saved = { ...llmConfig }
      const server = Deno.serve(
        { port: 0, onListen() {} },
        () =>
          Response.json({
            choices: [{ message: { content: 'not json at all' } }],
          }),
      )
      Object.assign(llmConfig, {
        key: 'test-key',
        baseUrl: `http://localhost:${server.addr.port}/v1`,
        retryDelayMs: 0,
      })
      try {
        const res = await call('POST', '/api/assessment', input, token)
        const state = await settled((await res.json()).id, token)
        eq(state.status, 'failed')
        eq(state.generation.steps[0].state, 'error')
        eq(state.generation.error, 'The model did not give a usable answer.')
        eq(state.generation.failures.length >= 2, true)
        // an approval is not possible: there is nothing to approve
        eq(
          (await call(
            'POST',
            '/api/assessment/approve',
            { id: state.id },
            token,
          ))
            .status,
          409,
        )
      } finally {
        Object.assign(llmConfig, saved)
        await server.shutdown()
      }
    },
  )
})

test('assessment: a company never sees another one', async (step) => {
  const a = await signup('Alpha')
  const b = await signup('Beta')
  const res = await call('POST', '/api/assessment', input, a)
  const { id } = await res.json()
  await settled(id, a)
  await step('every route answers 404 to the other company', async () => {
    eq((await call('GET', '/api/assessment', { id }, b)).status, 404)
    for (
      const action of [
        'retry',
        'update',
        'deleted-tests',
        'regenerate',
        'approve',
      ]
    ) {
      const out = await call(
        'POST',
        `/api/assessment/${action}`,
        { id, testIds: [], instruction: 'x' },
        b,
      )
      eq(out.status, 404, action)
    }
    eq((await (await call('GET', '/api/assessments', {}, b)).json()).length, 0)
  })
})
