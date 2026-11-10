//! Santé (médecins libéraux, sécurité sociale, assureurs) et école.

use super::*;

impl Simulation {
    /// Probabilité quotidienne de tomber malade (hors épidémie).
    fn sick_prob(&self, a: usize) -> f64 {
        let ag = &self.agents[a];
        0.0012
            * (1.0 + self.age_y(a) / 40.0)
            * (1.0 + 2.0 * (1.0 - ag.health / 100.0))
            * (if ag.fed < 0.7 { 2.0 } else { 1.0 })
            * self.env_sick
    }

    /// Part des maladies qui sont graves : croît avec l'âge.
    fn severe_share(&self, a: usize) -> f64 {
        0.06 + 0.0025 * self.age_y(a)
    }

    /// Plafond de santé : baisse avec l'âge ; un suivi médical récent en rattrape une partie.
    pub fn health_ceiling(&self, a: usize) -> f64 {
        let base = self.max_health(a);
        if self.day as f64 > self.agents[a].care_until {
            return base;
        }
        base + 0.4 * (100.0 - base)
    }

    fn fee_of(&mut self, b: usize) -> f64 {
        if self.businesses[b].fee <= 0.0 {
            self.businesses[b].fee = self.ref_fee();
        }
        self.businesses[b].fee
    }
    fn ref_fee(&self) -> f64 {
        mx(10.0, (self.avg_income * 1.3) / k::ACTS_PER_DOCTOR)
    }

    /// Assureur santé encore en activité ?
    pub(super) fn valid_insurer(&self, id: i64) -> Option<usize> {
        if id < 0 {
            return None;
        }
        let b = &self.businesses[id as usize];
        if b.alive && b.job == ASSUREUR && !b.workers.is_empty() { Some(id as usize) } else { None }
    }

    /// Unités de risque d'un foyer.
    fn household_units(&self, h: usize) -> f64 {
        let r = self.policy.insurance_risk_rating;
        let mut u = pow(risk_class(self.age_y(h)), r);
        for &c in &self.agents[h].children {
            if self.agents[c].alive && self.age_y(c) < k::ADULT_AGE {
                u += pow(risk_class(self.age_y(c)), r);
            }
        }
        u
    }

    /// Part d'une prime mensuelle que l'État prend en charge (subside), en centimes.
    fn subsidy_of(&self, h: usize, monthly: f64) -> f64 {
        let cap = self.policy.premium_income_cap;
        if cap <= 0.0 {
            return 0.0;
        }
        mx(0.0, monthly - round(cap * self.agents[h].last_income))
    }

