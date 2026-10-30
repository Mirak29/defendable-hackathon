// Run while the image is built (see the Dockerfile): loads, once, everything
// the server needs and cannot fetch later, and proves each part works. A
// failure stops the build: better here than in front of a candidate.
import '/api/schema.ts' // opens the database: the native SQLite library is fetched
import { tts } from '/api/tts.ts'
import { runEvaluation } from '/api/sandbox.ts'
import { checkProgram } from '/api/program-sandbox.ts'
import { demoAssessment } from '/fixtures/demo.ts'
import { demoFiles } from '/fixtures/demo-files.ts'

const fail = (message: string): never => {
  console.error(`warm-up failed: ${message}`)
  Deno.exit(1)
}

// the voice: the model runs once, from the weights deploy/fetch.ts put in the
// image
tts.warmUp()
const started = Date.now()
while (!tts.loaded()) {
  if (Date.now() - started > 15 * 60_000) fail('the voice did not load')
  await new Promise((r) => setTimeout(r, 500))
}
console.log(`voice ready in ${Math.round((Date.now() - started) / 1000)} s`)
// a voice that had to fetch its weights would not start on a machine without
// Internet: the model named in deploy/fetch.ts is not the one of api/tts.ts
if (tts.downloaded()) fail('the voice weights are not in the image')

// the sandbox of TypeScript: offline, with the module of the tests cached
const results = await runEvaluation(demoFiles, demoAssessment.tests)
const passed = results.filter((r) => r.passed).length
if (!passed) fail('the TypeScript sandbox ran no test successfully')
console.log(`TypeScript sandbox: ${passed}/${results.length} tests pass`)

// the sandbox of Python: Pyodide, offline
const problems = await checkProgram('python', { 'main.py': 'print("ok")\n' })
if (problems.length) fail(`the Python sandbox: ${problems[0].message}`)
console.log('Python sandbox: ready')

Deno.exit(0)
