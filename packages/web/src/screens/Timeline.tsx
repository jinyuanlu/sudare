// The conversation log: paging, live tail, sending, and the rows themselves.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { newEventId, type AliasId, type ConvEvent, type ConvId, type ConvView, type EventId, type MemberView, type ReceiptState } from '@sudare/protocol'
import { api, type Outgoing } from '../api'
import type { Names } from '../data'
import { t } from '../i18n'
import { prepare } from '../images'
import { ErrorNote, Loading, useSite } from '../ui'
import { errText, finePointer, fmtTime } from '../util'

export type Pending = Outgoing & { failed: unknown } // failed === null: on its way

export const useTimeline = (id: ConvId, tick: number, at: number | null) => {
  const [events, setEvents] = useState<ConvEvent[]>([])
  const [more, setMore] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [pending, setPending] = useState<Pending[]>([])
  const all = useRef<ConvEvent[]>([])
  const alive = useRef(true)
  const tail = useRef({ busy: false, again: false })

  const merge = (add: ConvEvent[]) => {
    const bySeq = new Map(all.current.map((e) => [e.seq, e]))
    for (const e of add) bySeq.set(e.seq, e)
    all.current = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    if (alive.current) setEvents(all.current)
  }

  const earlier = async (limit: number): Promise<boolean> => {
    const first = all.current[0]
    const page = await api.events(id, first ? { before: first.seq, limit } : { limit })
    merge(page.events)
    if (alive.current) setMore(page.more)
    return page.more
  }

  useEffect(() => {
    alive.current = true
    void (async () => {
      try {
        let older = await earlier(50)
        // Opened at a specific message: page back until it is on screen.
        for (let i = 0; at !== null && older && (all.current[0]?.seq ?? 0) > at && i < 25; i++) older = await earlier(200)
        if (alive.current) setReady(true)
      } catch (e) {
        if (alive.current) setError(e)
      }
    })()
    return () => { alive.current = false }
  }, [id])

  const forward = async () => {
    if (tail.current.busy) {
      tail.current.again = true
      return
    }
    tail.current.busy = true
    try {
      do {
        tail.current.again = false
        for (let next = true; next && alive.current;) {
          const page = await api.events(id, { after: all.current.at(-1)?.seq ?? 0, limit: 200 })
          merge(page.events)
          next = page.more
        }
      } while (tail.current.again)
    } catch {
      // the next bump fetches again
    } finally {
      tail.current.busy = false
    }
  }
  useEffect(() => { if (ready && tick > 0) void forward() }, [tick, ready])

  const deliver = async (m: Outgoing) => {
    try {
      merge([(await api.send(id, m)).event])
      setPending((p) => p.filter((x) => x.id !== m.id))
    } catch (e) {
      setPending((p) => p.map((x) => (x.id === m.id ? { ...x, failed: e } : x)))
    }
  }
  const send = (text: string, to: AliasId[], cause: EventId | null, images: string[] = []) => {
    const m: Outgoing = { id: newEventId(), text, to, cause, ...(images.length > 0 ? { images } : {}) }
    setPending((p) => [...p, { ...m, failed: null }])
    void deliver(m)
  }
  /** Same id on purpose: the server deduplicates on it. */
  const retry = (m: Pending) => {
    setPending((p) => p.map((x) => (x.id === m.id ? { ...x, failed: null } : x)))
    void deliver({ id: m.id, text: m.text, to: m.to, cause: m.cause, ...(m.images ? { images: m.images } : {}) })
  }
  const discard = (m: Pending) => setPending((p) => p.filter((x) => x.id !== m.id))

  return { events, more, ready, error, pending, loadEarlier: () => earlier(100).catch(setError), send, retry, discard }
}

export type TimelineState = ReturnType<typeof useTimeline>

// -- rows ----------------------------------------------------------------------------

const systemText = (e: ConvEvent, name: Names): string | null => {
  const b = e.body
  switch (b.kind) {
    case 'conv_created': return t('sys.created', { who: name(b.by), topic: b.topic })
    case 'conv_renamed': return t('sys.renamed', { who: name(b.by), topic: b.topic })
    case 'retention_set': return t('sys.retention', { who: name(b.by), days: b.days })
    case 'member_joined': return t('sys.joined', { who: b.handle })
    case 'member_renamed': return t('sys.renamedMember', { was: b.was, who: b.handle })
    case 'member_left': return t('sys.left', { who: name(b.alias) })
    case 'conv_archived': return t('sys.archived', { who: name(b.by) })
    case 'round_opened': return t('sys.roundOpened', { who: name(b.by), goal: b.goal })
    case 'round_joined': return t('sys.roundJoined', { who: name(b.alias) })
    case 'round_seated': return t('sys.roundSeated', { who: name(b.alias) })
    case 'round_closed': return t(`sys.roundClosed.${b.reason}`)
    case 'note_revision': return t('sys.noteRevision', { who: name(b.author.alias), title: b.title, rev: b.rev })
    case 'note_endorsed': return t('sys.noteEndorsed', { who: name(b.by), rev: b.rev })
    case 'message':
    case 'receipt': return null
  }
}

