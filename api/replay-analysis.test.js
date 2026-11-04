import { eq, test } from '/api/lib/test.ts'
import { sql } from '@01edu/db'
import { llmConfig } from '/api/llm.ts'
import { Candidate } from '/api/schema.ts'
import {
  approvedAssessment,
  signup,
  submittedCandidate,
} from '/api/lib/journey-test.js'
import { handleRecording } from './recordings.ts'
import { parseReplayMoments } from './replay-analysis.ts'

test('replay moments: grounded in the transcript, the quotes and the code', async (step) => {
  const report = {
    transcript: [{
      who: 'candidate',
      text: 'I validate the protocol.',
      recordingId: 'r',
      atMs: 12000,
    }],
    files: { 'src/app.ts': 'const x = 1\nexport { x }' },
  }
  await step(
    'timestamps come from evidence, invented quotes and other recordings are rejected',
    () => {
      const valid = {
        kind: 'point-to-check',
        lineIndex: 0,
        quote: 'validate the protocol',
        title: 'Validation to verify',
        detail: 'Compare this explanation with the code.',
        atMs: 999999,
        code: { path: 'src/app.ts', from: 1, to: 2 },
      }
      const result = parseReplayMoments(
        {
          moments: [valid, { ...valid, quote: 'invented' }, {
            ...valid,
            lineIndex: 99,
          }, { ...valid, title: 'Suspicious cheating' }],
        },
        report,
        'r',
      )
      eq(result.length, 1)
      eq(result[0].atMs, 12000)
      eq(result[0].code, valid.code)
      eq(parseReplayMoments({ moments: [valid] }, report, 'other'), [])
    },
  )
  await step(
    'the word filter drops judgments of the person, never words about code',
    () => {
      const keep = (detail) =>
        parseReplayMoments(
          {
            moments: [{
              kind: 'point-to-check',
              lineIndex: 0,
              quote: 'validate the protocol',
              title: 'Validation to verify',
              detail,
            }],
          },
          report,
          'r',
        ).length === 1
      for (
        const detail of [
          'The error message is not checked in src/app.ts.',
          'A stack trace would show where the request fails.',
          'The health check route returns 200 before validation.',
          'Read the next page of results.',
          'Two writes could cause a race condition.',
          'The underlying store is a Map.',
          'Ask how the average latency was measured.',
          'A data race on the shared Map is possible.',
          'Cache-Control max-age is not set.',
        ]
      ) eq([detail, keep(detail)], [detail, true])
      for (
        const detail of [
          'The candidate looks nervous here.',
          'The candidate is confident about the cache.',
          'Their age may matter.',
          'Mentions a health issue.',
          'A racial remark.',
          'The candidate may be lying.',
          'He seems 40 years old.',
          'Avoids eye contact.',
        ]
      ) eq([detail, keep(detail)], [detail, false])
    },
  )
})

const send = (method, path, cookies, body) =>
  handleRecording(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        origin: 'http://localhost',
        cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: body instanceof Uint8Array
        ? body
        : body === undefined
        ? undefined
        : JSON.stringify(body),
    }),
  )

test('replay analysis: private access, text-only request, caching and deletion', async (step) => {
  const member = await signup('ReplayAnalysis')
  const stranger = await signup('ReplayAnalysisOther')
  const assessment = await approvedAssessment(member)
  const { cookies, candidateId } = await submittedCandidate(member, assessment)
  const r = await (await send('POST', '/api/candidate/recording', cookies, {
    accepted: true,
    mime: 'video/webm',
  })).json()
  eq(
    (await send(
      'PUT',
      `/api/candidate/recording?id=${r.id}&sequence=0`,
      cookies,
      new Uint8Array([1]),
    )).status,
    200,
  )
  eq(
    (await send('POST', `/api/candidate/recording?id=${r.id}`, cookies, {
      status: 'complete',
      durationMs: 20000,
    })).status,
    200,
  )
  const endpoint =
    `/api/recruiter/recording?candidate=${candidateId}&id=${r.id}&analysis=1`
  Candidate.update({
    candidateId,
    candidateFinishedAt: Date.now(),
    candidateInterview: [
      {
        who: 'candidate',
        text: 'I validate the protocol.',
        recordingId: r.id,
        atMs: 12000,
      },
    ],
  })
  await step(
    'another company sees nothing, before any model request',
    async () => {
      eq((await send('GET', endpoint, stranger)).status, 404)
      eq((await send('POST', endpoint, stranger)).status, 404)
      eq((await (await send('GET', endpoint, member)).json()).status, 'idle')
      // without a key, the answer says so; with one, other failures do not
      const saved = { key: llmConfig.key, open: llmConfig.open.key }
      llmConfig.key = ''
      llmConfig.open.key = ''
      const noKey = await send('POST', endpoint, member)
      Object.assign(llmConfig, { key: saved.key })
      llmConfig.open.key = saved.open
      eq(noKey.status, 503)
      eq((await noKey.json()).error.includes('API key'), true)
    },
  )
  await step(
    'the model gets text only; the result persists, a second request does not call it again',
    async () => {
      const requests = []
      const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
        requests.push(await req.json())
        return Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                moments: [{
                  kind: 'point-to-check',
                  lineIndex: 0,
                  quote: 'validate the protocol',
                  title: 'Validation to verify',
                  detail: 'Compare with the implementation.',
                }],
              }),
            },
            finish_reason: 'stop',
          }],
          usage: {},
        })
      })
      const saved = { ...llmConfig }
      Object.assign(llmConfig, {
        key: 'local-test',
        baseUrl: `http://localhost:${server.addr.port}/v1`,
        fallback: '',
        retries: 0,
      })
      try {
        const response = await send('POST', endpoint, member)
        eq(response.status, 200)
        const result = await response.json()
        eq(result.status, 'ready')
        eq(result.moments.length, 1)
        const user = requests[0].messages[1].content
        eq(typeof user, 'string')
        eq(user.includes('identity'), false)
        eq(user.includes('email'), false)
        eq(
          (await (await send('GET', endpoint, member)).json()).moments.length,
          1,
        )
        await send('POST', endpoint, member)
        eq(requests.length, 1)
        eq(
          (await send(
            'DELETE',
            `/api/recruiter/recording?candidate=${candidateId}&id=${r.id}`,
            member,
          )).status,
          200,
        )
        eq((await send('GET', endpoint, member)).status, 404)
        eq(
          sql`SELECT COUNT(*) AS n FROM interviewReplayMoments WHERE recordingId = ?`
            .get(r.id).n,
          0,
        )
      } finally {
        Object.assign(llmConfig, saved)
        await server.shutdown()
      }
    },
  )
})
