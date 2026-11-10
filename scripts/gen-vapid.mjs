#!/usr/bin/env node
// Generates the VAPID key pair for Web Push.
//   VAPID_PUBLIC_KEY  -> wrangler.jsonc "vars" (it is public; browsers receive it)
//   VAPID_PRIVATE_KEY -> `wrangler secret put VAPID_PRIVATE_KEY`
import { webcrypto } from 'node:crypto'

const b64url = (b) => Buffer.from(b).toString('base64url')
const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey)
const raw = await webcrypto.subtle.exportKey('raw', pair.publicKey)

console.log(`VAPID_PUBLIC_KEY=${b64url(raw)}`)
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`)
