#!/usr/bin/env bash
# Turns on Apple push. Apple's team key works for every app of the team; the key itself is never printed.
#   server/deploy/turn-on-push.sh ~/Downloads/AuthKey_7TAG95VL55.p8
set -euo pipefail
KEY="${1:?Give the path of the .p8 key}"
ID=$(basename "$KEY" .p8); ID="${ID#AuthKey_}"
HOST=root@your-server
SSH="ssh -S $HOME/.ssh/drivezzz-server.sock"
scp -o ControlPath="$HOME/.ssh/drivezzz-server.sock" -q "$KEY" "$HOST:/etc/drivezzz-apns.p8"
$SSH "$HOST" "chown root:drivezzz /etc/drivezzz-apns.p8 && chmod 640 /etc/drivezzz-apns.p8 && printf 'APNS_KEY_FILE=/etc/drivezzz-apns.p8\nAPNS_KEY_ID=$ID\nAPNS_TEAM_ID=N92R3SAXJ7\n' > /etc/default/drivezzz && systemctl restart drivezzz && sleep 2 && systemctl is-active drivezzz && journalctl -u drivezzz -n 3 --no-pager | grep -i 'push off' || echo 'Push is on.'"
