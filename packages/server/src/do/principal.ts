// PrincipalDO: one object per person.
//
// It owns the private inbox log, the per-message handoff state machine with
// its compare-and-set claim (I3), agent drafts, received invitations, round
// seats and briefs, the full-text index and the live WebSocket connections.
// Agents never talk to a ConversationDO directly: every agent read passes
// `canRead` here first (I2).

import { DurableObject } from 'cloudflare:workers'
import {
  LIMITS, claimExpired, grantsRead, newDraftId, newEventId, transition, err, ok,
  type Actor, type AliasId, type ConvId, type ConvSummary, type DeviceId, type DraftId, type DraftTarget, type DraftView,
  type EventId, type HandoffMode, type InboxBody, type InboxEvent, type InboxItem, type InviteId, type InviteView,
  type ItemAction, type ItemState, type Result, type RoundId, type SearchHit, type SeatView,
} from '@sudare/protocol'
import type { Env } from '../env'
import { sendPush, validPushEndpoint } from '../push'
import type { DeliveredEvent, Delivery } from './types'

type ItemRow = { msg: string; conv: string; cseq: number; ts: number; sender: string; text: string; state: string }
type ConvRow = {
  conv: string; alias: string; handle: string; topic: string; from_seq: number; delivered_seq: number
  read_seq: number; last_ts: number; members: number; archived: number; gone: number; round: string | null
}
type DraftRow = {
  id: string; device: string; conv: string | null; target: string; text: string; status: DraftView['status']
  event_id: string; created: number; result: string | null
}
type RoundRow = { round: string; conv: string; goal: string; brief: string; device: string | null; joined: number; closed: number }

const SYNC_PAGE = 500

export type InviteNote = { id: InviteId; conv: ConvId; topic: string; by: string; members: number; expires: number }
export type DraftInput = { conv: ConvId | null; target: DraftTarget; text: string }
export type AgentInbox = {
  messages: { msg: EventId; conv: ConvId; topic: string; from: string; mode: HandoffMode; preview: string; ts: number }[]
  rounds: { round: RoundId; conv: ConvId; topic: string; goal: string }[]
}

