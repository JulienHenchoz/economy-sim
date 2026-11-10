// Historique quotidien de la version TypeScript en JSON (une ligne par jour), pour comparer avec le
// cœur Rust : npx tsx scripts/golden.ts <jours> <graine> [politique JSON] [événements JSON] > ts.jsonl
import './fdlibm';
import { Simulation } from '../src/sim/sim';
import type { EventKind } from '../src/sim/config';
const days = Number(process.argv[2] ?? 360);
const seed = Number(process.argv[3] ?? 42);
const policy = process.argv[4] ? JSON.parse(process.argv[4]) : {};
// événements déclenchés à des jours donnés : '{"200":"tempete","400":"epidemie"}'
const events: Record<string, EventKind> = process.argv[5] ? JSON.parse(process.argv[5]) : {};
const sim = new Simulation({ seed }, policy);
const out: string[] = [JSON.stringify(sim.history[0])];
for (let i = 0; i < days; i++) {
  if (events[String(sim.day)]) sim.triggerEvent(events[String(sim.day)]);
  sim.step();
  out.push(JSON.stringify(sim.history[sim.history.length - 1]));
}
out.push(JSON.stringify({ news: sim.news.map((n) => `j${n.day} ${n.text}`) }));
process.stdout.write(out.join('\n') + '\n');
