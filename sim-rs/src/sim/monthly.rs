//! Cycle mensuel : impôts, revenus, budget, dette publique, banque centrale, banque, gazette.

use super::*;
use crate::market::{call_auction, Order};

impl Simulation {
    pub(super) fn monthly(&mut self) {
        let p = self.policy.clone();
        // impôts ; l'administration fiscale en perçoit tout à l'effectif de référence
        let eff = 0.8 + 0.2 * mn(1.0, self.staff_cov(ADMINISTRATEUR, k::ADMIN_REF));
        self.tax_eff = eff;
        let values = self.biz_values();
        for a in self.aa() {
            if !self.agents[a].alive {
                continue;
            }
            let i_ = self.agents[a].income / 100.0;
            let mut tax = round(
                (p.income_tax_low * mn(i_, p.income_tax_threshold) + p.income_tax_high * mx(0.0, i_ - p.income_tax_threshold)) * 100.0 * eff,
            );
            tax = mn(tax, self.agents[a].money);
            if tax > 0.0 {
                self.agents[a].money -= tax;
                self.collect(IMPOT_REVENU, tax);
                self.flow(MENAGES, ETAT, tax);
            }
            // cotisation à l'assurance maladie publique, proportionnelle aux revenus
            let cot = mn(self.agents[a].money, round(self.agents[a].income * p.secu_contribution * eff));
            if cot > 0.0 {
                self.agents[a].money -= cot;
                self.collect(COTISATIONS_SANTE, cot);
                self.flow(MENAGES, ETAT, cot);
            }
            if p.wealth_tax > 0.0 {
                let ag = &self.agents[a];
                let mut w = ag.money + ag.bonds;
                for (&bid, &s) in &ag.shares {
                    w += s * values[bid].unwrap_or(0.0);
                }
                let t = mn(ag.money, round(mx(0.0, w - p.wealth_tax_threshold * 100.0) * (p.wealth_tax / 12.0) * eff));
                if t > 0.0 {
                    self.agents[a].money -= t;
                    self.collect(IMPOT_FORTUNE, t);
                    self.flow(MENAGES, ETAT, t);
                }
            }
            let ag = &mut self.agents[a];
            ag.last_income = ag.income;
            ag.income = 0.0;
        }
        for bi in self.ab() {
            if !self.businesses[bi].alive {
                continue;
            }
            let b = &self.businesses[bi];
            let profit = b.rev_month - b.input_month - b.wage_month - b.other_month;
            let t = mn(b.cash, round(mx(0.0, profit) * p.corporate_tax * eff));
            if t > 0.0 {
                self.businesses[bi].cash -= t;
                self.collect(IMPOT_SOCIETES, t);
                let c = self.cat_of(bi);
                self.flow(c, ETAT, t);
            }
            let b = &mut self.businesses[bi];
            let nw = mx(1.0, b.workers.len() as f64);
            b.va_per_worker = (b.rev_month - b.input_month - b.other_month) / nw / k::DAYS_PER_MONTH;
            b.profit_last_month = profit;
            b.rev_month = 0.0;
            b.input_month = 0.0;
            b.wage_month = 0.0;
            b.other_month = 0.0;
        }
        // revenus moyens par secteur (revenu d'activité du mois écoulé)
        let mut sum = [0.0; NJ];
        let mut cnt = [0.0; NJ];
        for a in self.alive_agents.iter().map(|&i| &self.agents[i]) {
            if !a.alive || a.status != Status::Actif {
                continue;
            }
            let Some(j) = a.job else { continue };
            if self.day - a.job_since < 25 {
                continue;
            }
            sum[j] += a.last_income / k::DAYS_PER_MONTH;
            cnt[j] += 1.0;
        }
        let mut tot = 0.0;
        let mut n = 0.0;
        for j in 0..NJ {
            if cnt[j] != 0.0 {
                self.sector_income[j] = self.sector_income[j] * 0.5 + (sum[j] / cnt[j]) * 0.5;
            }
            tot += sum[j];
            n += cnt[j];
        }
        if n != 0.0 {
            self.avg_income = self.avg_income * 0.5 + (tot / n) * 0.5;
        }
        self.reorganize();
        self.public_hiring();
        // chômeurs restants
        for a in self.aa() {
            if self.agents[a].alive && self.agents[a].status == Status::Chomeur {
                self.choose_job(a, None);
            }
        }
        self.price_insurance();
        self.choose_insurance();
        self.monthly_news();
        if self.day % 360 == 0 {
            self.record_quintiles();
        }
        self.compact();
        let hl = self.history.len();
        let from = hl.saturating_sub(30);
        if hl > from {
            let mut s = 0.0;
            for r in &self.history[from..] {
                s += r.cpi;
            }
            self.cpi_index = s / (hl - from) as f64;
        }
        // monnaie : taux directeur, crédit bancaire
        self.monetary_policy();
        self.bank_credit();
        // budget et dette
        self.pay_coupons();
        self.close_month();
        if self.day == 30 || self.day % 360 == 0 {
            self.vote_budget(true);
        } else if self.day % 90 == 0 && self.budget.is_some() {
            self.vote_budget(false);
        }
        self.manage_debt();
        self.redistribute_surplus();
        self.debt_stress *= 0.85;
        // comptes de l'État et flux
        self.state_prev_month = std::mem::replace(&mut self.state_month, StateMonth::zero());
        self.flows_prev = std::mem::take(&mut self.flows_month);
    }

    // ------------------------------------------------------------------ budget et dette publique

