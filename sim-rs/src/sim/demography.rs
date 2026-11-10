//! Démographie, successions, emploi, entreprises (création, fusion, dissolution), fonction publique.

use super::*;

impl Simulation {
    pub(super) fn demography(&mut self) {
        let retirement = self.policy.retirement_age;
        for i in self.aa() {
            if !self.agents[i].alive {
                continue;
            }
            let y = self.age_y(i);
            if self.agents[i].health <= 0.0 {
                let cause = if self.agents[i].hunger > 0.3 { DeathCause::Faim } else { DeathCause::Maladie };
                self.die(i, cause);
                continue;
            }
            let m = 0.00005 * exp(0.095 * y) + (if y < 5.0 { 0.003 } else { 0.0 });
            if self.rng.next() < (m / D) * (1.0 + 2.0 * (1.0 - self.agents[i].health / 100.0)) {
                self.die(i, if y > 55.0 { DeathCause::Age } else { DeathCause::Maladie });
                continue;
            }
            // passage à l'âge adulte
            if self.agents[i].status == Status::Enfant && y >= k::ADULT_AGE {
                self.agents[i].status = Status::Chomeur;
                self.choose_job(i, None);
            }
            // retraite
            let st = self.agents[i].status;
            if (st == Status::Actif || st == Status::Chomeur) && y >= retirement {
                self.retire(i);
            }
            // naissances
            let a = &self.agents[i];
            if y >= 18.0 && y < 42.0 && a.health > 50.0 && a.hunger < 0.2 {
                let kids = self.n_dependents(i);
                if kids < 4 {
                    let wealth_f = clamp(self.agents[i].money / (60.0 * 250.0), 0.3, 1.3);
                    if self.rng.next() < (1.15 / (25.0 * D)) * wealth_f {
                        let c = self.new_agent(self.day, i as i64);
                        self.agents[c].health = 90.0;
                        self.agents[i].children.push(c);
                        self.d.births += 1.0;
                    }
                }
            }
        }
    }

    fn retire(&mut self, a: usize) {
        self.leave_work(a);
        self.agents[a].status = Status::Retraite;
        self.agents[a].job = None;
    }

    /// Retire l'agent de son poste (entreprise ou fonction publique), sans changer son statut.
    pub(super) fn leave_work(&mut self, a: usize) {
        if self.agents[a].public_job {
            self.agents[a].public_job = false;
            self.agents[a].job = None;
        }
        if self.agents[a].biz >= 0 {
            let bi = self.agents[a].biz as usize;
            let b = &mut self.businesses[bi];
            b.workers.retain(|&x| x != a);
            b.wages.shift_remove(&a);
            self.agents[a].biz = -1;
            if self.businesses[bi].alive && self.businesses[bi].workers.is_empty() {
                self.dissolve(bi);
            }
        }
    }

