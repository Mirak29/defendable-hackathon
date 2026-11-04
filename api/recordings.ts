// Private interview media. Binary uploads bypass the JSON route validator.
// Separate tables leave existing candidate databases compatible.
import { createTable, db, sql } from '@01edu/db'
import { Assessment, Candidate, demoCompanyId } from '/api/schema.ts'
import { findCandidate } from '/api/candidate.ts'
import { decodeSession, type MemberSession } from '/api/member.ts'
import { json } from '/api/assessment.ts'
import type { Progress, RecordingView } from '/web/types.ts'
import { reportView } from '/api/report.ts'
import { hasAiKey } from '/api/llm.ts'
import {
  analyzeReplay,
  deleteReplayAnalysis,
  purgeReplayAnalyses,
  readReplayAnalysis,
} from '/api/replay-analysis.ts'

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
// The public demo member is shared. Media belongs to the login that invited
// this candidate, not to every visitor using that member account.
const RecordingOwner = createTable('interviewRecordingOwner', {
  ownerRowId: { type: 'INTEGER', primary: true },
  candidateId: { type: 'INTEGER', join: Candidate },
  memberSessionId: { type: 'INTEGER' },
})
sql`CREATE UNIQUE INDEX IF NOT EXISTS recording_owner_candidate
  ON interviewRecordingOwner(candidateId)`.run()
const ownerOf = RecordingOwner.sql<'memberSessionId', number>`
  SELECT memberSessionId FROM interviewRecordingOwner WHERE candidateId = ?
`.get

export const bindDemoRecordingOwner = (
  candidateId: number,
  session: MemberSession,
) => {
  if (session.companyId !== demoCompanyId) return
  RecordingOwner.insert({ candidateId, memberSessionId: session.entryId })
}
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
// Sizes only: SQLite reads a BLOB's length from its header, not its content.
const chunkSizes = sql<{ sequence: number; size: number }, string>`
  SELECT sequence, length(data) AS size FROM interviewRecordingChunk
  WHERE recordingId = ? ORDER BY sequence`.all
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

// Expired rows are already refused by every query (expiresAt), so deleting them
// once a minute is enough; per request it took the write lock on each chunk.
let purgedAt = 0
const purgeAtMostEveryMinute = () => {
  const now = Date.now()
  if (now - purgedAt < 60_000) return
  purgedAt = now
  purgeRecordings(now)
}

/** after the interview ends, the last chunks have this long to arrive */
export const FINAL_UPLOAD_MS = 5 * 60_000

/**
 * The browser records one chunk every 2 s (`recorder.start(2000)` in
 * web/lib/interview-recording.ts): the chunks received tell how long the video
 * that reached the server is.
 */
const CHUNK_MS = 2000

/**
 * A browser that closed, crashed or lost the connection never sends the final
 * POST: its recording would stay "recording" forever (no seeking, no key
 * moments). Close it as interrupted once the interview has ended, or once no
 * chunk can be accepted any more. Its duration is what reached the server,
 * never longer than the interview itself.
 */
export const closeAbandonedRecordings = (now = Date.now()) => {
  const stale = sql<
    {
      recordingId: string
      createdAt: number
      chunks: number
      finishedAt: number | null
    },
    { finished: number; open: number }
  >`
    SELECT r.recordingId, r.createdAt, r.nextSequence AS chunks,
      c.candidateFinishedAt AS finishedAt
    FROM interviewRecording r JOIN candidate c ON c.candidateId = r.candidateId
    WHERE r.status = 'recording' AND (r.createdAt <= :open
      OR (c.candidateFinishedAt IS NOT NULL
        AND c.candidateFinishedAt <= :finished))`
    .all({ finished: now - FINAL_UPLOAD_MS, open: now - MAX_DURATION })
  for (const r of stale) {
    const interview = r.finishedAt && r.finishedAt > r.createdAt
      ? r.finishedAt - r.createdAt
      : MAX_DURATION
    sql<never, { recordingId: string; durationMs: number }>`
      UPDATE interviewRecording SET status = 'interrupted',
      durationMs = :durationMs WHERE recordingId = :recordingId
      AND status = 'recording'`.run({
      recordingId: r.recordingId,
      durationMs: Math.min(MAX_DURATION, interview, r.chunks * CHUNK_MS),
    })
  }
}

