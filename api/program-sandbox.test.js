// The "program" assessment against the real sandbox: TypeScript in a `deno`
// subprocess, Python in Pyodide. No model is involved.
import { eq, test } from '/api/lib/test.ts'
import {
  checkProgram,
  normalizeOutput,
  runProgram,
  runProgramCases,
  runProgramOwnTests,
} from '/api/program-sandbox.ts'

const sum = [
  { id: 'T1', stdin: '3\n4\n5\n', expected: '12' },
  { id: 'T2', stdin: '10\n', expected: '10\n' },
  { id: 'T3', stdin: '', expected: '0' },
]

const tsSum = {
  'src/main.ts': `const text = await new Response(Deno.stdin.readable).text()
const total = text.split('\\n').filter(Boolean).reduce((n, l) => n + Number(l), 0)
console.log(total)
`,
}

const pySum = {
  'main.py': `import sys
print(sum(int(l) for l in sys.stdin if l.strip()))
`,
}

test('output comparison', async (step) => {
  await step('line ends and trailing spaces do not matter', () => {
    eq(normalizeOutput('a  \r\nb\n\n'), 'a\nb')
    eq(normalizeOutput(''), '')
  })
  await step('the words do', () => {
    eq(normalizeOutput('a b') === normalizeOutput('ab'), false)
  })
})

test('program: TypeScript', async (step) => {
  await step('a right program passes every case', async () => {
    const results = await runProgramCases('typescript', tsSum, sum)
    eq(results.map((r) => r.passed), [true, true, true])
  })

  await step('a wrong program fails, and says what it printed', async () => {
    const wrong = {
      'src/main.ts': 'console.log("nothing useful")\n',
    }
    const results = await runProgramCases('typescript', wrong, sum)
    eq(results.map((r) => r.passed), [false, false, false])
    eq(results[0].received, 'nothing useful')
    eq(results[0].expected, '12')
    eq(results[0].request, '3\n4\n5\n')
  })

  await step('a loop is stopped, the other cases still run', async () => {
    const loops = {
      'src/main.ts':
        `const text = await new Response(Deno.stdin.readable).text()
if (text.startsWith('10')) while (true) {}
console.log(text.split('\\n').filter(Boolean).reduce((n, l) => n + Number(l), 0))
`,
    }
    const results = await runProgramCases('typescript', loops, sum)
    eq(results.map((r) => r.passed), [true, false, true])
    eq(results[1].received.startsWith('Stopped after'), true)
  })

  await step('a crash is reported', async () => {
    const crash = { 'src/main.ts': 'throw new Error("boom")\n' }
    const [first] = await runProgramCases('typescript', crash, sum)
    eq(first.passed, false)
    eq(first.received.includes('boom'), true)
  })

  await step('no network, no files outside, no environment', async () => {
    const probe = {
      'src/main.ts': `const tried = []
for (const [name, fn] of [
  ['net', () => fetch('http://example.com')],
  ['env', () => Deno.env.get('PATH')],
  ['read', () => Deno.readTextFileSync('/etc/hosts')],
  ['write', () => Deno.writeTextFileSync('x.txt', 'x')],
]) {
  try { await fn(); tried.push(name + ' allowed') } catch { tried.push(name + ' refused') }
}
console.log(tried.join(','))
`,
    }
    const [first] = await runProgramCases('typescript', probe, [
      { id: 'T1', stdin: '', expected: '' },
    ])
    eq(
      first.received,
      'net refused,env refused,read refused,write refused',
    )
  })

  await step('"Run" shows the output as it came', async () => {
    const run = await runProgram('typescript', tsSum, '1\n2\n')
    eq(run.chunks.map((c) => c.text).join(''), '3\n')
    eq(run.exitCode, 0)
  })

  await step('an import outside the workspace is refused', async () => {
    const outside = { 'src/main.ts': 'import "https://example.com/x.ts"\n' }
    const results = await runProgramCases('typescript', outside, sum)
    eq(results[0].received.startsWith('Import not allowed'), true)
  })
})

