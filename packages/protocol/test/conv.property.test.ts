import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  activeMembers, apply, emptyConv, fold, newAliasId, newConvId, newNoteId, newRoundId, recipientsAt, step,
  type AliasId, type Command, type ConvState, type DeviceId, type DraftId, type EventId, type NoteId,
  type PrincipalId, type RoundId, type StoredConvEvent, type WritePath,
} from '../src'

// A small closed world, the same shape the TLA+ spec explores: three people,
// two agent devices each, one conversation, a handful of rounds and notes.
const CONV = newConvId(0)
const PEOPLE = ['p1', 'p2', 'p3', 'p4'] as PrincipalId[]
const DEVICES = ['d1', 'd2'] as DeviceId[]
const ROUNDS = [0, 1, 2, 3].map((i) => newRoundId(CONV, i))
const NOTES = [0, 1].map((i) => newNoteId(CONV, i))
const ALIASES = PEOPLE.map((_, i) => newAliasId(i))

type Sim = { state: ConvState; log: StoredConvEvent[]; now: number; n: number }

type Op = (id: EventId, sim: Sim) => Command | { advance: number }

// Operations are resolved against the current state so that sequences reach
// deep states (a seated round, a note awaiting its last endorsement) often,
// while `wild` picks keep exercising the rejection paths.
const pick = <T>(xs: readonly T[], i: number): T | undefined => xs[i % Math.max(xs.length, 1)]
const liveRound = (sim: Sim, i: number, wild: boolean): RoundId =>
  (wild ? undefined : Object.values(sim.state.rounds).find((r) => r.closed === null)?.id) ?? pick(ROUNDS, i)!
const freshRound = (sim: Sim, i: number): RoundId => ROUNDS.find((r) => !sim.state.rounds[r]) ?? pick(ROUNDS, i)!
const somebody = (sim: Sim, i: number, wild: boolean): PrincipalId =>
  (wild ? undefined : pick(activeMembers(sim.state), i)?.principal) ?? pick(PEOPLE, i)!
const headOf = (sim: Sim, n: NoteId): number | null => {
  const note = sim.state.notes[n]
  return note ? note.revs[note.revs.length - 1]!.rev : null
}
const pathFor = (sim: Sim, principal: PrincipalId, kind: number, i: number, wild: boolean): WritePath => {
  if (kind % 4 === 0) return { kind: 'human' }
  if (kind % 4 === 1) return { kind: 'delegate', draft: 'f_x' as DraftId }
  const round = liveRound(sim, i, wild)
  const alias = activeMembers(sim.state).find((m) => m.principal === principal)?.alias
  const seated = alias ? sim.state.rounds[round]?.seats[alias] : null
  return { kind: 'autonomous', round, device: (wild ? undefined : seated) ?? pick(DEVICES, i)! }
}

