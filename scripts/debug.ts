import { Simulation } from '../src/sim/sim';
import { RETAIL_GOODS, GOODS } from '../src/sim/config';
const sim = new Simulation({ seed: Number(process.argv[3] ?? 42) });
const days = Number(process.argv[2] ?? 20);
const every = Number(process.argv[4] ?? 1);
for (let i = 0; i < days; i++) {
  sim.step();
  if (sim.day % every) continue;
  const h = sim.history[sim.history.length - 1];
  console.log(`j${h.day} pop ${h.population} faim ${(h.hungerRate*100).toFixed(0)}% PIB ${h.gdp.toFixed(0)} gros ${h.wholesaleValue.toFixed(0)} santé ${h.avgHealth.toFixed(0)} État ${h.treasury.toFixed(0)} mén ${h.moneyHouseholds.toFixed(0)} entr ${h.moneyBusinesses.toFixed(0)}`);
  console.log('  détail: ' + RETAIL_GOODS.map(g => `${g.slice(0,6)} ${h.retailPrice[g]?.toFixed(2)}x${(h.retailVolume[g]??0).toFixed(0)} (manque ${(h.unmetDemand[g]??0).toFixed(0)})`).join(' | '));
  console.log('  gros  : ' + GOODS.map(g => `${g.slice(0,6)} ${h.wholesalePrice[g]?.toFixed(2)}x${(h.wholesaleVolume[g]??0).toFixed(0)} p${(h.production[g]??0).toFixed(0)} w${(h.waste[g]??0).toFixed(0)}`).join(' | '));
}