type RowProps = { e: ConvEvent; me: AliasId; name: Names; quote: string | null; receipt: ReceiptState | null; focused: boolean; conv: ConvId; onReply: (() => void) | null; onAsk: (() => Promise<unknown>) | null }

const MessageRow = ({ e, me, name, quote, receipt, focused, conv, onReply, onAsk }: RowProps) => {
  const [asked, setAsked] = useState<'no' | 'yes' | 'failed'>('no')
  if (e.body.kind !== 'message') return null
  const ask = () => void onAsk?.().then(() => setAsked('yes'), () => setAsked('failed'))
  const { author, text, to, cause, images = [] } = e.body
  const via = author.kind === 'human' ? null : t(author.kind === 'delegate' ? 'msg.delegate' : 'msg.autonomous')
  return (
    <li class={`msg${author.alias === me ? ' mine' : ''}${focused ? ' focused' : ''}`} data-testid="msg" data-seq={e.seq}>
      <div class="msg-head">
        <strong>{name(author.alias)}</strong>
        {via ? <span class={`tag via-${author.kind}`}>{via}</span> : null}
        <time class="muted small" dateTime={new Date(e.ts).toISOString()}>{fmtTime(e.ts)}</time>
      </div>
      {cause ? <div class="quote small">↩ {quote ?? t('msg.reply')}</div> : null}
      {text ? <div class="msg-text">{text}</div> : null}
      {images.length > 0 ? (
        <div class="msg-images">
          {images.map((i) => (
            <a key={i.id} href={`/api/convs/${conv}/images/${i.id}`} target="_blank" rel="noopener">
              <img src={`/api/convs/${conv}/images/${i.id}`} width={i.w} height={i.h} loading="lazy" alt={t('msg.picture', { who: name(author.alias) })} data-testid="msg-image" />
            </a>
          ))}
        </div>
      ) : null}
      <div class="msg-foot muted small">
        {to.length > 0 ? <span>{t('msg.to', { who: to.map((a) => `@${name(a)}`).join(' ') })}</span> : null}
        {receipt ? <span class="receipt">{t(`receipt.${receipt}`)}</span> : null}
        {onReply ? <button type="button" class="link" onClick={onReply}>{t('msg.replyAction')}</button> : null}
        {onAsk && author.alias !== me ? (asked === 'yes' ? <span>{t('msg.asked')}</span> : <button type="button" class="link" data-testid="ask-agent" onClick={ask}>{t(asked === 'failed' ? 'msg.askFailed' : 'msg.askAction')}</button>) : null}
      </div>
    </li>
  )
}

const snippet = (text: string): string => (text.length > 80 ? `${text.slice(0, 80)}…` : text)

type TimelineProps = {
  view: ConvView; tl: TimelineState; name: Names; focus: number | null
  onReply: ((e: ConvEvent) => void) | null; onBottom: (atBottom: boolean) => void
}

