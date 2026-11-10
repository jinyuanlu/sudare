// The human surface: everything a person does, over HTTP, with a `human`
// session. Agent tokens are not accepted anywhere in this file.

import { Hono, type Context } from 'hono'
import {
  HTTP_STATUS, LIMITS, convOf, isAliasId, isConvId, isDeviceId, isDraftId, isEventId, isInviteId, isNoteId, isRoundId,
  newDeviceId, newEventId, newNoteId, newRoundId, err, ok,
  type AliasId, type AliasRef, type ConvId, type DeviceId, type DraftId, type ErrorCode, type EventId, type InviteId,
  type Me, type NoteId, type PrincipalId, type ReceiptState, type Result, type RoundId,
} from '@sudare/protocol'
import { z } from 'zod'
import { TOKEN_PREFIX, revokeGrants } from '../auth/oauth'
import { addOptions, addVerify, assertOptions, assertVerify, registerOptions, registerVerify } from '../auth/passkey'
import { adoptSession, clearCookie, endDeviceSessions, endSession, issueSession, readSession, sessionCookie, type Session } from '../auth/session'
import { deviceView, directory } from '../directory'
import { origin, type Env } from '../env'
import { pushConfigured } from '../push'
import { acceptInvite, bootstrap, createConv, declineInvite, inviteByCode, inviteCard, inviteLink, inviteMember, inviteOpenTo } from '../services/convs'
import { approveDraft } from '../services/drafts'
import { convStub, principalSocket, principalStub } from '../services/stubs'
import { Fail, randomToken, sha256, timingSafeEqual } from '../util'

type App = { Bindings: Env; Variables: { session: Session } }
type C = Context<App>

const fail = (error: ErrorCode, detail?: unknown): never => {
  throw new Fail(err(error, detail))
}

const send = <T>(c: C, r: Result<T>, status: 200 | 201 = 200) =>
  r.ok ? c.json(r.value as object, status) : c.json({ error: r.error, detail: r.detail }, HTTP_STATUS[r.error] as 400)

/** Parse and validate a JSON body; anything malformed is a plain bad_request. */
const body = async <S extends z.ZodType>(c: C, schema: S): Promise<z.infer<S>> => {
  const parsed = schema.safeParse(await c.req.json().catch(() => null))
  return parsed.success ? parsed.data : fail('bad_request', parsed.error.issues.map((i) => i.path.join('.')).slice(0, 5))
}

const param = <T extends string>(c: C, name: string, check: (v: unknown) => v is T): T => {
  const v = c.req.param(name)
  return check(v) ? v : fail('not_found')
}

const me = (c: C): PrincipalId => c.get('session').principal
const conv = (c: C, id: ConvId) => convStub(c.env, id)
const inbox = (c: C) => principalStub(c.env, me(c))

const zId = <T extends string>(check: (v: unknown) => v is T) => z.string().refine(check) as unknown as z.ZodType<T>
const zEvent = zId(isEventId)
const zAliasRef = z.object({ conv: zId(isConvId), alias: zId(isAliasId) })
const zText = z.string().min(1).max(LIMITS.message * 4)
const zWebAuthn = z.object({ id: z.string().min(1).max(64), response: z.record(z.string(), z.unknown()) })

export const api = new Hono<App>().basePath('/api')

api.onError((e, c) => {
  if (e instanceof Fail) return c.json({ error: e.err.error, detail: e.err.detail }, HTTP_STATUS[e.err.error] as 400)
  console.error('unhandled', e)
  return c.json({ error: 'unavailable' }, 503)
})

api.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})

/**
 * Cross-site request forgery: a cookie-authenticated write must come from our
 * own origin. Bearer-authenticated requests (the plugin) carry no ambient
 * credential and are exempt.
 */
const sameOrigin = (c: C): boolean => c.req.header('Origin') === origin(c.env)

/** A brake on abuse. The binding is optional so local setups without it still run. */
const throttle = async (limiter: RateLimit | undefined, key: string): Promise<void> => {
  if (limiter && !(await limiter.limit({ key })).success) fail('rate_limited')
}
const caller = (c: C): string => c.req.header('CF-Connecting-IP') ?? 'local'

