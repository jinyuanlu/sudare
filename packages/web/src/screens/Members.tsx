import { useState } from 'preact/hooks'
import type { ContactView, ConvView, MemberView } from '@sudare/protocol'
import { api, type InviteLink } from '../api'
import { useAction, useLoad } from '../hooks'
import { t } from '../i18n'
import { navigate } from '../router'
import { refresh } from '../store'
import { CopyButton, ErrorNote, Loading, Modal } from '../ui'
import { fmtDate } from '../util'

const InviteSection = ({ view }: { view: ConvView }) => {
  const contacts = useLoad(api.contacts, [])
  const act = useAction()
  const [sent, setSent] = useState<string[]>([])
  const [link, setLink] = useState<InviteLink | null>(null)
  const [once, setOnce] = useState(false)
  const pending = useLoad(() => api.pendingInvites(view.id), [view.id])
  const key = (c: ContactView) => c.person
  // One row per person, and nobody who is already in this room.
  const here = new Set((contacts.data ?? []).filter((c) => c.conv === view.id).map((c) => c.person))
  const others = [...new Map((contacts.data ?? []).filter((c) => !here.has(c.person)).map((c) => [c.person, c])).values()]
  const waiting = new Set((pending.data ?? []).map((p) => p.name).filter((n): n is string => n !== null))
  const invite = (c: ContactView) => void act.run(async () => {
    await api.invite(view.id, { conv: c.conv, alias: c.alias })
    setSent((s) => [...s, key(c)])
    pending.reload()
  })
  const withdraw = (id: string) => void act.run(async () => {
    await api.withdrawInvite(view.id, id)
    pending.reload()
  })
  return (
    <section>
      <h3>{t('members.invite')}</h3>
      <div class="row wrap">
        <button type="button" class="primary" disabled={act.busy} onClick={() => void act.run(async () => {
          const made = await api.roomLink(view.id)
          setLink(made); setOnce(false)
          await navigator.clipboard?.writeText(made.url).catch(() => undefined)
          pending.reload()
        })}>{t('members.roomLink')}</button>
        <button type="button" disabled={act.busy} onClick={() => void act.run(async () => { setLink(await api.inviteLink(view.id)); setOnce(true); pending.reload() })}>{t('members.link')}</button>
      </div>
      {link ? (
        <div class="once">
          <p class="small">{t(once ? 'members.linkOnce' : 'members.roomLinkNote', { when: fmtDate(link.expires) })}</p>
          <input readOnly value={link.url} aria-label={t('members.linkLabel')} onFocus={(e) => e.currentTarget.select()} />
          <CopyButton text={link.url} />
        </div>
      ) : null}
      <ErrorNote error={act.error} />
      {(pending.data ?? []).length > 0 ? (
        <ul class="rows" aria-label={t('members.pending')}>
          {(pending.data ?? []).map((p) => (
            <li key={p.id}>
              <span>{p.kind === 'room' ? t('members.pendingRoom') : p.kind === 'link' ? t('members.pendingLink') : (p.name ?? t('members.pendingSomeone'))} <span class="muted small">· {t(p.kind === 'room' ? 'members.roomOn' : 'members.pending')}</span></span>
              {p.mine ? <button type="button" class="link" disabled={act.busy} onClick={() => withdraw(p.id)}>{t(p.kind === 'room' ? 'members.turnOff' : 'members.withdraw')}</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {contacts.loading && !contacts.data ? <Loading /> : null}
      <ErrorNote error={contacts.error} />
      {contacts.data && others.length === 0 ? <p class="muted small">{t('members.noContacts')}</p> : null}
      <ul class="rows">
        {others.map((c) => (
          <li key={key(c)}>
            <span>{c.handle} <span class="muted small">· {c.topic}</span></span>
            {sent.includes(key(c)) || waiting.has(c.handle)
              ? <span class="muted small">{t('members.invited')}</span>
              : <button type="button" disabled={act.busy} onClick={() => invite(c)}>{t('members.inviteOne')}</button>}
          </li>
        ))}
      </ul>
    </section>
  )
}

export const MembersDialog = ({ view, onClose }: { view: ConvView; onClose: () => void }) => {
  const act = useAction()
  const me = view.members.find((m) => m.me)
  const chat = (m: MemberView) => void act.run(async () => {
    const r = await api.createConv({
      topic: `${me?.handle ?? ''} · ${m.handle}`, members: [{ conv: view.id, alias: m.alias }], parent: null, handle: null, first: null, dm: true,
    })
    await refresh('convs')
    navigate(`/c/${r.conv}`)
  })
  return (
    <Modal title={t('conv.members')} onClose={onClose}>
      <ErrorNote error={act.error} />
      <ul class="rows" aria-label={t('conv.members')}>
        {view.members.map((m) => (
          <li key={m.alias} class={m.left ? 'dim' : ''}>
            <span>
              {m.active && !m.left ? <span class="here" title={t('members.here')} aria-label={t('members.here')}>● </span> : null}
              {m.handle}
              {m.me ? <span class="tag">{t('members.you')}</span> : null}
              {m.creator ? <span class="tag">{t('members.creator')}</span> : null}
              {m.left ? <span class="tag">{t('members.left')}</span> : null}
            </span>
            {!m.me && !m.left && !me?.left ? <button type="button" disabled={act.busy} onClick={() => chat(m)}>{t('members.chat')}</button> : null}
          </li>
        ))}
      </ul>
      {view.can_invite && !me?.left ? <InviteSection view={view} /> : <p class="muted small">{t('members.cannotInvite')}</p>}
    </Modal>
  )
}
