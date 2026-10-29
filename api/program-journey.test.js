// The journey of a candidate on a "program" assessment, on the real routes: the
// language is chosen before the clock starts, the editor opens in it, and the
// runs, the check and the preparation of the interview follow it.
import { eq, test } from '/api/lib/test.ts'
import {
  approvedAssessment,
  call,
  cookieOf,
  invite,
  prepared,
  signup,
} from '/api/lib/journey-test.js'
import { Assessment, Candidate } from '/api/schema.ts'
import { factsOf } from '/api/interview.ts'
import { interviewSystem } from '/api/prompts.ts'

const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v)

const testOf = (id, visibility, stdin, stdout) => ({
  id,
  title: `Sum ${id}`,
  route: 'program',
  condition: 'a list of numbers, one per line',
  expected: `the total: ${stdout}`,
  visibility,
  requirementIds: ['R1'],
  steps: [{ request: stdin, response: stdout }],
})

/** an approved assessment turned into a "program" one, as the generation will */
const programAssessment = async (member, languages) => {
  const id = await approvedAssessment(member)
  const row = Assessment.require(id)
  const spec = json(row.assessmentSpec)
  Assessment.update({
    assessmentId: id,
    assessmentSpec: {
      ...spec,
      kind: 'program',
      languages,
      format: 'Program (standard input to standard output)',
      routes: [],
      io: {
        input: 'one integer per line',
        output: 'their sum, on one line',
      },
      tests: [
        testOf('T1', 'public', '3\n4\n5\n', '12'),
        testOf('T2', 'public', '10\n', '10'),
        testOf('T3', 'hidden', '', '0'),
      ],
    },
  })
  return id
}

const SOLUTIONS = {
  python: {
    'main.py': `import sys
print(sum(int(l) for l in sys.stdin if l.strip()))
`,
  },
  typescript: {
    'src/main.ts': `const text = await new Response(Deno.stdin.readable).text()
console.log(text.split('\\n').filter(Boolean).reduce((n, l) => n + Number(l), 0))
`,
  },
}

