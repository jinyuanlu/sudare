import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

export type Loaded<T> = { data: T | undefined; error: unknown; loading: boolean; reload: () => void; set: (v: T) => void }

/** Fetch on mount and when deps change. Keeps the previous data while reloading. */
export const useLoad = <T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> => {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({ data: undefined, error: null, loading: true })
  const [n, setN] = useState(0)
  const key = JSON.stringify(deps)
  const last = useRef<string | null>(null)
  useEffect(() => {
    let alive = true
    const reset = last.current !== key
    last.current = key
    setState((s) => ({ data: reset ? undefined : s.data, error: null, loading: true }))
    load().then(
      (data) => { if (alive) setState({ data, error: null, loading: false }) },
      (error: unknown) => { if (alive) setState((s) => ({ data: s.data, error, loading: false })) },
    )
    return () => { alive = false }
  }, [key, n])
  const reload = useCallback(() => setN((x) => x + 1), [])
  const set = useCallback((data: T) => setState({ data, error: null, loading: false }), [])
  return { ...state, reload, set }
}

export type Action = { busy: boolean; error: unknown; run: (f: () => Promise<void>) => Promise<boolean>; clear: () => void }

/** One in-flight user action with its error. Resolves true when it succeeded. */
export const useAction = (): Action => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const run = useCallback(async (f: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await f()
      return true
    } catch (e) {
      if (alive.current) setError(e)
      return false
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [])
  return { busy, error, run, clear: useCallback(() => setError(null), []) }
}

export const useNow = (everyMs: number, active = true): number => {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs, active])
  return now
}

export const useVisible = (): boolean => {
  const [visible, setVisible] = useState(document.visibilityState === 'visible')
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}
