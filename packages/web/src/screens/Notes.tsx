import { useState } from 'preact/hooks'
import { LIMITS, type ConvId, type ConvView, type NoteId, type NoteRevView, type NoteView } from '@sudare/protocol'
import { api, type Revision } from '../api'
import { namesOf, useConv, useEventId } from '../data'
import { useAction, useLoad } from '../hooks'
import { t } from '../i18n'
import { Link, navigate } from '../router'
import { useStore } from '../store'
import { ErrorNote, Field, Loading, Page } from '../ui'
import { fmtDate, isCode, lineDiff } from '../util'

/** How many active members have not endorsed this revision yet. */
const awaiting = (view: ConvView | undefined, rev: NoteRevView | undefined): number =>
  view && rev ? view.members.filter((m) => !m.left && !rev.endorsed.includes(m.alias)).length : 0

const statusText = (note: NoteView, view: ConvView | undefined): string => {
  const head = note.revs.find((r) => r.rev === note.head)
  if (note.adopted === note.head) return t('notes.adopted', { rev: note.head })
  const waiting = t('notes.awaiting', { rev: note.head, n: awaiting(view, head) })
  return note.adopted === null ? waiting : `${t('notes.adopted', { rev: note.adopted })} · ${waiting}`
}

type EditorProps = { title: string; text: string; submit: string; onSubmit: (r: Omit<Revision, 'base'>) => Promise<void>; onCancel: () => void }

const NoteEditor = ({ title: title0, text: text0, submit, onSubmit, onCancel }: EditorProps) => {
  const [title, setTitle] = useState(title0)
  const [text, setText] = useState(text0)
  const act = useAction()
  const idFor = useEventId()
  const save = (e: Event) => {
    e.preventDefault()
    void act.run(() => onSubmit({ id: idFor(`${title}\n${text}`), title: title.trim(), text }))
  }
  return (
    <form class="card" onSubmit={save}>
      <Field label={t('notes.noteTitle')}>
        <input value={title} maxLength={LIMITS.noteTitle} required onInput={(e) => setTitle(e.currentTarget.value)} />
      </Field>
      <Field label={t('notes.text')} hint={t('notes.markdownHint')}>
        <textarea class="mono" rows={14} required value={text} onInput={(e) => setText(e.currentTarget.value)} />
      </Field>
      {isCode(act.error, 'note_base_stale') ? <p class="error" role="alert">{t('err.note_base_stale')}</p> : <ErrorNote error={act.error} />}
      <div class="row">
        <button type="submit" class="primary" disabled={act.busy || title.trim() === '' || text === ''}>{submit}</button>
        <button type="button" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </form>
  )
}

