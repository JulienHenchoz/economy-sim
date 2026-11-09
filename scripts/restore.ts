// Vérifie qu'un instantané restauré reproduit exactement la même suite : au jour 360 (fin de la
// première année) et au jour 1000 (dette, crédits bancaires et obligations de la banque centrale en cours).
import { Simulation, saveState, restoreState } from '../src/sim/sim';
import v8 from 'node:v8';
const sim = new Simulation({ seed: 5 });
let ok = true;
for (const at of [360, 1000]) {
  while (sim.day < at) sim.step();
  const st = saveState(sim);
  console.log(`jour ${at} : taille instantané ${(v8.serialize(st).length / 1e6).toFixed(2)} Mo, dette ${sim.debtTotal}, crédits ${sim.loans.length}, monnaie créée ${JSON.stringify(sim.moneyCreated)}`);
  while (sim.day < at + 60) sim.step();
  const b = restoreState(st, sim.history.slice(0, at + 1));
  while (b.day < at + 60) b.step();
  const a1 = sim.history[sim.history.length - 1], b1 = b.history[b.history.length - 1];
  const same = JSON.stringify(a1) === JSON.stringify(b1) && sim.moneyError === 0 && b.moneyError === 0;
  ok &&= same;
  console.log(`  jour ${a1.day}/${b1.day} pop ${a1.population}/${b1.population} pib ${a1.gdp}/${b1.gdp} dette ${a1.debt}/${b1.debt} → ${same ? 'IDENTIQUE' : 'DIFFÉRENT'}`);
}
console.log(ok ? 'IDENTIQUE' : 'DIFFÉRENT');
console.log('gazette:', sim.news.slice(-6).map((n) => `j${n.day} ${n.text}`).join('\n'));
const s = sim.snapshot();
console.log('mobilité', JSON.stringify(s.mobility), s.mobilityYears, 'p90/p10', sim.history[sim.history.length - 1].p90p10.toFixed(2));
console.log('carte', sim.mapState().agents.length, 'agents');
