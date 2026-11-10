//! Finances des entreprises, recettes et versements de l'État.

use super::*;

#[derive(Clone, Copy, PartialEq)]
enum Amount {
    Salary,
    Pension,
    Aid,
    Family,
    Sick,
    Unemployment,
    Ubi,
}

impl Simulation {
    pub(super) fn business_finance(&mut self) {
        let shop_rent = self.policy.shop_rent;
        let min_wage = self.policy.min_wage;
        for bi in self.ab() {
            if !self.businesses[bi].alive {
                continue;
            }
            let cat = self.cat_of(bi);
            let is_commerce = JOB_DEFS[self.businesses[bi].job].cat == Cat::Commerce;
            // salaires
            let mut tot_w = 0.0;
            for id in &self.businesses[bi].workers {
                tot_w += self.businesses[bi].wages.get(id).copied().unwrap_or(0.0);
            }
            if tot_w > 0.0 {
                let cash = self.businesses[bi].cash;
                let ratio = if cash >= tot_w { 1.0 } else { cash / tot_w };
                if ratio < 1.0 {
                    self.businesses[bi].arrears += 1.0;
                }
                for wi in 0..self.businesses[bi].workers.len() {
                    let id = self.businesses[bi].workers[wi];
                    let w = floor(self.businesses[bi].wages.get(&id).copied().unwrap_or(0.0) * ratio);
                    if w <= 0.0 {
                        continue;
                    }
                    self.businesses[bi].cash -= w;
                    self.pay_agent(id, w, true);
                    let b = &mut self.businesses[bi];
                    b.cost_day += w;
                    b.wage_month += w;
                    self.flow(cat, MENAGES, w);
                }
            }
            let nw = self.businesses[bi].workers.len() as f64;
            // locaux commerciaux
            if is_commerce && nw > 0.0 {
                let rent = mn(self.businesses[bi].cash, round(shop_rent * 100.0 * (1.0 + 0.3 * (nw - 1.0))));
                if rent > 0.0 {
                    let b = &mut self.businesses[bi];
                    b.cash -= rent;
                    b.cost_day += rent;
                    b.other_month += rent;
                    self.collect(LOYERS, rent);
                    self.flow(cat, ETAT, rent);
                }
            }
            {
                let b = &mut self.businesses[bi];
                b.tools *= 1.0 - k::TOOL_DEPRECIATION;
                b.cost_ema = b.cost_ema * 0.9 + b.cost_day * 0.1;
                if nw > 0.0 {
                    let rent = if is_commerce { shop_rent * 100.0 * (1.0 + 0.3 * (nw - 1.0)) } else { 0.0 };
                    b.va_ema = b.va_ema * 0.95 + ((b.rev_day - b.input_day - rent) / nw) * 0.05;
                }
            }
            let reserve = self.reserve_of(bi);
            // apport du patron si l'entreprise manque de fonds pour ses achats
            let owner = self.businesses[bi].owner;
            if owner >= 0 {
                let o = owner as usize;
                if self.agents[o].alive
                    && self.businesses[bi].cash < reserve * 0.3
                    && cat != F_PRODUCTION
                    && self.businesses[bi].workers.contains(&o)
                {
                    let inj = mn(floor(self.agents[o].money * 0.3), round(reserve * 0.5 - self.businesses[bi].cash));
                    if inj > 0.0 {
                        self.agents[o].money -= inj;
                        self.businesses[bi].cash += inj;
                    }
                }
            }
            // dividendes
            let b = &self.businesses[bi];
            let keep = reserve
                + (if b.workers.len() > 1 || b.va_per_worker * 0.7 > min_wage * 100.0 * 1.1 { b.offer_wage * 15.0 } else { 0.0 });
            if b.cash > keep {
                let div = floor((b.cash - keep) * 0.3);
                let mut paid = 0.0;
                let shares: Vec<(i64, f64)> = b.shares.iter().map(|(&k, &v)| (k, v)).collect();
                for (id, s) in shares {
                    let x = floor(div * s);
                    if x <= 0.0 {
                        continue;
                    }
                    paid += x;
                    if id == STATE_ID {
                        self.collect(DIVIDENDES, x);
                        self.flow(cat, ETAT, x);
                    } else {
                        self.pay_agent(id as usize, x, true);
                        self.flow(cat, MENAGES, x);
                    }
                }
                self.businesses[bi].cash -= paid;
            }
        }
    }