    /// PIB des 12 derniers mois (centimes), annualisé au début de la simulation.
    pub fn gdp_year(&self) -> f64 {
        let l = self.month_log.len();
        let m = &self.month_log[l.saturating_sub(12)..];
        if m.is_empty() {
            return mx(1.0, self.month_gdp * (D / mx(1.0, self.day as f64)));
        }
        let mut s = 0.0;
        for x in m {
            s += x.gdp;
        }
        mx(1.0, (s * 12.0) / m.len() as f64)
    }

    /// Taux moyen de la dette en circulation (annuel).
    pub fn avg_debt_rate(&self) -> f64 {
        let mut n = 0.0;
        let mut r = 0.0;
        for t in &self.debt {
            let mut q = 0.0;
            for v in t.holders.values() {
                q += v;
            }
            n += q;
            r += q * t.rate;
        }
        if n > 0.0 { r / n } else { 0.0 }
    }

    fn hold_counters(&mut self, key: i64, cents: f64) {
        if key == CB_KEY {
            self.cb_bonds += cents;
        } else if key == FOREIGN_KEY {
            self.foreign_bonds += cents;
        } else if key >= 0 {
            self.agents[key as usize].bonds += cents;
        } else {
            self.businesses[(-2 - key) as usize].bonds += cents;
        }
    }

    /// Ajoute (ou retire, si négatif) du nominal à un détenteur.
    fn hold_bond(&mut self, t: &mut Bond, key: i64, cents: f64) {
        if cents == 0.0 || cents.is_nan() {
            return;
        }
        let v = t.holders.get(&key).copied().unwrap_or(0.0) + cents;
        if v > 0.0 {
            t.holders.insert(key, v);
        } else {
            t.holders.shift_remove(&key);
        }
        self.hold_counters(key, cents);
    }

    fn hold_bond_at(&mut self, ti: usize, key: i64, cents: f64) {
        if cents == 0.0 || cents.is_nan() {
            return;
        }
        let t = &mut self.debt[ti];
        let v = t.holders.get(&key).copied().unwrap_or(0.0) + cents;
        if v > 0.0 {
            t.holders.insert(key, v);
        } else {
            t.holders.shift_remove(&key);
        }
        self.hold_counters(key, cents);
    }

    /// Création (cents > 0) ou destruction (cents < 0) de monnaie, par origine.
    fn mint(&mut self, src: usize, cents: f64) {
        self.money_base += cents;
        self.money_created[src] += cents;
    }

    /// Transmet toutes les obligations d'un détenteur : une part `cancel` est annulée, le reste est
    /// partagé selon `to` (clé `None` = annulé aussi). Le reste d'arrondi va au premier destinataire.
    pub(super) fn move_bonds(&mut self, from: i64, to: &[(Option<i64>, f64)], cancel: f64) {
        for ti in 0..self.debt.len() {
            let n = self.debt[ti].holders.get(&from).copied().unwrap_or(0.0);
            if n == 0.0 || n.is_nan() {
                continue;
            }
            self.hold_bond_at(ti, from, -n);
            let mut rest = n - round(n * cancel);
            let mut parts: Vec<(Option<i64>, f64)> = to.iter().map(|&(k, s)| (k, floor(rest * s))).collect();
            let mut given = 0.0;
            for x in &parts {
                given += x.1;
            }
            if let Some(first) = parts.iter_mut().find(|x| x.0.is_some()) {
                first.1 += rest - given;
            }
            for (key, q) in parts {
                let Some(key) = key else { continue };
                if q <= 0.0 {
                    continue;
                }
                self.hold_bond_at(ti, key, q);
                rest -= q;
            }
            self.debt_total -= rest; // part annulée
        }
        self.debt.retain(|t| !t.holders.is_empty());
    }

    /// Coupons mensuels (1/12 du taux annuel). S'ils ne peuvent être payés en entier : défaut partiel.
    fn pay_coupons(&mut self) {
        let mut due = 0.0;
        for t in &self.debt {
            for &n in t.holders.values() {
                due += floor((n * t.rate) / 12.0);
            }
        }
        if due <= 0.0 {
            return;
        }
        let ratio = if self.treasury >= due { 1.0 } else { mx(0.0, self.treasury) / due };
        for ti in 0..self.debt.len() {
            let rate = self.debt[ti].rate;
            let holders: Vec<(i64, f64)> = self.debt[ti].holders.iter().map(|(&k, &v)| (k, v)).collect();
            for (key, n) in holders {
                let c = floor(floor((n * rate) / 12.0) * ratio);
                if c <= 0.0 {
                    continue;
                }
                if key == CB_KEY {
                    // coupon versé à la banque centrale : son bénéfice est reversé aussitôt à l'État
                    self.state_out(INTERETS, c);
                    self.collect(PROFITS_BC, c);
                } else if key == FOREIGN_KEY {
                    // coupon versé à l'étranger : de la monnaie quitte l'île
                    self.state_out(INTERETS, c);
                    self.mint(ETRANGER, -c);
                } else if key >= 0 {
                    self.spend(INTERETS, key as usize, c, true);
                } else {
                    let b = (-2 - key) as usize;
                    self.state_out(INTERETS, c);
                    self.businesses[b].cash += c;
                    let cb = self.cat_of(b);
                    self.flow(ETAT, cb, c);
                }
            }
        }
        if ratio < 0.999 {
            self.debt_stress = 1.0;
            let t = format!("Défaut partiel : l'État n'a pu verser que {} % des intérêts dus à ses créanciers.", js_num(round(ratio * 100.0)));
            self.say("crise", t);
        }
    }

