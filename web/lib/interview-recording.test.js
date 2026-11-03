// Exercise capture composition and the final-chunk barrier without a real
// camera, microphone, network connection or model call.
import { eq, test } from '/api/lib/test.ts'
import {
  beginRecording,
  endRecording,
  recording,
} from './interview-recording.ts'

const withDevices = async (fn, failUpload = false) => {
  const names = ['MediaRecorder', 'MediaStream', 'fetch']
  const saved = names.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name)
  )
  const calls = []
  const connections = []
  const stopped = []
  const camera = { kind: 'video', stop: () => stopped.push('camera') }
  const microphone = { kind: 'audio', stop: () => stopped.push('microphone') }
  const mix = { kind: 'audio', stop: () => stopped.push('mix') }
  const stream = {
    getVideoTracks: () => [camera],
    getTracks: () => [camera, microphone],
  }
  const destination = {
    stream: { getAudioTracks: () => [mix], getTracks: () => [mix] },
  }
  const source = {
    connect: (to) => connections.push(['microphone', to]),
    disconnect() {},
  }
  const context = {
    createMediaStreamSource: () => source,
    createMediaStreamDestination: () => destination,
  }
  const oracle = {
    connect: (to) => connections.push(['oracle', to]),
    disconnect() {},
  }
  let recorder
  class Recorder {
    static isTypeSupported(type) {
      return type === 'video/webm;codecs=vp8,opus'
    }
    constructor(media) {
      recorder = this
      this.media = media
      this.state = 'inactive'
    }
    start() {
      this.state = 'recording'
    }
    stop() {
      this.state = 'inactive'
      // Real MediaRecorder emits the final data BEFORE the stop event.
      queueMicrotask(() => {
        this.ondataavailable({ data: new Blob([new Uint8Array([7, 8])]) })
        this.onstop(new Event('stop'))
      })
    }
  }
  try {
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: Recorder,
    })
    Object.defineProperty(globalThis, 'MediaStream', {
      configurable: true,
      value: class {
        constructor(tracks) {
          this.tracks = tracks
        }
      },
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (url, options) => {
        await Promise.resolve()
        calls.push({ url, ...options })
        if (failUpload && options.method === 'PUT') {
          return Response.json({ error: 'Upload unavailable' }, { status: 503 })
        }
        return Response.json(
          options.method === 'POST' && !url.includes('?')
            ? { id: 'attempt-1' }
            : { saved: true },
        )
      },
    })
    await fn({
      stream,
      context,
      oracle,
      calls,
      connections,
      stopped,
      destination,
      camera,
      mix,
      recorder: () => recorder,
    })
  } finally {
    await endRecording(false)
    names.forEach((name, i) => {
      if (saved[i]) Object.defineProperty(globalThis, name, saved[i])
      else delete globalThis[name]
    })
  }
}

test('recording client: both voices, ordered slices and final upload', async (step) => {
  await step(
    'mix both voices and await the final video chunk before finalizing',
    async () => {
      await withDevices(async (t) => {
        const failures = []
        eq(
          await beginRecording(
            t.stream,
            t.context,
            t.oracle,
            (message) => failures.push(message),
          ),
          'attempt-1',
        )
        eq(t.connections, [['microphone', t.destination], [
          'oracle',
          t.destination,
        ]])
        eq(t.recorder().media.tracks, [t.camera, t.mix])
        t.recorder().ondataavailable({
          data: new Blob([new Uint8Array(600_000)]),
        })
        await endRecording(true)
        const uploads = t.calls.filter((call) => call.method === 'PUT')
        eq(
          uploads.map((call) =>
            new URL(call.url, 'http://localhost').searchParams.get('sequence')
          ),
          ['0', '1', '2'],
        )
        eq(uploads.map((call) => call.body.size), [524288, 75712, 2])
        const finished = JSON.parse(t.calls.at(-1).body)
        eq(finished.status, 'complete')
        eq(recording.status.value, 'saved')
        eq(recording.preview.value, undefined)
        eq(t.stopped.sort(), ['camera', 'microphone', 'mix'])
        eq(failures, [])
      })
    },
  )
  await step(
    'a failed upload leaves an interrupted recording and a visible error',
    async () => {
      await withDevices(async (t) => {
        const failures = []
        await beginRecording(
          t.stream,
          t.context,
          t.oracle,
          (message) => failures.push(message),
        )
        await endRecording(true)
        eq(failures, ['Upload unavailable'])
        eq(recording.status.value, 'error')
        eq(JSON.parse(t.calls.at(-1).body).status, 'interrupted')
      }, true)
    },
  )
})
