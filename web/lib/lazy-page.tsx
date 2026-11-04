// Pages loaded on demand: a visitor downloads the landing, a candidate the
// candidate journey, a recruiter the company space. Opening a page of a group
// fetches the other pages of that group while the browser is idle, so the next
// step of a journey opens without a wait.
import { signal } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { Spinner } from '/web/ui/spinner.tsx'

type Page = () => JSX.Element | null
type Loader = () => Promise<Page>

// After a deployment, an open tab may ask for chunks that no longer exist:
// one reload fetches the new build. A second failure is shown instead.
const RELOAD_KEY = 'dfd-chunk-reload'
const recover = (error: unknown): Promise<never> => {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (Date.now() - last > 60_000) {
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
      location.reload()
      return new Promise<never>(() => {}) // the page is going away
    }
  } catch { /* no storage: show the error */ }
  throw error
}

const idle = (fn: () => void) =>
  'requestIdleCallback' in globalThis
    ? requestIdleCallback(fn, { timeout: 3000 })
    : setTimeout(fn, 500)

/** a short wait shows nothing; a longer one shows a spinner */
const Waiting = () => {
  const [late, setLate] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), 300)
    return () => clearTimeout(timer)
  }, [])
  return (
    <main tw='flex-1 flex items-center justify-center py-16'>
      {late && <Spinner tw='w-5 h-5' />}
    </main>
  )
}

const Failed = () => (
  <main tw='flex-1 flex items-center justify-center px-4 py-16'>
    <p role='alert' tw='m-0 text-[14px] text-content-secondary text-center'>
      This page could not be loaded. Check the connection, then{' '}
      <button
        type='button'
        tw='btn btn-secondary h-8 px-3 ml-1'
        onClick={() => location.reload()}
      >
        reload
      </button>
    </p>
  </main>
)

/** one component per page of the group, each loading its own code */
export const lazyPages = <K extends string>(
  group: Record<K, Loader>,
): Record<K, Page> => {
  const loaded = new Map<K, ReturnType<typeof signal<Page | 'failed'>>>()
  const promises = new Map<K, Promise<void>>()
  const load = (key: K) => {
    if (!promises.has(key)) {
      const state = loaded.get(key)!
      promises.set(
        key,
        group[key]().catch(recover).then(
          (page) => void (state.value = page),
          () => void (state.value = 'failed'),
        ),
      )
    }
    return promises.get(key)!
  }
  const keys = Object.keys(group) as K[]
  for (const key of keys) loaded.set(key, signal<Page | 'failed'>())
  return Object.fromEntries(keys.map((key) => {
    const Lazy: Page = () => {
      const page = loaded.get(key)!.value
      useEffect(() => {
        load(key).then(() => idle(() => keys.forEach(load)))
      }, [])
      if (page === 'failed') return <Failed />
      if (!page) return <Waiting />
      const Loaded = page
      return <Loaded />
    }
    return [key, Lazy]
  })) as Record<K, Page>
}
