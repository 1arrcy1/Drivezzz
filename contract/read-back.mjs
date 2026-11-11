// After go-live.sh: what's really on the chain, read back and compared. Reads only, needs no key. On the server:
//   node --disable-warning=ExperimentalWarning /root/drivezzz-go-live/read-back.mjs
// PROGRAM, OWNER, ADMIN, SERVER and FEE default to the real ones; SOLANA_RPC to the real network.
import crypto from 'node:crypto';
import fs from 'node:fs';

process.env.SOLANA_RPC ||= 'https://api.mainnet-beta.solana.com';
const { b58, unb58, pda, account, balance, tokenAccountOf, LOADER } = await import('./test/sol.mjs');

const PROGRAM = unb58(process.env.PROGRAM || '41tGxjd1fDPtPXJXk2cLMuitX6tixZA5XVPQefSe7xzf');
const OWNER = process.env.OWNER || '3xaQeBzoAP9oD8SqCkKkYgm8bn1U7rquyXy5K7336KK7';
const ADMIN = process.env.ADMIN || '7TyadkaYpmaoSNAaYwXPkXd6czu5wkMKxvrdeU4kM5at';
const SERVER = process.env.SERVER || '3Stw2juuQNmYpcNtmzjwU6DHQbgrp7DhT57JRHXFkweA';
const FEE = process.env.FEE || '6aHmEJ6gikE7XH8NANwzBHukdAP2nMUkQR9DTRkV7YuN';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const so = fs.readFileSync(new URL('./drivezzz_escrow.so', import.meta.url));

let failures = 0;
const ok = (name, cond, detail = '') => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

const program = await account(PROGRAM);
ok('the program is there and can run', Boolean(program?.executable));
const data = await account(pda([PROGRAM], LOADER).address);
ok('its data account is there', Boolean(data));
if (data) {
  const code = data.data.subarray(45);
  ok('the update right is the address it should be', data.data[12] === 1 && b58(data.data.subarray(13, 45)) === OWNER, b58(data.data.subarray(13, 45)));
  ok('the size is exactly the contract file', code.length === so.length, `${code.length} bytes`);
  const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
  ok('what runs is this contract file, byte for byte', hash(code) === hash(so), hash(code).slice(0, 16));
}
const config = await account(pda([Buffer.from('config')], PROGRAM).address);
ok('the settings are there', config?.data?.[0] === 1 && config.data.length === 130);
if (config) {
  ok('settings: the admin is the deploy key', b58(config.data.subarray(2, 34)) === ADMIN, b58(config.data.subarray(2, 34)));
  ok('settings: the server key', b58(config.data.subarray(34, 66)) === SERVER, b58(config.data.subarray(34, 66)));
  ok('settings: the fee address', b58(config.data.subarray(66, 98)) === FEE, b58(config.data.subarray(66, 98)));
  ok('settings: real USDC', b58(config.data.subarray(98, 130)) === USDC, b58(config.data.subarray(98, 130)));
}
ok('the fee address has a USDC account', Boolean(await account(tokenAccountOf(unb58(FEE), unb58(USDC)))));
ok('the fee address holds SOL', (await balance(unb58(FEE))) > 0n);
const serverSol = await balance(unb58(SERVER));
ok('the server key has its SOL for fees', serverSol >= 2_000_000n, `${Number(serverSol) / 1e9} SOL`);
console.log(failures ? `\n${failures} NOT RIGHT` : '\nAll of it is right.');
process.exit(failures ? 1 : 0);
