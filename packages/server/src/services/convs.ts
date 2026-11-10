// Creating conversations, inviting and joining: the orchestration that spans
// the directory, a ConversationDO and several PrincipalDOs. Each step is
// idempotent so a retry after a partial failure converges.

import {
  LIMITS, newAliasId, newConvId, newEventId, newInviteId, normalizeHandle, err, ok,
  type AliasRef, type ConvId, type EventId, type InviteId, type InvitePolicy, type PrincipalId, type Result, type WritePath,
} from '@sudare/protocol'
import { directory, type InviteRow } from '../directory'
import { origin, type Env } from '../env'
import { b64url, sha256 } from '../util'
import { convStub, principalStub } from './stubs'

const WEEK = 7 * 86_400_000

export type CreateInput = {
  topic: string
  members: AliasRef[]
  parent: ConvId | null
  invite: InvitePolicy
  handle: string | null // only needed by someone who has no default handle and no parent
  first: { id: EventId; text: string } | null
  dm: boolean
  path: WritePath // human, or delegate when an approved agent draft creates the conversation
}

export type Created = { conv: ConvId; existing: boolean; joined: number; invited: number }

type Person = { principal: PrincipalId; handle: string }

/** Who the alias references are. Each is resolved inside the conversation the caller knows them from. */
const resolveRefs = async (env: Env, me: PrincipalId, refs: AliasRef[]): Promise<Result<Person[]>> => {
  const byConv = Map.groupBy(refs, (r) => r.conv)
  const found: Person[] = []
  for (const [conv, group] of byConv) {
    const r = await convStub(env, conv).principalsOf(me, group.map((g) => g.alias))
    if (!r.ok) return r
    found.push(...r.value)
  }
  const unique = [...new Map(found.map((p) => [p.principal, p])).values()].filter((p) => p.principal !== me)
  return ok(unique)
}

/**
 * The join rule: when the caller and everyone they name already share one
 * conversation (the parent, or the one all references point into), the new
 * conversation has no new audience and everyone joins directly. Otherwise
 * each person is invited and decides for themselves.
 */
const sharedConv = (input: CreateInput): ConvId | null => {
  if (input.parent) return input.parent
  const convs = new Set(input.members.map((m) => m.conv))
  return convs.size === 1 ? [...convs][0]! : null
}

export const createConv = async (env: Env, me: PrincipalId, input: CreateInput): Promise<Result<Created>> => {
  const dir = directory(env)
  if (input.members.length + 1 > LIMITS.members) return err('conv_full')
  const others = await resolveRefs(env, me, input.members)
  if (!others.ok) return others
  if (input.dm && others.value.length !== 1) return err('bad_request', 'dm')

  const shared = sharedConv(input)
  const fork = shared ? await convStub(env, shared).forkHandles(me, others.value.map((o) => o.principal)) : null
  if (input.parent && !(await convStub(env, input.parent).isMember(me))) return err('not_member')
  const direct = fork?.ok === true

  const self = await dir.principal(me)
  const myHandle = direct ? fork.value[0]! : (input.handle ?? self?.default_handle ?? null)
  if (!myHandle) return err('handle_invalid')

  let conv = newConvId()
  if (input.dm) {
    const key = [me, others.value[0]!.principal].sort().join('|')
    await dir.reserveDm(conv, key)
    const reserved = await dir.dm(key)
    if (!reserved) return err('unavailable')
    if (reserved.id !== conv) {
      if (await convStub(env, reserved.id).isMember(me)) return ok({ conv: reserved.id, existing: true, joined: 0, invited: 0 })
      conv = reserved.id // reserved by an attempt that never finished: complete it
    }
  }

  const created = await convStub(env, conv).exec(conv, {
    t: 'create', id: newEventId(), topic: input.topic, invite: input.invite, parent: input.parent,
    creator: { principal: me, alias: newAliasId(), handle: myHandle },
    members: direct ? others.value.map((o, i) => ({ principal: o.principal, alias: newAliasId(), handle: fork.value[i + 1]! })) : [],
  })
  if (!created.ok && created.error !== 'conv_exists') {
    if (input.dm) await dir.releaseDm(conv)
    return err(created.error, created.detail)
  }
  await dir.setDefaultHandle(me, myHandle)

  if (!direct) {
    for (const o of others.value) await inviteDirect(env, me, conv, o.principal)
  }
  if (input.first) {
    const sent = await convStub(env, conv).exec(conv, {
      t: 'post', id: input.first.id, principal: me, path: input.path, text: input.first.text, to: [], cause: null,
    })
    if (!sent.ok) return err(sent.error, sent.detail)
  }
  return ok({ conv, existing: false, joined: direct ? others.value.length : 0, invited: direct ? 0 : others.value.length })
}

