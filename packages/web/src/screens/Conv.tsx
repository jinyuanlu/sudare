import { useEffect, useRef, useState } from 'preact/hooks'
import { LIMITS, type AliasId, type ConvEvent, type ConvId, type ConvView } from '@sudare/protocol'
import { ApiFailure, api } from '../api'
import { namesOf, useConv } from '../data'
import { useAction, useVisible } from '../hooks'
import { t } from '../i18n'
import { membersText } from '../util'
import { Link, navigate } from '../router'
import { refresh, useStore } from '../store'
import { ErrorNote, Field, Loading, Modal, Page, QuickStart } from '../ui'
import { MembersDialog } from './Members'
import { OpenRoundDialog, RoundBanner } from './Round'
import { Composer, Timeline, useTimeline } from './Timeline'

type Panel = null | 'members' | 'round' | 'rename' | 'retention'

const RenameDialog = ({ view, onClose, onSaved }: { view: ConvView; onClose: () => void; onSaved: (v: ConvView) => void }) => {
  const [topic, setTopic] = useState(view.topic)
  const act = useAction()
  const save = (e: Event) => {
    e.preventDefault()
    void act.run(async () => onSaved(await api.patchConv(view.id, { topic: topic.trim() })))
  }
  return (
    <Modal title={t('conv.rename')} onClose={onClose}>
      <form onSubmit={save}>
        <Field label={t('new.topic')}>
          <input value={topic} maxLength={LIMITS.topic} required onInput={(e) => setTopic(e.currentTarget.value)} />
        </Field>
        <ErrorNote error={act.error} />
        <button type="submit" class="primary" disabled={act.busy || topic.trim() === ''}>{t('common.save')}</button>
      </form>
    </Modal>
  )
}

const RetentionDialog = ({ view, onClose, onSaved }: { view: ConvView; onClose: () => void; onSaved: (v: ConvView) => void }) => {
  const [days, setDays] = useState(String(view.retention_days))
  const act = useAction()
  const save = (e: Event) => {
    e.preventDefault()
    void act.run(async () => onSaved(await api.patchConv(view.id, { retention_days: Number(days) })))
  }
  return (
    <Modal title={t('conv.retention')} onClose={onClose}>
      <form onSubmit={save}>
        <Field label={t('conv.retentionDays')} hint={t('conv.retentionHint')}>
          <input type="number" inputMode="numeric" min={1} max={LIMITS.retentionDaysMax} step={1} required value={days} onInput={(e) => setDays(e.currentTarget.value)} />
        </Field>
        <ErrorNote error={act.error} />
        <button type="submit" class="primary" disabled={act.busy}>{t('common.save')}</button>
      </form>
    </Modal>
  )
}

type MenuProps = { view: ConvView; openRound: boolean; onPanel: (p: Panel) => void; onError: (e: unknown) => void }

const Menu = ({ view, openRound, onPanel, onError }: MenuProps) => {
  const box = useRef<HTMLDetailsElement>(null)
  const me = view.members.find((m) => m.me)
  const creatorGone = !view.members.some((m) => m.creator && !m.left)
  const active = !view.archived && !me?.left
  const close = () => box.current?.removeAttribute('open')
  const item = (label: string, action: () => void) => (
    <button type="button" role="menuitem" onClick={() => { close(); action() }}>{label}</button>
  )
  const confirmed = (question: string, call: () => Promise<unknown>, after: () => void) => () => {
    if (!confirm(question)) return
    call().then(() => refresh('convs')).then(after, onError)
  }
  return (
    <details class="menu" ref={box}>
      <summary aria-label={t('conv.menu')}>⋯</summary>
      <div class="menu-items" role="menu">
        {item(t('conv.members'), () => onPanel('members'))}
        {view.can_invite ? item(t('conv.invite'), () => onPanel('members')) : null}
        {item(t('conv.newTopic'), () => navigate(`/new?parent=${view.id}`))}
        {item(t('notes.title'), () => navigate(`/c/${view.id}/notes`))}
        {active && !openRound ? item(t('round.openAction'), () => onPanel('round')) : null}
        {active ? item(t('conv.rename'), () => onPanel('rename')) : null}
        {active && me?.creator ? item(t('conv.retention'), () => onPanel('retention')) : null}
        {!me?.left ? item(t('conv.leave'), confirmed(t('conv.leaveConfirm'), () => api.leave(view.id), () => navigate('/'))) : null}
        {active && (me?.creator || creatorGone) ? item(t('conv.archive'), confirmed(t('conv.archiveConfirm'), () => api.archive(view.id), () => undefined)) : null}
      </div>
    </details>
  )
}