const human = (kinds: Session['kind'][] = ['web', 'plugin']) => async (c: C, next: () => Promise<void>) => {
  const session = await readSession(c.env, c.req.raw)
  if (!session) return fail('unauthenticated')
  if (!kinds.includes(session.kind)) return fail('forbidden_scope')
  if (session.via === 'cookie' && c.req.method !== 'GET' && !sameOrigin(c)) return fail('forbidden_scope', 'origin')
  if (c.req.method !== 'GET') await throttle(c.env.RL_WRITE, session.principal)
  c.set('session', session)
  await next()
}

/** Things only the person's own browser may do, never a plugin-held session. */
const web = human(['web'])
const anyHuman = human()

// -- sign-in ----------------------------------------------------------------------

const publicRead = async (c: C, next: () => Promise<void>) => {
  await throttle(c.env.RL_PUBLIC, caller(c))
  await next()
}

const publicWrite = async (c: C, next: () => Promise<void>) => {
  if (!sameOrigin(c)) return fail('forbidden_scope', 'origin')
  await throttle(c.env.RL_PUBLIC, caller(c))
  await next()
}

const startSession = async (c: C, proof: Parameters<typeof issueSession>[1]) => {
  const s = await issueSession(c.env, proof, 'web', null)
  c.header('Set-Cookie', sessionCookie(s.token, s.expires))
  return c.json({ principal: proof.principal, expires: s.expires })
}

api.get('/join/:code/check', publicRead, async (c) => {
  const i = await inviteByCode(c.env, c.req.param('code') ?? '')
  return c.json({ valid: !!i && i.used_at === null && inviteOpenTo(i, i.bound), registered: !!i?.bound })
})

api.post('/auth/register/options', publicWrite, async (c) => {
  const { code } = await body(c, z.object({ code: z.string().min(16).max(64) }))
  const i = await inviteByCode(c.env, code)
  // Registration exists only as a side effect of holding an unused invitation link.
  if (!i || i.kind === 'direct' || i.used_at !== null || i.bound !== null || !inviteOpenTo(i, null)) return fail('invite_invalid')
  return c.json(await registerOptions(c.env, i.id))
})