const inviteDirect = async (env: Env, me: PrincipalId, conv: ConvId, target: PrincipalId): Promise<Result<InviteId>> => {
  const dir = directory(env)
  const stub = convStub(env, conv)
  const info = await stub.inviteInfo(me)
  if (!info.ok) return info
  if (await stub.isMember(target)) return err('already_member')
  const pending = await dir.pendingDirect(conv, target)
  const id = pending?.id ?? newInviteId()
  const expires = pending?.expires_at ?? Date.now() + WEEK
  if (!pending) {
    await dir.createInvite({ id, code_hash: null, conv, kind: 'direct', by_principal: me, by_handle: info.value.by, target, bootstrap_topic: null, expires_at: expires })
  }
  await principalStub(env, target).inviteDeliver({ id, conv, topic: info.value.topic, by: info.value.by, members: info.value.members, expires })
  return ok(id)
}

/** Invite someone the caller has met ("the alias X in conversation Y"), delivered in-app without revealing who they are. */
export const inviteMember = async (env: Env, me: PrincipalId, conv: ConvId, ref: AliasRef): Promise<Result<InviteId>> => {
  const who = await resolveRefs(env, me, [ref])
  if (!who.ok) return who
  return who.value[0] ? inviteDirect(env, me, conv, who.value[0].principal) : err('recipient_unknown')
}

/** A single-use link, valid for seven days. Only its hash is stored. */
export const inviteLink = async (env: Env, me: PrincipalId, conv: ConvId): Promise<Result<{ id: InviteId; url: string; expires: number }>> => {
  const info = await convStub(env, conv).inviteInfo(me)
  if (!info.ok) return info
  const code = b64url(crypto.getRandomValues(new Uint8Array(24)))
  const id = newInviteId()
  const expires = Date.now() + WEEK
  await directory(env).createInvite({
    id, code_hash: await sha256(code), conv, kind: 'link', by_principal: me, by_handle: info.value.by, target: null, bootstrap_topic: null, expires_at: expires,
  })
  return ok({ id, url: `${origin(env)}/j/${code}`, expires })
}

/**
 * The room link: one link that anyone holding it can use to join, until a
 * member turns it off or it expires. Asking again returns the same link.
 */
export const roomLink = async (env: Env, me: PrincipalId, conv: ConvId): Promise<Result<{ id: InviteId; url: string; expires: number }>> => {
  const dir = directory(env)
  const info = await convStub(env, conv).inviteInfo(me)
  if (!info.ok) return info
  const existing = await dir.roomInvite(conv)
  if (existing?.code) return ok({ id: existing.id, url: `${origin(env)}/j/${existing.code}`, expires: existing.expires_at })
  const code = b64url(crypto.getRandomValues(new Uint8Array(24)))
  const id = newInviteId()
  const expires = Date.now() + WEEK
  await dir.createInvite({ id, code_hash: await sha256(code), conv, kind: 'room', by_principal: me, by_handle: info.value.by, target: null, bootstrap_topic: null, expires_at: expires })
  await dir.keepInviteCode(id, code)
  return ok({ id, url: `${origin(env)}/j/${code}`, expires })
}

/** The operator's one-time entry: a conversation that comes into being when its link is first accepted. */
export const bootstrap = async (env: Env, topic: string): Promise<{ url: string; expires: number }> => {
  const code = b64url(crypto.getRandomValues(new Uint8Array(24)))
  const expires = Date.now() + WEEK
  await directory(env).createInvite({
    id: newInviteId(), code_hash: await sha256(code), conv: newConvId(), kind: 'bootstrap', by_principal: null, by_handle: 'operator',
    target: null, bootstrap_topic: topic, expires_at: expires,
  })
  return { url: `${origin(env)}/j/${code}`, expires }
}