    /// Bilan du mois écoulé, pour les prévisions du budget.
    fn close_month(&mut self) {
        let mut rev = 0.0;
        for x in self.state_month.revenue {
            rev += x;
        }
        let mut spend = 0.0;
        for x in self.state_month.spending {
            spend += x;
        }
        self.need_month[INTERETS] = self.state_month.spending[INTERETS];
        self.need_month[REDISTRIBUTION] = self.state_month.spending[REDISTRIBUTION];
        let ix = self.index_factor();
        self.month_log.push(MonthLog {
            rev,
            spend: spend - self.state_month.spending[AIDE_URGENCE],
            gdp: self.month_gdp,
            ix,
            cut: self.budget_cut,
            bought: self.bought_month,
            needs: self.need_month,
        });
        if self.month_log.len() > 48 {
            self.month_log.remove(0);
        }
        self.need_month = [0.0; NSPEND];
        self.bought_month = [0.0; NSPEND];
        self.month_gdp = 0.0;
    }

    /// Vote du budget annuel (fin du premier mois, puis chaque début d'année), ou rectificatif.
    fn vote_budget(&mut self, annual: bool) {
        let p = self.policy.clone();
        let l = self.month_log.len();
        let months: Vec<MonthLog> = self.month_log[l.saturating_sub(12)..].to_vec();
        if months.is_empty() {
            return;
        }
        let ml = months.len() as f64;
        let mut ix = 0.0;
        for m in &months {
            ix += m.ix;
        }
        ix /= ml;
        let ann = 12.0 / ml;
        let mut revenue = 0.0;
        for m in &months {
            revenue += m.rev;
        }
        revenue *= ann;
        let gdp = self.gdp_year();
        let (mut pop, mut retirees, mut adults) = (0.0, 0.0, 0.0);
        for a in self.alive_agents.iter().map(|&i| &self.agents[i]) {
            if !a.alive {
                continue;
            }
            pop += 1.0;
            if a.status == Status::Retraite {
                retirees += 1.0;
            }
            if a.status != Status::Enfant {
                adults += 1.0;
            }
        }
        let mut needs = [0.0; NSPEND];
        for kk in 0..NSPEND {
            if !off_budget(kk) {
                let mut s = 0.0;
                for m in &months {
                    s += m.needs[kk];
                }
                needs[kk] = s * ann;
            }
        }
        // achats : seulement ce que le marché a pu fournir (ramené à un budget sans coupe)
        for kk in [CANTINES, EDUCATION, INVESTISSEMENT, LOGEMENT, CULTURE, AGRICULTURE] {
            let mut bought = 0.0;
            let mut wished = 0.0;
            for m in &months {
                bought += m.bought[kk] / mx(0.3, m.cut);
            }
            bought *= ann;
            for m in &months {
                wished += m.needs[kk];
            }
            wished *= ann;
            needs[kk] = needs[kk] - wished + mn(wished, bought);
        }
        // effectifs × salaires pour les fonctions publiques ; pensions et revenu universel d'après les effectifs
        for j in PUBLIC_JOBS {
            needs[staff_key(j)] += self.staff_target(j, pop) * p.public_salary * 100.0 * ix * D;
        }
        needs[PENSIONS] = retirees * p.pension * 100.0 * ix * D;
        needs[REVENU_UNIVERSEL] = adults * p.ubi * 100.0 * ix * D;
        // intérêts : la dette actuelle à son taux, plus le nouvel emprunt de l'année à mi-parcours
        let mut coupons = 0.0;
        for t in &self.debt {
            for &n in t.holders.values() {
                coupons += n * t.rate;
            }
        }
        let mut allowed = self.allowed_deficit(revenue, gdp);
        let mut spent_year = 0.0;
        for m in &months {
            spent_year += m.spend;
        }
        spent_year *= ann;
        if self.debt_total <= 0.0 {
            allowed = mx(allowed, 0.0) + mx(0.0, self.treasury - spent_year / 6.0);
        }
        let mut base = 0.0;
        for kk in 0..NSPEND {
            base += if off_budget(kk) { 0.0 } else { needs[kk] };
        }
        needs[INTERETS] = coupons + mx(0.0, base + coupons - revenue) * mx(self.last_rate, 0.02) * 0.5;
        let rule_cut = if base > 0.0 { clamp((revenue + allowed - needs[INTERETS]) / base, 0.3, 1.6) } else { 1.0 };
        // trajectoire d'ajustement : 10 points au plus au vote annuel, 5 à chaque budget rectificatif
        let step = if annual { 0.1 } else { 0.05 };
        let cut = clamp(rule_cut, mx(0.3, self.budget_cut - step), mn(1.6, self.budget_cut + step));
        let mut envelopes = [0.0; NSPEND];
        for kk in 0..NSPEND {
            envelopes[kk] = round(if kk == INTERETS { needs[kk] } else { needs[kk] * cut });
        }
        for kk in 0..NSPEND {
            needs[kk] = round(needs[kk]);
        }
        let prev = self.budget_cut;
        self.budget_cut = cut;
        if !annual {
            if let Some(b) = self.budget.as_mut() {
                b.cut = cut;
                b.planned = round(base * cut + needs[INTERETS]);
                for kk in 0..NSPEND {
                    b.envelopes[kk] = round(if kk == INTERETS { needs[kk] } else { needs[kk] * cut });
                }
            }
            if (cut - prev).abs() >= 0.049 {
                let t = format!(
                    "Budget rectificatif : les enveloppes passent de {} % à {} % des besoins ({}).",
                    js_num(round(prev * 100.0)),
                    js_num(round(cut * 100.0)),
                    if cut < prev { "recettes plus faibles ou déficit trop élevé" } else { "recettes meilleures que prévu" }
                );
                self.say("politique", t);
            }
            return;
        }
        let planned = round(base * cut + needs[INTERETS]);
        self.budget = Some(Budget {
            day: self.day,
            rule: p.fiscal_rule,
            revenue: round(revenue),
            gdp: round(gdp),
            needs,
            envelopes,
            allowed_deficit: round(allowed),
            planned,
            cut,
        });
        let year = (self.day as f64 / D).floor() + 1.0;
        let bal = (revenue - (base * cut + needs[INTERETS])) / gdp;
        let mut text = format!(
            "Budget de l'an {} : {} k écus de dépenses pour {} k de recettes prévues, {} du PIB.",
            js_num(year),
            js_num(round((base * cut + needs[INTERETS]) / 100000.0)),
            js_num(round(revenue / 100000.0)),
            if bal < 0.0 { format!("déficit de {} %", fixed(-bal * 100.0, 1)) } else { format!("excédent de {} %", fixed(bal * 100.0, 1)) }
        );
        if cut < 0.995 {
            let extra = if rule_cut < cut - 0.005 {
                format!(" (elle en demandait {} % : l'ajustement est étalé)", js_num(round((1.0 - rule_cut) * 100.0)))
            } else {
                String::new()
            };
            text += &format!(
                " La règle budgétaire impose des coupes de {} % sur les pensions, aides, soins, achats et postes publics{}.",
                js_num(round((1.0 - cut) * 100.0)),
                extra
            );
        } else if cut > 1.005 {
            text += &format!(
                " Les recettes permettent d'aller au-delà des besoins : pensions, aides, soins, achats et postes publics sont relevés de {} %.",
                js_num(round((cut - 1.0) * 100.0))
            );
        } else if prev < 0.995 {
            text += " Les coupes de l’an dernier sont levées.";
        }
        self.say("politique", text);
    }

