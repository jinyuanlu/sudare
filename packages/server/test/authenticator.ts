// A software WebAuthn authenticator: enough of CTAP2 to register a passkey
// (attestation "none") and sign assertions with ES256, so the tests exercise
// the real verification code.

const enc = new TextEncoder()
const b64url = (b: ArrayBuffer | Uint8Array) => {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b)
  return btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0)
  return out
}
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))

// Minimal CBOR: unsigned/negative ints, byte strings, text strings, maps.
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>
const head = (major: number, n: number): Uint8Array =>
  n < 24 ? Uint8Array.of((major << 5) | n)
  : n < 256 ? Uint8Array.of((major << 5) | 24, n)
  : Uint8Array.of((major << 5) | 25, n >> 8, n & 255)
const cbor = (v: Cbor): Uint8Array => {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (typeof v === 'string') return concat(head(3, enc.encode(v).length), enc.encode(v))
  if (v instanceof Uint8Array) return concat(head(2, v.length), v)
  return concat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]))
}

/** WebCrypto signs as r||s; WebAuthn wants ASN.1 DER. */
const der = (raw: Uint8Array): Uint8Array => {
  const int = (x: Uint8Array) => {
    let i = 0
    while (i < x.length - 1 && x[i] === 0) i++
    const t = x.slice(i)
    const body = t[0]! & 0x80 ? concat(Uint8Array.of(0), t) : t
    return concat(Uint8Array.of(0x02, body.length), body)
  }
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)))
  return concat(Uint8Array.of(0x30, body.length), body)
}

export type Authenticator = {
  create(options: { challenge: string; rp: { id?: string }; user: { id: string } }): Promise<Record<string, unknown>>
  get(options: { challenge: string; rpId?: string }): Promise<Record<string, unknown>>
}

export const authenticator = (origin: string): Authenticator => {
  let key: CryptoKeyPair | null = null
  let userHandle = ''
  let counter = 0
  const id = crypto.getRandomValues(new Uint8Array(16))
  const clientData = (type: string, challenge: string) => enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  const authData = async (rpId: string, attested: Uint8Array | null) =>
    concat(
      await sha256(enc.encode(rpId)),
      Uint8Array.of(attested ? 0x45 : 0x05), // user present + verified (+ attested credential data)
      Uint8Array.of(0, 0, 0, ++counter),
      attested ?? new Uint8Array(),
    )
  return {
    async create(options) {
      key = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
      userHandle = options.user.id
      const jwk = (await crypto.subtle.exportKey('jwk', key.publicKey)) as JsonWebKey
      const cose = cbor(new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, unb64url(jwk.x!)], [-3, unb64url(jwk.y!)]]))
      const attested = concat(new Uint8Array(16), Uint8Array.of(0, id.length), id, cose)
      const auth = await authData(options.rp.id ?? new URL(origin).hostname, attested)
      const attestationObject = cbor(new Map<string, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', auth]]))
      return {
        id: b64url(id), rawId: b64url(id), type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: b64url(clientData('webauthn.create', options.challenge)), attestationObject: b64url(attestationObject), transports: ['internal'] },
      }
    },
    async get(options) {
      if (!key) throw new Error('no credential')
      const client = clientData('webauthn.get', options.challenge)
      const auth = await authData(options.rpId ?? new URL(origin).hostname, null)
      const signed = concat(auth, await sha256(client))
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, signed))
      return {
        id: b64url(id), rawId: b64url(id), type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: b64url(client), authenticatorData: b64url(auth), signature: b64url(der(sig)), userHandle },
      }
    },
  }
}
