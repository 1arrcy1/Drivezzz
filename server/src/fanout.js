// What the main process tells its helpers (edge.js), a few at a time: whose news changed, and whose scores. With no helpers it does nothing.
const edges = new Set();
let waiting = [];
let timer = null;

function send() {
  timer = null;
  const batch = waiting;
  waiting = [];
  for (const edge of edges) if (edge.connected) edge.send(batch);
}

export const addEdge = (edge) => edges.add(edge);
export const removeEdge = (edge) => edges.delete(edge);

export function tellEdges(...message) {
  if (!edges.size) return;
  waiting.push(message);
  if (!timer) timer = setTimeout(send, 20);
}
