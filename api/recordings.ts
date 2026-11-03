// Private interview media. Binary uploads bypass the JSON route validator.
// Separate tables leave existing candidate databases compatible.
import { createTable, db, sql } from '@01edu/db'
import { Assessment, Candidate } from '/api/schema.ts'
import { findCandidate } from '/api/candidate.ts'
import { decodeSession } from '/api/member.ts'
import { json } from '/api/assessment.ts'
import type { Progress, RecordingView } from '/web/types.ts'

const Recording = createTable('interviewRecording', {
  recordingRowId: { type: 'INTEGER', primary: true },
  recordingId: { type: 'TEXT' },
  candidateId: { type: 'INTEGER', join: Candidate },
  mime: { type: 'TEXT' },
  createdAt: { type: 'REAL' },
  expiresAt: { type: 'REAL' },
  durationMs: { type: 'REAL' },
  bytes: { type: 'INTEGER' },
  nextSequence: { type: 'INTEGER' },
  status: { type: 'TEXT' },
})
createTable('interviewRecordingChunk', {
  chunkId: { type: 'INTEGER', primary: true },
  recordingId: { type: 'TEXT' },
  sequence: { type: 'INTEGER' },
  data: { type: 'BLOB' },
})
sql`CREATE UNIQUE INDEX IF NOT EXISTS recording_chunk_sequence
  ON interviewRecordingChunk(recordingId, sequence)`.run()
sql`CREATE UNIQUE INDEX IF NOT EXISTS recording_public_id
  ON interviewRecording(recordingId)`.run()

const DAY = 86_400_000
export const RECORDING_TTL = 30 * DAY
export const MAX_CHUNK = 2 * 1024 * 1024
export const MAX_RECORDING = 100 * 1024 * 1024
const MAX_DURATION = 20 * 60_000
const MIME = new Set([
  'video/webm',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/mp4',
  'video/mp4;codecs=avc1.424028,mp4a.40.2',
])

const fail = (status: number, message: string): never => {
  throw Response.json({ error: message }, { status })
}
const getRecording = sql<ReturnType<typeof Recording.require>, string>`
  SELECT * FROM interviewRecording WHERE recordingId = ?`.get
const countRecordings = sql<{ count: number }, number>`
  SELECT COUNT(*) AS count FROM interviewRecording WHERE candidateId = ?`.get
const listRecordings = sql<
  ReturnType<typeof Recording.require>,
  { candidateId: number; now: number }
>`
  SELECT * FROM interviewRecording WHERE candidateId = :candidateId
  AND expiresAt > :now ORDER BY createdAt`.all
const chunkAt =
  sql<{ data: Uint8Array }, { recordingId: string; sequence: number }>`
  SELECT data FROM interviewRecordingChunk
  WHERE recordingId = :recordingId AND sequence = :sequence`.get
const requireRecording = (id: string) =>
  getRecording(id) ?? fail(404, 'Recording not found.')
const cookie = (req: Request, name: string) =>
  req.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
    ?.[1]

const viewOf = (r: ReturnType<typeof Recording.require>): RecordingView => ({
  id: r.recordingId,
  mime: r.mime,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  durationMs: r.durationMs,
  bytes: r.bytes,
  status: r.status as RecordingView['status'],
})

export const purgeRecordings = (now = Date.now()) => {
  db.transaction(() => {
    sql<never, number>`DELETE FROM interviewRecordingChunk WHERE recordingId IN
      (SELECT recordingId FROM interviewRecording WHERE expiresAt <= ?)`
      .run(now)
    sql<never, number>`DELETE FROM interviewRecording WHERE expiresAt <= ?`.run(
      now,
    )
  })()
}

export const activeRecording = (candidateId: number, recordingId: string) => {
  const r = getRecording(recordingId)
  return r && r.candidateId === candidateId && r.expiresAt > Date.now() &&
      r.status === 'recording' && Date.now() - r.createdAt < MAX_DURATION
    ? viewOf(r)
    : undefined
}

