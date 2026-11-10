// The per-message inbox state machine (section 5 of the spec).
//
//   unread --read--> read
//   unread|read --handed_off--> handed_off
//   handed_off --claimed(device)--> claimed          (agent, compare-and-set)
//   claimed --done--> done                           (the claiming device, or a human)
//   claimed --claim_expired--> handed_off            (server, 10 min without heartbeat)
//
// Any transition not listed is rejected. Who may trigger which transition is
// part of the function, so the scope separation (I1, I3, I8) is decided here.

import type { HandoffMode, InboxBody } from './events'
import { LIMITS } from './events'
import type { DeviceId, EventId } from './ids'
import { err, ok, type Result } from './result'

export type ItemState =
  | { s: 'unread' }
  | { s: 'read' }
  | { s: 'handed_off'; mode: HandoffMode }
  | { s: 'claimed'; mode: HandoffMode; device: DeviceId; beat: number }
  | { s: 'done' }

export type Actor = { scope: 'human' } | { scope: 'agent'; device: DeviceId } | { scope: 'server' }

export type ItemAction =
  | { a: 'read' }
  | { a: 'handoff'; mode: HandoffMode }
  | { a: 'claim' }
  | { a: 'heartbeat' }
  | { a: 'done' }
  | { a: 'expire' }

export type Transition = { state: ItemState; log: InboxBody | null }

const moved = (state: ItemState, log: InboxBody | null): Result<Transition> => ok({ state, log })
const refused = err('invalid_transition')

export const claimExpired = (state: ItemState, now: number): boolean =>
  state.s === 'claimed' && now - state.beat >= LIMITS.claimTimeoutMs

export const transition = (
  msg: EventId, state: ItemState, action: ItemAction, actor: Actor, now: number,
): Result<Transition> => {
  switch (action.a) {
    case 'read':
      if (actor.scope !== 'human') return err('forbidden_scope')
      return state.s === 'unread' ? moved({ s: 'read' }, { kind: 'read', msg }) : refused
    case 'handoff':
      if (actor.scope !== 'human') return err('forbidden_scope')
      return state.s === 'unread' || state.s === 'read'
        ? moved({ s: 'handed_off', mode: action.mode }, { kind: 'handed_off', msg, mode: action.mode })
        : refused
    case 'claim':
      if (actor.scope !== 'agent') return err('forbidden_scope')
      if (state.s === 'claimed') return state.device === actor.device ? moved({ ...state, beat: now }, null) : err('claim_conflict')
      return state.s === 'handed_off'
        ? moved({ s: 'claimed', mode: state.mode, device: actor.device, beat: now }, { kind: 'claimed', msg, device: actor.device })
        : refused
    case 'heartbeat':
      if (actor.scope !== 'agent') return err('forbidden_scope')
      if (state.s !== 'claimed') return refused
      return state.device === actor.device ? moved({ ...state, beat: now }, null) : err('not_claimer')
    case 'done':
      if (state.s !== 'claimed') return refused
      if (actor.scope === 'agent' && actor.device !== state.device) return err('not_claimer')
      if (actor.scope === 'server') return err('forbidden_scope')
      return moved({ s: 'done' }, { kind: 'done', msg })
    case 'expire':
      if (actor.scope !== 'server') return err('forbidden_scope')
      return claimExpired(state, now)
        ? moved({ s: 'handed_off', mode: (state as Extract<ItemState, { s: 'claimed' }>).mode }, { kind: 'claim_expired', msg })
        : refused
  }
}

/** Does this item make its conversation readable to `device` (I2)? */
export const grantsRead = (state: ItemState, device: DeviceId): boolean =>
  state.s === 'handed_off' || (state.s === 'claimed' && state.device === device)

/** Rebuild an item's state from its slice of the inbox log. */
export const foldItem = (events: readonly { ts: number; body: InboxBody }[]): ItemState | null =>
  events.reduce<ItemState | null>((state, { ts, body }) => {
    switch (body.kind) {
      case 'delivered':
        return body.addressed ? { s: 'unread' } : state
      case 'read':
        return { s: 'read' }
      case 'handed_off':
        return { s: 'handed_off', mode: body.mode }
      case 'claimed':
        return state && state.s === 'handed_off' ? { s: 'claimed', mode: state.mode, device: body.device, beat: ts } : state
      case 'claim_expired':
        return state && state.s === 'claimed' ? { s: 'handed_off', mode: state.mode } : state
      case 'done':
        return { s: 'done' }
      default:
        return state
    }
  }, null)