export const inviteByCode = async (env: Env, code: string): Promise<InviteRow | null> =>
  directory(env).inviteByCode(await sha256(code))

/** Is this invitation open to this person right now? */
export const inviteOpenTo = (i: InviteRow, me: PrincipalId | null): boolean =>
  i.kind === 'room' ? i.declined_at === null && i.expires_at > Date.now() :
  i.declined_at === null && i.expires_at > Date.now() &&
  (i.used_at === null || (me !== null && i.used_by === me)) &&
  (i.target === null || i.target === me) && (i.bound === null || i.bound === me)

export const inviteCard = async (env: Env, i: InviteRow) => {
  if (i.kind === 'bootstrap') return { id: i.id, conv: i.conv, topic: i.bootstrap_topic ?? '', by: i.by_handle, members: 0, expires: i.expires_at }
  const row = await env.DB.prepare(`SELECT c.topic AS topic, (SELECT count(*) FROM aliases a WHERE a.conv = c.id AND a.left_at IS NULL) AS members FROM convs c WHERE c.id = ?`)
    .bind(i.conv).first<{ topic: string; members: number }>()
  return { id: i.id, conv: i.conv, topic: row?.topic ?? '', by: i.by_handle, members: row?.members ?? 0, expires: i.expires_at }
}

/**
 * I11: joining consumes an invitation that is unused, unexpired and meant for
 * this person. The consume is a single conditional UPDATE, so exactly one
 * caller wins; the join itself is keyed on the invite id and can be retried.
 */
export const acceptInvite = async (env: Env, me: PrincipalId, i: InviteRow, handle: string | null): Promise<Result<{ conv: ConvId }>> => {
  const dir = directory(env)
  if (!inviteOpenTo(i, me)) return err('invite_invalid')
  const self = await dir.principal(me)
  const wanted = normalizeHandle(handle ?? self?.default_handle ?? '')
  if (!wanted.ok) return wanted
  const stub = convStub(env, i.conv)
  if (i.kind === 'room') {
    // Many people may use a room link; each person's join is idempotent on its own key.
    if (await stub.isMember(me)) return err('already_member')
    const r = await stub.exec(i.conv, { t: 'join', id: `join:${i.id}:${me}` as EventId, member: { principal: me, alias: newAliasId(), handle: wanted.value } })
    if (!r.ok) return err(r.error, r.detail)
    await dir.setDefaultHandle(me, wanted.value)
    return ok({ conv: i.conv })
  }
  const retry = i.used_by === me
  // Someone already inside must not burn a link meant for a newcomer.
  if (!retry && i.kind !== 'bootstrap' && (await stub.isMember(me))) return err('already_member')
  if (!retry && (await dir.consumeInvite(i.id, me)) !== 1) return err('invite_invalid')

  const member = { principal: me, alias: newAliasId(), handle: wanted.value }
  const id = `join:${i.id}` as EventId
  const joined = i.kind === 'bootstrap'
    ? await stub.exec(i.conv, { t: 'create', id, topic: i.bootstrap_topic ?? 'Sudare', invite: 'any_member', parent: null, creator: member, members: [] })
    : await stub.exec(i.conv, { t: 'join', id, member })
  if (!joined.ok && !(retry && joined.error === 'already_member')) {
    await dir.releaseInvite(i.id, me)
    return err(joined.error, joined.detail)
  }
  await dir.setDefaultHandle(me, wanted.value)
  await principalStub(env, me).inviteClosed(i.id)
  if (i.by_principal) await principalStub(env, i.by_principal).inviteAnswered(i.id, true)
  return ok({ conv: i.conv })
}

export const declineInvite = async (env: Env, me: PrincipalId, i: InviteRow): Promise<Result<null>> => {
  if (i.target !== me || !inviteOpenTo(i, me) || i.used_at !== null) return err('invite_invalid')
  await directory(env).declineInvite(i.id)
  await principalStub(env, me).inviteClosed(i.id)
  if (i.by_principal) await principalStub(env, i.by_principal).inviteAnswered(i.id, false)
  return ok(null)
}