    /// Déficit permis par la règle budgétaire (centimes, négatif = excédent exigé).
    fn allowed_deficit(&self, revenue: f64, gdp: f64) -> f64 {
        let p = &self.policy;
        let mut allowed = 0.0;
        match p.fiscal_rule {
            FiscalRule::CibleDeficit => allowed = p.deficit_target * gdp,
            FiscalRule::FreinDette => {
                let l = self.month_log.len();
                let m = &self.month_log[l.saturating_sub(36)..];
                let mut s = 0.0;
                for x in m {
                    s += x.gdp;
                }
                let trend = (s * 12.0) / mx(1.0, m.len() as f64);
                allowed = revenue * (clamp(trend / gdp, 0.9, 1.1) - 1.0);
            }
            FiscalRule::Equilibre => {}
        }
        // plafond de dette : on s'en approche en douceur (un tiers de la marge restante par an)
        if p.debt_ceiling > 0.0 {
            allowed = mn(allowed, (p.debt_ceiling * gdp - self.debt_total) / 3.0);
        }
        allowed
    }

    /// Trésorerie : rembourse les obligations échues et emprunte de quoi couvrir le mois à venir.
    fn manage_debt(&mut self) {
        let sm = &self.state_month;
        let mut daily = 0.0;
        for kk in 0..NSPEND {
            daily += if kk == INTERETS || kk == REDISTRIBUTION { 0.0 } else { sm.spending[kk] };
        }
        let inflow = sm.revenue[TVA] + sm.revenue[LOYERS] + sm.revenue[SUCCESSION] + sm.revenue[DIVIDENDES];
        let mut maturing = 0.0;
        for t in &self.debt {
            if t.maturity <= self.day {
                for &n in t.holders.values() {
                    maturing += n;
                }
            }
        }
        let mut relief = 0.0;
        for r in &self.pending_relief {
            relief += r.left;
        }
        let need = maturing + mx(0.0, daily - inflow) + daily / 6.0 + relief - self.treasury;
        if need > 1000.0 {
            self.issue_bonds(round(need));
        }
        self.repay_maturing();
        let ratio = self.debt_total / self.gdp_year();
        if ratio > self.debt_record + 0.05 {
            self.debt_record = ratio;
            let t = format!(
                "Record : la dette publique atteint {} % du PIB ({} k écus).",
                js_num(round(ratio * 100.0)),
                js_num(round(self.debt_total / 100000.0))
            );
            self.say("crise", t);
        }
    }

    /// Remboursement des obligations échues ; si la caisse ne suffit pas, le reste est prolongé de 3 mois.
    fn repay_maturing(&mut self) {
        let due: Vec<usize> = (0..self.debt.len()).filter(|&i| self.debt[i].maturity <= self.day).collect();
        if due.is_empty() {
            return;
        }
        let mut total = 0.0;
        for &ti in &due {
            for &n in self.debt[ti].holders.values() {
                total += n;
            }
        }
        let ratio = if self.treasury >= total { 1.0 } else { mx(0.0, self.treasury) / total };
        for &ti in &due {
            let holders: Vec<(i64, f64)> = self.debt[ti].holders.iter().map(|(&k, &v)| (k, v)).collect();
            for (key, n) in holders {
                let x = floor(n * ratio);
                if x <= 0.0 {
                    continue;
                }
                self.hold_bond_at(ti, key, -x);
                self.treasury -= x;
                self.debt_total -= x;
                self.d.repayment += x;
                if key == CB_KEY {
                    self.mint(BC, -x); // la banque centrale détruit la monnaie remboursée
                } else if key == FOREIGN_KEY {
                    self.mint(ETRANGER, -x);
                } else if key >= 0 {
                    self.agents[key as usize].money += x;
                } else {
                    self.businesses[(-2 - key) as usize].cash += x;
                }
            }
            if !self.debt[ti].holders.is_empty() {
                self.debt[ti].maturity = self.day + 90;
            }
        }
        self.debt.retain(|t| !t.holders.is_empty());
        if ratio < 0.999 {
            self.debt_stress = 1.0;
            let t = format!(
                "Défaut : l'État ne rembourse que {} % des obligations échues, le reste est prolongé de trois mois.",
                js_num(round(ratio * 100.0))
            );
            self.say("crise", t);
        }
    }

