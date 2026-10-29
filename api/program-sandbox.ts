// The "program" assessment: the candidate's code reads its input on the
// standard input and writes its result on the standard output; a test is an
// input and the output it must give. The tests do not depend on the language:
// TypeScript runs in a `deno` subprocess, Python in Pyodide under the same
// restricted `deno` (api/py-runner.ts). The expected outputs never enter the
// sandbox: the verdict is computed here, from what the code printed.
import { dirname, fromFileUrl, join } from 'jsr:@std/path'
import {
  assertFiles,
  CASE_TIMEOUT_MS,
  type CodeProblem,
  findRefusedImport,
  inWorkspace,
  type OwnTestsRun,
  PERMISSIONS,
  refused,
  RUN_TIMEOUT_MS,
  type SandboxRun,
  spawn,
  withImportCheck,
} from '/api/sandbox.ts'
import { makeQueue } from '/api/lib/make-queue.ts'
import type { CandidateFiles, Language, TestResult } from '/web/types.ts'

/** the file that reads the input: the entry point of a program */
export const entryOf = (language: Language) =>
  language === 'python' ? 'main.py' : 'src/main.ts'

export type ProgramCase = { id: string; stdin: string; expected: string }

const nextSlot = makeQueue(2)
const SHOWN = 300

/** what a person would compare: line ends and the spaces at the end of lines */
export const normalizeOutput = (text: string) =>
  text.replaceAll('\r\n', '\n').split('\n').map((l) => l.trimEnd()).join('\n')
    .replace(/\n+$/, '')

const shorten = (text: string) =>
  text.length > SHOWN ? `${text.slice(0, SHOWN)}…` : text

/* ---------- Python ---------- */

const PYODIDE = '0.28.2'
const apiDir = dirname(fromFileUrl(import.meta.url))
const rootConfig = join(apiDir, '..', 'deno.json')
/** where Deno keeps the Pyodide package: the only place Python's runtime reads */
const pyodideDir = () => {
  const root = join(apiDir, '..')
  for (
    const dir of [
      join(
        root,
        'node_modules',
        '.deno',
        `pyodide@${PYODIDE}`,
        'node_modules',
        'pyodide',
      ),
      join(root, 'node_modules', 'pyodide'),
    ]
  ) {
    try {
      if (Deno.statSync(dir).isDirectory) return Deno.realPathSync(dir)
    } catch { /* not there */ }
  }
  throw Error('Pyodide is not installed: run `deno install`')
}

type PyCase = {
  id: string
  stdout: string
  stderr: string
  error?: string
  ms: number
  timeout?: boolean
  failure?: string
}

/** one job for the Python supervisor; undefined if it could not run at all */
const pyJob = async (
  job: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> => {
  const token = `__DFD_${crypto.randomUUID().replaceAll('-', '')}__`
  using _slot = await nextSlot()
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--config',
      rootConfig,
      '--cached-only',
      '--no-prompt',
      `--allow-read=${apiDir},${pyodideDir()}`,
      join(apiDir, 'py-runner.ts'),
      token,
    ],
    env: { NO_COLOR: '1' },
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'null',
  }).spawn()
  const writer = child.stdin.getWriter()
  writer.write(new TextEncoder().encode(JSON.stringify(job)))
    .then(() => writer.close())
    .catch(() => {/* ended before reading */})
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch { /* already exited */ }
  }, timeoutMs)
  const text = await new Response(child.stdout).text()
  await child.status
  clearTimeout(timer)
  const line = text.split('\n').find((l) => l.startsWith(token))
  if (!line) return
  try {
    return JSON.parse(line.slice(token.length))
  } catch {
    return
  }
}

const pyCases = async (
  files: CandidateFiles,
  cases: { id: string; stdin: string }[],
) => {
  // a case that loops costs its time and a new start of Python
  const budget = 15_000 + cases.length * (CASE_TIMEOUT_MS + 2_000)
  const out = await pyJob({
    mode: 'cases',
    files,
    entry: entryOf('python'),
    cases,
    caseTimeoutMs: CASE_TIMEOUT_MS,
  }, budget)
  return (out?.results as PyCase[] | undefined) ?? undefined
}

/* ---------- TypeScript ---------- */

type Ran = {
  stdout: string
  stderr: string
  timedOut: boolean
  error?: string
  ms: number
}

const tsCase = async (dir: string, stdin: string): Promise<Ran> => {
  const run = await spawn(
    dir,
    ['run', ...PERMISSIONS, `--allow-read=${dir}`, entryOf('typescript')],
    'deno run',
    CASE_TIMEOUT_MS,
    { input: stdin },
  )
  const text = (kind: 'out' | 'err') =>
    run.chunks.filter((c) => c.stream === kind).map((c) => c.text).join('')
  return {
    stdout: text('out'),
    stderr: text('err'),
    timedOut: run.timedOut,
    error: run.exitCode !== 0 && !run.timedOut
      ? text('err').trim().split('\n').slice(-6).join('\n') ||
        `exit code ${run.exitCode}`
      : undefined,
    ms: run.durationMs,
  }
}

/* ---------- the tests of a program ---------- */

