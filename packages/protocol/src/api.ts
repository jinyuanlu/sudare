// Wire shapes shared by the server, the PWA and the plugin.

import type { Author, Budget, ConvEvent, DraftTarget, HandoffMode, InboxEvent, InvitePolicy, RoundCloseReason } from './events'
import type { AliasId, ConvId, DeviceId, DraftId, EventId, InviteId, NoteId, RoundId } from './ids'
import type { ErrorCode } from './result'

export type ApiError = { error: ErrorCode; detail?: unknown }

export type MemberView = { alias: AliasId; handle: string; left: boolean; creator: boolean; me: boolean; active?: boolean }

export type RoundView = {
  id: RoundId
  by: AliasId
  goal: string
  budget: Budget
  used: { messages: number; chars: number }
  joined: AliasId[]
  seated: AliasId[]
  closed: RoundCloseReason | null
  opened_seq: number
}

export type NoteRevView = {
  rev: number
  base: number | null
  seq: number
  ts: number
  author: Author
  title: string
  endorsed: AliasId[]
  adopted: boolean
}

export type NoteView = {
  id: NoteId
  title: string
  head: number
  adopted: number | null
  revs: NoteRevView[]
}

export type ConvView = {
  id: ConvId
  topic: string
  invite: InvitePolicy
  parent: ConvId | null
  archived: boolean
  retention_days: number
  seq: number
  me: AliasId
  from_seq: number
  can_invite: boolean
  members: MemberView[]
  rounds: RoundView[]
}

export type ConvSummary = {
  id: ConvId
  topic: string
  alias: AliasId
  handle: string
  unread: number
  pending: number // addressed messages still unread
  last_seq: number
  last_ts: number
  members: number
  archived: boolean
  round: RoundId | null
}

export type InboxItem = {
  msg: EventId
  conv: ConvId
  topic: string
  seq: number
  ts: number
  from: string
  text: string
  state: 'unread' | 'read' | 'handed_off' | 'claimed' | 'done'
  mode: HandoffMode | null
  device: DeviceId | null
}

export type DraftView = {
  id: DraftId
  conv: ConvId | null
  topic: string | null
  target: DraftTarget
  text: string
  device: DeviceId
  device_name: string
  status: 'pending' | 'approving' | 'approved' | 'rejected'
  created: number
  result: { conv?: ConvId; event?: EventId; note?: NoteId; rev?: number } | null
}

export type InviteView = {
  id: InviteId
  conv: ConvId
  topic: string
  by: string
  members: number
  expires: number
  suggested_handle: string | null
}

/** `person` is stable for the same person across rooms, but only meaningful to the viewer it was computed for. */
export type ContactView = { conv: ConvId; topic: string; alias: AliasId; handle: string; person: string }

export type PendingInvite = { id: InviteId; kind: 'direct' | 'link'; name: string | null; expires: number; mine: boolean }

export type DeviceView = {
  id: DeviceId
  name: string
  kind: 'oauth' | 'token'
  client: string
  rounds: boolean
  created: number
  last_active: number | null
  expires: number | null
}

export type SeatView = { round: RoundId; conv: ConvId; topic: string; goal: string; device: DeviceId | null; brief: string }

export type SyncResponse = { events: InboxEvent[]; cursor: number; more: boolean }
export type EventsResponse = { events: ConvEvent[]; more: boolean }
export type SearchHit = { conv: ConvId; topic: string; kind: 'message' | 'note'; ref: string; seq: number; ts: number; snippet: string }
export type Me = { principal: string; default_handle: string | null; session_expires: number; vapid_key: string | null }