    fn die(&mut self, a: usize, cause: DeathCause) {
        self.leave_work(a);
        {
            let ag = &mut self.agents[a];
            ag.alive = false;
            ag.death_day = self.day;
            ag.death_cause = Some(cause);
            ag.sick = false;
            ag.severe = false;
            ag.insurer = -1;
        }
        self.mark_agent_dead(a);
        self.d.deaths[cause as usize] += 1.0;
        self.causes_total[cause as usize] += 1.0;
        let age = self.age_y(a);
        self.d.death_ages += age;
        if age < 1.0 {
            self.d.infant_deaths += 1.0;
        }
        let heirs: Vec<usize> = self.agents[a].children.iter().copied().filter(|&c| self.agents[c].alive).collect();
        let w = self.wealth_of(a, None);
        if w > self.mean_money * 8.0 && w > 100000.0 {
            let tail = if heirs.is_empty() {
                "Sans enfant : tout revient à l’État.".to_string()
            } else {
                format!("{} enfant(s) héritent.", heirs.len())
            };
            let text = format!(
                "Décès de {} ({} ans), une des grandes fortunes de l'île ({} écus). {}",
                agent_name(a as i64),
                js_num(floor(age)),
                js_num(round(w / 100.0)),
                tail
            );
            self.say("deces", text);
        }
        // succession : argent taxé puis partagé, parts d'entreprises transmises
        let tax = round(self.agents[a].money * self.policy.inheritance_tax);
        if tax > 0.0 {
            self.agents[a].money -= tax;
            self.collect(SUCCESSION, tax);
            self.flow(MENAGES, ETAT, tax);
        }
        if !heirs.is_empty() {
            let money = self.agents[a].money;
            let nh = heirs.len() as f64;
            let each = floor(money / nh);
            let mut rest = money - each * nh;
            for &h in &heirs {
                let x = each + (if rest > 0.0 { 1.0 } else { 0.0 });
                if rest > 0.0 {
                    rest -= 1.0;
                }
                self.agents[h].money += x;
                self.agents[h].inherited += x;
            }
            let mut heir0 = heirs[0];
            for &h in &heirs[1..] {
                heir0 = if self.age_y(heir0) >= self.age_y(h) { heir0 } else { h };
            }
            let food = std::mem::take(&mut self.agents[a].food);
            for (g, b) in food.iter() {
                let v: Vec<Batch> = b.iter().copied().collect();
                self.agents[heir0].food.add_batches(g, &v);
            }
            self.agents[a].food = food;
        } else if self.agents[a].money > 0.0 {
            let m = self.agents[a].money;
            self.collect(SUCCESSION, m);
            self.flow(MENAGES, ETAT, m);
        }
        self.agents[a].money = 0.0;
        self.agents[a].food.clear();
        // obligations : la part taxée est annulée, le reste va aux enfants
        if self.agents[a].bonds > 0.0 {
            let nh = heirs.len() as f64;
            let to: Vec<(Option<i64>, f64)> = heirs.iter().map(|&h| (Some(h as i64), 1.0 / nh)).collect();
            let it = self.policy.inheritance_tax;
            self.move_bonds(a as i64, &to, it);
        }
        let shares: Vec<(usize, f64)> = self.agents[a].shares.iter().map(|(&k, &v)| (k, v)).collect();
        for (bid, s) in shares {
            self.businesses[bid].shares.shift_remove(&(a as i64));
            if !self.businesses[bid].alive {
                continue;
            }
            if !heirs.is_empty() {
                let nh = heirs.len() as f64;
                for &h in &heirs {
                    let ns = self.businesses[bid].shares.get(&(h as i64)).copied().unwrap_or(0.0) + s / nh;
                    self.businesses[bid].shares.insert(h as i64, ns);
                    self.agents[h].shares.insert(bid, ns);
                }
            } else {
                let cur = self.businesses[bid].shares.get(&STATE_ID).copied().unwrap_or(0.0);
                self.businesses[bid].shares.insert(STATE_ID, cur + s);
            }
            self.recompute_owner(bid);
        }
        self.agents[a].shares.clear();
    }