api.post('/auth/register/verify', publicWrite, async (c) => {
  const { id, response } = await body(c, zWebAuthn)
  const r = await registerVerify(c.env, id, response)
  if (!r.ok) return send(c, r)
  if ((await directory(c.env).bindInvite(r.value.invite, r.value.proof.principal)) !== 1) {
    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM credentials WHERE principal = ?`).bind(r.value.proof.principal),
      c.env.DB.prepare(`DELETE FROM principals WHERE id = ?`).bind(r.value.proof.principal),
    ])
    return fail('invite_invalid')
  }
  return startSession(c, r.value.proof)
})

api.post('/auth/login/options', publicWrite, async (c) => c.json(await assertOptions(c.env, 'login', null)))

api.post('/auth/login/verify', publicWrite, async (c) => {
  const { id, response } = await body(c, zWebAuthn)
  const r = await assertVerify(c.env, 'login', id, response)
  return r.ok ? startSession(c, r.value.proof) : send(c, r)
})

api.post('/auth/logout', async (c) => {
  await endSession(c.env, c.req.raw)
  c.header('Set-Cookie', clearCookie())
  return c.json({})
})

api.get('/me', anyHuman, async (c) => {
  const p = await directory(c.env).principal(me(c))
  const out: Me = {
    principal: me(c), default_handle: p?.default_handle ?? null, session_expires: c.get('session').expires,
    vapid_key: pushConfigured(c.env) ? c.env.VAPID_PUBLIC_KEY : null,
  }
  return c.json(out)
})

api.post('/passkeys/options', web, async (c) => c.json(await addOptions(c.env, me(c))))
api.post('/passkeys/verify', web, async (c) => {
  const { id, response } = await body(c, zWebAuthn)
  return send(c, await addVerify(c.env, me(c), id, response))
})

// -- the plugin's in-memory human session ------------------------------------------
// The plugin generates a secret and sends only its hash (through its agent
// connection, which pins the request to one principal). The person confirms
// with a passkey in their browser; that ceremony, and nothing else, turns the
// hash into a session. The secret itself never leaves the plugin's memory
// until it is used as a bearer token.

type LinkRow = { id: string; principal: PrincipalId; device: DeviceId; challenge: string; expires_at: number; confirmed_at: number | null }
const linkRow = async (c: C, id: string): Promise<LinkRow> => {
  const row = await c.env.DB.prepare(`SELECT * FROM human_links WHERE id = ? AND expires_at > ?`).bind(id, Date.now()).first<LinkRow>()
  return row ?? fail('not_found')
}

api.get('/link/:id/status', async (c) => {
  await throttle(c.env.RL_WRITE, `link:${c.req.param('id')}`)
  const row = await linkRow(c, c.req.param('id') ?? '')
  return c.json({ confirmed: row.confirmed_at !== null, expires: row.expires_at })
})

api.get('/link/:id', web, async (c) => {
  if (c.env.PLUGIN_HUMAN_SESSION === 'off') return fail('not_found')
  const row = await linkRow(c, c.req.param('id') ?? '')
  // A link started by someone else's device is indistinguishable from one that does not exist.
  if (row.principal !== me(c)) return fail('not_found')
  const device = await directory(c.env).device(row.device)
  return c.json({ device: device?.name ?? 'unknown', code: row.challenge.slice(0, 6).toUpperCase(), confirmed: row.confirmed_at !== null, expires: row.expires_at })
})

api.post('/link/:id/options', web, async (c) => {
  const row = await linkRow(c, c.req.param('id') ?? '')
  if (row.principal !== me(c) || row.confirmed_at !== null) return fail('not_found')
  return c.json(await assertOptions(c.env, 'link', me(c), row.id))
})

api.post('/link/:id/confirm', web, async (c) => {
  const row = await linkRow(c, c.req.param('id') ?? '')
  const { id, response } = await body(c, zWebAuthn)
  const r = await assertVerify(c.env, 'link', id, response)
  if (!r.ok) return send(c, r)
  if (r.value.subject !== row.id || r.value.proof.principal !== row.principal || row.principal !== me(c)) return fail('unauthenticated')
  const claimed = await c.env.DB.prepare(`UPDATE human_links SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL`).bind(Date.now(), row.id).run()
  if ((claimed.meta.changes ?? 0) !== 1) return fail('not_found')
  const s = await adoptSession(c.env, r.value.proof, row.challenge, 'plugin', row.device)
  return c.json({ expires: s.expires })
})

// -- sync and live updates ---------------------------------------------------------

api.get('/sync', anyHuman, async (c) => {
  const raw = c.req.query('since')
  const since = raw === undefined ? null : Number(raw)
  if (since !== null && (!Number.isInteger(since) || since < 0)) return fail('bad_request', 'since')
  return c.json(await inbox(c).sync(since))
})

api.get('/ws', anyHuman, async (c) => {
  if (c.get('session').via === 'cookie' && !sameOrigin(c)) return fail('forbidden_scope', 'origin')
  return principalSocket(c.env, me(c), c.req.raw)
})

api.post('/push/subscribe', web, async (c) => {
  const { endpoint } = await body(c, z.object({ endpoint: z.string().url().max(1000) }))
  return send(c, await inbox(c).pushSubscribe(endpoint))
})

api.post('/push/unsubscribe', web, async (c) => {
  const { endpoint } = await body(c, z.object({ endpoint: z.string().max(1000) }))
  await inbox(c).pushUnsubscribe(endpoint)
  return c.json({})
})

// -- conversations ------------------------------------------------------------------

api.get('/convs', anyHuman, async (c) => c.json(await inbox(c).convs()))

api.get('/contacts', anyHuman, async (c) => c.json(await directory(c.env).contacts(me(c))))

api.post('/convs', anyHuman, async (c) => {
  const input = await body(c, z.object({
    topic: z.string().min(1).max(LIMITS.topic * 4),
    members: z.array(zAliasRef).max(LIMITS.members - 1).default([]),
    parent: zId(isConvId).nullable().default(null),
    invite: z.enum(['any_member', 'creator']).default('any_member'),
    handle: z.string().max(100).nullable().default(null),
    first: z.object({ id: zEvent, text: zText }).nullable().default(null),
    dm: z.boolean().default(false),
  }))
  return send(c, await createConv(c.env, me(c), { ...input, members: input.members as AliasRef[], path: { kind: 'human' } }), 201)
})

api.get('/convs/:id', anyHuman, async (c) => send(c, await conv(c, param(c, 'id', isConvId)).view(me(c))))

api.patch('/convs/:id', anyHuman, async (c) => {
  const id = param(c, 'id', isConvId)
  const input = await body(c, z.object({ topic: z.string().min(1).max(LIMITS.topic * 4).optional(), retention_days: z.number().int().optional() }))
  if (input.topic !== undefined) {
    const r = await conv(c, id).exec(id, { t: 'rename', id: newEventId(), principal: me(c), topic: input.topic })
    if (!r.ok) return send(c, err(r.error, r.detail))
  }
  if (input.retention_days !== undefined) {
    const r = await conv(c, id).exec(id, { t: 'set_retention', id: newEventId(), principal: me(c), days: input.retention_days })
    if (!r.ok) return send(c, err(r.error, r.detail))
  }
  return send(c, await conv(c, id).view(me(c)))
})

api.post('/convs/:id/invites', anyHuman, async (c) => {
  const id = param(c, 'id', isConvId)
  const input = await body(c, z.union([z.object({ to: zAliasRef }), z.object({ link: z.literal(true) })]))
  return 'to' in input
    ? send(c, await inviteMember(c.env, me(c), id, input.to as AliasRef).then((r) => (r.ok ? ok({ invite: r.value }) : r)), 201)
    : send(c, await inviteLink(c.env, me(c), id), 201)
})

const simple = (t: 'leave' | 'archive') => async (c: C) => {
  const id = param(c, 'id', isConvId)
  const r = await conv(c, id).exec(id, { t, id: newEventId(), principal: me(c) })
  return send(c, r.ok ? ok({}) : err(r.error, r.detail))
}
api.post('/convs/:id/leave', anyHuman, simple('leave'))
api.post('/convs/:id/archive', anyHuman, simple('archive'))

api.get('/convs/:id/events', anyHuman, async (c) => {
  const num = (k: string) => (c.req.query(k) === undefined ? undefined : Number(c.req.query(k)))
  const q = { before: num('before'), after: num('after'), limit: num('limit') }
  if (Object.values(q).some((v) => v !== undefined && (!Number.isInteger(v) || v < 0))) return fail('bad_request')
  return send(c, await conv(c, param(c, 'id', isConvId)).events(me(c), q))
})

api.post('/convs/:id/messages', anyHuman, async (c) => {
  const id = param(c, 'id', isConvId)
  const input = await body(c, z.object({
    id: zEvent, text: zText, to: z.array(zId(isAliasId)).max(LIMITS.recipients).default([]),
    to_handles: z.array(z.string().max(100)).max(LIMITS.recipients).default([]), cause: zEvent.nullable().default(null),
  }))
  const named = input.to_handles.length > 0 ? await conv(c, id).resolveHandles(me(c), input.to_handles) : ok<AliasId[]>([])
  if (!named.ok) return send(c, named)
  // I1, first gate: a `human` session writes directly.
  const r = await conv(c, id).exec(id, {
    t: 'post', id: input.id, principal: me(c), path: { kind: 'human' }, text: input.text,
    to: [...(input.to as AliasId[]), ...named.value], cause: input.cause,
  })
  return send(c, r.ok ? ok({ event: r.events[0] }) : err(r.error, r.detail), 201)
})

api.post('/convs/:id/read', anyHuman, async (c) => {
  const { seq } = await body(c, z.object({ seq: z.number().int().min(0) }))
  await inbox(c).markRead(param(c, 'id', isConvId), seq)
  return c.json({})
})

// -- invitations --------------------------------------------------------------------

api.get('/invites', anyHuman, async (c) => {
  const [list, self] = await Promise.all([inbox(c).invites(), directory(c.env).principal(me(c))])
  return c.json(list.map((i) => ({ ...i, suggested_handle: self?.default_handle ?? null })))
})

const zHandle = z.object({ handle: z.string().max(100).nullable().default(null) })

api.post('/invites/:id/accept', anyHuman, async (c) => {
  const i = await directory(c.env).invite(param(c, 'id', isInviteId))
  if (!i || i.target !== me(c)) return fail('invite_invalid')
  return send(c, await acceptInvite(c.env, me(c), i, (await body(c, zHandle)).handle))
})

api.post('/invites/:id/decline', anyHuman, async (c) => {
  const i = await directory(c.env).invite(param(c, 'id', isInviteId))
  return send(c, i ? await declineInvite(c.env, me(c), i) : err('invite_invalid'))
})

api.get('/join/:code', anyHuman, async (c) => {
  const i = await inviteByCode(c.env, c.req.param('code') ?? '')
  if (!i || !inviteOpenTo(i, me(c))) return fail('invite_invalid')
  const self = await directory(c.env).principal(me(c))
  return c.json({ ...(await inviteCard(c.env, i)), suggested_handle: self?.default_handle ?? null, joined: i.used_by === me(c) })
})

api.post('/join/:code/accept', anyHuman, async (c) => {
  const i = await inviteByCode(c.env, c.req.param('code') ?? '')
  return send(c, i ? await acceptInvite(c.env, me(c), i, (await body(c, zHandle)).handle) : err('invite_invalid'))
})

// -- addressed messages: read, hand off, done ----------------------------------------

api.get('/inbox', anyHuman, async (c) => c.json(await inbox(c).inbox(c.req.query('all') === '1')))

const act = (action: 'read' | 'handoff' | 'done') => async (c: C) => {
  const msg = param(c, 'msg', isEventId)
  const mode = action === 'handoff' ? (await body(c, z.object({ mode: z.enum(['readonly', 'full']).default('readonly') }))).mode : 'readonly'
  const r = await inbox(c).humanAct(msg, action === 'handoff' ? { a: 'handoff', mode } : { a: action })
  if (!r.ok) return send(c, r)
  // Two-person conversations show receipts; the conversation decides whether this one counts.
  const state: ReceiptState = action === 'handoff' ? 'handed_off' : action
  const id = r.value.conv
  c.executionCtx.waitUntil(conv(c, id).exec(id, { t: 'receipt', id: newEventId(), principal: me(c), of: msg, state }).catch(() => undefined))
  return c.json({ state: r.value.state })
}
api.post('/inbox/:msg/read', anyHuman, act('read'))
api.post('/inbox/:msg/handoff', anyHuman, act('handoff'))
api.post('/inbox/:msg/done', anyHuman, act('done'))

// -- drafts ----------------------------------------------------------------------------

api.get('/drafts', anyHuman, async (c) => {
  const [drafts, devices] = await Promise.all([inbox(c).drafts(c.req.query('all') !== '1'), directory(c.env).devices(me(c))])
  const names = new Map(devices.map((d) => [d.id as string, d.name]))
  return c.json(drafts.map((d) => ({ ...d, device_name: names.get(d.device) ?? 'revoked device' })))
})

api.post('/drafts/:id/approve', anyHuman, async (c) => {
  const { text } = await body(c, z.object({ text: zText.nullable().default(null) }))
  // I1, second gate: a `human` session approves an agent's draft.
  return send(c, await approveDraft(c.env, me(c), param(c, 'id', isDraftId) as DraftId, text))
})

api.post('/drafts/:id/reject', anyHuman, async (c) => send(c, await inbox(c).draftReject(param(c, 'id', isDraftId) as DraftId).then((r) => (r.ok ? ok({}) : r))))

// -- discussion rounds -------------------------------------------------------------------

const zBrief = z.string().max(LIMITS.brief).default('')

api.post('/convs/:id/rounds', anyHuman, async (c) => {
  const id = param(c, 'id', isConvId)
  const d = LIMITS.budgetDefault
  const input = await body(c, z.object({
    goal: z.string().min(1).max(LIMITS.goal),
    messages: z.number().int().default(d.messages), chars: z.number().int().default(d.chars), minutes: z.number().default(d.minutes),
    brief: zBrief,
  }))
  const round = newRoundId(id)
  await inbox(c).seatPrepare(round, id, input.brief)
  // I9: only this route, which requires a `human` session, can open a round.
  const r = await conv(c, id).exec(id, {
    t: 'round_open', id: newEventId(), principal: me(c), round, goal: input.goal,
    budget: { messages: input.messages, chars: input.chars, until: Date.now() + Math.round(input.minutes * 60_000) },
  })
  return send(c, r.ok ? ok({ round }) : err(r.error, r.detail), 201)
})

api.post('/rounds/:id/join', anyHuman, async (c) => {
  const round = param(c, 'id', isRoundId) as RoundId
  const { brief } = await body(c, z.object({ brief: zBrief }))
  const id = convOf(round)
  await inbox(c).seatPrepare(round, id, brief)
  const r = await conv(c, id).exec(id, { t: 'round_join', id: newEventId(), principal: me(c), round })
  return send(c, r.ok ? ok({}) : err(r.error, r.detail))
})

api.post('/rounds/:id/close', anyHuman, async (c) => {
  const round = param(c, 'id', isRoundId) as RoundId
  const id = convOf(round)
  const r = await conv(c, id).exec(id, { t: 'round_close', id: newEventId(), principal: me(c), round })
  return send(c, r.ok ? ok({}) : err(r.error, r.detail))
})

api.get('/seats', anyHuman, async (c) => c.json(await inbox(c).seats()))

// -- notes ------------------------------------------------------------------------------

const zRevision = z.object({ id: zEvent, title: z.string().min(1).max(LIMITS.noteTitle * 4), text: z.string().min(1).max(LIMITS.note), base: z.number().int().positive().nullable().default(null) })

const revise = async (c: C, note: NoteId) => {
  const input = await body(c, zRevision)
  const id = convOf(note)
  const r = await conv(c, id).exec(id, { t: 'note_revise', id: input.id, principal: me(c), path: { kind: 'human' }, note, base: input.base, title: input.title, text: input.text })
  const rev = r.events.map((e) => e.body).find((b) => b.kind === 'note_revision')
  return send(c, r.ok && rev?.kind === 'note_revision' ? ok({ note, rev: rev.rev }) : err(r.ok ? 'unavailable' : r.error, r.ok ? undefined : r.detail), 201)
}

api.get('/convs/:id/notes', anyHuman, async (c) => send(c, await conv(c, param(c, 'id', isConvId)).notes(me(c))))
api.post('/convs/:id/notes', anyHuman, async (c) => revise(c, newNoteId(param(c, 'id', isConvId))))
api.post('/notes/:id/revisions', anyHuman, async (c) => revise(c, param(c, 'id', isNoteId) as NoteId))

const readNote = async (c: C) => {
  const note = param(c, 'id', isNoteId) as NoteId
  const raw = c.req.query('rev')
  const rev = raw === undefined ? undefined : Number(raw)
  if (rev !== undefined && (!Number.isInteger(rev) || rev < 1)) return fail('bad_request', 'rev')
  return conv(c, convOf(note)).note(me(c), note, rev)
}

api.get('/notes/:id', anyHuman, async (c) => send(c, await readNote(c)))

api.post('/notes/:id/endorse', anyHuman, async (c) => {
  const note = param(c, 'id', isNoteId) as NoteId
  const { rev } = await body(c, z.object({ rev: z.number().int().positive() }))
  const id = convOf(note)
  // I10: an endorsement is only ever written from a `human` session.
  const r = await conv(c, id).exec(id, { t: 'note_endorse', id: newEventId(), principal: me(c), note, rev })
  return send(c, r.ok ? ok({}) : err(r.error, r.detail))
})

api.get('/notes/:id/export', anyHuman, async (c) => {
  const r = await readNote(c)
  if (!r.ok) return send(c, r)
  const name = r.value.title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 80) || 'note'
  return new Response(`# ${r.value.title}\n\n${r.value.text}\n`, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${name}.v${r.value.rev}.md`)}`,
    },
  })
})

