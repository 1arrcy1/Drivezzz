// Sets up the escrow right after its deploy: the settings, the fee address's USDC account and the server key's float.
// Every step checks first, so running it again only does what's left. Called by go-live.sh, which holds the settings.
import fs from 'node:fs';
import { b58, unb58, key, loadKeypair, pda, ix, u64, send, balance, account, sleep, SYSTEM, TOKEN, ATA, LOADER, tokenAccountOf } from './test/sol.mjs';

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is missing`);
  return v;
};
const PROGRAM = unb58(need('PROGRAM'));
const deploy = loadKeypair(need('DEPLOY_KEY'));
const server = loadKeypair(need('SERVER_KEY'));
const FEE = unb58(need('FEE_ADDRESS'));
const MINT = unb58(need('USDC_MINT'));
const FLOAT = 10_000_000n; // 0.01 SOL: each settle pays its base fee back to the server key, but not its priority fee.

const config = pda([Buffer.from('config')], PROGRAM);
const programdata = pda([PROGRAM], LOADER).address;

// A program only runs from the slot after its deploy, and a connection can be a little behind that: this waits for it.
async function onceItRuns(action) {
  for (let i = 0; ; i++) {
    try { return await action(); } catch (e) {
      if (i >= 30 || !/not deployed|unsupported program id/i.test(`${e.message} ${JSON.stringify(e)}`)) throw e;
      await sleep(1000);
    }
  }
}

if (!(await account(config.address))) {
  await onceItRuns(() => send([ix(PROGRAM, [[deploy, 1, 1], [config.address, 0, 1], [programdata], [SYSTEM]],
    Buffer.concat([Buffer.from([0, config.bump]), key(server), key(FEE), key(MINT)]))], [deploy]));
  console.log('Settings made.');
}
const c = await account(config.address);
const same = c && c.data[0] === 1 && c.data.subarray(34, 66).equals(server.pub) && c.data.subarray(66, 98).equals(FEE) && c.data.subarray(98, 130).equals(MINT);
if (!same) throw new Error('The settings on the chain aren’t what they should be: stopping.');

// Without this account every USDC ride paid out in full would be refused by the chain.
const feeToken = tokenAccountOf(FEE, MINT);
if (!(await account(feeToken))) {
  await send([ix(ATA, [[deploy, 1, 1], [feeToken, 0, 1], [FEE], [MINT], [SYSTEM], [TOKEN]], Buffer.from([1]))], [deploy]);
  console.log('USDC account made for the fee address.');
}

const have = await balance(server);
if (have < FLOAT) {
  await send([ix(SYSTEM, [[deploy, 1, 1], [server, 0, 1]], Buffer.concat([Buffer.from([2, 0, 0, 0]), u64(FLOAT - have)]))], [deploy]);
  console.log('SOL sent to the server key for its fees.');
}

if (!(await account(FEE))) throw new Error(`The fee address ${b58(FEE)} holds no SOL: SOL rides couldn’t be paid out. Send it a little SOL first.`);
console.log(`Settings OK.\n  program      ${b58(PROGRAM)}\n  server key   ${server.address}\n  fee address  ${b58(FEE)}\n  USDC         ${b58(MINT)}\n  server key has ${Number(await balance(server)) / 1e9} SOL\n  deploy key has ${Number(await balance(deploy)) / 1e9} SOL left`);
if (process.env.ENV_OUT) fs.writeFileSync(process.env.ENV_OUT, `ESCROW_PROGRAM_ID=${b58(PROGRAM)}\nESCROW_FEE_ADDRESS=${b58(FEE)}\n`);
