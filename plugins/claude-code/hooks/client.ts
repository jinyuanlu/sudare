// Talking to the Sudare server from inside the mod. Two credentials, kept
// strictly apart:
//
//   agent token  - held by Claude Code's own MCP client (keychain). The mod
//                  reaches it only through $.mcp.call; it never sees it.
//   human secret - generated here, kept in a module variable (process
//                  memory), never written to disk, env or $.store. A reload
//                  of the mod forgets it, which is the intended lifetime.

import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface
export type Json = Record<string, unknown>
export type Reply = { ok: boolean; status: number; body: Json | Json[] }

let human: { secret: string; expires: number } | null = null

export const isSignedIn = (): boolean => human !== null
export const signOut = (): void => {
  human = null
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

export function makeClient($: Engine, server: string) {
  const base = server.replace(/\/+$/, '')

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
    if (res.status === 401) human = null
    return { ok: res.ok, status: res.status, body: parse(res.text) }
  }

  /** An agent-scope tool call through Claude Code's own authenticated MCP connection. */
  const tool = async (name: string, args: Json = {}): Promise<Reply> => {
    const attempt = async (serverName: string) => {
      const r = await $.mcp.call(serverName, name, args)
      const first = r.content[0] as { type?: string; text?: string } | undefined
      return { ok: !r.isError, status: r.isError ? 400 : 200, body: parse(first?.text ?? '{}') }
    }
    try {
      return await attempt('plugin:sudare:sudare')
    } catch {
      return attempt('sudare')
    }
  }

  /**
   * Ask for a human session. Only the hash of a fresh secret leaves this
   * process, through the agent connection (which pins the request to this
   * person). The person then confirms with a passkey in their browser.
   */
  const beginSignIn = async (): Promise<{ ok: true; code: string; url: string; link: string; secret: string } | { ok: false; error: string }> => {
    const secret = `sds_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`
    const challenge = await sha256(secret)
    const started = await tool('human_session_start', { challenge }).catch(() => null)
    const body = started?.body as { url?: string; link?: string; error?: string } | undefined
    if (!started?.ok || !body?.url || !body.link) return { ok: false, error: body?.error ?? 'the Sudare MCP server is not connected' }
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

  return { base, api, tool, beginSignIn, finishSignIn, open }
}

export type Client = ReturnType<typeof makeClient>
