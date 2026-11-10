// The conversation state machine: a pure functional core.
//
//   decide : (State, Command, Env) -> Decision   -- validates, never mutates
//   apply  : (State, Event)        -> State      -- total fold step
//
// The Durable Object is a thin imperative shell around these two functions:
// it persists the emitted events and the folded state in one transaction.
// Every safety invariant of the conversation log (I1, I3-seat, I4, I5, I9,
// I10, I11-membership, I12) is decided here, so the property tests and the
// TLA+ spec can speak about exactly the code that runs in production.

import {
  LIMITS,
  type Author, type Budget, type ConvBody, type ConvPrivate, type InvitePolicy,
  type ReceiptState, type RoundCloseReason, type StoredConvEvent,
} from './events'
import {
  convOf,
  type AliasId, type ConvId, type DeviceId, type DraftId, type EventId, type NoteId,
  type PrincipalId, type RoundId,
} from './ids'
import { err, type Err } from './result'
import { byteLength, charCount, handleKey, normalizeHandle, normalizeTopic } from './text'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type Member = {
  alias: AliasId
  principal: PrincipalId
  handle: string
  fromSeq: number // first event this member may read (I12)
  leftSeq: number | null
}

export type Round = {
  id: RoundId
  by: AliasId
  goal: string
  budget: Budget
  openedSeq: number
  seats: Record<AliasId, DeviceId | null> // key present = the person joined; value = seated device
  messages: number
  chars: number
  closed: { reason: RoundCloseReason; seq: number } | null
}

export type NoteRev = {
  rev: number
  base: number | null
  seq: number
  author: Author
  title: string
  endorsed: AliasId[]
  adoptedSeq: number | null // sticky: adoption is judged against the members at that moment
}

export type Note = { id: NoteId; revs: NoteRev[] }

export type ConvState = {
  conv: ConvId
  seq: number
  created: boolean
  topic: string
  invite: InvitePolicy
  parent: ConvId | null
  creator: AliasId | null
  archivedSeq: number | null
  retentionDays: number
  members: Record<AliasId, Member>
  rounds: Record<RoundId, Round>
  notes: Record<NoteId, Note>
}

export const emptyConv = (conv: ConvId): ConvState => ({
  conv, seq: 0, created: false, topic: '', invite: 'any_member', parent: null, creator: null,
  archivedSeq: null, retentionDays: LIMITS.retentionDaysDefault, members: {}, rounds: {}, notes: {},
})

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export const allMembers = (s: ConvState): Member[] => Object.values(s.members)
export const activeMembers = (s: ConvState): Member[] => allMembers(s).filter((m) => m.leftSeq === null)
export const memberOf = (s: ConvState, p: PrincipalId): Member | undefined =>
  activeMembers(s).find((m) => m.principal === p)
export const isCreator = (s: ConvState, m: Member): boolean => s.creator === m.alias
export const openRounds = (s: ConvState): Round[] => Object.values(s.rounds).filter((r) => r.closed === null)
export const latestRev = (n: Note): NoteRev => n.revs[n.revs.length - 1]!
export const adoptedRev = (n: Note): NoteRev | undefined =>
  [...n.revs].reverse().find((r) => r.adoptedSeq !== null)

/** Members who were entitled to see the event at `seq` (the recipients for I7). */
export const recipientsAt = (s: ConvState, seq: number): Member[] =>
  allMembers(s).filter((m) => m.fromSeq <= seq && (m.leftSeq === null || seq <= m.leftSeq))

export const canInvite = (s: ConvState, m: Member): boolean =>
  s.archivedSeq === null && (s.invite === 'any_member' || isCreator(s, m))

export const remaining = (r: Round) => ({
  messages: r.budget.messages - r.messages,
  chars: r.budget.chars - r.chars,
  until: r.budget.until,
})

/** May `m` read the event at `seq`? Adopted notes are handled separately. */
export const canReadSeq = (m: Member, seq: number): boolean =>
  seq >= m.fromSeq && (m.leftSeq === null || seq <= m.leftSeq)

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

