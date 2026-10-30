// Who /api/voice is for: a candidate whose interview is ready, else the lab
// when it is on (off in production, so the public demo account cannot open
// interviews on the project's model keys).
import { eq, test } from '/api/lib/test.ts'
import { candidateVoice } from '/api/interview.ts'
import {
  labConfig,
  labFacts,
  labProgramFacts,
  voiceOptionsFor,
} from '/api/voice-lab.ts'
import {
  approvedAssessment,
  signup,
  submittedCandidate,
} from '/api/lib/journey-test.js'

const voiceRequest = (cookie) =>
  new Request('http://localhost/api/voice', {
    headers: cookie ? { cookie } : {},
  })

const withLab = async (enabled, fn) => {
  const saved = labConfig.enabled
  labConfig.enabled = enabled
  try {
    await fn()
  } finally {
    labConfig.enabled = saved
  }
}

test('voice: who the interview is for', async (step) => {
  await step('a member without a candidate: the lab', async () => {
    await withLab(true, async () => {
      const options = await voiceOptionsFor(voiceRequest('dfd_session=x'))
      eq(options?.facts, labFacts)
    })
  })

  await step('a leftover candidate cookie does not lock the lab', async () => {
    await withLab(true, async () => {
      const options = await voiceOptionsFor(
        voiceRequest('dfd_candidate=an-old-link; dfd_session=x'),
      )
      eq(options?.facts, labFacts)
    })
  })

  await step('the lab off, as in production: nothing to open', async () => {
    await withLab(false, async () => {
      eq(await voiceOptionsFor(voiceRequest('dfd_session=x')), undefined)
    })
  })

  await step(
    'a candidate whose interview is ready: their interview',
    async () => {
      const member = await signup('VoiceRoute')
      const assessment = await approvedAssessment(member)
      const { cookies } = await submittedCandidate(member, assessment)
      // with the lab off too: a real interview never depends on it
      await withLab(false, async () => {
        const options = await voiceOptionsFor(
          voiceRequest(`dfd_candidate=${cookies.dfd_candidate}`),
        )
        eq(options, candidateVoice)
      })
    },
  )
})

test('voice lab: the facts of a real interview', async (step) => {
  await step('an API: kind, language and own tests, like factsOf', async () => {
    const facts = await labFacts()
    eq([facts.kind, facts.language, facts.ownTests], [
      'api',
      'typescript',
      'none written',
    ])
  })

  await step(
    'a program: the failed test written as in production',
    async () => {
      const facts = await labProgramFacts()
      eq([facts.kind, facts.language], ['program', 'python'])
      // expected and received as they are, the input quoted (factsOf)
      const line = facts.failedTests[0]
      eq(typeof line, 'string')
      eq(line.includes('expected "'), false)
    },
  )
})
