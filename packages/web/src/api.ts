// The only place that talks HTTP. Everything is same-origin JSON under /api.

import {
  ERROR_CODES,
  type AliasId, type AliasRef, type ContactView, type ConvEvent, type ConvId, type ConvSummary, type ConvView, type DeviceId,
  type DeviceView, type DraftId, type DraftView, type ErrorCode, type EventId, type EventsResponse, type HandoffMode,
  type InboxItem, type InviteId, type PendingInvite, type InviteView, type Me, type NoteId, type NoteView, type RoundId, type SearchHit, type SyncResponse,
} from '@sudare/protocol'
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'

export type FailureCode = ErrorCode | 'network'

export class ApiFailure extends Error {
  constructor(readonly code: FailureCode, readonly status: number, readonly detail?: unknown) {
    super(code)
    this.name = 'ApiFailure'
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isErrorCode = (v: unknown): v is ErrorCode => typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v)

let onUnauthenticated: () => void = () => undefined
export const setUnauthenticatedHandler = (f: () => void): void => { onUnauthenticated = f }

type Options = { anon?: boolean } // anon: a 401 is an answer here, not a reason to leave the page

const request = async <T>(method: string, path: string, body?: unknown, opts: Options = {}): Promise<T> => {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiFailure('network', 0)
  }
  const data: unknown = await res.json().catch(() => null)
  // Success bodies are trusted to match the shared protocol types; failures are narrowed.
  if (res.ok) return data as T
  const code: ErrorCode = isRecord(data) && isErrorCode(data.error) ? data.error : res.status === 401 ? 'unauthenticated' : 'unavailable'
  if (res.status === 401 && !opts.anon) onUnauthenticated()
  throw new ApiFailure(code, res.status, isRecord(data) ? data.detail : undefined)
}

const get = <T>(path: string, opts?: Options) => request<T>('GET', path, undefined, opts)
const post = <T = Record<string, never>>(path: string, body: unknown = {}, opts?: Options) => request<T>('POST', path, body, opts)
const q = (params: Record<string, string | number | null | undefined>): string => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) s.set(k, String(v))
  const out = s.toString()
  return out ? `?${out}` : ''
}

export type Ceremony<O> = { id: string; options: O }
export type Assertion = { id: string; response: unknown }
export type Site = { signup: boolean; notice: string }
export type JoinCheck = { valid: boolean; registered: boolean; topic: string | null; by: string | null; members: number }
export type JoinCard = Omit<InviteView, 'suggested_handle'> & { suggested_handle: string | null; joined: boolean }
export type Created = { conv: ConvId; existing: boolean; joined: number; invited: number }
export type NoteRead = { note: NoteView; rev: number; title: string; text: string }
export type LinkInfo = { device: string; code: string; confirmed: boolean; expires: number; remember_hours: number }
export type InviteLink = { id: InviteId; url: string; expires: number }
export type NewToken = { id: DeviceId; token: string; mcp: string }
export type Revision = { id: EventId; title: string; text: string; base: number | null }
export type NewConv = {
  topic: string; members: AliasRef[]; parent: ConvId | null; handle: string | null
  first: { id: EventId; text: string } | null; dm?: boolean
}
export type Outgoing = { id: EventId; text: string; to: AliasId[]; cause: EventId | null }

