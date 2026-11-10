// Compare deux historiques JSONL (TypeScript et Rust) : premier jour et premiers champs qui diffèrent.
// node scripts/compare.mjs ts.jsonl rs.jsonl
import fs from 'node:fs';
const [a, b] = process.argv.slice(2).map((f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
const diffs = (x, y, path = '') => {
  const out = [];
  if (typeof x === 'number' || typeof y === 'number' || x === null || y === null) {
    const nx = x ?? NaN, ny = y ?? NaN;
    if (!(nx === ny || (Number.isNaN(nx) && Number.isNaN(ny)))) out.push(`${path}: ${x} ≠ ${y}`);
    return out;
  }
  if (typeof x !== 'object' || typeof y !== 'object') return x === y ? out : [`${path}: ${JSON.stringify(x)} ≠ ${JSON.stringify(y)}`];
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) out.push(...diffs(x[k], y[k], path ? `${path}.${k}` : k));
  return out;
};
const n = Math.min(a.length, b.length);
let first = -1;
for (let i = 0; i < n; i++) {
  const d = diffs(a[i], b[i]);
  if (d.length) {
    first = i;
    console.log(`DIFFÉRENT à la ligne ${i} (jour ${a[i].day ?? 'gazette'}) : ${d.length} champs`);
    console.log(d.slice(0, 25).join('\n'));
    break;
  }
}
if (first < 0) console.log(a.length === b.length ? `IDENTIQUE sur ${n} lignes` : `identique sur ${n} lignes, longueurs ${a.length}/${b.length}`);