export const ConvScreen = ({ id, at }: { id: ConvId; at: number | null }) => {
  const tick = useStore((s) => s.ticks[id] ?? 0)
  const conv = useConv(id)
  const tl = useTimeline(id, tick, at)
  const visible = useVisible()
  const [panel, setPanel] = useState<Panel>(null)
  const [reply, setReply] = useState<ConvEvent | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [failure, setFailure] = useState<unknown>(null)
  const marked = useRef(0)
  const view = conv.data
  const lastSeq = tl.events.at(-1)?.seq ?? 0

  // Read means: the end of the timeline was actually on screen.
  useEffect(() => {
    if (!tl.ready || !visible || !atBottom || lastSeq <= marked.current) return
    marked.current = lastSeq
    void api.read(id, lastSeq).then(() => refresh('convs', 'inbox'), () => { marked.current = 0 })
  }, [tl.ready, visible, atBottom, lastSeq])

  const [showQuick, setShowQuick] = useState(() => localStorage.getItem('sudare.quick') !== 'hidden')
  if (!view) {
    const isGone = conv.error instanceof ApiFailure && (conv.error.code === 'not_member' || conv.error.code === 'conv_missing')
    return (
      <Page title={t('conv.title')}>
        {isGone ? <div class="alone"><p>{t('conv.gone')}</p><Link class="button" href="/">{t('notfound.home')}</Link></div> : conv.error ? <ErrorNote error={conv.error} /> : <Loading />}
      </Page>
    )
  }

  const joinedLater = new Map<AliasId, string>()
  for (const e of tl.events) if (e.body.kind === 'member_joined' || e.body.kind === 'member_renamed') joinedLater.set(e.body.alias, e.body.handle)
  const name = namesOf(view, joinedLater)
  const me = view.members.find((m) => m.me)
  const active = view.members.filter((m) => !m.left)
  const round = view.rounds.find((r) => r.closed === null) ?? null
  const writable = !view.archived && !me?.left
  const saved = (v: ConvView) => {
    conv.set(v)
    setPanel(null)
    void refresh('convs')
  }
  const replyText = reply?.body.kind === 'message' ? `${name(reply.body.author.alias)}: ${reply.body.text.slice(0, 80)}` : null

  return (
    <Page
      wide title={view.dm_with ?? view.topic}
      sub={<button type="button" class="link" onClick={() => setPanel('members')}>{membersText(active.length)} · {t('conv.hereNow', { n: active.filter((m) => m.active).length })}{view.archived ? ` · ${t('home.archived')}` : ''}</button>}
      actions={<>{view.can_invite && !view.archived ? <button type="button" onClick={() => setPanel('members')}>{t('conv.invite')}</button> : null}<Link class="button" href={`/c/${id}/notes`}>{t('notes.title')}</Link><Menu view={view} openRound={round !== null} onPanel={setPanel} onError={setFailure} /></>}
    >
      <div class="conv">
        {showQuick ? <QuickStart onDismiss={() => { localStorage.setItem('sudare.quick', 'hidden'); setShowQuick(false) }} /> : null}
        <ErrorNote error={failure} />
        {active.length === 1 && view.can_invite && !view.archived ? (
          <div class="alone">
            <p>{t('conv.alone')}</p>
            <button type="button" class="primary" onClick={() => setPanel('members')}>{t('conv.inviteSomeone')}</button>
          </div>
        ) : null}
        {round ? <RoundBanner view={view} round={round} name={name} onChanged={conv.reload} /> : null}
        <Timeline view={view} tl={tl} name={name} focus={at} onReply={writable ? setReply : null} onBottom={setAtBottom} />
        {writable ? (
          <Composer
            members={active.filter((m) => !m.me)} reply={replyText} onCancelReply={() => setReply(null)} conv={view.id}
            onSend={(text, to, images) => { tl.send(text, to, reply?.id ?? null, images); setReply(null) }}
          />
        ) : <p class="muted pad center">{t(view.archived ? 'conv.archivedNote' : 'conv.leftNote')}</p>}
      </div>
      {panel === 'members' ? <MembersDialog view={view} onClose={() => setPanel(null)} onChanged={(v) => { conv.set(v); void refresh('convs') }} /> : null}
      {panel === 'round' ? <OpenRoundDialog conv={id} onClose={() => setPanel(null)} onOpened={() => { setPanel(null); conv.reload() }} /> : null}
      {panel === 'rename' ? <RenameDialog view={view} onClose={() => setPanel(null)} onSaved={saved} /> : null}
      {panel === 'retention' ? <RetentionDialog view={view} onClose={() => setPanel(null)} onSaved={saved} /> : null}
    </Page>
  )
}
