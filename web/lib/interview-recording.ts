// Record camera + microphone + Oracle's actual server audio in one video.
// Visual sampling requires a separate opt-in. Chunks are uploaded in order.
import { signal } from '@preact/signals'
import { paths } from '/web/paths.ts'
import type { RecordingView } from '/web/types.ts'

export const recording = {
  preview: signal<MediaStream | undefined>(undefined),
  status: signal<'idle' | 'recording' | 'saving' | 'saved' | 'error'>('idle'),
  error: signal(''),
}

type Capture = {
  recorder: MediaRecorder
  source: MediaStreamAudioSourceNode
  destination: MediaStreamAudioDestinationNode
  oracle: GainNode
  started: number
  id: string
  sequence: number
  queuedBytes: number
  pending: Promise<void>
  failed: boolean
  stopped: Promise<void>
  stop?: Promise<void>
}
let capture: Capture | undefined

const formats = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/mp4;codecs=avc1.424028,mp4a.40.2',
  'video/webm',
  'video/mp4',
]

const request = async (url: string, options: RequestInit) => {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw Error(body.error ?? 'The recording could not be saved.')
  }
  return response
}

export const beginRecording = async (
  stream: MediaStream,
  context: AudioContext,
  oracle: GainNode,
  onFailure: (message: string) => void,
  visualAnalysisAccepted = false,
) => {
  if (capture) throw Error('A recording is already being saved. Please wait.')
  recording.error.value = ''
  if (typeof MediaRecorder === 'undefined') {
    throw Error(
      'This browser cannot record the interview. Use a current Chrome, Edge, Firefox or Safari browser.',
    )
  }
  const mime = formats.find((format) => MediaRecorder.isTypeSupported(format))
  if (!mime) {
    throw Error('This browser has no supported video recording format.')
  }
  const source = context.createMediaStreamSource(stream)
  const destination = context.createMediaStreamDestination()
  source.connect(destination)
  oracle.connect(destination)
  const media = new MediaStream([
    ...stream.getVideoTracks(),
    ...destination.stream.getAudioTracks(),
  ])
  let current: Capture | undefined
  try {
    const recorder = new MediaRecorder(media, {
      mimeType: mime,
      videoBitsPerSecond: 350_000,
      audioBitsPerSecond: 64_000,
    })
    const response = await request(paths.candidateRecording, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accepted: true, mime, visualAnalysisAccepted }),
    })
    const info: RecordingView = await response.json()
    let stopped!: () => void
    current = {
      recorder,
      source,
      destination,
      oracle,
      started: performance.now(),
      id: info.id,
      sequence: 0,
      queuedBytes: 0,
      pending: Promise.resolve(),
      failed: false,
      stopped: new Promise<void>((resolve) => stopped = resolve),
    }
    const c = current
    const fail = (message: string) => {
      if (c.failed) return
      c.failed = true
      recording.error.value = message
      recording.status.value = 'error'
      onFailure(message)
    }
    recorder.ondataavailable = ({ data }) => {
      if (!data.size || c.failed) return
      c.queuedBytes += data.size
      if (c.queuedBytes > 12 * 1024 * 1024) {
        fail(
          'The recording upload cannot keep up. Check your connection before resuming.',
        )
        return
      }
      c.pending = c.pending.then(async () => {
        if (c.failed) return
        // A delayed browser event can contain more than one server chunk.
        for (let offset = 0; offset < data.size; offset += 512 * 1024) {
          const part = data.slice(offset, offset + 512 * 1024)
          const url =
            `${paths.candidateRecording}?id=${c.id}&sequence=${c.sequence}`
          for (let attempt = 0;; attempt++) {
            try {
              await request(url, { method: 'PUT', body: part })
              break
            } catch (error) {
              if (attempt === 2) throw error
              await new Promise((resolve) =>
                setTimeout(resolve, 500 * (attempt + 1))
              )
            }
          }
          c.sequence++
        }
        c.queuedBytes -= data.size
      }).catch((error) =>
        fail(error instanceof Error ? error.message : String(error))
      )
    }
    recorder.onerror = () =>
      fail(
        'The camera recording stopped unexpectedly. Check your devices and try again.',
      )
    recorder.onstop = stopped
    capture = c
    recording.preview.value = stream
    recorder.start(2000)
    recording.status.value = 'recording'
    return info.id
  } catch (error) {
    source.disconnect()
    oracle.disconnect(destination)
    destination.stream.getTracks().forEach((track) => track.stop())
    recording.preview.value = undefined
    recording.status.value = 'error'
    recording.error.value = error instanceof Error
      ? error.message
      : String(error)
    if (current) {
      capture = undefined
      // A created but empty attempt remains labelled incomplete on the server.
      request(`${paths.candidateRecording}?id=${current.id}`, {
        method: 'POST',
        body: JSON.stringify({ status: 'interrupted', durationMs: 0 }),
      }).catch(() => {})
    }
    throw error
  }
}

/** Stop only after Oracle's last sound. Resolve after the final chunk is saved. */
export const endRecording = (complete: boolean): Promise<void> => {
  const c = capture
  if (!c) return Promise.resolve()
  if (c.stop) return c.stop
  if (!c.failed) recording.status.value = 'saving'
  c.stop = (async () => {
    const durationMs = Math.min(20 * 60_000, performance.now() - c.started)
    if (c.recorder.state !== 'inactive') c.recorder.stop()
    else c.recorder.onstop?.(new Event('stop'))
    await c.stopped
    await c.pending
    try {
      await request(`${paths.candidateRecording}?id=${c.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: complete && !c.failed ? 'complete' : 'interrupted',
          durationMs,
        }),
      })
      if (!c.failed) recording.status.value = 'saved'
    } catch (error) {
      recording.error.value = error instanceof Error
        ? error.message
        : String(error)
      recording.status.value = 'error'
    } finally {
      c.source.disconnect()
      c.oracle.disconnect(c.destination)
      c.destination.stream.getTracks().forEach((track) => track.stop())
      recording.preview.value?.getTracks().forEach((track) => track.stop())
      recording.preview.value = undefined
      if (capture === c) capture = undefined
    }
  })()
  return c.stop
}
