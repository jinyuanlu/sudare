// Web Push without a payload: the notification says only "something is
// waiting", never who wrote or what. No payload also means no RFC 8291
// encryption, just a VAPID (RFC 8292) JWT.

import { origin, type Env } from './env'
import { b64url, unb64url } from './util'

const PUSH_HOSTS = [
  'fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com',
  '.notify.windows.com', '.push.apple.com', '.push.services.mozilla.com',
]

/** Push endpoints are client supplied; only known push services are ever fetched. */
export const validPushEndpoint = (endpoint: string): boolean => {
  try {
    const url = new URL(endpoint)
    return url.protocol === 'https:' && PUSH_HOSTS.some((h) => (h.startsWith('.') ? url.hostname.endsWith(h) : url.hostname === h))
  } catch {
    return false
  }
}

const signingKey = (env: Env): Promise<CryptoKey> => {
  const point = unb64url(env.VAPID_PUBLIC_KEY) // uncompressed P-256 point: 0x04 || x || y
  const jwk = { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY!, x: b64url(point.slice(1, 33)), y: b64url(point.slice(33, 65)) }
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

const vapidJwt = async (env: Env, audience: string): Promise<string> => {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const sub = env.VAPID_SUBJECT || origin(env)
  const head = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub })}`
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(env), new TextEncoder().encode(head))
  return `${head}.${b64url(sig)}`
}

export const pushConfigured = (env: Env): boolean => !!env.VAPID_PUBLIC_KEY && !!env.VAPID_PRIVATE_KEY

export const sendPush = async (env: Env, endpoint: string): Promise<'sent' | 'gone' | 'failed'> => {
  if (!pushConfigured(env) || !validPushEndpoint(endpoint)) return 'failed'
  try {
    const jwt = await vapidJwt(env, new URL(endpoint).origin)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`, TTL: '86400', Urgency: 'high', 'Content-Length': '0' },
    })
    if (res.status === 404 || res.status === 410) return 'gone'
    return res.ok ? 'sent' : 'failed'
  } catch {
    return 'failed'
  }
}
