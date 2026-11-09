import { Simulation } from '../src/sim/sim';
const sim = new Simulation({ seed: 42 });
const days = Number(process.argv[2] ?? 60);
for (let i = 0; i < days; i++) {
  sim.step();
  if (sim.day % 60) continue;
  const hungry = sim.agents.filter((a) => a.alive && a.fed < 0.9);
  const by: Record<string, { n: number; money: number; inc: number }> = {};
  for (const a of hungry) {
    const head = sim.isHead(a) ? a : sim.agents[a.parent];
    const k = `${a.status}${sim.isHead(a) ? '' : '(dép)'}`;
    by[k] ??= { n: 0, money: 0, inc: 0 };
    by[k].n++;
    by[k].money += head.money / 100;
    by[k].inc += head.lastIncome / 3000;
  }
  console.log(`j${sim.day} affamés ${hungry.length} coût/nut ${(sim.costPerNutrition() / 100).toFixed(2)} :`, Object.entries(by).map(([k, v]) => `${k} ${v.n} (argent moy ${(v.money / v.n).toFixed(1)}, rev/j ${(v.inc / v.n).toFixed(2)})`).join(' ; '));
}