const nat = fc.nat(1000)
const wild = fc.boolean().chain((b) => (b ? fc.constant(false) : fc.boolean())) // 25% wild
const text = fc.string({ minLength: 1, maxLength: 12 }).map((s) => `x${s}`)

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 8, arbitrary: fc.tuple(nat, nat, nat, wild, text).map(([who, kind, i, w, text]): Op => (id, sim) => {
      const principal = somebody(sim, who, w)
      // One post in four carries pictures: mostly from a person, sometimes (wild) from whatever path came up, sometimes too many.
      const path = pathFor(sim, principal, i % 4 === 0 && !w ? 0 : kind, i, w)
      const images = i % 4 === 0 ? Array.from({ length: w ? (i % 7) + 1 : (i % 3) + 1 }, (_, n) => ({ id: `b${i}_${n}`, type: 'image/png' as const, bytes: 10 + n, w: 4, h: 3 })) : undefined
      return { t: 'post', id, principal, path, text: images && i % 8 === 0 ? '' : text, to: [], cause: null, ...(images ? { images } : {}) }
    }) },
  { weight: 2, arbitrary: fc.tuple(nat, nat).map(([who, i]): Op => (id) => {
      const k = who % PEOPLE.length
      return { t: 'join', id, member: { principal: PEOPLE[k]!, alias: `${ALIASES[k]}${i}` as AliasId, handle: `h${k}` } }
    }) },
  { weight: 1, arbitrary: fc.tuple(nat, wild).map(([who, w]): Op => (id, sim) => ({ t: 'leave', id, principal: somebody(sim, who, w) })) },
  // A small pool of names, some of them already someone else's, in either letter case.
  { weight: 2, arbitrary: fc.tuple(nat, fc.nat(9), wild).map(([who, name, w]): Op => (id, sim) => ({ t: 'set_handle', id, principal: somebody(sim, who, w), handle: name % 2 ? `H${name % 7}` : `h${name % 7}` })) },
  { weight: 3, arbitrary: fc.tuple(nat, nat, fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 40 }), fc.integer({ min: 1, max: 120 }), wild).map(([who, i, messages, chars, ttl, w]): Op => (id, sim) =>
      ({ t: 'round_open', id, principal: somebody(sim, who, w), round: freshRound(sim, i), goal: 'g', budget: { messages, chars, until: sim.now + ttl } })) },
  { weight: 3, arbitrary: fc.tuple(nat, nat, wild).map(([who, i, w]): Op => (id, sim) => ({ t: 'round_join', id, principal: somebody(sim, who, w), round: liveRound(sim, i, w) })) },
  { weight: 4, arbitrary: fc.tuple(nat, nat, nat, wild).map(([who, i, d, w]): Op => (id, sim) =>
      ({ t: 'round_seat', id, principal: somebody(sim, who, w), round: liveRound(sim, i, w), device: pick(DEVICES, d)!, capable: !w || d % 2 === 0 })) },
  { weight: 1, arbitrary: fc.tuple(nat, nat, wild).map(([who, i, w]): Op => (id, sim) => ({ t: 'round_close', id, principal: somebody(sim, who, w), round: liveRound(sim, i, w) })) },
  { weight: 3, arbitrary: fc.tuple(nat, nat, nat, nat, wild, text).map(([who, kind, i, n, w, text]): Op => (id, sim) => {
      const principal = somebody(sim, who, w)
      const note = pick(NOTES, n)!
      return { t: 'note_revise', id, principal, path: pathFor(sim, principal, kind, i, w), note, base: w ? (i % 3) + 1 : headOf(sim, note), title: 't', text }
    }) },
  { weight: 5, arbitrary: fc.tuple(nat, nat, nat, wild).map(([who, n, i, w]): Op => (id, sim) => {
      const note = pick(NOTES, n)!
      return { t: 'note_endorse', id, principal: somebody(sim, who, w), note, rev: w ? (i % 3) + 1 : (headOf(sim, note) ?? 1) }
    }) },
  { weight: 1, arbitrary: fc.tuple(nat, fc.nat(7)).map(([who, rare]): Op => (id, sim) => (rare === 0 ? { t: 'archive', id, principal: somebody(sim, who, false) } : { t: 'tick' })) },
  { weight: 2, arbitrary: fc.constant<Op>(() => ({ t: 'tick' })) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 30 }).map((advance): Op => () => ({ advance })) },
)

const start = (): Sim => {
  const sim: Sim = { state: emptyConv(CONV), log: [], now: 1000, n: 0 }
  return run(sim, () => ({
    t: 'create', id: 'e0' as EventId, topic: 'topic', invite: 'any_member', parent: null,
    creator: { principal: PEOPLE[0]!, alias: ALIASES[0]!, handle: 'h0' },
    members: [{ principal: PEOPLE[1]!, alias: ALIASES[1]!, handle: 'h1' }],
  }))
}

const run = (sim: Sim, f: Op): Sim => {
  const next = { ...sim, n: sim.n + 1 }
  const c = f(`e${next.n}` as EventId, sim)
  if ('advance' in c) return { ...next, now: sim.now + c.advance }
  let k = 0
  const r = step(sim.state, c, { now: sim.now, nextId: () => `e${next.n}_${k++}` as EventId })
  return { ...next, state: r.state, log: [...sim.log, ...r.events] }
}

const simulate = (ops: Op[]): Sim => ops.reduce(run, start())

/** Replays the log, handing each event the state it was appended to. */
const replay = (log: StoredConvEvent[], check: (before: ConvState, e: StoredConvEvent) => void): void => {
  log.reduce((s, e) => (check(s, e), apply(s, e)), emptyConv(CONV))
}

const prop = (check: (sim: Sim) => void) =>
  fc.assert(fc.property(fc.array(op, { maxLength: 80 }), (ops) => check(simulate(ops))), { numRuns: 400 })

const authorAlias = (e: StoredConvEvent): AliasId | null => {
  const b = e.body
  switch (b.kind) {
    case 'message': case 'note_revision': return b.author.alias
    case 'receipt': case 'note_endorsed': case 'conv_renamed': case 'retention_set': case 'conv_archived': return b.by
    case 'round_opened': return b.by
    case 'round_joined': case 'round_seated': case 'member_left': case 'member_renamed': return b.alias
    default: return null
  }
}