/** the evaluation tests, public or hidden: one input, one expected output */
export const runProgramCases = async (
  language: Language,
  files: CandidateFiles,
  cases: ProgramCase[],
): Promise<TestResult[]> => {
  const verdict = (c: ProgramCase, ran: Ran | PyCase): TestResult => {
    const base = { id: c.id, durationMs: ran.ms, request: shorten(c.stdin) }
    if ('timeout' in ran && ran.timeout || 'timedOut' in ran && ran.timedOut) {
      return {
        ...base,
        passed: false,
        received: `Stopped after ${CASE_TIMEOUT_MS / 1000} s`,
      }
    }
    if ('failure' in ran && ran.failure) {
      return { ...base, passed: false, received: `Error: ${ran.failure}` }
    }
    const received = normalizeOutput(ran.stdout)
    if (ran.error && !received) {
      return { ...base, passed: false, received: `Error: ${ran.error}` }
    }
    const expected = normalizeOutput(c.expected)
    return {
      ...base,
      passed: received === expected,
      expected: shorten(expected),
      received: shorten(received) || '(nothing)',
    }
  }
  const failAll = (why: string) =>
    cases.map((c): TestResult => ({
      id: c.id,
      passed: false,
      durationMs: 0,
      request: shorten(c.stdin),
      received: why,
    }))

  assertFiles(files)
  if (language === 'python') {
    const results = await pyCases(
      files,
      cases.map(({ id, stdin }) => ({ id, stdin })),
    )
    if (!results) return failAll('The tests could not run')
    return cases.map((c) => {
      const ran = results.find((r) => r.id === c.id)
      return ran ? verdict(c, ran) : failAll('Not run')[0]
    })
  }
  const spec = findRefusedImport(files)
  if (spec) return failAll(`Import not allowed: ${spec}`)
  const out = await inWorkspace<TestResult[]>(files, async (dir) => {
    const results: TestResult[] = []
    for (const c of cases) results.push(verdict(c, await tsCase(dir, c.stdin)))
    return results
  }, (spec) => failAll(`Import not allowed: ${spec}`))
  return out
}

/* ---------- "Run": the program on an input ---------- */

const asRun = (
  command: string,
  stdout: string,
  stderr: string,
  ms: number,
  timedOut: boolean,
  failed: boolean,
): SandboxRun => ({
  command,
  chunks: [
    ...(stdout ? [{ text: stdout, stream: 'out' as const }] : []),
    ...(stderr ? [{ text: stderr, stream: 'err' as const }] : []),
  ],
  exitCode: failed ? 1 : 0,
  durationMs: ms,
  timedOut,
  truncated: false,
})

/** "Run": the program with the sample input, its output as it came */
export const runProgram = async (
  language: Language,
  files: CandidateFiles,
  stdin: string,
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<SandboxRun> => {
  assertFiles(files)
  if (language === 'python') {
    const command = 'python main.py'
    const out = await pyJob({
      mode: 'cases',
      files,
      entry: entryOf('python'),
      cases: [{ id: 'run', stdin }],
      caseTimeoutMs: timeoutMs,
    }, timeoutMs + 15_000)
    const ran = (out?.results as PyCase[] | undefined)?.[0]
    if (!ran) {
      return asRun(command, '', 'The program could not run.', 0, false, true)
    }
    if (ran.timeout) {
      return asRun(command, '', '', timeoutMs, true, true)
    }
    return asRun(
      command,
      ran.stdout,
      [ran.stderr, ran.error].filter(Boolean).join('\n'),
      ran.ms,
      false,
      !!ran.error,
    )
  }
  const command = 'deno run src/main.ts'
  const spec = findRefusedImport(files)
  if (spec) return refused(command, spec)
  return inWorkspace(
    files,
    async (dir) =>
      withImportCheck(
        await spawn(
          dir,
          ['run', ...PERMISSIONS, `--allow-read=${dir}`, entryOf(language)],
          command,
          timeoutMs,
          { input: stdin },
        ),
      ),
    (spec) => refused(command, spec),
  )
}

/* ---------- "My tests" and the check of the code ---------- */

/** the tests the candidate wrote: `deno test` or `unittest` */
export const runProgramOwnTests = async (
  language: Language,
  files: CandidateFiles,
): Promise<OwnTestsRun> => {
  assertFiles(files)
  if (language === 'python') {
    const command = 'python -m unittest'
    const out = await pyJob({ mode: 'unittest', files }, 30_000)
    if (!out || typeof out.run !== 'number') {
      return {
        ...asRun(
          command,
          '',
          'The tests could not run.',
          0,
          !!out?.timeout,
          true,
        ),
        passed: 0,
        failed: 0,
      }
    }
    const failed = Number(out.failed)
    return {
      ...asRun(command, '', String(out.output ?? ''), 0, false, failed > 0),
      passed: Number(out.run) - failed,
      failed,
    }
  }
  const { runOwnTests } = await import('/api/sandbox.ts')
  return runOwnTests(files)
}

/** syntax errors of Python, type errors of TypeScript: shown in the editor */
export const checkProgram = async (
  language: Language,
  files: CandidateFiles,
): Promise<CodeProblem[]> => {
  assertFiles(files)
  if (language === 'python') {
    const out = await pyJob({ mode: 'check', files }, 20_000)
    const problems = (out?.problems as Omit<CodeProblem, 'code'>[]) ?? []
    return problems.map((p) => ({ ...p, code: 'python-syntax' }))
  }
  const { checkTypes } = await import('/api/sandbox.ts')
  return checkTypes(files)
}