const adoptWhereComplete = (s: ConvState, seq: number): ConvState => {
  const active = activeMembers(s).map((m) => m.alias)
  if (active.length === 0) return s
  const complete = (r: NoteRev) => r.adoptedSeq === null && active.every((a) => r.endorsed.includes(a))
  const notes = Object.fromEntries(
    Object.entries(s.notes).map(([id, n]) => [
      id,
      n.revs.some(complete)
        ? { ...n, revs: n.revs.map((r) => (complete(r) ? { ...r, adoptedSeq: seq } : r)) }
        : n,
    ]),
  ) as ConvState['notes']
  return { ...s, notes }
}

const withRound = (s: ConvState, id: RoundId, f: (r: Round) => Round): ConvState => {
  const r = s.rounds[id]
  return r ? { ...s, rounds: { ...s.rounds, [id]: f(r) } } : s
}

const countAutonomous = (s: ConvState, author: Author, text: string): ConvState =>
  author.kind === 'autonomous'
    ? withRound(s, author.round, (r) => ({ ...r, messages: r.messages + 1, chars: r.chars + charCount(text) }))
    : s

export const apply = (state: ConvState, e: StoredConvEvent): ConvState => {
  const s = { ...state, seq: e.seq }
  const b = e.body
  switch (b.kind) {
    case 'conv_created':
      return { ...s, created: true, topic: b.topic, invite: b.invite, parent: b.parent, creator: b.by }
    case 'conv_renamed':
      return { ...s, topic: b.topic }
    case 'retention_set':
      return { ...s, retentionDays: b.days }
    case 'member_joined':
      return {
        ...s,
        members: {
          ...s.members,
          [b.alias]: {
            alias: b.alias,
            principal: e.private.principal!,
            handle: b.handle,
            fromSeq: b.via === 'invite' ? e.seq : 1,
            leftSeq: null,
          },
        },
      }
    case 'member_left': {
      const m = s.members[b.alias]
      const next = m ? { ...s, members: { ...s.members, [b.alias]: { ...m, leftSeq: e.seq } } } : s
      return adoptWhereComplete(next, e.seq)
    }
    case 'conv_archived':
      return { ...s, archivedSeq: e.seq }
    case 'message':
      return countAutonomous(s, b.author, b.text)
    case 'receipt':
      return s
    case 'round_opened':
      return {
        ...s,
        rounds: {
          ...s.rounds,
          [b.round]: {
            id: b.round, by: b.by, goal: b.goal, budget: b.budget, openedSeq: e.seq,
            seats: {}, messages: 0, chars: 0, closed: null,
          },
        },
      }
    case 'round_joined':
      return withRound(s, b.round, (r) => ({ ...r, seats: { ...r.seats, [b.alias]: null } }))
    case 'round_seated':
      return withRound(s, b.round, (r) => ({ ...r, seats: { ...r.seats, [b.alias]: e.private.device ?? null } }))
    case 'round_closed':
      return withRound(s, b.round, (r) => (r.closed ? r : { ...r, closed: { reason: b.reason, seq: e.seq } }))
    case 'note_revision': {
      const rev: NoteRev = {
        rev: b.rev, base: b.base, seq: e.seq, author: b.author, title: b.title, endorsed: [], adoptedSeq: null,
      }
      const prior = s.notes[b.note]
      const note: Note = prior ? { ...prior, revs: [...prior.revs, rev] } : { id: b.note, revs: [rev] }
      return { ...s, notes: { ...s.notes, [b.note]: note } }
    }
    case 'note_endorsed': {
      const n = s.notes[b.note]
      if (!n) return s
      const revs = n.revs.map((r) =>
        r.rev === b.rev && !r.endorsed.includes(b.by) ? { ...r, endorsed: [...r.endorsed, b.by] } : r,
      )
      return adoptWhereComplete({ ...s, notes: { ...s.notes, [b.note]: { ...n, revs } } }, e.seq)
    }
  }
}

export const fold = (conv: ConvId, events: readonly StoredConvEvent[]): ConvState =>
  events.reduce(apply, emptyConv(conv))

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Which gate a write came through. The Worker derives this from the
 * credential, never from the request body:
 *  - human:      a `human` session wrote it directly
 *  - delegate:   a `human` session approved the agent draft `draft`
 *  - autonomous: an `agent` device speaking inside round `round`
 */
