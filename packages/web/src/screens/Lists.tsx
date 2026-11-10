// Inbox, drafts, invitations and search: the lists that live outside one conversation.

import { useState } from 'preact/hooks'
import type { AliasId, ConvId, DraftView, InboxItem, InviteView, SearchHit } from '@sudare/protocol'
import { api } from '../api'
import { namesOf } from '../data'
import { useAction, useLoad } from '../hooks'
import { t } from '../i18n'
import { Link, navigate } from '../router'
import { refresh, useStore } from '../store'
import { ErrorNote, Loading, Page } from '../ui'
import { fmtTime } from '../util'
import { InviteCard } from './Auth'

const InboxRow = ({ item }: { item: InboxItem }) => {
  const act = useAction()
  const run = (call: () => Promise<unknown>) => () => void act.run(async () => {
    await call()
    await refresh('inbox', 'convs')
  })
  const handoff = (
    <>
      <button type="button" disabled={act.busy} onClick={run(() => api.inboxHandoff(item.msg, 'readonly'))}>{t('inbox.handoffRead')}</button>
      <button type="button" disabled={act.busy} onClick={run(() => api.inboxHandoff(item.msg, 'full'))}>{t('inbox.handoffFull')}</button>
    </>
  )
  return (
    <li class={`card state-${item.state}`}>
      <div class="msg-head">
        <strong>{item.from}</strong>
        <Link href={`/c/${item.conv}?at=${item.seq}`}>{item.topic || t('join.untitled')}</Link>
        <time class="muted small" dateTime={new Date(item.ts).toISOString()}>{fmtTime(item.ts)}</time>
        <span class="tag">{t(`inbox.state.${item.state}`)}</span>
      </div>
      <p class="msg-text">{item.text}</p>
      {item.state === 'handed_off' ? <p class="muted small" role="status">{t('inbox.waiting', { mode: t(`inbox.mode.${item.mode ?? 'readonly'}`) })}</p> : null}
      {item.state === 'claimed' ? <p class="muted small" role="status">{t('inbox.working')}</p> : null}
      <ErrorNote error={act.error} />
      <div class="row wrap">
        {item.state === 'unread' ? <button type="button" class="primary" disabled={act.busy} onClick={run(() => api.inboxRead(item.msg))}>{t('inbox.markRead')}</button> : null}
        {item.state === 'unread' || item.state === 'read' ? handoff : null}
        {item.state === 'claimed' ? <button type="button" disabled={act.busy} onClick={run(() => api.inboxDone(item.msg))}>{t('inbox.markDone')}</button> : null}
        <Link class="button" href={`/c/${item.conv}?at=${item.seq}`}>{t('inbox.open')}</Link>
      </div>
    </li>
  )
}

export const InboxScreen = () => {
  const items = useStore((s) => s.inbox)
  return (
    <Page title={t('inbox.title')}>
      <p class="muted small">{t('inbox.lead')}</p>
      {items === null ? <Loading /> : items.length === 0 ? <p class="muted pad">{t('inbox.empty')}</p> : (
        <ul class="cards">{items.map((i) => <InboxRow key={i.msg} item={i} />)}</ul>
      )}
    </Page>
  )
}

/** Recipient handles need the conversation's member list; fetched only for drafts that address someone. */
const Recipients = ({ conv, to }: { conv: ConvId; to: AliasId[] }) => {
  const view = useLoad(() => api.conv(conv), [conv])
  const name = namesOf(view.data)
  return <>{view.data ? to.map((a) => `@${name(a)}`).join(' ') : '…'}</>
}

const targetText = (d: DraftView) => {
  const target = d.target
  const topic = d.topic ?? t('join.untitled')
  switch (target.kind) {
    case 'message':
      return <>{t('drafts.message', { topic })}{d.conv && target.to.length > 0 ? <> → <Recipients conv={d.conv} to={target.to} /></> : null}</>
    case 'note':
      return <>{t(target.note ? 'drafts.noteRevision' : 'drafts.noteNew', { title: target.title, topic })}</>
    case 'conv':
      return <>{t('drafts.conv', { topic: target.topic, n: target.members.length })}</>
  }
}