describe('conversation log invariants', () => {
  it('I5: seq is gapless and strictly increasing, and state is a pure fold of the log', () =>
    prop(({ state, log }) => {
      expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1))
      expect(fold(CONV, log)).toEqual(state)
    }))

  it('I1: every message came through exactly one of the three gates', () =>
    prop(({ log }) =>
      replay(log, (before, e) => {
        if (e.body.kind !== 'message') return
        const a = e.body.author
        if (a.kind === 'delegate') expect(e.private.draft).toBeDefined()
        if (a.kind === 'human') expect(e.private.draft).toBeUndefined()
        if (a.kind === 'autonomous') expect(before.rounds[a.round]?.closed).toBeNull()
      })))

  it('I4: autonomous writes need an open, joined, seated round and stay within its budget', () =>
    prop(({ state, log }) => {
      replay(log, (before, e) => {
        const author = e.body.kind === 'message' || e.body.kind === 'note_revision' ? e.body.author : null
        if (author?.kind !== 'autonomous') return
        const r = before.rounds[author.round]!
        expect(r.closed).toBeNull()
        expect(e.ts).toBeLessThan(r.budget.until)
        expect(r.seats[author.alias]).toBeTruthy()
      })
      for (const r of Object.values(state.rounds)) {
        expect(r.messages).toBeLessThanOrEqual(r.budget.messages)
        expect(r.chars).toBeLessThanOrEqual(r.budget.chars)
      }
    }))

  it('corollary: autonomous messages are bounded by the sum of human-opened budgets', () =>
    prop(({ state, log }) => {
      const autonomous = log.filter((e) => e.body.kind === 'message' && e.body.author.kind === 'autonomous').length
      const granted = Object.values(state.rounds).reduce((n, r) => n + r.budget.messages, 0)
      expect(autonomous).toBeLessThanOrEqual(granted)
    }))

  it('I3: a seat is held by at most one device for the life of a round', () =>
    prop(({ log }) => {
      const holders = new Map<string, Set<string>>()
      for (const e of log) {
        if (e.body.kind !== 'round_seated') continue
        const key = `${e.body.round}/${e.body.alias}`
        holders.set(key, (holders.get(key) ?? new Set()).add(e.private.device!))
      }
      for (const set of holders.values()) expect(set.size).toBe(1)
    }))

  it('I9: budgets never change, at most one round is open, and a tick past the deadline closes it', () =>
    prop((sim) => {
      const opened = new Map<RoundId, unknown>()
      replay(sim.log, (before, e) => {
        if (e.body.kind === 'round_opened') {
          opened.set(e.body.round, e.body.budget)
          expect(Object.values(before.rounds).every((r) => r.closed !== null)).toBe(true)
        }
      })
      for (const r of Object.values(sim.state.rounds)) expect(r.budget).toEqual(opened.get(r.id))
      const late = run({ ...sim, now: sim.now + 1_000_000 }, () => ({ t: 'tick' }))
      expect(Object.values(late.state.rounds).every((r) => r.closed !== null)).toBe(true)
    }))

  it('I10: an adopted revision was endorsed by every member present at adoption', () =>
    prop(({ state, log }) => {
      const endorsements = (n: NoteId, rev: number, upTo: number) =>
        new Set(log.filter((e) => e.seq <= upTo && e.body.kind === 'note_endorsed' && e.body.note === n && e.body.rev === rev)
          .map((e) => (e.body as { by: AliasId }).by))
      for (const n of Object.values(state.notes)) {
        for (const r of n.revs) {
          if (r.adoptedSeq === null) continue
          const at = fold(CONV, log.filter((e) => e.seq <= r.adoptedSeq!))
          const who = endorsements(n.id, r.rev, r.adoptedSeq)
          expect(activeMembers(at).length).toBeGreaterThan(0)
          for (const m of activeMembers(at)) expect(who.has(m.alias)).toBe(true)
        }
      }
    }))

  it('I10: autonomous revisions are never self-endorsed', () =>
    prop(({ state }) => {
      for (const n of Object.values(state.notes)) {
        for (const r of n.revs) if (r.author.kind === 'autonomous' && r.endorsed.length === 0) expect(r.adoptedSeq).toBeNull()
      }
    }))

  it('I11: only current members write, and nothing but leave is written after archive', () =>
    prop(({ log }) =>
      replay(log, (before, e) => {
        const alias = authorAlias(e)
        if (alias) expect(before.members[alias]?.leftSeq).toBeNull()
        if (before.archivedSeq !== null) expect(e.body.kind).toBe('member_left')
        expect(activeMembers(before).length).toBeLessThanOrEqual(20)
      })))

  it('I12: an invited member receives nothing from before the join', () =>
    prop(({ state, log }) => {
      for (const e of log) {
        for (const m of recipientsAt(state, e.seq)) {
          const joined = log.find((x) => x.body.kind === 'member_joined' && x.body.alias === m.alias)!
          if (joined.body.kind === 'member_joined' && joined.body.via === 'invite') expect(e.seq).toBeGreaterThanOrEqual(joined.seq)
        }
      }
    }))

  it('handles are unique among everyone who is or was in the conversation, per person', () =>
    prop(({ state }) => {
      const active = activeMembers(state)
      expect(new Set(active.map((m) => m.handle.toLowerCase())).size).toBe(active.length)
      expect(new Set(active.map((m) => m.principal)).size).toBe(active.length)
      // Nobody ever holds a name that is, or was last, someone else's.
      const all = Object.values(state.members)
      for (const a of all) for (const b of all) if (a.principal !== b.principal) expect(a.handle.toLowerCase()).not.toBe(b.handle.toLowerCase())
    }))

  it('only a person attaches pictures, at most four, and a message is never empty', () =>
    prop(({ log }) => {
      for (const e of log) {
        if (e.body.kind !== 'message') continue
        const images = e.body.images ?? []
        if (images.length > 0) expect(e.body.author.kind).toBe('human')
        expect(images.length).toBeLessThanOrEqual(4)
        expect(new Set(images.map((i) => i.id)).size).toBe(images.length)
        expect(e.body.text.trim() !== '' || images.length > 0).toBe(true)
      }
    }))

  it('a rename changes one member\'s label and nothing else', () =>
    prop(({ log }) =>
      replay(log, (before, e) => {
        if (e.body.kind !== 'member_renamed') return
        const after = apply(before, e)
        expect(before.members[e.body.alias]!.handle).toBe(e.body.was)
        expect(after.members[e.body.alias]).toEqual({ ...before.members[e.body.alias]!, handle: e.body.handle })
        expect({ ...after, members: before.members, seq: before.seq }).toEqual(before)
      })))
})

