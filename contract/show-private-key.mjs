// For you, in your own terminal: a Solana CLI key file as the base58 private key wallets ask for when importing.
//   node show-private-key.mjs /root/drivezzz-deploy-key.json
import fs from 'node:fs';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`), out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}
const key = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(key) || key.length !== 64) throw new Error('That is not a Solana key file.');
console.log(`Address:     ${b58(key.slice(32))}\nPrivate key: ${b58(key)}\n\nAnyone with this private key controls the wallet. Don't paste it into a chat or a website.`);