const DraftRow = ({ d, onApproved }: { d: DraftView; onApproved: (r: NonNullable<DraftView['result']>) => void }) => {
  const [text, setText] = useState(d.text)
  const act = useAction()
  const approving = d.status === 'approving'
  const approve = () => void act.run(async () => {
    const result = await api.approveDraft(d.id, !approving && text !== d.text ? text : null)
    await refresh('drafts', 'convs')
    onApproved(result)
  })
  const reject = () => void act.run(async () => {
    await api.rejectDraft(d.id)
    await refresh('drafts')
  })
  return (
    <li class="card">
      <div class="msg-head">
        <strong>{targetText(d)}</strong>
        <time class="muted small" dateTime={new Date(d.created).toISOString()}>{fmtTime(d.created)}</time>
      </div>
      <p class="muted small">{t('drafts.by', { device: d.device_name })}</p>
      <textarea
        class={d.target.kind === 'note' ? 'mono' : ''} rows={Math.min(14, Math.max(3, text.split('\n').length + 1))} value={text} readOnly={approving}
        aria-label={t('drafts.text')} onInput={(e) => setText(e.currentTarget.value)}
      />
      {approving ? <p class="warn small">{t('drafts.approving')}</p> : text !== d.text ? <p class="muted small">{t('drafts.edited')}</p> : null}
      <ErrorNote error={act.error} />
      <div class="row">
        <button type="button" class="primary" disabled={act.busy || (text.trim() === '' && text !== d.text)} onClick={approve}>
          {approving ? t('common.retry') : t('drafts.approve')}
        </button>
        {approving ? null : <button type="button" disabled={act.busy} onClick={reject}>{t('drafts.reject')}</button>}
      </div>
    </li>
  )
}

export const DraftsScreen = () => {
  const drafts = useStore((s) => s.drafts)
  const [last, setLast] = useState<NonNullable<DraftView['result']> | null>(null)
  return (
    <Page title={t('drafts.title')}>
      <p class="muted small">{t('drafts.lead')}</p>
      {last?.conv ? (
        <p class="ok" role="status">
          {t('drafts.approved')}{' '}
          <Link href={last.note ? `/c/${last.conv}/notes/${last.note}` : `/c/${last.conv}`}>{t('inbox.open')}</Link>
        </p>
      ) : null}
      {drafts === null ? <Loading /> : drafts.length === 0 ? <p class="muted pad">{t('drafts.empty')}</p> : (
        <ul class="cards">{drafts.map((d) => <DraftRow key={d.id} d={d} onApproved={setLast} />)}</ul>
      )}
    </Page>
  )
}

const InviteRow = ({ invite }: { invite: InviteView }) => {
  const join = async (handle: string) => {
    const r = await api.acceptInvite(invite.id, handle)
    await refresh('invites', 'convs')
    navigate(`/c/${r.conv}`)
  }
  const decline = async () => {
    await api.declineInvite(invite.id)
    await refresh('invites')
  }
  return (
    <li>
      <InviteCard topic={invite.topic} by={invite.by} members={invite.members} expires={invite.expires} suggested={invite.suggested_handle} onJoin={join} onDecline={decline} />
    </li>
  )
}

export const InvitesScreen = () => {
  const invites = useStore((s) => s.invites)
  return (
    <Page title={t('invites.title')}>
      {invites === null ? <Loading /> : invites.length === 0 ? <p class="muted pad">{t('invites.empty')}</p> : (
        <ul class="cards">{invites.map((i) => <InviteRow key={i.id} invite={i} />)}</ul>
      )}
    </Page>
  )
}

const hitHref = (h: SearchHit): string => {
  if (h.kind === 'message') return `/c/${h.conv}?at=${h.seq}`
  const [note, rev] = h.ref.split('#')
  return `/c/${h.conv}/notes/${note}${rev ? `?rev=${rev}` : ''}`
}

export const SearchScreen = ({ query }: { query: string }) => {
  const [text, setText] = useState(query)
  const hits = useLoad(async () => (query.trim() === '' ? null : api.search(query)), [query])
  const submit = (e: Event) => {
    e.preventDefault()
    navigate(`/search?q=${encodeURIComponent(text.trim())}`, true)
  }
  return (
    <Page title={t('search.title')}>
      <form class="row" role="search" onSubmit={submit}>
        <input type="search" value={text} maxLength={200} aria-label={t('search.label')} placeholder={t('search.label')} onInput={(e) => setText(e.currentTarget.value)} />
        <button type="submit" class="primary">{t('search.go')}</button>
      </form>
      <ErrorNote error={hits.error} />
      {hits.loading && query ? <Loading /> : null}
      {hits.data?.length === 0 ? <p class="muted pad">{t('search.empty')}</p> : null}
      <ul class="cards">
        {hits.data?.map((h) => (
          <li key={`${h.kind}/${h.ref}`}>
            <Link class="card link-card" href={hitHref(h)}>
              <span class="msg-head">
                <strong>{h.topic || t('join.untitled')}</strong>
                <span class="tag">{t(h.kind === 'note' ? 'search.note' : 'search.message')}</span>
                <time class="muted small" dateTime={new Date(h.ts).toISOString()}>{fmtTime(h.ts)}</time>
              </span>
              <span class="msg-text">{h.snippet}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  )
}