describe('generator coverage', () => {
  it('reaches the states the invariants talk about (the properties are not vacuous)', () => {
    const sims = fc.sample(fc.array(op, { minLength: 40, maxLength: 80 }), { numRuns: 600, seed: 7 }).map(simulate)
    const count = (f: (s: Sim) => boolean) => sims.filter(f).length
    const kinds = (s: Sim) => s.log.map((e) => e.body)
    expect(count((s) => kinds(s).some((b) => b.kind === 'message' && b.author.kind === 'autonomous'))).toBeGreaterThan(10)
    expect(count((s) => kinds(s).some((b) => b.kind === 'round_closed' && b.reason === 'budget'))).toBeGreaterThan(3)
    expect(count((s) => kinds(s).some((b) => b.kind === 'round_closed' && b.reason === 'expired'))).toBeGreaterThan(10)
    expect(count((s) => kinds(s).some((b) => b.kind === 'note_revision' && b.author.kind === 'autonomous'))).toBeGreaterThan(3)
    expect(count((s) => Object.values(s.state.notes).some((n) => n.revs.some((r) => r.adoptedSeq !== null)))).toBeGreaterThan(10)
    expect(count((s) => kinds(s).some((b) => b.kind === 'member_joined' && b.via === 'invite'))).toBeGreaterThan(10)
    expect(count((s) => kinds(s).some((b) => b.kind === 'member_renamed'))).toBeGreaterThan(10)
    expect(count((s) => kinds(s).some((b) => b.kind === 'message' && (b.images?.length ?? 0) > 0))).toBeGreaterThan(10)
    expect(count((s) => kinds(s).some((b) => b.kind === 'message' && b.text === '' && (b.images?.length ?? 0) > 0))).toBeGreaterThan(3)
  })
})

