#!/usr/bin/env bash
# Copies the server to your server and restarts it. Open the shared connection first:
#   ssh -M -S ~/.ssh/drivezzz-server.sock -o ControlPersist=8h -fN root@your-server
# Data in /var/lib/drivezzz and the keys in /root are never touched.
set -euo pipefail
cd "$(dirname "$0")"
# The legal pages name who runs Drivezzz: they can't go out with the marked blanks still in them.
if grep -l '<mark class="fill"' server/public/*.html; then echo "Fill in the marked details in these pages first."; exit 1; fi
HOST=root@your-server
SSH="ssh -S $HOME/.ssh/drivezzz-server.sock"
rsync -az --delete --exclude data --exclude .DS_Store -e "$SSH" server/ "$HOST:/opt/drivezzz/server/"
# Cloudflare keeps .js and .css for about a day whatever the server says, so every deploy gives them a new address.
$SSH "$HOST" "cd /opt/drivezzz/server && sed -i -E 's/\.(css|js)\?v=[0-9]+/.\1?v=$(date +%s)/g' admin/index.html public/*.html"
$SSH "$HOST" 'cd /opt/drivezzz/server && chown -R root:root . && bash deploy/setup-server.sh && systemctl restart drivezzz && sleep 2 && systemctl --no-pager --lines=3 status drivezzz && curl -fsS http://127.0.0.1:8080/api/health'