export const api = {
  me: () => get<Me>('/me', { anon: true }),
  loginOptions: () => post<Ceremony<PublicKeyCredentialRequestOptionsJSON>>('/auth/login/options', {}, { anon: true }),
  loginVerify: (a: Assertion) => post('/auth/login/verify', a, { anon: true }),
  registerOptions: (code: string) => post<Ceremony<PublicKeyCredentialCreationOptionsJSON>>('/auth/register/options', { code }, { anon: true }),
  registerVerify: (a: Assertion) => post('/auth/register/verify', a, { anon: true }),
  site: () => get<Site>('/site', { anon: true }),
  signup: () => post<{ code: string }>('/signup', {}, { anon: true }),
  logout: () => post('/auth/logout', {}, { anon: true }),
  passkeyOptions: () => post<Ceremony<PublicKeyCredentialCreationOptionsJSON>>('/passkeys/options'),
  passkeyVerify: (a: Assertion) => post('/passkeys/verify', a),

  link: (id: string) => get<LinkInfo>(`/link/${encodeURIComponent(id)}`),
  linkOptions: (id: string) => post<Ceremony<PublicKeyCredentialRequestOptionsJSON>>(`/link/${encodeURIComponent(id)}/options`),
  linkConfirm: (id: string, a: Assertion) => post<{ expires: number }>(`/link/${encodeURIComponent(id)}/confirm`, a),

  sync: (since: number | null) => get<SyncResponse>(`/sync${q({ since })}`),
  pushSubscribe: (endpoint: string) => post('/push/subscribe', { endpoint }),
  pushUnsubscribe: (endpoint: string) => post('/push/unsubscribe', { endpoint }),

  convs: () => get<ConvSummary[]>('/convs'),
  contacts: () => get<ContactView[]>('/contacts'),
  pendingInvites: (id: ConvId) => get<PendingInvite[]>(`/convs/${id}/invites`),
  withdrawInvite: (id: ConvId, invite: string) => request<Record<string, never>>('DELETE', `/convs/${id}/invites/${invite}`),
  createConv: (input: NewConv) => post<Created>('/convs', input),
  conv: (id: ConvId) => get<ConvView>(`/convs/${id}`),
  patchConv: (id: ConvId, patch: { topic?: string; retention_days?: number }) => request<ConvView>('PATCH', `/convs/${id}`, patch),
  invite: (id: ConvId, to: AliasRef) => post<{ invite: InviteId }>(`/convs/${id}/invites`, { to }),
  inviteLink: (id: ConvId) => post<InviteLink>(`/convs/${id}/invites`, { link: true }),
  roomLink: (id: ConvId) => post<InviteLink>(`/convs/${id}/invites`, { room: true }),
  leave: (id: ConvId) => post(`/convs/${id}/leave`),
  archive: (id: ConvId) => post(`/convs/${id}/archive`),
  events: (id: ConvId, page: { before?: number; after?: number; limit?: number }) => get<EventsResponse>(`/convs/${id}/events${q(page)}`),
  send: (id: ConvId, m: Outgoing) => post<{ event: ConvEvent }>(`/convs/${id}/messages`, m),
  read: (id: ConvId, seq: number) => post(`/convs/${id}/read`, { seq }),

  invites: () => get<InviteView[]>('/invites'),
  acceptInvite: (id: InviteId, handle: string | null) => post<{ conv: ConvId }>(`/invites/${id}/accept`, { handle }),
  declineInvite: (id: InviteId) => post(`/invites/${id}/decline`),
  joinCheck: (code: string) => get<JoinCheck>(`/join/${encodeURIComponent(code)}/check`, { anon: true }),
  joinCard: (code: string) => get<JoinCard>(`/join/${encodeURIComponent(code)}`),
  joinAccept: (code: string, handle: string | null) => post<{ conv: ConvId }>(`/join/${encodeURIComponent(code)}/accept`, { handle }),

  inbox: () => get<InboxItem[]>('/inbox'),
  inboxRead: (msg: EventId) => post<{ state: InboxItem['state'] }>(`/inbox/${msg}/read`),
  inboxHandoff: (msg: EventId, mode: HandoffMode) => post<{ state: InboxItem['state'] }>(`/inbox/${msg}/handoff`, { mode }),
  inboxDone: (msg: EventId) => post<{ state: InboxItem['state'] }>(`/inbox/${msg}/done`),
  inboxTakeBack: (msg: EventId) => post<{ state: InboxItem['state'] }>(`/inbox/${msg}/takeback`),

  drafts: () => get<DraftView[]>('/drafts'),
  approveDraft: (id: DraftId, text: string | null) => post<NonNullable<DraftView['result']>>(`/drafts/${id}/approve`, text === null ? {} : { text }),
  rejectDraft: (id: DraftId) => post(`/drafts/${id}/reject`),

  openRound: (id: ConvId, r: { goal: string; messages: number; chars: number; minutes: number; brief: string }) => post<{ round: RoundId }>(`/convs/${id}/rounds`, r),
  joinRound: (id: RoundId, brief: string) => post(`/rounds/${id}/join`, { brief }),
  closeRound: (id: RoundId) => post(`/rounds/${id}/close`),

  notes: (id: ConvId) => get<NoteView[]>(`/convs/${id}/notes`),
  note: (id: NoteId, rev?: number) => get<NoteRead>(`/notes/${id}${q({ rev })}`),
  newNote: (id: ConvId, r: Revision) => post<{ note: NoteId; rev: number }>(`/convs/${id}/notes`, r),
  reviseNote: (id: NoteId, r: Revision) => post<{ note: NoteId; rev: number }>(`/notes/${id}/revisions`, r),
  endorse: (id: NoteId, rev: number) => post(`/notes/${id}/endorse`, { rev }),
  exportUrl: (id: NoteId, rev: number) => `/api/notes/${id}/export?rev=${rev}`,

  devices: () => get<DeviceView[]>('/devices'),
  newToken: (input: { name: string; days: number; rounds: boolean }) => post<NewToken>('/devices/token', input),
  patchDevice: (id: DeviceId, input: { name: string; rounds: boolean }) => request<Record<string, never>>('PATCH', `/devices/${id}`, input),
  revokeDevice: (id: DeviceId) => request<Record<string, never>>('DELETE', `/devices/${id}`),

  search: (query: string) => get<SearchHit[]>(`/search${q({ q: query })}`),
}
