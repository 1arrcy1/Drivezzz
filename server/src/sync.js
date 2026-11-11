// How the app hears about changes: GET /api/sync?rev=N&wait=25 waits until something changed for this
// user or the time is up. A quiet answer is a few bytes, which keeps a driver under the data budget.
import { tellEdges } from './fanout.js';

const revs = new Map();
const waiters = new Map();

export const revOf = (userId) => revs.get(userId) ?? 1;

function setRev(userId, rev) {
  revs.set(userId, rev);
  const list = waiters.get(userId);
  if (!list) return;
  waiters.delete(userId);
  for (const wake of list) wake();
}

export function bump(userId) {
  if (!userId) return;
  const rev = revOf(userId) + 1;
  setRev(userId, rev);
  tellEdges('rev', userId, rev);
}

// In a helper process (edge.js): the main process keeps count, and this is what it said.
export const learnRev = (userId, rev) => { if (rev > revOf(userId)) setRev(userId, rev); };

export function waitForChange(userId, rev, ms, req) {
  if (rev !== revOf(userId)) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      const list = waiters.get(userId);
      if (list) { const i = list.indexOf(finish); if (i >= 0) list.splice(i, 1); if (!list.length) waiters.delete(userId); }
      finish();
    }, ms);
    if (!waiters.has(userId)) waiters.set(userId, []);
    waiters.get(userId).push(finish);
    req.once('close', finish);
  });
}
