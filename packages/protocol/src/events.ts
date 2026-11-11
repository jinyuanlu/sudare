import type {
  AliasId, ConvId, DeviceId, DraftId, EventId, InviteId, NoteId, PrincipalId, RoundId,
} from './ids'

// ---------------------------------------------------------------------------
// Conversation log (shared by the members of one conversation)
// ---------------------------------------------------------------------------

export type Author =
  | { kind: 'human'; alias: AliasId } // sent directly by the person
  | { kind: 'delegate'; alias: AliasId } // drafted by an agent, approved by the person
  | { kind: 'autonomous'; alias: AliasId; round: RoundId } // agent, inside a discussion round

/** Immutable once the round is opened. `until` is epoch milliseconds. */
export type Budget = { messages: number; chars: number; until: number }

export type InvitePolicy = 'any_member' | 'creator'
export type JoinVia = 'creator' | 'fork' | 'invite'
export type RoundCloseReason = 'budget' | 'expired' | 'closed' | 'note_proposed'
export type ReceiptState = 'read' | 'handed_off' | 'done'

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type ImageType = (typeof IMAGE_TYPES)[number]
/** A picture attached to a message. The bytes live with the room; this is what the log says about them. */
export type ImageRef = { id: string; type: ImageType; bytes: number; w: number; h: number }

export type ConvBody =
  | { kind: 'conv_created'; topic: string; by: AliasId; invite: InvitePolicy; parent: ConvId | null }
  | { kind: 'conv_renamed'; topic: string; by: AliasId }
  | { kind: 'retention_set'; days: number; by: AliasId }
  | { kind: 'member_joined'; alias: AliasId; handle: string; via: JoinVia }
  | { kind: 'member_renamed'; alias: AliasId; handle: string; was: string }
  | { kind: 'member_left'; alias: AliasId }
  | { kind: 'conv_archived'; by: AliasId }
  | { kind: 'message'; author: Author; text: string; to: AliasId[]; cause: EventId | null; images?: ImageRef[] }
  | { kind: 'receipt'; of: EventId; by: AliasId; state: ReceiptState }
  | { kind: 'round_opened'; round: RoundId; by: AliasId; goal: string; budget: Budget }
  | { kind: 'round_joined'; round: RoundId; alias: AliasId }
  | { kind: 'round_seated'; round: RoundId; alias: AliasId }
  | { kind: 'round_closed'; round: RoundId; reason: RoundCloseReason }
  | { kind: 'note_revision'; note: NoteId; rev: number; base: number | null; author: Author; title: string; text: string }
  | { kind: 'note_endorsed'; note: NoteId; rev: number; by: AliasId }

export type ConvKind = ConvBody['kind']

/**
 * Server-only annotations stored beside an event. Never served to members:
 * this is where the alias -> principal mapping and device identities live.
 */
export type ConvPrivate = {
  principal?: PrincipalId // member_joined: who is behind the alias
  device?: DeviceId // round_seated: which device holds the seat
  draft?: DraftId // delegate writes: the approved draft
}

export type ConvEvent = {
  id: EventId // ULID, client generated, the idempotency key
  conv: ConvId
  seq: number // strictly increasing per conversation, server assigned
  ts: number
  body: ConvBody
}

export type StoredConvEvent = ConvEvent & { private: ConvPrivate }

// ---------------------------------------------------------------------------
// Inbox log (private, one per person)
// ---------------------------------------------------------------------------

export type HandoffMode = 'readonly' | 'full'

/** "The alias X in conversation Y": how a person refers to someone they have met. */
export type AliasRef = { conv: ConvId; alias: AliasId }

export type DraftTarget =
  | { kind: 'message'; to: AliasId[]; cause: EventId | null }
  | { kind: 'note'; note: NoteId | null; base: number | null; title: string }
  | { kind: 'conv'; topic: string; members: AliasRef[]; parent: ConvId | null } // text is the first message

export type InboxBody =
  | { kind: 'conv_invited'; invite: InviteId; conv: ConvId; topic: string; by: string; members: number }
  | { kind: 'invite_answered'; invite: InviteId; accepted: boolean }
  | { kind: 'conv_joined'; conv: ConvId; alias: AliasId; from_seq: number }
  | { kind: 'conv_left'; conv: ConvId }
  | { kind: 'delivered'; msg: EventId; conv: ConvId; addressed: boolean }
  | { kind: 'notice'; conv: ConvId; seq: number; event: ConvKind }
  | { kind: 'picked'; msg: EventId; conv: ConvId } // a message that was not addressed to this person, which they chose to deal with
  | { kind: 'read'; msg: EventId }
  | { kind: 'handed_off'; msg: EventId; mode: HandoffMode }
  | { kind: 'claimed'; msg: EventId; device: DeviceId }
  | { kind: 'claim_expired'; msg: EventId }
  | { kind: 'taken_back'; msg: EventId }
  | { kind: 'done'; msg: EventId }
  | { kind: 'draft_created'; draft: DraftId; conv: ConvId | null; target: DraftTarget; text: string; device: DeviceId }
  | { kind: 'draft_approved'; draft: DraftId; as: EventId }
  | { kind: 'draft_rejected'; draft: DraftId }
  | { kind: 'round_seat'; round: RoundId; conv: ConvId; device: DeviceId | null } // null: joined, waiting for an agent

export type InboxEvent = { seq: number; ts: number; body: InboxBody }

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const LIMITS = {
  members: 20,
  topic: 120,
  handle: 24,
  message: 32_000, // characters
  note: 256 * 1024, // bytes of UTF-8
  noteTitle: 200,
  goal: 2_000,
  brief: 8_000,
  recipients: 20,
  image: { perMessage: 4, bytes: 4 * 1024 * 1024, side: 16_384 },
  claimTimeoutMs: 10 * 60_000,
  retentionDaysDefault: 30,
  retentionDaysMax: 3650,
  budgetDefault: { messages: 20, chars: 20_000, minutes: 30 },
  budgetMax: { messages: 200, chars: 400_000, minutes: 24 * 60 },
} as const
