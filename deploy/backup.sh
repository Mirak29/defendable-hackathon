#!/bin/sh
# Copy the database of the running app into /data/backups (the 30 newest are
# kept). From the folder of docker-compose.yml, by hand or from cron:
#   0 */6 * * * cd /home/ubuntu/defendable && ./deploy/backup.sh >> backup.log 2>&1
set -e
docker compose exec -T app deno run -A --unstable-ffi deploy/backup.ts
