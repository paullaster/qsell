#!/usr/bin/env bash
# Migration rehearsal (design doc §22). Restores a dump of SOURCE_URL into a new throwaway database, applies every migration the
# code has that the source does not, and proves the data came through: every table that existed keeps its rows, the vendor ledger
# and the general ledger keep their checksums, and the vendor ledger still agrees with its detail.
# Usage: SOURCE_URL=postgres://user:pass@host:port/dbname ./scripts/migration-rehearsal.sh
# SOURCE_URL is only read (pg_dump). The copy is named after the source plus "_migrate_<time>" and is dropped unless KEEP=1.
set -euo pipefail
: "${SOURCE_URL:?set SOURCE_URL to the database to rehearse on}"
BASE="${SOURCE_URL%/*}"
SRC="${SOURCE_URL##*/}"
COPY="${SRC}_migrate_$(date +%s)"
DUMP="$(mktemp -d)/migration.dump"
case "$COPY" in *_migrate_*) ;; *) echo "refusing: bad copy name" >&2; exit 2 ;; esac

applied() { psql "$1" -At -c "SELECT count(*) FROM drizzle.__drizzle_migrations" 2>/dev/null || echo 0; }
echo "dumping $SRC (migrations applied: $(applied "$SOURCE_URL")) ..."
pg_dump --format=custom --no-owner --file="$DUMP" "$SOURCE_URL"
psql "$BASE/postgres" -q -c "CREATE DATABASE \"$COPY\" TEMPLATE template0"
trap '[ "${KEEP:-0}" = 1 ] || psql "$BASE/postgres" -q -c "DROP DATABASE IF EXISTS \"$COPY\"" >/dev/null 2>&1' EXIT
pg_restore --no-owner --dbname="$BASE/$COPY" "$DUMP" 2> >(grep -v "^$" >&2) || true

counts() {
  psql "$1" -At -c "
    SELECT table_name || '=' || (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.' || quote_ident(table_name), false, true, '')))[1]::text
    FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"
}
ledger() {
  psql "$1" -At -c "SELECT 'vendor_ledger=' || count(*) || ':' || COALESCE(md5(string_agg(id::text || amount::text || remaining_amount::text, ',' ORDER BY id)), '-') FROM vendor_ledger_entries;
                    SELECT 'gl=' || count(*) || ':' || COALESCE(md5(string_agg(id::text || debit::text || credit::text, ',' ORDER BY id)), '-') FROM gl_entries;"
}
# What the vendor ledger says is open on each entry must equal what its detailed entries add up to.
drift() {
  psql "$1" -At -c "SELECT count(*) FROM vendor_ledger_entries e WHERE e.remaining_amount <> COALESCE((SELECT sum(d.amount) FROM vendor_detailed_entries d WHERE d.ledger_entry_id = e.id), 0)"
}

B="$(mktemp)"; A="$(mktemp)"
{ counts "$BASE/$COPY"; ledger "$BASE/$COPY"; } > "$B"
BEFORE_DRIFT="$(drift "$BASE/$COPY")"
echo "applying migrations to the copy ..."
START=$(date +%s)
DATABASE_URL="$BASE/$COPY" pnpm exec drizzle-kit migrate
echo "migrated in $(( $(date +%s) - START )) s (migrations applied: $(applied "$BASE/$COPY"))"
{ counts "$BASE/$COPY"; ledger "$BASE/$COPY"; } > "$A"
AFTER_DRIFT="$(drift "$BASE/$COPY")"

# Rows that existed before must still be there (tables that did not exist are new and are listed, not compared).
FAILED=0
while IFS='=' read -r table rows; do
  case "$table" in vendor_ledger|gl) continue ;; esac
  now="$(grep "^${table}=" "$A" | cut -d= -f2)"
  if [ "$now" != "$rows" ]; then echo "DIFFERENT: $table had $rows rows, now $now" >&2; FAILED=1; fi
done < "$B"
for key in vendor_ledger gl; do
  if [ "$(grep "^${key}=" "$B")" != "$(grep "^${key}=" "$A")" ]; then echo "DIFFERENT: $key checksum changed" >&2; FAILED=1; fi
done
[ "$BEFORE_DRIFT" = "$AFTER_DRIFT" ] || { echo "DIFFERENT: vendor ledger drift $BEFORE_DRIFT -> $AFTER_DRIFT" >&2; FAILED=1; }
echo "new tables: $(diff <(cut -d= -f1 "$B" | sort) <(cut -d= -f1 "$A" | sort) | grep '^>' | cut -c3- | tr '\n' ' ')"
if [ "$FAILED" = 0 ]; then echo "OK: the migrations kept every row and both ledgers (vendor ledger drift $AFTER_DRIFT)"; else echo "FAILED: see above" >&2; exit 1; fi
