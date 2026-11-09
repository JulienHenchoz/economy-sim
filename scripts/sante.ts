// Marché des soins : npx tsx scripts/sante.ts <jours> <graine> <tous les N jours> [politique JSON]
import { Simulation } from '../src/sim/sim';
const days = Number(process.argv[2] ?? 1080);
const seed = Number(process.argv[3] ?? 42);
const every = Number(process.argv[4] ?? 90);
const policy = process.argv[5] ? JSON.parse(process.argv[5]) : {};
const sim = new Simulation({ seed }, policy);
for (let i = 0; i < days; i++) {
  sim.step();
  if (sim.moneyError !== 0) { console.error(`!! masse monétaire non conservée au jour ${sim.day}`); process.exit(1); }
  if (sim.day % every) continue;
  const h = sim.history.slice(-every);
  const last = h[h.length - 1];
  const m = (f: (r: (typeof h)[0]) => number) => h.reduce((s, r) => s + f(r), 0) / h.length;
  const sum = (f: (r: (typeof h)[0]) => number) => h.reduce((s, r) => s + f(r), 0);
  const docs = sim.businesses.filter((b) => b.alive && b.job === 'medecin' && b.workers.length);
  const ins = sim.businesses.filter((b) => b.alive && b.job === 'assureur' && b.workers.length);
  const f = (x: number, d = 1) => x.toFixed(d);
  console.log(`j${last.day} pop ${last.population} santé ${f(last.avgHealth)} malades ${f(m((r) => r.sickRate) * 100)}% | méd ${last.workersByJob.medecin} (${docs.length} cab) rev ${f(last.incomeByJob.medecin)} vs moy ${f(sim.avgIncome / 100)} | honoraires ${f(last.avgFee, 2)} é/acte | actes/j ${f(m((r) => r.careActs))} refus prix ${f(m((r) => r.careDenied))} sans méd ${f(m((r) => r.careNoDoctor))}`);
  console.log(`    dépense soins/j ${f(m((r) => r.careSpend.menages + r.careSpend.secu + r.careSpend.assurance))} (ménages ${f(m((r) => r.careSpend.menages))} sécu ${f(m((r) => r.careSpend.secu))} assur ${f(m((r) => r.careSpend.assurance))}) PIB/j ${f(m((r) => r.gdp), 0)} | assurés ${f(last.insuredRate * 100, 0)}% assureurs ${last.workersByJob.assureur} (${ins.length}) rev ${f(last.incomeByJob.assureur)} prime ${f(last.avgPremium, 2)} é/mois | cotis ${f(sum((r) => r.revenue.cotisationsSante), 0)} rembours ${f(sum((r) => r.spending.remboursementsSante), 0)} subsides ${f(sum((r) => r.spending.subsidesPrimes), 0)} | †mal ${sum((r) => r.deaths.maladie)} †âge ${sum((r) => r.deaths.age)} †faim ${sum((r) => r.deaths.faim)}`);
  for (const b of ins) console.log(`    assureur ${b.id}: ${b.workers.length} trav, ${b.insuredN} assurés, prime ${(b.premium / 100).toFixed(2)}, sinistres/u ${(b.claimsPerUnit / 100).toFixed(2)}, marge ${b.markup.toFixed(2)}, caisse ${(b.cash / 100).toFixed(0)}, va ${(b.vaEma / 100).toFixed(1)}`);
}

