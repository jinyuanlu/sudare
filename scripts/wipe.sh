#!/bin/sh
# Erase everything on a Sudare server: every room, inbox, account and agent grant.
# For a demo server between showings. There is no undo.
#
#   ADMIN_SECRET=... sh scripts/wipe.sh https://sudare.example.com
set -eu
ORIGIN="${1:?usage: ADMIN_SECRET=... sh scripts/wipe.sh https://your.domain}"
: "${ADMIN_SECRET:?set ADMIN_SECRET}"
if [ "${CI:-}" != 1 ]; then
  printf 'This erases every room and account on %s. Type the host name to go on: ' "$ORIGIN"
  read -r ANSWER
  HOST="${ORIGIN#*://}"; HOST="${HOST%%/*}"
  [ "$ANSWER" = "$HOST" ] || { echo "Not erased." >&2; exit 1; }
fi
i=0
while :; do
  OUT="$(curl -fsS -X POST "${ORIGIN%/}/admin/wipe" -H "Authorization: Bearer $ADMIN_SECRET" \
    -H 'Content-Type: application/json' -d '{"confirm":"erase everything"}')"
  case "$OUT" in *'"left":0'*) echo "Erased."; exit 0 ;; esac
  i=$((i + 1))
  [ "$i" -lt 2000 ] || { echo "Still not empty after $i batches: $OUT" >&2; exit 1; }
done
