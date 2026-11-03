import { eq, test } from '/api/lib/test.ts'
import { codeFilesKey, isTestFile } from '/web/lib/test-file.ts'

test('test files', async (step) => {
  await step('the files deno test and unittest find', () => {
    for (
      const path of [
        'src/app_test.ts',
        'src/app.test.ts',
        'src/test.ts',
        'src/app.test.js',
        'src/links_test.tsx',
        'test_main.py',
        'tests/test_links.py',
        'main_test.py',
      ]
    ) eq([path, isTestFile(path)], [path, true])
  })

  await step('the code and the notes are not tests', () => {
    for (
      const path of [
        'src/app.ts',
        'src/contest.ts',
        'src/latest.ts',
        'src/testing.ts',
        'main.py',
        'playground.ts',
        'README.md',
      ]
    ) eq([path, isTestFile(path)], [path, false])
  })
})

test('test results: code identity ignores notes and file ordering', async (step) => {
  const files = { 'src/app.ts': 'export const x = 1', 'deno.json': '{}' }
  await step('reordering or editing notes keeps the same identity', () => {
    eq(
      codeFilesKey(files),
      codeFilesKey({
        'README.md': 'Updated notes',
        'deno.json': '{}',
        'src/app.ts': files['src/app.ts'],
      }),
    )
  })
  await step('code, tests and configuration changes invalidate results', () => {
    for (
      const change of [
        { 'src/app.ts': 'export const x = 2' },
        { 'src/app_test.ts': 'Deno.test("new", () => {})' },
        { 'main.py': 'print(1)' },
        { 'deno.json': '{"imports":{}}' },
      ]
    ) eq(codeFilesKey(files) === codeFilesKey({ ...files, ...change }), false)
  })
})