    pub(super) fn healthcare(&mut self) {
        let ix = self.index_factor();
        let epi = if self.has_event(EventKind::Epidemie) { 8.0 } else { 1.0 };
        self.collect_premiums();
        let mut sick: Vec<usize> = Vec::new();
        let mut follow: Vec<usize> = Vec::new();
        for a in self.aa() {
            if !self.agents[a].alive {
                continue;
            }
            if !self.agents[a].sick && self.rng.next() < self.sick_prob(a) * epi {
                let sev = self.rng.next() < self.severe_share(a);
                let ag = &mut self.agents[a];
                ag.sick = true;
                ag.severe = sev;
                ag.care_need = if sev { k::SEVERE_ACTS } else { 1.0 };
            }
            if self.agents[a].sick {
                sick.push(a);
            } else if self.age_y(a) >= k::FOLLOW_UP_AGE && self.day as f64 - self.agents[a].last_care >= k::FOLLOW_UP_EVERY {
                follow.push(a);
            }
        }
        sick.sort_by(|&x, &y| ord(self.agents[x].health - self.agents[y].health));
        self.rng.shuffle(&mut follow);
        let mut patients = sick;
        patients.extend(follow);
        let mut docs: Vec<usize> = self.ab().into_iter()
            .filter(|&i| {
                let b = &self.businesses[i];
                b.alive && b.job == MEDECIN && b.potential > 0.0
            })
            .collect();
        for &b in &docs {
            self.businesses[b].acts_day = 0.0;
        }
        for &b in &docs {
            self.fee_of(b);
        }
        docs.sort_by(|&x, &y| ord(self.businesses[x].fee - self.businesses[y].fee));
        let mut di = 0usize;
        let mut shortage = 0.0;
        let mut fee_sum = 0.0;
        let food_day = self.cost_per_nutrition();
        let mut treated = vec![false; self.agents.len()];
        let p = self.policy.clone();
        for &a in &patients {
            let acts = 1.0;
            while di < docs.len() && self.businesses[docs[di]].acts_day + acts > self.businesses[docs[di]].potential + 0.5 {
                di += 1;
            }
            let payer = if self.is_head(a) { a } else { self.agents[a].parent as usize };
            if di >= docs.len() {
                if self.agents[payer].money > 0.0 {
                    shortage += acts;
                }
                self.d.care_no_doctor += acts;
                continue;
            }
            let doc = docs[di];
            let price = round(self.fee_of(doc) * acts);
            // sécurité sociale : une part du tarif de référence ; pour un foyer modeste, une part des honoraires réels
            let mut secu = round(p.secu_rate * mn(price, p.secu_tariff * 100.0 * ix * acts));
            if self.agents[payer].money < 4.0 * p.social_aid_threshold * 100.0 * ix * self.household_size(payer) {
                secu = mx(secu, round(p.secu_rate_poor * price));
            }
            let secu_need = secu;
            secu = mn(price, round(secu * self.budget_cut));
            secu = mx(0.0, mn(secu, self.treasury));
            // assureur : une part de ce qui reste
            let ins = self.valid_insurer(self.agents[payer].insurer);
            let mut ins_pay = if ins.is_some() { round(p.insurance_coverage * (price - secu)) } else { 0.0 };
            if let Some(i) = ins {
                ins_pay = mx(0.0, mn(ins_pay, self.businesses[i].cash));
            }
            let oop = price - secu - ins_pay;
            let food_need = self.household_need(payer) * food_day;
            let pm = self.agents[payer].money;
            let room = if self.agents[a].sick {
                mx(0.0, pm - food_need * 5.0) * (if self.agents[a].health < 50.0 { 0.8 } else { 0.5 })
            } else {
                mx(0.0, pm - food_need * k::SAVINGS_BUFFER_DAYS) * 0.1
            };
            if oop > room {
                self.d.care_denied += acts;
                continue;
            }
            self.need_month[REMBOURSEMENTS_SANTE] += secu_need;
            if secu > 0.0 {
                self.treasury -= secu;
                self.d.spending[REMBOURSEMENTS_SANTE] += secu;
                self.state_month.spending[REMBOURSEMENTS_SANTE] += secu;
                self.flow(ETAT, F_SANTE, secu);
            }
            if let Some(i) = ins {
                if ins_pay > 0.0 {
                    let b = &mut self.businesses[i];
                    b.cash -= ins_pay;
                    b.cost_day += ins_pay;
                    b.input_day += ins_pay;
                    b.input_month += ins_pay;
                    b.claims_month += ins_pay;
                    self.flow(F_ASSURANCE, F_SANTE, ins_pay);
                }
            }
            if oop > 0.0 {
                self.agents[payer].money -= oop;
                self.flow(MENAGES, F_SANTE, oop);
            }
            {
                let d = &mut self.businesses[doc];
                d.cash += price;
                d.rev_day += price;
                d.rev_month += price;
                d.acts_day += acts;
            }
            for wi in 0..self.businesses[doc].workers.len() {
                let id = self.businesses[doc].workers[wi];
                let w = &mut self.agents[id];
                if !w.sick {
                    w.xp = mn(1.0, w.xp + 1.0 / 180.0);
                }
            }
            self.d.care_acts += acts;
            self.d.care_spend[0] += oop;
            self.d.care_spend[1] += secu;
            self.d.care_spend[2] += ins_pay;
            fee_sum += price;
            let day = self.day as f64;
            self.agents[a].last_care = day;
            if self.agents[a].sick {
                treated[a] = true;
                self.agents[a].care_need -= acts;
                if self.agents[a].care_need <= 0.0 {
                    let hc = self.health_ceiling(a);
                    let ag = &mut self.agents[a];
                    ag.sick = false;
                    ag.severe = false;
                    ag.health = mn(hc, ag.health + 4.0);
                }
            } else {
                self.agents[a].care_until = day + k::CARE_DAYS;
                let hc = self.health_ceiling(a);
                let ag = &mut self.agents[a];
                ag.health = mn(hc, ag.health + 3.0);
            }
        }
        self.care_shortage = shortage;
        if self.d.care_acts > 0.0 {
            self.avg_fee = fee_sum / self.d.care_acts;
        } else if self.avg_fee == 0.0 || self.avg_fee.is_nan() {
            self.avg_fee = self.ref_fee();
        }
        // honoraires : cabinet plein et patients refoulés → hausse ; cabinet peu occupé → baisse
        let rf = self.ref_fee();
        let fl = (self.avg_income * 0.4) / k::ACTS_PER_DOCTOR;
        for &b in &docs {
            let cap = mx(1.0, floor(self.businesses[b].potential + 0.5));
            {
                let x = &mut self.businesses[b];
                x.occupancy = x.occupancy * 0.9 + mn(1.0, x.acts_day / cap) * 0.1;
            }
            let mut f = self.fee_of(b);
            let occ = self.businesses[b].occupancy;
            if occ >= 0.9 && shortage > 0.0 {
                f *= 1.0 + self.rng.range(0.002, 0.01);
            } else if occ < 0.7 {
                f *= 1.0 - self.rng.range(0.003, 0.015) * (0.7 - occ) / 0.7;
            }
            self.businesses[b].fee = clamp(f, fl, rf * 3.0);
        }
        let culture_cov = self.culture_cov;
        for a in self.aa() {
            if !self.agents[a].alive {
                continue;
            }
            let y = self.age_y(a);
            if self.agents[a].sick && !treated[a] {
                self.d.sick_untreated += 1.0;
                // sans soins, une maladie grave ronge la santé et guérit rarement d'elle-même
                let sev = self.agents[a].severe;
                self.agents[a].health -= if sev { 2.5 } else if y < 10.0 || y > 65.0 { 3.0 } else { 2.0 };
                if self.rng.next() < (if sev { 0.04 } else { 0.07 }) {
                    self.agents[a].sick = false;
                    self.agents[a].severe = false;
                }
            }
            let hc = self.health_ceiling(a);
            let ag = &mut self.agents[a];
            if ag.fed >= 0.9 {
                ag.health += 0.4 + 0.05 * (culture_cov - 1.0); // culture et sport
            } else {
                ag.health -= 4.0 * pow(1.0 - ag.fed, 1.4);
            }
            if ag.cold {
                ag.health -= 0.15;
            }
            ag.health = mn(ag.health, hc);
        }
    }

