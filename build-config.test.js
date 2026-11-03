import { assertEquals } from 'jsr:@std/assert'
import { build, stop } from 'npm:esbuild'
import { config } from './build-config.ts'

Deno.test('browser bundle uses the pinned Preact version for hooks and rendering', async () => {
  try {
    const result = await build({
      ...config,
      entryPoints: { index: 'web/debug-app.ts' },
      metafile: true,
      write: false,
    })
    const versions = Object.keys(result.metafile.inputs).flatMap((path) => {
      const match = path.match(/preact@([^/]+)\/node_modules\/preact\//)
      return match ? [match[1]] : []
    })
    const { imports } = JSON.parse(await Deno.readTextFile('deno.json'))
    assertEquals([...new Set(versions)], [
      imports.preact.slice('npm:preact@'.length),
    ])
  } finally {
    stop()
  }
})
