//! Marché de gros, silo public, achats publics, apprentissage des prix.

use super::*;
use crate::market::{call_auction, Order};

/// Achat public en cours : poste budgétaire, bien, quantité voulue.
#[derive(Clone, Copy)]
pub(super) struct PublicOrder {
    pub k: SpendKey,
    pub g: Good,
    pub q: f64,
}

pub(super) struct PublicWant {
    pub g: Good,
    pub q: f64,
    pub p: f64,
    pub parts: Vec<PublicOrder>,
}

/// Ensemble ordonné de (bien, quantité), comme un objet JS dont on garde l'ordre des clés.
type GoodList = Vec<(Good, f64)>;
fn set_good(l: &mut GoodList, g: Good, q: f64) {
    if let Some(x) = l.iter_mut().find(|x| x.0 == g) {
        x.1 = q;
    } else {
        l.push((g, q));
    }
}

fn js_max_list(it: impl IntoIterator<Item = f64>) -> f64 {
    let mut m = f64::NEG_INFINITY;
    for x in it {
        m = mx(m, x);
    }
    m
}

impl Simulation {
    pub(super) fn wholesale_market(&mut self) {
        let mut bids: Vec<Vec<Order>> = (0..NG).map(|_| Vec::new()).collect();
        let mut asks: Vec<Vec<Order>> = (0..NG).map(|_| Vec::new()).collect();
        let mut offered: Vec<(usize, GoodList)> = Vec::new();
        let mut wanted: Vec<(usize, GoodList)> = Vec::new();
        let vat = self.policy.vat;
        let day = self.day as f64;

        for bi in self.ab() {
            if !self.businesses[bi].alive {
                continue;
            }
            let job = self.businesses[bi].job;
            let def = &JOB_DEFS[job];
            let nw = self.businesses[bi].workers.len() as f64;
            // charpentier : se sert d'abord dans sa production pour s'équiper
            if job == CHARPENTIER && self.businesses[bi].tools < nw {
                let b = &mut self.businesses[bi];
                let take = mn(nw - b.tools, b.inv.qty(OUTILS));
                if take > 0.0 {
                    b.inv.remove(OUTILS, take);
                    b.tools += take;
                }
            }
            // --- offres de vente : tout ce qui n'est pas un intrant (ni un bien de détail pour un commerçant)
            let mut off: GoodList = Vec::new();
            let goods: Vec<Good> = self.businesses[bi].inv.goods().collect();
            for g in goods {
                if def.input(g).is_some() {
                    continue;
                }
                if def.cat == Cat::Commerce && GOOD_DEFS[g].retail {
                    continue;
                }
                if g == ENERGIE && mechanized(job) {
                    continue; // carburant des machines, pas à vendre
                }
                let qty = self.businesses[bi].inv.qty(g);
                if qty <= 1e-6 {
                    continue;
                }
                let exp = self.businesses[bi].inv.expiring_by(g, day + 1.0);
                // un transformateur ne vend pas (hors invendus périssables) sous le coût de ses intrants
                if let Some(oq) = def.output(g) {
                    if def.cat == Cat::Transformation {
                        let mut unit_cost = self.labor_per_batch(job) * 0.7;
                        for &(ig, iq) in def.inputs {
                            unit_cost += iq * self.last_w[ig];
                        }
                        let fl = unit_cost / oq / def.outputs.len() as f64;
                        if self.ask_of(bi, g) < fl {
                            self.businesses[bi].ask[g] = Some(fl);
                        }
                    }
                    // producteur : prix de réserve = 30 % de la valeur de son travail
                    if def.cat == Cat::Production {
                        let mut fl = (self.labor_per_batch(job) * 0.3) / oq / def.outputs.len() as f64;
                        // un producteur d'énergie fossile ne vend pas sous la taxe carbone qu'il devra payer
                        if g == ENERGIE {
                            fl += emissions(job) * self.policy.carbon_tax * 100.0 * self.index_factor();
                        }
                        if self.ask_of(bi, g) < fl {
                            self.businesses[bi].ask[g] = Some(fl);
                        }
                    }
                }
                let p = self.ask_of(bi, g);
                if exp > 1e-6 {
                    asks[g].push(Order::tagged(bi as i64, exp, mx(1.0, p * 0.6), 1));
                }
                if qty - exp > 1e-6 {
                    let pr = mx(1.0, p * self.rng.range(0.97, 1.03));
                    asks[g].push(Order::new(bi as i64, qty - exp, pr));
                }
                set_good(&mut off, g, qty);
            }
            offered.push((bi, off));
            if nw == 0.0 {
                continue;
            }
            // --- demandes d'achat
            let mut want: Vec<(Good, f64, f64)> = Vec::new();
            if def.cat == Cat::Transformation {
                // on ne paie jamais un intrant plus cher que ce que rapporte le lot produit
                let mut out_value = 0.0;
                for &(g, q) in def.outputs {
                    let a = self.ask_of(bi, g);
                    out_value += q * mx(self.last_w[g], a);
                }
                out_value = mx(out_value * 0.3, out_value * 0.95 - self.labor_per_batch(job) * 0.5);
                let potential = self.businesses[bi].potential;
                let pb = self.planned_batches(bi);
                let m = js_max_list(def.outputs.iter().map(|&(g, q)| {
                    (self.businesses[bi].out_sales[g].unwrap_or(potential * q)
                        + mx(0.0, self.wholesale_unmet[g]) * ((potential * q) / mx(1e-6, self.cap_by_good[g])))
                        / q
                }));
                let plan = mn(potential, pb * 0.5 + m * 1.15 + potential * 0.15);
                let ni = def.inputs.len() as f64;
                for &(g, q) in def.inputs {
                    let target = plan * q * (if GOOD_DEFS[g].shelf <= 4.0 { 1.5 } else { 3.0 });
                    let need = target - self.businesses[bi].inv.qty(g);
                    if need <= 0.01 {
                        continue;
                    }
                    let max_p = out_value / (q * ni);
                    let bp = mn(self.bid_of(bi, g), max_p);
                    want.push((g, need, bp * self.rng.range(0.98, 1.02)));
                }
            } else if def.cat == Cat::Commerce {
                let w = self.retail_weights(bi);
                let mut tot = 0.0;
                let mut tgt = [0.0; NG];
                let potential = self.businesses[bi].potential;
                for g in RETAIL_GOODS {
                    // ventes récentes + 15 % de la capacité pour tester la demande, dans la limite de la capacité
                    let days = if GOOD_DEFS[g].shelf <= 4.0 { 1.3 } else { 3.0 };
                    let unmet = self.retail_unmet[g] * (potential / self.shop_cap_total);
                    tgt[g] = (self.businesses[bi].sales_ema[g].unwrap_or(0.0) * 1.2 + unmet + 0.1 * potential * w[g]) * days;
                    tot += tgt[g] / days;
                }
                let cap_f = if tot > potential { potential / tot } else { 1.0 };
                for g in RETAIL_GOODS {
                    let need = tgt[g] * cap_f - self.businesses[bi].inv.qty(g);
                    if need <= 0.01 {
                        continue;
                    }
                    let max_p = (self.last_r[g] / (1.0 + vat)) * 0.95;
                    let bp = mn(self.bid_of(bi, g), max_p);
                    want.push((g, need, bp * self.rng.range(0.98, 1.02)));
                }
            }
            // énergie des machines : 5 jours d'avance, payée au plus 80 % de ce qu'elle rapporte
            if mechanized(job) {
                let need = nw * k::ENERGY_PER_WORKER * 5.0 - self.businesses[bi].inv.qty(ENERGIE);
                let max_p = (k::ENERGY_BONUS * mx(50.0, self.businesses[bi].va_per_worker) * 0.8) / k::ENERGY_PER_WORKER;
                if need > 0.05 {
                    let bp = mn(self.bid_of(bi, ENERGIE), max_p);
                    want.push((ENERGIE, need, bp * self.rng.range(0.98, 1.02)));
                }
            }
            let tools = self.businesses[bi].tools;
            if tools < nw * 0.95 && job != CHARPENTIER && def.cat != Cat::Assurance {
                let gain_per_day = k::TOOL_BONUS * mx(50.0, self.businesses[bi].va_per_worker);
                let max_p = gain_per_day * 50.0;
                let bp = mn(self.bid_of(bi, OUTILS), max_p);
                want.push((OUTILS, mn(2.0, nw - tools), bp * self.rng.range(0.98, 1.02)));
            }
            // budget : 90 % de la trésorerie
            let budget = self.businesses[bi].cash * 0.9;
            let mut cost = 0.0;
            for x in &want {
                cost += x.1 * x.2;
            }
            let scale = if cost > budget { budget / cost } else { 1.0 };
            let mut wmap: GoodList = Vec::new();
            for &(g, q0, p) in &want {
                let q = q0 * scale;
                if q <= 1e-4 || p < 1.0 {
                    continue;
                }
                bids[g].push(Order::new(bi as i64, q, p));
                set_good(&mut wmap, g, q);
            }
            wanted.push((bi, wmap));
        }
        // achats publics
        let state_want = self.public_purchase_orders();
        for x in &state_want {
            bids[x.g].push(Order::new(STATE_ID, x.q, x.p));
        }
        let mut state_got: Vec<Option<Vec<Batch>>> = vec![None; NG];
        let mut state_cost: [Option<f64>; NG] = [None; NG];
        // silo public de blé (ordres distincts, tag 7)
        let (silo_buy, silo_sell) = self.silo_orders();
        if let Some((q, p)) = silo_buy {
            bids[BLE].push(Order::tagged(STATE_ID, q, p, 7));
        }
        if let Some((q, p)) = silo_sell {
            asks[BLE].push(Order::tagged(STATE_ID, q, p, 7));
        }
        let mut silo_bought = 0.0;

        let nb = self.businesses.len();
        let mut sold: Vec<[f64; NG]> = vec![[0.0; NG]; nb];
        let mut bought: Vec<[f64; NG]> = vec![[0.0; NG]; nb];
        for g in 0..NG {
            let res = call_auction(&mut bids[g], &mut asks[g], &mut self.rng);
            self.wholesale_unmet[g] = res.demand - res.volume;
            self.last_w_demand[g] = res.demand;
            let Some(p) = res.price else { continue };
            let mut vol = 0.0;
            for m in &res.matches {
                let bid = bids[g][m.bid];
                let ask = asks[g][m.ask];
                if ask.owner == STATE_ID {
                    // vente du silo à une entreprise
                    let buyer = bid.owner as usize;
                    let mut q = mn(m.qty, self.silo.qty(g));
                    let mut cost = round(p * q);
                    let bcash = self.businesses[buyer].cash;
                    if cost > bcash {
                        q = bcash / p;
                        cost = mn(bcash, round(p * q));
                    }
                    if q <= 1e-6 || cost <= 0.0 {
                        continue;
                    }
                    let got = self.silo.take(g, q);
                    let b = &mut self.businesses[buyer];
                    b.inv.add_batches(g, &got);
                    b.cash -= cost;
                    b.cost_day += cost;
                    b.input_month += cost;
                    b.input_day += cost;
                    self.collect(VENTES_PUBLIQUES, cost);
                    let c = self.cat_of(buyer);
                    self.flow(c, ETAT, cost);
                    bought[buyer][g] += q;
                    vol += q;
                    self.d.wholesale_value += cost;
                    continue;
                }
                if bid.owner == STATE_ID {
                    let seller = ask.owner as usize;
                    let mut q = m.qty;
                    let mut cost = round(p * q);
                    let cash = mx(0.0, self.treasury);
                    if cost > cash {
                        q = cash / p;
                        cost = mn(cash, round(p * q));
                    }
                    if q <= 1e-6 || cost <= 0.0 {
                        continue;
                    }
                    let got = self.businesses[seller].inv.take(g, q);
                    if bid.tag == 7 {
                        // blé mis en silo : séché et stocké, il se conserve un an
                        for x in &got {
                            self.silo.add(g, x.q, day + k::SILO_SHELF);
                        }
                        self.state_out(AGRICULTURE, cost);
                        silo_bought += q;
                    } else {
                        state_got[g].get_or_insert_with(Vec::new).extend(got);
                        self.treasury -= cost;
                        state_cost[g] = Some(state_cost[g].unwrap_or(0.0) + cost);
                    }
                    let s = &mut self.businesses[seller];
                    s.cash += cost;
                    s.rev_day += cost;
                    s.rev_month += cost;
                    let c = self.cat_of(seller);
                    self.flow(ETAT, c, cost);
                    sold[seller][g] += q;
                    vol += q;
                    self.d.wholesale_value += cost;
                    continue;
                }
                let buyer = bid.owner as usize;
                let seller = ask.owner as usize;
                let mut q = m.qty;
                let mut cost = round(p * q);
                let bcash = self.businesses[buyer].cash;
                if cost > bcash {
                    q = bcash / p;
                    cost = mn(bcash, round(p * q));
                }
                if q <= 1e-6 || cost <= 0.0 {
                    continue;
                }
                let got = self.businesses[seller].inv.take(g, q);
                if g == OUTILS {
                    self.businesses[buyer].tools += q;
                } else {
                    let b = &mut self.businesses[buyer];
                    if JOB_DEFS[b.job].cat == Cat::Commerce {
                        let before = b.inv.qty(g);
                        b.avg_cost[g] = Some((b.avg_cost[g].unwrap_or(p) * before + p * q) / (before + q));
                    }
                    b.inv.add_batches(g, &got);
                }
                self.businesses[buyer].cash -= cost;
                {
                    let s = &mut self.businesses[seller];
                    s.cash += cost;
                    s.rev_day += cost;
                    s.rev_month += cost;
                }
                // taxe carbone : accise sur chaque unité d'énergie fossile vendue
                let em = emissions(self.businesses[seller].job);
                if g == ENERGIE && em > 0.0 && self.policy.carbon_tax > 0.0 {
                    let t = mn(cost, round(q * em * self.policy.carbon_tax * 100.0 * self.index_factor()));
                    let s = &mut self.businesses[seller];
                    s.cash -= t;
                    s.rev_day -= t;
                    s.rev_month -= t;
                    self.collect(TAXE_CARBONE, t);
                    self.flow(F_PRODUCTION, ETAT, t);
                }
                {
                    let b = &mut self.businesses[buyer];
                    b.cost_day += cost;
                    if g == OUTILS {
                        b.other_month += cost;
                    } else {
                        b.input_month += cost;
                        b.input_day += cost;
                    }
                }
                let cb = self.cat_of(buyer);
                let cs = self.cat_of(seller);
                self.flow(cb, cs, cost);
                sold[seller][g] += q;
                bought[buyer][g] += q;
                vol += q;
                self.d.wholesale_value += cost;
            }
            if vol > 0.0 {
                self.last_w[g] = p;
                self.d.wholesale_volume[g] = Some(vol);
            }
        }
        // apprentissage des prix
        for (id, off) in &offered {
            let id = *id;
            for &(g, q) in off {
                let s = sold[id][g];
                let fl = mx(1e-3, self.businesses[id].prod_ema[g].unwrap_or(0.0));
                let a = self.ask_of(id, g);
                let mut np = self.adapt_ask(a, s / q, (q - s) / fl, if GOOD_DEFS[g].shelf <= 4.0 { 0.5 } else { 4.0 }, self.last_w[g]);
                // rupture avec des acheteurs restés sur leur faim : hausse plus franche
                if s / q >= 0.98 && self.wholesale_unmet[g] > 0.05 * mx(1.0, self.last_w_demand[g]) {
                    np *= 1.0 + self.rng.range(0.02, 0.06);
                }
                self.businesses[id].ask[g] = Some(np);
            }
            let job = self.businesses[id].job;
            for &(g, _) in JOB_DEFS[job].outputs {
                let s = sold[id][g];
                let b = &mut self.businesses[id];
                b.out_sales[g] = Some(b.out_sales[g].unwrap_or(s) * 0.8 + s * 0.2);
            }
        }
        for (id, w) in &wanted {
            let id = *id;
            for &(g, q) in w {
                let got = bought[id][g];
                let b0 = self.bid_of(id, g);
                let nb = self.adapt_bid(b0, got / q, self.last_w[g]);
                self.businesses[id].bid[g] = Some(nb);
            }
        }
        self.deliver_public_purchases(&state_want, &state_got, &state_cost);
        self.d.silo_trade = silo_bought;
    }

