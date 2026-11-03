import { eq, test } from '/api/lib/test.ts'
import { call, cookieOf, invite, signup } from '/api/lib/journey-test.js'
import { demoFiles } from '/fixtures/demo-files.ts'

test('guided demo: prepared example, real sandbox, demo account only', async (step) => {
  const previous = Deno.env.get('DEMO_ACCESS')
  Deno.env.set('DEMO_ACCESS', '1')
  try {
    await step(
      'requires a signed-in demo member and same-origin requests',
      async () => {
        eq((await call('POST', '/api/demo/assessment')).status, 401)
        const ordinary = await signup('GuidedDemoAccess')
        eq(
          (await call('POST', '/api/demo/assessment', {}, ordinary)).status,
          404,
        )
      },
    )
    const session = await call('POST', '/api/demo/session')
    const recruiter = { dfd_session: cookieOf(session, 'dfd_session') }
    let id
    await step(
      'creates one reusable prepared assessment, with no fabricated AI checks',
      async () => {
        const first = await call('POST', '/api/demo/assessment', {}, recruiter)
        eq(first.status, 200)
        id = (await first.json()).id
        const second = await call('POST', '/api/demo/assessment', {}, recruiter)
        eq((await second.json()).id, id)
        const state =
          await (await call('GET', '/api/assessment', { id }, recruiter)).json()
        eq([state.status, state.input.domain, state.spec.tests.length], [
          'approved',
          'guided-demo-v1',
          11,
        ])
        eq([state.generation, state.reference, state.starterFails], [
          undefined,
          undefined,
          undefined,
        ])
        const foreign = await call(
          'POST',
          '/api/demo/assessment',
          {},
          recruiter,
          { origin: 'https://other.example' },
        )
        eq(foreign.status, 403)
      },
    )
    await step(
      'its example solution really passes the public and personal tests',
      async () => {
        const { body } = await invite(recruiter, id, { sendEmail: false })
        const started = await call('POST', '/api/candidate/start', {
          invitation: body.invitation,
        })
        eq(started.status, 200)
        const candidate = { dfd_candidate: cookieOf(started, 'dfd_candidate') }
        const evaluation = await (await call('POST', '/api/candidate/run', {
          kind: 'eval',
          files: demoFiles,
        }, candidate)).json()
        eq(evaluation.results.length, 8)
        eq(evaluation.results.every((r) => r.passed), true)
        const mine = await (await call('POST', '/api/candidate/run', {
          kind: 'mine',
          files: demoFiles,
        }, candidate)).json()
        eq(mine.own.passed > 0, true)
        eq(mine.own.failed, 0)
      },
    )
    await step(
      'disabling demo access also disables preparing examples for existing demo sessions',
      async () => {
        Deno.env.delete('DEMO_ACCESS')
        eq(
          (await call('POST', '/api/demo/assessment', {}, recruiter)).status,
          404,
        )
      },
    )
  } finally {
    if (previous === undefined) Deno.env.delete('DEMO_ACCESS')
    else Deno.env.set('DEMO_ACCESS', previous)
  }
})