describe('conversation decisions', () => {
  const env = (now = 1000) => { let k = 0; return { now, nextId: () => `g${k++}` as EventId } }
  const base = start().state
  const [p1, p2] = PEOPLE as [PrincipalId, PrincipalId]
  const r = ROUNDS[0]!
  const exec = (s: ConvState, c: Command, now = 1000) => step(s, c, env(now))
  const seated = (budget = { messages: 2, chars: 100, until: 2000 }) => {
    const a = exec(base, { t: 'round_open', id: 'a' as EventId, principal: p1, round: r, goal: 'g', budget }).state
    return exec(a, { t: 'round_seat', id: 'b' as EventId, principal: p1, round: r, device: DEVICES[0]!, capable: true }).state
  }
  const say = (s: ConvState, id: string, d = DEVICES[0]!, now = 1000, principal = p1) =>
    exec(s, { t: 'post', id: id as EventId, principal, path: { kind: 'autonomous', round: r, device: d }, text: 'hello', to: [], cause: null }, now)

  it('closes the round on the message that exhausts the budget, and rejects the next', () => {
    const one = say(seated(), 'm1')
    expect(one.error).toBeNull()
    const two = say(one.state, 'm2')
    expect(two.events.map((e) => e.body.kind)).toEqual(['message', 'round_closed'])
    expect(say(two.state, 'm3').error?.error).toBe('round_closed')
  })

  it('rejects an over-budget message and still closes the round', () => {
    const s = seated({ messages: 5, chars: 7, until: 2000 })
    const over = say(say(s, 'm1').state, 'm2')
    expect(over.error?.error).toBe('budget_exceeded')
    expect(over.events.map((e) => e.body.kind)).toEqual(['round_closed'])
    expect(over.state.rounds[r]!.closed?.reason).toBe('budget')
  })

  it('refuses a second device, an unjoined member, and a device that cannot sandbox', () => {
    const s = seated()
    expect(say(s, 'm', DEVICES[1]!).error?.error).toBe('round_not_seated')
    expect(say(s, 'm', DEVICES[0]!, 1000, p2).error?.error).toBe('round_not_joined')
    expect(exec(s, { t: 'round_seat', id: 'x' as EventId, principal: p1, round: r, device: DEVICES[1]!, capable: true }).error?.error).toBe('seat_taken')
    const joined = exec(s, { t: 'round_join', id: 'j' as EventId, principal: p2, round: r }).state
    expect(exec(joined, { t: 'round_seat', id: 'y' as EventId, principal: p2, round: r, device: DEVICES[0]!, capable: false }).error?.error).toBe('seat_not_capable')
  })

  it('expires a round on first contact after the deadline', () => {
    const late = say(seated(), 'm', DEVICES[0]!, 2000)
    expect(late.error?.error).toBe('round_closed')
    expect(late.state.rounds[r]!.closed?.reason).toBe('expired')
  })

  it('adopts a note only once every current member has endorsed the same revision', () => {
    const n = NOTES[0]!
    const v1 = exec(base, { t: 'note_revise', id: 'n1' as EventId, principal: p1, path: { kind: 'human' }, note: n, base: null, title: 'T', text: 'body' }).state
    expect(v1.notes[n]!.revs[0]!.adoptedSeq).toBeNull()
    const v2 = exec(v1, { t: 'note_revise', id: 'n2' as EventId, principal: p2, path: { kind: 'human' }, note: n, base: 1, title: 'T', text: 'body 2' }).state
    expect(exec(v2, { t: 'note_endorse', id: 'x' as EventId, principal: p1, note: n, rev: 1 }).error?.error).toBe('note_base_stale')
    const done = exec(v2, { t: 'note_endorse', id: 'n3' as EventId, principal: p1, note: n, rev: 2 }).state
    expect(done.notes[n]!.revs.map((x) => x.adoptedSeq !== null)).toEqual([false, true])
  })

  it('the last person to leave archives the conversation; an earlier leaver does not', () => {
    const one = exec(base, { t: 'leave', id: 'l1' as EventId, principal: p2 })
    expect(one.events.map((e) => e.body.kind)).toEqual(['member_left'])
    expect(one.state.archivedSeq).toBeNull()
    const two = exec(one.state, { t: 'leave', id: 'l2' as EventId, principal: p1 })
    expect(two.events.map((e) => e.body.kind)).toEqual(['conv_archived', 'member_left'])
    expect(two.state.archivedSeq).not.toBeNull()
    expect(activeMembers(two.state)).toEqual([])
  })

  it('a round ends with the single note revision it produces', () => {
    const n = NOTES[1]!
    const out = exec(seated(), { t: 'note_revise', id: 'n' as EventId, principal: p1, path: { kind: 'autonomous', round: r, device: DEVICES[0]! }, note: n, base: null, title: 'T', text: 'minutes' })
    expect(out.events.map((e) => e.body.kind)).toEqual(['note_revision', 'round_closed'])
    expect(out.state.notes[n]!.revs[0]!.endorsed).toEqual([])
  })
})
