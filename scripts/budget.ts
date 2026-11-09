// Budget annuel de l'État : npx tsx scripts/budget.ts <années> <graine> ['{politique}']
import { Simulation, REV_KEYS, SPEND_KEYS } from '../src/sim/sim';
const years = Number(process.argv[2] ?? 3);
const seed = Number(process.argv[3] ?? 42);
const policy = process.argv[4] ? JSON.parse(process.argv[4]) : {};
const sim = new Simulation({ seed }, policy);
const k = (x: number) => (x / 1000).toFixed(0).padStart(5);
const kk = k;
for (let y = 1; y <= years; y++) {
  for (let d = 0; d < 360; d++) sim.step();
  const h = sim.history.slice(-360);
  const sum = (f: (r: (typeof h)[0]) => number) => h.reduce((s, r) => s + f(r), 0);
  const gdp = sum((r) => r.gdp);
  const rev = Object.fromEntries(REV_KEYS.map((x) => [x, sum((r) => (r.revenue as any)[x])]));
  const sp = Object.fromEntries(SPEND_KEYS.map((x) => [x, sum((r) => (r.spending as any)[x])]));
  const R = Object.values(rev).reduce((a, b) => a + b, 0);
  const S = Object.values(sp).reduce((a, b) => a + b, 0);
  const last = h[h.length - 1] as any;
  console.log(`année ${y} : PIB ${k(gdp)} k | recettes ${k(R)} k | dépenses ${k(S)} k | solde ${((R - S) / gdp * 100).toFixed(1)} % PIB | trésorerie ${k(last.treasury)} k | pop ${last.population} | Gini ${last.giniWealth.toFixed(2)} | IPC ${last.cpi.toFixed(0)}` + (last.debt !== undefined ? ` | dette ${k(last.debt)} k (${(last.debtRatio * 100).toFixed(1)} %) taux ${(last.avgRate * 100).toFixed(1)} %` : ''));
  console.log('   recettes : ' + REV_KEYS.map((x) => `${x} ${k(rev[x])}`).join(' '));
  console.log('   dépenses : ' + SPEND_KEYS.map((x) => `${x} ${k(sp[x])}`).join(' '));
  const b = (sim as any).budget;
  if (b) console.log(`   budget (j${b.day}) : recettes prévues ${k(b.revenue / 100)} déficit permis ${k(b.allowedDeficit / 100)} voté ${k(b.planned / 100)} coupe ${b.cut.toFixed(2)} | besoins ` + Object.entries(b.needs).filter(([, v]) => v).map(([x, v]) => `${x} ${k((v as number) / 100)}`).join(' '));
  console.log(`   monnaie : ménages ${k(last.moneyHouseholds * 100)} entreprises ${k(last.moneyBusinesses * 100)} État ${k(last.treasury * 100)} | actifs nets : ménages ${k(last.nfaHouseholds * 100 || 0)} entreprises ${k(last.nfaBusinesses * 100 || 0)} | détenteurs ${(last.debtHolders ?? []).map((x: number) => (x * 100).toFixed(0)).join('/')} | coupe ${(last.budgetCut ?? 1).toFixed(2)}`);
}
