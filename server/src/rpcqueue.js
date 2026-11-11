// Requests to a Solana connection, kept under its limits: what doesn't fit waits its turn instead of being refused. The free
// public connection allows 100 requests in 10 seconds from one address, and 40 of one kind (Pieter: no paid connection, queue
// them and tell the rider, 6 November 2026). Urgent ones, a rider paying or waiting to see a payment arrive, go before the
// background work of paying out. No database or network here, so the tests can drive it with their own clock.
export function makeQueue({ perWindow, perMethod, windowMs = 10_000, now = Date.now }) {
  const sent = [];              // when each request within the window went out
  const byMethod = new Map();   // the same, per kind of request
  const waiting = [];           // { method, urgent, resolve }, urgent ones first
  let pausedUntil = 0;
  let timer = null;

  const prune = (list, t) => { while (list.length && list[0] <= t - windowMs) list.shift(); };
  const usedBy = (method, t) => {
    const list = byMethod.get(method) ?? [];
    prune(list, t);
    byMethod.set(method, list);
    return list;
  };

  function pump() {
    const t = now();
    if (t < pausedUntil) return later(pausedUntil - t);
    prune(sent, t);
    for (let i = 0; i < waiting.length && sent.length < perWindow;) {
      const w = waiting[i];
      const used = usedBy(w.method, t);
      if (used.length >= perMethod) { i++; continue; }
      waiting.splice(i, 1);
      sent.push(t);
      used.push(t);
      w.resolve();
    }
    if (!waiting.length) return;
    // The first moment something waiting could go.
    let next = Infinity;
    for (const w of waiting) {
      const used = usedBy(w.method, t);
      const free = Math.max(sent.length >= perWindow ? sent[0] + windowMs : t, used.length >= perMethod ? used[0] + windowMs : t);
      next = Math.min(next, free);
    }
    later(Math.max(5, next - t));
  }
  function later(ms) {
    if (timer) return;
    timer = setTimeout(() => { timer = null; pump(); }, ms);
    timer.unref?.();
  }

  return {
    // Resolves when this request may go out.
    take(method, urgent = false) {
      if (!perWindow) return Promise.resolve();
      return new Promise((resolve) => {
        const w = { method, urgent, resolve };
        const at = urgent ? waiting.findIndex((x) => !x.urgent) : -1;
        if (at < 0) waiting.push(w); else waiting.splice(at, 0, w);
        pump();
      });
    },
    // The connection said it's busy anyway (it can be stricter than it says): everything waits this long.
    busy(ms) { pausedUntil = Math.max(pausedUntil, now() + ms); },
    // How many wait, and about how long the last of them will. For the app: "you're in the queue".
    status() {
      if (!waiting.length) return { waiting: 0, seconds: 0 };
      const perSecond = perWindow / (windowMs / 1000), methodPerSecond = perMethod / (windowMs / 1000);
      const counts = new Map();
      for (const w of waiting) counts.set(w.method, (counts.get(w.method) ?? 0) + 1);
      const most = Math.max(...counts.values());
      const paused = Math.max(0, pausedUntil - now()) / 1000;
      return { waiting: waiting.length, seconds: Math.ceil(paused + Math.max(waiting.length / perSecond, most / methodPerSecond)) };
    },
  };
}
