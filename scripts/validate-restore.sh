#!/usr/bin/env bash
set -euo pipefail
# RESTORE_CONTAINER is the ID of a temporary PostgreSQL Actions service.
# No production URI is accepted or used here.
: "${RESTORE_CONTAINER:?Container temporário ausente}"
test -s backup.dump
docker cp backup.dump "$RESTORE_CONTAINER:/tmp/backup.dump"
docker exec "$RESTORE_CONTAINER" pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -U postgres -d backup_validation /tmp/backup.dump
docker exec -i "$RESTORE_CONTAINER" psql -U postgres -d backup_validation -v ON_ERROR_STOP=1 < scripts/check-restored.sql
