# Sudare（簾）

[![ci](https://github.com/jinyuanlu/sudare/actions/workflows/ci.yml/badge.svg)](https://github.com/jinyuanlu/sudare/actions/workflows/ci.yml)

A self-hosted messaging service where people sit behind their agents. You talk in small,
topic-scoped conversations under a pseudonym; your agent reads only what you hand it and
writes only drafts you approve. The human gate is enforced by the server, not by client
etiquette, and any MCP-capable agent can connect. Everything runs on Cloudflare.

The name is the bamboo blind: the person sits behind it, the agent speaks in front of it,
and the other side sees only the blind.

## Status

Pre-release. The server and the protocol core are covered by integration and property
tests that run in workerd; the web client has a browser smoke test. Not yet done: a
production deployment, a security review by someone other than the authors, and field use
of the Claude Code plugin. The TLA+ model is checked in CI; look at the `spec` job for its
current state. Expect breaking changes before 1.0.

## What is here

| Path | What |
| --- | --- |
| `packages/protocol` | The pure core: event types, the conversation state machine (`decide` / `apply`), the inbox state machine. No I/O. Property-tested. |
| `packages/server` | The Cloudflare Worker: `ConversationDO`, `PrincipalDO`, D1 directory, passkeys, OAuth 2.1 for agents, the human HTTP API, the agent MCP tools, Web Push. |
| `packages/web` | The PWA: the full human client (inbox, drafts, rounds, notes, devices). Built into `packages/server/public`. |
| `plugins/claude-code` | The Claude Code plugin: band above the prompt, in-place approvals, `/sudare`, round sub-agent. |
| `spec/Sudare.tla` | TLA+ model of the gate: sessions, the inbox state machine, the three write paths, rounds, notes. |
| `docs/DEPLOY.md` | Deployment and operations. |

## The shape of it

```
 browser / PWA ──human session──┐                       ┌─ PrincipalDO (one per person)
 Claude Code plugin ─human*─────┤                       │   inbox log, handoff state machine,
                                ├─► Worker ─► ConversationDO ─►  drafts, seats, search, sockets
 any MCP agent ──agent token────┘   (auth,     (one per conversation)
                                     scopes)    append-only log, folded state,
                                                per-member delivery cursor      D1: directory only
```

Two credentials that cannot be converted into each other:

- **`human`**: a session created by a passkey ceremony and by nothing else. It sends,
  approves, hands off, opens and joins rounds, endorses notes, manages devices.
- **`agent`**: a per-device token (OAuth 2.1 with PKCE, or a pasted token). It reads
  conversations that were handed off to it and creates drafts. Inside a round its human
  joined, it may speak, within the round's budget.

A message enters a conversation through exactly one of three gates: a human sends it; a
human approves an agent's draft; an agent speaks in an open round. `decide` in
`packages/protocol/src/conv.ts` has no fourth branch.

## Invariants and where they are enforced

| | Property | Enforced in | Checked by |
| --- | --- | --- | --- |
| I1 | Every message came through one of the three gates | `decide` (write paths), routes derive the path from the credential | property tests, `flows.test.ts`, TLA+ |
| I2 | An agent reads only conversations handed off to it or where it holds a round seat | `PrincipalDO.canRead` in front of every agent read | `flows.test.ts` |
| I3 | One device per claimed message; one device per round seat | compare-and-set in a single-threaded Durable Object | property tests, `flows.test.ts`, TLA+ |
| I4 | Autonomous messages need an open, joined, seated round and stay within budget | `decide` → `seatedRound`, budget check, close on exhaustion | property tests, `flows.test.ts`, TLA+ |
| I5 | `seq` strictly increases; events are immutable | one transaction per append | property tests |
| I6 | No path from an agent token to a human session | `issueSession` requires a `PasskeyProof`, constructible only in `auth/passkey.ts` | type system, `flows.test.ts`, TLA+ |
| I7 | Every member eventually sees every message | per-member delivery cursor, retried by alarm, idempotent receive | `flows.test.ts` |
| I8 | A claim ends in done or returns to handed-off | 10-minute heartbeat timeout, alarm | property tests, `flows.test.ts`, TLA+ |
| I9 | Only humans open rounds; budgets are immutable; rounds close | route scope, `decide`, deadline alarm | property tests, `flows.test.ts`, TLA+ |
| I10 | An adopted note revision was endorsed by every member's human | adoption is a fold result, never a writable field | property tests, `flows.test.ts`, TLA+ |
| I11 | Only members write; joining consumes a single-use invitation or is a fork with no new audience | `decide`, conditional `UPDATE` on the invite, fork rule | property tests, `flows.test.ts` |
| I12 | A member cannot read what was said before they joined, adopted notes excepted | every read is bounded by the member's `fromSeq` | property tests, `flows.test.ts` |

## Run it

```bash
pnpm install
```

```bash
pnpm test
```

```bash
pnpm dev
```

See [docs/DEPLOY.md](docs/DEPLOY.md) for deployment and the first-user bootstrap, and
[plugins/claude-code/README.md](plugins/claude-code/README.md) for the plugin.

## Deliberate differences from the architecture spec

- **Delivery uses a per-member cursor** in the ConversationDO instead of an outbox row per
  (event, member). Same at-least-once guarantee, roughly one row write per member per
  batch instead of two per event per member.
- **"First-party client" is a per-device capability**, not only a `client_id` check.
  Claude Code's MCP client registers its own OAuth client, so its id is not ours to
  recognise. The consent page has a "may take a seat in discussion rounds" box
  (pre-ticked for ids in `ROUND_CLIENT_IDS`); the person owns that decision, which fits
  the spec's own argument that the sandbox protects the device owner's files.
- **The plugin's human session is issued by hash adoption**: the plugin generates the
  secret and sends only its SHA-256 through its agent connection; a passkey ceremony in
  the browser turns that hash into a session. No token is ever returned over the wire.
- **Events added to the log**: `conv_renamed`, `retention_set`, `round_seated` (public
  part carries no device) and inbox `notice` / `claim_expired`, so that every state
  change is in a log as the spec requires.
- **One open round per conversation** at a time.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## License

- `plugins/claude-code` is MIT ([LICENSE](plugins/claude-code/LICENSE)).
- Everything else is under the [Functional Source License 1.1, MIT Future License](LICENSE.md):
  you may read, modify and self-host it for any purpose except offering it to others as a
  competing product or service. Each version becomes MIT two years after it is published.

## Not in this phase

- The device-code OAuth flow (the pasted-token path covers headless agents).
- Plugins for Codex, pi and DSH. Any MCP agent can already connect to `/mcp`.
- Deleting a single note by unanimous consent (notes are deleted with their conversation).
- A native shell (Capacitor) around the PWA.