    /// Ferme une entreprise : trésorerie aux actionnaires, stock et outils revendus à un confrère.
    pub(super) fn dissolve(&mut self, bi: usize) {
        if !self.businesses[bi].alive {
            return;
        }
        self.businesses[bi].alive = false;
        self.mark_biz_dead(bi);
        let job = self.businesses[bi].job;
        let mut buyer: Option<usize> = None;
        for x in self.ab() {
            let b = &self.businesses[x];
            if !(b.alive && b.job == job && !b.workers.is_empty()) {
                continue;
            }
            buyer = match buyer {
                None => Some(x),
                Some(y) => Some(if self.businesses[y].cash >= b.cash { y } else { x }),
            };
        }
        let value = self.biz_value(bi) - self.businesses[bi].cash - self.businesses[bi].bonds;
        if let Some(by) = buyer {
            if value > 0.0 {
                let price = mn(floor(value * 0.5), floor(self.businesses[by].cash * 0.5));
                let frac = price / (value * 0.5);
                self.businesses[by].cash -= price;
                self.businesses[bi].cash += price;
                let t = self.businesses[bi].tools * frac;
                self.businesses[by].tools += t;
                let inv = std::mem::take(&mut self.businesses[bi].inv);
                for (g, batches) in inv.iter() {
                    for x in batches {
                        self.businesses[by].inv.add(g, x.q * frac, x.exp);
                    }
                }
                self.businesses[bi].inv = inv;
                let (cb, cs) = (self.cat_of(by), self.cat_of(bi));
                self.flow(cb, cs, price);
            }
        }
        self.businesses[bi].inv.clear();
        self.businesses[bi].tools = 0.0;
        let mut paid = 0.0;
        let entries: Vec<(i64, f64)> = self.businesses[bi].shares.iter().map(|(&k, &v)| (k, v)).collect();
        let cash = self.businesses[bi].cash;
        for &(id, s) in &entries {
            let x = floor(cash * s);
            paid += x;
            if id == STATE_ID {
                self.collect(DIVIDENDES, x);
            } else {
                self.agents[id as usize].money += x;
            }
        }
        // reste d'arrondi au patron (ou à l'État)
        let rest = cash - paid;
        if rest > 0.0 {
            let owner = self.businesses[bi].owner;
            if owner >= 0 {
                self.agents[owner as usize].money += rest;
            } else {
                self.collect(DIVIDENDES, rest);
            }
        }
        self.businesses[bi].cash = 0.0;
        // obligations : partagées entre les actionnaires (la part de l'État est annulée)
        if self.businesses[bi].bonds > 0.0 {
            let to: Vec<(Option<i64>, f64)> = entries.iter().map(|&(id, s)| (if id == STATE_ID { None } else { Some(id) }, s)).collect();
            self.move_bonds(-2 - bi as i64, &to, 0.0);
        }
        for &(id, _) in &entries {
            if id != STATE_ID {
                self.agents[id as usize].shares.shift_remove(&bi);
            }
        }
        self.businesses[bi].shares.clear();
        let workers = std::mem::take(&mut self.businesses[bi].workers);
        for id in workers {
            let w = &mut self.agents[id];
            w.biz = -1;
            if w.alive && w.status == Status::Actif {
                w.status = Status::Chomeur;
                w.job = None;
            }
        }
    }

    // ------------------------------------------------------------------ emploi

    pub(super) fn start_independent(&mut self, a: usize, job: Job, initial: bool) -> usize {
        let b = self.new_business(job, a);
        self.businesses[b].workers.push(a);
        {
            let ag = &mut self.agents[a];
            ag.biz = b as i64;
            ag.job = Some(job);
            ag.status = Status::Actif;
            ag.job_since = self.day;
        }
        let capital = floor(self.agents[a].money * (if initial { 0.2 } else { 0.3 }));
        self.agents[a].money -= capital;
        self.businesses[b].cash += capital;
        if initial {
            let day = self.day as f64;
            let biz = &mut self.businesses[b];
            biz.tools = 1.0;
            let def = &JOB_DEFS[job];
            // stock de départ pour que le premier jour ne soit pas une famine
            let pot = def.batches * 1.4;
            for &(g, q) in def.inputs {
                biz.inv.add(g, pot * q * 2.0, day + GOOD_DEFS[g].shelf);
            }
            if def.cat == Cat::Commerce {
                for g in RETAIL_GOODS {
                    let share = if g == BOIS { 0.04 } else { 0.137 };
                    biz.inv.add(g, k::SHOP_CAPACITY * 1.3 * share, day + mn(GOOD_DEFS[g].shelf, 3.0));
                    biz.sales_ema[g] = Some(k::SHOP_CAPACITY * share);
                }
            }
        }
        b
    }

    pub(super) fn make_public(&mut self, a: usize, job: Job) {
        self.leave_work(a);
        let ag = &mut self.agents[a];
        ag.public_job = true;
        ag.job = Some(job);
        ag.status = Status::Actif;
        ag.job_since = self.day;
    }