export type WritePath =
  | { kind: 'human' }
  | { kind: 'delegate'; draft: DraftId }
  | { kind: 'autonomous'; round: RoundId; device: DeviceId }

export type NewMember = { principal: PrincipalId; alias: AliasId; handle: string }

export type Command =
  | {
      t: 'create'; id: EventId; topic: string; invite: InvitePolicy; parent: ConvId | null
      creator: NewMember; members: NewMember[]; retentionDays?: number
    }
  | { t: 'join'; id: EventId; member: NewMember }
  | { t: 'leave'; id: EventId; principal: PrincipalId }
  | { t: 'archive'; id: EventId; principal: PrincipalId }
  | { t: 'rename'; id: EventId; principal: PrincipalId; topic: string }
  | { t: 'set_retention'; id: EventId; principal: PrincipalId; days: number }
  | {
      t: 'post'; id: EventId; principal: PrincipalId; path: WritePath
      text: string; to: AliasId[]; cause: EventId | null
    }
  | { t: 'receipt'; id: EventId; principal: PrincipalId; of: EventId; state: ReceiptState }
  | { t: 'round_open'; id: EventId; principal: PrincipalId; round: RoundId; goal: string; budget: Budget }
  | { t: 'round_join'; id: EventId; principal: PrincipalId; round: RoundId }
  | { t: 'round_seat'; id: EventId; principal: PrincipalId; round: RoundId; device: DeviceId; capable: boolean }
  | { t: 'round_close'; id: EventId; principal: PrincipalId; round: RoundId }
  | {
      t: 'note_revise'; id: EventId; principal: PrincipalId; path: WritePath
      note: NoteId; base: number | null; title: string; text: string
    }
  | { t: 'note_endorse'; id: EventId; principal: PrincipalId; note: NoteId; rev: number }
  | { t: 'tick' }

export type DecideEnv = { now: number; nextId: () => EventId }

export type Emit = { id: EventId; body: ConvBody; private: ConvPrivate }

/**
 * `emits` are appended even when `error` is set: a rejected over-budget
 * message still closes its round (I4), and that closure must be durable.
 */
export type Decision = { emits: Emit[]; error: Err | null }

const reject = (error: Err, emits: Emit[] = []): Decision => ({ emits, error })
const accept = (emits: Emit[]): Decision => ({ emits, error: null })
const emit = (id: EventId, body: ConvBody, priv: ConvPrivate = {}): Emit => ({ id, body, private: priv })

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

const handleFree = (s: ConvState, handle: string, principal: PrincipalId): boolean =>
  allMembers(s).every((m) => handleKey(m.handle) !== handleKey(handle) || (m.principal === principal && m.leftSeq !== null))

const validBudget = (b: Budget, now: number): boolean =>
  Number.isInteger(b.messages) && b.messages >= 1 && b.messages <= LIMITS.budgetMax.messages &&
  Number.isInteger(b.chars) && b.chars >= 1 && b.chars <= LIMITS.budgetMax.chars &&
  Number.isFinite(b.until) && b.until > now && b.until <= now + LIMITS.budgetMax.minutes * 60_000

/** The writer must be an active member of a live conversation. */
const writer = (s: ConvState, principal: PrincipalId): Member | Err => {
  if (!s.created) return err('conv_missing')
  const m = memberOf(s, principal)
  if (!m) return err('not_member')
  return s.archivedSeq !== null ? err('conv_archived') : m
}

const isErr = (x: Member | Round | Err): x is Err => 'ok' in x

/**
 * I4: an autonomous write needs an open, unexpired round that the author's
 * human joined and whose seat is held by exactly this device. An expired
 * round is closed as a side effect.
 */
const seatedRound = (
  s: ConvState, m: Member, path: Extract<WritePath, { kind: 'autonomous' }>, env: DecideEnv,
): Round | Decision => {
  const r = s.rounds[path.round]
  if (!r) return reject(err('round_missing'))
  if (r.closed) return reject(err('round_closed'))
  if (env.now >= r.budget.until) {
    return reject(err('round_closed'), [emit(env.nextId(), { kind: 'round_closed', round: r.id, reason: 'expired' })])
  }
  if (!(m.alias in r.seats)) return reject(err('round_not_joined'))
  return r.seats[m.alias] === path.device ? r : reject(err('round_not_seated'))
}

