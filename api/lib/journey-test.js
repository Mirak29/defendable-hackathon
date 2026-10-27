// Helpers of the tests that play a journey on the real routes: a recruiter
// signs up, approves an assessment (recorded answers, no key), invites.
import { eq } from '/api/lib/test.ts'
import { routeHandler } from '/api/routes.ts'
import { demoJobDescription } from '/fixtures/demo.ts'

export const call = async (method, path, input, cookies = {}) => {
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
