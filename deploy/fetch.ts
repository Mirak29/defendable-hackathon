// Run while the image is built, before the code is copied (see the Dockerfile):
// downloads the two things that are big and never change with the code, so
// their layer stays in the cache (and out of every upload) when the code is
// edited. deploy/warm.ts then checks that everything works.
import { Database } from '@db/sqlite'
import { KokoroTTS } from 'kokoro-js'

// the native SQLite library is fetched the first time a database is opened
new Database(':memory:').close()

// the voice weights (326 MB); the same model as api/tts.ts
await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
  dtype: 'fp32',
  device: 'cpu',
})
console.log('voice weights and SQLite fetched')
Deno.exit(0)