    /// Primes d'assurance, prélevées chaque jour (1/30 de la prime mensuelle).
    fn collect_premiums(&mut self) {
        for &bi in &self.alive_biz {
            let b = &mut self.businesses[bi];
            if b.alive && b.job == ASSUREUR {
                b.insured_n = 0.0;
                b.insured_units = 0.0;
            }
        }
        for h in self.aa() {
            if self.agents[h].insurer < 0 {
                continue;
            }
            let b = if self.is_head(h) { self.valid_insurer(self.agents[h].insurer) } else { None };
            let Some(b) = b else {
                self.agents[h].insurer = -1;
                continue;
            };
            let units = self.household_units(h);
            let monthly = round(self.businesses[b].premium * units);
            let due = round(monthly / k::DAYS_PER_MONTH);
            let mut state = mn(due, round(self.subsidy_of(h, monthly) / k::DAYS_PER_MONTH));
            self.need_month[SUBSIDES_PRIMES] += mx(0.0, state);
            state = mx(0.0, mn(mn(round(state * self.budget_cut), due), self.treasury));
            let own = due - state;
            if self.agents[h].money < own {
                self.agents[h].insurer = -1;
                self.businesses[b].lost_month += 1.0;
                continue;
            }
            self.agents[h].money -= own;
            self.flow(MENAGES, F_ASSURANCE, own);
            if state > 0.0 {
                self.treasury -= state;
                self.d.spending[SUBSIDES_PRIMES] += state;
                self.state_month.spending[SUBSIDES_PRIMES] += state;
                self.flow(ETAT, F_ASSURANCE, state);
            }
            let hs = self.household_size(h);
            let x = &mut self.businesses[b];
            x.cash += due;
            x.rev_day += due;
            x.rev_month += due;
            x.premiums_month += due;
            x.insured_n += hs;
            x.insured_units += units;
            x.unit_days += units;
        }
    }