const readBytes = async (req: Request) => {
  if (!req.body) fail(400, 'A recording chunk is required.')
  const reader = req.body!.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_CHUNK) {
        await reader.cancel()
        fail(413, 'Recording chunk is too large.')
      }
      parts.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (!size) fail(400, 'Empty recording chunk.')
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

const readJson = async (req: Request): Promise<Record<string, unknown>> => {
  // Small control messages have the same bounded reader as binary uploads.
  const bytes = await readBytes(req)
  if (bytes.length > 1024) fail(413, 'Control message is too large.')
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error()
    return body
  } catch {
    return fail(400, 'Invalid recording request.')
  }
}

const upload = async (req: Request, url: URL) => {
  const c = findCandidate(cookie(req, 'dfd_candidate'))
  if (c.candidateRevokedAt) fail(403, 'The invitation was revoked.')
  const recordingId = url.searchParams.get('id') ?? ''
  if (req.method === 'POST' && !recordingId) {
    if (
      c.candidateFinishedAt || !c.candidateSubmittedAt ||
      json<Progress>(c.candidatePreparation)?.steps.at(-1)?.state !== 'done'
    ) {
      fail(409, 'The interview is not ready for recording.')
    }
    const body = await readJson(req)
    if (body.accepted !== true) fail(400, 'Recording agreement is required.')
    if (typeof body.mime !== 'string' || !MIME.has(body.mime)) {
      fail(400, 'Unsupported recording format.')
    }
    const count = countRecordings(c.candidateId)!
    if (count.count >= 5) {
      fail(409, 'Recording attempt limit reached. Contact the recruiter.')
    }
    const now = Date.now()
    const recordingId = crypto.randomUUID()
    Recording.insert({
      recordingId,
      candidateId: c.candidateId,
      mime: body.mime as string,
      createdAt: now,
      expiresAt: now + RECORDING_TTL,
      durationMs: 0,
      bytes: 0,
      nextSequence: 0,
      status: 'recording',
    })
    return Response.json(viewOf(requireRecording(recordingId)))
  }
  const r = getRecording(recordingId)
  if (!r || r.candidateId !== c.candidateId || r.expiresAt <= Date.now()) {
    fail(404, 'Recording not found.')
  }
  if (req.method === 'PUT') {
    // Final chunks may arrive after Oracle marks the interview finished.
    if (r!.status !== 'recording' || Date.now() - r!.createdAt > MAX_DURATION) {
      fail(409, 'This recording is closed.')
    }
    const sequence = Number(url.searchParams.get('sequence'))
    if (
      !url.searchParams.has('sequence') || !Number.isSafeInteger(sequence) ||
      sequence < 0
    ) {
      fail(400, 'Invalid recording sequence.')
    }
    const bytes = await readBytes(req)
    db.transaction(() => {
      const current = requireRecording(recordingId)
      if (current.status !== 'recording') fail(409, 'This recording is closed.')
      if (sequence < current.nextSequence) {
        const old = chunkAt({ recordingId, sequence })!
        if (
          old.data.length !== bytes.length ||
          old.data.some((v, i) => v !== bytes[i])
        ) {
          fail(409, 'Recording retry differs from the saved chunk.')
        }
        return
      }
      if (sequence !== current.nextSequence) {
        fail(409, 'Recording chunks must arrive in order.')
      }
      if (current.bytes + bytes.length > MAX_RECORDING) {
        fail(413, 'Recording size limit reached.')
      }
      sql<never, { recordingId: string; sequence: number; bytes: Uint8Array }>`
        INSERT INTO interviewRecordingChunk(recordingId, sequence, data)
        VALUES (:recordingId, :sequence, :bytes)`.run({
        recordingId,
        sequence,
        bytes,
      })
      sql<never, { recordingId: string; bytes: number }>`
        UPDATE interviewRecording SET bytes = bytes + :bytes,
        nextSequence = nextSequence + 1 WHERE recordingId = :recordingId`
        .run({ recordingId, bytes: bytes.length })
    })()
    return Response.json({ saved: true })
  }
  if (req.method === 'POST') {
    const body = await readJson(req)
    if (
      typeof body.durationMs !== 'number' ||
      !Number.isFinite(body.durationMs) ||
      body.durationMs < 0 || body.durationMs > MAX_DURATION
    ) fail(400, 'Invalid duration.')
    if (body.status !== 'complete' && body.status !== 'interrupted') {
      fail(400, 'Invalid recording status.')
    }
    if (r!.status !== 'recording') return Response.json(viewOf(r!))
    sql<never, { recordingId: string; durationMs: number; status: string }>`
      UPDATE interviewRecording SET durationMs = :durationMs,
      status = :status WHERE recordingId = :recordingId`
      .run({
        recordingId,
        durationMs: body.durationMs as number,
        status: body.status as string,
      })
    return Response.json(viewOf(requireRecording(recordingId)))
  }
  return fail(405, 'Method not allowed.')
}

