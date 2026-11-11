// ConversationDO: the imperative shell around the pure conversation core.
//
// One object per conversation. It owns the shared append-only log, the folded
// state, and a delivery cursor per member. An append, the new folded state and
// the cursors a new member needs are written in one synchronous transaction;
// the single-threaded object makes `seq` strictly monotonic (I5).
//
// Delivery (I7) is at-least-once: each member has a cursor that only advances
// once their PrincipalDO acknowledged a batch. The cursor plays the role of the
// spec's outbox table with one row per member instead of one per (event, member).

import { DurableObject } from 'cloudflare:workers'
import {
  activeMembers, adoptedRev, allMembers, apply, canInvite, canReadSeq, decide, emptyConv, isCreator, latestRev,
  LIMITS, memberOf, newEventId, openRounds, publicEvent, remaining, err, ok,
  type AliasId, type Command, type ConvBody, type ConvEvent, type ConvId, type ConvState, type ConvView,
  type DeviceId, type Err, type EventId, type ImageRef, type ImageType, type Member, type NoteId, type NoteView, type PrincipalId, type Result,
  type Round, type RoundId, type RoundView, type StoredConvEvent,
} from '@sudare/protocol'
import type { Env } from '../env'
import { DIRECTORY, type DeliveredEvent, type Delivery } from './types'

const DAY = 86_400_000
const BATCH = 200
const PART = 1024 * 1024
const LONG_POLL_MS = 25_000
const RETRY_MIN_MS = 2_000
const RETRY_MAX_MS = 5 * 60_000

type Row = { seq: number; id: string; ts: number; body: string; private: string; direct: number }

export type ExecResult =
  | { ok: true; events: ConvEvent[]; duplicate: boolean }
  | { ok: false; error: Err['error']; detail?: unknown; events: ConvEvent[] }

export type RoundBrief = { round: RoundView; context: ConvEvent[]; members: ConvView['members'] }

const toStored = (conv: ConvId, r: Row): StoredConvEvent => ({
  id: r.id as EventId, conv, seq: r.seq, ts: r.ts, body: JSON.parse(r.body), private: JSON.parse(r.private),
})

const refOf = (b: ConvBody): string | null =>
  b.kind === 'note_revision' || b.kind === 'note_endorsed' ? b.note : 'round' in b ? b.round : null

