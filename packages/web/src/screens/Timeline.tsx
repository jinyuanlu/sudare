// The conversation log: paging, live tail, sending, and the rows themselves.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { newEventId, type AliasId, type ConvEvent, type ConvId, type ConvView, type EventId, type MemberView, type ReceiptState } from '@sudare/protocol'
import { api, type Outgoing } from '../api'
import type { Names } from '../data'
import { t } from '../i18n'
import { ErrorNote, Loading } from '../ui'
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
  const send = (text: string, to: AliasId[], cause: EventId | null) => {
    const m: Outgoing = { id: newEventId(), text, to, cause }
    setPending((p) => [...p, { ...m, failed: null }])
    void deliver(m)
  }
  /** Same id on purpose: the server deduplicates on it. */
  const retry = (m: Pending) => {
    setPending((p) => p.map((x) => (x.id === m.id ? { ...x, failed: null } : x)))
    void deliver({ id: m.id, text: m.text, to: m.to, cause: m.cause })
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

type RowProps = { e: ConvEvent; me: AliasId; name: Names; quote: string | null; receipt: ReceiptState | null; focused: boolean; onReply: (() => void) | null }

const MessageRow = ({ e, me, name, quote, receipt, focused, onReply }: RowProps) => {
  if (e.body.kind !== 'message') return null
  const { author, text, to, cause } = e.body
  const via = author.kind === 'human' ? null : t(author.kind === 'delegate' ? 'msg.delegate' : 'msg.autonomous')
  return (
    <li class={`msg${author.alias === me ? ' mine' : ''}${focused ? ' focused' : ''}`} data-testid="msg" data-seq={e.seq}>
      <div class="msg-head">
        <strong>{name(author.alias)}</strong>
        {via ? <span class={`tag via-${author.kind}`}>{via}</span> : null}
        <time class="muted small" dateTime={new Date(e.ts).toISOString()}>{fmtTime(e.ts)}</time>
      </div>
      {cause ? <div class="quote small">↩ {quote ?? t('msg.reply')}</div> : null}
      <div class="msg-text">{text}</div>
      <div class="msg-foot muted small">
        {to.length > 0 ? <span>{t('msg.to', { who: to.map((a) => `@${name(a)}`).join(' ') })}</span> : null}
        {receipt ? <span class="receipt">{t(`receipt.${receipt}`)}</span> : null}
        {onReply ? <button type="button" class="link" onClick={onReply}>{t('msg.replyAction')}</button> : null}
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
                focused={e.seq === focus} onReply={onReply ? () => onReply(e) : null}
              />
            )
          }
          const text = systemText(e, name)
          return text === null ? null : <li key={e.id} class="sys">{text} · <time dateTime={new Date(e.ts).toISOString()}>{fmtTime(e.ts)}</time></li>
        })}
        {tl.pending.map((m) => (
          <li key={m.id} class={`msg mine ${m.failed ? 'failed' : 'sending'}`} data-testid="msg-pending">
            <div class="msg-text">{m.text}</div>
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
  onSend: (text: string, to: AliasId[]) => void
}

export const Composer = ({ members, reply, onCancelReply, onSend }: ComposerProps) => {
  const [text, setText] = useState('')
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
    if (body === '') return
    onSend(body, to.map((m) => m.alias))
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
      <div class="composer-row">
        <textarea
          ref={area} data-testid="composer" rows={Math.min(8, Math.max(1, text.split('\n').length))} value={text}
          aria-label={t('composer.label')} placeholder={t('composer.placeholder')}
          onInput={(e) => track(e.currentTarget)} onKeyDown={onKeyDown} onBlur={() => setQuery(null)}
        />
        <button type="submit" class="primary" data-testid="send" disabled={text.trim() === ''}>{t('composer.send')}</button>
      </div>
      <div class="muted small" aria-live="polite">
        {to.length > 0 ? t('composer.to', { who: to.map((m) => `@${m.handle}`).join(' ') }) : t('composer.hint')}
      </div>
    </form>
  )
}