    /// Trésorerie que l'entreprise garde avant de verser des dividendes.
    pub fn reserve_of(&self, bi: usize) -> f64 {
        let b = &self.businesses[bi];
        if b.job == ASSUREUR {
            return mx(5000.0, b.claims_per_unit * b.insured_units * 2.0);
        }
        mx(3000.0, b.cost_ema * 4.0)
    }

    pub(super) fn collect(&mut self, k: RevKey, cents: f64) {
        if cents <= 0.0 {
            return;
        }
        self.treasury += cents;
        self.d.revenue[k] += cents;
        self.state_month.revenue[k] += cents;
    }

    pub(super) fn spend(&mut self, k: SpendKey, a: usize, cents: f64, taxable: bool) {
        if cents <= 0.0 {
            return;
        }
        self.treasury -= cents;
        self.pay_agent(a, cents, taxable);
        self.d.spending[k] += cents;
        self.state_month.spending[k] += cents;
        self.flow(ETAT, MENAGES, cents);
    }

    fn amount(&self, kind: Amount, a: usize) -> f64 {
        let p = &self.policy;
        let ix = self.index_factor();
        match kind {
            Amount::Salary => round(p.public_salary * 100.0 * ix),
            Amount::Pension => round(p.pension * 100.0 * ix),
            Amount::Aid => {
                let n = self.household_size(a);
                mn(round(p.social_aid_amount * 100.0 * ix * n), round(p.social_aid_threshold * 100.0 * ix * n) - self.agents[a].money)
            }
            Amount::Family => {
                let n = self.n_dependents(a) as f64 + (if self.agents[a].status == Status::Enfant { 1.0 } else { 0.0 });
                round(p.family_allowance * 100.0 * ix * n)
            }
            Amount::Sick => round(p.sick_pay * 100.0 * ix),
            Amount::Unemployment => round(p.unemployment_benefit * 100.0 * ix),
            Amount::Ubi => round(p.ubi * 100.0 * ix),
        }
    }

