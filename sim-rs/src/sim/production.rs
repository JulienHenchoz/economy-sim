//! Capacités et production.

use super::*;

impl Simulation {
    /// Capacité de production (lots/jour) ou de vente (unités/jour) de chaque entreprise.
    pub(super) fn compute_capacities(&mut self) {
        let mut n = [0.0f64; NJ];
        let mut raw: Vec<usize> = Vec::new();
        for b in self.alive_biz.iter().map(|&i| &self.businesses[i]) {
            if !b.alive {
                continue;
            }
            n[b.job] += b.workers.len() as f64;
        }
        let mut fish_demand = 0.0;
        let mut wood_demand = 0.0;
        let mut oil_demand = 0.0;
        let mut gas_demand = 0.0;
        let mut oil_b: Vec<usize> = Vec::new();
        let mut gas_b: Vec<usize> = Vec::new();
        let mut pop = 0.0;
        for a in self.alive_agents.iter().map(|&i| &self.agents[i]) {
            pop += if a.alive { 1.0 } else { 0.0 };
        }
        // infrastructures : ±10 % de productivité autour du niveau de référence
        let infra_f = 0.9 + 0.15 * mn(1.3, self.infra / mx(1.0, k::INFRA_PER_CAPITA * 100.0 * pop));
        for bi in self.ab() {
            if !self.businesses[bi].alive {
                continue;
            }
            let job = self.businesses[bi].job;
            let def = &JOB_DEFS[job];
            let nw = self.businesses[bi].workers.len() as f64;
            if nw == 0.0 {
                self.businesses[bi].potential = 0.0;
                continue;
            }
            let mut l = 0.0;
            for &id in &self.businesses[bi].workers {
                l += self.productivity(id) * infra_f;
            }
            let tools = self.businesses[bi].tools;
            let tool_f = if job == ENERGIE_VERTE {
                0.3 + 0.9 * mn(1.0, tools / nw)
            } else {
                1.0 + k::TOOL_BONUS * mn(1.0, tools / nw)
            };
            let scale_f = 1.0 + mn(k::SCALE_BONUS_MAX, k::SCALE_BONUS_PER_WORKER * (nw - 1.0));
            match def.cat {
                Cat::Commerce => {
                    self.businesses[bi].potential = k::SHOP_CAPACITY * l * (0.6 + 0.4 * mn(1.0, tools / nw)) * scale_f;
                    continue;
                }
                Cat::Sante => {
                    self.businesses[bi].potential = k::ACTS_PER_DOCTOR * l * (0.75 + 0.25 * mn(1.0, tools / nw));
                    continue;
                }
                Cat::Assurance => {
                    self.businesses[bi].potential = k::CONTRACTS_PER_INSURER * l * scale_f;
                    continue;
                }
                _ => {}
            }
            let mut nat = self.event_factor(job);
            if let Natural::Land(cap0) = def.natural {
                let cap = cap0 * (1.0 + self.land_bonus);
                nat *= if n[job] <= cap { 1.0 } else { sqrt(cap / n[job]) };
            }
            let mech_f = if mechanized(job) {
                1.0 + k::ENERGY_BONUS * mn(1.0, self.businesses[bi].inv.qty(ENERGIE) / (nw * k::ENERGY_PER_WORKER))
            } else {
                1.0
            };
            let mut pot = l * tool_f * scale_f * nat * mech_f * def.batches;
            match def.natural {
                Natural::Oil => {
                    pot *= mx(0.05, sqrt(self.oil_reserve / k::OIL_RESERVE));
                    oil_demand += pot;
                    oil_b.push(bi);
                }
                Natural::Gas => {
                    pot *= mx(0.05, sqrt(self.gas_reserve / k::GAS_RESERVE));
                    gas_demand += pot;
                    gas_b.push(bi);
                }
                Natural::Fish => {
                    pot *= pow(mn(1.0, self.fish_stock / (0.5 * k::FISH_K)), 0.7);
                    fish_demand += pot;
                    raw.push(bi);
                }
                Natural::Forest => {
                    pot *= pow(mn(1.0, self.forest_stock / (0.5 * k::FOREST_K)), 0.7);
                    wood_demand += pot;
                    raw.push(bi);
                }
                _ => {}
            }
            self.businesses[bi].potential = pot;
        }
        // stock naturel et quotas
        let p = &self.policy;
        let fish_max = mn(self.fish_stock * 0.5, if p.fishing_quota > 0.0 { p.fishing_quota } else { f64::INFINITY });
        let wood_max = mn(self.forest_stock * 0.5, if p.logging_quota > 0.0 { p.logging_quota } else { f64::INFINITY });
        let fish_f = if fish_demand > fish_max { fish_max / fish_demand } else { 1.0 };
        let wood_f = if wood_demand > wood_max { wood_max / wood_demand } else { 1.0 };
        for &bi in &raw {
            let f = if self.businesses[bi].job == PECHEUR { fish_f } else { wood_f };
            self.businesses[bi].potential *= f;
        }
        // gisements : on ne peut pas extraire plus que ce qui reste
        if oil_demand > self.oil_reserve {
            for &bi in &oil_b {
                self.businesses[bi].potential *= self.oil_reserve / oil_demand;
            }
        }
        if gas_demand > self.gas_reserve {
            for &bi in &gas_b {
                self.businesses[bi].potential *= self.gas_reserve / gas_demand;
            }
        }
        self.cap_by_good = [0.0; NG];
        self.shop_cap_total = 0.0;
        for b in self.alive_biz.iter().map(|&i| &self.businesses[i]) {
            if !b.alive || b.potential <= 0.0 {
                continue;
            }
            let def = &JOB_DEFS[b.job];
            if def.cat == Cat::Commerce {
                self.shop_cap_total += b.potential;
            }
            for &(g, q) in def.outputs {
                self.cap_by_good[g] += b.potential * q;
            }
        }
        self.shop_cap_total = mx(1.0, self.shop_cap_total);
    }

