// The supervisor of a Python run, started by program-sandbox.ts in a `deno`
// subprocess that may only read Pyodide's files and this folder: no network,
// environment, subprocess or write access. It reads one job on its standard
// input, drives one worker, and prints a single result line:
//
//   <token>{"results":[…]}
//
// A case that does not answer in time loses its worker (a loop in Python
// cannot be interrupted from inside): the next case gets a fresh one.
import type { CheckProblem, Job, Reply } from '/api/py-worker.ts'

type Input =
  | {
    mode: 'cases'
    files: Record<string, string>
    entry: string
    cases: { id: string; stdin: string }[]
    caseTimeoutMs: number
  }
  | { mode: 'check'; files: Record<string, string> }
  | { mode: 'unittest'; files: Record<string, string> }

const token = Deno.args[0]
const input = JSON.parse(
  await new Response(Deno.stdin.readable).text(),
) as Input

const start = () =>
  new Promise<Worker>((resolve, reject) => {
    const worker = new Worker(new URL('./py-worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (e: MessageEvent<Reply>) => {
      if (e.data.type === 'ready') resolve(worker)
      else reject(Error(e.data.type === 'error' ? e.data.message : 'no start'))
    }
    worker.onerror = (e) => reject(Error(e.message))
    worker.postMessage({ type: 'init', files: input.files } satisfies Job)
  })

const ask = (worker: Worker, job: Job, ms: number) =>
  new Promise<Reply | 'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms)
    worker.onmessage = (e: MessageEvent<Reply>) => {
      clearTimeout(timer)
      resolve(e.data)
    }
    worker.onerror = (e) => {
      clearTimeout(timer)
      resolve({ type: 'error', message: e.message })
    }
    worker.postMessage(job)
  })

const print = (value: unknown) => console.log(token + JSON.stringify(value))

try {
  let worker = await start()
  if (input.mode === 'check') {
    const reply = await ask(worker, { type: 'check' }, 10_000)
    print({
      problems: typeof reply === 'object' && reply.type === 'check'
        ? reply.problems
        : [] as CheckProblem[],
    })
  } else if (input.mode === 'unittest') {
    const reply = await ask(worker, { type: 'unittest' }, 10_000)
    print(
      typeof reply === 'object' && reply.type === 'unittest'
        ? { run: reply.run, failed: reply.failed, output: reply.output }
        : { timeout: reply === 'timeout' },
    )
  } else {
    const results: unknown[] = []
    for (const [i, c] of input.cases.entries()) {
      const reply = await ask(
        worker,
        { type: 'case', id: c.id, stdin: c.stdin, entry: input.entry },
        input.caseTimeoutMs,
      )
      if (reply === 'timeout') {
        results.push({ id: c.id, timeout: true })
        worker.terminate()
        // a fresh worker only when another case is waiting
        if (i < input.cases.length - 1) worker = await start()
      } else if (reply.type === 'case') {
        results.push(reply)
      } else {
        results.push({
          id: c.id,
          failure: reply.type === 'error' ? reply.message : 'no answer',
        })
      }
    }
    print({ results })
  }
  worker.terminate()
} catch (e) {
  print({ failure: String((e as Error).message ?? e) })
}
Deno.exit(0)