const isDecision = (x: Round | Decision): x is Decision => 'emits' in x

const authorOf = (m: Member, path: WritePath): Author =>
  path.kind === 'autonomous'
    ? { kind: 'autonomous', alias: m.alias, round: path.round }
    : { kind: path.kind, alias: m.alias }

const privateOf = (path: WritePath): ConvPrivate => (path.kind === 'delegate' ? { draft: path.draft } : {})

const decidePost = (s: ConvState, c: Extract<Command, { t: 'post' }>, env: DecideEnv): Decision => {
  const m = writer(s, c.principal)
  if (isErr(m)) return reject(m)
  const chars = charCount(c.text)
  if (c.text.trim() === '') return reject(err('bad_request', 'text'))
  if (chars > LIMITS.message) return reject(err('text_too_large'))
  const to = [...new Set(c.to)]
  if (to.length > LIMITS.recipients) return reject(err('bad_request', 'to'))
  const active = new Set(activeMembers(s).map((x) => x.alias))
  if (!to.every((a) => active.has(a))) return reject(err('recipient_unknown'))
  const message = emit(
    c.id,
    { kind: 'message', author: authorOf(m, c.path), text: c.text, to, cause: c.cause },
    privateOf(c.path),
  )
  if (c.path.kind !== 'autonomous') return accept([message])

  const r = seatedRound(s, m, c.path, env)
  if (isDecision(r)) return r
  const after = { messages: r.messages + 1, chars: r.chars + chars }
  const closeForBudget = () => emit(env.nextId(), { kind: 'round_closed', round: r.id, reason: 'budget' })
  if (after.messages > r.budget.messages || after.chars > r.budget.chars) {
    return reject(err('budget_exceeded'), [closeForBudget()])
  }
  const exhausted = after.messages === r.budget.messages || after.chars === r.budget.chars
  return accept(exhausted ? [message, closeForBudget()] : [message])
}

const decideNote = (s: ConvState, c: Extract<Command, { t: 'note_revise' }>, env: DecideEnv): Decision => {
  const m = writer(s, c.principal)
  if (isErr(m)) return reject(m)
  if (convOf(c.note) !== s.conv) return reject(err('bad_request', 'note'))
  const title = c.title.trim()
  if (title === '' || charCount(title) > LIMITS.noteTitle) return reject(err('bad_request', 'title'))
  if (c.text.trim() === '') return reject(err('bad_request', 'text'))
  if (byteLength(c.text) > LIMITS.note) return reject(err('note_too_large'))
  const existing = s.notes[c.note]
  const head = existing ? latestRev(existing).rev : null
  if (c.base !== head) return reject(err(existing ? 'note_base_stale' : 'note_missing', { head }))
  const rev = (head ?? 0) + 1
  const revision = emit(
    c.id,
    { kind: 'note_revision', note: c.note, rev, base: c.base, author: authorOf(m, c.path), title, text: c.text },
    privateOf(c.path),
  )
  if (c.path.kind === 'autonomous') {
    const r = seatedRound(s, m, c.path, env)
    if (isDecision(r)) return r
    return accept([revision, emit(env.nextId(), { kind: 'round_closed', round: r.id, reason: 'note_proposed' })])
  }
  // A person who wrote or approved a revision has, by that act, endorsed it.
  return accept([revision, emit(env.nextId(), { kind: 'note_endorsed', note: c.note, rev, by: m.alias })])
}