export class ConversationDO extends DurableObject<Env> {
  private state!: ConvState
  private waiters = new Set<() => void>()
  private flushing: Promise<void> | null = null
  private dirty = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const sql = ctx.storage.sql
    sql.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL, kind TEXT NOT NULL,
      ref TEXT, body TEXT NOT NULL, private TEXT NOT NULL, direct INTEGER NOT NULL DEFAULT 0)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS events_kind ON events(kind, ts)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS events_ref ON events(ref)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS cursors (target TEXT PRIMARY KEY, acked INTEGER NOT NULL)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`)
    // Pictures. `seq` is the message a picture belongs to; null until it is sent with one.
    sql.exec(`CREATE TABLE IF NOT EXISTS blobs (
      id TEXT PRIMARY KEY, by TEXT NOT NULL, type TEXT NOT NULL, bytes INTEGER NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL,
      ts INTEGER NOT NULL, seq INTEGER, thumb INTEGER NOT NULL DEFAULT 0)`)
    // A row holds at most 2 MB, so bytes are kept in parts.
    sql.exec(`CREATE TABLE IF NOT EXISTS blob_parts (id TEXT NOT NULL, kind TEXT NOT NULL, i INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, kind, i))`)
    const saved = this.meta('state')
    this.state = saved ? (JSON.parse(saved) as ConvState) : emptyConv('' as ConvId)
  }

  // -- storage helpers ------------------------------------------------------

  private get sql() {
    return this.ctx.storage.sql
  }

  private meta(k: string): string | null {
    const row = this.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0]
    return row ? row.v : null
  }

  private setMeta(k: string, v: string): void {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v)
  }

  private rows(where: string, ...args: (string | number)[]): StoredConvEvent[] {
    return this.sql.exec<Row>(`SELECT seq, id, ts, body, private, direct FROM events WHERE ${where}`, ...args)
      .toArray().map((r) => toStored(this.state.conv, r))
  }

  private floor(): number {
    return Number(this.meta('floor') ?? 0)
  }

  // -- writes ---------------------------------------------------------------

  /**
   * Decide a command against the current state and persist what it emits.
   * Idempotent on the command id: a repeat returns the original events.
   */
  async exec(conv: ConvId, c: Command): Promise<ExecResult> {
    if (!this.state.conv) this.state = emptyConv(conv)
    if (this.state.conv !== conv) return { ok: false, error: 'bad_request', events: [] }
    const now = Date.now()
    const result = this.ctx.storage.transactionSync((): ExecResult => {
      if ('id' in c) {
        const prior = this.rows(`id = ?`, c.id)
        if (prior.length > 0) return { ok: true, events: prior.map(publicEvent), duplicate: true }
      }
      const d = decide(this.state, c, { now, nextId: () => newEventId(now) })
      const base = this.state.seq
      const events = d.emits.map((e, i): StoredConvEvent => ({
        id: e.id, conv, seq: base + i + 1, ts: now, body: e.body, private: e.private,
      }))
      let state = this.state
      for (const e of events) {
        const direct = activeMembers(state).length === 2 ? 1 : 0
        this.sql.exec(
          `INSERT INTO events (seq, id, ts, kind, ref, body, private, direct) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          e.seq, e.id, e.ts, e.body.kind, refOf(e.body), JSON.stringify(e.body), JSON.stringify(e.private), direct,
        )
        state = apply(state, e)
        if (e.body.kind === 'message') for (const image of e.body.images ?? []) this.sql.exec(`UPDATE blobs SET seq = ? WHERE id = ?`, e.seq, image.id)
        if (e.body.kind === 'member_joined') {
          const m = state.members[e.body.alias]!
          this.sql.exec(
            `INSERT INTO cursors (target, acked) VALUES (?, ?) ON CONFLICT(target) DO UPDATE SET acked = min(acked, excluded.acked)`,
            m.principal, m.fromSeq - 1,
          )
        }
      }
      if (events.length > 0) {
        this.sql.exec(`INSERT OR IGNORE INTO cursors (target, acked) VALUES (?, 0)`, DIRECTORY)
        this.setMeta('state', JSON.stringify(state))
        this.state = state
      }
      const out = events.map(publicEvent)
      return d.error
        ? { ok: false, error: d.error.error, detail: d.error.detail, events: out }
        : { ok: true, events: out, duplicate: false }
    })
    if (result.events.length > 0 && !('duplicate' in result && result.duplicate)) this.changed()
    return result
  }

  private changed(): void {
    for (const wake of this.waiters) wake()
    this.waiters.clear()
    this.ctx.waitUntil(this.flush())
  }

  // -- delivery (I7) ----------------------------------------------------------

  private async flush(): Promise<void> {
    if (this.flushing) {
      this.dirty = true
      return this.flushing
    }
    this.flushing = (async () => {
      let failed = false
      do {
        this.dirty = false
        const targets = this.sql.exec<{ target: string; acked: number }>(`SELECT target, acked FROM cursors`).toArray()
        const results = await Promise.allSettled(targets.map((t) => this.deliverTo(t.target, t.acked)))
        failed = results.some((r) => r.status === 'rejected')
        for (const r of results) if (r.status === 'rejected') console.warn('delivery failed', String(r.reason))
      } while (this.dirty && !failed)
      const attempt = failed ? Number(this.meta('attempt') ?? 0) + 1 : 0
      this.setMeta('attempt', String(attempt))
      this.setMeta('retry_at', failed ? String(Date.now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt)) : '0')
      await this.schedule()
    })().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  private ack(target: string, seq: number): void {
    this.sql.exec(`UPDATE cursors SET acked = max(acked, ?) WHERE target = ?`, seq, target)
  }

  private async deliverTo(target: string, acked: number): Promise<void> {
    const s = this.state
    if (target === DIRECTORY) return this.project(acked)
    const principal = target as PrincipalId
    // A person may have several aliases over time (left and came back): the
    // batch covers every stretch they were entitled to.
    const mine = allMembers(s).filter((m) => m.principal === principal)
    const current = mine.find((m) => m.leftSeq === null) ?? mine[mine.length - 1]
    if (!current) return void this.sql.exec(`DELETE FROM cursors WHERE target = ?`, target)
    const events = this.rows(`seq > ? ORDER BY seq LIMIT ${BATCH}`, acked)
    const last = events.length > 0 ? events[events.length - 1]!.seq : s.seq
    const visible = events.filter((e) => mine.some((m) => canReadSeq(m, e.seq)))
    if (visible.length > 0 || acked === 0) {
      const direct = new Map(
        this.sql.exec<{ seq: number; direct: number }>(`SELECT seq, direct FROM events WHERE seq > ? AND seq <= ?`, acked, last)
          .toArray().map((r) => [r.seq, r.direct === 1]),
      )
      const delivery: Delivery = {
        principal, conv: s.conv, topic: s.topic, alias: current.alias, handle: current.handle,
        fromSeq: current.fromSeq, members: activeMembers(s).length, archived: s.archivedSeq !== null,
        round: openRounds(s)[0]?.id ?? null, floor: this.floor(),
        events: visible.map((e) => this.deliverable(e, mine, direct.get(e.seq) ?? false)),
      }
      await this.env.PRINCIPAL.get(this.env.PRINCIPAL.idFromName(principal)).deliver(delivery)
    }
    this.ack(target, last)
    const gone = current.leftSeq !== null && last >= current.leftSeq
    if (gone && last >= s.seq) this.sql.exec(`DELETE FROM cursors WHERE target = ? AND acked >= ?`, target, s.seq)
    if (last < s.seq) this.dirty = true
  }

  private deliverable(e: StoredConvEvent, mine: Member[], direct: boolean): DeliveredEvent {
    const b = e.body
    const author = b.kind === 'message' || b.kind === 'note_revision' ? b.author.alias : null
    const subject = author ?? ('alias' in b ? b.alias : 'by' in b ? b.by : null)
    const isMine = subject !== null && mine.some((m) => m.alias === subject)
    const named = b.kind === 'message' && mine.some((m) => b.to.includes(m.alias))
    return {
      event: publicEvent(e),
      mine: isMine,
      addressed: b.kind === 'message' && !isMine && (named || direct),
      sender: author ? (this.state.members[author]?.handle ?? null) : null,
    }
  }

  /** Projects membership and topic into the D1 directory. Idempotent upserts. */
  private async project(acked: number): Promise<void> {
    const events = this.rows(`seq > ? AND kind IN ('conv_created','conv_renamed','conv_archived','member_joined','member_renamed','member_left') ORDER BY seq LIMIT ${BATCH}`, acked)
    const db = this.env.DB
    const statements = events.flatMap((e): D1PreparedStatement[] => {
      const b = e.body
      switch (b.kind) {
        case 'conv_created':
          return [db.prepare(`INSERT INTO convs (id, topic, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET topic = excluded.topic`).bind(e.conv, b.topic, e.ts)]
        case 'conv_renamed':
          return [db.prepare(`UPDATE convs SET topic = ? WHERE id = ?`).bind(b.topic, e.conv)]
        case 'conv_archived':
          return [db.prepare(`UPDATE convs SET archived_at = ? WHERE id = ?`).bind(e.ts, e.conv)]
        case 'member_joined':
          return [
            db.prepare(`INSERT INTO aliases (alias, conv, principal, handle, joined_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(alias) DO NOTHING`)
              .bind(b.alias, e.conv, e.private.principal!, b.handle, e.ts),
            // "Private" is only ever a head count. Once a third person is in, this is an ordinary
            // room, and the two can open a fresh chat between themselves.
            db.prepare(`UPDATE convs SET dm_key = NULL WHERE id = ? AND dm_key IS NOT NULL AND (SELECT count(*) FROM aliases WHERE conv = ? AND left_at IS NULL) > 2`)
              .bind(e.conv, e.conv),
          ]
        case 'member_renamed':
          return [
            db.prepare(`UPDATE aliases SET handle = ? WHERE alias = ?`).bind(b.handle, b.alias),
            // Invitations still waiting for an answer say who sent them: keep that current.
            db.prepare(`UPDATE invites SET by_handle = ? WHERE conv = ? AND used_at IS NULL AND by_principal = (SELECT principal FROM aliases WHERE alias = ?)`).bind(b.handle, e.conv, b.alias),
          ]
        case 'member_left':
          return [db.prepare(`UPDATE aliases SET left_at = ? WHERE alias = ?`).bind(e.ts, b.alias)]
        default:
          return []
      }
    })
    if (statements.length > 0) await db.batch(statements)
    this.ack(DIRECTORY, events.length === BATCH ? events[events.length - 1]!.seq : this.state.seq)
    if (events.length === BATCH) this.dirty = true
  }

  // -- alarm: round deadlines (I9), delivery retries, retention -------------

  private async schedule(): Promise<void> {
    const s = this.state
    if (!s.created) return
    const retry = Number(this.meta('retry_at') ?? 0)
    const sweep = Number(this.meta('sweep_at') ?? 0) || Date.now() + DAY
    if (!this.meta('sweep_at')) this.setMeta('sweep_at', String(sweep))
    const times = [sweep, ...(retry > 0 ? [retry] : []), ...openRounds(s).map((r) => r.budget.until)]
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 50, Math.min(...times)))
  }

  override async alarm(): Promise<void> {
    const s = this.state
    if (!s.created) return
    if (openRounds(s).some((r) => Date.now() >= r.budget.until)) await this.exec(s.conv, { t: 'tick' })
    if (Date.now() >= Number(this.meta('sweep_at') ?? 0)) {
      this.setMeta('sweep_at', String(Date.now() + DAY))
      if (await this.sweep()) return
    }
    await this.flush()
    await this.schedule()
  }

  /** Retention: drop expired messages; delete an archived conversation whole. Returns true if destroyed. */
  private async sweep(): Promise<boolean> {
    const s = this.state
    const horizon = Date.now() - s.retentionDays * DAY
    if (s.archivedSeq !== null) {
      const archived = this.rows(`seq = ?`, s.archivedSeq)[0]
      if (archived && archived.ts <= horizon) {
        await this.destroy()
        return true
      }
    }
    this.dropImages(`seq IS NULL AND ts <= ?`, Date.now() - DAY) // uploaded and never sent
    const top = this.sql.exec<{ m: number | null }>(
      `SELECT max(seq) AS m FROM events WHERE kind IN ('message','receipt') AND ts <= ?`, horizon,
    ).toArray()[0]?.m
    if (!top || top <= this.floor()) return false
    this.sql.exec(`DELETE FROM events WHERE kind IN ('message','receipt') AND seq <= ?`, top)
    this.dropImages(`seq <= ?`, top)
    this.setMeta('floor', String(top))
    await Promise.allSettled(
      activeMembers(s).map((m) => this.env.PRINCIPAL.get(this.env.PRINCIPAL.idFromName(m.principal)).purged(s.conv, top)),
    )
    return false
  }

  /** The operator erases the server: this room's storage, without the per-member goodbyes. */
  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.state = emptyConv('' as ConvId)
  }

  private async destroy(): Promise<void> {
    const s = this.state
    const people = [...new Set(allMembers(s).map((m) => m.principal))]
    await Promise.all(people.map((p) => this.env.PRINCIPAL.get(this.env.PRINCIPAL.idFromName(p)).forget(s.conv)))
    await this.env.DB.batch([
      this.env.DB.prepare(`DELETE FROM aliases WHERE conv = ?`).bind(s.conv),
      this.env.DB.prepare(`DELETE FROM invites WHERE conv = ?`).bind(s.conv),
      this.env.DB.prepare(`DELETE FROM convs WHERE id = ?`).bind(s.conv),
    ])
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.state = emptyConv('' as ConvId)
  }

  // -- reads: every one is filtered by what the caller may see (I11, I12) ----

  private member(p: PrincipalId): Result<Member> {
    if (!this.state.created) return err('conv_missing')
    const m = memberOf(this.state, p)
    return m ? ok(m) : err('not_member')
  }

  private roundView(r: Round): RoundView {
    const aliases = Object.keys(r.seats) as AliasId[]
    return {
      id: r.id, by: r.by, goal: r.goal, budget: r.budget, used: { messages: r.messages, chars: r.chars },
      joined: aliases, seated: aliases.filter((a) => r.seats[a] !== null),
      closed: r.closed?.reason ?? null, opened_seq: r.openedSeq,
    }
  }

  private memberViews(me: Member): ConvView['members'] {
    return allMembers(this.state).map((m) => ({
      alias: m.alias, handle: m.handle, left: m.leftSeq !== null, creator: isCreator(this.state, m), me: m.alias === me.alias,
    }))
  }

  async view(p: PrincipalId): Promise<Result<ConvView>> {
    const m = this.member(p)
    if (!m.ok) return m
    const s = this.state
    return ok({
      id: s.conv, topic: s.topic, invite: s.invite, parent: s.parent, archived: s.archivedSeq !== null,
      retention_days: s.retentionDays, seq: s.seq, me: m.value.alias, from_seq: m.value.fromSeq,
      can_invite: canInvite(s, m.value), members: this.memberViews(m.value),
      rounds: Object.values(s.rounds).filter((r) => r.closed === null || r.closed.seq >= m.value.fromSeq).map((r) => this.roundView(r)),
    })
  }

  async events(
    p: PrincipalId, q: { before?: number; after?: number; limit?: number },
  ): Promise<Result<{ events: ConvEvent[]; more: boolean }>> {
    const m = this.member(p)
    if (!m.ok) return m
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200)
    const lo = Math.max(m.value.fromSeq, (q.after ?? 0) + 1)
    const hi = q.before ?? Number.MAX_SAFE_INTEGER
    const forward = q.after !== undefined
    const rows = this.rows(`seq >= ? AND seq < ? ORDER BY seq ${forward ? 'ASC' : 'DESC'} LIMIT ?`, lo, hi, limit + 1)
    const page = rows.slice(0, limit)
    return ok({ events: (forward ? page : page.reverse()).map(publicEvent), more: rows.length > limit })
  }

  // -- pictures -------------------------------------------------------------------

  private parts(id: string, kind: 'full' | 'thumb'): Uint8Array {
    const rows = this.sql.exec<{ data: ArrayBuffer }>(`SELECT data FROM blob_parts WHERE id = ? AND kind = ? ORDER BY i`, id, kind).toArray().map((r) => new Uint8Array(r.data))
    const out = new Uint8Array(rows.reduce((n, r) => n + r.length, 0))
    rows.reduce((at, r) => (out.set(r, at), at + r.length), 0)
    return out
  }

  private keep(id: string, kind: 'full' | 'thumb', data: Uint8Array): void {
    for (let i = 0; i * PART < data.length; i++) this.sql.exec(`INSERT INTO blob_parts (id, kind, i, data) VALUES (?, ?, ?, ?)`, id, kind, i, data.slice(i * PART, (i + 1) * PART).buffer)
  }

  /** A member puts a picture in the room, to send with their next message. A few may wait unsent, no more. */
  async putImage(p: PrincipalId, image: { type: ImageType; w: number; h: number; data: Uint8Array; thumb: Uint8Array | null }): Promise<Result<ImageRef>> {
    const m = this.member(p)
    if (!m.ok) return m
    if (this.state.archivedSeq !== null) return err('conv_archived')
    const waiting = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM blobs WHERE by = ? AND seq IS NULL AND ts > ?`, p, Date.now() - DAY).one().n
    if (waiting >= 2 * LIMITS.image.perMessage) return err('rate_limited')
    const ref: ImageRef = { id: `b_${crypto.randomUUID().replace(/-/g, '')}`, type: image.type, bytes: image.data.length, w: image.w, h: image.h }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT INTO blobs (id, by, type, bytes, w, h, ts, seq, thumb) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`, ref.id, p, ref.type, ref.bytes, ref.w, ref.h, Date.now(), image.thumb ? 1 : 0)
      this.keep(ref.id, 'full', image.data)
      if (image.thumb) this.keep(ref.id, 'thumb', image.thumb)
    })
    return ok(ref)
  }

  /** The pictures a person is about to send: theirs, in this room, not yet sent. What the log will say about them comes from here, not from the client. */
  async unsentImages(p: PrincipalId, ids: string[]): Promise<Result<ImageRef[]>> {
    const rows = ids.map((id) => this.sql.exec<ImageRef & { by: string; seq: number | null }>(`SELECT id, by, type, bytes, w, h, seq FROM blobs WHERE id = ?`, id).toArray()[0])
    return rows.every((r) => r && r.by === p && r.seq === null)
      ? ok(rows.map((r) => ({ id: r!.id, type: r!.type, bytes: r!.bytes, w: r!.w, h: r!.h })))
      : err('bad_request', 'images')
  }

  /**
   * A picture, for a member who may read the message it belongs to (I12), or for the
   * person who uploaded it. `small` is the PNG preview a terminal can draw, where there is one.
   */
  async image(p: PrincipalId, id: string, small: boolean): Promise<Result<{ type: ImageType; data: Uint8Array }>> {
    const m = this.member(p)
    if (!m.ok) return m
    const row = this.sql.exec<{ by: string; type: ImageType; seq: number | null; thumb: number }>(`SELECT by, type, seq, thumb FROM blobs WHERE id = ?`, id).toArray()[0]
    const sent = row && row.seq !== null && canReadSeq(m.value, row.seq)
    if (!row || !(sent || row.by === p)) return err('not_found')
    if (!small) return ok({ type: row.type, data: this.parts(id, 'full') })
    if (row.thumb) return ok({ type: 'image/png', data: this.parts(id, 'thumb') })
    return row.type === 'image/png' ? ok({ type: row.type, data: this.parts(id, 'full') }) : err('not_found')
  }

  private dropImages(where: string, ...args: (string | number)[]): void {
    this.sql.exec(`DELETE FROM blob_parts WHERE id IN (SELECT id FROM blobs WHERE ${where})`, ...args)
    this.sql.exec(`DELETE FROM blobs WHERE ${where}`, ...args)
  }

  /** One message someone else wrote, as this member may see it (I12): what a person needs to hand it to their agent. */
  async message(p: PrincipalId, id: EventId): Promise<Result<{ seq: number; ts: number; sender: string; text: string }>> {
    const m = this.member(p)
    if (!m.ok) return m
    const e = this.rows(`id = ?`, id)[0]
    if (!e || e.body.kind !== 'message' || e.seq < m.value.fromSeq || m.value.leftSeq !== null) return err('not_found')
    if (e.body.author.alias === m.value.alias) return err('bad_request', 'own message')
    return ok({ seq: e.seq, ts: e.ts, sender: this.state.members[e.body.author.alias]?.handle ?? '', text: e.body.text || '[picture]' })
  }

  /** Alias ids for handles, for agent drafts. Unknown handles are an error naming them. */
  async resolveHandles(p: PrincipalId, handles: string[]): Promise<Result<AliasId[]>> {
    const m = this.member(p)
    if (!m.ok) return m
    const byKey = new Map(activeMembers(this.state).map((x) => [x.handle.toLowerCase(), x.alias]))
    const found = handles.map((h) => byKey.get(h.replace(/^@/, '').normalize('NFKC').toLowerCase()))
    const missing = handles.filter((_, i) => !found[i])
    return missing.length > 0 ? err('recipient_unknown', { handles: missing }) : ok(found as AliasId[])
  }

  /** Server-internal: who is behind these aliases. Requires the caller to be a current member. */
  async principalsOf(p: PrincipalId, aliases: AliasId[]): Promise<Result<{ principal: PrincipalId; handle: string }[]>> {
    const m = this.member(p)
    if (!m.ok) return m
    const found = aliases.map((a) => this.state.members[a]).filter((x): x is Member => !!x && x.leftSeq === null)
    return found.length === aliases.length
      ? ok(found.map((x) => ({ principal: x.principal, handle: x.handle })))
      : err('recipient_unknown')
  }

  /**
   * The fork rule: if the caller and every one of `others` are current
   * members here, a new conversation among them needs no consent because the
   * audience does not grow. Returns everyone's handle here, caller first.
   */
  async forkHandles(p: PrincipalId, others: PrincipalId[]): Promise<Result<string[]>> {
    const m = this.member(p)
    if (!m.ok) return m
    const found = others.map((o) => memberOf(this.state, o))
    return found.every((x) => x) ? ok([m.value.handle, ...found.map((x) => x!.handle)]) : err('not_member')
  }

  async inviteInfo(p: PrincipalId): Promise<Result<{ topic: string; by: string; members: number }>> {
    const m = this.member(p)
    if (!m.ok) return m
    if (this.state.archivedSeq !== null) return err('conv_archived')
    if (!canInvite(this.state, m.value)) return err('invite_forbidden')
    return ok({ topic: this.state.topic, by: m.value.handle, members: activeMembers(this.state).length })
  }

  async isMember(p: PrincipalId): Promise<boolean> {
    return this.state.created && memberOf(this.state, p) !== undefined
  }

  // -- notes ------------------------------------------------------------------

  private revisionRows(note?: NoteId): StoredConvEvent[] {
    return note ? this.rows(`kind = 'note_revision' AND ref = ? ORDER BY seq`, note) : this.rows(`kind = 'note_revision' ORDER BY seq`)
  }

  /** A revision is visible if it was written after the member joined, or it has been adopted (I12). */
  private noteViews(me: Member, only?: NoteId): NoteView[] {
    const ts = new Map(this.revisionRows(only).map((e) => [e.seq, e.ts]))
    return Object.values(this.state.notes)
      .filter((n) => !only || n.id === only)
      .map((n) => {
        const revs = n.revs.filter((r) => canReadSeq(me, r.seq) || r.adoptedSeq !== null)
        return revs.length === 0 ? null : {
          id: n.id, title: revs[revs.length - 1]!.title, head: latestRev(n).rev, adopted: adoptedRev(n)?.rev ?? null,
          revs: revs.map((r) => ({
            rev: r.rev, base: r.base, seq: r.seq, ts: ts.get(r.seq) ?? 0, author: r.author, title: r.title,
            endorsed: r.endorsed, adopted: r.adoptedSeq !== null,
          })),
        }
      })
      .filter((n): n is NoteView => n !== null)
  }

  async notes(p: PrincipalId): Promise<Result<NoteView[]>> {
    const m = this.member(p)
    return m.ok ? ok(this.noteViews(m.value)) : m
  }

  async note(p: PrincipalId, note: NoteId, rev?: number): Promise<Result<{ note: NoteView; rev: number; title: string; text: string }>> {
    const m = this.member(p)
    if (!m.ok) return m
    const view = this.noteViews(m.value, note)[0]
    if (!view) return err('note_missing')
    const wanted = rev ?? view.adopted ?? view.revs[view.revs.length - 1]!.rev
    if (!view.revs.some((r) => r.rev === wanted)) return err('note_missing')
    const body = this.revisionRows(note).map((e) => e.body).find((b) => b.kind === 'note_revision' && b.rev === wanted)
    return body && body.kind === 'note_revision' ? ok({ note: view, rev: wanted, title: body.title, text: body.text }) : err('note_missing')
  }

  // -- rounds -----------------------------------------------------------------

  private seat(p: PrincipalId, device: DeviceId, round: RoundId): Result<{ me: Member; round: Round }> {
    const m = this.member(p)
    if (!m.ok) return m
    const r = this.state.rounds[round]
    if (!r) return err('round_missing')
    return r.seats[m.value.alias] === device ? ok({ me: m.value, round: r }) : err('round_not_seated')
  }

  async roundBrief(p: PrincipalId, device: DeviceId, round: RoundId): Promise<Result<RoundBrief>> {
    const seat = this.seat(p, device, round)
    if (!seat.ok) return seat
    const context = this.rows(`seq >= ? ORDER BY seq DESC LIMIT 50`, seat.value.me.fromSeq).reverse().map(publicEvent)
    return ok({ round: this.roundView(seat.value.round), context, members: this.memberViews(seat.value.me) })
  }

  /** Long poll: events since `since` within the round's lifetime; waits up to 25 s when there are none. */
  async roundRead(
    p: PrincipalId, device: DeviceId, round: RoundId, since: number, waitMs: number,
  ): Promise<Result<{ events: ConvEvent[]; remaining: ReturnType<typeof remaining>; closed: string | null; seq: number }>> {
    const read = () => {
      const seat = this.seat(p, device, round)
      if (!seat.ok) return seat
      const r = seat.value.round
      const lo = Math.max(since + 1, r.openedSeq, seat.value.me.fromSeq)
      const hi = r.closed ? r.closed.seq : Number.MAX_SAFE_INTEGER
      const events = this.rows(`seq >= ? AND seq <= ? ORDER BY seq LIMIT ${BATCH}`, lo, hi).map(publicEvent)
      const seq = events.length > 0 ? events[events.length - 1]!.seq : Math.max(since, r.openedSeq - 1)
      return ok({ events, remaining: remaining(r), closed: r.closed?.reason ?? null, seq })
    }
    const first = read()
    if (!first.ok || first.value.events.length > 0 || first.value.closed || waitMs <= 0) return first
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.waiters.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, Math.min(waitMs, LONG_POLL_MS))
      this.waiters.add(wake)
    })
    return read()
  }

  // -- export (migration exit) ------------------------------------------------

  /** The complete log, in seq order, as NDJSON pages. The log is the only source of truth. */
  async export(after: number, limit = 1000): Promise<{ lines: string[]; next: number | null }> {
    const rows = this.rows(`seq > ? ORDER BY seq LIMIT ?`, after, limit)
    return {
      lines: rows.map((e) => JSON.stringify(e)),
      next: rows.length === limit ? rows[rows.length - 1]!.seq : null,
    }
  }
}
