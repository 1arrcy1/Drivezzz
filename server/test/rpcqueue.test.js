// The line for the Solana connection (src/rpcqueue.js), on a short window so it runs quickly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeQueue } from '../src/rpcqueue.js';
import { client, startServer } from './helpers.js';

const WINDOW = 400;

test('requests over the limit wait their turn instead of going out, and riders go first', async () => {
  const q = makeQueue({ perWindow: 5, perMethod: 2, windowMs: WINDOW });
  const start = Date.now();
  const went = [];
  const send = (method, urgent, name) => q.take(method, urgent).then(() => went.push({ method, urgent, name, at: Date.now() - start }));
  const all = [];
  for (let i = 0; i < 8; i++) all.push(send('getMultipleAccounts', false, `payout ${i}`));
  for (let i = 0; i < 4; i++) all.push(send('getLatestBlockhash', false, `blockhash ${i}`));
  const busy = q.status();
  assert.ok(busy.waiting > 0 && busy.seconds > 0, `the app is told there's a line: ${JSON.stringify(busy)}`);
  all.push(send('getMultipleAccounts', true, 'rider paying'));
  await Promise.all(all);
  assert.deepEqual(q.status(), { waiting: 0, seconds: 0 });

  // Never more than the limits in any window (a little slack for timers firing late).
  for (const a of went) {
    const inWindow = went.filter((b) => b.at >= a.at && b.at < a.at + WINDOW - 30);
    assert.ok(inWindow.length <= 5, `at most 5 in a window, got ${inWindow.length} from ${a.at} ms`);
    for (const m of ['getMultipleAccounts', 'getLatestBlockhash']) assert.ok(inWindow.filter((b) => b.method === m).length <= 2, `at most 2 ${m} in a window`);
  }
  // The rider joined last but goes before the payouts still waiting for the same kind of request.
  const rider = went.findIndex((w) => w.name === 'rider paying');
  const payoutsAfter = went.slice(rider + 1).filter((w) => w.method === 'getMultipleAccounts').length;
  assert.ok(payoutsAfter >= 4, `the rider went ahead of the payouts still waiting (${payoutsAfter} after)`);
});

test('when the connection says it is busy anyway, everything waits, and the app hears how long', async () => {
  const q = makeQueue({ perWindow: 50, perMethod: 20, windowMs: WINDOW });
  q.busy(300);
  const start = Date.now();
  const pending = q.take('getMultipleAccounts', true);
  assert.ok(q.status().seconds >= 1, 'the pause counts in the wait');
  await pending;
  assert.ok(Date.now() - start >= 280, 'nothing went out during the pause');
});

test('without a limit (a connection of your own) nothing waits', async () => {
  const q = makeQueue({ perWindow: 0, perMethod: 1 });
  await Promise.all(Array.from({ length: 500 }, () => q.take('getMultipleAccounts')));
  assert.deepEqual(q.status(), { waiting: 0, seconds: 0 });
});

test('the app can ask about the line, which asks nothing of the network', async () => {
  const srv = await startServer();
  try {
    const c = client(srv.base);
    assert.equal((await c.get('/api/chain/queue')).status, 401);
    await c.start();
    const q = await c.get('/api/chain/queue');
    assert.equal(q.status, 200);
    assert.equal(q.waiting, 0);
    assert.equal(q.seconds, 0);
  } finally { srv.stop(); }
});