export const purgeRecordings = (now = Date.now()) => {
  closeAbandonedRecordings(now)
  db.transaction(() => {
    sql<never, number>`DELETE FROM interviewRecordingChunk WHERE recordingId IN
      (SELECT recordingId FROM interviewRecording WHERE expiresAt <= ?)`
      .run(now)
    sql<never, number>`DELETE FROM interviewRecording WHERE expiresAt <= ?`.run(
      now,
    )
    purgeReplayAnalyses()
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
      c.candidateFinishedAt || c.candidateInterviewStartedAt ||
      !c.candidateSubmittedAt ||
      json<Progress>(c.candidatePreparation)?.steps.at(-1)?.state !== 'done'
    ) {
      fail(409, 'The interview is not ready for recording.')
    }
    const body = await readJson(req)
    if (body.accepted !== true) fail(400, 'Recording agreement is required.')
    if (typeof body.mime !== 'string' || !MIME.has(body.mime)) {
      fail(400, 'Unsupported recording format.')
    }
    const demo = Assessment.require(c.assessmentId).companyId === demoCompanyId
    const recruiter = demo
      ? await decodeSession(cookie(req, 'dfd_session'))
      : undefined
    const recordingId = crypto.randomUUID()
    // count and insert together: two starts at once cannot pass the limit
    db.transaction(() => {
      const count = countRecordings(c.candidateId)!
      if (count.count >= 5) {
        fail(409, 'Recording attempt limit reached. Contact the recruiter.')
      }
      // An invitation can predate demo isolation. The browser actually
      // recording the interview can establish ownership, but never replace
      // an existing owner.
      if (
        demo && !ownerOf(c.candidateId) &&
        recruiter?.companyId === demoCompanyId
      ) bindDemoRecordingOwner(c.candidateId, recruiter)
      const now = Date.now()
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
    })()
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
  if (req.method === 'POST' && url.searchParams.get('claim') === '1') {
    if (session!.companyId !== demoCompanyId || recordingId) {
      fail(405, 'Method not allowed.')
    }
    db.transaction(() => {
      const owner = ownerOf(candidateId)
      if (owner) {
        if (owner.memberSessionId !== session!.entryId) {
          fail(404, 'Recording not found.')
        }
        return
      }
      // A completed interview's secret candidate cookie proves participation.
      // Its public invitation alone must never grant access to old videos.
      let subject
      try {
        subject = findCandidate(cookie(req, 'dfd_candidate'))
      } catch { /* no proof */ }
      if (
        !c!.candidateFinishedAt || subject?.candidateId !== candidateId ||
        !listRecordings({ candidateId, now: Date.now() }).some((r) =>
          r.bytes > 0
        )
      ) {
        fail(404, 'Recording not found.')
      }
      bindDemoRecordingOwner(candidateId, session!)
    })()
    return Response.json({ claimed: true })
  }
  if (
    session!.companyId === demoCompanyId &&
    ownerOf(candidateId)?.memberSessionId !== session!.entryId
  ) {
    // Old demo recordings have no safe owner to infer. Hide those too.
    if (!recordingId && req.method === 'GET') return Response.json([])
    fail(404, 'Recording not found.')
  }
  if (!recordingId && req.method === 'GET') {
    const rows = listRecordings({ candidateId, now: Date.now() })
    return Response.json(rows.map(viewOf))
  }
  const r = recordingId ? getRecording(recordingId) : undefined
  if (!r || r.candidateId !== candidateId || r.expiresAt <= Date.now()) {
    fail(404, 'Recording not found.')
  }
  if (url.searchParams.get('analysis') === '1') {
    if (req.method === 'GET') {
      return Response.json(readReplayAnalysis(recordingId!))
    }
    if (req.method !== 'POST') fail(405, 'Method not allowed.')
    if (!c!.candidateFinishedAt || r!.status === 'recording' || !r!.bytes) {
      fail(409, 'Wait for the interview recording to finish saving.')
    }
    if (!hasAiKey()) {
      fail(503, 'Replay analysis needs a configured model API key.')
    }
    try {
      return Response.json(await analyzeReplay(recordingId!, reportView(c!)))
    } catch {
      return fail(500, 'Replay analysis could not start. Try again.')
    }
  }
  if (req.method === 'DELETE') {
    db.transaction(() => {
      deleteReplayAnalysis(recordingId!)
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
  // Start at the chunk holding `start` (found from the sizes alone), then load
  // one bounded chunk per pull, rather than materializing the video.
  let offset = 0
  let sequence = 0
  for (const chunk of range ? chunkSizes(recordingId!) : []) {
    if (offset + chunk.size > start) break
    offset += chunk.size
    sequence = chunk.sequence + 1
  }
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
    purgeAtMostEveryMinute()
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
