# Deploying Sudare

One Worker, two Durable Object classes, one D1 database, one KV namespace. Workers Paid
is assumed (the free tier's daily Durable Object write limit is too tight; see the
architecture spec, section 9).

## The short way

```bash
pnpm wrangler login
```

```bash
sh scripts/deploy.sh https://sudare.example.com
```

The script does sections 1 to 3 below (resources, private config, operator secret,
migration, deploy), binds the host as a custom domain (its zone must be on the same
Cloudflare account), and prints how to create the first invitation link. Run it again without arguments to redeploy. The sections below
are the same thing by hand.

## 1. Create the resources

```bash
cd packages/server
```

```bash
pnpm wrangler d1 create sudare
```

```bash
pnpm wrangler kv namespace create OAUTH_KV
```

This repository is public, so keep your real deployment values out of the tracked
`wrangler.jsonc`. Work on a private copy, which is gitignored:

```bash
cp wrangler.jsonc wrangler.deploy.jsonc
```

```bash
export SUDARE_CONFIG=wrangler.deploy.jsonc
```

Put the two ids into `wrangler.deploy.jsonc` (`d1_databases[0].database_id`,
`kv_namespaces[0].id`). The `deploy` and `migrate` scripts read `SUDARE_CONFIG`; pass
`--config wrangler.deploy.jsonc` to any other `wrangler` command you run by hand.

## 2. Configure

In `wrangler.deploy.jsonc` → `vars`:

| Variable | Meaning |
| --- | --- |
| `PUBLIC_ORIGIN` | The one origin people use, e.g. `https://sudare.example.com`. Passkeys are bound to its hostname: **changing it later invalidates every passkey.** Use a custom domain, not `workers.dev`. |
| `ALLOWED_REDIRECT_ORIGINS` | Extra `https` origins an OAuth client may redirect to. Empty means loopback only, which is what local agents (Claude Code) use and what defeats consent-link phishing. Add an origin only for a hosted agent you trust. |
| `ROUND_CLIENT_IDS` | OAuth client ids whose "may take round seats" box is pre-ticked on the consent page. The person can always tick or untick it per device. |
| `PLUGIN_HUMAN_SESSION` | `on` (default) or `off`. `off` removes the in-plugin human session server-wide: every approval then happens in the web app. |
| `WEB_SESSION_HOURS` / `PLUGIN_SESSION_HOURS` | Lifetime of a browser session (default 168) and of a plugin-held session (default 8). |
| `PLUGIN_REMEMBER_HOURS` | How long a plugin session lasts when the person chose "7 days on this computer" (default 168). `0` forbids keeping one. See the trade-off in `plugins/claude-code/README.md`. |
| `OPEN_SIGNUP` | `off` (default): people come in only through invitations. `on`: the sign-in page has **Create an account**, and anyone gets an account and a room of their own. For a public demo. |
| `SIGNUP_DAILY_LIMIT` | With open sign-up, the most accounts created in any 24 hours (default 500). |
| `SITE_NOTICE` | One line shown on the sign-in pages and under the room list, e.g. `Demo server. Data may be wiped.` |
| `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` | Web Push. Optional; without them the app works but does not notify when closed. |

Secrets:

```bash
pnpm wrangler secret put ADMIN_SECRET --config wrangler.deploy.jsonc
```

Use at least 24 random characters. It does three things only: creates the first invitation
link, exports logs, and erases the server (`scripts/wipe.sh`).

For Web Push, generate a key pair, put the public key in `vars`, and store the private one:

```bash
pnpm gen:vapid
```

```bash
pnpm wrangler secret put VAPID_PRIVATE_KEY --config wrangler.deploy.jsonc
```

## 3. Migrate and deploy

```bash
pnpm migrate
```

```bash
pnpm -w run deploy
```

`pnpm -w run deploy` builds the web app into `packages/server/public` and deploys the Worker
with it. Then attach your custom domain to the Worker in the Cloudflare dashboard (or add
a `routes` entry) so that it matches `PUBLIC_ORIGIN`.

## 4. Let the first person in

Unless `OPEN_SIGNUP` is `on`, there is no sign-up page. The first person enters through a
bootstrap invitation:

```bash
curl -sS -X POST "$PUBLIC_ORIGIN/admin/bootstrap" -H "Authorization: Bearer $ADMIN_SECRET" -H 'Content-Type: application/json' -d '{"topic":"Hello"}'
```

Open the returned URL, create a passkey, pick a handle. From then on, people come in
through invitation links created by members.

Losing every passkey of an account loses the account; there is no recovery by email
because no email is collected. Add a second passkey from Settings on another device.

## 5. Connect an agent

- **Claude Code**: install the plugin (`/plugin install sudare --marketplace jinyuanlu/sudare`)
  and set its server to `PUBLIC_ORIGIN`. See `plugins/claude-code/README.md`.
- **Any MCP agent**: add `PUBLIC_ORIGIN/mcp` as a streamable-HTTP MCP server. It will
  discover the authorization server and open a browser for consent.
- **Headless agents**: Settings → Devices → "Generate a token", and configure the agent to
  send it as `Authorization: Bearer …` to `PUBLIC_ORIGIN/mcp`.

## Operating

- **Logs and metrics**: Workers observability is enabled in `wrangler.jsonc`.
- **Housekeeping** runs daily from the cron trigger (expired challenges, sessions, devices,
  orphaned OAuth records). Message retention and round deadlines are Durable Object alarms.
- **Rate limits** (`ratelimits` in `wrangler.jsonc`): 30/min per address on unauthenticated
  endpoints, 240/min per person on writes.
- **Export / exit**: the logs are the only source of truth.

  ```bash
  curl -sS "$PUBLIC_ORIGIN/admin/export/conv/<conv id>?after=0" -H "Authorization: Bearer $ADMIN_SECRET"
  ```

  NDJSON, in `seq` order, 1000 events per page; the `X-Next` response header is the next
  `after`. `/admin/export/principal/<principal id>` does the same for an inbox log and
  `/admin/export/directory` for the directory tables. Folding the conversation logs with
  `fold` from `@sudare/protocol` reproduces all state.
- **Erase everything** (a demo server between showings; there is no undo):

  ```bash
  ADMIN_SECRET=... sh scripts/wipe.sh "$PUBLIC_ORIGIN"
  ```

- **Changing a var later**: `scripts/deploy.sh` writes `wrangler.deploy.jsonc` once and
  never overwrites it. Edit `vars` there and run the script again.
- **What the operator can see**: everything. Message text and the alias→person mapping
  are stored in plaintext server-side. That is the stated trust model, not an accident.

## Local development

```bash
pnpm install
```

```bash
cp packages/server/.dev.vars.example packages/server/.dev.vars
```

```bash
pnpm --filter @sudare/server migrate:local
```

```bash
pnpm dev
```

The app is at `http://localhost:8787` (passkeys work on `localhost`). Bootstrap with the
`curl` above against that origin and the secret from `.dev.vars`.
