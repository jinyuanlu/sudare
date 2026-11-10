// Identifiers. Every id is an opaque branded string; routing information
// (which conversation a round or note belongs to) is encoded structurally so
// the Worker can find the owning Durable Object without a directory lookup.

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type PrincipalId = Brand<string, 'PrincipalId'>
export type DeviceId = Brand<string, 'DeviceId'>
export type ConvId = Brand<string, 'ConvId'>
export type AliasId = Brand<string, 'AliasId'>
export type EventId = Brand<string, 'EventId'>
export type RoundId = Brand<string, 'RoundId'>
export type NoteId = Brand<string, 'NoteId'>
export type DraftId = Brand<string, 'DraftId'>
export type InviteId = Brand<string, 'InviteId'>

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID = '[0-9A-HJKMNP-TV-Z]{26}'

const encodeTime = (ms: number): string => {
  let out = ''
  let rest = Math.floor(ms)
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[rest % 32]! + out
    rest = Math.floor(rest / 32)
  }
  return out
}

const encodeRandom = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => CROCKFORD[b % 32]!).join('')

/** A ULID: 48 bits of time, 80 bits of randomness, lexicographically sortable. */
export const ulid = (now: number = Date.now()): string =>
  encodeTime(now) + encodeRandom(crypto.getRandomValues(new Uint8Array(16)))

const make =
  <T extends string>(prefix: string) =>
  (now?: number): T =>
    `${prefix}_${ulid(now)}` as T

const matcher =
  <T extends string>(pattern: string) =>
  (value: unknown): value is T =>
    typeof value === 'string' && new RegExp(`^${pattern}$`).test(value)

export const newPrincipalId = make<PrincipalId>('p')
export const newDeviceId = make<DeviceId>('d')
export const newConvId = make<ConvId>('c')
export const newAliasId = make<AliasId>('a')
export const newDraftId = make<DraftId>('f')
export const newInviteId = make<InviteId>('i')
export const newEventId = (now?: number): EventId => ulid(now) as EventId

export const isPrincipalId = matcher<PrincipalId>(`p_${ULID}`)
export const isDeviceId = matcher<DeviceId>(`d_${ULID}`)
export const isConvId = matcher<ConvId>(`c_${ULID}`)
export const isAliasId = matcher<AliasId>(`a_${ULID}`)
export const isEventId = matcher<EventId>(ULID)
export const isDraftId = matcher<DraftId>(`f_${ULID}`)
export const isInviteId = matcher<InviteId>(`i_${ULID}`)
export const isRoundId = matcher<RoundId>(`r_${ULID}_${ULID}`)
export const isNoteId = matcher<NoteId>(`n_${ULID}_${ULID}`)

const scoped =
  <T extends string>(prefix: string) =>
  (conv: ConvId, now?: number): T =>
    `${prefix}_${conv.slice(2)}_${ulid(now)}` as T

export const newRoundId = scoped<RoundId>('r')
export const newNoteId = scoped<NoteId>('n')

/** The conversation a round or note lives in. */
export const convOf = (id: RoundId | NoteId): ConvId => `c_${id.slice(2, 28)}` as ConvId
