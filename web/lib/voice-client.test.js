import { eq, test } from '/api/lib/test.ts'
import { startRecordedVoice, stopVoice, voice } from './voice-client.ts'
import { endRecording, recording } from './interview-recording.ts'

const withDevices = async (fn, delayed = false) => {
  const names = [
    'document',
    'navigator',
    'speechSynthesis',
    'AudioContext',
    'AudioWorkletNode',
    'MediaStream',
    'MediaRecorder',
    'WebSocket',
    'fetch',
  ]
  const saved = names.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name)
  )
  let stopped = 0
  const track = (kind) => ({
    kind,
    stop: () => stopped++,
    addEventListener() {},
    removeEventListener() {},
  })
  const camera = track('video')
  const microphone = track('audio')
  const node = () => ({ connect() {}, disconnect() {} })
  let socket
  let allowCreate
  let requested
  const creationRequested = new Promise((resolve) => requested = resolve)
  const globals = {
    document: { baseURI: 'http://localhost/' },
    navigator: {
      mediaDevices: {
        getUserMedia: () =>
          Promise.resolve({
            getTracks: () => [camera, microphone],
            getVideoTracks: () => [camera],
          }),
      },
    },
    speechSynthesis: { cancel() {}, getVoices: () => [] },
    AudioContext: class {
      currentTime = 0
      state = 'running'
      destination = {}
      audioWorklet = { addModule() {} }
      resume() {
        return Promise.resolve()
      }
      close() {
        return Promise.resolve()
      }
      createGain() {
        return node()
      }
      createAnalyser() {
        return {
          ...node(),
          fftSize: 1024,
          getFloatTimeDomainData(a) {
            a.fill(0)
          },
        }
      }
      createMediaStreamSource() {
        return node()
      }
      createMediaStreamDestination() {
        return {
          ...node(),
          stream: {
            getAudioTracks: () => [track('audio')],
            getTracks: () => [],
          },
        }
      }
      createBuffer(_channels, length, rate) {
        return {
          duration: length / rate,
          getChannelData: () => new Float32Array(length),
        }
      }
      createBufferSource() {
        return { ...node(), start() {}, stop() {} }
      }
    },
    AudioWorkletNode: class {
      port = {}
    },
    MediaStream: class {
      constructor(tracks) {
        this.tracks = tracks
      }
    },
    MediaRecorder: class {
      static isTypeSupported() {
        return true
      }
      state = 'inactive'
      start() {
        this.state = 'recording'
      }
      stop() {
        this.state = 'inactive'
        queueMicrotask(() => {
          this.ondataavailable({ data: new Blob(['last']) })
          this.onstop(new Event('stop'))
        })
      }
    },
    WebSocket: class {
      static OPEN = 1
      readyState = 1
      constructor() {
        socket = this
      }
      send() {}
      close() {
        this.readyState = 3
      }
    },
    fetch: async (url, options) => {
      if (options.method === 'POST' && !url.includes('?')) {
        requested()
        if (delayed) {
          return await new Promise((resolve) =>
            allowCreate = () => resolve(Response.json({ id: 'attempt' }))
          )
        }
        return Response.json({ id: 'attempt' })
      }
      return Response.json({ saved: true })
    },
  }
  try {
    for (const name of names) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value: globals[name],
      })
    }
    await fn({
      requested: creationRequested,
      allowCreate: () => allowCreate(),
      socket: () => socket,
      stopped: () => stopped,
      emit: (event) => socket.onmessage({ data: JSON.stringify(event) }),
    })
  } finally {
    stopVoice()
    await endRecording(false)
    await new Promise((resolve) => setTimeout(resolve, 40))
    names.forEach((name, i) => {
      if (saved[i]) Object.defineProperty(globalThis, name, saved[i])
      else delete globalThis[name]
    })
  }
}

test('voice client: leaving the interview releases recording devices', async (step) => {
  await step(
    'leaving during the final sentence releases media even after the socket closed',
    async () => {
      await withDevices(async (t) => {
        await startRecordedVoice()
        t.emit({ type: 'ready', voice: 'server', rate: 16000, history: [] })
        t.emit({ type: 'speech', text: 'Goodbye', pcm: 'AAAAAA==' })
        t.emit({ type: 'end' })
        t.socket().onclose()
        eq(recording.status.value, 'recording')
        stopVoice()
        await endRecording(true)
        eq(recording.preview.value, undefined)
        eq(t.stopped() > 0, true)
        eq(recording.status.value, 'saved')
      })
    },
  )
  await step(
    'a delayed recording start cannot create a background call after leaving',
    async () => {
      await withDevices(async (t) => {
        const starting = startRecordedVoice()
        await t.requested
        stopVoice()
        t.allowCreate()
        await starting
        eq(t.socket(), undefined)
        eq(t.stopped() > 0, true)
        eq(recording.preview.value, undefined)
        eq(voice.status.value, 'idle')
      }, true)
    },
  )
})