    pub(super) fn produce(&mut self) {
        let day = self.day as f64;
        for bi in self.ab() {
            if !self.businesses[bi].alive || self.businesses[bi].potential <= 0.0 {
                continue;
            }
            let job = self.businesses[bi].job;
            let def = &JOB_DEFS[job];
            if def.cat != Cat::Production && def.cat != Cat::Transformation {
                continue;
            }
            let mut batches = self.businesses[bi].potential;
            for &(g, q) in def.inputs {
                batches = mn(batches, self.businesses[bi].inv.qty(g) / q);
            }
            if def.cat == Cat::Transformation {
                batches = mn(batches, self.planned_batches(bi));
            }
            {
                let b = &mut self.businesses[bi];
                for &(g, q) in def.outputs {
                    b.prod_ema[g] = Some(b.prod_ema[g].unwrap_or(batches * q) * 0.85 + mx(0.0, batches) * q * 0.15);
                }
            }
            if batches <= 1e-6 {
                continue;
            }
            for &(g, q) in def.inputs {
                self.businesses[bi].inv.remove(g, batches * q);
            }
            // les machines consomment leur énergie au prorata de l'activité
            if mechanized(job) {
                let b = &self.businesses[bi];
                let e = mn(
                    b.inv.qty(ENERGIE),
                    b.workers.len() as f64 * k::ENERGY_PER_WORKER * mn(1.0, batches / mx(1e-6, b.potential)),
                );
                if e > 0.0 {
                    self.businesses[bi].inv.remove(ENERGIE, e);
                    self.d.energy_use[0] += e;
                }
            }
            for &(g, q) in def.outputs {
                let out = batches * q;
                self.businesses[bi].inv.add(g, out, day + GOOD_DEFS[g].shelf);
                self.d.production[g] = Some(self.d.production[g].unwrap_or(0.0) + out);
                if g == POISSON {
                    self.fish_stock = mx(10.0, self.fish_stock - out);
                }
                if g == BOIS {
                    self.forest_stock = mx(10.0, self.forest_stock - out);
                }
                if g == ENERGIE {
                    self.energy_produced(bi, out);
                }
            }
            for wi in 0..self.businesses[bi].workers.len() {
                let id = self.businesses[bi].workers[wi];
                let a = &mut self.agents[id];
                if !a.sick {
                    a.xp = mn(1.0, a.xp + 1.0 / 180.0);
                }
            }
        }
    }

    /// Énergie produite : épuisement des gisements, émissions et subvention à l'énergie verte.
    fn energy_produced(&mut self, bi: usize, out: f64) {
        let job = self.businesses[bi].job;
        let src = match job {
            PETROLIER => 0,
            GAZIER => 1,
            _ => 2,
        };
        self.d.energy_by_source[src] += out;
        if job == PETROLIER {
            self.oil_reserve = mx(0.0, self.oil_reserve - out);
        }
        if job == GAZIER {
            self.gas_reserve = mx(0.0, self.gas_reserve - out);
        }
        let em = out * emissions(job);
        self.pollution += em;
        self.d.emissions += em;
        if job == ENERGIE_VERTE && self.policy.green_subsidy > 0.0 {
            let need = round(out * self.policy.green_subsidy * 100.0 * self.index_factor());
            self.need_month[ENVIRONNEMENT] += need;
            let x = mn(round(need * self.budget_cut), mx(0.0, self.treasury));
            if x > 0.0 {
                self.state_out(ENVIRONNEMENT, x);
                self.businesses[bi].cash += x;
                self.businesses[bi].rev_month += x;
                self.flow(ETAT, F_PRODUCTION, x);
            }
        }
    }

    /// Un transformateur ne produit que ce qu'il pense vendre.
    pub(super) fn planned_batches(&self, bi: usize) -> f64 {
        let b = &self.businesses[bi];
        let def = &JOB_DEFS[b.job];
        let mut plan = f64::INFINITY;
        for &(g, q) in def.outputs {
            let unmet = mx(0.0, self.wholesale_unmet[g]) * ((b.potential * q) / mx(1e-6, self.cap_by_good[g]));
            let sales = b.out_sales[g].unwrap_or(b.potential * q) + unmet;
            let days = if GOOD_DEFS[g].shelf <= 4.0 { 1.5 } else { 5.0 };
            let target = sales * days + b.potential * q * 0.25;
            plan = mn(plan, mx(0.0, target - b.inv.qty(g)) / q);
        }
        mn(b.potential, plan)
    }
}
