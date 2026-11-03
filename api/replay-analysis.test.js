import { eq, test, throws } from '/api/lib/test.ts'
import { sql } from '@01edu/db'
import { llmConfig } from '/api/llm.ts'
import { Candidate } from '/api/schema.ts'
import {
  approvedAssessment,
  signup,
  submittedCandidate,
} from '/api/lib/journey-test.js'
import { handleRecording } from './recordings.ts'
import { parseReplayMoments, validateFrames } from './replay-analysis.ts'
import { frameTimes } from '/web/lib/replay-frames.ts'

const image = 'data:image/jpeg;base64,/9j/2Q=='
test('replay moments: ground positions, quotes and code; restrict image observations', async (step) => {
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
        source: 'transcript',
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
        [],
      )
      eq(result.length, 1)
      eq(result[0].atMs, 12000)
      eq(result[0].code, valid.code)
      eq(parseReplayMoments({ moments: [valid] }, report, 'other', []), [])
    },
  )
  await step(
    'visual wording cannot contain emotion, gaze or intent judgments',
    () => {
      const frames = [{ atMs: 5000, image }]
      const result = parseReplayMoments(
        {
          moments: [
            { source: 'image', kind: 'cheating', frameIndex: 0 },
            { source: 'image', kind: 'camera-obscured', frameIndex: 99 },
            {
              source: 'image',
              kind: 'camera-obscured',
              frameIndex: 0,
              title: 'Cheater',
              detail: 'Looks nervous',
              atMs: 99999,
            },
          ],
        },
        report,
        'r',
        frames,
      )
      eq(result.length, 1)
      eq(result[0].atMs, 5000)
      eq(result[0].title, 'Camera visibility to verify')
      eq(result[0].detail.includes('nervous'), false)
      eq(
        parseReplayMoments(
          {
            moments: [{
              source: 'image',
              kind: 'camera-obscured',
              frameIndex: 0,
            }],
          },
          report,
          'r',
          [],
        ),
        [],
      )
    },
  )
  await step(
    'sample count, sizes, formats and timeline bounds are enforced',
    () => {
      eq(frameTimes(1200000).length, 12)
      eq(frameTimes(0), [])
      eq(frameTimes(1000), [0])
      eq(validateFrames([{ atMs: 500, image }], 1000).length, 1)
      throws(() => validateFrames([{ atMs: 1001, image }], 1000))
      throws(() =>
        validateFrames(
          [{ atMs: 0, image: 'https://external.invalid/image' }],
          1000,
        )
      )
      throws(() =>
        validateFrames(
          Array.from({ length: 13 }, () => ({ atMs: 0, image })),
          1000,
        )
      )
      throws(() =>
        validateFrames([{ atMs: 0, image: image + 'A'.repeat(180000) }], 1000)
      )
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

test('replay analysis: consent, private access, multimodal request, caching and deletion', async (step) => {
  const member = await signup('ReplayAnalysis')
  const stranger = await signup('ReplayAnalysisOther')
  const assessment = await approvedAssessment(member)
  const { cookies, candidateId } = await submittedCandidate(member, assessment)
  const recordings = []
  for (const allowed of [false, true]) {
    const r = await (await send('POST', '/api/candidate/recording', cookies, {
      accepted: true,
      mime: 'video/webm',
      visualAnalysisAccepted: allowed,
    })).json()
    recordings.push(r)
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
  }
  const [legacy, visual] = recordings
  const endpoint = (id) =>
    `/api/recruiter/recording?candidate=${candidateId}&id=${id}&analysis=1`
  Candidate.update({
    candidateId,
    candidateFinishedAt: Date.now(),
    candidateInterview: [
      {
        who: 'candidate',
        text: 'I validate the protocol.',
        recordingId: visual.id,
        atMs: 12000,
      },
    ],
  })
  await step(
    'ownership, origin and consent are checked before any model request',
    async () => {
      eq((await send('GET', endpoint(visual.id), stranger)).status, 404)
      eq(
        (await send('POST', endpoint(visual.id), stranger, { frames: [] }))
          .status,
        404,
      )
      eq(
        (await send('POST', endpoint(legacy.id), member, {
          frames: [{ atMs: 5000, image }],
        })).status,
        403,
      )
      eq(
        (await send('POST', endpoint(visual.id), member, {
          frames: [{ atMs: 50000, image }],
        })).status,
        400,
      )
      const state = await (await send('GET', endpoint(legacy.id), member))
        .json()
      eq(state.visualAllowed, false)
      eq(state.status, 'idle')
    },
  )
  await step(
    'images reach only the model; results persist and cached requests do not call it again',
    async () => {
      const requests = []
      const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
        const body = await req.json()
        requests.push(body)
        return Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                moments: [
                  { source: 'image', kind: 'frame-unreadable', frameIndex: 0 },
                  {
                    source: 'transcript',
                    kind: 'point-to-check',
                    lineIndex: 0,
                    quote: 'validate the protocol',
                    title: 'Validation to verify',
                    detail: 'Compare with the implementation.',
                  },
                ],
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
        const response = await send('POST', endpoint(visual.id), member, {
          frames: [{ atMs: 5000, image }],
        })
        eq(response.status, 200)
        const result = await response.json()
        eq(result.status, 'ready')
        eq(result.moments.length, 2)
        eq(result.sampledAtMs, [5000])
        const user = requests[0].messages[1].content
        eq(user[1], { type: 'image_url', image_url: { url: image } })
        eq(user[0].text.includes('identity'), false)
        eq(user[0].text.includes('email'), false)
        const stored =
          sql`SELECT result FROM interviewReplayAnalysis WHERE recordingId = ?`
            .get(visual.id)
        eq(JSON.stringify(stored).includes(image), false)
        eq(
          (await (await send('GET', endpoint(visual.id), member)).json())
            .moments.length,
          2,
        )
        await send('POST', endpoint(visual.id), member, { frames: [] })
        eq(requests.length, 1)
        const textOnly = await send('POST', endpoint(legacy.id), member, {
          frames: [],
        })
        eq((await textOnly.json()).status, 'ready')
        eq(typeof requests[1].messages[1].content, 'string')
        eq(
          (await send(
            'DELETE',
            `/api/recruiter/recording?candidate=${candidateId}&id=${visual.id}`,
            member,
          )).status,
          200,
        )
        eq((await send('GET', endpoint(visual.id), member)).status, 404)
        eq(
          sql`SELECT COUNT(*) AS n FROM interviewReplayAnalysis WHERE recordingId = ?`
            .get(visual.id).n,
          0,
        )
      } finally {
        Object.assign(llmConfig, saved)
        await server.shutdown()
      }
    },
  )
})
