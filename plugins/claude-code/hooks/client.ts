// Talking to the Sudare server from inside the mod. Two credentials, kept
// strictly apart:
//
//   agent token  - held by Claude Code's own MCP client (keychain). The mod
//                  reaches it only through $.mcp.call; it never sees it.
//   human secret - generated here, kept in a module variable (process
//                  memory). By default it is never written to disk, env or
//                  $.store, and a reload forgets it. Only when the person
//                  turned on "Remember sign-in on this machine" is it also
//                  kept in $.store, for as long as the server said it lasts.

import type { EngineInterface } from 'claude-code'

import { asPlugin } from './guard'

type Engine = EngineInterface
export type Json = Record<string, unknown>
export type Reply = { ok: boolean; status: number; body: Json | Json[] }

let human: { secret: string; expires: number } | null = null

export const isSignedIn = (): boolean => human !== null
const STORED = 'human'

export function makeClient($: Engine, server: string, remember = false) {
  const base = server.replace(/\/+$/, '')

  /** Forget the sign-in everywhere on this machine. */
  const signOut = async (): Promise<void> => {
    human = null
    await $.store.delete(STORED).catch(() => undefined)
  }

  /** With "remember" on, pick up the sign-in a previous run kept; otherwise make sure none is kept. */
  const restore = async (): Promise<void> => {
    if (!remember) return void (await $.store.delete(STORED).catch(() => undefined))
    if (human) return
    const kept = (await $.store.get(STORED).catch(() => undefined)) as { secret?: unknown; expires?: unknown; server?: unknown } | undefined
    const usable = kept && typeof kept.secret === 'string' && typeof kept.expires === 'number' && kept.server === base && kept.expires > (await $.clock.now())
    if (usable) human = { secret: kept.secret as string, expires: kept.expires as number }
    else if (kept) await $.store.delete(STORED).catch(() => undefined)
  }

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const b64url = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i]!, bytes[i + 1], bytes[i + 2]]
    out += ALPHABET[a >> 2]! + ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!
    if (b !== undefined) out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!
    if (c !== undefined) out += ALPHABET[c & 63]!
  }
  return out
}

const sha256 = async (text: string): Promise<string> =>
  b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))

const parse = (text: string): Json | Json[] => {
  try {
    return JSON.parse(text) as Json | Json[]
  } catch {
    return {}
  }
}

  /** A human-scope API call. Without a live session it fails locally with 401. */
  const api = async (method: string, path: string, body?: Json): Promise<Reply> => {
    if (!human || human.expires <= (await $.clock.now())) {
      human = null
      return { ok: false, status: 401, body: { error: 'unauthenticated' } }
    }
    const res = await $.http.fetch(`${base}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${human.secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (res.status === 401) {
      human = null
      await $.store.delete(STORED).catch(() => undefined) // revoked or expired on the server: stop keeping it
    }
    return { ok: res.ok, status: res.status, body: parse(res.text) }
  }

  /** An agent-scope tool call through Claude Code's own authenticated MCP connection. */
  const tool = async (name: string, args: Json = {}): Promise<Reply> => {
    const attempt = async (serverName: string) => {
      const r = await $.mcp.call(serverName, name, args)
      const first = r.content[0] as { type?: string; text?: string } | undefined
      return { ok: !r.isError, status: r.isError ? 400 : 200, body: parse(first?.text ?? '{}') }
    }
    // Claude Code names a plugin's server plugin:<plugin>:<server>; older builds used the bare name.
    const errors: string[] = []
    for (const serverName of ['plugin:sudare:sudare', 'sudare']) {
      try {
        return await attempt(serverName)
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e))
      }
    }
    return { ok: false, status: 0, body: { error: errors[0] ?? 'the Sudare MCP server did not answer' } }
  }

  /**
   * Ask for a human session. Only the hash of a fresh secret leaves this
   * process, through the agent connection (which pins the request to this
   * person). The person then confirms with a passkey in their browser.
   */
  const beginSignIn = async (): Promise<{ ok: true; code: string; url: string; link: string; secret: string } | { ok: false; error: string }> => {
    const secret = `sds_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`
    const challenge = await sha256(secret)
    const started = await asPlugin(() => tool('human_session_start', { challenge, remember }))
    const body = started.body as { url?: string; link?: string; error?: string }
    if (!started.ok || !body.url || !body.link) return { ok: false, error: String(body.error ?? 'unexpected answer from the server').slice(0, 200) }
    return { ok: true, code: challenge.slice(0, 6).toUpperCase(), url: body.url, link: body.link, secret }
  }

  /** True once the person confirmed; from then on the secret is a bearer token. */
  const finishSignIn = async (link: string, secret: string): Promise<'confirmed' | 'waiting' | 'gone'> => {
    const res = await $.http.fetch(`${base}/api/link/${link}/status`)
    if (res.status === 404) return 'gone'
    const body = parse(res.text) as { confirmed?: boolean }
    if (!body.confirmed) return 'waiting'
    human = { secret, expires: (await $.clock.now()) + 8 * 3_600_000 }
    const me = await api('GET', '/me')
    const until = (me.body as { session_expires?: number }).session_expires
    if (me.ok && until && human) human = { secret, expires: until }
    if (me.ok && remember && human) await $.store.set(STORED, { ...human, server: base }).catch(() => undefined)
    return me.ok ? 'confirmed' : 'gone'
  }

  /** Open a URL in the person's browser, with whatever this platform offers. */
  const open = async (url: string): Promise<boolean> => {
    for (const argv of [['open', url], ['xdg-open', url], ['cmd', '/c', 'start', '', url]]) {
      try {
        if ((await $.process.run(argv, { timeoutMs: 5000 })).exitCode === 0) return true
      } catch {
        // try the next opener
      }
    }
    return false
  }

  return { base, api, tool, beginSignIn, finishSignIn, open, signOut, restore }
}

export type Client = ReturnType<typeof makeClient>
