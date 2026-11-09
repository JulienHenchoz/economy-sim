// Énergie, services et équipements publics : npx tsx scripts/services.ts <jours> <graine> [pas] ['{politique}']
import { Simulation } from '../src/sim/sim';
const days = Number(process.argv[2] ?? 1080);
const seed = Number(process.argv[3] ?? 42);
const every = Number(process.argv[4] ?? 90);
const policy = process.argv[5] ? JSON.parse(process.argv[5]) : {};
const sim = new Simulation({ seed }, policy);
const f = (x: number, d = 0) => x.toFixed(d);
while (sim.day < days) {
  sim.step();
  if (sim.day % every) continue;
  const h = sim.history.slice(-every);
  const avg = (fn: (r: (typeof h)[0]) => number) => h.reduce((s, r) => s + fn(r), 0) / h.length;
  const r = h[h.length - 1];
  const w = r.workersByJob;
  console.log(
    `j${r.day} pop ${r.population} faim ${f(avg((x) => x.hungerRate) * 100, 1)}% | énergie/j pétrole ${f(avg((x) => x.energyBySource.petrole))} gaz ${f(avg((x) => x.energyBySource.gaz))} vert ${f(avg((x) => x.energyBySource.vert))} → machines ${f(avg((x) => x.energyUse.machines))} ménages ${f(avg((x) => x.energyUse.menages))} prix gros ${f(r.wholesalePrice.energie ?? 0, 2)} détail ${f(r.retailPrice.energie ?? 0, 2)} bois ${f(r.retailPrice.bois ?? 0, 2)}` +
      ` | travailleurs pét ${w.petrolier} gaz ${w.gazier} vert ${w.energieVerte} | pollution ${f(r.pollution, 2)} gisements ${f(r.oilLeft * 100)}%/${f(r.gasLeft * 100)}%` +
      ` | public ens ${w.enseignant} adm ${w.administrateur} pol ${w.policier} inf ${w.infirmier} gar ${w.garde} TP ${w.cantonnier} | impôts perçus ${f(r.taxEff * 100)}% infra ${f(r.infraCov, 2)} logements ${r.socialHousing} terres +${f(r.landBonus * 100, 1)}% silo ${f(r.siloStock)} école ${f(r.schoolCov, 2)} culture ${f(r.cultureCov, 2)}` +
      ` | vols/j ${f(avg((x) => x.thefts), 2)} froid ${f(avg((x) => x.coldRate) * 100, 1)}% pauvres ${f(r.poorRate * 100)}% blé ${f(r.wholesalePrice.ble ?? 0, 2)}`,
  );
}
