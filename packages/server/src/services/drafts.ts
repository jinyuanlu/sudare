// Approving an agent draft. Reached only from routes that require a `human`
// session: this is the one place a delegate write enters a conversation (I1).

import {
  newNoteId, err, ok,
  type ConvId, type DraftId, type DraftView, type EventId, type PrincipalId, type Result, type WritePath,
} from '@sudare/protocol'
import type { Env } from '../env'
import { createConv } from './convs'
import { convStub, principalStub } from './stubs'

type Outcome = Result<NonNullable<DraftView['result']>>

const perform = async (env: Env, me: PrincipalId, d: DraftView & { event_id: EventId }): Promise<Outcome> => {
  const path: WritePath = { kind: 'delegate', draft: d.id }
  const t = d.target
  switch (t.kind) {
    case 'message': {
      const conv = d.conv as ConvId
      const r = await convStub(env, conv).exec(conv, { t: 'post', id: d.event_id, principal: me, path, text: d.text, to: t.to, cause: t.cause })
      return r.ok ? ok({ conv, event: d.event_id }) : err(r.error, r.detail)
    }
    case 'note': {
      const conv = d.conv as ConvId
      const note = t.note ?? newNoteId(conv)
      const r = await convStub(env, conv).exec(conv, { t: 'note_revise', id: d.event_id, principal: me, path, note, base: t.base, title: t.title, text: d.text })
      const rev = r.events.map((e) => e.body).find((b) => b.kind === 'note_revision')
      return r.ok && rev?.kind === 'note_revision' ? ok({ conv, note: rev.note, rev: rev.rev }) : err(r.ok ? 'unavailable' : r.error, r.ok ? undefined : r.detail)
    }
    case 'conv': {
      const r = await createConv(env, me, {
        topic: t.topic, members: t.members, parent: t.parent, invite: 'any_member', handle: null, dm: false, path,
        first: d.text.trim() === '' ? null : { id: d.event_id, text: d.text },
      })
      return r.ok ? ok({ conv: r.value.conv }) : r
    }
  }
}

export const approveDraft = async (env: Env, me: PrincipalId, id: DraftId, text: string | null): Promise<Outcome> => {
  const inbox = principalStub(env, me)
  const begun = await inbox.draftBegin(id, text)
  if (!begun.ok) return begun
  const outcome = await perform(env, me, begun.value)
  await inbox.draftFinish(id, outcome.ok ? { ok: true, result: outcome.value } : { ok: false })
  return outcome
}
