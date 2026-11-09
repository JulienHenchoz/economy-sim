// Vérifie qu'un instantané restauré reproduit exactement la même suite.
import { Simulation, saveState, restoreState } from '../src/sim/sim';
import v8 from 'node:v8';
const sim = new Simulation({ seed: 5 });
while (sim.day < 360) sim.step();
const st = saveState(sim);
console.log('taille instantané', (v8.serialize(st).length / 1e6).toFixed(2), 'Mo');
while (sim.day < 420) sim.step();
const b = restoreState(st, sim.history.slice(0, 361));
while (b.day < 420) b.step();
const a1 = sim.history[sim.history.length - 1], b1 = b.history[b.history.length - 1];
console.log('jour', a1.day, b1.day, 'pop', a1.population, b1.population, 'pib', a1.gdp, b1.gdp, 'gini', a1.giniWealth, b1.giniWealth);
console.log(JSON.stringify(a1) === JSON.stringify(b1) ? 'IDENTIQUE' : 'DIFFÉRENT');
console.log('gazette:', sim.news.slice(-6).map((n) => `j${n.day} ${n.text}`).join('\n'));
const s = sim.snapshot();
console.log('mobilité', JSON.stringify(s.mobility), s.mobilityYears, 'p90/p10', a1.p90p10.toFixed(2));
console.log('carte', sim.mapState().agents.length, 'agents');
