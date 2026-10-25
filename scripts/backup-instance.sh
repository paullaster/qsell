#!/usr/bin/env bash
# Back up one qsell installation: logical Postgres dump + local media volume.
# Run from cron/systemd as the deploy user:
#   scripts/backup-instance.sh /opt/qsell/instances/new-shop
# Env: BACKUP_DIR (default $DEPLOY_PATH/backups), BACKUP_KEEP_DAYS (default 14),
#      BACKUP_REMOTE (optional rsync/ssh target, e.g. user@backup-host:/srv/qsell/new-shop/)
set -Eeuo pipefail
umask 077

DEPLOY_PATH="${1:?Usage: $0 <deploy-path>}"
cd "$DEPLOY_PATH"
test -s .env.deploy || { echo "No .env.deploy in $DEPLOY_PATH" >&2; exit 1; }

BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_PATH/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
project=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' .env.deploy | tail -n 1)
compose() { docker compose --env-file .env.deploy -f compose.production.yaml "$@"; }
install -d -m 700 "$BACKUP_DIR"

db_file="$BACKUP_DIR/${project}-db-${stamp}.sql.gz"
compose exec -T db pg_dump -U qsell -d qsell --no-owner | gzip > "$db_file.partial"
gzip -t "$db_file.partial"
mv "$db_file.partial" "$db_file"

media_file="$BACKUP_DIR/${project}-media-${stamp}.tar.gz"
docker run --rm -v "${project}_media_data:/media:ro" -v "$BACKUP_DIR":/backup alpine \
  tar czf "/backup/$(basename "$media_file")" -C /media .

# The bundled object store (compose profile `storage`), when this instance uses it. This copies the
# files as they are on disk, so run it when uploads are quiet, or stop the rustfs service first.
store_file=""
if docker volume inspect "${project}_rustfs_data" >/dev/null 2>&1; then
  store_file="$BACKUP_DIR/${project}-objects-${stamp}.tar.gz"
  docker run --rm -v "${project}_rustfs_data:/objects:ro" -v "$BACKUP_DIR":/backup alpine \
    tar czf "/backup/$(basename "$store_file")" -C /objects .
fi

find "$BACKUP_DIR" -maxdepth 1 -type f \( -name "${project}-db-*" -o -name "${project}-media-*" -o -name "${project}-objects-*" \) \
  -mtime "+${KEEP_DAYS}" -delete

if [[ -n "${BACKUP_REMOTE:-}" ]]; then
  rsync -a --chmod=F600 "$db_file" "$media_file" ${store_file:+"$store_file"} "$BACKUP_REMOTE"
else
  echo "WARNING: BACKUP_REMOTE not set; backups exist only on this host." >&2
fi
echo "Backup complete: $db_file, $media_file${store_file:+, $store_file}"