    /// Poids d'un secteur dans le choix d'un métier : croît plus vite que le revenu moyen.
    fn job_attractiveness(&self, income: f64) -> f64 {
        pow(mx(1.0, self.capped_va(income)), 1.5)
    }

    /// Un pic de prix ne fait pas croire à une fortune durable : on plafonne à 3× le revenu moyen.
    fn capped_va(&self, v: f64) -> f64 {
        mn(v, self.avg_income * 3.0)
    }

    fn eligible(&self, a: usize, j: Job) -> bool {
        self.agents[a].edu >= JOB_DEFS[j].min_edu
    }

    /// Choix d'un emploi pour un chômeur : poste salarié vacant ou installation à son compte.
    pub(super) fn choose_job(&mut self, a: usize, exclude: Option<Job>) {
        let jobs: Vec<Job> = MARKET_JOBS.iter().copied().filter(|&j| Some(j) != exclude && self.eligible(a, j)).collect();
        let incs: Vec<f64> = jobs.iter().map(|&j| self.sector_va[j]).collect();
        let w: Vec<f64> = incs.iter().map(|&x| self.job_attractiveness(x)).collect();
        let ji = self.rng.weighted(&w);
        let job = jobs[ji];
        let expected = incs[ji];
        // un poste salarié vaut mieux s'il paie au moins 90 % du revenu espéré à son compte
        let mut best: Option<usize> = None;
        for bi in self.ab() {
            let b = &self.businesses[bi];
            if !b.alive || b.vacancies <= 0.0 || !self.eligible(a, b.job) {
                continue;
            }
            if b.offer_wage >= expected * 0.9 && (best.is_none() || b.offer_wage > self.businesses[best.unwrap()].offer_wage) {
                best = Some(bi);
            }
        }
        if let Some(bi) = best {
            let w = self.businesses[bi].offer_wage;
            self.hire(bi, a, w);
        } else {
            self.start_independent(a, job, false);
        }
    }

    fn hire(&mut self, bi: usize, a: usize, wage: f64) {
        self.leave_work(a);
        let b = &mut self.businesses[bi];
        b.workers.push(a);
        b.wages.insert(a, wage);
        b.vacancies -= 1.0;
        let job = b.job;
        let ag = &mut self.agents[a];
        ag.biz = bi as i64;
        ag.job = Some(job);
        ag.status = Status::Actif;
        ag.job_since = self.day;
        ag.xp *= 0.5;
    }

