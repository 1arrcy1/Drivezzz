import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-coins-'));
const coins = await import('../src/coins.js');
const sol = await import('../src/solana.js');

test('testnet is the default', () => assert.equal(coins.network(), 'testnet'));

test('the coins are USDC and SOL, and USDC follows the network', () => {
  assert.deepEqual(coins.ASSET_IDS, ['usdc-sol', 'sol']);
  assert.equal(coins.usdcMint(), '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  coins.setNetwork('mainnet');
  assert.equal(coins.usdcMint(), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  coins.setNetwork('testnet');
});

test('amounts show exactly, also those of old rides', () => {
  assert.equal(coins.fromUnits('sol', 1_500_000_000n), '1.5');
  assert.equal(coins.fromUnits('sol', 1n), '0.000000001');
  assert.equal(coins.fromUnits('usdc-sol', 5_160_000n), '5.16');
  assert.equal(coins.fromUnits('sol', 0n), '0');
  assert.equal(coins.fromUnits('xlm', 562_157_155n), '56.2157155');
  assert.equal(coins.fromUnits('xrp', 400_000_000n), '400');
  assert.equal(coins.fromUnits('ltc', 400_000_000n), '4');
});

test('base58 round trips, leading zeros too', () => {
  const key = Buffer.concat([Buffer.alloc(2), Buffer.from('drivezzz')]);
  assert.deepEqual(coins.b58decode(coins.b58encode(key)), key);
  assert.equal(coins.b58encode(Buffer.alloc(32)), '11111111111111111111111111111111');
  assert.throws(() => coins.b58decode('0OIl'));
});

test('only a Solana address passes', () => {
  const good = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  assert.equal(coins.checkAddress(` ${good} `).address, good);
  for (const bad of ['', 'nope', 'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh', '11111111111111111111111111111111', null]) {
    assert.throws(() => coins.checkAddress(bad), /Solana address/);
  }
});

test('a wallet key is on the curve, a program address isn’t', () => {
  assert.equal(coins.onCurve(sol.keypair(Buffer.alloc(32, 7)).pub), true);
  assert.equal(coins.onCurve(sol.pda([Buffer.from('escrow')], sol.TOKEN).address), false);
});
