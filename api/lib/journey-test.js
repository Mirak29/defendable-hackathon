// Helpers of the tests that play a journey on the real routes: a recruiter
// signs up, approves an assessment (recorded answers, no key), invites.
import { eq } from '/api/lib/test.ts'
import { routeHandler } from '/api/routes.ts'
import { demoJobDescription } from '/fixtures/demo.ts'
import { demoFiles } from '/fixtures/demo-files.ts'
import { llmConfig } from '/api/llm.ts'

export const call = async (method, path, input, cookies = {}, headers = {}) => {
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
        headers: { 'content-type': 'application/json', ...headers },
        body: method === 'POST' ? JSON.stringify(input ?? {}) : undefined,
      }),
      url,
      cookies,
      trace: Date.now(),
    })
  } catch (error) {
    if (error.response instanceof Response) return error.response
    throw error
  }
}

export const cookieOf = (res, name) =>
  res.headers.get('set-cookie')?.match(new RegExp(`${name}=([^;]+)`))?.[1]

export const signup = async (name) => {
  const res = await call('POST', '/api/signup', {
    companyName: name,
    name: 'Test',
    email: `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}@gmail.com`,
    password: 'Strong-password-1',
  })
  return { dfd_session: cookieOf(res, 'dfd_session') }
}

/** an approved assessment (recorded answers, no key) and its owner */
export const approvedAssessment = async (member) => {
  const created = await call('POST', '/api/assessment', {
    jobDescription: demoJobDescription,
    level: 'intermediate',
    durationMin: 90,
    skills: ['REST API design', 'Data validation'],
  }, member)
  const { id } = await created.json()
  for (let i = 0; i < 300; i++) {
    const state = await (await call('GET', '/api/assessment', { id }, member))
      .json()
    if (state.status !== 'generating') break
    await new Promise((r) => setTimeout(r, 50))
  }
  const res = await call('POST', '/api/assessment/approve', { id }, member)
  eq(res.status, 200)
  return id
}

export const identity = (n = 1) => ({
  firstName: 'Awa',
  lastName: 'Diop',
  email: `awa${n}-${crypto.randomUUID().slice(0, 6)}@gmail.com`,
})

export const invite = async (member, assessment, patch = {}) => {
  const res = await call('POST', '/api/candidate/invite', {
    assessment,
    ...identity(),
    ...patch,
  }, member)
  return { res, body: res.ok ? await res.json() : undefined }
}

/** the preparation of the interview, once it is over */
export const prepared = async (cookies) => {
  for (let i = 0; i < 600; i++) {
    const view = await (await call('GET', '/api/candidate/me', {}, cookies))
      .json()
    const steps = view.preparation?.steps ?? []
    if (steps.at(-1)?.state === 'done' || view.preparation?.error) return view
    await new Promise((r) => setTimeout(r, 100))
  }
  throw Error('the preparation did not finish')
}

/** a candidate who built the demo solution and submitted it, interview ready */
export const submittedCandidate = async (member, assessment) => {
  const { body } = await invite(member, assessment)
  const started = await call('POST', '/api/candidate/start', {
    invitation: body.invitation,
  })
  const cookies = { dfd_candidate: cookieOf(started, 'dfd_candidate') }
  await call('POST', '/api/candidate/files', { files: demoFiles }, cookies)
  await call('POST', '/api/candidate/submit', { tools: ['Claude'] }, cookies)
  await prepared(cookies)
  return { cookies, candidateId: body.candidateId, invitation: body.invitation }
}

/**
 * a mock of the model: `answer` is the content of its reply (undefined: down).
 * The second check of the report is answered apart (`support`, by default it
 * finds nothing to doubt) and counted in `calls.support`, not in `calls`.
 */
export const withModel = async (
  answer,
  fn,
  { support = { verdicts: [] } } = {},
) => {
  const calls = []
  calls.support = []
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const body = await req.json()
    const second = body.messages?.some((m) =>
      m.role === 'system' &&
      m.content.includes('You check the work of a report writer')
    )
    if (second) calls.support.push(body)
    else calls.push(body)
    const content = second
      ? typeof support === 'function' ? support(calls.support) : support
      : typeof answer === 'function'
      ? answer(calls.length)
      : answer
    if (content === undefined) return new Response('down', { status: 503 })
    if (body.stream) {
      // a long step is streamed: one chunk with the answer, then the usage
      const chunks = [
        { choices: [{ delta: { content: JSON.stringify(content) } }] },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ]
      return new Response(
        chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    return Response.json({
      choices: [{
        message: { content: JSON.stringify(content) },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })
  })
  const saved = { ...llmConfig }
  Object.assign(llmConfig, {
    key: 'test-key',
    baseUrl: `http://localhost:${server.addr.port}/v1`,
    retryDelayMs: 0,
    maxRetryAfterMs: 0,
    retries: 0,
  })
  try {
    return await fn(calls)
  } finally {
    Object.assign(llmConfig, saved)
    await server.shutdown()
  }
}