test('program: Python', async (step) => {
  await step('a right program passes every case', async () => {
    const results = await runProgramCases('python', pySum, sum)
    eq(results.map((r) => r.passed), [true, true, true])
  })

  await step('a wrong program fails, and says what it printed', async () => {
    const results = await runProgramCases(
      'python',
      { 'main.py': 'print("nothing useful")\n' },
      sum,
    )
    eq(results.map((r) => r.passed), [false, false, false])
    eq(results[0].received, 'nothing useful')
    eq(results[0].expected, '12')
  })

  await step('a loop is stopped, the other cases still run', async () => {
    const loops = {
      'main.py': `import sys
data = sys.stdin.read()
if data.startswith('10'):
    while True:
        pass
print(sum(int(l) for l in data.split() if l))
`,
    }
    const results = await runProgramCases('python', loops, sum)
    eq(results.map((r) => r.passed), [true, false, true])
    eq(results[1].received.startsWith('Stopped after'), true)
  })

  await step('an exception is reported with its message', async () => {
    const [first] = await runProgramCases(
      'python',
      { 'main.py': 'raise ValueError("boom")\n' },
      sum,
    )
    eq(first.passed, false)
    eq(first.received.includes('boom'), true)
  })

  await step('a case does not see the state of the one before', async () => {
    const state = {
      'main.py': `import counter
counter.n += 1
print(counter.n)
`,
      'counter.py': 'n = 0\n',
    }
    const results = await runProgramCases('python', state, [
      { id: 'T1', stdin: '', expected: '1' },
      { id: 'T2', stdin: '', expected: '1' },
    ])
    eq(results.map((r) => r.passed), [true, true])
  })

  await step('a module of the candidate can be imported', async () => {
    const two = {
      'main.py': 'from util import double\nprint(double(21))\n',
      'util.py': 'def double(x):\n    return x * 2\n',
    }
    const [first] = await runProgramCases('python', two, [
      { id: 'T1', stdin: '', expected: '42' },
    ])
    eq(first.passed, true)
  })

  await step(
    'it cannot reach the network or the disk of the machine',
    async () => {
      const probe = {
        'main.py': `import urllib.request, os
out = []
try:
    urllib.request.urlopen("http://example.com", timeout=3)
    out.append("net allowed")
except Exception:
    out.append("net refused")
out.append("hosts " + str(os.path.exists("/etc/hosts")))
try:
    out.append("home " + str(os.path.exists("C:/Users")))
except Exception:
    out.append("home refused")
print(",".join(out))
`,
      }
      const [first] = await runProgramCases('python', probe, [
        { id: 'T1', stdin: '', expected: '' },
      ])
      eq(first.received, 'net refused,hosts False,home False')
    },
  )

  await step('"Run" shows the output and the error', async () => {
    const run = await runProgram('python', pySum, '1\n2\n')
    eq(run.chunks.map((c) => c.text).join(''), '3\n')
    const bad = await runProgram('python', { 'main.py': '1/0\n' }, '')
    eq(bad.exitCode, 1)
    eq(bad.chunks.some((c) => c.text.includes('ZeroDivisionError')), true)
  })

  await step('a syntax error is found with its line', async () => {
    const problems = await checkProgram('python', {
      'main.py': 'print("ok")\nif True print("no")\n',
    })
    eq(problems.length, 1)
    eq(problems[0].file, 'main.py')
    eq(problems[0].line, 2)
    eq(problems[0].code, 'python-syntax')
    eq(await checkProgram('python', pySum), [])
  })

  await step(
    'the tests the candidate wrote are run with unittest',
    async () => {
      const own = await runProgramOwnTests('python', {
        'main.py': 'def double(x):\n    return x * 2\n',
        'test_main.py': `import unittest
from main import double

class T(unittest.TestCase):
    def test_ok(self):
        self.assertEqual(double(2), 4)

    def test_bad(self):
        self.assertEqual(double(2), 5)
`,
      })
      eq([own.passed, own.failed], [1, 1])
    },
  )
})
