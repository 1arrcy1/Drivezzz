// Words that aren’t allowed in names, bios, vehicle names, reviews or place names (from Datezzz). Matched as whole
// words after simple look-alike normalisation (0→o, 1→i, @→a…).
export const BLOCKED_WORDS = [
  // English slurs and abuse
  'nigger', 'niggers', 'nigga', 'niggas', 'faggot', 'faggots', 'fag', 'fags', 'retard', 'retards', 'retarded',
  'tranny', 'trannies', 'kike', 'kikes', 'spic', 'spics', 'chink', 'chinks', 'wetback', 'wetbacks', 'coon', 'coons',
  'cunt', 'cunts', 'whore', 'whores', 'rapist', 'rape', 'raping', 'pedo', 'pedos', 'pedophile', 'paedophile',
  'childporn', 'kys', 'killyourself',
  // Dutch slurs and abuse
  'kanker', 'kankerlijer', 'kankerhoer', 'tyfus', 'tyfuslijer', 'tering', 'teringlijer', 'mongool', 'mongolen',
  'flikker', 'flikkers', 'neger', 'negers', 'makak', 'hoer', 'hoeren', 'sloerie', 'kutwijf', 'kankerflikker',
];

const LOOKALIKES = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
const blocked = new Set(BLOCKED_WORDS);

function normalise(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[013457@$!]/g, (c) => LOOKALIKES[c]);
}

// Returns the first blocked word in the text, or null.
export function findBlocked(text) {
  if (!text) return null;
  const words = normalise(text).split(/[^a-z]+/).filter(Boolean);
  for (const w of words) if (blocked.has(w)) return w;
  // Also catch words spelled with separators, like "f.a.g.g.o.t".
  const squashed = normalise(text).replace(/[^a-z]/g, '');
  for (const w of BLOCKED_WORDS) if (w.length >= 6 && squashed === w) return w;
  return null;
}
