#!/bin/sh
# Deploy Sudare to your Cloudflare account, first time or again.
#
#   pnpm wrangler login                      # once
#   sh scripts/deploy.sh https://sudare.example.com
#
# First run: creates the D1 database and KV namespace, writes the gitignored
# packages/server/wrangler.deploy.jsonc, sets a random ADMIN_SECRET, migrates,
# deploys, and prints the first invitation link. Later runs: migrate and deploy.
# Attach the custom domain to the Worker yourself (dashboard, or a "routes"
# entry in wrangler.deploy.jsonc) so that it serves the origin you passed.
set -eu
cd "$(dirname "$0")/../packages/server"
CONFIG=wrangler.deploy.jsonc
W="pnpm wrangler"

first_id() { grep -oE "$1" | head -n 1; }

if [ ! -f "$CONFIG" ]; then
  ORIGIN="${1:?usage: sh scripts/deploy.sh https://your.domain}"
  case "$ORIGIN" in https://*) ;; *) echo "The origin must start with https://" >&2; exit 1 ;; esac

  echo "Creating the D1 database and the KV namespace..."
  D1_OUT="$($W d1 create sudare 2>&1)" || { echo "$D1_OUT" >&2; exit 1; }
  D1_ID="$(printf '%s' "$D1_OUT" | first_id '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')"
  KV_OUT="$($W kv namespace create OAUTH_KV 2>&1)" || { echo "$KV_OUT" >&2; exit 1; }
  KV_ID="$(printf '%s' "$KV_OUT" | first_id '[0-9a-f]{32}')"
  if [ -z "$D1_ID" ] || [ -z "$KV_ID" ]; then
    printf 'Could not read the new ids from wrangler. Its output was:\n%s\n%s\n' "$D1_OUT" "$KV_OUT" >&2
    echo "Copy wrangler.jsonc to $CONFIG, fill in the ids and PUBLIC_ORIGIN by hand, and run this again." >&2
    exit 1
  fi
  sed -e "s|REPLACE_WITH_D1_ID|$D1_ID|" -e "s|REPLACE_WITH_KV_ID|$KV_ID|" \
      -e "s|\"PUBLIC_ORIGIN\": \"[^\"]*\"|\"PUBLIC_ORIGIN\": \"${ORIGIN%/}\"|" wrangler.jsonc > "$CONFIG"

  SECRET="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
  printf '%s' "$SECRET" | $W secret put ADMIN_SECRET --config "$CONFIG"
  FIRST=1
fi

ORIGIN="$(sed -n 's/.*"PUBLIC_ORIGIN": "\([^"]*\)".*/\1/p' "$CONFIG" | head -n 1)"
(cd ../.. && pnpm install --frozen-lockfile && pnpm build)
$W d1 migrations apply sudare --remote --config "$CONFIG"
$W deploy --config "$CONFIG"

if [ "${FIRST:-0}" = 1 ]; then
  cat <<MSG

Deployed. Two things only you can do:

  1. Attach ${ORIGIN#https://} to the Worker "sudare" as a custom domain
     (Cloudflare dashboard -> Workers -> sudare -> Settings -> Domains & Routes).
  2. Then create the first invitation link. This is the operator secret; store it
     somewhere safe, it is shown only now:

       ADMIN_SECRET=$SECRET

       curl -sS -X POST "$ORIGIN/admin/bootstrap" -H "Authorization: Bearer $SECRET" \\
         -H 'Content-Type: application/json' -d '{"topic":"Hello"}'
MSG
else
  echo "Deployed to $ORIGIN"
fi
