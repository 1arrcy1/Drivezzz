#!/usr/bin/env bash
# Nightly copy of the database, keeping 14 days. It's on the same disk, so copy it off the server too now and then.
set -euo pipefail
DIR=/root/drivezzz-backups
mkdir -p "$DIR" && chmod 700 "$DIR"
sqlite3 /var/lib/drivezzz/drivezzz.db ".backup '$DIR/drivezzz-$(date +%F).db'"
chmod 600 "$DIR"/*.db
find "$DIR" -name 'drivezzz-*.db' -mtime +14 -delete
