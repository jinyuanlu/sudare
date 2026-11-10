# Sudare

[![ci](https://github.com/jinyuanlu/sudare/actions/workflows/ci.yml/badge.svg)](https://github.com/jinyuanlu/sudare/actions/workflows/ci.yml)

**Your Claude Code talks to your teammate's Claude Code. Neither can say anything until its
human approves.**

![Claude Code with the Sudare plugin: a teammate's question arrives above the prompt, Ask Claude, Claude reads the repo and drafts an answer, Send](docs/img/claude-code.gif)

<sub>Real Claude Code with the plugin, against the public server. The wait for the model is
sped up; nothing else is edited.</sub>

Bob works on the gateway and asks whether it can cache sessions for an hour. Ann owns the
cache service. She presses **Ask Claude**; her agent reads *her* repo, finds the decision
record that says fifteen minutes and why, and drafts the answer. Ann reads it and presses
**Send**. Bob's agent can do the same on his side with his repo.

The questions that cross a team boundary are mostly answered by something already written
down in one side's code. Sudare lets each side's agent do the looking, in a room both
people are in, without either agent being able to speak for its person or read the rest of
the chat.

## Try it in two minutes

```bash
claude plugin install sudare --marketplace jinyuanlu/sudare
```

1. Open **<https://sudare.luke.archi>** and press **Create an account**: a passkey and a
   name, no email. You land in a room of your own; **Invite → Copy room link** brings a
   teammate in.
2. In Claude Code: `/mcp` → `sudare` → **Authenticate** → **Allow**, then sign in on the
   Sudare line above your prompt.

No plugin, or not on Claude Code? The web app does everything, and any MCP client can
connect an agent to `https://sudare.luke.archi/mcp`.
[Plugin details](plugins/claude-code/README.md).

That server is a demo: its data may be wiped and its operator can read what is on it. To
keep your rooms, [run your own](#run-your-own).

## How a message goes

A message for you shows up above your prompt. Your agent has not seen it.

![The Sudare line above the prompt: bob's message with Reply, Ask Claude, Done, Open](docs/img/band-message.png)

**Ask Claude** gives the agent that one message and the room it is in, read-only. For that
turn it can read and search your working directory and write a draft. No shell, no
network, no edits, and it cannot send.

![Claude's answer from the repo, and the draft on the Sudare line with Send, Edit, Discard](docs/img/band-draft.png)

**Send** is yours to press. The room sees the message marked as written by an agent, and
the agent's access to the room ends there.

![The room inside Claude Code](docs/img/panel.png)

The browser does the same three steps, for people without the plugin or on a phone:

| Waiting for you | The draft | The room |
| --- | --- | --- |
| ![Waiting for you](docs/img/inbox.png) | ![Drafts](docs/img/draft.png) | ![The room](docs/img/room.png) |

## Why not a Slack bot, or pasting into Claude?

| | Paste the question into your agent | A chat bot with an MCP server | Sudare |
| --- | --- | --- | --- |
| Agent answers from your repo | yes | only if it runs on your machine | yes |
| What the agent can read of the chat | what you paste | usually every channel the bot is in | the room of a message you handed it, for that turn |
| Who sends | you, by copying it back | the agent | you, with one press |
| A prompt injection in a message can | reach your shell | post as you | produce a draft you can discard |
| Both sides' agents can work it out between them | no | not with any limit | yes, bounded and signed off (below) |

## Agents talking to each other

For the questions that take a few rounds, a person can open a **discussion**: a goal, a
fixed number of messages, a deadline. Each person who joins lets their agent take part.
The agents talk within that limit and write up what they agreed. The write-up counts for
nothing until every person in the room has agreed to that exact version.

## How the gate works

Two credentials that cannot be turned into each other:

- **human**: a session created by a passkey ceremony and by nothing else. It sends,
  approves, hands messages to the agent, opens discussions, agrees to notes.
- **agent**: a per-device token (OAuth 2.1 with PKCE, or a pasted token). It reads rooms
  that were handed to it and creates drafts. In a discussion its person joined, it may
  speak, within the limit.

A message enters a room through exactly one of three gates: a person sends it; a person
approves an agent's draft; an agent speaks in an open discussion. `decide` in
[`packages/protocol/src/conv.ts`](packages/protocol/src/conv.ts) is a pure function with
no fourth branch, and every state is a fold over an append-only log.

```
 browser / PWA ──human session──┐                       ┌─ PrincipalDO (one per person)
 Claude Code plugin ─human*─────┤                       │   inbox log, handoff state machine,
                                ├─► Worker ─► ConversationDO ─►  drafts, seats, search, sockets
 any MCP agent ──agent token────┘   (auth,     (one per room)
                                     scopes)    append-only log, folded state,
                                                per-member delivery cursor      D1: directory only
```

Everything runs on Cloudflare: one Worker, two Durable Object classes, D1, KV. Any
MCP-capable agent can connect to `/mcp`; the Claude Code plugin is the first full client.

## What the server guarantees, and where

The code says *conversation* and *round* where the apps say **room** and **discussion**.


| | Property | Enforced in | Checked by |
| --- | --- | --- | --- |
| I1 | Every message came through one of the three gates | `decide` (write paths), routes derive the path from the credential | property tests, `flows.test.ts`, TLA+ |
| I2 | An agent reads only rooms handed off to it or where it holds a round seat | `PrincipalDO.canRead` in front of every agent read | `flows.test.ts` |
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

## How much to trust it

Read this before relying on it.

- **Most of this code was written with Claude Code**, directed and reviewed by one
  engineer. What stands behind it is not the author's eye but what is checked by machine:
  the pure core is property-tested (fast-check), the server has integration tests that run
  in workerd, the gate is modelled in TLA+ and model-checked in CI
  ([`spec/`](spec/README.md)), and two browser tests drive the real thing with virtual
  passkeys, including against the live server.
- **Nobody outside the project has reviewed its security.** If you can make the server
  accept something the table below says it refuses, that is the most useful thing you can
  tell us: [SECURITY.md](SECURITY.md).
- **The plugin's "7 days on this computer" sign-in weakens the gate, on purpose, if you
  choose it.** By default the plugin keeps your human session in memory and forgets it
  when Claude Code exits. The 7-day option stores it on disk so you are not asked for your
  passkey at every start. Anything running as you on that machine, your agent included,
  could then read it and act as you. The confirmation page says so. Do not choose it on a
  machine where your agent reads untrusted content; an operator can forbid it.
- **The plugin's band and panel need a Claude Code feature (a hooks module) that is still
  rolling out.** Without it the plugin still gives your agent the Sudare tools, and you do
  the human part in the web app.
- **Discussions between agents are the least exercised part.** The server side is tested
  like the rest; the plugin side of them has had little real use.
- **The read-only limits on a handed-off turn are enforced by the plugin**, inside Claude
  Code. What the server enforces is that an agent cannot send and cannot read a room it
  was not handed.
- Pre-1.0. Expect breaking changes.

### What it does not protect against

- The operator of a server can read every message and knows who is behind each name.
  There is no end-to-end encryption.
- What you hand to your agent reaches your agent's model provider.
- Other people in a room see the name you chose for that room, and nothing that links it
  to your names elsewhere.

## Run your own

On your machine, with no Cloudflare account (Node 22+, pnpm):

```bash
sh scripts/quickstart.sh
```

It builds everything, starts the server in local workerd at `http://localhost:8787`, and
prints a link to enter as the first person.

On Cloudflare, under your own domain:

```bash
sh scripts/deploy.sh https://sudare.example.com
```

A server is invitation-only unless its operator turns open sign-up on.
[docs/DEPLOY.md](docs/DEPLOY.md) has the settings and the operations.

## Develop

```bash
pnpm install
```

```bash
pnpm test
```

With the quickstart server running, the browser tests (they need `playwright` resolvable,
and the `ADMIN_SECRET` from `packages/server/.dev.vars` unless sign-up is open):

```bash
pnpm e2e
```

| Path | What |
| --- | --- |
| `packages/protocol` | The pure core: event types, the room state machine (`decide` / `apply`), the inbox state machine. No I/O. Property-tested. |
| `packages/server` | The Worker: `ConversationDO`, `PrincipalDO`, the D1 directory, passkeys, OAuth 2.1 for agents, the human HTTP API, the agent MCP tools, Web Push. |
| `packages/web` | The web app (a PWA): rooms, what is waiting for you, drafts, discussions, notes, devices. |
| `plugins/claude-code` | The Claude Code plugin: a line above the prompt, a side panel, approvals in place, `/sudare`, the discussion sub-agent. |
| `spec/Sudare.tla` | The TLA+ model of the gate. |
| `e2e` | Browser tests with virtual passkeys. |

## Design notes

- **Delivery uses a per-member cursor** in the room's Durable Object, not an outbox row
  per (event, member): the same at-least-once guarantee for about one row write per member
  per batch.
- **The plugin's human session is issued by hash adoption.** The plugin generates a
  secret and sends only its SHA-256 through its agent connection; a passkey ceremony in
  the browser turns that hash into a session. No session token ever travels over the wire,
  and an agent that learns the hash has learned nothing it can use.
- **Whether an agent may sit in discussions is a per-device permission** the person grants
  on the consent page, not a property of the OAuth client: Claude Code registers its own
  client, so its id is not ours to recognise.
- **A room with nobody left archives itself**; a member cannot read what was said before
  they joined, agreed notes excepted.
- **Not built yet**: the device-code OAuth flow (a pasted token covers headless agents),
  plugins for other agent hosts, deleting a single note, a native mobile shell.

## The name

A *sudare* (簾) is the bamboo blind that hangs in Japanese doorways and windows in summer.
It lets the air through and keeps the room behind it private: from outside you can tell
someone is there, and not much more.

At the Heian court, a thousand years ago, the finer version of it was how people of rank
received visitors. They sat behind the blind and were not seen; an attendant sat in front
and carried the words. In China, a regent who ruled this way was said to "govern from
behind the curtain" (垂簾聴政).

That is the arrangement here, with one correction. The attendant in front of the blind is
your agent, and it speaks well, but it says nothing the person behind the blind has not
approved.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately:
[SECURITY.md](SECURITY.md).

---

<sub>License: the plugin is [MIT](plugins/claude-code/LICENSE); the rest is [FSL-1.1-MIT](LICENSE.md).</sub>
