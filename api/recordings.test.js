import { eq, test } from '/api/lib/test.ts'
import { sql } from '@01edu/db'
import {
  approvedAssessment,
  call,
  cookieOf,
  signup,
  submittedCandidate,
} from '/api/lib/journey-test.js'
import {
  handleRecording,
  MAX_CHUNK,
  purgeRecordings,
  RECORDING_TTL,
} from '/api/recordings.ts'
import { candidateVoice } from '/api/interview.ts'
import { Candidate } from '/api/schema.ts'

const send = (method, path, cookies = {}, body, headers = {}) =>
  handleRecording(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        origin: 'http://localhost',
        cookie: Object.entries(cookies).map(([key, value]) => `${key}=${value}`)
          .join('; '),
        ...headers,
      },
      body: body instanceof Uint8Array
        ? body
        : body === undefined
        ? undefined
        : JSON.stringify(body),
    }),
  )

test('recording: consent, ordered uploads, private ranges and deletion', async (step) => {
  const member = await signup('Recordings')
  const otherMember = await signup('OtherRecordingCompany')
  const assessment = await approvedAssessment(member)
  const { cookies, candidateId } = await submittedCandidate(member, assessment)
  const other = await submittedCandidate(member, assessment)
  let recording
  const path = '/api/candidate/recording'
  const replay = `/api/recruiter/recording?candidate=${candidateId}`

  await step('camera recording agreement and origin are enforced', async () => {
    eq(
      (await send('POST', path, {}, { accepted: true, mime: 'video/webm' }))
        .status,
      401,
    )
    eq(
      (await send(
        'POST',
        path,
        cookies,
        { accepted: true, mime: 'video/webm' },
        { origin: 'null' },
      )).status,
      403,
    )
    eq((await send('POST', path, cookies, { mime: 'video/webm' })).status, 400)
    eq(
      (await send('POST', path, cookies, { accepted: true, mime: 'text/html' }))
        .status,
      400,
    )
    eq(
      (await send(
        'POST',
        path,
        cookies,
        { accepted: true, mime: 'video/webm' },
        { origin: 'http://evil.invalid' },
      )).status,
      403,
    )
    const response = await send('POST', path, cookies, {
      accepted: true,
      mime: 'video/webm;codecs=vp8,opus',
    })
    eq(response.status, 200)
    recording = await response.json()
    eq(recording.expiresAt - recording.createdAt, RECORDING_TTL)
    eq(recording.status, 'recording')
    const headers = { cookie: `dfd_candidate=${cookies.dfd_candidate}` }
    eq(
      await candidateVoice.authorize(
        new Request('http://localhost/api/voice', { headers }),
      ),
      false,
    )
    eq(
      await candidateVoice.authorize(
        new Request(`http://localhost/api/voice?recording=${recording.id}`, {
          headers,
        }),
      ),
      true,
    )
  })
  await step(
    'ordered chunks can be retried but not replaced or appended by another candidate',
    async () => {
      const upload = `${path}?id=${recording.id}`
      eq(
        (await send(
          'PUT',
          `${upload}&sequence=1`,
          cookies,
          new Uint8Array([9]),
        )).status,
        409,
      )
      eq(
        (await send(
          'PUT',
          `${upload}&sequence=0`,
          other.cookies,
          new Uint8Array([9]),
        )).status,
        404,
      )
      eq(
        (await send(
          'PUT',
          `${upload}&sequence=0`,
          cookies,
          new Uint8Array([1, 2, 3]),
        )).status,
        200,
      )
      eq(
        (await send(
          'PUT',
          `${upload}&sequence=0`,
          cookies,
          new Uint8Array([1, 2, 3]),
        )).status,
        200,
      )
      eq(
        (await send(
          'PUT',
          `${upload}&sequence=0`,
          cookies,
          new Uint8Array([4]),
        )).status,
        409,
      )
      eq(
        (await send(
          'PUT',
          `${upload}&sequence=1`,
          cookies,
          new Uint8Array(MAX_CHUNK + 1),
        )).status,
        413,
      )
      eq(
        (await send(
          'PUT',
          `${upload}&sequence=1`,
          cookies,
          new Uint8Array([4, 5, 6]),
        )).status,
        200,
      )
      eq(
        (await send('POST', upload, cookies, {
          status: 'complete',
          durationMs: 4000,
        })).status,
        200,
      )
      eq(
        (await send(
          'PUT',
          `${upload}&sequence=2`,
          cookies,
          new Uint8Array([7]),
        )).status,
        409,
      )
    },
  )
  await step(
    'replay belongs to the company and supports seeking across chunk boundaries',
    async () => {
      const media = `${replay}&id=${recording.id}`
      eq((await send('GET', media)).status, 401)
      eq((await send('GET', media, otherMember)).status, 404)
      eq((await send('GET', media, cookies)).status, 401)
      eq(
        (await send(
          'GET',
          `${replay}&id=${encodeURIComponent("' OR 1=1 --")}`,
          member,
        )).status,
        404,
      )
      const list = await (await send('GET', replay, member)).json()
      eq([list.length, list[0].bytes, list[0].status], [1, 6, 'complete'])
      const response = await send('GET', media, member, undefined, {
        range: 'bytes=2-4',
      })
      eq(response.status, 206)
      eq(response.headers.get('content-range'), 'bytes 2-4/6')
      eq(response.headers.get('cache-control'), 'private, no-store')
      eq([...new Uint8Array(await response.arrayBuffer())], [3, 4, 5])
      const suffix = await send('GET', media, member, undefined, {
        range: 'bytes=-2',
      })
      eq([...new Uint8Array(await suffix.arrayBuffer())], [5, 6])
      const head = await send('HEAD', media, member)
      eq(head.headers.get('content-length'), '6')
      eq(await head.text(), '')
      eq(
        (await send('GET', media, member, undefined, { range: 'bytes=6-' }))
          .status,
        416,
      )
      eq(
        (await send('GET', media, member, undefined, {
          range: 'bytes=0-1,3-4',
        })).status,
        416,
      )
      const full = await send('GET', media, member)
      eq([...new Uint8Array(await full.arrayBuffer())], [1, 2, 3, 4, 5, 6])
      eq((await send('DELETE', media, otherMember)).status, 404)
      eq((await send('DELETE', media, member)).status, 200)
      eq((await send('GET', media, member)).status, 404)
    },
  )
  await step('expired recordings and their media are purged', async () => {
    const response = await send('POST', path, cookies, {
      accepted: true,
      mime: 'video/webm',
    })
    const expired = await response.json()
    await send(
      'PUT',
      `${path}?id=${expired.id}&sequence=0`,
      cookies,
      new Uint8Array([8]),
    )
    purgeRecordings(expired.expiresAt + 1)
    eq((await send('GET', `${replay}&id=${expired.id}`, member)).status, 404)
    eq(await (await send('GET', replay, member)).json(), [])
  })
  await step(
    'the final chunk can save after Oracle finishes, but a new attempt cannot start',
    async () => {
      const last = await (await send('POST', path, cookies, {
        accepted: true,
        mime: 'video/webm',
      })).json()
      Candidate.update({ candidateId, candidateFinishedAt: Date.now() })
      eq(
        (await send('POST', path, cookies, {
          accepted: true,
          mime: 'video/webm',
        })).status,
        409,
      )
      eq(
        (await send(
          'PUT',
          `${path}?id=${last.id}&sequence=0`,
          cookies,
          new Uint8Array([1]),
        )).status,
        200,
      )
      eq(
        (await send('POST', `${path}?id=${last.id}`, cookies, {
          status: 'complete',
          durationMs: 1000,
        })).status,
        200,
      )
    },
  )
})