export const NotesScreen = ({ id }: { id: ConvId }) => {
  const tick = useStore((s) => s.ticks[id] ?? 0)
  const conv = useConv(id)
  const notes = useLoad(() => api.notes(id), [id, tick])
  const [creating, setCreating] = useState(false)
  const create = async (r: Omit<Revision, 'base'>) => {
    const made = await api.newNote(id, { ...r, base: null })
    navigate(`/c/${id}/notes/${made.note}`)
  }
  return (
    <Page
      title={t('notes.title')} back={`/c/${id}`} sub={conv.data?.topic}
      actions={creating || conv.data?.archived ? null : <button type="button" class="primary" onClick={() => setCreating(true)}>{t('notes.new')}</button>}
    >
      {creating ? <NoteEditor title="" text="" submit={t('notes.create')} onSubmit={create} onCancel={() => setCreating(false)} /> : null}
      <ErrorNote error={notes.error} />
      {!notes.data && !notes.error ? <Loading /> : null}
      {notes.data?.length === 0 && !creating ? <p class="muted pad">{t('notes.empty')}</p> : null}
      <ul class="cards">
        {notes.data?.map((n) => (
          <li key={n.id}>
            <Link class="card link-card" href={`/c/${id}/notes/${n.id}`}>
              <strong>{n.title}</strong>
              <span class="muted small">{statusText(n, conv.data)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  )
}

const Diff = ({ before, after }: { before: string; after: string }) => {
  const lines = lineDiff(before, after)
  if (lines === null) return <p class="muted small">{t('notes.diffTooLarge')}</p>
  if (lines.every((l) => l.op === ' ')) return <p class="muted small">{t('notes.diffSame')}</p>
  return (
    <pre class="diff" aria-label={t('notes.diff')}>
      {lines.map((l, i) => <span key={i} class={l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}>{`${l.op} ${l.text}\n`}</span>)}
    </pre>
  )
}

export const NoteScreen = ({ id, note, rev }: { id: ConvId; note: NoteId; rev: number | null }) => {
  const tick = useStore((s) => s.ticks[id] ?? 0)
  const conv = useConv(id)
  // Without an explicit revision, show the head: that is the one waiting for endorsements.
  const read = useLoad(async () => {
    const first = await api.note(note, rev ?? undefined)
    return rev === null && first.rev !== first.note.head ? api.note(note, first.note.head) : first
  }, [note, rev, tick])
  const current = read.data?.note.revs.find((r) => r.rev === read.data?.rev)
  const baseRev = current?.base ?? null
  const base = useLoad(async () => (baseRev === null ? null : api.note(note, baseRev)), [note, baseRev])
  const [mono, setMono] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [editing, setEditing] = useState(false)
  const act = useAction()

  const back = `/c/${id}/notes`
  if (!read.data || !current) return <Page title={t('notes.title')} back={back}>{read.error ? <ErrorNote error={read.error} /> : <Loading />}</Page>
  const { note: view, text, title } = read.data
  const name = namesOf(conv.data)
  const isHead = current.rev === view.head
  const mine = conv.data ? current.endorsed.includes(conv.data.me) : true
  const waiting = awaiting(conv.data, current)
  const writable = conv.data !== undefined && !conv.data.archived && !conv.data.members.find((m) => m.me)?.left
  const revise = async (r: Omit<Revision, 'base'>) => {
    try {
      await api.reviseNote(note, { ...r, base: view.head })
      setEditing(false)
      navigate(`/c/${id}/notes/${note}`, true)
      read.reload()
    } catch (e) {
      if (isCode(e, 'note_base_stale')) read.reload() // show the newer head; the editor keeps the person's text
      throw e
    }
  }

  return (
    <Page title={title} back={back} sub={statusText(view, conv.data)}>
      <div class="row wrap">
        <label class="inline">
          {t('notes.revision')}{' '}
          <select value={String(current.rev)} onChange={(e) => navigate(`/c/${id}/notes/${note}?rev=${e.currentTarget.value}`, true)}>
            {view.revs.map((r) => (
              <option key={r.rev} value={String(r.rev)}>
                {t('notes.revOption', { rev: r.rev, when: fmtDate(r.ts) })}{r.rev === view.adopted ? ` · ${t('notes.adoptedShort')}` : ''}{r.rev === view.head ? ` · ${t('notes.latest')}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label class="inline"><input type="checkbox" checked={mono} onChange={(e) => setMono(e.currentTarget.checked)} /> {t('notes.mono')}</label>
        {baseRev !== null ? <label class="inline"><input type="checkbox" checked={showDiff} onChange={(e) => setShowDiff(e.currentTarget.checked)} /> {t('notes.showDiff', { rev: baseRev })}</label> : null}
        <a class="button" href={api.exportUrl(note, current.rev)} download>{t('notes.export')}</a>
      </div>
      <p class="muted small">
        {t('notes.by', { who: name(current.author.alias) })}
        {current.author.kind === 'human' ? '' : ` (${t(current.author.kind === 'delegate' ? 'msg.delegate' : 'msg.autonomous')})`} ·{' '}
        {current.endorsed.length > 0 ? t('notes.endorsedBy', { who: current.endorsed.map(name).join(', ') }) : t('notes.noEndorsements')}
        {current.adopted ? '' : ` · ${t('notes.waitingFor', { n: waiting })}`}
      </p>
      {!isHead ? <p class="warn">{t('notes.notHead')} <Link href={`/c/${id}/notes/${note}?rev=${view.head}`}>{t('notes.goHead')}</Link></p> : null}
      {showDiff && baseRev !== null
        ? (base.data ? <Diff before={base.data.text} after={text} /> : base.error ? <p class="muted small">{t('notes.diffUnavailable')}</p> : <Loading />)
        : <pre class={mono ? 'note mono' : 'note'}>{text}</pre>}
      <ErrorNote error={act.error} />
      {writable && !editing ? (
        <div class="row">
          {isHead && !mine ? (
            <button type="button" class="primary" disabled={act.busy} onClick={() => void act.run(async () => { await api.endorse(note, current.rev); read.reload() })}>
              {t('notes.endorse')}
            </button>
          ) : null}
          {isHead && mine ? <span class="ok small">{t('notes.youEndorsed')}</span> : null}
          <button type="button" onClick={() => setEditing(true)}>{t('notes.propose')}</button>
        </div>
      ) : null}
      {editing ? <NoteEditor title={title} text={text} submit={t('notes.propose')} onSubmit={revise} onCancel={() => setEditing(false)} /> : null}
    </Page>
  )
}