    /// Silo public : achète sous `grainFloor` × valeur du travail, revend au-dessus de 1,5 ×.
    fn silo_orders(&self) -> (Option<(f64, f64)>, Option<(f64, f64)>) {
        let p = &self.policy;
        let stock = self.silo.qty(BLE);
        let mut sell = None;
        let mut buy = None;
        if stock > 1.0 {
            sell = Some((mn(stock, 0.3 * self.cap_by_good[BLE] + 1.0), mx(2.0, 1.5 * self.labor_per_batch(CEREALIER))));
        }
        if !p.grain_reserve {
            return (buy, sell);
        }
        let room = k::SILO_DAYS * self.cap_by_good[BLE] * 0.5 - stock;
        if room > 1.0 && self.treasury > 0.0 {
            buy = Some((mn(room, 0.3 * self.cap_by_good[BLE]), mx(1.0, p.grain_floor * self.labor_per_batch(CEREALIER))));
        }
        (buy, sell)
    }

    /// Achats publics du jour, par poste.
    fn public_purchase_orders(&mut self) -> Vec<PublicWant> {
        let mut kids = 0.0;
        let mut pop = 0.0;
        let mut homes = 0.0;
        for a in self.aa() {
            if !self.agents[a].alive {
                continue;
            }
            pop += 1.0;
            if self.age_y(a) < k::ADULT_AGE {
                kids += 1.0;
            }
            if self.is_head(a) {
                homes += 1.0;
            }
        }
        let p = self.policy.clone();
        let pupils = mn(kids, self.staff_n[ENSEIGNANT] * k::PUPILS_PER_TEACHER);
        let meals = kids * p.school_meals;
        let ix = self.index_factor();
        let w = |g: Good| GOOD_DEFS[g].wholesale0 * ix;
        let gdp_day = self.gdp_year() / D;
        let housing_gap = mx(0.0, p.social_housing * homes - self.housing);
        let want = [
            PublicOrder { k: CANTINES, g: PAIN, q: (meals * 0.6) / GOOD_DEFS[PAIN].nutrition },
            PublicOrder { k: CANTINES, g: FRUITS, q: (meals * 0.4) / GOOD_DEFS[FRUITS].nutrition },
            PublicOrder { k: EDUCATION, g: BOIS, q: pupils * 0.04 },
            PublicOrder { k: EDUCATION, g: ARTISANAT, q: (pupils * p.school_supplies * 100.0 * ix) / D / w(ARTISANAT) },
            PublicOrder { k: INVESTISSEMENT, g: BOIS, q: (p.public_investment * gdp_day * 0.25) / w(BOIS) },
            PublicOrder { k: INVESTISSEMENT, g: OUTILS, q: (p.public_investment * gdp_day * 0.25) / w(OUTILS) },
            PublicOrder { k: LOGEMENT, g: BOIS, q: ((self.housing / k::HOUSING_LIFE) + housing_gap / 300.0) * k::HOUSING_WOOD },
            PublicOrder { k: LOGEMENT, g: OUTILS, q: ((self.housing / k::HOUSING_LIFE) + housing_gap / 300.0) * k::HOUSING_TOOLS },
            PublicOrder { k: CULTURE, g: ARTISANAT, q: (pop * p.culture * 100.0 * ix) / D / w(ARTISANAT) },
            PublicOrder { k: AGRICULTURE, g: OUTILS, q: (p.land_improvement * gdp_day) / w(OUTILS) },
        ];
        let mut by_good: Vec<(Good, Vec<PublicOrder>)> = Vec::new();
        let mut need = 0.0;
        for x in want {
            if x.q <= 1e-3 {
                continue;
            }
            if let Some(e) = by_good.iter_mut().find(|e| e.0 == x.g) {
                e.1.push(x);
            } else {
                by_good.push((x.g, vec![x]));
            }
        }
        let mut out: Vec<PublicWant> = Vec::new();
        for (g, parts) in by_good {
            let lw = self.last_w[g];
            let price = mn(*self.state_bid[g].get_or_insert(lw), lw * 1.1);
            self.state_bid[g] = Some(price);
            let mut tot = 0.0;
            for x in &parts {
                tot += x.q;
            }
            for x in &parts {
                self.need_month[x.k] += x.q * price;
                need += x.q * price;
            }
            let q = mn(tot, (if g == BOIS || g == OUTILS { 0.25 } else { 0.15 }) * self.cap_by_good[g]);
            if q > 0.01 {
                out.push(PublicWant { g, q, p: price, parts });
            }
        }
        // part financée, et jamais plus que la moitié de la caisse du jour
        let sc = mn(self.budget_cut, if need > 0.0 { (mx(0.0, self.treasury) * 0.5) / need } else { 0.0 });
        for x in out.iter_mut() {
            x.q *= sc;
        }
        out.retain(|x| x.q > 1e-3);
        out
    }