test('demo recordings: private to the login session that invited the candidate', async (step) => {
  const previous = Deno.env.get('DEMO_ACCESS')
  Deno.env.set('DEMO_ACCESS', '1')
  try {
    const signIn = async () => ({
      dfd_session: cookieOf(
        await call('POST', '/api/demo/session'),
        'dfd_session',
      ),
    })
    const owner = await signIn()
    const visitor = await signIn()
    const { id } = await (await call('POST', '/api/demo/assessment', {}, owner))
      .json()
    const { cookies, candidateId, invitation } = await submittedCandidate(
      owner,
      id,
    )
    const path = '/api/candidate/recording'
    const info = await (await send('POST', path, cookies, {
      accepted: true,
      mime: 'video/webm',
    })).json()
    await send(
      'PUT',
      `${path}?id=${info.id}&sequence=0`,
      cookies,
      new Uint8Array([1, 2, 3]),
    )
    await send('POST', `${path}?id=${info.id}`, cookies, {
      status: 'complete',
      durationMs: 1000,
    })
    const listing = `/api/recruiter/recording?candidate=${candidateId}`
    const media = `${listing}&id=${info.id}`
    await step(
      'the inviting session can list and play its own recording',
      async () => {
        const rows = await (await send('GET', listing, owner)).json()
        eq(rows.map((r) => r.id), [info.id])
        const response = await send('GET', media, owner)
        eq(response.status, 200)
        eq([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3])
      },
    )
    await step(
      'another public demo login cannot list, stream, inspect or delete it',
      async () => {
        eq(await (await send('GET', listing, visitor)).json(), [])
        for (const method of ['GET', 'HEAD', 'DELETE']) {
          eq((await send(method, media, visitor)).status, 404)
        }
        eq(
          (await send('GET', media, visitor, undefined, { range: 'bytes=0-1' }))
            .status,
          404,
        )
        eq((await send('HEAD', media, owner)).status, 200)
        eq((await send('GET', `${media}&analysis=1`, visitor)).status, 404)
        eq(
          (await send('POST', `${media}&analysis=1`, visitor, { frames: [] }))
            .status,
          404,
        )
      },
    )
    await step(
      'legacy demo videos without a provable owner are hidden too',
      async () => {
        sql`DELETE FROM interviewRecordingOwner WHERE candidateId = ${candidateId}`
          .run()
        eq(await (await send('GET', listing, owner)).json(), [])
        eq((await send('GET', media, owner)).status, 404)
        eq((await send('DELETE', media, owner)).status, 404)
      },
    )
    await step(
      'legacy recovery requires the actual completed candidate session',
      async () => {
        Candidate.update({ candidateId, candidateFinishedAt: Date.now() })
        const claim = `${listing}&claim=1`
        eq((await send('POST', claim, visitor)).status, 404)
        eq(
          (await call('POST', '/api/candidate/start', { invitation }, visitor))
            .status,
          409,
        )
        const other = await submittedCandidate(visitor, id)
        eq(
          (await send('POST', claim, { ...visitor, ...other.cookies })).status,
          404,
        )
        eq((await send('POST', claim, { ...owner, ...cookies })).status, 200)
        const replay = await send('GET', media, owner)
        eq(replay.status, 200)
        eq([...new Uint8Array(await replay.arrayBuffer())], [1, 2, 3])
        eq((await send('POST', claim, { ...visitor, ...cookies })).status, 404)
        eq((await send('GET', media, visitor)).status, 404)
      },
    )
    await step(
      'starting a recording on an older invitation binds ownership without exposing it',
      async () => {
        const older = await submittedCandidate(owner, id)
        sql`DELETE FROM interviewRecordingOwner WHERE candidateId = ${older.candidateId}`
          .run()
        const response = await send('POST', path, {
          ...owner,
          ...older.cookies,
        }, { accepted: true, mime: 'video/webm' })
        eq(response.status, 200)
        const list = `/api/recruiter/recording?candidate=${older.candidateId}`
        eq((await (await send('GET', list, owner)).json()).length, 1)
        eq(await (await send('GET', list, visitor)).json(), [])
      },
    )
    await step('signing out ends access even with the old cookie', async () => {
      eq((await call('POST', '/api/logout', {}, owner)).status, 204)
      eq((await send('GET', listing, owner)).status, 401)
    })
  } finally {
    if (previous === undefined) Deno.env.delete('DEMO_ACCESS')
    else Deno.env.set('DEMO_ACCESS', previous)
  }
})
