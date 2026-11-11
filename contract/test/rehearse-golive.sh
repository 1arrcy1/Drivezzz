#!/usr/bin/env bash
# Deploy day, rehearsed: go-live.sh and the server's move off the pretend chain, on a private validator with mainnet's rules, its
# token programs and real USDC's mint. Throwaway keys, the deploy key's real amount of SOL. No real network, key or money.
# As root on the server, after copying this folder and server/ to /home/dzbuild/rehearsal (contract/ and server/):
#   bash /home/dzbuild/rehearsal/contract/test/rehearse-golive.sh
set -euo pipefail
R=/home/dzbuild/rehearsal
C="$R/contract"
BIN=/home/dzbuild/.local/share/solana/install/active_release/bin
RPC=http://127.0.0.1:18899
USDC=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
FEE=6aHmEJ6gikE7XH8NANwzBHukdAP2nMUkQR9DTRkV7YuN
OWNER=3xaQeBzoAP9oD8SqCkKkYgm8bn1U7rquyXy5K7336KK7   # Only a public address: on this private chain it means nothing.
export PATH="$BIN:/opt/drivezzz/node/bin:$PATH"
as() { runuser -u dzbuild -- env PATH="$PATH" "$@"; }

systemctl stop dz-localnet dz-rehearsal 2>/dev/null || true
systemctl reset-failed dz-localnet dz-rehearsal 2>/dev/null || true
cp /root/drivezzz-go-live/drivezzz_escrow.so "$C/"
rm -rf "$R/keys" "$R/ledger" "$R/data" "$R/fixtures"
mkdir -p "$R/keys" "$R/fixtures"
chown -R dzbuild:dzbuild "$R"

for k in drivezzz-deploy-key drivezzz-escrow-key drivezzz-program-key rider driver; do
  as solana-keygen new --no-bip39-passphrase --silent --outfile "$R/keys/$k.json" >/dev/null
done
RIDER=$(solana-keygen pubkey "$R/keys/rider.json")
DRIVER=$(solana-keygen pubkey "$R/keys/driver.json")
# Real USDC can't be minted here, so the rider and the driver start with token accounts of it, 100 and 0.
as node --disable-warning=ExperimentalWarning "$C/test/rehearse-fixtures.mjs" "$R/fixtures" "$RIDER" "$DRIVER" "$USDC" "$FEE" > "$R/fixtures/addresses"
read -r RIDER_ATA DRIVER_ATA FEE_ATA < "$R/fixtures/addresses"

systemd-run --quiet --unit=dz-rehearsal --uid=dzbuild --gid=dzbuild --working-directory="$R" \
  "$BIN/solana-test-validator" --ledger "$R/ledger" --reset --quiet --bind-address 127.0.0.1 --rpc-port 18899 --faucet-port 19900 \
  --gossip-port 18000 --dynamic-port-range 18001-18040 --url https://api.mainnet-beta.solana.com --clone-feature-set \
  --clone-upgradeable-program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA --clone ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL \
  --clone "$USDC" --clone "$FEE" --clone "$FEE_ATA" \
  --account "$RIDER_ATA" "$R/fixtures/rider.json" --account "$DRIVER_ATA" "$R/fixtures/driver.json"
for i in $(seq 1 120); do
  [ "$(curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$RPC" | grep -c '"ok"')" = 1 ] && break
  sleep 1
done
sleep 3
DEPLOY=$(solana-keygen pubkey "$R/keys/drivezzz-deploy-key.json")
solana --url "$RPC" --keypair "$R/keys/rider.json" airdrop 5 "$RIDER" >/dev/null
solana --url "$RPC" --keypair "$R/keys/rider.json" airdrop 0.243192095 "$DEPLOY" >/dev/null
solana --url "$RPC" --keypair "$R/keys/rider.json" airdrop 0.05 "$DRIVER" >/dev/null
echo "===== the validator: $(solana --url "$RPC" cluster-version), deploy key $(solana --url "$RPC" balance "$DEPLOY")"
GO="NETWORK=mainnet CRYPTO_SOL_URL=$RPC KEYS=$R/keys CONFIRM=DEPLOY"

echo "===== go-live.sh, stopped halfway through the upload"
setsid runuser -u dzbuild -- env PATH="$PATH" $GO bash "$C/go-live.sh" "$OWNER" > "$R/go-live-1.log" 2>&1 &
LEADER=$!
# The upload has begun once the buffer took its rent from the deploy key.
START=$(solana --url "$RPC" balance "$DEPLOY" --lamports | cut -d' ' -f1)
for i in $(seq 1 600); do
  [ "$(solana --url "$RPC" balance "$DEPLOY" --lamports | cut -d' ' -f1)" -lt "$((START - 50000000))" ] && break
  sleep 0.1
done
kill -KILL -- -"$LEADER" 2>/dev/null || true
wait "$LEADER" 2>/dev/null || true
sleep 1
echo "stopped. Deploy key $(solana --url "$RPC" balance "$DEPLOY"), program there: $(solana --url "$RPC" program show "$(solana-keygen pubkey "$R/keys/drivezzz-program-key.json")" >/dev/null 2>&1 && echo yes || echo no)"
solana --url "$RPC" --keypair "$R/keys/drivezzz-deploy-key.json" program show --buffers 2>&1 | tail -3

echo "===== go-live.sh again, to finish it"
as $GO bash "$C/go-live.sh" "$OWNER" 2>&1 | tail -26
echo "===== and once more: nothing left to do"
as $GO bash "$C/go-live.sh" "$OWNER" 2>&1 | tail -8

echo "===== read-back"
as env SOLANA_RPC="$RPC" PROGRAM="$(solana-keygen pubkey "$R/keys/drivezzz-program-key.json")" OWNER="$OWNER" ADMIN="$DEPLOY" \
  SERVER="$(solana-keygen pubkey "$R/keys/drivezzz-escrow-key.json")" FEE="$FEE" node --disable-warning=ExperimentalWarning "$C/read-back.mjs"

echo "===== the server's move, from the pretend chain to this contract"
as env R="$R" SOLANA_RPC="$RPC" RPC="$RPC" node --disable-warning=ExperimentalWarning "$C/test/rehearse-switch.mjs"
systemctl stop dz-rehearsal
echo "===== done $(date -u)"
