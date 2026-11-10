import { WebAuthnError } from '@simplewebauthn/browser'
import { ApiFailure } from './api'
import { getState } from './store'
import { hasKey, t } from './i18n'

const locale = (): string => (getState().lang === 'zh' ? 'zh-CN' : 'en')

export const fmtTime = (ts: number): string => {
  const d = new Date(ts)
  const sameDay = d.toDateString() === new Date().toDateString()
  return new Intl.DateTimeFormat(locale(), sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d)
}

export const fmtDate = (ts: number): string => new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts))

export const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/** Every failure a person can see, as a sentence in their language. */
export const errText = (e: unknown): string => {
  if (e instanceof ApiFailure) {
    const key = `err.${e.code}`
    return hasKey(key) ? t(key) : t('err.other', { code: e.code })
  }
  if (e instanceof WebAuthnError || (e instanceof Error && e.name === 'NotAllowedError')) return t('err.passkey')
  return t('err.other', { code: e instanceof Error ? e.name : 'unknown' })
}

export const isCode = (e: unknown, code: ApiFailure['code']): boolean => e instanceof ApiFailure && e.code === code

export const base64UrlToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export const isIOS = (): boolean => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1)
export const isStandalone = (): boolean => matchMedia('(display-mode: standalone)').matches || ('standalone' in navigator && navigator.standalone === true)
export const finePointer = (): boolean => matchMedia('(pointer: fine)').matches

// -- line diff (longest common subsequence) ------------------------------------------

export type DiffLine = { op: ' ' | '+' | '-'; text: string }
const DIFF_CELLS = 4_000_000

/** Null when the texts are too large to compare cell by cell. */
export const lineDiff = (before: string, after: string): DiffLine[] | null => {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const [n, m] = [endA - start, endB - start]
  if (n * m > DIFF_CELLS) return null
  // lcs[i * w + j]: length of the LCS of a[start+i..endA) and b[start+j..endB)
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[start + i] === b[start + j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)
    }
  }
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ op: ' ', text }))
  let [i, j] = [0, 0]
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) { out.push({ op: ' ', text: a[start + i]! }); i++; j++ }
    else if (j < m && (i === n || lcs[i * w + j + 1]! >= lcs[(i + 1) * w + j]!)) out.push({ op: '+', text: b[start + j++]! })
    else out.push({ op: '-', text: a[start + i++]! })
  }
  for (const text of a.slice(endA)) out.push({ op: ' ', text })
  return out
}