    /// Fusion : l'indépendant `joiner` apporte son entreprise `src` et `extra` centimes d'épargne à `dst`.
    fn merge_into(&mut self, dst: usize, src: usize, joiner: usize, extra: f64, wage: f64) {
        let v_d = mx(1.0, self.biz_value(dst));
        self.agents[joiner].money -= extra;
        self.businesses[src].cash += extra;
        let v_s = mx(0.0, self.biz_value(src));
        let tot = v_d + v_s;
        let dshares: Vec<(i64, f64)> = self.businesses[dst].shares.iter().map(|(&k, &v)| (k, v)).collect();
        for (id, s) in dshares {
            let ns = (s * v_d) / tot;
            self.businesses[dst].shares.insert(id, ns);
            if id != STATE_ID {
                self.agents[id as usize].shares.insert(dst, ns);
            }
        }
        let sshares: Vec<(i64, f64)> = self.businesses[src].shares.iter().map(|(&k, &v)| (k, v)).collect();
        for (id, s) in sshares {
            let ns = self.businesses[dst].shares.get(&id).copied().unwrap_or(0.0) + (s * v_s) / tot;
            self.businesses[dst].shares.insert(id, ns);
            if id != STATE_ID {
                self.agents[id as usize].shares.insert(dst, ns);
                self.agents[id as usize].shares.shift_remove(&src);
            }
        }
        let sc = self.businesses[src].cash;
        self.businesses[dst].cash += sc;
        if self.businesses[src].bonds > 0.0 {
            self.move_bonds(-2 - src as i64, &[(Some(-2 - dst as i64), 1.0)], 0.0);
        }
        for l in self.loans.iter_mut() {
            if l.biz == src {
                l.biz = dst;
            }
        }
        let st = self.businesses[src].tools;
        self.businesses[dst].tools += st;
        if self.businesses[src].job == ASSUREUR {
            for &h in &self.alive_agents {
                if self.agents[h].insurer == src as i64 {
                    self.agents[h].insurer = dst as i64;
                }
            }
        }
        let inv = std::mem::take(&mut self.businesses[src].inv);
        for (g, batches) in inv.iter() {
            let v: Vec<Batch> = batches.iter().copied().collect();
            self.businesses[dst].inv.add_batches(g, &v);
        }
        let sw = std::mem::take(&mut self.businesses[src].workers);
        for id in sw {
            self.agents[id].biz = -1;
        }
        {
            let s = &mut self.businesses[src];
            s.cash = 0.0;
            s.tools = 0.0;
            s.inv.clear();
            s.shares.clear();
            s.alive = false;
        }
        self.mark_biz_dead(src);
        self.businesses[dst].workers.push(joiner);
        let djob = self.businesses[dst].job;
        {
            let j = &mut self.agents[joiner];
            j.biz = dst as i64;
            j.job = Some(djob);
            j.status = Status::Actif;
        }
        let prev_owner = self.businesses[dst].owner;
        self.recompute_owner(dst);
        let n = self.businesses[dst].workers.len() as f64;
        let label = JOB_DEFS[djob].label.to_lowercase();
        let owner = self.businesses[dst].owner;
        if owner != prev_owner && owner >= 0 && prev_owner >= 0 && n >= 4.0 {
            let t = format!(
                "{} apporte plus de capital que {} et prend la tête de l'entreprise ({}, {} pers.).",
                agent_name(owner),
                agent_name(prev_owner),
                label,
                n
            );
            self.say("entreprise", t);
        }
        if n > self.record_firm {
            self.record_firm = n;
            let t = format!(
                "Record : l'entreprise de {} ({}) compte désormais {} personnes, la plus grande de l'île.",
                agent_name(owner),
                label,
                n
            );
            self.say("entreprise", t);
        }
        let workers = self.businesses[dst].workers.clone();
        let b = &mut self.businesses[dst];
        for id in workers {
            if id as i64 == b.owner {
                b.wages.shift_remove(&id);
            } else if !b.wages.contains_key(&id) {
                b.wages.insert(id, wage);
            }
        }
    }

    /// Valeur ajoutée moyenne par travailleur dans chaque métier.
    pub(super) fn update_sector_va(&mut self) {
        let mut sum = [0.0; NJ];
        let mut cnt = [0.0; NJ];
        for b in self.alive_biz.iter().map(|&i| &self.businesses[i]) {
            if !b.alive || b.workers.is_empty() {
                continue;
            }
            let nw = b.workers.len() as f64;
            sum[b.job] += b.va_ema * nw;
            cnt[b.job] += nw;
        }
        for j in MARKET_JOBS {
            if cnt[j] != 0.0 {
                self.sector_va[j] = sum[j] / cnt[j];
            }
        }
        let s = self.policy.public_salary * 100.0 * self.index_factor();
        for j in PUBLIC_JOBS {
            self.sector_va[j] = s;
        }
    }

    /// Revenu courant d'un actif, tel qu'il le perçoit (centimes/jour).
    fn current_earnings(&self, a: usize) -> f64 {
        let ag = &self.agents[a];
        if ag.public_job {
            return self.policy.public_salary * 100.0 * self.index_factor();
        }
        if ag.biz < 0 {
            return 0.0;
        }
        let b = &self.businesses[ag.biz as usize];
        if b.owner != a as i64 {
            return b.wages.get(&a).copied().unwrap_or(0.0);
        }
        b.va_ema
    }