const decideCreate = (s: ConvState, c: Extract<Command, { t: 'create' }>, env: DecideEnv): Decision => {
  if (s.created) return reject(err('conv_exists'))
  const topic = normalizeTopic(c.topic)
  if (!topic.ok) return reject(topic)
  const everyone = [c.creator, ...c.members]
  if (everyone.length > LIMITS.members) return reject(err('conv_full'))
  if (new Set(everyone.map((x) => x.principal)).size !== everyone.length) return reject(err('already_member'))
  const normalized = everyone.map((x) => normalizeHandle(x.handle))
  const handles = normalized.flatMap((h) => (h.ok ? [h.value] : []))
  if (handles.length !== everyone.length) return reject(err('handle_invalid'))
  if (new Set(handles.map(handleKey)).size !== handles.length) return reject(err('handle_taken'))
  const days = c.retentionDays ?? LIMITS.retentionDaysDefault
  if (!Number.isInteger(days) || days < 1 || days > LIMITS.retentionDaysMax) return reject(err('bad_request', 'retention'))
  const joined = (x: NewMember, i: number): Emit =>
    emit(
      env.nextId(),
      { kind: 'member_joined', alias: x.alias, handle: handles[i]!, via: i === 0 ? 'creator' : 'fork' },
      { principal: x.principal },
    )
  return accept([
    emit(c.id, { kind: 'conv_created', topic: topic.value, by: c.creator.alias, invite: c.invite, parent: c.parent }),
    ...everyone.map(joined),
    ...(days === LIMITS.retentionDaysDefault
      ? []
      : [emit(env.nextId(), { kind: 'retention_set', days, by: c.creator.alias } as ConvBody)]),
  ])
}

const decideJoin = (s: ConvState, c: Extract<Command, { t: 'join' }>): Decision => {
  if (!s.created) return reject(err('conv_missing'))
  if (s.archivedSeq !== null) return reject(err('conv_archived'))
  if (memberOf(s, c.member.principal)) return reject(err('already_member'))
  if (activeMembers(s).length >= LIMITS.members) return reject(err('conv_full'))
  const handle = normalizeHandle(c.member.handle)
  if (!handle.ok) return reject(handle)
  if (!handleFree(s, handle.value, c.member.principal)) return reject(err('handle_taken'))
  return accept([
    emit(c.id, { kind: 'member_joined', alias: c.member.alias, handle: handle.value, via: 'invite' }, { principal: c.member.principal }),
  ])
}

const openRound = (s: ConvState, id: RoundId): Round | Err => {
  const r = s.rounds[id]
  if (!r) return err('round_missing')
  return r.closed ? err('round_closed') : r
}

