#!/usr/bin/env bash
# Restore a pg_dump custom-format backup into RESTORE_DATABASE_URL.
# Usage: RESTORE_DATABASE_URL=<url> ./scripts/restore-postgres.sh <backup-file.dump.gz>
set -euo pipefail

BACKUP_FILE="${1:-}"

if [[ -z "$BACKUP_FILE" ]]; then
  echo "Usage: RESTORE_DATABASE_URL=<url> $0 <backup-file.dump.gz>" >&2
  exit 1
fi

if [[ -z "${RESTORE_DATABASE_URL:-}" ]]; then
  echo "RESTORE_DATABASE_URL is not set." >&2
  exit 1
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "File not found: $BACKUP_FILE" >&2
  exit 1
fi

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

DUMP_FILE="${WORK_DIR}/restore.dump"

echo "Decompressing ${BACKUP_FILE}..."
gunzip -c "$BACKUP_FILE" > "$DUMP_FILE"

echo "Restoring into target database..."
pg_restore \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  --dbname="$RESTORE_DATABASE_URL" \
  "$DUMP_FILE"

echo "Restore complete."