    /// Prime de risque exigée par les prêteurs : croît avec la dette / PIB et après une crise.
    fn risk_premium(&self) -> f64 {
        let r = self.debt_total / self.gdp_year();
        0.2 * r * r + 0.04 * self.debt_stress
    }

    /// Émission d'obligations par enchère (prix uniforme).
    pub(super) fn issue_bonds(&mut self, amount: f64) {
        let prem = self.risk_premium();
        let mut bids: Vec<Order> = Vec::new();
        let mut rates: Vec<f64> = vec![0.0]; // tag → taux (tag 0 inutilisé)
        let pr = |r: f64| 1e6 / (1.0 + r);
        let cpn = self.cost_per_nutrition();
        let offer = |bids: &mut Vec<Order>, rates: &mut Vec<f64>, key: i64, money: f64, bonds: f64, investable: f64, base: f64, slope: f64| {
            let willing = investable * 0.5;
            if willing < 1000.0 {
                return;
            }
            for i in 1..=3 {
                let sh = (bonds + (willing * i as f64) / 3.0) / mx(1.0, bonds + money);
                let r = base + prem + slope * sh * sh;
                rates.push(r);
                let tag = (rates.len() - 1) as i32;
                bids.push(Order::tagged(key, willing / 3.0, pr(r), tag));
            }
        };
        for a in self.aa() {
            if !self.is_head(a) || self.agents[a].status == Status::Enfant || self.agents[a].money <= 0.0 {
                continue;
            }
            let cushion = self.household_need(a) * cpn * 1.6 * k::BOND_CUSHION_DAYS;
            // impatience propre à chacun (0,7 à 1,3)
            let taste = 0.7 + 0.6 * ((a as f64 * 0.6180339887) % 1.0);
            let ag = &self.agents[a];
            offer(&mut bids, &mut rates, a as i64, ag.money, ag.bonds, ag.money - cushion, 0.01 * taste, 0.08 * taste);
        }
        for bi in self.ab() {
            let b = &self.businesses[bi];
            if !b.alive || b.workers.is_empty() {
                continue;
            }
            let idle = b.cash - self.reserve_of(bi) * 1.5 - b.offer_wage * b.workers.len() as f64 * 30.0;
            offer(&mut bids, &mut rates, -2 - bi as i64, b.cash, b.bonds, idle, 0.015, 0.08);
        }
        // investisseurs étrangers : taux mondial + prime de risque, dans la limite du plafond
        let p = &self.policy;
        let foreign_room = mx(0.0, p.foreign_debt_cap * self.initial_money * 5.0 - self.foreign_bonds);
        if foreign_room > 1000.0 {
            let r = k::WORLD_RATE + prem * 1.5;
            rates.push(r);
            let tag = (rates.len() - 1) as i32;
            bids.push(Order::tagged(FOREIGN_KEY, mn(foreign_room, amount), pr(r), tag));
        }
        // banque centrale : achète au taux directeur ce que sa politique monétaire demande
        let cb_room = mx(0.0, p.cb_financing * (self.debt_total + amount) - self.cb_bonds);
        let cb_want = mn(cb_room, self.cb_purchase_target());
        if cb_want > 1000.0 {
            rates.push(self.policy_rate);
            let tag = (rates.len() - 1) as i32;
            bids.push(Order::tagged(CB_KEY, cb_want, pr(self.policy_rate), tag));
        }
        let mut asks = [Order::new(STATE_ID, amount, pr(k::BOND_MAX_RATE))];
        let res = call_auction(&mut bids, &mut asks, &mut self.rng);
        // appariements : (détenteur, quantité)
        let mut matches: Vec<(i64, f64)> = Vec::new();
        let mut rate = 0.0;
        let mut placed = 0.0;
        let mut cb_placed = 0.0;
        for m in &res.matches {
            let bid = bids[m.bid];
            let r = if bid.tag > 0 { rates.get(bid.tag as usize).copied().unwrap_or(0.0) } else { 0.0 };
            rate = mx(rate, r);
            matches.push((bid.owner, m.qty));
        }
        for m in &res.matches {
            placed += m.qty;
        }
        for m in &res.matches {
            if bids[m.bid].owner == CB_KEY {
                cb_placed += m.qty;
            }
        }
        // prêteur en dernier ressort : la banque centrale complète une enchère ratée (dans sa limite) ;
        // pas de monnaie nouvelle quand l'inflation dépasse 10 %
        let last_resort = if self.inflation > 0.1 { 0.0 } else { mn(mx(0.0, amount - placed), mx(0.0, cb_room - cb_placed)) };
        if last_resort > 1000.0 {
            matches.push((CB_KEY, last_resort));
            rate = mx(rate, self.policy_rate);
            let t = format!(
                "La banque centrale vole au secours de l'État : elle achète {} écus d'obligations que personne ne voulait, avec de la monnaie nouvelle.",
                js_num(round(last_resort / 100.0))
            );
            self.say("crise", t);
        }
        if matches.is_empty() {
            self.debt_stress = 1.0;
            let t = format!(
                "Enchère ratée : personne ne prête à l'État à moins de {} %. Faute de liquidités, il ne pourra pas tout payer.",
                js_num(round(k::BOND_MAX_RATE * 100.0))
            );
            self.say("crise", t);
            return;
        }
        let mut t = Bond { id: self.next_bond_id, issued: self.day, maturity: self.day + k::BOND_MATURITY as i64, rate, holders: OrderedMap::default() };
        self.next_bond_id += 1;
        let mut sold = 0.0;
        for (key, qty) in matches {
            if key == CB_KEY || key == FOREIGN_KEY {
                // monnaie nouvelle (banque centrale) ou venue de l'étranger
                let x = floor(qty);
                if x <= 0.0 {
                    continue;
                }
                self.mint(if key == CB_KEY { BC } else { ETRANGER }, x);
                self.treasury += x;
                self.hold_bond(&mut t, key, x);
                sold += x;
                continue;
            }
            let cash = if key >= 0 { self.agents[key as usize].money } else { self.businesses[(-2 - key) as usize].cash };
            let x = mn(cash, floor(qty));
            if x <= 0.0 {
                continue;
            }
            if key >= 0 {
                self.agents[key as usize].money -= x;
            } else {
                self.businesses[(-2 - key) as usize].cash -= x;
            }
            self.treasury += x;
            self.hold_bond(&mut t, key, x);
            sold += x;
        }
        if sold <= 0.0 {
            return;
        }
        self.debt.push(t);
        self.debt_total += sold;
        self.d.borrowing += sold;
        let prev = self.last_rate;
        self.last_rate = rate;
        if sold < amount * 0.9 {
            self.debt_stress = mn(1.0, self.debt_stress + 0.5);
            let t = format!(
                "Enchère ratée : l'État ne place que {} % des obligations voulues ({} écus sur {}), au taux de {} %.",
                js_num(round((sold / amount) * 100.0)),
                js_num(round(sold / 100.0)),
                js_num(round(amount / 100.0)),
                fixed(rate * 100.0, 1)
            );
            self.say("crise", t);
        } else if prev > 0.0 && rate > prev + 0.015 && rate > 0.05 {
            let t = format!(
                "Le taux de la dette s'envole : {} % → {} % à la dernière enchère.",
                fixed(prev * 100.0, 1),
                fixed(rate * 100.0, 1)
            );
            self.say("crise", t);
        }
    }

