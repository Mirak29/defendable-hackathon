// The Python side of a program run: one Pyodide (CPython in WebAssembly) per
// worker, driven by py-runner.ts, the only one that talks to it. The candidate's
// files live in Pyodide's own in-memory file system: nothing of the host is
// reachable from them, and the expected outputs never enter this worker.
import { loadPyodide, type PyodideInterface } from 'npm:pyodide@0.28.2'

export type Job =
  | { type: 'init'; files: Record<string, string> }
  | { type: 'case'; id: string; stdin: string; entry: string }
  | { type: 'check' }
  | { type: 'unittest' }

export type Reply =
  | { type: 'ready' }
  | {
    type: 'case'
    id: string
    stdout: string
    stderr: string
    error?: string
    ms: number
  }
  | { type: 'check'; problems: CheckProblem[] }
  | { type: 'unittest'; run: number; failed: number; output: string }
  | { type: 'error'; message: string }

export type CheckProblem = {
  file: string
  line: number
  column: number
  length: number
  message: string
}

const WORK = '/work'
const decoder = new TextDecoder()

let py: PyodideInterface
let paths: string[] = []
let out = ''
let err = ''

/** `main.py` → `main`, `src/util.py` → `src.util`: what `import` would load */
const moduleName = (path: string) =>
  path.replace(/\.py$/, '').replaceAll('/', '.')

/** a module the candidate wrote must not survive from a case to the next */
const forgetModules = () =>
  py.runPython(`
import sys
for _name in ${
    JSON.stringify(paths.filter((p) => p.endsWith('.py')).map(moduleName))
  }:
    sys.modules.pop(_name, None)
`)

const init = async (files: Record<string, string>) => {
  py = await loadPyodide({ fullStdLib: false })
  py.setStdout({
    write: (bytes: Uint8Array) => {
      out += decoder.decode(bytes, { stream: true })
      return bytes.length
    },
  })
  py.setStderr({
    write: (bytes: Uint8Array) => {
      err += decoder.decode(bytes, { stream: true })
      return bytes.length
    },
  })
  py.FS.mkdirTree(WORK)
  py.FS.chdir(WORK)
  paths = Object.keys(files)
  for (const [path, code] of Object.entries(files)) {
    const dir = path.includes('/') ? path.replace(/\/[^/]+$/, '') : ''
    if (dir) py.FS.mkdirTree(`${WORK}/${dir}`)
    py.FS.writeFile(`${WORK}/${path}`, code)
  }
  py.runPython(`import sys\nsys.path.insert(0, ${JSON.stringify(WORK)})`)
}

const runCase = async (id: string, stdin: string, entry: string) => {
  out = ''
  err = ''
  const lines = stdin.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let next = 0
  py.setStdin({ stdin: () => (next < lines.length ? lines[next++] : null) })
  let error: string | undefined
  const started = performance.now()
  try {
    forgetModules()
    await py.runPythonAsync(
      `exec(compile(open(${JSON.stringify(entry)}).read(), ${
        JSON.stringify(entry)
      }, 'exec'), {'__name__': '__main__'})`,
    )
  } catch (e) {
    error = String((e as Error).message ?? e).trim().split('\n').slice(-6)
      .join('\n')
  }
  try {
    py.runPython('import sys\nsys.stdout.flush()\nsys.stderr.flush()')
  } catch { /* nothing to flush */ }
  return {
    type: 'case' as const,
    id,
    stdout: out,
    stderr: err,
    error,
    ms: Math.round(performance.now() - started),
  }
}

const check = (): Reply => {
  const json = py.runPython(`
import json
_problems = []
for _path in ${JSON.stringify(paths.filter((p) => p.endsWith('.py')))}:
    try:
        compile(open(_path).read(), _path, 'exec')
    except SyntaxError as e:
        _col = e.offset or 1
        _end = getattr(e, 'end_offset', None) or _col + 1
        _problems.append({'file': _path, 'line': e.lineno or 1, 'column': _col,
                          'length': max(1, _end - _col), 'message': e.msg})
json.dumps(_problems)
`) as string
  return { type: 'check', problems: JSON.parse(json) }
}

const unittest = (): Reply => {
  forgetModules()
  const json = py.runPython(`
import unittest, io, json
_suite = unittest.TestLoader().discover(${
    JSON.stringify(WORK)
  }, pattern='test*.py', top_level_dir=${JSON.stringify(WORK)})
_stream = io.StringIO()
_result = unittest.TextTestRunner(stream=_stream, verbosity=1).run(_suite)
json.dumps({'run': _result.testsRun, 'failed': len(_result.failures) + len(_result.errors), 'output': _stream.getvalue()})
`) as string
  return { type: 'unittest', ...JSON.parse(json) }
}

self.onmessage = async (event: MessageEvent<Job>) => {
  const job = event.data
  try {
    if (job.type === 'init') {
      await init(job.files)
      self.postMessage({ type: 'ready' } satisfies Reply)
    } else if (job.type === 'case') {
      self.postMessage(await runCase(job.id, job.stdin, job.entry))
    } else if (job.type === 'check') {
      self.postMessage(check())
    } else {
      self.postMessage(unittest())
    }
  } catch (e) {
    self.postMessage(
      {
        type: 'error',
        message: String((e as Error).message ?? e),
      } satisfies Reply,
    )
  }
}
