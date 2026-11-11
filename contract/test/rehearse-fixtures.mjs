// For rehearse-golive.sh: token accounts of real USDC for a private validator, where it can't be minted. Prints their addresses.
import fs from 'node:fs';
import path from 'node:path';
import { b58, unb58, tokenAccountOf, u64 } from './sol.mjs';

const [dir, rider, driver, mint, fee] = process.argv.slice(2);
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
function write(name, owner, amount) {
  const address = tokenAccountOf(unb58(owner), unb58(mint));
  // Mint, owner, amount, then no delegate, initialised, not native, nothing delegated, no close authority.
  const data = Buffer.concat([unb58(mint), unb58(owner), u64(amount), Buffer.alloc(36), Buffer.from([1]), Buffer.alloc(56)]);
  if (data.length !== 165) throw new Error('a token account is 165 bytes');
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ pubkey: b58(address), account: { lamports: 2039280, data: [data.toString('base64'), 'base64'], owner: TOKEN, executable: false, rentEpoch: 0, space: 165 } }));
  return b58(address);
}
console.log(write('rider', rider, 100_000_000n), write('driver', driver, 0n), b58(tokenAccountOf(unb58(fee), unb58(mint))));