    /// Livraison et comptabilité des achats publics, répartis entre les postes au prorata des commandes.
    fn deliver_public_purchases(&mut self, want: &[PublicWant], got: &[Option<Vec<Batch>>], cost: &[Option<f64>; NG]) {
        let mut homes: Vec<(usize, f64)> = Vec::new();
        let mut kids = 0.0;
        let mut school = 0.0;
        let mut culture = 0.0;
        let empty: Vec<Batch> = Vec::new();
        for x in want {
            let gl = got[x.g].as_ref().unwrap_or(&empty);
            let mut q = 0.0;
            for b in gl {
                q += b.q;
            }
            // prix appris : servi → on baisse doucement, pas servi → on monte vers le marché
            let nb = self.adapt_bid(x.p, q / x.q, self.last_w[x.g]);
            self.state_bid[x.g] = Some(nb);
            if q <= 1e-9 {
                continue;
            }
            let mut tot = 0.0;
            for o in &x.parts {
                tot += o.q;
            }
            let c = cost[x.g].unwrap_or(0.0);
            let mut booked = 0.0;
            let np = x.parts.len();
            for (i, o) in x.parts.iter().enumerate() {
                let share = o.q / tot;
                let qq = q * share;
                let cc = if i == np - 1 { c - booked } else { round(c * share) };
                booked += cc;
                self.book(o.k, cc);
                self.bought_month[o.k] += cc;
                let v = qq * GOOD_DEFS[x.g].wholesale0; // valeur aux prix de départ (centimes)
                if o.k == INVESTISSEMENT {
                    self.infra += v;
                } else if o.k == LOGEMENT {
                    self.housing += if x.g == BOIS { qq / k::HOUSING_WOOD / 2.0 } else { qq / k::HOUSING_TOOLS / 2.0 };
                } else if o.k == AGRICULTURE {
                    self.land_bonus += qq * k::LAND_PER_TOOL;
                } else if o.k == EDUCATION && x.g == ARTISANAT {
                    school += v;
                } else if o.k == CULTURE {
                    culture += v;
                } else if o.k == CANTINES {
                    // repas des cantines dans le garde-manger des foyers avec enfants
                    if homes.is_empty() {
                        for a in self.aa() {
                            if !self.is_head(a) {
                                continue;
                            }
                            let nd = self.n_dependents(a) as f64;
                            let n = if self.agents[a].status == Status::Enfant { 1.0 + nd } else { nd };
                            if n > 0.0 {
                                homes.push((a, n));
                                kids += n;
                            }
                        }
                    }
                    if kids != 0.0 {
                        for b in gl {
                            for &(h, n) in &homes {
                                self.agents[h].food.add(x.g, (b.q * share * n) / kids, b.exp);
                            }
                        }
                    }
                }
            }
        }
        // couverture du matériel scolaire et de la culture (1 = niveau par défaut), moyenne sur ~2 mois
        let rf = |per_year: f64, n: f64| mx(1.0, (per_year * 100.0 * n) / D);
        let mut nk = 0.0;
        for a in self.aa() {
            nk += if self.agents[a].alive && self.age_y(a) < k::ADULT_AGE { 1.0 } else { 0.0 };
        }
        let pupils = mn(nk, self.staff_n[ENSEIGNANT] * k::PUPILS_PER_TEACHER);
        self.school_cov = self.school_cov * 0.98 + 0.02 * mn(1.5, school / rf(10.0, pupils));
        self.culture_cov = self.culture_cov * 0.98 + 0.02 * mn(1.5, culture / rf(8.0, self.pop_n));
    }