    /// Tarifs des assureurs (chaque mois).
    pub(super) fn price_insurance(&mut self) {
        let industry = self.actuarial_claims();
        let min_loss = self.policy.insurance_min_loss_ratio;
        for bi in self.ab() {
            {
                let b = &self.businesses[bi];
                if !b.alive || b.job != ASSUREUR || b.workers.is_empty() {
                    continue;
                }
            }
            let units = self.businesses[bi].unit_days / k::DAYS_PER_MONTH;
            if units > 0.5 {
                let b = &mut self.businesses[bi];
                b.claims_per_unit = b.claims_per_unit * 0.3 + (b.claims_month / units) * 0.7;
            }
            // remboursement de l'excédent de primes (ratio sinistres / primes minimal)
            if min_loss > 0.0 && self.businesses[bi].premiums_month > 0.0 {
                let b = &self.businesses[bi];
                let rebate = mn(b.cash, round(b.premiums_month * min_loss - b.claims_month));
                if rebate > 0.0 {
                    self.rebate(bi, rebate);
                }
            }
            let cred = units / (units + 300.0);
            let nw = self.businesses[bi].workers.len() as f64;
            let claims = cred * self.businesses[bi].claims_per_unit + (1.0 - cred) * industry;
            let admin = (self.avg_income * k::DAYS_PER_MONTH * nw) / mx(units, 0.4 * k::CONTRACTS_PER_INSURER * nw);
            let reserve = self.reserve_of(bi);
            let (cash, insured_n, potential, lost) = {
                let b = &self.businesses[bi];
                (b.cash, b.insured_n, b.potential, b.lost_month)
            };
            // provisions entamées : on remonte la marge pour les reconstituer
            if cash < reserve * 0.5 && units > 10.0 {
                self.businesses[bi].markup += 0.05;
            } else if insured_n >= potential * 0.95 {
                self.businesses[bi].markup += 0.03;
            } else if lost > 0.1 * mx(5.0, insured_n / 2.0) {
                self.businesses[bi].markup -= 0.04;
            } else {
                let m = self.businesses[bi].markup;
                let r = self.rng.range(-0.005, 0.005);
                self.businesses[bi].markup -= 0.01 * (m - 0.05) + r;
            }
            let b = &mut self.businesses[bi];
            b.markup = clamp(b.markup, -0.1, 0.6);
            let target = mx(5.0, (claims + admin) * (1.0 + b.markup));
            b.premium = if b.premium > 0.0 { b.premium * 0.5 + target * 0.5 } else { target };
            b.premiums_month = 0.0;
            b.claims_month = 0.0;
            b.unit_days = 0.0;
            b.lost_month = 0.0;
        }
    }

