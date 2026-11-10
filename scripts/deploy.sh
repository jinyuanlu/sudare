#!/bin/sh
# Deploy Sudare to your Cloudflare account, first time or again.
#
#   pnpm wrangler login                      # once
#   sh scripts/deploy.sh https://sudare.example.com
#
# First run: creates the D1 database and KV namespace, writes the gitignored
# packages/server/wrangler.deploy.jsonc, sets a random ADMIN_SECRET, migrates,
# deploys, and prints the first invitation link. Later runs: migrate and deploy.
# The origin's host is bound to the Worker as a custom domain; its zone must be
# on the same Cloudflare account.
set -eu
cd "$(dirname "$0")/../packages/server"
CONFIG=wrangler.deploy.jsonc
W="pnpm wrangler"

first_id() { grep -oE "$1" | head -n 1; }

if [ ! -f "$CONFIG" ]; then
  ORIGIN="${1:?usage: sh scripts/deploy.sh https://your.domain}"
  case "$ORIGIN" in https://*) ;; *) echo "The origin must start with https://" >&2; exit 1 ;; esac

  HOST="${ORIGIN#https://}"; HOST="${HOST%%/*}"

  # Reuse what an earlier, interrupted run already created.
  pick() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const x=JSON.parse(s).find(o=>(o.name??o.title)===process.argv[1]);console.log(x?(x.uuid??x.id):'')}catch{console.log('')}})" "$1"; }

  echo "Finding or creating the D1 database..."
  D1_ID="$($W d1 list --json 2>/dev/null | pick sudare)"
  if [ -z "$D1_ID" ]; then
    D1_OUT="$($W d1 create sudare 2>&1)" || { echo "$D1_OUT" >&2; exit 1; }
    D1_ID="$(printf '%s' "$D1_OUT" | first_id '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')"
  fi

  echo "Finding or creating the KV namespace..."
  KV_LIST="$($W kv namespace list 2>&1)" || { echo "$KV_LIST" >&2; echo "The API token needs the account permission \"Workers KV Storage: Edit\"." >&2; exit 1; }
  KV_ID="$(printf '%s' "$KV_LIST" | pick OAUTH_KV)"
  if [ -z "$KV_ID" ]; then
    KV_OUT="$($W kv namespace create OAUTH_KV 2>&1)" || { echo "$KV_OUT" >&2; exit 1; }
    KV_ID="$(printf '%s' "$KV_OUT" | first_id '[0-9a-f]{32}')"
  fi
  if [ -z "$D1_ID" ] || [ -z "$KV_ID" ]; then
    echo "Could not read the resource ids from wrangler." >&2
    echo "Copy wrangler.jsonc to $CONFIG, fill in the ids and PUBLIC_ORIGIN by hand, and run this again." >&2
    exit 1
  fi
  sed -e "s|REPLACE_WITH_D1_ID|$D1_ID|" -e "s|REPLACE_WITH_KV_ID|$KV_ID|" \
      -e "s|\"PUBLIC_ORIGIN\": \"[^\"]*\"|\"PUBLIC_ORIGIN\": \"${ORIGIN%/}\"|" \
      -e "s|^  \"main\": \"src/index.ts\",|  \"main\": \"src/index.ts\",\n  \"routes\": [{ \"pattern\": \"$HOST\", \"custom_domain\": true }],|" wrangler.jsonc > "$CONFIG"

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

Deployed to $ORIGIN (bound as a custom domain; its zone must be on this Cloudflare
account, and the certificate can take a minute to issue).

Create the first invitation link. This is the operator secret; store it somewhere
safe, it is shown only now:

       ADMIN_SECRET=$SECRET

       curl -sS -X POST "$ORIGIN/admin/bootstrap" -H "Authorization: Bearer $SECRET" \\
         -H 'Content-Type: application/json' -d '{"topic":"Hello"}'
MSG
else
  echo "Deployed to $ORIGIN"
fi