    /// Reconversions, étalées : chaque jour, un trentième des actifs réexamine son métier.
    pub(super) fn career_reviews(&mut self) {
        let slot = (self.day % 30) as usize;
        for a in self.aa() {
            if a % 30 != slot {
                continue;
            }
            {
                let ag = &self.agents[a];
                if !ag.alive || ag.status != Status::Actif || ag.job.is_none() || ag.public_job {
                    continue;
                }
                if self.day - ag.job_since < 45 {
                    continue;
                }
            }
            let bz = self.agents[a].biz;
            let b = if bz >= 0 { Some(bz as usize) } else { None };
            if let Some(bi) = b {
                let x = &self.businesses[bi];
                if x.owner == a as i64 && x.workers.len() > 1 {
                    continue; // un patron ne quitte pas son entreprise
                }
            }
            let own = self.current_earnings(a);
            let cur_job = self.agents[a].job;
            let jobs: Vec<Job> = MARKET_JOBS.iter().copied().filter(|&j| Some(j) != cur_job && self.eligible(a, j)).collect();
            let vas: Vec<f64> = jobs.iter().map(|&j| self.capped_va(self.sector_va[j])).collect();
            let mut alt = f64::NEG_INFINITY;
            for &v in &vas {
                alt = mx(alt, v);
            }
            if own >= alt * 0.7 {
                continue;
            }
            let gap = mn(1.0, (alt - mx(0.0, own)) / mx(50.0, alt));
            // lent pour un petit écart, rapide quand le métier ne nourrit plus son homme
            if self.rng.next() > 0.03 * gap + 0.15 * mx(0.0, gap - 0.6) {
                continue;
            }
            let w: Vec<f64> = vas.iter().map(|&x| if x > own * 1.25 { self.job_attractiveness(x) } else { 0.0 }).collect();
            let nj = jobs[self.rng.weighted(&w)];
            let solo = match b {
                Some(bi) => self.businesses[bi].workers.len() == 1 && self.businesses[bi].owner == a as i64,
                None => false,
            };
            if solo {
                // indépendant : il change d'activité en gardant son entreprise (stock revendu peu à peu)
                let va = self.sector_va[nj];
                let x = &mut self.businesses[b.unwrap()];
                x.job = nj;
                x.bid = NO_GOODS;
                x.retail = NO_GOODS;
                x.sales_ema = NO_GOODS;
                x.out_sales = NO_GOODS;
                x.prod_ema = NO_GOODS;
                x.fee = 0.0;
                x.premium = 0.0;
                x.va_ema = va;
                let ag = &mut self.agents[a];
                ag.job = Some(nj);
                ag.xp = 0.0;
                ag.job_since = self.day;
            } else {
                let old = self.agents[a].job;
                self.leave_work(a);
                self.agents[a].status = Status::Chomeur;
                self.agents[a].job = None;
                self.choose_job(a, old);
            }
        }
    }

