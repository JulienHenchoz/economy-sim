// Lance la simulation sans interface pour calibrer le modèle : npm run headless -- <jours> <graine>
import { Simulation } from '../src/sim/sim';
import { JOBS, RETAIL_GOODS } from '../src/sim/config';

const days = Number(process.argv[2] ?? 1800);
const seed = Number(process.argv[3] ?? 42);
const every = Number(process.argv[4] ?? 90);
const sim = new Simulation({ seed });
const t0 = Date.now();
for (let i = 0; i < days; i++) {
  sim.step();
  if (sim.moneyError !== 0) {
    console.error(`!! masse monétaire non conservée au jour ${sim.day} : écart ${sim.moneyError} centimes`);
    process.exit(1);
  }
  if (sim.day % every === 0) {
    const h = sim.history[sim.history.length - 1];
    const f = (x: number, d = 0) => x.toFixed(d);
    const mean = (k: 'gdp' | 'hungerRate') => sim.history.slice(-30).reduce((s, r) => s + r[k], 0) / 30;
    console.log(
      `j${h.day} pop ${h.population} (enf ${h.enfants} act ${h.actifs} chô ${h.chomeurs} ret ${h.retraites}) ` +
        `PIB ${f(mean('gdp'))} faim ${f(mean('hungerRate') * 100, 1)}% santé ${f(h.avgHealth)} ` +
        `Gini P ${f(h.giniWealth, 2)} R ${f(h.giniIncome, 2)} top10 ${f(h.top10Wealth * 100)}% ` +
        `État ${f(h.treasury)} payé ${f(h.paidRatio, 2)} IPC ${f(h.cpi)} entr ${h.firms} (max ${h.biggestFirm}) poisson ${f(h.fishStock / 240)}% forêt ${f(h.forestStock / 600)}%`,
    );
    console.log('   prix détail : ' + RETAIL_GOODS.map((g) => `${g} ${h.retailPrice[g]?.toFixed(2)}`).join(' '));
    console.log('   emplois    : ' + JOBS.map((j) => `${j.slice(0, 5)} ${h.workersByJob[j]}/${h.incomeByJob[j].toFixed(1)}`).join(' '));
    const d = sim.history.slice(-every);
    const deaths = d.reduce((s, r) => ({ age: s.age + r.deaths.age, faim: s.faim + r.deaths.faim, maladie: s.maladie + r.deaths.maladie }), { age: 0, faim: 0, maladie: 0 });
    const births = d.reduce((s, r) => s + r.births, 0);
    console.log(`   naissances ${births} décès âge ${deaths.age} faim ${deaths.faim} maladie ${deaths.maladie}`);
  }
}
console.log(`${days} jours en ${Date.now() - t0} ms`);
