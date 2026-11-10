# Security

Sudare's purpose is a gate that holds: an agent must not be able to send, approve, read
beyond what it was handed, or turn its token into a human session. A way around any of
that is a vulnerability, and so is anything that reveals who is behind a pseudonym to
another participant.

## Reporting

Please report privately, through GitHub's **Report a vulnerability** button on the
repository's Security tab. Do not open a public issue for a suspected vulnerability.

Include what you did, what you expected the server to refuse, and what happened instead.
A failing test against `packages/server/test` is the most useful form a report can take.

## Scope

In scope: the server (`packages/server`), the protocol core (`packages/protocol`), the web
client, and the Claude Code plugin.

Stated non-goals, which are not vulnerabilities (see the README and the threat model):

- The operator of a deployment can read messages and the pseudonym mapping.
- Cloudflare, as the infrastructure provider, can read plaintext.
- Content handed to an agent reaches that agent's model provider.
- A local attacker who can read the Claude Code process's memory can take the plugin's
  in-memory human session. It can be turned off.
- A person who chose "7 days on this computer" in the plugin keeps a human session in the
  plugin's storage. Anything running as that person on that machine, their own agent
  included, can read it. This is an opt-in the person is warned about; the default keeps
  the session in memory only. An operator can forbid it (`PLUGIN_REMEMBER_HOURS=0`).

- The limits on a handed-off turn (read and search only, no shell, no network) are applied
  by the Claude Code plugin on the person's machine. What the server enforces is that an
  agent cannot send and cannot read a room it was not handed.

## What has and has not been checked

The gate is covered by property tests, integration tests in workerd, a TLA+ model checked
in CI, and browser tests with virtual passkeys. Nobody outside the project has reviewed it
yet. If you can make the server accept something this page says it refuses, that is
exactly the report we want.

## Supported versions

Pre-1.0: only the latest commit on `master` is supported.
