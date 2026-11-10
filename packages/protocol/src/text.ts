import { LIMITS } from './events'
import { err, ok, type Result } from './result'

/** Length in Unicode code points: the unit budgets and limits are stated in. */
export const charCount = (text: string): number => {
  let n = 0
  for (const _ of text) n++
  return n
}

export const byteLength = (text: string): number => new TextEncoder().encode(text).length

const FORBIDDEN_IN_HANDLE = /[\s@\p{Cc}\p{Cf}\p{Co}\p{Cs}#:,/\\]/u

/** Canonical display form of a handle, or `handle_invalid`. */
export const normalizeHandle = (raw: string): Result<string> => {
  const handle = raw.normalize('NFKC').trim()
  const n = charCount(handle)
  return n < 1 || n > LIMITS.handle || FORBIDDEN_IN_HANDLE.test(handle)
    ? err('handle_invalid')
    : ok(handle)
}

/** Key under which two handles collide. */
export const handleKey = (handle: string): string => handle.normalize('NFKC').toLowerCase()

export const normalizeTopic = (raw: string): Result<string> => {
  const topic = raw.normalize('NFC').replace(/\s+/g, ' ').trim()
  const n = charCount(topic)
  return n < 1 || n > LIMITS.topic ? err('bad_request', 'topic') : ok(topic)
}
