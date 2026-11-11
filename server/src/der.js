// Reading DER (ASN.1), the encoding of certificates, of what a passport or ID card chip signs (chip.js) and of Apple's App Attest
// (attest.js). Only reading, only what those need. A node: { cls, tag, constructed, bytes (all of it), value (its content), children }.
export function parse(buf, at = 0, limit = buf.length) {
  let i = at;
  if (i + 2 > limit) throw new Error('DER: too short');
  const first = buf[i++];
  const cls = first >> 6;
  const constructed = Boolean(first & 0x20);
  let tag = first & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    let b;
    do { b = buf[i++]; tag = tag * 128 + (b & 0x7f); } while (b & 0x80 && i < limit);
  }
  let len = buf[i++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (!n || n > 4) throw new Error('DER: bad length');
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + buf[i++];
  }
  const end = i + len;
  if (end > limit) throw new Error('DER: cut short');
  const node = { cls, tag, constructed, start: at, end, bytes: buf.subarray(at, end), value: buf.subarray(i, end) };
  if (constructed) {
    node.children = [];
    for (let j = i; j < end;) {
      const c = parse(buf, j, end);
      node.children.push(c);
      j = c.end;
    }
  }
  return node;
}

// The context-specific [n] child, if there is one.
export const tagged = (node, n) => node.children?.find((c) => c.cls === 2 && c.tag === n);

export function oidOf(node) {
  const v = node.value;
  const parts = [Math.floor(v[0] / 40), v[0] % 40];
  let n = 0;
  for (let i = 1; i < v.length; i++) {
    n = n * 128 + (v[i] & 0x7f);
    if (!(v[i] & 0x80)) { parts.push(n); n = 0; }
  }
  return parts.join('.');
}

export function intOf(node) {
  let n = 0;
  for (const b of node.value) n = n * 256 + b;
  return n;
}
