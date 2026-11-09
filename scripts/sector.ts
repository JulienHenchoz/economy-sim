// Détail d'un métier à un jour donné : npx tsx scripts/sector.ts <jours> <graine> <métier>
import { Simulation } from '../src/sim/sim';
import type { Job } from '../src/sim/config';
const [days, seed, job] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4] as Job];
const sim = new Simulation({ seed });
for (let i = 0; i < days; i++) sim.step();
const bs = sim.businesses.filter((b) => b.alive && b.job === job && b.workers.length);
const f = (x: number) => (x / 100).toFixed(2);
console.log(`${job}: ${bs.length} entreprises, ${bs.reduce((s, b) => s + b.workers.length, 0)} travailleurs`);
for (const b of bs.slice(0, 12)) {
  const inv = [...b.inv].map(([g, l]) => `${g}:${l.reduce((s, x) => s + x.q, 0).toFixed(0)}`).join(' ');
  console.log(`#${b.id} n=${b.workers.length} pot=${b.potential.toFixed(1)} vaEma=${f(b.vaEma)} cash=${f(b.cash)} ask=${JSON.stringify(Object.fromEntries(Object.entries(b.ask).map(([k, v]) => [k, f(v!)])))} bid=${JSON.stringify(Object.fromEntries(Object.entries(b.bid).map(([k, v]) => [k, f(v!)])))} inv=${inv}`);
}
