import { eq, test } from '/api/lib/test.ts'
import {
  approvedAssessment,
  call,
  signup,
  submittedCandidate,
} from '/api/lib/journey-test.js'
import { handleRecording } from '/api/recordings.ts'
import { candidateVoice } from '/api/interview.ts'
import { labConfig, voiceOptionsFor } from '/api/voice-lab.ts'
import { Candidate } from '/api/schema.ts'
import { recoverInterruptedJobs } from '/api/recovery.ts'

const createRecording = (cookies) =>
  handleRecording(
    new Request('http://localhost/api/candidate/recording', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        cookie: `dfd_candidate=${cookies.dfd_candidate}`,
      },
      body: JSON.stringify({ accepted: true, mime: 'video/webm' }),
    }),
  )
const voiceRequest = (cookies, id) =>
  new Request(`http://localhost/api/voice?recording=${id}`, {
    headers: {
      cookie: `dfd_candidate=${cookies.dfd_candidate}; dfd_session=${
        cookies.dfd_session ?? ''
      }`,
    },
  })

test('interview: one attempt, terminal interruption and correct report facts', async (step) => {
  const recruiter = await signup('SingleInterview')
  const assessment = await approvedAssessment(recruiter)
  const candidate = await submittedCandidate(recruiter, assessment)
  const cookies = { ...recruiter, ...candidate.cookies }
  const media = await (await createRecording(cookies)).json()
  const request = voiceRequest(cookies, media.id)
  await step(
    'only one connection claims the interview, including simultaneous starts',
    async () => {
      eq(await candidateVoice.authorize(request), true)
      eq(candidateVoice.onStart(request), true)
      eq(candidateVoice.onStart(request), false)
      eq(await candidateVoice.authorize(request), false)
      eq((await createRecording(cookies)).status, 409)
      const enabled = labConfig.enabled
      labConfig.enabled = true
      try {
        eq(await voiceOptionsFor(request), undefined)
      } finally {
        labConfig.enabled = enabled
      }
    },
  )
  await step(
    'switching tabs is recorded without ending the active interview',
    async () => {
      await call('POST', '/api/candidate/integrity', {
        kind: 'page-leave',
        phase: 'interview',
        ms: 3000,
      }, cookies)
      eq(Candidate.require(candidate.candidateId).candidateFinishedAt, null)
    },
  )
  await step(
    'a dropped connection closes even an empty interview and cannot be resumed',
    async () => {
      candidateVoice.onFinish(request, [], false)
      const view = await (await call('GET', '/api/candidate/me', {}, cookies))
        .json()
      eq(!!view.finishedAt, true)
      eq(view.interviewInterrupted, true)
      eq(await candidateVoice.authorize(request), false)
      eq((await createRecording(cookies)).status, 409)
      const report = await (await call('GET', '/api/report', {
        candidate: candidate.candidateId,
      }, recruiter)).json()
      eq(report.facts.interviewCompleted, false)
      eq(report.facts.integrity.interrupted, true)
      candidateVoice.onFinish(request, [], true)
      const again = await (await call('GET', '/api/candidate/me', {}, cookies))
        .json()
      eq(again.interviewInterrupted, true)
      eq(again.finishedAt, view.finishedAt)
    },
  )
  await step(
    'a server restart also closes an attempt left active',
    async () => {
      const other = await submittedCandidate(recruiter, assessment)
      const otherMedia = await (await createRecording(other.cookies)).json()
      const otherRequest = voiceRequest(other.cookies, otherMedia.id)
      eq(candidateVoice.onStart(otherRequest), true)
      recoverInterruptedJobs()
      const view =
        await (await call('GET', '/api/candidate/me', {}, other.cookies)).json()
      eq([!!view.finishedAt, view.interviewInterrupted], [true, true])
      eq(await candidateVoice.authorize(otherRequest), false)
    },
  )
})
