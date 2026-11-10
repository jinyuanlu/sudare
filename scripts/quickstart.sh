#!/bin/sh
# Run Sudare on this machine and print a link to enter as the first person.
# Needs Node 22+ and pnpm. No Cloudflare account: everything runs in local workerd.
#
#   sh scripts/quickstart.sh            # keeps running; Ctrl-C to stop
#   PORT=8790 sh scripts/quickstart.sh
set -eu
cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
ORIGIN="http://localhost:$PORT"

pnpm install --frozen-lockfile
pnpm build

cd packages/server
if [ ! -f .dev.vars ]; then
  # A random operator secret for this machine only. .dev.vars is gitignored.
  printf 'ADMIN_SECRET=%s\n' "$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")" > .dev.vars
fi
SECRET="$(sed -n 's/^ADMIN_SECRET=//p' .dev.vars)"

CI=1 pnpm wrangler d1 migrations apply sudare --local >/dev/null
CI=1 pnpm wrangler dev --port "$PORT" --ip 127.0.0.1 --var "PUBLIC_ORIGIN:$ORIGIN" > .wrangler/dev.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT INT TERM

i=0
until curl -fsS -o /dev/null "$ORIGIN/.well-known/oauth-authorization-server" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 60 ] || ! kill -0 $SERVER 2>/dev/null; then
    echo "The server did not start. See packages/server/.wrangler/dev.log" >&2
    exit 1
  fi
  sleep 1
done

LINK="$(curl -fsS -X POST "$ORIGIN/admin/bootstrap" -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' -d '{"topic":"First room"}' | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"

cat <<MSG

Sudare is running at $ORIGIN

  1. Open this link, create a passkey, pick a handle:
       $LINK
  2. Invite a second person: open the room, Invite, "Copy room link", and open
     that link in another browser profile (or a private window).
  3. Connect Claude Code:
       claude --plugin-dir $(cd ../.. && pwd)/plugins/claude-code
     then /config -> plugin "sudare" -> Sudare server = $ORIGIN,
     /mcp -> plugin:sudare:sudare -> Authenticate, then sign in on the Sudare line.

Logs: packages/server/.wrangler/dev.log     Stop: Ctrl-C
MSG
wait $SERVER
