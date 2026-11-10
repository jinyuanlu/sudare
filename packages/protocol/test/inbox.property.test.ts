import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { LIMITS, foldItem, grantsRead, transition, type Actor, type DeviceId, type EventId, type InboxBody, type ItemAction, type ItemState } from '../src'

const MSG = 'm' as EventId
const devices = ['d1', 'd2'] as DeviceId[]
const actor: fc.Arbitrary<Actor> = fc.oneof(
  fc.constant<Actor>({ scope: 'human' }),
  fc.constant<Actor>({ scope: 'server' }),
  fc.constantFrom(...devices).map((device): Actor => ({ scope: 'agent', device })),
)
const action: fc.Arbitrary<ItemAction> = fc.oneof(
  fc.constant<ItemAction>({ a: 'read' }),
  fc.constantFrom('readonly' as const, 'full' as const).map((mode): ItemAction => ({ a: 'handoff', mode })),
  fc.constant<ItemAction>({ a: 'claim' }),
  fc.constant<ItemAction>({ a: 'heartbeat' }),
  fc.constant<ItemAction>({ a: 'done' }),
  fc.constant<ItemAction>({ a: 'take_back' }),
  fc.constant<ItemAction>({ a: 'expire' }),
)
const steps = fc.array(fc.tuple(action, actor, fc.integer({ min: 0, max: LIMITS.claimTimeoutMs })), { maxLength: 40 })

// The table from the spec: state x log event -> allowed scopes.
const TABLE: Record<string, { from: ItemState['s'][]; to: ItemState['s']; by: Actor['scope'][] }> = {
  read: { from: ['unread'], to: 'read', by: ['human'] },
  handed_off: { from: ['unread', 'read'], to: 'handed_off', by: ['human'] },
  claimed: { from: ['handed_off'], to: 'claimed', by: ['agent'] },
  done: { from: ['unread', 'read', 'handed_off', 'claimed'], to: 'done', by: ['agent', 'human'] },
  taken_back: { from: ['handed_off', 'claimed'], to: 'read', by: ['human'] },
  claim_expired: { from: ['claimed'], to: 'handed_off', by: ['server'] },
}

type Trace = { state: ItemState; now: number; log: { ts: number; body: InboxBody }[] }
const delivered: InboxBody = { kind: 'delivered', msg: MSG, conv: 'c' as never, addressed: true }

const walk = (seq: [ItemAction, Actor, number][], visit?: (before: ItemState, body: InboxBody, by: Actor, now: number) => void): Trace =>
  seq.reduce<Trace>(
    (t, [a, by, dt]) => {
      const now = t.now + dt
      const r = transition(MSG, t.state, a, by, now)
      if (!r.ok) return { ...t, now }
      if (r.value.log) visit?.(t.state, r.value.log, by, now)
      return { state: r.value.state, now, log: r.value.log ? [...t.log, { ts: now, body: r.value.log }] : t.log }
    },
    { state: { s: 'unread' }, now: 0, log: [{ ts: 0, body: delivered }] },
  )

describe('inbox item state machine', () => {
  it('only takes the transitions in the table, each by the scope the table names', () =>
    fc.assert(fc.property(steps, (seq) => {
      walk(seq, (before, body, by) => {
        const row = TABLE[body.kind]!
        expect(row.from).toContain(before.s)
        expect(row.by).toContain(by.scope)
      })
    })))

  it('I3: while claimed, only the claiming device may finish it and no other device may claim it', () =>
    fc.assert(fc.property(steps, (seq) => {
      walk(seq, (before, body, by) => {
        if (before.s !== 'claimed') return
        if (body.kind === 'claimed') throw new Error('claimed twice')
        if (body.kind === 'done' && by.scope === 'agent') expect(by.device).toBe(before.device)
      })
    })))

  it('an agent can only finish a message it has claimed; a person can finish any', () =>
    fc.assert(fc.property(steps, (seq) => {
      walk(seq, (before, body, by) => {
        if (body.kind === 'done' && by.scope === 'agent') expect(before.s).toBe('claimed')
      })
    })))

  it('I8: a claim expires only after the timeout without a heartbeat, back to handed_off', () =>
    fc.assert(fc.property(steps, (seq) => {
      let beat = 0
      walk(seq, (before, body, _by, now) => {
        if (body.kind === 'claimed') beat = now
        if (body.kind === 'claim_expired' && before.s === 'claimed') expect(now - before.beat).toBeGreaterThanOrEqual(LIMITS.claimTimeoutMs)
      })
      void beat
    })))

  it('the state is a fold of the log (up to heartbeat times)', () =>
    fc.assert(fc.property(steps, (seq) => {
      const t = walk(seq)
      const folded = foldItem(t.log)!
      expect(folded.s).toBe(t.state.s)
      if (folded.s === 'claimed' && t.state.s === 'claimed') expect(folded.device).toBe(t.state.device)
    })))

  it('I2: an item grants read access only while handed off, or to the device that claimed it', () => {
    const [d1, d2] = devices as [DeviceId, DeviceId]
    expect(grantsRead({ s: 'unread' }, d1)).toBe(false)
    expect(grantsRead({ s: 'read' }, d1)).toBe(false)
    expect(grantsRead({ s: 'handed_off', mode: 'full' }, d1)).toBe(true)
    expect(grantsRead({ s: 'claimed', mode: 'full', device: d1, beat: 0 }, d1)).toBe(true)
    expect(grantsRead({ s: 'claimed', mode: 'full', device: d1, beat: 0 }, d2)).toBe(false)
    expect(grantsRead({ s: 'done' }, d1)).toBe(false)
  })
})
