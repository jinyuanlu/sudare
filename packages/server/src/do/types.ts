import type { AliasId, ConvEvent, ConvId, PrincipalId, RoundId } from '@sudare/protocol'

/** One conversation event as handed to a member's PrincipalDO. */
export type DeliveredEvent = {
  event: ConvEvent
  addressed: boolean // named in `to`, or a message in a two-person conversation
  mine: boolean // the event's author or subject is the receiving person
  sender: string | null // author handle, for messages and note revisions
}

/** A batch for one member, in seq order. Idempotent: the receiver keeps a high-water mark. */
export type Delivery = {
  principal: PrincipalId
  conv: ConvId
  topic: string
  alias: AliasId
  handle: string
  fromSeq: number
  members: number
  archived: boolean
  round: RoundId | null
  floor: number // messages at or below this seq were removed by retention
  events: DeliveredEvent[]
}

export const DIRECTORY = '#directory'
