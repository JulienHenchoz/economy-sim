// Plusieurs graines, résumé annuel : npm run multi -- <années> <graines...>
import { Simulation } from '../src/sim/sim';
const years = Number(process.argv[2] ?? 6);
const seeds = process.argv.slice(3).map(Number);
// politique optionnelle : POLICY='{"secuRate":0}' npx tsx scripts/multi.ts 6 1
const policy = process.env.POLICY ? JSON.parse(process.env.POLICY) : {};
for (const seed of seeds.length ? seeds : [1, 2, 3]) {
  const sim = new Simulation({ seed }, policy);
  const out: string[] = [];
  for (let y = 1; y <= years; y++) {
    for (let d = 0; d < 360; d++) sim.step();
    const h = sim.history.slice(-360);
    const avg = (f: (r: (typeof h)[0]) => number) => h.reduce((s, r) => s + f(r), 0) / h.length;
    const last = h[h.length - 1];
    const deaths = h.reduce((s, r) => s + r.deaths.faim, 0);
    const births = h.reduce((s, r) => s + r.births, 0);
    const dAll = h.reduce((s, r) => s + r.deaths.faim + r.deaths.age + r.deaths.maladie, 0);
    const rev = h.reduce((s, r) => s + Object.values(r.revenue).reduce((a, b) => a + b, 0), 0);
    const spend = h.reduce((s, r) => s + Object.values(r.spending).reduce((a, b) => a + b, 0), 0);
    const gdp = h.reduce((s, r) => s + r.gdp, 0);
    const tdays = (avg((r) => r.treasury) / Math.max(1, spend)) * 360;
    const debt = last.debtRatio !== undefined ? ` PIB ${(gdp / 1000).toFixed(0)}k déf ${(((spend - rev) / gdp) * 100).toFixed(1)}% dette ${(last.debtRatio * 100).toFixed(0)}% taux ${(avg((r) => r.lastRate) * 100).toFixed(1)}% trés ${tdays.toFixed(0)}j coupe ${last.budgetCut.toFixed(2)} | dir ${(last.policyRate * 100).toFixed(1)}% infl ${(last.inflation * 100).toFixed(0)}% crédit ${(last.bankLoans / 1000).toFixed(0)}k BC ${(last.cbDebt / 1000).toFixed(0)}k étr ${(last.foreignDebt / 1000).toFixed(0)}k M ${(last.moneyTotal / 1000).toFixed(0)}k` : '';
    out.push(`a${y}: pop ${last.population} faim ${(avg((r) => r.hungerRate) * 100).toFixed(0)}% (†faim ${deaths}/${dAll}, nais ${births}) IPC ${avg((r) => r.cpi).toFixed(0)} G ${last.giniWealth.toFixed(2)}${debt}`);
    if (sim.moneyError !== 0) out.push(`!! masse monétaire : écart ${sim.moneyError}`);
    if (!last.population) break;
  }
  console.log(`graine ${seed}\n   ` + out.join('\n   '));
}
