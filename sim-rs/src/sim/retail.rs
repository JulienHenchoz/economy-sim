//! Marché de détail, autoconsommation, consommation des ménages, IPC.

use super::*;
use crate::market::{call_auction, Order};

impl Simulation {
    pub(super) fn retail_market(&mut self) {
        let prev_prices = self.last_r;
        let vat = self.policy.vat;
        let day = self.day as f64;
        let mut bids: Vec<Vec<Order>> = (0..NG).map(|_| Vec::new()).collect();
        let mut asks: Vec<Vec<Order>> = (0..NG).map(|_| Vec::new()).collect();
        let mut offered: Vec<(usize, GoodOpt)> = Vec::new();

        crate::prof!(20, {
        for bi in self.ab() {
            {
                let b = &self.businesses[bi];
                if !b.alive || JOB_DEFS[b.job].cat != Cat::Commerce || b.workers.is_empty() {
                    continue;
                }
            }
            let w = self.retail_weights(bi);
            let mut off: GoodOpt = NO_GOODS;
            let mut tot = 0.0;
            let potential = self.businesses[bi].potential;
            for g in RETAIL_GOODS {
                let x = mn(self.businesses[bi].inv.qty(g), potential * w[g] * 1.6);
                off[g] = Some(x);
                tot += x;
            }
            let sc = if tot > potential { potential / tot } else { 1.0 };
            for g in RETAIL_GOODS {
                let q = off[g].unwrap() * sc;
                if q <= 1e-6 {
                    off[g] = None;
                    continue;
                }
                off[g] = Some(q);
                let exp = mn(q, self.businesses[bi].inv.expiring_by(g, day));
                let p = self.retail_of(bi, g);
                if exp > 1e-6 {
                    asks[g].push(Order::tagged(bi as i64, exp, mx(1.0, p * 0.6), 1));
                }
                if q - exp > 1e-6 {
                    let pr = mx(1.0, p * self.rng.range(0.97, 1.03));
                    asks[g].push(Order::new(bi as i64, q - exp, pr));
                }
            }
            offered.push((bi, off));
        }

        });
        crate::prof!(21, {
        // ménages
        let mut tot_money = 0.0;
        let mut n_ad = 0.0;
        for a in self.alive_agents.iter().map(|&i| &self.agents[i]) {
            if a.alive && a.status != Status::Enfant {
                tot_money += a.money;
                n_ad += 1.0;
            }
        }
        self.mean_money = mx(100.0, tot_money / mx(1.0, n_ad));
        // valeurs communes à tous les foyers (les prix ne bougent pas pendant la prise d'ordres)
        let cpn = self.cost_per_nutrition();
        let mut nut_value = [0.0; NG];
        for g in FOOD_GOODS {
            nut_value[g] = pow(GOOD_DEFS[g].nutrition / mx(1.0, self.last_r[g]), 1.5);
        }
        let s_e = pow(self.last_r[ENERGIE], -3.0);
        let s_b = pow(self.last_r[BOIS], -3.0);
        for a in self.aa() {
            if !self.is_head(a) {
                continue;
            }
            let need = self.household_need(a);
            crate::prof!(25, { self.self_consume(a, need); });
            let mut stock_nut = 0.0;
            for g in FOOD_GOODS {
                stock_nut += self.agents[a].food.qty(g) * GOOD_DEFS[g].nutrition;
            }
            let money = self.agents[a].money;
            // loi d'Engel simplifiée
            let affluence = clamp(money / mx(1.0, need * cpn * 60.0) - 1.0, 0.0, 1.0);
            self.agents[a].appetite = 0.3 * affluence;
            let want = mx(0.0, need * (1.0 + self.agents[a].appetite) * k::FOOD_BUFFER_DAYS - stock_nut);
            let u = self.agents[a].hunger;
            let wf = 1.0 + 0.12 * log10(1.0 + money / self.mean_money);
            let dm = (self.day % 30) as f64;
            let day_in_month = if dm == 0.0 { 30.0 } else { dm };
            let daily_income = mx(self.agents[a].last_income / k::DAYS_PER_MONTH, self.agents[a].income / day_in_month);
            let mut orders: Vec<(Good, f64, f64)> = Vec::new();
            if std::env::var("TRACE_DAY").ok().and_then(|x| x.parse::<i64>().ok()) == Some(self.day) && (a == 19 || a == 61) {
                let food: Vec<String> = self.agents[a].food.iter().map(|(g, b)| format!("[\"{}\",[{}]]", GOOD_IDS[g], b.iter().map(|x| format!("[{},{}]", js_num(x.q), js_num(x.exp))).collect::<Vec<_>>().join(","))).collect();
                println!("H {} need {} stock {} want {} money {} app {} u {} wf {} food [{}]", a, js_num(need), js_num(stock_nut), js_num(want), js_num(money), js_num(self.agents[a].appetite), js_num(u), js_num(wf), food.join(","));
            }
            if want > 0.01 {
                let mut s_score = 0.0;
                let mut score = [0.0; NG];
                for g in FOOD_GOODS {
                    score[g] = self.agents[a].prefs[g].unwrap_or(0.1) * nut_value[g];
                    s_score += score[g];
                }
                for g in FOOD_GOODS {
                    let q = (want * score[g]) / s_score / GOOD_DEFS[g].nutrition;
                    if q < 0.01 {
                        continue;
                    }
                    // surenchère modeste (même affamé)
                    let p = mx(1.0, self.last_r[g] * (1.03 + 0.12 * u) * wf * self.rng.range(0.97, 1.04));
                    orders.push((g, q, p));
                }
            }
            let mut cost = 0.0;
            for o in &orders {
                cost += o.1 * o.2;
            }
            // la nourriture passe avant tout : jusqu'au quart de l'épargne par jour (90 % si affamé)
            let budget = money * (0.25 + 0.65 * mn(1.0, u * 3.0));
            let sc = if cost > budget { budget / mx(1.0, cost) } else { 1.0 };
            let mut spent = 0.0;
            for &(g, q0, p) in &orders {
                let q = q0 * sc;
                if q < 0.005 {
                    continue;
                }
                bids[g].push(Order::new(a as i64, q, p));
                spent += q * p;
            }
            // confort (artisanat)
            let food_cost_day = need * cpn;
            let free = money * 0.95 - spent;
            let disc = mn(free, mx(0.0, 0.1 * daily_income + (money - food_cost_day * k::SAVINGS_BUFFER_DAYS) / 120.0));
            if disc > 1.0 && self.agents[a].hunger < 0.1 {
                let p = self.last_r[ARTISANAT] * self.rng.range(0.97, 1.08);
                let q = disc / p;
                if q > 0.005 {
                    bids[ARTISANAT].push(Order::new(a as i64, q, p));
                    spent += q * p;
                }
            }
            // chauffage, après la nourriture : bois et énergie (part ∝ prix^-3)
            let hs = self.household_size(a);
            let heat = self.heat_need(a, hs) * 4.0 - self.agents[a].food.qty(BOIS) - self.agents[a].food.qty(ENERGIE);
            if heat > 0.05 {
                let heat_budget = mn(mx(0.0, money * 0.95 - spent), 0.1 * (daily_income + money / 30.0) * 4.0);
                let cold = self.agents[a].cold;
                for (fuel, w) in [(ENERGIE, s_e / (s_e + s_b)), (BOIS, s_b / (s_e + s_b))] {
                    let p = self.last_r[fuel] * (if cold { 1.04 } else { 1.01 }) * self.rng.range(0.97, 1.03);
                    let q = mn(heat * w, (heat_budget * w) / p);
                    if q > 0.01 {
                        bids[fuel].push(Order::new(a as i64, q, p));
                    }
                }
            }
        }

        });
        let mut sold: Vec<[f64; NG]> = vec![[0.0; NG]; self.businesses.len()];
        if std::env::var("TRACE_DAY").ok().and_then(|x| x.parse::<i64>().ok()) == Some(self.day) {
            for g in RETAIL_GOODS {
                for o in &bids[g] { println!("B {} {} {} {}", GOOD_IDS[g], o.owner, crate::util::js_num(o.qty), crate::util::js_num(o.price)); }
                for o in &asks[g] { println!("A {} {} {} {}", GOOD_IDS[g], o.owner, crate::util::js_num(o.qty), crate::util::js_num(o.price)); }
            }
        }
        crate::prof!(22, {
        for g in RETAIL_GOODS {
            let res = call_auction(&mut bids[g], &mut asks[g], &mut self.rng);
            let prev_r = self.last_r[g];
            let mut filled_q = 0.0;
            if let Some(p) = res.price {
                let mut vol = 0.0;
                for m in &res.matches {
                    let a = bids[g][m.bid].owner as usize;
                    let shop = asks[g][m.ask].owner as usize;
                    let mut q = m.qty;
                    let mut cost = round(p * q);
                    let money = self.agents[a].money;
                    if cost > money {
                        q = money / p;
                        cost = mn(money, round(p * q));
                    }
                    if q <= 1e-6 || cost <= 0.0 {
                        continue;
                    }
                    self.businesses[shop].inv.move_to(g, q, &mut self.agents[a].food);
                    let tax = round((cost * vat) / (1.0 + vat));
                    self.agents[a].money -= cost;
                    {
                        let s = &mut self.businesses[shop];
                        s.cash += cost - tax;
                        s.rev_day += cost - tax;
                        s.rev_month += cost - tax;
                    }
                    self.collect(TVA, tax);
                    self.flow(MENAGES, F_COMMERCE, cost);
                    self.flow(F_COMMERCE, ETAT, tax);
                    sold[shop][g] += q;
                    vol += q;
                    self.d.gdp += cost;
                }
                filled_q = vol;
                if vol > 0.0 {
                    self.last_r[g] = p;
                    self.d.retail_volume[g] = Some(vol);
                }
            }
            let unmet = mx(0.0, res.demand - filled_q);
            self.d.unmet[g] = Some(unmet);
            // file d'attente devant des rayons vides : le prix de référence ne baisse pas
            let short = if res.demand > 0.0 { unmet / res.demand } else { 0.0 };
            if short > 0.5 {
                self.last_r[g] = mx(self.last_r[g], prev_r);
            }
            // aucune vente alors que des commerces proposent : tâtonnement vers l'offre la moins chère
            let al = &asks[g];
            if res.price.is_none() && !al.is_empty() && res.demand > 0.0 {
                let mut min_ask = f64::INFINITY;
                for o in al {
                    min_ask = mn(min_ask, o.price);
                }
                if min_ask > self.last_r[g] {
                    self.last_r[g] += 0.1 * (min_ask - self.last_r[g]);
                }
            }
            self.retail_demand[g] = res.demand;
            self.retail_unmet[g] = unmet;
        }
        });
        crate::prof!(23, {
        for (id, off) in &offered {
            let id = *id;
            for g in RETAIL_GOODS {
                let s = sold[id][g];
                {
                    let b = &mut self.businesses[id];
                    b.sales_ema[g] = Some(b.sales_ema[g].unwrap_or(s) * 0.85 + s * 0.15);
                }
                let q = match off[g] {
                    Some(q) if q != 0.0 && !q.is_nan() => q,
                    _ => continue,
                };
                // marge : monte si tout part et que le rayon est vide, baisse s'il reste des invendus
                let f = s / q;
                let mut m = self.markup_of(id, g);
                let b = &self.businesses[id];
                let stock_days = b.inv.qty(g) / mx(0.5, b.sales_ema[g].unwrap_or(0.0));
                let target = if GOOD_DEFS[g].shelf <= 4.0 { 0.5 } else { 3.0 };
                let shortage = self.retail_unmet[g] > 0.05 * mx(1.0, self.retail_demand[g]);
                m -= 0.01 * (m - 1.1);
                if f >= 0.98 && shortage {
                    m *= 1.0 + self.rng.range(0.005, 0.03);
                } else if stock_days > target {
                    m *= 1.0 - self.rng.range(0.01, 0.04) * mn(1.0, (stock_days - target) / (target + 1.0));
                }
                self.businesses[id].retail[g] = Some(clamp(m, 1.0, 1.6));
            }
        }
        });
        crate::prof!(24, { self.update_cpi(&prev_prices); });
    }