    /// Ajustement du prix demandé : tout vendu → on monte ; stock au-delà de la cible → on baisse.
    pub(super) fn adapt_ask(&mut self, mut p: f64, fill: f64, stock_days: f64, target_days: f64, market: f64) -> f64 {
        if fill >= 0.98 {
            p = mx(p * (1.0 + self.rng.range(0.01, 0.04)), (p + market) / 2.0);
        } else if stock_days > target_days * 1.2 {
            p *= 1.0 - self.rng.range(0.01, 0.04) * mn(1.0, (stock_days - target_days) / (target_days + 1.0));
        } else if stock_days < target_days * 0.8 {
            p *= 1.0 + self.rng.range(0.0, 0.02);
        }
        clamp(p, 1.0, 1e6)
    }
    pub(super) fn adapt_bid(&mut self, mut p: f64, fill: f64, market: f64) -> f64 {
        if fill < 0.9 {
            p = mx(p * (1.0 + self.rng.range(0.03, 0.08) * (1.0 - fill)), mn(market, p * 1.15));
        } else {
            p *= 1.0 - self.rng.range(0.0, 0.02);
        }
        clamp(p, 1.0, 1e6)
    }

    /// Répartition de la capacité de vente d'un commerce entre les produits.
    pub(super) fn retail_weights(&self, bi: usize) -> [f64; NG] {
        let b = &self.businesses[bi];
        let mut w = [0.0; NG];
        let mut s = 0.0;
        let mut sales = 0.0;
        let mut dem = 0.0;
        let n = RETAIL_GOODS.len() as f64;
        for g in RETAIL_GOODS {
            sales += b.sales_ema[g].unwrap_or(0.0);
            dem += self.retail_demand[g];
        }
        for g in RETAIL_GOODS {
            let own = if sales > 0.0 { b.sales_ema[g].unwrap_or(0.0) / sales } else { 1.0 / n };
            let mkt = if dem > 0.0 { self.retail_demand[g] / dem } else { 1.0 / n };
            w[g] = 0.4 * own + 0.6 * mkt + 0.01;
            s += w[g];
        }
        for g in RETAIL_GOODS {
            w[g] /= s;
        }
        w
    }
}