    /// Aide d'urgence après une catastrophe : une part des pertes estimées, versée sur 30 jours.
    pub(super) fn promise_relief(&mut self, kind: EventKind) {
        let rate = self.policy.disaster_relief;
        if rate <= 0.0 || kind == EventKind::Epidemie {
            return;
        }
        let mut total = 0.0;
        let mut n = 0;
        let days = kind.days() as f64;
        for bi in self.ab() {
            let b = &self.businesses[bi];
            if !b.alive || b.workers.is_empty() {
                continue;
            }
            let va = mx(0.0, b.va_ema) * b.workers.len() as f64;
            let mut loss = 0.0;
            if kind == EventKind::MauvaiseRecolte && (b.job == CEREALIER || b.job == ARBORICULTEUR || b.job == ELEVEUR) {
                loss = 0.5 * va * days;
            }
            if kind == EventKind::Tempete {
                loss = (if b.job == PECHEUR { va * days } else { 0.0 }) + b.tools * 0.3 * self.last_w[OUTILS];
            }
            if kind == EventKind::Incendie && b.job == BUCHERON {
                loss = 0.5 * va * 60.0;
            }
            let x = round(loss * rate);
            if x < 100.0 {
                continue;
            }
            self.pending_relief.push(Relief { biz: bi, left: x, daily: ceil(x / 30.0) });
            total += x;
            n += 1;
        }
        if n > 0 {
            let t = format!(
                "Aide d'urgence : l'État promet {} écus à {} entreprises et indépendants touchés ({} % des pertes estimées), versés sur un mois et empruntés hors budget.",
                js_num(round(total / 100.0)),
                n,
                js_num(round(rate * 100.0))
            );
            self.say("politique", t);
        }
    }

    // ------------------------------------------------------------------ banque centrale et banque

    /// Politique monétaire (chaque mois) : inflation sur 12 mois, taux directeur (Taylor lissé).
    fn monetary_policy(&mut self) {
        if self.day as f64 > D / 2.0 {
            self.cpi_log.push(self.cpi_index);
        }
        if self.cpi_log.len() > 24 {
            self.cpi_log.remove(0);
        }
        let n = self.cpi_log.len();
        let avg = |a: &[f64]| {
            let mut s = 0.0;
            for &x in a {
                s += x;
            }
            s / a.len() as f64
        };
        if n >= 24 {
            self.inflation = avg(&self.cpi_log[12..]) / avg(&self.cpi_log[0..12]) - 1.0;
        } else if n >= 12 {
            self.inflation = avg(&self.cpi_log[n - 6..]) / avg(&self.cpi_log[n - 12..n - 6]) - 1.0;
        } else {
            self.inflation = 0.0;
        }
        if (self.day as f64) < D {
            self.inflation = clamp(self.inflation, -0.1, 0.1);
        }
        let t = self.policy.inflation_target;
        if (self.day as f64) < D {
            self.policy_rate = 0.02 + t;
            return;
        }
        let taylor = clamp(0.02 + self.inflation + 0.5 * (self.inflation - t), 0.0, 0.2);
        self.policy_rate += 0.25 * (taylor - self.policy_rate);
    }

    /// Achats d'obligations visés par la banque centrale à l'enchère du mois.
    fn cb_purchase_target(&self) -> f64 {
        let gap = self.policy.inflation_target - self.inflation;
        if gap <= 0.0 || (self.day as f64) < D {
            return 0.0;
        }
        self.money_base * 0.01 * mn(3.0, gap / 0.02)
    }

