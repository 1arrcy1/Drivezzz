#!/usr/bin/env bash
# First-time setup on the server, as root, from /opt/drivezzz/server. Safe to run again. The admin login comes from src/make-admin.js.
set -euo pipefail
id drivezzz >/dev/null 2>&1 || useradd --system --home /var/lib/drivezzz --shell /usr/sbin/nologin drivezzz
mkdir -p /var/lib/drivezzz && chown -R drivezzz:drivezzz /var/lib/drivezzz
install -m 644 deploy/drivezzz.service /etc/systemd/system/drivezzz.service
echo '17 3 * * * root /opt/drivezzz/server/deploy/backup.sh' > /etc/cron.d/drivezzz-backup
systemctl daemon-reload
systemctl enable drivezzz >/dev/null 2>&1
