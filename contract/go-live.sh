#!/usr/bin/env bash
# Puts the escrow on the real network, without anyone's own wallet keys: a deploy key made here pays, and the right to
# update the program goes to your own address at the end. It spends real SOL, so it's yours to run, on the server, as root:
#   bash /root/drivezzz-go-live/go-live.sh <your Solana address>
# Run it again after a failure: finished steps are skipped. Nothing here changes the live server: that's ./deploy.sh, after.
#
# NETWORK=devnet KEYS=<folder> rehearses all of it on devnet.
set -euo pipefail
OWNER="${1:-}"
NETWORK="${NETWORK:-mainnet}"
HERE="$(cd "$(dirname "$0")" && pwd)"
KEYS="${KEYS:-/root}"
PATH="/home/dzbuild/.local/share/solana/install/active_release/bin:/opt/drivezzz/node/bin:$PATH"
DEPLOY_KEY="$KEYS/drivezzz-deploy-key.json"
SERVER_KEY="$KEYS/drivezzz-escrow-key.json"
PROGRAM_KEY="$KEYS/drivezzz-program-key.json"
SO="$HERE/drivezzz_escrow.so"
NEED_SOL="0.135"

if [ "$NETWORK" = mainnet ]; then
  URL="${CRYPTO_SOL_URL:-https://api.mainnet-beta.solana.com}"
  USDC_MINT="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
else
  URL="https://api.devnet.solana.com"
  USDC_MINT="${USDC_MINT:?the test USDC}"
fi
FEE_ADDRESS="${FEE_ADDRESS:-6aHmEJ6gikE7XH8NANwzBHukdAP2nMUkQR9DTRkV7YuN}"

umask 077
for f in "$DEPLOY_KEY" "$SERVER_KEY" "$PROGRAM_KEY"; do
  [ -f "$f" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$f" >/dev/null
done

DEPLOY="$(solana-keygen pubkey "$DEPLOY_KEY")"
SERVER="$(solana-keygen pubkey "$SERVER_KEY")"
PROGRAM="$(solana-keygen pubkey "$PROGRAM_KEY")"
sol() { solana --url "$URL" --keypair "$DEPLOY_KEY" "$@"; }

echo "Network      $NETWORK"
echo "Deploy key   $DEPLOY   (send SOL here)"
echo "Server key   $SERVER"
echo "Program      $PROGRAM"
echo "Fee address  $FEE_ADDRESS"
echo "Update right $OWNER"
[ -n "$OWNER" ] || { echo; echo "Give your own Solana address: it gets the right to update the program."; exit 1; }
[ "${#OWNER}" -ge 32 ] && [ "${#OWNER}" -le 44 ] || { echo "That doesn't look like a Solana address."; exit 1; }

# The contract must be the real one: 30 days, not the devnet's 10 minutes. 2,592,000 seconds in the file.
[ -f "$SO" ] || { echo "$SO is missing."; exit 1; }
if [ "$NETWORK" = mainnet ]; then
  node -e 'const b=require("fs").readFileSync(process.argv[1]); if(!b.includes(Buffer.from([0x00,0x8d,0x27,0x00]))) process.exit(1)' "$SO" \
    || { echo "This contract doesn't have the 30 days in it: stopping."; exit 1; }
fi
echo "Contract     $(sha256sum "$SO" | cut -c1-16)…, $(stat -c %s "$SO") bytes"

# A failed try leaves the upload's account behind, with most of the SOL in it: that comes back first, or it looks like too little.
if ! sol program show "$PROGRAM" >/dev/null 2>&1; then
  sol program close --buffers >/dev/null 2>&1 || true
fi
BALANCE="$(sol balance "$DEPLOY" | cut -d' ' -f1)"
echo "Deploy key has $BALANCE SOL"

if ! sol program show "$PROGRAM" >/dev/null 2>&1; then
  node -e 'process.exit(Number(process.argv[1]) >= Number(process.argv[2]) ? 0 : 1)' "$BALANCE" "$NEED_SOL" \
    || { echo "Not enough yet: send at least $NEED_SOL SOL to $DEPLOY, then run this again."; exit 1; }
  if [ "$NETWORK" = mainnet ] && [ "${CONFIRM:-}" != DEPLOY ]; then
    read -r -p "This spends real SOL on the real network. Type DEPLOY to go on: " ANSWER
    [ "$ANSWER" = DEPLOY ] || { echo "Stopped. Nothing was sent."; exit 1; }
  fi
  # The priority fee keeps a busy network from dropping the upload's pieces: only a few thousand lamports in all.
  sol program deploy "$SO" --program-id "$PROGRAM_KEY" --upgrade-authority "$DEPLOY_KEY" --max-len "$(stat -c %s "$SO")" --use-rpc --with-compute-unit-price 50000
fi

cd "$HERE"
PROGRAM="$PROGRAM" DEPLOY_KEY="$DEPLOY_KEY" SERVER_KEY="$SERVER_KEY" FEE_ADDRESS="$FEE_ADDRESS" USDC_MINT="$USDC_MINT" \
  SOLANA_RPC="$URL" ENV_OUT="$KEYS/drivezzz-escrow.env" node --disable-warning=ExperimentalWarning go-live.mjs

# Last: the right to update the program goes to you. The deploy key stays the settings' admin, for the admin panel.
AUTH="$(sol program show "$PROGRAM" | sed -n 's/^Authority: //p')"
if [ "$AUTH" != "$OWNER" ]; then
  sol program set-upgrade-authority "$PROGRAM" --upgrade-authority "$DEPLOY_KEY" --new-upgrade-authority "$OWNER" --skip-new-upgrade-authority-signer-check
fi
echo
echo "Done. Update right: $(sol program show "$PROGRAM" | sed -n 's/^Authority: //p')"
echo "Deploy key has $(sol balance "$DEPLOY")"
echo "For the live server: $KEYS/drivezzz-escrow.env"
