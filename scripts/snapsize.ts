import { Simulation } from '../src/sim/sim';
import v8 from 'node:v8';
const sim = new Simulation({ seed: 3 });
for (const y of [1, 5, 10]) {
  while (sim.day < y * 360) sim.step();
  const h = sim.history; sim.history = [];
  const t0 = performance.now();
  const c = structuredClone(sim);
  const t1 = performance.now();
  sim.history = h;
  const bytes = v8.serialize(c).length;
  console.log(`an ${y}: ${(bytes / 1e6).toFixed(2)} Mo, clone ${(t1 - t0).toFixed(0)} ms, agents ${sim.agents.length}, entreprises ${sim.businesses.length} (vivantes ${sim.businesses.filter(b => b.alive).length}), historique ${(v8.serialize(h).length / 1e6).toFixed(1)} Mo`);
}
