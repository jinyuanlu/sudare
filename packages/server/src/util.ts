import { err, ok, type Err, type Result } from '@sudare/protocol'

export const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of u8) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const unb64url = (text: string): Uint8Array => {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

export const sha256 = async (text: string): Promise<string> =>
  b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

export const randomToken = (prefix: string, bytes = 32): string =>
  `${prefix}_${b64url(crypto.getRandomValues(new Uint8Array(bytes)))}`

export const timingSafeEqual = (a: string, b: string): boolean => {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!
  return diff === 0
}

/** Unwraps a Result or throws the Err; `Fail` carries it to the HTTP edge. */
export class Fail extends Error {
  constructor(readonly err: Err) {
    super(err.error)
  }
}

export const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Fail(r)
  return r.value
}

export const fail = (...args: Parameters<typeof err>): never => {
  throw new Fail(err(...args))
}

export { err, ok }
