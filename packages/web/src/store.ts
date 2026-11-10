// The one store: a cache of what the server said, plus the live-update loop.
// The server is the source of truth; nothing here is authoritative.

import { useEffect, useState } from 'preact/hooks'
import type { ConvId, ConvSummary, DraftView, InboxEvent, InboxItem, InviteView, Me } from '@sudare/protocol'
import { ApiFailure, api, setUnauthenticatedHandler } from './api'
import type { Lang } from './i18n'

export type State = {
  me: Me | null | undefined // undefined: not asked yet; null: signed out
  lang: Lang
  convs: ConvSummary[] | null
  inbox: InboxItem[] | null
  drafts: DraftView[] | null
  invites: InviteView[] | null
  ticks: Record<string, number> // per conversation: bumped whenever its log may have moved
  live: boolean
}

export const LANG_KEY = 'sudare.lang'
const detectLang = (): Lang => {
  const saved = localStorage.getItem(LANG_KEY)
  if (saved === 'en' || saved === 'zh') return saved
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

let state: State = { me: undefined, lang: detectLang(), convs: null, inbox: null, drafts: null, invites: null, ticks: {}, live: false }
const listeners = new Set<() => void>()

export const getState = (): State => state
export const setState = (patch: Partial<State>): void => {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

export const useStore = <T>(select: (s: State) => T): T => {
  const [value, setValue] = useState(() => select(state))
  useEffect(() => {
    const update = () => setValue(() => select(state))
    update()
    listeners.add(update)
    return () => void listeners.delete(update)
  }, [])
  return value
}

// -- lists ---------------------------------------------------------------------

type ListKey = 'convs' | 'inbox' | 'drafts' | 'invites'
const loaders: { [K in ListKey]: () => Promise<State[K]> } = { convs: api.convs, inbox: api.inbox, drafts: api.drafts, invites: api.invites }

export const refresh = async (...keys: ListKey[]): Promise<void> => {
  await Promise.all(keys.map(async (k) => {
    try {
      setState({ [k]: await loaders[k]() })
    } catch (e) {
      if (!(e instanceof ApiFailure)) throw e // a failed refresh keeps the previous cache
    }
  }))
}

export const bump = (conv: ConvId): void => setState({ ticks: { ...state.ticks, [conv]: (state.ticks[conv] ?? 0) + 1 } })

// -- live updates ----------------------------------------------------------------

const cursorKey = () => `sudare.cursor.${state.me?.principal ?? ''}`
let cursor: number | null = null
let syncing = false
let again = false

const apply = (events: InboxEvent[]): void => {
  const lists = new Set<ListKey>()
  const convs = new Set<ConvId>()
  for (const { body } of events) {
    switch (body.kind) {
      case 'delivered':
        convs.add(body.conv)
        lists.add('convs')
        if (body.addressed) lists.add('inbox')
        break
      case 'notice':
      case 'conv_joined':
      case 'conv_left':
      case 'round_seat':
        convs.add(body.conv)
        lists.add('convs')
        break
      case 'conv_invited':
      case 'invite_answered':
        lists.add('invites')
        break
      case 'read':
      case 'handed_off':
      case 'claimed':
      case 'claim_expired':
      case 'taken_back':
      case 'done':
        lists.add('inbox').add('convs')
        break
      case 'draft_created':
      case 'draft_approved':
      case 'draft_rejected':
        lists.add('drafts')
        break
    }
  }
  if (lists.size > 0) void refresh(...lists)
  for (const c of convs) bump(c)
}

export const sync = async (): Promise<void> => {
  if (syncing) {
    again = true
    return
  }
  syncing = true
  try {
    do {
      again = false
      for (let more = true; more;) {
        const page = await api.sync(cursor)
        more = page.more
        cursor = page.cursor
        localStorage.setItem(cursorKey(), String(cursor))
        apply(page.events)
      }
    } while (again)
  } catch {
    // the socket's reconnect (or the next bump) retries
  } finally {
    syncing = false
  }
}

let socket: WebSocket | null = null
let pingTimer: ReturnType<typeof setInterval> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
let attempt = 0

const disconnect = (): void => {
  clearInterval(pingTimer)
  clearTimeout(retryTimer)
  const ws = socket
  socket = null
  if (ws) {
    ws.onclose = null
    ws.close()
  }
  setState({ live: false })
}

const connect = (): void => {
  if (!state.me || socket) return
  clearTimeout(retryTimer)
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`)
  socket = ws
  ws.onopen = () => {
    attempt = 0
    setState({ live: true })
    pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping') }, 30_000)
    void sync() // whatever happened while we were away
  }
  ws.onmessage = (m) => {
    let seq: unknown
    try { seq = (JSON.parse(String(m.data)) as { seq?: unknown }).seq } catch { return }
    if (typeof seq === 'number' && (cursor === null || seq > cursor)) void sync()
  }
  ws.onclose = () => {
    clearInterval(pingTimer)
    socket = null
    setState({ live: false })
    if (!state.me) return
    const delay = Math.min(30_000, 1000 * 2 ** attempt++) * (0.75 + Math.random() / 2)
    retryTimer = setTimeout(connect, delay)
  }
  ws.onerror = () => ws.close()
}

const onVisible = (): void => {
  if (document.visibilityState !== 'visible' || !state.me) return
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send('ping')
    void sync()
  } else if (!socket || socket.readyState !== WebSocket.CONNECTING) {
    disconnect()
    attempt = 0
    connect()
  }
}

// -- session ---------------------------------------------------------------------

const signedIn = (me: Me): void => {
  setState({ me })
  const saved = Number(localStorage.getItem(cursorKey()))
  cursor = Number.isInteger(saved) && saved > 0 ? saved : null
  void refresh('convs', 'inbox', 'drafts', 'invites')
  connect()
}

export const signedOut = (): void => {
  disconnect()
  cursor = null
  setState({ me: null, convs: null, inbox: null, drafts: null, invites: null, ticks: {} })
}

/** Ask the server who we are. Safe to call again after a passkey ceremony. */
export const loadMe = async (): Promise<Me | null> => {
  try {
    const me = await api.me()
    signedIn(me)
    return me
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 401) {
      signedOut()
      return null
    }
    throw e
  }
}

export const boot = (): void => {
  setUnauthenticatedHandler(signedOut)
  document.addEventListener('visibilitychange', onVisible)
  addEventListener('online', onVisible)
  const ask = (): void => void loadMe().catch(() => setTimeout(ask, 3000)) // offline at start: keep asking
  ask()
}
