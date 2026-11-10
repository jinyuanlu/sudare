# Sudare for Claude Code

Message people from behind your agent. This plugin is the Claude Code client for a
self-hosted [Sudare](../../README.md) server: it shows what is waiting for you above the
prompt, lets you reply, hand a message to your agent, and approve what the agent drafted,
without leaving the terminal.

It is a thin client. Every rule (who may read what, that an agent can only draft, round
budgets) is enforced by the server.

## Before you install

You need a Sudare account first. Someone already using Sudare sends you an invitation
link; open it in a browser, create a passkey and pick a name. There is no other sign-up.

## Install

```
/plugin install sudare --marketplace jinyuanlu/sudare
```

A **Sudare** line appears above your prompt and walks you through two steps:

1. **Connect your agent.** Type `/mcp`, choose `sudare`, press **Authenticate**. Your
   browser opens; press **Allow**. This lets your agent read what you ask it to read and
   write drafts. It cannot send anything.
2. **Sign in.** The Sudare line now offers **this session** or **7 days on this computer**.
   Pick one; your browser asks for your passkey. This lets *you* read, send and approve
   from Claude Code.

The line shows only the step you are on, and moves to the next by itself.

The server defaults to the public instance, `https://sudare.luke.archi`. If you host your
own, set **Sudare server** in `/config`.

To try it from a clone without installing, against a local server
(`sh scripts/quickstart.sh` in the repository root):

```bash
claude --plugin-dir plugins/claude-code
```

Then `/config` → plugin `sudare` → **Sudare server** = `http://localhost:8787`, and `/mcp` →
`plugin:sudare:sudare` → Authenticate.

### If the band does not appear

The band, the panel and `/sudare` are drawn by a hooks module, a Claude Code feature that
is still rolling out. Where it is not enabled yet, the plugin still gives your agent the
Sudare tools and the round sub-agent; you read, hand off and approve in the web app
instead. `claude --debug` says `hooks module sudare… loaded` when it is on.

## Use

| You do | What happens |
| --- | --- |
| **Open Sudare** on the band, or `/sudare panel` | The panel: your rooms, the messages of the one you pick, and a box to write in. |
| **To** row in the panel | `everyone`, or one person. `●` means they are here now. A message for one person is still readable by the others; it also lands in that person's inbox. `private chat` opens a separate room with just the two of you. |
| `/sudare` | Lists your rooms. `/sudare <topic prefix>` picks one and prints its recent messages. |
| `@fox see you at 3` + Enter | Sends to `@fox` in the current room (or your private chat with them). |
| **Reply** | Puts `@name ` in your prompt; type and press Enter to send as yourself. |
| **Ask Claude** | Hands the message to your agent, which drafts a reply. Until that turn ends the agent can only read, search and draft. |
| **Send** / **Edit** / discard | What to do with the reply Claude wrote. Nothing is sent until you press Send. |
| **Join** / decline | Answers an invitation. |
| **Let Claude join** | Seats a tool-restricted sub-agent in a discussion you joined. |
| `/sudare new <topic> @a @b` | New room with people you have met. |
| `/sudare invite @a` | Invites someone into the current room. |
| `/sudare join <link>` | Opens an invitation link in the browser. |
| `/sudare panel` / `web` / `signout` | The side panel, the web app, drop the human session. |

## What is stored where

- The **agent token** is held by Claude Code's own MCP client (your OS keychain). An agent
  token can read what you handed off and write drafts. It cannot send or approve.
- The **human session** is a random secret this plugin generates and keeps in process
  memory only: not on disk, not in an environment variable. Reloading the plugin or
  restarting Claude Code forgets it. Set **In-plugin human session** to `off` to never
  hold one; approvals then happen in the web app.

A local attacker who can read this process's memory can still take the session. If that
matters to you, turn it off.

**7 days on this computer** (the second sign-in button; the
**Remember sign-in on this machine** setting forces it on) keeps the human session in the
plugin's storage for 7 days, so you do not sign in after every restart. The confirmation
page says so before you agree. The cost is the protection above: anything running as you on
that machine, a tricked agent included, can then read the stored session and send and
approve as you. Leave it off on a machine where the agent reads untrusted content.
`/sudare signout` removes the stored session.

## Privacy

The plugin talks only to the Sudare server you configure. Nothing is sent anywhere else.

## Develop

```
claude --plugin-dir plugins/claude-code
claude plugin validate plugins/claude-code
claude plugin test plugins/claude-code
```
