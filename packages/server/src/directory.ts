// D1 access. Every query the Worker makes against the directory is here.

import type { AliasId, ConvId, DeviceId, DeviceView, InviteId, PrincipalId } from '@sudare/protocol'
import type { Env } from './env'

export type InviteRow = {
  id: InviteId; code_hash: string | null; conv: ConvId; kind: 'link' | 'direct' | 'bootstrap'
  by_principal: PrincipalId | null; by_handle: string; target: PrincipalId | null; bound: PrincipalId | null
  bootstrap_topic: string | null; created_at: number; expires_at: number
  used_at: number | null; used_by: PrincipalId | null; declined_at: number | null
}

export type DeviceRow = {
  id: DeviceId; principal: PrincipalId; kind: 'oauth' | 'token'; name: string; client_id: string; client_name: string
  rounds: number; token_hash: string | null; created_at: number; last_active: number | null
  expires_at: number | null; revoked_at: number | null
}

export const deviceView = (d: DeviceRow): DeviceView => ({
  id: d.id, name: d.name, kind: d.kind, client: d.client_name, rounds: d.rounds === 1,
  created: d.created_at, last_active: d.last_active, expires: d.expires_at,
})

const first = <T>(db: D1Database, query: string, ...args: unknown[]): Promise<T | null> =>
  db.prepare(query).bind(...args).first<T>()

const all = async <T>(db: D1Database, query: string, ...args: unknown[]): Promise<T[]> =>
  (await db.prepare(query).bind(...args).all<T>()).results

const run = async (db: D1Database, query: string, ...args: unknown[]): Promise<number> =>
  (await db.prepare(query).bind(...args).run()).meta.changes ?? 0