    /// Embauches, licenciements, salaires et regroupements d'indépendants.
    pub(super) fn reorganize(&mut self) {
        let min_wage = round(self.policy.min_wage * 100.0 * self.index_factor());
        for bi in self.ab() {
            self.businesses[bi].vacancies = 0.0;
            if !self.businesses[bi].alive || self.businesses[bi].workers.is_empty() {
                continue;
            }
            let va = self.businesses[bi].va_per_worker;
            // salaires : 70 % de la valeur ajoutée par travailleur, jamais sous le salaire minimum
            let offer = mx(min_wage, round(va * 0.7));
            self.businesses[bi].offer_wage = offer;
            let owner = self.businesses[bi].owner;
            let mut employees: Vec<usize> = self.businesses[bi].workers.iter().copied().filter(|&id| id as i64 != owner).collect();
            for &id in &employees {
                self.businesses[bi].wages.insert(id, offer);
            }
            let arrears = self.businesses[bi].arrears;
            // licenciement si la valeur ajoutée ne couvre plus le salaire
            if !employees.is_empty() && (arrears >= 3.0 || va < offer * 0.95) {
                let keyed: Vec<(usize, f64, f64)> = employees
                    .iter()
                    .map(|&id| (id, self.agents[id].shares.get(&bi).copied().unwrap_or(0.0), self.productivity(id)))
                    .collect();
                let mut keyed = keyed;
                keyed.sort_by(|x, y| {
                    let v = x.1 - y.1;
                    ord(if v == 0.0 || v.is_nan() { x.2 - y.2 } else { v })
                });
                employees = keyed.iter().map(|x| x.0).collect();
                let fired = employees[0];
                self.leave_work(fired);
                self.agents[fired].status = Status::Chomeur;
                self.agents[fired].job = None;
            } else if va * 0.7 >= min_wage * 1.1 && self.businesses[bi].cash > offer * 10.0 + self.reserve_of(bi) && arrears == 0.0 {
                // embauche si la trésorerie couvre dix jours de salaire en plus de la réserve
                let r = self.reserve_of(bi);
                self.businesses[bi].vacancies = if self.businesses[bi].cash > offer * 40.0 + r { 2.0 } else { 1.0 };
            }
            self.businesses[bi].arrears = 0.0;
        }
        // indépendants en difficulté : rejoindre une entreprise qui recrute, ou se regrouper entre eux
        let mut by_sector: Vec<(Job, Vec<usize>)> = Vec::new();
        for bi in self.ab() {
            let b = &self.businesses[bi];
            if !b.alive || b.workers.len() != 1 || b.owner != b.workers[0] as i64 {
                continue;
            }
            if let Some(e) = by_sector.iter_mut().find(|e| e.0 == b.job) {
                e.1.push(bi);
            } else {
                by_sector.push((b.job, vec![bi]));
            }
        }
        for (job, solos) in by_sector {
            let sector_inc = self.sector_va[job];
            let mut struggling: Vec<usize> = solos.iter().copied().filter(|&b| self.businesses[b].va_ema < sector_inc * 0.8).collect();
            self.rng.shuffle(&mut struggling);
            let hiring: Vec<usize> = self.ab().into_iter()
                .filter(|&i| {
                    let b = &self.businesses[i];
                    b.alive && b.job == job && b.vacancies > 0.0
                })
                .collect();
            let mut leftovers: Vec<usize> = Vec::new();
            for &s in &struggling {
                if !self.businesses[s].alive || self.businesses[s].workers.len() != 1 {
                    continue;
                }
                let a = self.businesses[s].owner as usize;
                let sva = self.businesses[s].va_ema;
                // (la version TypeScript oubliait de vérifier que l'entreprise qui recrute existe encore :
                // une fusion antérieure pouvait l'avoir absorbée ; reproduit en mode `legacy`)
                let legacy = self.legacy;
                let h = hiring.iter().copied().find(|&x| {
                    let hb = &self.businesses[x];
                    (legacy || hb.alive) && hb.vacancies > 0.0 && x != s && hb.offer_wage > sva
                });
                if let Some(h) = h {
                    self.businesses[h].vacancies -= 1.0;
                    let w = self.businesses[h].offer_wage;
                    self.merge_into(h, s, a, 0.0, w);
                } else {
                    leftovers.push(s);
                }
            }
            // regroupement de deux indépendants : le plus gros apport devient patron
            let mut i = 0;
            while i + 1 < leftovers.len() {
                let (aa, bb_) = (leftovers[i], leftovers[i + 1]);
                i += 2;
                if self.rng.next() > 0.3 {
                    continue;
                }
                if !self.businesses[aa].alive
                    || !self.businesses[bb_].alive
                    || self.businesses[aa].workers.len() != 1
                    || self.businesses[bb_].workers.len() != 1
                {
                    continue;
                }
                let a = self.businesses[aa].owner as usize;
                let bb = self.businesses[bb_].owner as usize;
                let ca = self.biz_value(aa) + self.agents[a].money * 0.25;
                let cb = self.biz_value(bb_) + self.agents[bb].money * 0.25;
                let (dst, src, joiner) = if ca >= cb { (aa, bb_, bb) } else { (bb_, aa, a) };
                let owner = self.businesses[dst].owner as usize;
                let extra_owner = floor(self.agents[owner].money * 0.25);
                self.agents[owner].money -= extra_owner;
                self.businesses[dst].cash += extra_owner;
                let wage = mx(min_wage, round(((self.businesses[aa].va_per_worker + self.businesses[bb_].va_per_worker) / 2.0) * 0.7));
                let extra = floor(self.agents[joiner].money * 0.25);
                self.merge_into(dst, src, joiner, extra, wage);
                if self.rng.next() < 0.25 {
                    let t = format!(
                        "{} et {}, {}s en difficulté, s'associent. {} devient patron·ne (plus gros apport).",
                        agent_name(owner as i64),
                        agent_name(joiner as i64),
                        JOB_DEFS[job].label.to_lowercase(),
                        agent_name(self.businesses[dst].owner)
                    );
                    self.say("entreprise", t);
                }
            }
        }
    }

