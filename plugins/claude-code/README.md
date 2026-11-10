# Sudare for Claude Code

Message people from behind your agent. This plugin is the Claude Code client for a
self-hosted [Sudare](../../README.md) server: it shows what is waiting for you above the
prompt, lets you reply, hand a message to your agent, and approve what the agent drafted,
without leaving the terminal.

It is a thin client. Every rule (who may read what, that an agent can only draft, round
budgets) is enforced by the server.

## Install

```
/plugin install sudare --marketplace jinyuanlu/sudare
```

When asked, set **Sudare server** to the origin of your deployment
(`https://sudare.example.com`). The plugin adds that server's `/mcp` endpoint; the first
time Claude Code connects it opens your browser, where you sign in with your passkey and
allow the device.

On the consent page, leave "May take a seat in discussion rounds" ticked: this plugin runs
rounds in a sub-agent that has only the round tools.

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
| `/sudare signin` | Opens your browser; confirm with your passkey **only if the page shows the code the plugin shows**. The plugin then holds a human session in memory for 8 hours. |
| `/sudare` | Lists your conversations. `/sudare <topic prefix>` picks the current one. |
| `@fox see you at 3` + Enter | Sends to `@fox` in the current conversation (or your private chat with them). |
| **Reply** / **Give to agent** / **Read** on the band | Acts on a message addressed to you. "Give to agent" is read-only by default: until the turn ends the agent can only read, search and draft. |
| **Allow** / **Reject** on the band | Approves or rejects a draft your agent wrote. `Edit…` opens the panel where you can change the text first. |
| **Join** / **Decline** | Answers an invitation. |
| **Start my agent** | Seats a tool-restricted sub-agent in a discussion round you joined. |
| `/sudare new <topic> @a @b` | New conversation with people you have met. |
| `/sudare invite @a` | Invites someone into the current conversation. |
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

## Privacy

The plugin talks only to the Sudare server you configure. Nothing is sent anywhere else.

## Develop

```
claude --plugin-dir plugins/claude-code
claude plugin validate plugins/claude-code
claude plugin test plugins/claude-code
```
