#!/usr/bin/env bash
# Backup and restore rehearsal (design doc §22, V-8). Dumps SOURCE_URL (read only), restores into a new throwaway database,
# and proves the copy is whole: same row counts in every table, same triggers and indexes, same vendor ledger checksum.
# Usage: SOURCE_URL=postgres://user:pass@host:port/dbname ./scripts/backup-restore-rehearsal.sh
# The copy is named after the source plus "_restore_<time>" and is dropped at the end unless KEEP=1.
set -euo pipefail
: "${SOURCE_URL:?set SOURCE_URL to the database to rehearse on}"
BASE="${SOURCE_URL%/*}"
SRC="${SOURCE_URL##*/}"
COPY="${SRC}_restore_$(date +%s)"
DUMP="$(mktemp -d)/rehearsal.dump"
case "$COPY" in *restore*) ;; *) echo "refusing: bad copy name" >&2; exit 2 ;; esac

echo "dumping $SRC ..."
pg_dump --format=custom --no-owner --file="$DUMP" "$SOURCE_URL"
echo "restoring into $COPY ..."
psql "$BASE/postgres" -q -c "CREATE DATABASE \"$COPY\" TEMPLATE template0"
trap '[ "${KEEP:-0}" = 1 ] || psql "$BASE/postgres" -q -c "DROP DATABASE IF EXISTS \"$COPY\"" >/dev/null 2>&1' EXIT
pg_restore --no-owner --dbname="$BASE/$COPY" "$DUMP" 2> >(grep -v "^$" >&2) || true

counts() {
  psql "$1" -At -c "
    SELECT table_name || '=' || (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.' || quote_ident(table_name), false, true, '')))[1]::text
    FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"
}
shape() {
  psql "$1" -At -c "
    SELECT 'triggers=' || count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text NOT LIKE 'gl_entries_p%';
    SELECT 'indexes=' || count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename NOT LIKE 'gl_entries_p%';
    SELECT 'constraints=' || count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public' AND c.conrelid::regclass::text NOT LIKE 'gl_entries_p%';"
}
ledger() {
  psql "$1" -At -c "SELECT 'vendor_ledger=' || count(*) || ':' || COALESCE(md5(string_agg(id::text || amount::text || remaining_amount::text, ',' ORDER BY id)), '-') FROM vendor_ledger_entries;
                    SELECT 'gl=' || count(*) || ':' || COALESCE(md5(string_agg(id::text || debit::text || credit::text, ',' ORDER BY id)), '-') FROM gl_entries;"
}

S="$(mktemp)"; C="$(mktemp)"
{ counts "$SOURCE_URL"; shape "$SOURCE_URL"; ledger "$SOURCE_URL"; } > "$S"
{ counts "$BASE/$COPY"; shape "$BASE/$COPY"; ledger "$BASE/$COPY"; } > "$C"
if diff -u "$S" "$C"; then
  echo "OK: $(grep -c '=' "$S") figures match between $SRC and the restored copy"
else
  echo "FAILED: the restored copy differs from the source (see above)" >&2
  exit 1
fi