export const decide = (s: ConvState, c: Command, env: DecideEnv): Decision => {
  switch (c.t) {
    case 'create':
      return decideCreate(s, c, env)
    case 'join':
      return decideJoin(s, c)
    case 'post':
      return decidePost(s, c, env)
    case 'note_revise':
      return decideNote(s, c, env)
    case 'leave': {
      // Leaving is allowed even from an archived conversation.
      const m = s.created ? memberOf(s, c.principal) : undefined
      if (!m) return reject(err('not_member'))
      const left = emit(c.id, { kind: 'member_left', alias: m.alias })
      // The last person out closes the door: with nobody inside, nobody could ever
      // invite anyone back, so the conversation is archived and deleted after its
      // retention like any other archived one.
      const isLast = activeMembers(s).length === 1 && s.archivedSeq === null
      return accept(isLast
        ? [
            ...openRounds(s).map((r) => emit(env.nextId(), { kind: 'round_closed', round: r.id, reason: 'closed' } as ConvBody)),
            emit(env.nextId(), { kind: 'conv_archived', by: m.alias }),
            left,
          ]
        : [left])
    }
    case 'archive': {
      const m = writer(s, c.principal)
      if (isErr(m)) return reject(m)
      const creatorGone = s.creator === null || s.members[s.creator]?.leftSeq !== null
      if (!isCreator(s, m) && !creatorGone) return reject(err('forbidden_scope'))
      return accept([
        ...openRounds(s).map((r) => emit(env.nextId(), { kind: 'round_closed', round: r.id, reason: 'closed' } as ConvBody)),
        emit(c.id, { kind: 'conv_archived', by: m.alias }),
      ])
    }
    case 'rename': {
      const m = writer(s, c.principal)
      if (isErr(m)) return reject(m)
      const topic = normalizeTopic(c.topic)
      return topic.ok ? accept([emit(c.id, { kind: 'conv_renamed', topic: topic.value, by: m.alias })]) : reject(topic)
    }
    case 'set_retention': {
      const m = writer(s, c.principal)
      if (isErr(m)) return reject(m)
      if (!isCreator(s, m)) return reject(err('forbidden_scope'))
      const valid = Number.isInteger(c.days) && c.days >= 1 && c.days <= LIMITS.retentionDaysMax
      return valid ? accept([emit(c.id, { kind: 'retention_set', days: c.days, by: m.alias })]) : reject(err('bad_request', 'days'))
    }
    case 'receipt': {
      const m = writer(s, c.principal)
      if (isErr(m)) return reject(m)
      // Receipts are only written in two-person conversations.
      return activeMembers(s).length === 2
        ? accept([emit(c.id, { kind: 'receipt', of: c.of, by: m.alias, state: c.state })])
        : accept([])
    }
    case 'round_open': {
      const m = writer(s, c.principal)
      if (isErr(m)) return reject(m)
      if (convOf(c.round) !== s.conv || s.rounds[c.round]) return reject(err('id_conflict'))
      if (openRounds(s).length > 0) return reject(err('round_open_exists'))
      const goal = c.goal.trim()
      if (goal === '' || charCount(goal) > LIMITS.goal) return reject(err('bad_request', 'goal'))
      if (!validBudget(c.budget, env.now)) return reject(err('budget_invalid'))
      const budget: Budget = { messages: c.budget.messages, chars: c.budget.chars, until: c.budget.until }
      return accept([
        emit(c.id, { kind: 'round_opened', round: c.round, by: m.alias, goal, budget }),
        emit(env.nextId(), { kind: 'round_joined', round: c.round, alias: m.alias }),
      ])
    }
    case 'round_join': {
      const m = writer(s, c.principal)
      if (isErr(m)) return reject(m)
      const r = openRound(s, c.round)
      if (isErr(r)) return reject(r)
      return m.alias in r.seats
        ? reject(err('round_already_joined'))
        : accept([emit(c.id, { kind: 'round_joined', round: r.id, alias: m.alias })])
    }
    case 'round_seat': {
      const m = writer(s, c.principal)
      if (isErr(m)) return reject(m)
      const r = openRound(s, c.round)
      if (isErr(r)) return reject(r)
      if (!c.capable) return reject(err('seat_not_capable'))
      if (!(m.alias in r.seats)) return reject(err('round_not_joined'))
      const holder = r.seats[m.alias]
      if (holder === c.device) return accept([]) // idempotent re-claim by the same device
      return holder === null
        ? accept([emit(c.id, { kind: 'round_seated', round: r.id, alias: m.alias }, { device: c.device })])
        : reject(err('seat_taken'))
    }
    case 'round_close': {
      const m = writer(s, c.principal)
      if (isErr(m)) return reject(m)
      const r = openRound(s, c.round)
      if (isErr(r)) return reject(r)
      return m.alias in r.seats
        ? accept([emit(c.id, { kind: 'round_closed', round: r.id, reason: 'closed' })])
        : reject(err('round_not_joined'))
    }
    case 'note_endorse': {
      const m = writer(s, c.principal)
      if (isErr(m)) return reject(m)
      const n = s.notes[c.note]
      if (!n) return reject(err('note_missing'))
      const head = latestRev(n)
      if (c.rev !== head.rev) return reject(err('note_base_stale', { head: head.rev }))
      return head.endorsed.includes(m.alias)
        ? reject(err('already_endorsed'))
        : accept([emit(c.id, { kind: 'note_endorsed', note: n.id, rev: c.rev, by: m.alias })])
    }
    case 'tick':
      return accept(
        openRounds(s)
          .filter((r) => env.now >= r.budget.until)
          .map((r) => emit(env.nextId(), { kind: 'round_closed', round: r.id, reason: 'expired' })),
      )
  }
}

/** Run a command against a state: the composition the shell performs, minus persistence. */
export const step = (
  s: ConvState, c: Command, env: DecideEnv,
): { state: ConvState; events: StoredConvEvent[]; error: Err | null } => {
  const d = decide(s, c, env)
  const events = d.emits.map((e, i): StoredConvEvent => ({
    id: e.id, conv: s.conv, seq: s.seq + i + 1, ts: env.now, body: e.body, private: e.private,
  }))
  return { state: events.reduce(apply, s), events, error: d.error }
}

/** What a member may see of an event: the server-only annotations are dropped. */
export const publicEvent = ({ private: _private, ...e }: StoredConvEvent) => e
