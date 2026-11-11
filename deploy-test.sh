#!/usr/bin/env bash
# Copies this folder to the test server on your server and restarts it. It's always on at http://your-server:8090, with a pretend
# chain (no contract, no real money), a pretend driver and data of its own in /var/lib/drivezzz-test. Never the live server.
# Open the shared connection first:
#   ssh -M -S ~/.ssh/drivezzz-server.sock -o ControlPersist=8h -fN root@your-server
set -euo pipefail
cd "$(dirname "$0")"
HOST=root@your-server
SSH="ssh -S $HOME/.ssh/drivezzz-server.sock"
$SSH "$HOST" 'mkdir -p /opt/drivezzz-test/server /opt/drivezzz-test/contract/test'
rsync -az --delete --exclude data --exclude .DS_Store -e "$SSH" server/ "$HOST:/opt/drivezzz-test/server/"
rsync -az --delete --exclude .DS_Store -e "$SSH" contract/test/ "$HOST:/opt/drivezzz-test/contract/test/"
$SSH "$HOST" 'bash /opt/drivezzz-test/server/deploy/setup-test-server.sh'
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -m 3 http://your-server:8090/api/health >/dev/null; then echo "Test server is up: http://your-server:8090"; exit 0; fi
  sleep 1
done
echo "The test server didn't answer. Look at: journalctl -u drivezzz-test -n 50"
exit 1