    /// Effectif visé d'une fonction publique (avant coupes budgétaires).
    pub(super) fn staff_target(&self, job: Job, pop: f64) -> f64 {
        let p = &self.policy;
        if job == CANTONNIER {
            return round((p.public_investment * self.gdp_year() * 0.5) / mx(1.0, p.public_salary * 100.0 * self.index_factor() * D));
        }
        round((p.staff_per1000(job) * pop) / 1000.0)
    }

    pub(super) fn public_hiring(&mut self) {
        let mut pop = 0.0;
        for a in self.alive_agents.iter().map(|&i| &self.agents[i]) {
            pop += if a.alive { 1.0 } else { 0.0 };
        }
        let salary = self.policy.public_salary * 100.0 * self.index_factor();
        for job in PUBLIC_JOBS {
            // le budget voté peut imposer moins de postes que prévu (coupes au prorata)
            let target = round(self.staff_target(job, pop) * self.budget_cut);
            let mut current: Vec<usize> = self.aa().into_iter()
                .filter(|&a| {
                    let ag = &self.agents[a];
                    ag.alive && ag.public_job && ag.job == Some(job)
                })
                .collect();
            let cl = current.len() as f64;
            if cl > target {
                current.sort_by(|&x, &y| ord((self.agents[y].job_since - self.agents[x].job_since) as f64));
                let n = (cl - target) as usize;
                for &a in current[..n].to_vec().iter() {
                    self.leave_work(a);
                    self.agents[a].status = Status::Chomeur;
                    self.choose_job(a, None);
                }
            } else if cl < target {
                let mut cands: Vec<usize> = self.aa().into_iter()
                    .filter(|&a| {
                        let ag = &self.agents[a];
                        if !ag.alive || ag.public_job || (ag.status != Status::Actif && ag.status != Status::Chomeur) {
                            return false;
                        }
                        if !self.eligible(a, job) {
                            return false;
                        }
                        if ag.biz >= 0 {
                            let b = &self.businesses[ag.biz as usize];
                            if b.owner == a as i64 && b.workers.len() > 1 {
                                return false;
                            }
                        }
                        ag.status == Status::Chomeur || ag.last_income / k::DAYS_PER_MONTH < salary * 1.1
                    })
                    .collect();
                // les plus diplômés pour les postes qualifiés, les moins diplômés pour les travaux publics
                if job == CANTONNIER || job == GARDE {
                    cands.sort_by(|&x, &y| ord(self.agents[x].edu - self.agents[y].edu));
                } else {
                    cands.sort_by(|&x, &y| ord(self.agents[y].edu - self.agents[x].edu));
                }
                let n = (target - cl) as usize;
                for &a in cands.iter().take(n) {
                    self.make_public(a, job);
                }
            }
            // fonctionnaires mal payés (État à court d'argent) : démission possible
            for &a in &current {
                if !self.agents[a].alive || !self.agents[a].public_job {
                    continue;
                }
                if self.d.paid_ratio < 0.8 && self.rng.next() < 0.2 {
                    self.leave_work(a);
                    self.agents[a].status = Status::Chomeur;
                    self.choose_job(a, None);
                }
            }
        }
    }
}
