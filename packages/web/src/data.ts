// Small read helpers shared by the conversation, notes and drafts screens.

import { useEffect, useRef } from 'preact/hooks'
import { newEventId, type AliasId, type ConvId, type ConvView, type EventId } from '@sudare/protocol'
import { api } from './api'
import { useLoad, type Loaded } from './hooks'
import { useStore } from './store'
import { t } from './i18n'

/** The conversation as the server sees it now; refetched whenever its log moves. */
export const useConv = (id: ConvId): Loaded<ConvView> => {
  const tick = useStore((s) => s.ticks[id] ?? 0)
  const conv = useLoad(() => api.conv(id), [id])
  useEffect(() => { if (tick > 0) conv.reload() }, [tick])
  return conv
}

export type Names = (alias: AliasId) => string
export const namesOf = (view: ConvView | undefined, extra?: Map<AliasId, string>): Names => {
  const map = new Map(view?.members.map((m) => [m.alias, m.handle]))
  return (alias) => map.get(alias) ?? extra?.get(alias) ?? t('common.someone')
}

/**
 * The event id is the idempotency key: the same content retried keeps its id,
 * changed content gets a new one.
 */
export const useEventId = (): ((content: string) => EventId) => {
  const last = useRef<{ content: string; id: EventId } | null>(null)
  return (content) => {
    if (last.current?.content !== content) last.current = { content, id: newEventId() }
    return last.current.id
  }
}