export const directory = (env: Env) => {
  const db = env.DB
  return {
    // principals
    principal: (id: PrincipalId) => first<{ id: PrincipalId; default_handle: string | null }>(db, `SELECT id, default_handle FROM principals WHERE id = ?`, id),
    createPrincipal: (id: PrincipalId, invitedVia: InviteId) =>
      run(db, `INSERT INTO principals (id, invited_via, created_at) VALUES (?, ?, ?)`, id, invitedVia, Date.now()),
    setDefaultHandle: (id: PrincipalId, handle: string) =>
      run(db, `UPDATE principals SET default_handle = ? WHERE id = ? AND default_handle IS NULL`, handle, id),

    // presence
    /** At most one write a minute per person. */
    seen: (id: PrincipalId) => run(db, `UPDATE principals SET last_seen = ? WHERE id = ? AND (last_seen IS NULL OR last_seen < ?)`, Date.now(), id, Date.now() - 60_000),
    /** Aliases of a conversation whose person was seen in the last two minutes. */
    activeIn: async (conv: ConvId) =>
      new Set((await all<{ alias: AliasId }>(db,
        `SELECT a.alias AS alias FROM aliases a JOIN principals p ON p.id = a.principal WHERE a.conv = ? AND a.left_at IS NULL AND p.last_seen > ?`, conv, Date.now() - 120_000)).map((r) => r.alias)),

    // devices
    device: (id: DeviceId) => first<DeviceRow>(db, `SELECT * FROM devices WHERE id = ?`, id),
    deviceByToken: (hash: string) => first<DeviceRow>(db, `SELECT * FROM devices WHERE token_hash = ?`, hash),
    devices: (p: PrincipalId) =>
      all<DeviceRow>(db, `SELECT * FROM devices WHERE principal = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC`, p, Date.now()),
    createDevice: (d: Omit<DeviceRow, 'last_active' | 'revoked_at'>) =>
      run(db, `INSERT INTO devices (id, principal, kind, name, client_id, client_name, rounds, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        d.id, d.principal, d.kind, d.name, d.client_id, d.client_name, d.rounds, d.token_hash, d.created_at, d.expires_at),
    updateDevice: (p: PrincipalId, id: DeviceId, name: string, rounds: boolean) =>
      run(db, `UPDATE devices SET name = ?, rounds = ? WHERE id = ? AND principal = ? AND revoked_at IS NULL`, name, rounds ? 1 : 0, id, p),
    revokeDevice: (p: PrincipalId, id: DeviceId) =>
      run(db, `UPDATE devices SET revoked_at = ? WHERE id = ? AND principal = ? AND revoked_at IS NULL`, Date.now(), id, p),
    touchDevice: (id: DeviceId, slide: number | null) =>
      run(db, `UPDATE devices SET last_active = ?, expires_at = CASE WHEN ? IS NULL THEN expires_at ELSE ? END WHERE id = ?`, Date.now(), slide, slide, id),
    expireDevices: () => run(db, `UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?`, Date.now(), Date.now()),

    // conversations and aliases
    /** Of these rooms, the private chats, each with the other person's name there. */
    privateChats: async (me: PrincipalId, convs: ConvId[]): Promise<Map<ConvId, string>> => {
      if (convs.length === 0) return new Map()
      const marks = convs.map(() => '?').join(',')
      const rows = await all<{ conv: ConvId; handle: string }>(db,
        `SELECT c.id AS conv, a.handle AS handle FROM convs c JOIN aliases a ON a.conv = c.id AND a.principal != ? AND a.left_at IS NULL
         WHERE c.dm_key IS NOT NULL AND c.id IN (${marks})`, me, ...convs)
      return new Map(rows.map((r) => [r.conv, r.handle]))
    },
    isPrivateChat: async (conv: ConvId) => (await first<{ n: number }>(db, `SELECT count(*) AS n FROM convs WHERE id = ? AND dm_key IS NOT NULL`, conv))?.n === 1,
    reserveDm: (conv: ConvId, key: string) =>
      run(db, `INSERT INTO convs (id, topic, dm_key, created_at) VALUES (?, '', ?, ?) ON CONFLICT(dm_key) DO NOTHING`, conv, key, Date.now()),
    dm: (key: string) => first<{ id: ConvId }>(db, `SELECT id FROM convs WHERE dm_key = ?`, key),
    releaseDm: (conv: ConvId) => run(db, `DELETE FROM convs WHERE id = ? AND topic = ''`, conv),
    /** Everyone who currently shares a conversation with `p`: the only people `p` can name. */
    contacts: (p: PrincipalId) =>
      all<{ conv: ConvId; alias: AliasId; handle: string; topic: string; principal: PrincipalId }>(db,
        `SELECT other.conv AS conv, other.alias AS alias, other.handle AS handle, c.topic AS topic, other.principal AS principal
         FROM aliases mine JOIN aliases other ON other.conv = mine.conv AND other.principal != mine.principal AND other.left_at IS NULL
         JOIN convs c ON c.id = mine.conv
         WHERE mine.principal = ? AND mine.left_at IS NULL AND c.archived_at IS NULL ORDER BY c.created_at DESC, other.handle`, p),

    // invites
    invite: (id: InviteId) => first<InviteRow>(db, `SELECT * FROM invites WHERE id = ?`, id),
    inviteByCode: (hash: string) => first<InviteRow>(db, `SELECT * FROM invites WHERE code_hash = ?`, hash),
    createInvite: (i: Pick<InviteRow, 'id' | 'code_hash' | 'conv' | 'kind' | 'by_principal' | 'by_handle' | 'target' | 'bootstrap_topic' | 'expires_at'>) =>
      run(db, `INSERT INTO invites (id, code_hash, conv, kind, by_principal, by_handle, target, bootstrap_topic, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        i.id, i.code_hash, i.conv, i.kind, i.by_principal, i.by_handle, i.target, i.bootstrap_topic, Date.now(), i.expires_at),
    pendingDirect: (conv: ConvId, target: PrincipalId) =>
      first<InviteRow>(db, `SELECT * FROM invites WHERE conv = ? AND target = ? AND used_at IS NULL AND declined_at IS NULL AND expires_at > ?`, conv, target, Date.now()),
    /** One registration per link: the link binds to the first principal who registers through it. */
    bindInvite: (id: InviteId, p: PrincipalId) => run(db, `UPDATE invites SET bound = ? WHERE id = ? AND bound IS NULL AND used_at IS NULL`, p, id),
    /** Single use (I11): succeeds for exactly one caller. */
    consumeInvite: (id: InviteId, p: PrincipalId) =>
      run(db, `UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND declined_at IS NULL AND expires_at > ?`, Date.now(), p, id, Date.now()),
    releaseInvite: (id: InviteId, p: PrincipalId) => run(db, `UPDATE invites SET used_at = NULL, used_by = NULL WHERE id = ? AND used_by = ?`, id, p),
    pendingInvites: (conv: ConvId) =>
      all<InviteRow>(db, `SELECT * FROM invites WHERE conv = ? AND kind IN ('direct', 'link') AND used_at IS NULL AND declined_at IS NULL AND expires_at > ? ORDER BY created_at`, conv, Date.now()),
    declineInvite: (id: InviteId) => run(db, `UPDATE invites SET declined_at = ? WHERE id = ? AND used_at IS NULL AND declined_at IS NULL`, Date.now(), id),

    // housekeeping
    purge: () => db.batch([
      db.prepare(`DELETE FROM challenges WHERE expires_at <= ?`).bind(Date.now()),
      db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(Date.now()),
      db.prepare(`DELETE FROM human_links WHERE expires_at <= ?`).bind(Date.now()),
      db.prepare(`DELETE FROM invites WHERE expires_at <= ? AND used_at IS NULL`).bind(Date.now() - 30 * 86_400_000),
    ]),
  }
}

export type Directory = ReturnType<typeof directory>