    /// Autoconsommation : un indépendant qui produit de la nourriture en prélève pour son foyer.
    fn self_consume(&mut self, a: usize, need: f64) {
        let bz = self.agents[a].biz;
        if bz < 0 {
            return;
        }
        let bi = bz as usize;
        {
            let b = &self.businesses[bi];
            if b.owner != a as i64 || b.workers.len() != 1 || JOB_DEFS[b.job].cat == Cat::Commerce {
                return;
            }
        }
        let mut have = 0.0;
        for g in FOOD_GOODS {
            have += self.agents[a].food.qty(g) * GOOD_DEFS[g].nutrition;
        }
        let mut missing = need - have;
        for g in FOOD_GOODS {
            if missing <= 0.0 {
                break;
            }
            let avail = self.businesses[bi].inv.qty(g);
            if avail <= 0.0 {
                continue;
            }
            let nut = GOOD_DEFS[g].nutrition;
            let q = mn(avail, missing / nut);
            let got = self.businesses[bi].inv.take(g, q);
            self.agents[a].food.add_batches(g, &got);
            missing -= q * nut;
            self.d.self_consumed += q * nut;
        }
    }

    /// Coût moyen d'une unité de nutrition au détail (centimes), panier type.
    pub fn cost_per_nutrition(&self) -> f64 {
        let mut best = f64::INFINITY;
        let mut avg = 0.0;
        let mut n = 0.0;
        for g in FOOD_GOODS {
            let c = self.last_r[g] / GOOD_DEFS[g].nutrition;
            best = mn(best, c);
            avg += c;
            n += 1.0;
        }
        (best + avg / n) / 2.0
    }