// -- devices ------------------------------------------------------------------------------

api.get('/devices', anyHuman, async (c) => c.json((await directory(c.env).devices(me(c))).map(deviceView)))

api.post('/devices/token', web, async (c) => {
  const input = await body(c, z.object({ name: z.string().min(1).max(60), days: z.number().int().min(1).max(365).default(30), rounds: z.boolean().default(false) }))
  const token = randomToken(TOKEN_PREFIX)
  const id = newDeviceId()
  await directory(c.env).createDevice({
    id, principal: me(c), kind: 'token', name: input.name, client_id: 'token', client_name: 'Pasted token', rounds: input.rounds ? 1 : 0,
    token_hash: await sha256(token), created_at: Date.now(), expires_at: Date.now() + input.days * 86_400_000,
  })
  return c.json({ id, token, mcp: `${origin(c.env)}/mcp` }, 201) // the only time the token is shown
})

api.patch('/devices/:id', web, async (c) => {
  const id = param(c, 'id', isDeviceId) as DeviceId
  const input = await body(c, z.object({ name: z.string().min(1).max(60), rounds: z.boolean() }))
  return (await directory(c.env).updateDevice(me(c), id, input.name, input.rounds)) === 1 ? c.json({}) : fail('not_found')
})

api.delete('/devices/:id', web, async (c) => {
  const id = param(c, 'id', isDeviceId) as DeviceId
  if ((await directory(c.env).revokeDevice(me(c), id)) !== 1) return fail('not_found')
  await Promise.all([revokeGrants(c.env, me(c), id), endDeviceSessions(c.env, id)])
  return c.json({})
})

