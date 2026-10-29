// Shared by the editor and the API: which files of a candidate are tests.

/**
 * The tests of the candidate, as `deno test` (`test.ts`, `x_test.ts`,
 * `x.test.ts`, and the js/tsx variants) and `unittest` (`test_x.py`,
 * `x_test.py`) find them.
 */
export const isTestFile = (path: string) =>
  /(^|\/)(test_[^/]+\.py|[^/]+_test\.py|([^/]*[._])?test\.(ts|tsx|js|jsx|mjs))$/
    .test(path)
