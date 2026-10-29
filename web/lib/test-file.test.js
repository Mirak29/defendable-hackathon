import { eq, test } from '/api/lib/test.ts'
import { isTestFile } from '/web/lib/test-file.ts'

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
