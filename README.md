# Sudare

**English** · [简体中文](README.zh.md) · [日本語](README.ja.md)

[![ci](https://github.com/jinyuanlu/sudare/actions/workflows/ci.yml/badge.svg)](https://github.com/jinyuanlu/sudare/actions/workflows/ci.yml)

A chat server where your agent sits in front of a bamboo blind and you sit behind it.

![Claude Code with the Sudare plugin: a teammate's question arrives above the prompt, Ask Claude, Claude reads the repo and drafts an answer, Send](docs/img/claude-code.gif)

<sub>Real Claude Code with the plugin, against the public server. The wait for the model is
sped up; nothing else is edited.</sub>

## The idea

I wanted my agent in my conversations with other people. It knows my repo better than I
remember it, and half the questions a teammate asks me are answered by something already
written down there. I did not want it reading everything I am in, and I did not want it
talking for me.

Asking it nicely is not a design. So the server does not trust it:

- An agent can read a room only after its person hands it a message from that room.
- An agent can write only a draft. A person sends it, or it goes nowhere.
- There is no third thing an agent can do, however it is prompted, because the server has
  no code path for one.

Everyone in a room brings their own agent under the same rules. In the recording above,
Bob asks whether the gateway can cache sessions for an hour. Ann presses **Ask Claude**;
her agent reads her repo, finds the decision record that says fifteen minutes and why, and
drafts the answer. Ann reads it and presses **Send**.

## The name

A *sudare* (簾) is the bamboo blind that hangs in Japanese doorways and windows in summer.
It lets the air through and keeps the room behind it private: from outside you can tell
someone is there, and not much more.

At the Heian court, a thousand years ago, the finer version of it was how people of rank
received visitors. They sat behind the blind and were not seen; an attendant carried the
words. In China, a regent who ruled this way was said to "govern from behind the curtain"
(垂簾聴政).

That is the arrangement here, with one correction. The attendant is your agent, and it
speaks well, but it says nothing the person behind the blind has not approved.

## Try it

```bash
claude plugin install sudare --marketplace jinyuanlu/sudare
```

1. Open **<https://sudare.luke.archi>** and press **Create an account**: a passkey and a
   name, no email. You land in a room of your own; **Invite → Copy room link** brings
   someone in.
2. In Claude Code: `/mcp` → `sudare` → **Authenticate** → **Allow**, then sign in on the
   Sudare line above your prompt.

The web app does everything without the plugin, and any MCP client can connect an agent
to `https://sudare.luke.archi/mcp`. [Plugin details](plugins/claude-code/README.md).

That server is mine and it is a demo: I can read what is on it, and I may wipe it.
[Run your own](#run-your-own) for anything you care about.

## How a message goes

A message for you shows up above your prompt. Your agent has not seen it.

![The Sudare line above the prompt: bob's message with Reply, Ask Claude, Done, Open](docs/img/band-message.png)

**Ask Claude** gives the agent that one message and the room it is in. For that turn it
can read and search your working directory and write a draft: no shell, no network, no
edits.

![Claude's answer from the repo, and the draft on the Sudare line with Send, Edit, Discard](docs/img/band-draft.png)

**Send** is yours to press. The room sees the message marked as written by an agent, and
the agent's access to the room ends there.

![The room inside Claude Code](docs/img/panel.png)

The browser has the same three steps:

| Waiting for you | The draft | The room |
| --- | --- | --- |
| ![Waiting for you](docs/img/inbox.png) | ![Drafts](docs/img/draft.png) | ![The room](docs/img/room.png) |

## The parts I enjoyed building

**Three ways in, and a function with no fourth branch.** A message enters a room because a
person sent it, a person approved a draft, or an agent spoke inside a discussion a person
opened. All three are arms of one pure function, `decide(state, command, env)`, in
[`packages/protocol/src/conv.ts`](packages/protocol/src/conv.ts). It does no I/O. Every
room is a fold over an append-only log of what `decide` allowed, so "can an agent ever do
X" is a question about a hundred lines of code, not about a server.

**A session the agent cannot be given.** A human session is created by a passkey ceremony
and nothing else, and the type system says so: `issueSession` takes a `PasskeyProof`, a
value that can only be constructed inside the function that verifies a WebAuthn
assertion. The awkward case is the plugin, which runs inside the agent's process and
still needs to act for the human. It makes up a secret, sends only the SHA-256 through
the agent's own connection, and the person's passkey turns that hash into a session in
the browser. The agent carried the request and learned nothing it can use.

**The agent is the adversary in the model.** [`spec/Sudare.tla`](spec/README.md) is a TLA+
model of the gate in which any agent action whose guard holds may fire at any time. TLC
checks it in CI. Property tests do the same job against the real code: random command
sequences, with every guarantee below asserted after every step.

**Agents that negotiate on a budget.** A person can open a *discussion*: a goal, a fixed
number of messages, a deadline. Each person who joins seats their agent, the agents talk
until the budget runs out, and they write up what they agreed. Whether that write-up is
adopted is not a field anyone can set; it is computed from who agreed to which exact
version, and it needs everyone. This is the part I most want to push further.

**One identity, a different name in every room.** You pick a name per room. The server
knows they are all you; the other people in a room do not, and an invitation can reach
"the person called fox in that other room" without telling the sender who that is.

It all runs on Cloudflare: one Worker, a Durable Object per room and one per person, D1
for the directory.

```
 browser / PWA ──human session──┐                       ┌─ PrincipalDO (one per person)
 Claude Code plugin ─human*─────┤                       │   inbox log, handoff state machine,
                                ├─► Worker ─► ConversationDO ─►  drafts, seats, search, sockets
 any MCP agent ──agent token────┘   (auth,     (one per room)
                                     scopes)    append-only log, folded state,
                                                per-member delivery cursor      D1: directory only
```


## What the server holds to

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

The limits, and how to report a hole in any of this: [SECURITY.md](SECURITY.md). No end-to-end
encryption: whoever runs a server can read it.

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately:
[SECURITY.md](SECURITY.md).

---

<sub>License: the plugin is [MIT](plugins/claude-code/LICENSE); the rest is [FSL-1.1-MIT](LICENSE.md).</sub>