export const Timeline = ({ view, tl, name, focus, onReply, onBottom }: TimelineProps) => {
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const heightBefore = useRef<number | null>(null)
  const focusedOnce = useRef(false)
  const byId = new Map(tl.events.map((e) => [e.id, e]))
  // Receipts exist only in two-person conversations: the latest one per message wins.
  const receipts = new Map<EventId, ReceiptState>()
  for (const e of tl.events) if (e.body.kind === 'receipt') receipts.set(e.body.of, e.body.state)

  useLayoutEffect(() => {
    const el = box.current
    if (!el || !tl.ready) return
    if (heightBefore.current !== null) {
      el.scrollTop += el.scrollHeight - heightBefore.current // keep the view still when older rows arrive
      heightBefore.current = null
    } else if (focus !== null && !focusedOnce.current) {
      focusedOnce.current = true
      const row = el.querySelector(`[data-seq="${focus}"]`)
      if (row) {
        row.scrollIntoView({ block: 'center' })
        stick.current = false
      } else el.scrollTop = el.scrollHeight
    } else if (stick.current) el.scrollTop = el.scrollHeight
    onBottom(stick.current)
  }, [tl.events, tl.pending.length, tl.ready])

  const onScroll = () => {
    const el = box.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    onBottom(stick.current)
  }
  const loadEarlier = () => {
    heightBefore.current = box.current?.scrollHeight ?? null
    void tl.loadEarlier()
  }

  return (
    <div class="timeline-box" ref={box} onScroll={onScroll}>
      {tl.error ? <ErrorNote error={tl.error} /> : null}
      {!tl.ready && !tl.error ? <Loading /> : null}
      {tl.ready && tl.more ? <button type="button" class="link center" onClick={loadEarlier}>{t('conv.earlier')}</button> : null}
      {tl.ready && !tl.more && view.from_seq > 1 ? <p class="sys">{t('conv.fromHere')}</p> : null}
      <ol class="timeline" role="log" aria-live="polite" aria-label={t('conv.timeline')}>
        {tl.events.map((e) => {
          if (e.body.kind === 'message') {
            const cause = e.body.cause ? byId.get(e.body.cause) : undefined
            const quote = cause?.body.kind === 'message' ? `${name(cause.body.author.alias)}: ${snippet(cause.body.text)}` : null
            return (
              <MessageRow
                key={e.id} e={e} me={view.me} name={name} quote={quote} receipt={e.body.kind === 'message' && e.body.author.alias === view.me ? (receipts.get(e.id) ?? null) : null /* what the other person did with MY message; my own state is not a receipt */}
                focused={e.seq === focus} conv={view.id} onReply={onReply ? () => onReply(e) : null}
                onAsk={onReply ? () => api.messageHandoff(view.id, e.id, 'readonly') : null}
              />
            )
          }
          const text = systemText(e, name)
          return text === null ? null : <li key={e.id} class="sys">{text} · <time dateTime={new Date(e.ts).toISOString()}>{fmtTime(e.ts)}</time></li>
        })}
        {tl.pending.map((m) => (
          <li key={m.id} class={`msg mine ${m.failed ? 'failed' : 'sending'}`} data-testid="msg-pending">
            <div class="msg-text">{m.text}{m.images?.length ? ` ${t('composer.withPictures', { n: m.images.length })}` : ''}</div>
            <div class="msg-foot small">
              {m.failed ? (
                <>
                  <span class="error" role="alert">{t('msg.failed', { why: errText(m.failed) })}</span>
                  <button type="button" class="link" onClick={() => tl.retry(m)}>{t('common.retry')}</button>
                  <button type="button" class="link" onClick={() => tl.discard(m)}>{t('common.discard')}</button>
                </>
              ) : <span class="muted" role="status">{t('msg.sending')}</span>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

// -- composer ------------------------------------------------------------------------

const BOUNDARY = String.raw`(?=$|[\s@#:,/\\.!?;)\]}，。！？；、）])`
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Members named with `@handle` in the text. Longest handles first, so `@ann.b` is not also `@ann`. */
export const mentioned = (text: string, members: MemberView[]): MemberView[] => {
  let rest = text
  const found: MemberView[] = []
  for (const m of [...members].sort((a, b) => b.handle.length - a.handle.length)) {
    const re = new RegExp(`@${escapeRe(m.handle)}${BOUNDARY}`, 'giu')
    if (!re.test(rest)) continue
    found.push(m)
    rest = rest.replace(re, (hit) => ' '.repeat(hit.length))
  }
  return found
}

type ComposerProps = {
  members: MemberView[] // who can be addressed: active, not me
  reply: string | null; onCancelReply: () => void
  conv: ConvId
  onSend: (text: string, to: AliasId[], images: string[]) => void
}

type Shot = { id: string; url: string }
const MAX_SHOTS = 4

export const Composer = ({ members, reply, onCancelReply, conv, onSend }: ComposerProps) => {
  const [text, setText] = useState('')
  const [shots, setShots] = useState<Shot[]>([])
  const [uploading, setUploading] = useState(0)
  const [problem, setProblem] = useState<string | null>(null)
  const canAttach = useSite()?.images !== false
  const picker = useRef<HTMLInputElement>(null)
  // A pasted or chosen picture is uploaded at once and waits here until the message is sent.
  const attach = (files: Blob[]) => {
    const room = MAX_SHOTS - shots.length - uploading
    if (files.length === 0 || !canAttach) return
    if (room <= 0) return setProblem(t('composer.tooMany', { n: MAX_SHOTS }))
    setProblem(null)
    for (const file of files.slice(0, room)) {
      setUploading((n) => n + 1)
      void prepare(file)
        .then(async (p) => ({ id: (await api.uploadImage(conv, p.data, p.thumb)).image.id, url: p.url }))
        .then((shot) => setShots((s) => [...s, shot]), (e) => setProblem(e instanceof Error && e.message === 'not_an_image' ? t('composer.notImage') : e instanceof Error && e.message === 'too_large' ? t('composer.tooLarge') : errText(e)))
        .finally(() => setUploading((n) => n - 1))
    }
  }
  const onPaste = (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()
    attach(files)
  }
  const [query, setQuery] = useState<string | null>(null)
  const [index, setIndex] = useState(0)
  const area = useRef<HTMLTextAreaElement>(null)
  const options = query === null ? [] : members.filter((m) => m.handle.toLowerCase().startsWith(query.toLowerCase())).slice(0, 6)
  const to = mentioned(text, members)

  const track = (el: HTMLTextAreaElement) => {
    setText(el.value)
    const m = /(?:^|\s)@([^\s@]*)$/.exec(el.value.slice(0, el.selectionStart))
    setQuery(m ? m[1]! : null)
    setIndex(0)
  }
  const pick = (m: MemberView) => {
    const el = area.current
    if (!el) return
    const head = el.value.slice(0, el.selectionStart).replace(/@[^\s@]*$/, `@${m.handle} `)
    el.value = head + el.value.slice(el.selectionStart)
    el.setSelectionRange(head.length, head.length)
    el.focus()
    setText(el.value)
    setQuery(null)
  }
  const submit = () => {
    const body = text.trim()
    if ((body === '' && shots.length === 0) || uploading > 0) return
    onSend(body, to.map((m) => m.alias), shots.map((s) => s.id))
    setShots([])
    setProblem(null)
    setText('')
    setQuery(null)
    area.current?.focus()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return // an IME is still deciding what Enter means
    if (options.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(options[index] ?? options[0]!)
      } else if (e.key === 'Escape') setQuery(null)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && finePointer()) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <form class="composer" onSubmit={(e) => { e.preventDefault(); submit() }}>
      {reply !== null ? (
        <div class="quote small">
          ↩ {reply} <button type="button" class="link" onClick={onCancelReply}>{t('common.cancel')}</button>
        </div>
      ) : null}
      {options.length > 0 ? (
        <ul class="suggest" role="listbox" aria-label={t('composer.suggest')}>
          {options.map((m, i) => (
            <li key={m.alias} role="option" aria-selected={i === index}>
              <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m)}>@{m.handle}</button>
            </li>
          ))}
        </ul>
      ) : null}
      {shots.length > 0 || uploading > 0 ? (
        <div class="shots">
          {shots.map((s) => (
            <span key={s.id} class="shot">
              <img src={s.url} alt={t('composer.attached')} />
              <button type="button" class="link" aria-label={t('composer.removePicture')} onClick={() => setShots((all) => all.filter((x) => x.id !== s.id))}>×</button>
            </span>
          ))}
          {uploading > 0 ? <span class="muted small" role="status">{t('composer.uploading')}</span> : null}
        </div>
      ) : null}
      {problem ? <p class="error small" role="alert">{problem}</p> : null}
      <div class="composer-row">
        {canAttach ? (
          <>
            <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden data-testid="pick-image"
              onChange={(e) => { attach([...(e.currentTarget.files ?? [])]); e.currentTarget.value = '' }} />
            <button type="button" class="attach" title={t('composer.attach')} aria-label={t('composer.attach')} onClick={() => picker.current?.click()}>＋</button>
          </>
        ) : null}
        <textarea
          ref={area} data-testid="composer" rows={Math.min(8, Math.max(1, text.split('\n').length))} value={text}
          aria-label={t('composer.label')} placeholder={t('composer.placeholder')}
          onInput={(e) => track(e.currentTarget)} onKeyDown={onKeyDown} onBlur={() => setQuery(null)} onPaste={onPaste}
        />
        <button type="submit" class="primary" data-testid="send" disabled={(text.trim() === '' && shots.length === 0) || uploading > 0}>{t('composer.send')}</button>
      </div>
      <div class="muted small" aria-live="polite">
        {to.length > 0 ? t('composer.to', { who: to.map((m) => `@${m.handle}`).join(' ') }) : t(canAttach ? 'composer.hintPictures' : 'composer.hint')}
      </div>
    </form>
  )
}