export class PrincipalDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const sql = ctx.storage.sql
    sql.exec(`CREATE TABLE IF NOT EXISTS log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
      conv TEXT, msg TEXT, cseq INTEGER, mine INTEGER NOT NULL DEFAULT 0)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS log_conv ON log(conv, cseq)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS log_msg ON log(msg)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS items (
      msg TEXT PRIMARY KEY, conv TEXT NOT NULL, cseq INTEGER NOT NULL, ts INTEGER NOT NULL, sender TEXT NOT NULL,
      text TEXT NOT NULL, state TEXT NOT NULL, s TEXT NOT NULL, device TEXT, beat INTEGER)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS items_s ON items(s)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS items_conv ON items(conv, cseq)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS convs (
      conv TEXT PRIMARY KEY, alias TEXT NOT NULL, handle TEXT NOT NULL, topic TEXT NOT NULL, from_seq INTEGER NOT NULL,
      delivered_seq INTEGER NOT NULL DEFAULT 0, read_seq INTEGER NOT NULL DEFAULT 0, last_ts INTEGER NOT NULL DEFAULT 0,
      members INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, gone INTEGER NOT NULL DEFAULT 0, round TEXT)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY, device TEXT NOT NULL, conv TEXT, target TEXT NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL, event_id TEXT NOT NULL, created INTEGER NOT NULL, result TEXT)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY, conv TEXT NOT NULL, topic TEXT NOT NULL, by TEXT NOT NULL, members INTEGER NOT NULL,
      expires INTEGER NOT NULL, answered INTEGER NOT NULL DEFAULT 0)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS rounds (
      round TEXT PRIMARY KEY, conv TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', brief TEXT NOT NULL DEFAULT '',
      device TEXT, joined INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS push (endpoint TEXT PRIMARY KEY, created INTEGER NOT NULL)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`)
    sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
      text, conv UNINDEXED, kind UNINDEXED, ref UNINDEXED, cseq UNINDEXED, ts UNINDEXED, tokenize = 'trigram')`)
  }

  private get sql() {
    return this.ctx.storage.sql
  }

  private all<T extends Record<string, SqlStorageValue>>(query: string, ...args: (string | number | null)[]): T[] {
    return this.sql.exec<T>(query, ...args).toArray()
  }

  // -- the inbox log ----------------------------------------------------------

  private append(body: InboxBody, at: { conv?: string; msg?: string; cseq?: number; mine?: boolean } = {}): number {
    this.sql.exec(
      `INSERT INTO log (ts, kind, body, conv, msg, cseq, mine) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      Date.now(), body.kind, JSON.stringify(body), at.conv ?? null, at.msg ?? null, at.cseq ?? null, at.mine ? 1 : 0,
    )
    return this.head()
  }

  private head(): number {
    return this.all<{ m: number | null }>(`SELECT max(seq) AS m FROM log`)[0]?.m ?? 0
  }

  private meta(k: string): string | null {
    return this.all<{ v: string }>(`SELECT v FROM meta WHERE k = ?`, k)[0]?.v ?? null
  }

  private setMeta(k: string, v: string): void {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v)
  }

  /** Tell every connected client that the log moved; wake the phone if nobody is connected. */
  private announce(urgent: boolean): void {
    const seq = this.head()
    const sockets = this.ctx.getWebSockets()
    for (const ws of sockets) {
      try {
        ws.send(JSON.stringify({ seq }))
      } catch {
        // a dead socket is cleaned up by the runtime
      }
    }
    if (urgent && sockets.length === 0) this.ctx.waitUntil(this.push())
  }

  private async push(): Promise<void> {
    const subs = this.all<{ endpoint: string }>(`SELECT endpoint FROM push`)
    const results = await Promise.all(subs.map(async (s) => [s.endpoint, await sendPush(this.env, s.endpoint)] as const))
    for (const [endpoint, r] of results) if (r === 'gone') this.sql.exec(`DELETE FROM push WHERE endpoint = ?`, endpoint)
  }

  /** Incremental read of the inbox log. The cursor is per person and lives here, not on a device. */
  async sync(since: number | null): Promise<{ events: InboxEvent[]; cursor: number; more: boolean }> {
    const stored = Number(this.meta('cursor') ?? 0)
    const from = since ?? stored
    if (since !== null && since > stored) this.setMeta('cursor', String(Math.min(since, this.head())))
    const rows = this.all<{ seq: number; ts: number; body: string }>(
      `SELECT seq, ts, body FROM log WHERE seq > ? ORDER BY seq LIMIT ?`, from, SYNC_PAGE + 1,
    )
    const page = rows.slice(0, SYNC_PAGE)
    return {
      events: page.map((r) => ({ seq: r.seq, ts: r.ts, body: JSON.parse(r.body) as InboxBody })),
      cursor: page.length > 0 ? page[page.length - 1]!.seq : Math.max(from, 0),
      more: rows.length > SYNC_PAGE,
    }
  }

  // -- delivery from conversations (I7) ---------------------------------------

  async deliver(d: Delivery): Promise<void> {
    let urgent = false
    let any = false
    this.ctx.storage.transactionSync(() => {
      const row = this.all<ConvRow>(`SELECT * FROM convs WHERE conv = ?`, d.conv)[0]
      const delivered = row?.delivered_seq ?? 0
      this.sql.exec(
        `INSERT INTO convs (conv, alias, handle, topic, from_seq, members, archived, round) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conv) DO UPDATE SET alias = excluded.alias, handle = excluded.handle, topic = excluded.topic,
           from_seq = excluded.from_seq, members = excluded.members, archived = excluded.archived, round = excluded.round`,
        d.conv, d.alias, d.handle, d.topic, d.fromSeq, d.members, d.archived ? 1 : 0, d.round,
      )
      let last = delivered
      let lastTs = row?.last_ts ?? 0
      for (const e of d.events) {
        if (e.event.seq <= delivered) continue // at-least-once: already seen
        urgent = this.receive(d, e) || urgent
        last = e.event.seq
        lastTs = e.event.ts
        any = true
      }
      this.sql.exec(`UPDATE convs SET delivered_seq = max(delivered_seq, ?), last_ts = max(last_ts, ?) WHERE conv = ?`, last, lastTs, d.conv)
      this.dropUpTo(d.conv, d.floor)
    })
    if (any) this.announce(urgent)
  }

  /** Folds one conversation event into the inbox. Returns whether it deserves a push. */
  private receive(d: Delivery, { event: e, addressed, mine, sender }: DeliveredEvent): boolean {
    const b = e.body
    const at = { conv: d.conv, cseq: e.seq, mine }
    const notice = () => void this.append({ kind: 'notice', conv: d.conv, seq: e.seq, event: b.kind }, at)
    switch (b.kind) {
      case 'message':
        this.append({ kind: 'delivered', msg: e.id, conv: d.conv, addressed }, { ...at, msg: e.id })
        this.sql.exec(`INSERT INTO search (text, conv, kind, ref, cseq, ts) VALUES (?, ?, 'message', ?, ?, ?)`, b.text, d.conv, e.id, e.seq, e.ts)
        if (addressed) {
          const state: ItemState = { s: 'unread' }
          this.sql.exec(
            `INSERT OR IGNORE INTO items (msg, conv, cseq, ts, sender, text, state, s) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            e.id, d.conv, e.seq, e.ts, sender ?? '', b.text, JSON.stringify(state), state.s,
          )
        }
        return addressed
      case 'note_revision':
        this.sql.exec(
          `INSERT INTO search (text, conv, kind, ref, cseq, ts) VALUES (?, ?, 'note', ?, ?, ?)`,
          `${b.title}\n${b.text}`, d.conv, `${b.note}#${b.rev}`, e.seq, e.ts,
        )
        notice()
        return !mine || b.author.kind === 'autonomous' // a revision is waiting for this person's endorsement
      case 'member_joined':
        if (!mine) return notice(), false
        this.sql.exec(`UPDATE convs SET gone = 0 WHERE conv = ?`, d.conv)
        this.append({ kind: 'conv_joined', conv: d.conv, alias: b.alias, from_seq: e.seq }, at)
        return false
      case 'member_left':
        if (!mine) return notice(), false
        this.sql.exec(`UPDATE convs SET gone = 1 WHERE conv = ?`, d.conv)
        this.append({ kind: 'conv_left', conv: d.conv }, at)
        return false
      case 'round_opened':
        this.sql.exec(`INSERT INTO rounds (round, conv, goal) VALUES (?, ?, ?) ON CONFLICT(round) DO UPDATE SET goal = excluded.goal`, b.round, d.conv, b.goal)
        notice()
        return !mine
      case 'round_joined':
        notice()
        if (!mine) return false
        this.sql.exec(`INSERT INTO rounds (round, conv, joined) VALUES (?, ?, 1) ON CONFLICT(round) DO UPDATE SET joined = 1`, b.round, d.conv)
        this.append({ kind: 'round_seat', round: b.round, conv: d.conv, device: null }, at)
        return false
      case 'round_closed':
        this.sql.exec(`UPDATE rounds SET closed = 1 WHERE round = ?`, b.round)
        notice()
        return false
      default:
        notice()
        return false
    }
  }

  // -- conversations list -------------------------------------------------------

  async convs(): Promise<ConvSummary[]> {
    const rows = this.all<ConvRow & { unread: number; pending: number }>(
      `SELECT c.*,
        (SELECT count(*) FROM log l WHERE l.conv = c.conv AND l.kind = 'delivered' AND l.mine = 0 AND l.cseq > c.read_seq) AS unread,
        (SELECT count(*) FROM items i WHERE i.conv = c.conv AND i.s = 'unread') AS pending
       FROM convs c WHERE c.gone = 0 ORDER BY c.last_ts DESC`,
    )
    return rows.map((r) => ({
      id: r.conv as ConvId, topic: r.topic, alias: r.alias as AliasId, handle: r.handle, unread: r.unread, pending: r.pending,
      last_seq: r.delivered_seq, last_ts: r.last_ts, members: r.members, archived: r.archived === 1, round: r.round as RoundId | null,
    }))
  }

  /** Mark the timeline read up to `seq`. Returns the addressed messages this read. */
  async markRead(conv: ConvId, seq: number): Promise<EventId[]> {
    // Having the conversation on screen is reading it: addressed messages up to
    // `seq` leave "unread" too, through the same state machine as an explicit read.
    const read = this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE convs SET read_seq = max(read_seq, min(?, delivered_seq)) WHERE conv = ?`, seq, conv)
      const unread = this.all<{ msg: string }>(`SELECT msg FROM items WHERE conv = ? AND s = 'unread' AND cseq <= ? ORDER BY cseq`, conv, seq)
      return unread.map((r) => r.msg as EventId).filter((msg) => this.move(msg, { a: 'read' }, { scope: 'human' }).ok)
    })
    this.announce(false)
    return read
  }

  async topicOf(conv: ConvId): Promise<string | null> {
    return this.all<{ topic: string }>(`SELECT topic FROM convs WHERE conv = ? AND gone = 0`, conv)[0]?.topic ?? null
  }

  // -- addressed messages: the handoff state machine ---------------------------

  private item(msg: EventId): (ItemRow & { parsed: ItemState }) | null {
    const row = this.all<ItemRow>(`SELECT msg, conv, cseq, ts, sender, text, state FROM items WHERE msg = ?`, msg)[0]
    return row ? { ...row, parsed: JSON.parse(row.state) as ItemState } : null
  }

  private move(msg: EventId, action: ItemAction, actor: Actor): Result<{ row: ItemRow; state: ItemState }> {
    const row = this.item(msg)
    if (!row) return err('not_found')
    const t = transition(msg, row.parsed, action, actor, Date.now())
    if (!t.ok) return t
    const next = t.value.state
    this.sql.exec(
      `UPDATE items SET state = ?, s = ?, device = ?, beat = ? WHERE msg = ?`,
      JSON.stringify(next), next.s, next.s === 'claimed' ? next.device : null, next.s === 'claimed' ? next.beat : null, msg,
    )
    if (t.value.log) this.append(t.value.log, { conv: row.conv, msg, cseq: row.cseq })
    return ok({ row, state: next })
  }

  private expireClaims(): void {
    const now = Date.now()
    const stale = this.all<{ msg: string; state: string }>(`SELECT msg, state FROM items WHERE s = 'claimed' AND beat <= ?`, now - LIMITS.claimTimeoutMs)
    for (const r of stale) {
      if (claimExpired(JSON.parse(r.state) as ItemState, now)) this.move(r.msg as EventId, { a: 'expire' }, { scope: 'server' })
    }
  }

  private async armClaimAlarm(): Promise<void> {
    const next = this.all<{ b: number | null }>(`SELECT min(beat) AS b FROM items WHERE s = 'claimed'`)[0]?.b
    if (next) await this.ctx.storage.setAlarm(next + LIMITS.claimTimeoutMs + 100)
  }

  /** I8: a claim without a heartbeat for ten minutes falls back to handed_off. */
  override async alarm(): Promise<void> {
    const before = this.head()
    this.ctx.storage.transactionSync(() => this.expireClaims())
    if (this.head() !== before) this.announce(false)
    await this.armClaimAlarm()
  }

  private toInboxItem(r: ItemRow, topic: string): InboxItem {
    const st = JSON.parse(r.state) as ItemState
    return {
      msg: r.msg as EventId, conv: r.conv as ConvId, topic, seq: r.cseq, ts: r.ts, from: r.sender, text: r.text, state: st.s,
      mode: st.s === 'handed_off' || st.s === 'claimed' ? st.mode : null, device: st.s === 'claimed' ? st.device : null,
    }
  }

  async inbox(all: boolean): Promise<InboxItem[]> {
    this.ctx.storage.transactionSync(() => this.expireClaims())
    const rows = this.all<ItemRow & { topic: string }>(
      `SELECT i.msg, i.conv, i.cseq, i.ts, i.sender, i.text, i.state, coalesce(c.topic, '') AS topic
       FROM items i LEFT JOIN convs c ON c.conv = i.conv ${all ? '' : `WHERE i.s != 'done'`} ORDER BY i.ts DESC LIMIT 200`,
    )
    return rows.map((r) => this.toInboxItem(r, r.topic))
  }

  /** A human action on an addressed message. Returns what a two-person receipt needs. */
  async humanAct(
    msg: EventId, action: Extract<ItemAction, { a: 'read' | 'handoff' | 'done' }>,
  ): Promise<Result<{ conv: ConvId; state: ItemState['s'] }>> {
    const r = this.ctx.storage.transactionSync(() => this.move(msg, action, { scope: 'human' }))
    if (!r.ok) return r
    this.announce(false)
    return ok({ conv: r.value.row.conv as ConvId, state: r.value.state.s })
  }

  // -- agent scope ---------------------------------------------------------------

  /** I2: may this device read this conversation right now? */
  async canRead(device: DeviceId, conv: ConvId): Promise<boolean> {
    this.touch(device)
    const items = this.all<{ state: string }>(`SELECT state FROM items WHERE conv = ? AND s IN ('handed_off', 'claimed')`, conv)
    if (items.some((r) => grantsRead(JSON.parse(r.state) as ItemState, device))) return true
    return this.all(`SELECT 1 AS x FROM rounds WHERE conv = ? AND device = ? AND joined = 1 AND closed = 0`, conv, device).length > 0
  }

  /** Any agent call is a heartbeat for that device's claims. */
  private touch(device: DeviceId): void {
    this.ctx.storage.transactionSync(() => {
      this.expireClaims()
      this.sql.exec(`UPDATE items SET beat = ?, state = json_set(state, '$.beat', ?) WHERE s = 'claimed' AND device = ?`, Date.now(), Date.now(), device)
    })
  }

  async agentInbox(device: DeviceId): Promise<AgentInbox> {
    this.touch(device)
    const messages = this.all<ItemRow & { topic: string }>(
      `SELECT i.msg, i.conv, i.cseq, i.ts, i.sender, i.text, i.state, coalesce(c.topic, '') AS topic
       FROM items i LEFT JOIN convs c ON c.conv = i.conv WHERE i.s = 'handed_off' ORDER BY i.ts LIMIT 50`,
    )
    const rounds = this.all<RoundRow & { topic: string }>(
      `SELECT r.*, coalesce(c.topic, '') AS topic FROM rounds r LEFT JOIN convs c ON c.conv = r.conv
       WHERE r.joined = 1 AND r.closed = 0 AND r.device IS NULL`,
    )
    return {
      messages: messages.map((r) => ({
        msg: r.msg as EventId, conv: r.conv as ConvId, topic: r.topic, from: r.sender,
        mode: (JSON.parse(r.state) as Extract<ItemState, { s: 'handed_off' }>).mode, preview: r.text.slice(0, 200), ts: r.ts,
      })),
      rounds: rounds.map((r) => ({ round: r.round as RoundId, conv: r.conv as ConvId, topic: r.topic, goal: r.goal })),
    }
  }

  /** I3: compare-and-set claim. The object is single-threaded, so two devices cannot both win. */
  async claim(device: DeviceId, msg: EventId): Promise<Result<InboxItem>> {
    const r = this.ctx.storage.transactionSync(() => {
      this.expireClaims()
      return this.move(msg, { a: 'claim' }, { scope: 'agent', device })
    })
    if (!r.ok) return r
    await this.armClaimAlarm()
    this.announce(false)
    const row = this.item(msg)!
    return ok(this.toInboxItem(row, (await this.topicOf(row.conv as ConvId)) ?? ''))
  }

  async agentDone(device: DeviceId, msg: EventId): Promise<Result<{ conv: ConvId }>> {
    const r = this.ctx.storage.transactionSync(() => this.move(msg, { a: 'done' }, { scope: 'agent', device }))
    if (!r.ok) return r
    this.announce(false)
    return ok({ conv: r.value.row.conv as ConvId })
  }

  // -- drafts: the only thing an agent can write outside a round (I1) ----------

  private draftView(r: DraftRow, deviceName = ''): DraftView {
    return {
      id: r.id as DraftId, conv: r.conv as ConvId | null, topic: null, target: JSON.parse(r.target) as DraftTarget,
      text: r.text, device: r.device as DeviceId, device_name: deviceName, status: r.status, created: r.created,
      result: r.result ? JSON.parse(r.result) : null,
    }
  }

  async draftCreate(device: DeviceId, input: DraftInput): Promise<DraftId> {
    this.touch(device)
    const id = newDraftId()
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO drafts (id, device, conv, target, text, status, event_id, created) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        id, device, input.conv, JSON.stringify(input.target), input.text, newEventId(), Date.now(),
      )
      this.append({ kind: 'draft_created', draft: id, conv: input.conv, target: input.target, text: input.text, device }, { conv: input.conv ?? undefined })
    })
    this.announce(true)
    return id
  }

  /** A device only ever sees the status of its own drafts. */
  async draftStatus(device: DeviceId, id: DraftId): Promise<Result<Pick<DraftView, 'status' | 'result'>>> {
    this.touch(device)
    const row = this.all<DraftRow>(`SELECT * FROM drafts WHERE id = ? AND device = ?`, id, device)[0]
    return row ? ok({ status: row.status, result: row.result ? JSON.parse(row.result) : null }) : err('not_found')
  }

  async drafts(pendingOnly: boolean): Promise<DraftView[]> {
    const rows = this.all<DraftRow & { topic: string | null }>(
      `SELECT d.*, c.topic AS topic FROM drafts d LEFT JOIN convs c ON c.conv = d.conv
       ${pendingOnly ? `WHERE d.status IN ('pending', 'approving')` : ''} ORDER BY d.created DESC LIMIT 100`,
    )
    return rows.map((r) => ({ ...this.draftView(r), topic: r.topic }))
  }

  /**
   * Phase one of approval, called only with a `human` session: the intent is
   * made durable before the conversation is written, so a crash in between
   * can be retried with the same event id and never double-sends.
   */
  async draftBegin(id: DraftId, text: string | null): Promise<Result<DraftView & { event_id: EventId }>> {
    const row = this.all<DraftRow>(`SELECT * FROM drafts WHERE id = ?`, id)[0]
    if (!row) return err('not_found')
    if (row.status !== 'pending' && row.status !== 'approving') return err('draft_not_pending')
    const final = row.status === 'pending' && text !== null ? text : row.text
    this.sql.exec(`UPDATE drafts SET status = 'approving', text = ? WHERE id = ?`, final, id)
    return ok({ ...this.draftView({ ...row, status: 'approving', text: final }), event_id: row.event_id as EventId })
  }

  /** Phase two: the write landed (or was definitively refused, which returns the draft to pending). */
  async draftFinish(id: DraftId, outcome: { ok: true; result: DraftView['result'] } | { ok: false }): Promise<void> {
    const row = this.all<DraftRow>(`SELECT * FROM drafts WHERE id = ? AND status = 'approving'`, id)[0]
    if (!row) return
    this.ctx.storage.transactionSync(() => {
      if (!outcome.ok) return void this.sql.exec(`UPDATE drafts SET status = 'pending' WHERE id = ?`, id)
      this.sql.exec(`UPDATE drafts SET status = 'approved', result = ? WHERE id = ?`, JSON.stringify(outcome.result), id)
      this.append({ kind: 'draft_approved', draft: id, as: row.event_id as EventId }, { conv: row.conv ?? undefined })
    })
    this.announce(false)
  }

  async draftReject(id: DraftId): Promise<Result<null>> {
    const row = this.all<DraftRow>(`SELECT * FROM drafts WHERE id = ?`, id)[0]
    if (!row) return err('not_found')
    if (row.status !== 'pending') return err('draft_not_pending')
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE drafts SET status = 'rejected' WHERE id = ?`, id)
      this.append({ kind: 'draft_rejected', draft: id }, { conv: row.conv ?? undefined })
    })
    this.announce(false)
    return ok(null)
  }

  // -- invitations ---------------------------------------------------------------

  async inviteDeliver(n: InviteNote): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const fresh = this.all(`SELECT 1 AS x FROM invites WHERE id = ?`, n.id).length === 0
      if (!fresh) return
      this.sql.exec(`INSERT INTO invites (id, conv, topic, by, members, expires) VALUES (?, ?, ?, ?, ?, ?)`, n.id, n.conv, n.topic, n.by, n.members, n.expires)
      this.append({ kind: 'conv_invited', invite: n.id, conv: n.conv, topic: n.topic, by: n.by, members: n.members }, { conv: n.conv })
    })
    this.announce(true)
  }

  async invites(): Promise<Omit<InviteView, 'suggested_handle'>[]> {
    return this.all<{ id: string; conv: string; topic: string; by: string; members: number; expires: number }>(
      `SELECT id, conv, topic, by, members, expires FROM invites WHERE answered = 0 AND expires > ? ORDER BY expires`, Date.now(),
    ).map((r) => ({ ...r, id: r.id as InviteId, conv: r.conv as ConvId }))
  }

  async inviteClosed(id: InviteId): Promise<void> {
    this.sql.exec(`UPDATE invites SET answered = 1 WHERE id = ?`, id)
    this.announce(false)
  }

  /** The inviter learns only "joined" or "not joined". */
  async inviteAnswered(id: InviteId, accepted: boolean): Promise<void> {
    this.append({ kind: 'invite_answered', invite: id, accepted })
    this.announce(false)
  }

  // -- round seats and briefs ---------------------------------------------------

  /** Stored before the join is written to the conversation; activated when that event is delivered. */
  async seatPrepare(round: RoundId, conv: ConvId, brief: string): Promise<void> {
    this.sql.exec(
      `INSERT INTO rounds (round, conv, brief) VALUES (?, ?, ?) ON CONFLICT(round) DO UPDATE SET brief = excluded.brief`,
      round, conv, brief,
    )
  }

  async seatInfo(round: RoundId): Promise<Result<{ conv: ConvId; brief: string; device: DeviceId | null }>> {
    const r = this.all<RoundRow>(`SELECT * FROM rounds WHERE round = ?`, round)[0]
    if (!r) return err('round_missing')
    if (r.closed === 1) return err('round_closed')
    return ok({ conv: r.conv as ConvId, brief: r.brief, device: r.device as DeviceId | null })
  }

  /** Mirrors a seat the ConversationDO granted (the compare-and-set happened there). */
  async seatTaken(round: RoundId, conv: ConvId, device: DeviceId): Promise<void> {
    const changed = this.ctx.storage.transactionSync(() => {
      const before = this.all<RoundRow>(`SELECT * FROM rounds WHERE round = ?`, round)[0]
      if (before?.device === device) return false
      this.sql.exec(
        `INSERT INTO rounds (round, conv, device, joined) VALUES (?, ?, ?, 1) ON CONFLICT(round) DO UPDATE SET device = excluded.device, joined = 1`,
        round, conv, device,
      )
      this.append({ kind: 'round_seat', round, conv, device }, { conv })
      return true
    })
    if (changed) this.announce(false)
  }

  async seats(): Promise<SeatView[]> {
    return this.all<RoundRow & { topic: string }>(
      `SELECT r.*, coalesce(c.topic, '') AS topic FROM rounds r LEFT JOIN convs c ON c.conv = r.conv WHERE r.joined = 1 AND r.closed = 0`,
    ).map((r) => ({ round: r.round as RoundId, conv: r.conv as ConvId, topic: r.topic, goal: r.goal, device: r.device as DeviceId | null, brief: r.brief }))
  }

  // -- search --------------------------------------------------------------------

  /**
   * Full-text search over what this person received. The trigram tokenizer
   * needs three characters; shorter queries fall back to a substring scan.
   */
  async search(q: string, limit = 30): Promise<SearchHit[]> {
    const query = q.trim()
    if (query === '') return []
    type Hit = { conv: string; kind: 'message' | 'note'; ref: string; cseq: number; ts: number; snippet: string; topic: string }
    const columns = `s.conv, s.kind, s.ref, s.cseq, s.ts, coalesce(c.topic, '') AS topic`
    const rows = [...query].length >= 3
      ? this.all<Hit>(
          `SELECT ${columns}, snippet(search, 0, '', '', '…', 24) AS snippet FROM search s LEFT JOIN convs c ON c.conv = s.conv
           WHERE search MATCH ? ORDER BY s.ts DESC LIMIT ?`,
          `"${query.replace(/"/g, '""')}"`, limit,
        )
      : this.all<Hit>(
          `SELECT ${columns}, substr(s.text, max(1, instr(lower(s.text), lower(?)) - 40), 160) AS snippet FROM search s
           LEFT JOIN convs c ON c.conv = s.conv WHERE instr(lower(s.text), lower(?)) > 0 ORDER BY s.ts DESC LIMIT ?`,
          query, query, limit,
        )
    return rows.map((r) => ({ conv: r.conv as ConvId, topic: r.topic, kind: r.kind, ref: r.ref, seq: r.cseq, ts: r.ts, snippet: r.snippet }))
  }

  // -- retention -----------------------------------------------------------------

  private dropUpTo(conv: ConvId, floor: number): void {
    if (floor <= 0) return
    this.sql.exec(`DELETE FROM items WHERE conv = ? AND cseq <= ?`, conv, floor)
    this.sql.exec(`DELETE FROM search WHERE conv = ? AND kind = 'message' AND cseq <= ?`, conv, floor)
    this.sql.exec(`DELETE FROM log WHERE conv = ? AND msg IS NOT NULL AND cseq <= ?`, conv, floor)
  }

  /** The conversation removed messages up to `floor`: drop every local trace of them. */
  async purged(conv: ConvId, floor: number): Promise<void> {
    this.ctx.storage.transactionSync(() => this.dropUpTo(conv, floor))
  }

  /** The conversation was deleted. */
  async forget(conv: ConvId): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      for (const table of ['items', 'log', 'convs', 'rounds', 'invites', 'drafts', 'search']) {
        this.sql.exec(`DELETE FROM ${table} WHERE conv = ?`, conv)
      }
    })
    this.announce(false)
  }

  // -- push and live connections -------------------------------------------------

  async pushSubscribe(endpoint: string): Promise<Result<null>> {
    if (!validPushEndpoint(endpoint)) return err('bad_request', 'endpoint')
    this.sql.exec(`INSERT OR REPLACE INTO push (endpoint, created) VALUES (?, ?)`, endpoint, Date.now())
    this.sql.exec(`DELETE FROM push WHERE endpoint NOT IN (SELECT endpoint FROM push ORDER BY created DESC LIMIT 10)`)
    return ok(null)
  }

  async pushUnsubscribe(endpoint: string): Promise<void> {
    this.sql.exec(`DELETE FROM push WHERE endpoint = ?`, endpoint)
  }

  /** WebSocket upgrade, hibernatable. The socket only ever says "the log is at seq N". */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 })
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    pair[1].send(JSON.stringify({ seq: this.head() }))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === 'ping') ws.send(JSON.stringify({ seq: this.head() }))
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code)
    } catch {
      // already closed
    }
  }

  /** The complete inbox log as NDJSON pages. */
  async export(after: number, limit = 1000): Promise<{ lines: string[]; next: number | null }> {
    const rows = this.all<{ seq: number; ts: number; body: string }>(`SELECT seq, ts, body FROM log WHERE seq > ? ORDER BY seq LIMIT ?`, after, limit)
    return {
      lines: rows.map((r) => JSON.stringify({ seq: r.seq, ts: r.ts, body: JSON.parse(r.body) })),
      next: rows.length === limit ? rows[rows.length - 1]!.seq : null,
    }
  }
}