    /// Crédit bancaire aux entreprises (chaque mois).
    fn bank_credit(&mut self) {
        let rate = self.policy_rate + self.policy.bank_spread;
        // remboursements
        let loans = std::mem::take(&mut self.loans);
        let mut keep: Vec<Loan> = Vec::new();
        for mut l in loans {
            if !self.businesses[l.biz].alive {
                self.loan_loss(&mut l);
                continue;
            }
            let cap = ceil(l.principal / mx(1.0, l.months_left));
            let int = round((l.principal * l.rate) / 12.0);
            if self.businesses[l.biz].cash >= cap + int {
                {
                    let b = &mut self.businesses[l.biz];
                    b.cash -= cap + int;
                    b.other_month += int;
                }
                l.principal -= cap;
                l.months_left -= 1.0;
                self.bank_loans_total -= cap;
                self.mint(BANQUE, -cap);
                self.bank_income_month += int;
                let c = self.cat_of(l.biz);
                self.flow(c, MENAGES, int);
                l.missed = 0.0;
            } else {
                l.missed += 1.0;
                if l.missed >= 3.0 {
                    self.loan_loss(&mut l);
                    continue;
                }
            }
            if l.principal > 0.0 {
                keep.push(l);
            }
        }
        self.loans = keep;
        // intérêts : fonds propres puis déposants
        if self.bank_income_month > 0.0 {
            let retain = round(self.bank_income_month * (if self.bank_equity < 0.0 { 1.0 } else { 0.1 }));
            self.bank_equity += retain;
            self.mint(BANQUE, -retain);
            let pay = self.bank_income_month - retain;
            let savers: Vec<usize> = self.aa().into_iter()
                .filter(|&a| {
                    let ag = &self.agents[a];
                    ag.alive && ag.money > 0.0 && ag.status != Status::Enfant
                })
                .collect();
            let mut tot = 0.0;
            for &a in &savers {
                tot += self.agents[a].money;
            }
            if tot > 0.0 && pay > 0.0 {
                let mut paid = 0.0;
                for &a in &savers {
                    let x = floor((pay * self.agents[a].money) / tot);
                    if x <= 0.0 {
                        continue;
                    }
                    self.pay_agent(a, x, true);
                    paid += x;
                }
                // reste d'arrondi : fonds propres
                self.bank_equity += pay - paid;
                self.mint(BANQUE, -(pay - paid));
            }
            self.bank_income_month = 0.0;
        }
        // nouveaux crédits : à partir de la 2e année, plafond ancré sur le PIB de départ
        let p = self.policy.clone();
        let cap = p.credit_limit * self.initial_money * 5.0;
        if p.credit_limit <= 0.0 || (self.day as f64) < D || self.bank_equity < -0.1 * cap {
            return;
        }
        let mut room = mn(cap - self.bank_loans_total, self.money_base * 0.01);
        // la demande de crédit baisse avec le taux : nulle à 15 %
        let appetite = clamp(1.0 - rate / 0.15, 0.0, 1.0);
        let mut owed: Vec<f64> = vec![0.0; self.businesses.len()];
        for l in &self.loans {
            owed[l.biz] += l.principal;
        }
        let mut cands: Vec<usize> = self.ab().into_iter()
            .filter(|&i| {
                let b = &self.businesses[i];
                b.alive && !b.workers.is_empty() && b.va_per_worker > 0.0
            })
            .collect();
        // les plus rentables d'abord
        cands.sort_by(|&x, &y| ord(self.businesses[y].va_per_worker - self.businesses[x].va_per_worker));
        let ix = self.index_factor();
        for bi in cands {
            if room <= 1000.0 {
                break;
            }
            let b = &self.businesses[bi];
            let nw = b.workers.len() as f64;
            let reserve = self.reserve_of(bi);
            let mut want = 0.0;
            if b.cash < reserve {
                want += reserve * 1.5 - b.cash;
            }
            if b.vacancies > 0.0 || (b.va_per_worker * 0.7 >= p.min_wage * 100.0 * ix * 1.1 && b.cash < b.offer_wage * 40.0 + reserve) {
                want += b.offer_wage * 30.0;
            }
            if b.tools < nw * 0.95 && b.job != CHARPENTIER {
                want += (nw - b.tools) * self.last_w[OUTILS];
            }
            want *= appetite * 0.5;
            if want < 2000.0 {
                continue;
            }
            // capacité de remboursement : mensualités ≤ 30 % de la valeur ajoutée mensuelle
            let va_month = b.va_per_worker * nw * k::DAYS_PER_MONTH;
            let debt = owed[bi];
            let max_debt = (va_month * 0.3) / (1.0 / k::LOAN_MONTHS + rate / 12.0);
            let x = floor(mn(mn(want, max_debt - debt), room));
            if x < 2000.0 {
                continue;
            }
            self.loans.push(Loan { biz: bi, principal: x, rate, months_left: k::LOAN_MONTHS, missed: 0.0 });
            self.bank_loans_total += x;
            self.mint(BANQUE, x);
            self.businesses[bi].cash += x;
            room -= x;
            owed[bi] = debt + x;
        }
    }

    /// Défaut d'un emprunteur : la banque perd le capital ; la monnaie déjà prêtée reste en circulation.
    fn loan_loss(&mut self, l: &mut Loan) {
        self.bank_equity -= l.principal;
        self.bank_loans_total -= l.principal;
        l.principal = 0.0;
    }

    /// Facteur d'indexation des montants publics : IPC moyen du mois écoulé / 100.
    pub fn index_factor(&self) -> f64 {
        if self.policy.indexation { clamp(self.cpi_index / 100.0, 0.05, 50.0) } else { 1.0 }
    }

