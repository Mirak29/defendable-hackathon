// Run while the image is built, before the code is copied (see the Dockerfile):
// downloads the two things that are big and never change with the code, so
// their layer stays in the cache (and out of every upload) when the code is
// edited. deploy/warm.ts then checks that everything works.
import { Database } from '@db/sqlite'
import { AutoTokenizer, VitsModel } from '@huggingface/transformers'

// the native SQLite library is fetched the first time a database is opened
new Database(':memory:').close()

// the voice weights (MMS-TTS, about 110 MB); the same model and the same
// loading as api/tts.ts, which then reads them from the disk only
const MODEL = 'Xenova/mms-tts-eng'
await AutoTokenizer.from_pretrained(MODEL)
await VitsModel.from_pretrained(MODEL, {
  dtype: 'fp32',
  device: 'cpu',
})
console.log('voice weights and SQLite fetched')
Deno.exit(0)
