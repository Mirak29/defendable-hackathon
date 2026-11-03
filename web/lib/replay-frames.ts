import type { ReplayFrame } from './replay-analysis-types.ts'

export const frameTimes = (durationMs: number) => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return []
  const end = Math.max(0, durationMs - 500)
  const length = Math.min(12, Math.max(1, Math.ceil(durationMs / 10_000)))
  return Array.from(
    { length },
    (_, i) => length === 1 ? 0 : Math.round(end * i / (length - 1)),
  )
}

// Decode locally using the browser's codecs. Do not alter the visible player,
// upload the full video, or persist the sampled images in browser storage.
export const sampleReplayFrames = async (
  src: string,
  durationMs: number,
  signal: AbortSignal,
): Promise<ReplayFrame[]> => {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.playsInline = true
  const wait = (event: string, action: () => void) =>
    new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer)
        video.removeEventListener(event, ready)
        video.removeEventListener('error', failed)
        signal.removeEventListener('abort', aborted)
        error ? reject(error) : resolve()
      }
      const ready = () => done()
      const failed = () =>
        done(Error('The video could not be decoded for image sampling.'))
      const aborted = () => done(new DOMException('Cancelled', 'AbortError'))
      const timer = setTimeout(
        () =>
          done(
            Error(
              'Image sampling timed out. You can analyze the transcript without images.',
            ),
          ),
        10_000,
      )
      video.addEventListener(event, ready, { once: true })
      video.addEventListener('error', failed, { once: true })
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
      else {try {
          action()
        } catch {
          failed()
        }}
    })
  try {
    await wait('loadeddata', () => {
      video.src = src
      video.load()
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.min(480, video.videoWidth)
    canvas.height = Math.round(
      video.videoHeight * canvas.width / video.videoWidth,
    )
    const context = canvas.getContext('2d')
    if (!context || !canvas.width || !canvas.height) {
      throw Error('Images could not be sampled.')
    }
    const frames: ReplayFrame[] = []
    for (const atMs of frameTimes(durationMs)) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      if (Math.abs(video.currentTime * 1000 - atMs) > 100) {
        await wait('seeked', () => {
          video.currentTime = atMs / 1000
        })
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const image = canvas.toDataURL('image/jpeg', 0.6)
      if (image.length > 150_000) throw Error('A sampled image is too large.')
      frames.push({
        atMs: Math.min(durationMs, Math.round(video.currentTime * 1000)),
        image,
      })
    }
    return frames
  } finally {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
}