    /// Faits marquants du mois pour la gazette.
    fn monthly_news(&mut self) {
        let hl = self.history.len();
        if hl < 31 {
            return;
        }
        let mut msgs: Vec<(&'static str, String)> = Vec::new();
        {
            let h = &self.history;
            let now = &h[hl - 1];
            let before = &h[hl - 31];
            for g in RETAIL_GOODS {
                let (Some(a), Some(b)) = (before.retail_price.0[g], now.retail_price.0[g]) else { continue };
                if a == 0.0 || b == 0.0 || a.is_nan() || b.is_nan() {
                    continue;
                }
                let r = b / a - 1.0;
                if r > 0.4 {
                    msgs.push((
                        "prix",
                        format!("Flambée du prix {} : +{} % en un mois ({} é).", OF_GOOD[g], js_num(round(r * 100.0)), fixed(b, 2)),
                    ));
                } else if r < -0.35 {
                    msgs.push(("prix", format!("Le prix {} s'effondre : {} % en un mois.", OF_GOOD[g], js_num(round(r * 100.0)))));
                }
            }
            let month = &h[hl - 30..];
            let mut famine = 0.0;
            for r in month {
                famine += r.deaths[1];
            }
            if famine >= 5.0 {
                msgs.push(("crise", format!("Famine : {} habitants sont morts de faim ce mois-ci.", js_num(famine))));
            }
            let mut hunger = 0.0;
            for r in month {
                hunger += r.hunger_rate;
            }
            hunger /= month.len() as f64;
            if hunger > 0.1 {
                msgs.push(("crise", format!("{} % des habitants ont faim.", js_num(round(hunger * 100.0)))));
            }
            if month.iter().any(|r| r.paid_ratio < 0.95) {
                msgs.push(("crise", "Les caisses de l'État sont vides : pensions et aides n'ont pas pu être entièrement versées.".into()));
            }
            if self.fish_stock < 0.3 * k::FISH_K {
                msgs.push((
                    "ressource",
                    format!("Surpêche : il ne reste que {} % du stock de poissons.", js_num(round((self.fish_stock / k::FISH_K) * 100.0))),
                ));
            }
            if self.forest_stock < 0.3 * k::FOREST_K {
                msgs.push((
                    "ressource",
                    format!("Déforestation : la forêt est réduite à {} %.", js_num(round((self.forest_stock / k::FOREST_K) * 100.0))),
                ));
            }
            if hl >= 91 {
                let old = &h[hl - 91];
                for j in MARKET_JOBS {
                    let a = old.workers_by_job.0[j];
                    let b = now.workers_by_job.0[j];
                    let label = JOB_DEFS[j].label.to_lowercase();
                    if a >= 15.0 && b < a * 0.6 {
                        msgs.push(("societe", format!("Exode : les {}s passent de {} à {} en trois mois.", label, js_num(a), js_num(b))));
                    }
                    if b >= 15.0 && b > mx(a, 5.0) * 1.6 {
                        msgs.push(("societe", format!("Ruée vers le métier de {} : {} → {} en trois mois.", label, js_num(a), js_num(b))));
                    }
                }
            }
        }
        for (kind, text) in msgs {
            self.say(kind, text);
        }
    }

    /// Quintile de patrimoine de chaque adulte, relevé une fois par an (mobilité sociale).
    fn record_quintiles(&mut self) {
        let values = self.biz_values();
        let mut sorted: Vec<(usize, f64)> = self.aa().into_iter()
            .filter(|&a| self.agents[a].alive && self.agents[a].status != Status::Enfant)
            .map(|a| (a, self.wealth_of(a, Some(&values))))
            .collect();
        sorted.sort_by(|x, y| ord(x.1 - y.1));
        let year = (self.day / 360) as usize;
        let n = sorted.len() as f64;
        for (i, &(a, _)) in sorted.iter().enumerate() {
            let q = mn(4.0, floor((i as f64 / n) * 5.0)) as i8;
            let qs = &mut self.agents[a].quintiles;
            if qs.len() <= year {
                qs.resize(year + 1, -1);
            }
            qs[year] = q;
        }
    }

    /// Vide les données des entreprises disparues (allège les instantanés).
    fn compact(&mut self) {
        for bi in std::mem::take(&mut self.dead_biz_pending) {
            let b = &mut self.businesses[bi];
            if b.alive {
                continue;
            }
            b.inv = Inv::new();
            b.shares = OrderedMap::default();
            b.wages = OrderedMap::default();
            b.ask = NO_GOODS;
            b.bid = NO_GOODS;
            b.retail = NO_GOODS;
            b.avg_cost = NO_GOODS;
            b.sales_ema = NO_GOODS;
            b.out_sales = NO_GOODS;
            b.prod_ema = NO_GOODS;
            b.workers = Vec::new();
        }
        for ai in std::mem::take(&mut self.dead_agents_pending) {
            let a = &mut self.agents[ai];
            if !a.alive {
                a.prefs = NO_GOODS;
            }
        }
    }

    /// Dividende public choisi, ou filet automatique sans dette au-delà de 90 jours de dépenses.
    fn redistribute_surplus(&mut self) {
        let days = if self.policy.surplus_days > 0.0 {
            self.policy.surplus_days
        } else if self.debt_total <= 0.0 {
            90.0
        } else {
            0.0
        };
        if days <= 0.0 {
            return;
        }
        let sp = &self.state_month.spending;
        let mut monthly = 0.0;
        for kk in 0..NSPEND {
            monthly += if kk == AIDE_URGENCE || kk == REDISTRIBUTION { 0.0 } else { sp[kk] };
        }
        let target = (monthly / k::DAYS_PER_MONTH) * days;
        let excess = self.treasury - target;
        if excess <= 0.0 {
            return;
        }
        let adults: Vec<usize> = self.aa().into_iter().filter(|&a| self.agents[a].alive && self.agents[a].status != Status::Enfant).collect();
        if adults.is_empty() {
            return;
        }
        let each = floor(excess / adults.len() as f64);
        if each <= 0.0 {
            return;
        }
        for a in adults {
            self.spend(REDISTRIBUTION, a, each, false);
        }
    }
}
