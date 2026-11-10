import { useState } from 'preact/hooks'
import { LIMITS, isConvId, normalizeHandle, type ContactView, type ConvId } from '@sudare/protocol'
import { ApiFailure, api } from '../api'
import { useEventId } from '../data'
import { useAction, useLoad } from '../hooks'
import { t } from '../i18n'
import { navigate } from '../router'
import { refresh, useStore } from '../store'
import { ErrorNote, Field, Loading, Page } from '../ui'

const key = (c: ContactView): string => `${c.conv}/${c.alias}`

export const NewScreen = ({ parent: rawParent }: { parent: string | null }) => {
  const parent: ConvId | null = isConvId(rawParent) ? rawParent : null
  const me = useStore((s) => s.me)
  const parentTopic = useStore((s) => s.convs?.find((c) => c.id === parent)?.topic)
  const contacts = useLoad(api.contacts, [])
  const [topic, setTopic] = useState('')
  const [first, setFirst] = useState('')
  const [handle, setHandle] = useState('')
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const act = useAction()
  const idFor = useEventId()
  const needHandle = !parent && !me?.default_handle

  // People from the parent conversation first: they can join without an invitation.
  const all = [...(contacts.data ?? [])].sort((a, b) => Number(b.conv === parent) - Number(a.conv === parent))
  const shown = all.filter((c) => `${c.handle} ${c.topic}`.toLowerCase().includes(filter.trim().toLowerCase()))
  const toggle = (k: string, on: boolean) => setPicked((p) => (on ? [...p, k] : p.filter((x) => x !== k)))

  const create = (e: Event) => {
    e.preventDefault()
    void act.run(async () => {
      const h = needHandle ? normalizeHandle(handle) : null
      if (h && !h.ok) throw new ApiFailure('handle_invalid', 400)
      const members = all.filter((c) => picked.includes(key(c))).map((c) => ({ conv: c.conv, alias: c.alias }))
      const text = first.trim()
      const made = await api.createConv({
        topic: topic.trim(), members, parent, handle: h?.ok ? h.value : null,
        first: text === '' ? null : { id: idFor(text), text },
      })
      await refresh('convs')
      navigate(`/c/${made.conv}`)
    })
  }

  return (
    <Page title={parent ? t('new.fork') : t('new.title')} back={parent ? `/c/${parent}` : '/'} sub={parent ? parentTopic : undefined}>
      <form onSubmit={create}>
        <Field label={t('new.topic')}>
          <input value={topic} maxLength={LIMITS.topic} required onInput={(e) => setTopic(e.currentTarget.value)} />
        </Field>
        {needHandle ? (
          <Field label={t('join.handle')} hint={t('join.handleHint')}>
            <input data-testid="handle" value={handle} maxLength={LIMITS.handle} required onInput={(e) => setHandle(e.currentTarget.value)} />
          </Field>
        ) : null}
        <fieldset>
          <legend>{t('new.members', { n: picked.length, max: LIMITS.members - 1 })}</legend>
          <p class="muted small">{t('new.rule')}</p>
          {contacts.error ? <ErrorNote error={contacts.error} /> : !contacts.data ? <Loading /> : all.length === 0 ? <p class="muted small">{t('new.noContacts')}</p> : (
            <>
              {all.length > 8 ? <input type="search" value={filter} placeholder={t('new.filter')} aria-label={t('new.filter')} onInput={(e) => setFilter(e.currentTarget.value)} /> : null}
              <ul class="rows picker">
                {shown.map((c) => (
                  <li key={key(c)}>
                    <label class="inline">
                      <input
                        type="checkbox" checked={picked.includes(key(c))}
                        disabled={!picked.includes(key(c)) && picked.length >= LIMITS.members - 1}
                        onChange={(e) => toggle(key(c), e.currentTarget.checked)}
                      />
                      <span>{c.handle} <span class="muted small">· {c.topic}</span></span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </fieldset>
        <Field label={t('new.first')}>
          <textarea rows={3} value={first} onInput={(e) => setFirst(e.currentTarget.value)} />
        </Field>
        <ErrorNote error={act.error} />
        <button type="submit" class="primary" disabled={act.busy || topic.trim() === ''}>{t('new.create')}</button>
      </form>
    </Page>
  )
}