    pub(super) fn consume(&mut self) {
        for a in self.aa() {
            if !self.is_head(a) {
                continue;
            }
            let mut members = vec![a];
            members.extend(self.dependents(a));
            let mut need = 0.0;
            for &m in &members {
                need += self.need_of(m);
            }
            let eat = need * (1.0 + self.agents[a].appetite);
            let mut got = 0.0;
            // manger d'abord ce qui périme le plus vite
            let mut order: Vec<Good> = FOOD_GOODS.iter().copied().filter(|&g| self.agents[a].food.qty(g) > 1e-9).collect();
            {
                let food = &self.agents[a].food;
                order.sort_by(|&x, &y| ord(food.first_exp(x) - food.first_exp(y)));
            }
            for g in order {
                if got >= eat - 1e-9 {
                    break;
                }
                let nut = GOOD_DEFS[g].nutrition;
                let food = &mut self.agents[a].food;
                let q = mn(food.qty(g), (eat - got) / nut);
                food.remove(g, q);
                got += q * nut;
            }
            let r = if need > 0.0 { mn(1.0, got / need) } else { 1.0 };
            {
                let food = &mut self.agents[a].food;
                let art = food.qty(ARTISANAT);
                if art > 0.0 {
                    food.remove(ARTISANAT, art * k::COMFORT_WEAR);
                }
            }
            // chauffage : bois ou énergie ; un logement social isolé en demande moitié moins
            let heat_need = self.heat_need(a, members.len() as f64);
            let en = mn(heat_need, self.agents[a].food.qty(ENERGIE));
            self.agents[a].food.remove(ENERGIE, en);
            self.d.energy_use[1] += en;
            let wood = mn(heat_need - en, self.agents[a].food.qty(BOIS));
            self.agents[a].food.remove(BOIS, wood);
            let cold = en + wood < heat_need * 0.8;
            if cold {
                self.d.cold += members.len() as f64;
            }
            for &m in &members {
                let ag = &mut self.agents[m];
                ag.fed = r;
                ag.hunger = ag.hunger * 0.75 + (1.0 - r) * 0.25;
                ag.cold = cold;
            }
        }
    }

    /// Besoin de chauffage d'un foyer (unités de bois ou d'énergie par jour).
    pub(super) fn heat_need(&self, head: usize, members: f64) -> f64 {
        members * k::FIREWOOD_PER_PERSON * (if self.is_housed(head) { 0.5 } else { 1.0 })
    }

    /// Mise à jour de l'IPC chaîné après le marché de détail.
    fn update_cpi(&mut self, prev: &[f64; NG]) {
        let mut spend = 0.0;
        let mut today = [0.0; NG];
        for &(g, _) in &self.cpi_share {
            today[g] = self.d.retail_volume[g].unwrap_or(0.0) * self.last_r[g];
            spend += today[g];
        }
        let mut dlog = 0.0;
        let mut tot = 0.0;
        for e in self.cpi_share.iter_mut() {
            if spend > 0.0 {
                e.1 = e.1 * (29.0 / 30.0) + (today[e.0] / spend) / 30.0;
            }
            tot += e.1;
        }
        for &(g, s) in &self.cpi_share {
            if prev[g] > 0.0 && self.last_r[g] > 0.0 {
                dlog += (s / tot) * ln(self.last_r[g] / prev[g]);
            }
        }
        self.cpi_chain *= exp(dlog);
    }
}