test('program journey: the language is chosen before the clock starts', async (step) => {
  const member = await signup('Programs')
  const assessment = await programAssessment(member, ['typescript', 'python'])
  let cookies
  let candidateId
  let invitation

  await step('the welcome page offers the languages', async () => {
    const created = await invite(member, assessment)
    invitation = created.body.invitation
    candidateId = created.body.candidateId
    const view = await (await call('GET', '/api/invitation', { invitation }))
      .json()
    eq(view.kind, 'program')
    eq(view.languages, ['typescript', 'python'])
    eq(view.language, undefined)
  })

  await step(
    'a language the assessment does not offer is refused',
    async () => {
      const res = await call(
        'POST',
        '/api/candidate/start',
        {
          invitation,
          language: 'python',
        },
        {},
        {},
      )
      eq(res.status, 200) // python is offered here
      const other = await invite(member, assessment)
      const refused = await call('POST', '/api/candidate/start', {
        invitation: other.body.invitation,
        language: 'rust',
      })
      eq(refused.status >= 400, true)
    },
  )

  await step('the editor opens in the chosen language, fixed', async () => {
    const started = await call('POST', '/api/candidate/start', {
      invitation,
      language: 'python', // a second start gives the session back, unchanged
    })
    cookies = { dfd_candidate: cookieOf(started, 'dfd_candidate') }
    const view = await started.json()
    eq(view.language, 'python')
    eq(view.kind, 'program')
    eq(Object.keys(view.files).includes('main.py'), true)
    eq(Object.keys(view.files).includes('src/app.ts'), false)
    eq(view.assessment.hiddenCount, 1)
    eq(
      (await call('GET', '/api/invitation', { invitation }).then((r) =>
        r.json()
      )).language,
      'python',
    )
    const later = await call('POST', '/api/candidate/start', {
      invitation,
      language: 'typescript',
    })
    eq((await later.json()).language, 'python')
  })

  await step('the starter fails every test', async () => {
    const view = await (await call('GET', '/api/candidate/me', {}, cookies))
      .json()
    const res = await call('POST', '/api/candidate/run', {
      kind: 'eval',
      files: view.files,
    }, cookies)
    const { results } = await res.json()
    eq(results.map((r) => r.passed), [false, false])
  })

  await step('the right program passes the public tests', async () => {
    const res = await call('POST', '/api/candidate/run', {
      kind: 'eval',
      files: SOLUTIONS.python,
    }, cookies)
    const { results } = await res.json()
    eq(results.map((r) => [r.id, r.passed]), [['T1', true], ['T2', true]])
  })

  await step('"Run" uses the sample input', async () => {
    const res = await call('POST', '/api/candidate/run', {
      kind: 'run',
      files: SOLUTIONS.python,
    }, cookies)
    const { run } = await res.json()
    eq(run.chunks.map((c) => c.text).join(''), '12\n')
  })

  await step('a syntax error is shown with its line', async () => {
    const res = await call('POST', '/api/candidate/check', {
      files: { 'main.py': 'x = 1\nif x print(x)\n' },
    }, cookies)
    const problems = await res.json()
    eq(problems.length, 1)
    eq(problems[0].line, 2)
  })

  await step('submitting prepares the interview with every test', async () => {
    await call('POST', '/api/candidate/files', {
      files: SOLUTIONS.python,
    }, cookies)
    await call('POST', '/api/candidate/submit', { tools: ['Claude'] }, cookies)
    const view = await prepared(cookies)
    eq(view.preparation.error, undefined)
    const stored = json(Candidate.require(candidateId).candidateResults)
    eq(stored.tests.map((t) => [t.id, t.passed]), [
      ['T1', true],
      ['T2', true],
      ['T3', true],
    ])
    eq(stored.problems, [])
  })

  await step('the interviewer and the reporter know it is Python', () => {
    const c = Candidate.require(candidateId)
    const facts = factsOf(c)
    eq([facts.kind, facts.language], ['program', 'python'])
    eq(Object.keys(facts.files).includes('main.py'), true)
    eq(facts.passedCount, 3)
    eq(
      interviewSystem(facts).includes('wrote the Python program of the brief'),
      true,
    )
  })
})

test('program journey: TypeScript, and a single language', async (step) => {
  const member = await signup('Programs2')
  const assessment = await programAssessment(member, ['typescript'])
  const created = await invite(member, assessment)
  const { invitation } = created.body

  await step('one language: no choice, the default is used', async () => {
    const view = await (await call('GET', '/api/invitation', { invitation }))
      .json()
    eq(view.languages, ['typescript'])
    const refused = await call('POST', '/api/candidate/start', {
      invitation,
      language: 'python',
    })
    eq(refused.status, 400)
    const started = await call('POST', '/api/candidate/start', { invitation })
    const me = await started.json()
    eq(me.language, 'typescript')
    eq(Object.keys(me.files).includes('src/main.ts'), true)
  })

  await step('the TypeScript program runs on the same tests', async () => {
    const started = await call('POST', '/api/candidate/start', { invitation })
    const cookies = { dfd_candidate: cookieOf(started, 'dfd_candidate') }
    const res = await call('POST', '/api/candidate/run', {
      kind: 'eval',
      files: SOLUTIONS.typescript,
    }, cookies)
    const { results } = await res.json()
    eq(results.map((r) => r.passed), [true, true])
  })
})

test('program journey: an API assessment stays in TypeScript', async (step) => {
  const member = await signup('Programs3')
  const assessment = await approvedAssessment(member)
  const { body } = await invite(member, assessment)

  await step('no language to choose', async () => {
    const view = await (await call('GET', '/api/invitation', {
      invitation: body.invitation,
    })).json()
    eq([view.kind, view.languages], ['api', ['typescript']])
    const refused = await call('POST', '/api/candidate/start', {
      invitation: body.invitation,
      language: 'python',
    })
    eq(refused.status, 400)
  })
})