const replay = async (req: Request, url: URL) => {
  const session = await decodeSession(cookie(req, 'dfd_session'))
  if (!session) fail(401, 'Sign-in required.')
  const candidateId = Number(url.searchParams.get('candidate'))
  const c = Number.isSafeInteger(candidateId)
    ? Candidate.get(candidateId)
    : undefined
  if (!c || Assessment.get(c.assessmentId)?.companyId !== session!.companyId) {
    fail(404, 'Candidate not found.')
  }
  const recordingId = url.searchParams.get('id')
  if (!recordingId && req.method === 'GET') {
    const rows = listRecordings({ candidateId, now: Date.now() })
    return Response.json(rows.map(viewOf))
  }
  const r = recordingId ? getRecording(recordingId) : undefined
  if (!r || r.candidateId !== candidateId || r.expiresAt <= Date.now()) {
    fail(404, 'Recording not found.')
  }
  if (req.method === 'DELETE') {
    db.transaction(() => {
      sql<
        never,
        string
      >`DELETE FROM interviewRecordingChunk WHERE recordingId = ?`
        .run(recordingId!)
      sql<never, string>`DELETE FROM interviewRecording WHERE recordingId = ?`
        .run(recordingId!)
    })()
    return Response.json({ deleted: true })
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fail(405, 'Method not allowed.')
  }
  const size = r!.bytes
  let start = 0
  let end = size - 1
  const range = req.headers.get('range')
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match || (!match[1] && !match[2])) {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${size}` },
      })
    }
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
    end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
    if (
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start > end || start >= size
    ) {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${size}` },
      })
    }
  }
  const headers = new Headers({
    'content-type': r!.mime,
    'content-length': String(Math.max(0, end - start + 1)),
    'accept-ranges': 'bytes',
  })
  if (range) headers.set('content-range', `bytes ${start}-${end}/${size}`)
  // Load only one bounded chunk per pull, rather than materializing the video.
  let offset = 0
  let sequence = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      for (;;) {
        const part = chunkAt({
          recordingId: recordingId!,
          sequence: sequence++,
        })
        if (!part || offset > end) return controller.close()
        const from = Math.max(0, start - offset)
        const to = Math.min(part.data.length, end - offset + 1)
        offset += part.data.length
        if (to > from) {
          controller.enqueue(part.data.slice(from, to))
          return
        }
      }
    },
  })
  return new Response(req.method === 'HEAD' ? null : body, {
    status: range ? 206 : 200,
    headers,
  })
}

export const handleRecording = async (req: Request): Promise<Response> => {
  try {
    const url = new URL(req.url)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.get('origin')
      let originHost: string | undefined
      try {
        originHost = origin ? new URL(origin).host : undefined
      } catch { /* malformed origins are refused too */ }
      if (!originHost || originHost !== url.host) {
        fail(403, 'Origin not allowed.')
      }
    }
    purgeRecordings()
    const response = await (url.pathname === '/api/candidate/recording'
      ? upload(req, url)
      : replay(req, url))
    response.headers.set('cache-control', 'private, no-store')
    response.headers.set('x-content-type-options', 'nosniff')
    return response
  } catch (err) {
    if (err instanceof Response) return err
    // Existing candidate authentication uses the API's response errors.
    if (
      err && typeof err === 'object' && 'response' in err &&
      err.response instanceof Response
    ) return err.response
    return Response.json({ error: 'Recording request failed.' }, {
      status: 500,
    })
  }
}