    pub(super) fn state_payments(&mut self) {
        let ix = self.index_factor();
        let cut = self.budget_cut;
        let mut staff: Vec<(SpendKey, Vec<usize>)> = Vec::new();
        let mut retirees = Vec::new();
        let mut adults = Vec::new();
        let mut poor = Vec::new();
        let mut parents = Vec::new();
        let mut sick_w = Vec::new();
        let mut unemployed = Vec::new();
        let aid_threshold = self.policy.social_aid_threshold;
        for a in self.aa() {
            let ag = &self.agents[a];
            if !ag.alive {
                continue;
            }
            if ag.public_job {
                if let Some(j) = ag.job {
                    let k = staff_key(j);
                    if let Some(e) = staff.iter_mut().find(|e| e.0 == k) {
                        e.1.push(a);
                    } else {
                        staff.push((k, vec![a]));
                    }
                }
            }
            if ag.status == Status::Retraite {
                retirees.push(a);
            }
            if ag.status != Status::Enfant {
                adults.push(a);
            }
            if (ag.status == Status::Actif && !ag.public_job && ag.sick)
                || ((ag.status == Status::Actif || ag.status == Status::Chomeur) && ag.health < 35.0)
            {
                sick_w.push(a);
            }
            if ag.status == Status::Chomeur {
                unemployed.push(a);
            }
            if self.is_head(a) {
                if self.agents[a].money < aid_threshold * 100.0 * self.household_size(a) * ix {
                    poor.push(a);
                }
                if self.n_dependents(a) > 0 || self.agents[a].status == Status::Enfant {
                    parents.push(a);
                }
            }
        }
        // aide d'urgence promise après une catastrophe : dépense exceptionnelle, hors règle budgétaire
        if !self.pending_relief.is_empty() {
            for i in 0..self.pending_relief.len() {
                let r = self.pending_relief[i].clone();
                let x = mn(mn(r.left, r.daily), mx(0.0, self.treasury));
                if !self.businesses[r.biz].alive {
                    self.pending_relief[i].left = 0.0;
                    continue;
                }
                if x <= 0.0 {
                    continue;
                }
                self.pending_relief[i].left -= x;
                self.state_out(AIDE_URGENCE, x);
                self.businesses[r.biz].cash += x;
                let c = self.cat_of(r.biz);
                self.flow(ETAT, c, x);
            }
            self.pending_relief.retain(|r| r.left > 0.0);
        }
        // montants dus (besoins) ; le budget voté n'en finance qu'une part (`cut`)
        let mut plan: Vec<(SpendKey, Vec<usize>, Amount, bool, f64, bool)> = Vec::new();
        for (k, list) in staff {
            plan.push((k, list, Amount::Salary, true, 1.0, true));
        }
        plan.push((PENSIONS, retirees, Amount::Pension, true, cut, false));
        plan.push((AIDE_SOCIALE, poor, Amount::Aid, false, cut, false));
        plan.push((ALLOCATIONS_FAMILIALES, parents, Amount::Family, false, cut, false));
        plan.push((INDEMNITES_MALADIE, sick_w, Amount::Sick, true, cut, false));
        plan.push((CHOMAGE, unemployed, Amount::Unemployment, true, cut, false));
        plan.push((REVENU_UNIVERSEL, adults, Amount::Ubi, false, cut, false));
        let staff_keys: Vec<SpendKey> = plan.iter().filter(|x| x.5).map(|x| x.0).collect();
        let totals: Vec<f64> = plan
            .iter()
            .map(|(_, list, kind, _, _, _)| {
                let mut s = 0.0;
                for &a in list {
                    s += mx(0.0, self.amount(*kind, a));
                }
                s
            })
            .collect();
        // avance de trésorerie : si la caisse ne couvre pas les versements du jour, l'État emprunte
        let mut due = 0.0;
        for (i, x) in plan.iter().enumerate() {
            due += totals[i] * x.4;
        }
        if due > 0.0 && self.treasury < due {
            self.issue_bonds(round(due * 5.0 - self.treasury));
        }
        let mut worst = 1.0;
        for (i, (k, list, kind, taxable, share, _)) in plan.iter().enumerate() {
            let mut tot = totals[i];
            if *share != 1.0 || !staff_keys.contains(k) {
                self.need_month[*k] += tot;
            }
            tot *= share;
            if tot <= 0.0 {
                continue;
            }
            let ratio = if self.treasury >= tot { 1.0 } else { mx(0.0, self.treasury) / tot };
            worst = mn(worst, ratio);
            for &a in list {
                let x = floor(mx(0.0, self.amount(*kind, a)) * share * ratio);
                self.spend(*k, a, x, *taxable);
            }
        }
        self.d.paid_ratio = worst;
    }

    /// Sortie de caisse de l'État sans bénéficiaire habitant (l'appelant crédite le destinataire).
    pub(super) fn state_out(&mut self, k: SpendKey, cents: f64) {
        if cents <= 0.0 {
            return;
        }
        self.treasury -= cents;
        self.book(k, cents);
    }

    /// Inscrit une dépense déjà sortie de la caisse dans les comptes du jour et du mois.
    pub(super) fn book(&mut self, k: SpendKey, cents: f64) {
        if cents <= 0.0 {
            return;
        }
        self.d.spending[k] += cents;
        self.state_month.spending[k] += cents;
    }
}