    /// Sinistres mensuels attendus par unité de risque si toute la population était assurée (centimes).
    fn actuarial_claims(&self) -> f64 {
        let p = &self.policy;
        let fee = or(self.avg_fee, self.ref_fee());
        let secu_share = p.secu_rate * mn(1.0, (p.secu_tariff * 100.0 * self.index_factor()) / fee);
        let mut cost = 0.0;
        let mut units = 0.0;
        for a in self.aa() {
            if !self.agents[a].alive {
                continue;
            }
            cost += self.expected_care(a);
            units += pow(risk_class(self.age_y(a)), p.insurance_risk_rating);
        }
        if units > 0.0 { (cost / units) * (1.0 - secu_share) * p.insurance_coverage } else { 0.0 }
    }

    /// Rend `cents` aux foyers assurés par `b`, au prorata de leurs unités de risque.
    fn rebate(&mut self, bi: usize, cents: f64) {
        let heads: Vec<usize> = self.aa().into_iter().filter(|&h| self.agents[h].insurer == bi as i64 && self.is_head(h)).collect();
        let units: Vec<f64> = heads.iter().map(|&h| self.household_units(h)).collect();
        let mut tot = 0.0;
        for &u in &units {
            tot += u;
        }
        if tot <= 0.0 {
            return;
        }
        let mut paid = 0.0;
        for (i, &h) in heads.iter().enumerate() {
            let x = floor((cents * units[i]) / tot);
            if x <= 0.0 {
                continue;
            }
            self.agents[h].money += x;
            paid += x;
        }
        let b = &mut self.businesses[bi];
        b.cash -= paid;
        b.input_month += paid;
        b.va_ema -= (paid / mx(1.0, b.workers.len() as f64)) * 0.05;
        self.flow(F_ASSURANCE, MENAGES, paid);
    }

    /// Coût de soins mensuel attendu d'une personne (centimes), avant sécu et assurance.
    fn expected_care(&self, a: usize) -> f64 {
        let per_episode = 1.0 + self.severe_share(a) * (k::SEVERE_ACTS - 1.0);
        let acts = k::DAYS_PER_MONTH * self.sick_prob(a) * per_episode
            + (if self.age_y(a) >= k::FOLLOW_UP_AGE { k::DAYS_PER_MONTH / k::FOLLOW_UP_EVERY } else { 0.0 });
        acts * self.avg_fee
    }

