// History API routing: the server answers every unknown path with index.html.

import type { ComponentChildren, JSX } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { isConvId, isNoteId, type ConvId, type NoteId } from '@sudare/protocol'

export type Route =
  | { name: 'home' } | { name: 'login' } | { name: 'new' } | { name: 'inbox' } | { name: 'drafts' } | { name: 'invites' }
  | { name: 'search' } | { name: 'settings' } | { name: 'notfound' }
  | { name: 'join'; code: string }
  | { name: 'link'; id: string }
  | { name: 'conv'; id: ConvId }
  | { name: 'notes'; id: ConvId }
  | { name: 'note'; id: ConvId; note: NoteId }
  | { name: 'picture'; id: ConvId; image: string }

const STATIC: Record<string, Route> = {
  '/': { name: 'home' }, '/login': { name: 'login' }, '/new': { name: 'new' }, '/inbox': { name: 'inbox' },
  '/drafts': { name: 'drafts' }, '/invites': { name: 'invites' }, '/search': { name: 'search' }, '/settings': { name: 'settings' },
}

export const parseRoute = (pathname: string): Route => {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const fixed = STATIC[path]
  if (fixed) return fixed
  const [, head, a, b, c, extra] = path.split('/').map((s) => { try { return decodeURIComponent(s) } catch { return s } })
  if (extra !== undefined) return { name: 'notfound' }
  if (head === 'j' && a && b === undefined) return { name: 'join', code: a }
  if (head === 'link' && a && b === undefined) return { name: 'link', id: a }
  if (head === 'c' && isConvId(a)) {
    if (b === undefined) return { name: 'conv', id: a }
    if (b === 'notes' && c === undefined) return { name: 'notes', id: a }
    if (b === 'notes' && isNoteId(c)) return { name: 'note', id: a, note: c }
    if (b === 'p' && c && /^b_[0-9a-f]{32}$/.test(c)) return { name: 'picture', id: a, image: c }
  }
  return { name: 'notfound' }
}

const CHANGE = 'sudare:navigate'

export const navigate = (to: string, replace = false): void => {
  if (replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  dispatchEvent(new Event(CHANGE))
}

export type Location = { path: string; search: string; query: URLSearchParams }
const current = (): Location => ({ path: location.pathname, search: location.search, query: new URLSearchParams(location.search) })

export const useLocation = (): Location => {
  const [loc, setLoc] = useState(current)
  useEffect(() => {
    const update = () => setLoc(current())
    addEventListener('popstate', update)
    addEventListener(CHANGE, update)
    return () => {
      removeEventListener('popstate', update)
      removeEventListener(CHANGE, update)
    }
  }, [])
  return loc
}

/** Where to return after signing in. Only same-site paths: never `//host` or an absolute URL. */
export const safeNext = (raw: string | null): string =>
  raw !== null && /^\/(?![/\\])/.test(raw) && !/[\u0000-\u001f]/.test(raw) ? raw : '/'

export const loginPath = (): string => `/login?next=${encodeURIComponent(location.pathname + location.search)}`

type LinkProps = Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string; children?: ComponentChildren }

export const Link = ({ href, children, onClick, ...rest }: LinkProps) => (
  <a
    {...rest}
    href={href}
    onClick={(e) => {
      onClick?.(e)
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      navigate(href)
    }}
  >
    {children}
  </a>
)
