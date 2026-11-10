// Passkeys (WebAuthn). The only way a person proves who they are.
//
// `PasskeyProof` can only be constructed in this module (its brand is a
// module-private symbol), and `issueSession` demands one. So "a human session
// exists only after a passkey ceremony" (I6) is checked by the compiler.

import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { newPrincipalId, err, ok, type InviteId, type PrincipalId, type Result } from '@sudare/protocol'
import { origin, type Env } from '../env'
import { b64url, unb64url } from '../util'

const proven: unique symbol = Symbol('passkey')
export type PasskeyProof = { readonly [proven]: true; readonly principal: PrincipalId }
const proof = (principal: PrincipalId): PasskeyProof => ({ [proven]: true, principal })

type Purpose = 'register' | 'login' | 'link' | 'add'
type Challenge = { challenge: string; purpose: Purpose; subject: string | null }
type CredentialRow = { id: string; principal: PrincipalId; public_key: string; counter: number; transports: string | null }

const CHALLENGE_TTL = 5 * 60_000
const rp = (env: Env) => ({ id: new URL(origin(env)).hostname, origin: origin(env), name: 'Sudare' })

const remember = async (env: Env, challenge: string, purpose: Purpose, subject: string | null): Promise<string> => {
  const id = b64url(crypto.getRandomValues(new Uint8Array(16)))
  await env.DB.prepare(`INSERT INTO challenges (id, challenge, purpose, subject, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, challenge, purpose, subject, Date.now() + CHALLENGE_TTL).run()
  return id
}

/** One use only: the row is deleted as it is read. */
const recall = async (env: Env, id: string, purpose: Purpose): Promise<Challenge | null> => {
  const row = await env.DB.prepare(`DELETE FROM challenges WHERE id = ? AND purpose = ? AND expires_at > ? RETURNING challenge, purpose, subject`)
    .bind(id, purpose, Date.now()).first<Challenge>()
  return row ?? null
}

const credentialsOf = async (env: Env, p: PrincipalId): Promise<CredentialRow[]> =>
  (await env.DB.prepare(`SELECT * FROM credentials WHERE principal = ?`).bind(p).all<CredentialRow>()).results

const creation = (env: Env, principal: PrincipalId, exclude: CredentialRow[]) =>
  generateRegistrationOptions({
    rpName: rp(env).name,
    rpID: rp(env).id,
    userName: `sudare-${principal.slice(-6).toLowerCase()}`,
    userDisplayName: 'Sudare',
    userID: new TextEncoder().encode(principal) as Uint8Array<ArrayBuffer>,
    attestationType: 'none',
    excludeCredentials: exclude.map((c) => ({ id: c.id })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  })

const storeCredential = async (env: Env, principal: PrincipalId, challenge: string, response: unknown): Promise<Result<null>> => {
  const v = await verifyRegistrationResponse({
    response: response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
    expectedChallenge: challenge, expectedOrigin: rp(env).origin, expectedRPID: rp(env).id, requireUserVerification: true,
  }).catch(() => null)
  if (!v?.verified) return err('unauthenticated')
  const c = v.registrationInfo.credential
  await env.DB.prepare(`INSERT INTO credentials (id, principal, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(c.id, principal, b64url(c.publicKey), c.counter, JSON.stringify(c.transports ?? []), Date.now()).run()
  return ok(null)
}

/** Registration is only offered to the holder of a valid invitation link. */
export const registerOptions = async (env: Env, invite: InviteId) => {
  const principal = newPrincipalId()
  const options = await creation(env, principal, [])
  return { id: await remember(env, options.challenge, 'register', `${principal}|${invite}`), options }
}

export const registerVerify = async (
  env: Env, id: string, response: unknown,
): Promise<Result<{ proof: PasskeyProof; invite: InviteId }>> => {
  const ch = await recall(env, id, 'register')
  if (!ch?.subject) return err('unauthenticated')
  const [principal, invite] = ch.subject.split('|') as [PrincipalId, InviteId]
  // The principal row must exist before the credential row that references it.
  await env.DB.prepare(`INSERT INTO principals (id, invited_via, created_at) VALUES (?, ?, ?)`).bind(principal, invite, Date.now()).run()
  const stored = await storeCredential(env, principal, ch.challenge, response)
  if (!stored.ok) {
    await env.DB.prepare(`DELETE FROM principals WHERE id = ?`).bind(principal).run()
    return stored
  }
  return ok({ proof: proof(principal), invite })
}

export const addOptions = async (env: Env, principal: PrincipalId) => {
  const options = await creation(env, principal, await credentialsOf(env, principal))
  return { id: await remember(env, options.challenge, 'add', principal), options }
}

export const addVerify = async (env: Env, principal: PrincipalId, id: string, response: unknown): Promise<Result<null>> => {
  const ch = await recall(env, id, 'add')
  return ch?.subject === principal ? storeCredential(env, principal, ch.challenge, response) : err('unauthenticated')
}

/** `expect`: when set, only this principal's passkeys are offered and accepted. */
export const assertOptions = async (env: Env, purpose: 'login' | 'link', expect: PrincipalId | null, subject: string | null = null) => {
  const allow = expect ? await credentialsOf(env, expect) : []
  const options = await generateAuthenticationOptions({
    rpID: rp(env).id, userVerification: 'required',
    ...(expect ? { allowCredentials: allow.map((c) => ({ id: c.id })) } : {}),
  })
  return { id: await remember(env, options.challenge, purpose, subject ?? expect), options }
}

export const assertVerify = async (
  env: Env, purpose: 'login' | 'link', id: string, response: unknown,
): Promise<Result<{ proof: PasskeyProof; subject: string | null }>> => {
  const ch = await recall(env, id, purpose)
  const credentialId = (response as { id?: unknown } | null)?.id
  if (!ch || typeof credentialId !== 'string') return err('unauthenticated')
  const row = await env.DB.prepare(`SELECT * FROM credentials WHERE id = ?`).bind(credentialId).first<CredentialRow>()
  if (!row) return err('unauthenticated')
  const v = await verifyAuthenticationResponse({
    response: response as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
    expectedChallenge: ch.challenge, expectedOrigin: rp(env).origin, expectedRPID: rp(env).id, requireUserVerification: true,
    credential: {
      id: row.id, publicKey: unb64url(row.public_key) as Uint8Array<ArrayBuffer>, counter: row.counter,
      transports: JSON.parse(row.transports ?? '[]'),
    },
  }).catch(() => null)
  if (!v?.verified) return err('unauthenticated')
  await env.DB.prepare(`UPDATE credentials SET counter = ?, last_used = ? WHERE id = ?`).bind(v.authenticationInfo.newCounter, Date.now(), row.id).run()
  return ok({ proof: proof(row.principal), subject: ch.subject })
}