    /// Choix d'assurance des foyers (chaque mois).
    pub(super) fn choose_insurance(&mut self) {
        let p = self.policy.clone();
        let ix = self.index_factor();
        let offers: Vec<usize> = self.ab().into_iter()
            .filter(|&i| {
                let b = &self.businesses[i];
                b.alive && b.job == ASSUREUR && !b.workers.is_empty()
            })
            .collect();
        let fresh: Vec<usize> = offers.iter().copied().filter(|&b| self.businesses[b].premium <= 0.0).collect();
        if !fresh.is_empty() {
            // nouvel assureur : il s'aligne sur le marché, ou sur les statistiques s'il est seul
            let others: Vec<usize> = offers.iter().copied().filter(|&b| self.businesses[b].premium > 0.0).collect();
            let market = if others.is_empty() {
                0.0
            } else {
                let mut s = 0.0;
                for &b in &others {
                    s += self.businesses[b].premium;
                }
                s / others.len() as f64
            };
            let est = self.actuarial_claims() * 1.3 + (self.avg_income * k::DAYS_PER_MONTH) / (0.4 * k::CONTRACTS_PER_INSURER);
            for &b in &fresh {
                self.businesses[b].premium = or(market, est);
            }
        }
        if offers.is_empty() {
            for &h in &self.alive_agents {
                self.agents[h].insurer = -1;
            }
            return;
        }
        let mut seats = vec![0.0; self.businesses.len()];
        for &b in &offers {
            seats[b] = self.businesses[b].potential - self.businesses[b].insured_n;
        }
        let fee = or(self.avg_fee, self.ref_fee());
        let secu_share = p.secu_rate * mn(1.0, (p.secu_tariff * 100.0 * ix) / fee);
        let mut heads: Vec<usize> = self.aa().into_iter().filter(|&h| self.is_head(h)).collect();
        self.rng.shuffle(&mut heads);
        for &h in &heads {
            let cur = self.valid_insurer(self.agents[h].insurer);
            // inertie : un foyer sur quatre réexamine son contrat chaque mois
            let must = if p.insurance_mandatory { cur.is_none() } else { self.agents[h].insurer >= 0 && cur.is_none() };
            if !must && self.rng.next() > 0.25 {
                continue;
            }
            let units = self.household_units(h);
            let size = self.household_size(h);
            let mut best: Option<usize> = None;
            let mut best_p = f64::INFINITY;
            for &b in &offers {
                let pr = self.businesses[b].premium * self.rng.range(0.97, 1.03);
                if Some(b) != cur && seats[b] < size {
                    continue;
                }
                if pr < best_p {
                    best_p = pr;
                    best = Some(b);
                }
            }
            let Some(best) = best else { continue };
            let net = |s: &Simulation, b: usize| {
                let m = s.businesses[b].premium * units;
                m - s.subsidy_of(h, m)
            };
            let choice: Option<usize> = if p.insurance_mandatory {
                match cur {
                    Some(c) if net(self, c) <= net(self, best) * 1.05 => Some(c),
                    _ => Some(best),
                }
            } else {
                let mut expected = self.expected_care(h);
                for c in self.dependents(h) {
                    expected += self.expected_care(c);
                }
                let covered = expected * (1.0 - secu_share) * p.insurance_coverage;
                let episode = fee * k::SEVERE_ACTS * (1.0 - secu_share);
                let money = self.agents[h].money;
                let aversion = 1.4 + (if episode > 0.3 * money { 0.8 } else { 0.0 });
                let budget = 0.12 * self.agents[h].last_income + 0.04 * money;
                let ok = |s: &Simulation, b: usize| {
                    let n = net(s, b);
                    n <= covered * aversion * (if Some(b) == cur { 1.15 } else { 1.0 }) && n <= budget
                };
                match cur {
                    Some(c) if ok(self, c) && net(self, c) <= net(self, best) * 1.05 => Some(c),
                    _ => {
                        if ok(self, best) {
                            Some(best)
                        } else {
                            None
                        }
                    }
                }
            };
            if choice != cur {
                if let Some(c) = cur {
                    self.businesses[c].lost_month += 1.0;
                }
                if let Some(c) = choice {
                    seats[c] -= size;
                }
                self.agents[h].insurer = match choice {
                    Some(c) => c as i64,
                    None => -1,
                };
            }
        }
    }

    pub(super) fn schooling(&mut self) {
        let mut teachers = 0.0;
        let mut kids: Vec<usize> = Vec::new();
        for a in self.aa() {
            let ag = &self.agents[a];
            if !ag.alive {
                continue;
            }
            if ag.public_job && ag.job == Some(ENSEIGNANT) && !ag.sick {
                teachers += 1.0;
            }
            let y = self.age_y(a);
            if y >= k::SCHOOL_START && y < k::ADULT_AGE {
                kids.push(a);
            }
        }
        let pr = if kids.is_empty() { 0.0 } else { mn(1.0, (teachers * k::PUPILS_PER_TEACHER) / kids.len() as f64) };
        for &kd in &kids {
            if self.agents[kd].sick {
                continue;
            }
            // matériel scolaire : ±15 % de progrès autour du niveau par défaut
            let f = 0.85 + 0.15 * self.school_cov;
            let inc = if self.rng.next() < pr { f / (10.0 * D) } else { 0.15 / (10.0 * D) };
            let ag = &mut self.agents[kd];
            ag.edu = mn(1.0, ag.edu + inc);
        }
    }
}
