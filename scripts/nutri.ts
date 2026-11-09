import { Simulation } from '../src/sim/sim';
import { FOOD_GOODS, GOOD_DEFS } from '../src/sim/config';
const sim = new Simulation({ seed: 42 });
for (let i = 0; i < Number(process.argv[2] ?? 120); i++) {
  sim.step();
  if (sim.day % 10) continue;
  const h = sim.history.slice(-10);
  let prod = 0, sold = 0, waste = 0, need = 0;
  for (const r of h) for (const g of FOOD_GOODS) {
    prod += (r.production[g] ?? 0) * GOOD_DEFS[g].nutrition / 10;
    sold += (r.retailVolume[g] ?? 0) * GOOD_DEFS[g].nutrition / 10;
    waste += (r.waste[g] ?? 0) * GOOD_DEFS[g].nutrition / 10;
  }
  for (const a of sim.agents) if (a.alive) need += sim.needOf(a);
  // potentiel brut si tout le blé/poisson/bétail/lait était transformé
  const r = h[h.length - 1];
  const raw = (r.production.ble ?? 0) * 1 + (r.production.poisson ?? 0) * 0.5 + (r.production.betail ?? 0) * 8 * 0.6 + (r.production.lait ?? 0) * 0.25 + (r.production.oeufs ?? 0) * 0.25 + (r.production.fruits ?? 0) * 0.2;
  const shops = sim.businesses.filter(b => b.alive && b.job === 'commercant' && b.workers.length);
  const shopStock = shops.reduce((s, b) => s + FOOD_GOODS.reduce((t, g) => t + (b.inv.get(g)?.reduce((u, x) => u + x.q, 0) ?? 0) * GOOD_DEFS[g].nutrition, 0), 0);
  const mk = shops.length ? shops.reduce((s, b) => s + (b.retail.pain ?? 1), 0) / shops.length : 0;
  console.log(`j${sim.day} besoin ${need.toFixed(0)} produit(final) ${prod.toFixed(0)} potentiel brut ${raw.toFixed(0)} vendu ${sold.toFixed(0)} gaspillé ${waste.toFixed(0)} stock commerces ${shopStock.toFixed(0)} marge pain moy ${mk.toFixed(2)} commerces ${shops.length}`);
}