// -- search ---------------------------------------------------------------------------------

api.get('/search', anyHuman, async (c) => c.json(await inbox(c).search((c.req.query('q') ?? '').slice(0, 200))))

api.all('*', () => fail('not_found'))

// -- operator -----------------------------------------------------------------------------------

export const admin = new Hono<App>().basePath('/admin')

admin.onError((e, c) => (e instanceof Fail ? c.json({ error: e.err.error }, HTTP_STATUS[e.err.error] as 400) : c.json({ error: 'unavailable' }, 503)))

admin.use('*', async (c, next) => {
  const secret = c.env.ADMIN_SECRET
  const given = (c.req.header('Authorization') ?? '').replace(/^Bearer /, '')
  if (!secret || secret.length < 24 || !timingSafeEqual(given, secret)) return fail('unauthenticated')
  await next()
})

/** The one thing the deploy secret is for: the first conversation and its invitation link. */
admin.post('/bootstrap', async (c) => {
  const input = z.object({ topic: z.string().min(1).max(LIMITS.topic).default('Sudare') }).safeParse(await c.req.json().catch(() => ({})))
  return c.json(await bootstrap(c.env, input.success ? input.data.topic : 'Sudare'), 201)
})

/** Migration exit: the complete logs as NDJSON, in seq order. */
const ndjson = (lines: string[], next: number | null) =>
  new Response(lines.join('\n') + (lines.length ? '\n' : ''), { headers: { 'Content-Type': 'application/x-ndjson', 'X-Next': next === null ? '' : String(next) } })

admin.get('/export/conv/:id', async (c) => {
  const id = c.req.param('id') as ConvId
  const page = await convStub(c.env, id).export(Number(c.req.query('after') ?? 0))
  return ndjson(page.lines, page.next)
})

admin.get('/export/principal/:id', async (c) => {
  const page = await principalStub(c.env, c.req.param('id') as PrincipalId).export(Number(c.req.query('after') ?? 0))
  return ndjson(page.lines, page.next)
})

admin.get('/export/directory', async (c) => {
  const tables = ['principals', 'convs', 'aliases', 'devices', 'invites']
  const rows = await Promise.all(tables.map(async (t) => (await c.env.DB.prepare(`SELECT * FROM ${t}`).all()).results.map((r) => JSON.stringify({ table: t, ...r, token_hash: undefined, code_hash: undefined }))))
  return ndjson(rows.flat(), null)
})
