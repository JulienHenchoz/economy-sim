//! Initialisation : population, familles, métiers de départ.

use super::*;

impl Simulation {
    pub(super) fn populate(&mut self) {
        let population = self.init.population;
        let total = population * self.init.money_per_inhabitant * 100.0;
        self.initial_money = total;
        self.money_base = total;
        self.treasury = round(total * self.init.state_share);
        let per_head = floor((total - self.treasury) / population);
        self.treasury = total - per_head * population; // le reste de la division va à l'État

        // pyramide des âges : plate jusqu'à 65 ans puis décroissante
        let age_w: Vec<f64> = (0..95).map(|a| if a < 65 { 1.0 } else { exp(-((a - 65) as f64) / 8.0) }).collect();
        let n = population as usize;
        for _ in 0..n {
            let age_y = self.rng.weighted(&age_w) as f64 + self.rng.next();
            let a = self.new_agent(-(round(age_y * D) as i64), -1);
            self.agents[a].money = per_head;
            if age_y >= k::ADULT_AGE {
                self.agents[a].edu = clamp(0.55 + 0.2 * self.rng.normal(), 0.05, 1.0);
            } else {
                self.agents[a].edu = clamp((age_y - k::SCHOOL_START) / 10.0, 0.0, 1.0) * 0.9;
            }
            let h = clamp(92.0 - mx(0.0, age_y - 50.0) * 0.6 + self.rng.normal() * 4.0, 30.0, 100.0);
            self.agents[a].health = h;
            // visites de suivi déjà étalées dans le temps
            let lc = -floor(self.rng.next() * k::FOLLOW_UP_EVERY);
            self.agents[a].last_care = lc;
            self.agents[a].care_until = lc + k::CARE_DAYS;
        }
        // familles : chaque enfant reçoit un parent plus âgé de 18 à 45 ans
        let adults: Vec<usize> = (0..self.agents.len()).filter(|&a| self.age_y(a) >= 20.0 && self.age_y(a) < 60.0).collect();
        for c in 0..self.agents.len() {
            if self.age_y(c) >= k::ADULT_AGE {
                continue;
            }
            let yc = self.age_y(c);
            let cands: Vec<usize> = adults
                .iter()
                .copied()
                .filter(|&p| {
                    let diff = self.age_y(p) - yc;
                    diff >= 18.0 && diff <= 45.0 && self.agents[p].children.len() < 4
                })
                .collect();
            if cands.is_empty() {
                continue;
            }
            let p = cands[self.rng.int(cands.len())];
            self.agents[c].parent = p as i64;
            self.agents[p].children.push(c);
        }
        // nourriture de départ : 2 jours par foyer
        for a in 0..self.agents.len() {
            if !self.is_head(a) {
                continue;
            }
            let need = self.household_need(a);
            let mut psum = 0.0;
            for x in FOOD_GOODS {
                psum += self.agents[a].prefs[x].unwrap_or(0.0);
            }
            for g in FOOD_GOODS {
                let share = self.agents[a].prefs[g].unwrap_or(0.0) / psum;
                self.agents[a].food.add(g, (need * 2.0 * share) / GOOD_DEFS[g].nutrition, GOOD_DEFS[g].shelf);
            }
            let hs = self.household_size(a);
            self.agents[a].food.add(BOIS, hs * k::FIREWOOD_PER_PERSON * 15.0, GOOD_DEFS[BOIS].shelf);
        }
        // métiers
        let mut working: Vec<usize> = (0..self.agents.len())
            .filter(|&a| self.age_y(a) >= k::ADULT_AGE && self.age_y(a) < self.policy.retirement_age)
            .collect();
        self.rng.shuffle(&mut working);
        for a in 0..self.agents.len() {
            let y = self.age_y(a);
            if y < k::ADULT_AGE {
                self.agents[a].status = Status::Enfant;
            } else if y >= self.policy.retirement_age {
                self.agents[a].status = Status::Retraite;
            }
        }
        // métiers qualifiés d'abord (les plus éduqués) : médecins libéraux, enseignants, assureurs
        let mut by_edu = working.clone();
        by_edu.sort_by(|&x, &y| ord(self.agents[y].edu - self.agents[x].edu));
        let mut m_share = 0.0;
        for j in MARKET_JOBS {
            m_share += JOB_DEFS[j].share;
        }
        // fonctionnaires de départ (hors travaux publics, embauchés à la fin du premier mois)
        let n_public: Vec<(Job, f64)> = PUBLIC_JOBS
            .iter()
            .filter(|&&j| j != CANTONNIER)
            .map(|&j| (j, round((self.policy.staff_per1000(j) * population) / 1000.0)))
            .collect();
        let mut n_teach = 0.0;
        for x in &n_public {
            n_teach += x.1;
        }
        let wl = working.len() as f64;
        let n_doc = round((JOB_DEFS[MEDECIN].share / m_share) * (wl - n_teach));
        let n_ins = mx(1.0, round((JOB_DEFS[ASSUREUR].share / m_share) * (wl - n_teach)));
        let mut kk = 0usize;
        let mut i = 0.0;
        while i < n_doc && kk < by_edu.len() {
            self.start_independent(by_edu[kk], MEDECIN, true);
            i += 1.0;
            kk += 1;
        }
        for &(j, n) in &n_public {
            let mut i = 0.0;
            while i < n && kk < by_edu.len() {
                self.make_public(by_edu[kk], j);
                i += 1.0;
                kk += 1;
            }
        }
        let mut i = 0.0;
        while i < n_ins && kk < by_edu.len() {
            self.start_independent(by_edu[kk], ASSUREUR, true);
            i += 1.0;
            kk += 1;
        }
        let rest: Vec<usize> = working.iter().copied().filter(|&a| !self.agents[a].public_job && self.agents[a].biz < 0).collect();
        let jobs: Vec<Job> = MARKET_JOBS.iter().copied().filter(|&j| j != MEDECIN && j != ASSUREUR).collect();
        let weights: Vec<f64> = jobs.iter().map(|&j| JOB_DEFS[j].share).collect();
        let mut w_sum = 0.0;
        for &w in &weights {
            w_sum += w;
        }
        let quotas: Vec<f64> = weights.iter().map(|&w| round((w / w_sum) * rest.len() as f64)).collect();
        let mut idx = 0usize;
        for ji in 0..jobs.len() {
            let mut n = 0.0;
            while n < quotas[ji] && idx < rest.len() {
                self.start_independent(rest[idx], jobs[ji], true);
                idx += 1;
                n += 1.0;
            }
        }
        while idx < rest.len() {
            self.start_independent(rest[idx], CEREALIER, true);
            idx += 1;
        }
        for j in 0..NJ {
            self.sector_income[j] = 400.0;
        }
        // équipements publics de départ
        self.infra = k::INFRA_PER_CAPITA * 100.0 * population * (2.0 / 3.0);
        let heads = (0..self.agents.len()).filter(|&a| self.is_head(a)).count() as f64;
        self.housing = self.policy.social_housing * heads;
        self.census();
        self.assign_housing();
        self.compute_capacities();
        self.choose_insurance();
    }

    pub(super) fn new_agent(&mut self, born: i64, parent: i64) -> usize {
        let mut base: GoodOpt = NO_GOODS;
        base[PAIN] = Some(0.35);
        base[POISSON_PREP] = Some(0.15);
        base[VIANDE] = Some(0.12);
        base[FROMAGE] = Some(0.08);
        base[LAIT] = Some(0.08);
        base[OEUFS] = Some(0.1);
        base[FRUITS] = Some(0.12);
        let p = if parent >= 0 { self.agents[parent as usize].prefs } else { base };
        let mut prefs = NO_GOODS;
        for g in FOOD_GOODS {
            prefs[g] = Some(mx(0.01, p[g].unwrap_or(0.1) * exp(0.35 * self.rng.normal())));
        }
        let id = self.agents.len();
        self.agents.push(Agent {
            id,
            alive: true,
            born,
            parent,
            children: Vec::new(),
            money: 0.0,
            edu: 0.0,
            xp: 0.0,
            health: 90.0,
            sick: false,
            severe: false,
            care_need: 0.0,
            status: Status::Enfant,
            job: None,
            biz: -1,
            public_job: false,
            food: Inv::new(),
            fed: 1.0,
            hunger: 0.0,
            cold: false,
            appetite: 0.0,
            income: 0.0,
            last_income: 0.0,
            prefs,
            shares: OrderedMap::default(),
            death_day: -1,
            death_cause: None,
            job_since: 0,
            inherited: 0.0,
            insurer: -1,
            last_care: -1e6,
            care_until: -1.0,
            quintiles: Vec::new(),
            bonds: 0.0,
        });
        self.alive_agents.push(id);
        id
    }

    pub(super) fn new_business(&mut self, job: Job, owner: usize) -> usize {
        let id = self.businesses.len();
        let mut shares = OrderedMap::default();
        shares.insert(owner as i64, 1.0);
        self.businesses.push(Business {
            id,
            alive: true,
            job,
            owner: owner as i64,
            shares,
            workers: Vec::new(),
            wages: OrderedMap::default(),
            cash: 0.0,
            inv: Inv::new(),
            tools: 0.0,
            ask: NO_GOODS,
            bid: NO_GOODS,
            retail: NO_GOODS,
            avg_cost: NO_GOODS,
            sales_ema: NO_GOODS,
            out_sales: NO_GOODS,
            prod_ema: NO_GOODS,
            potential: 0.0,
            rev_day: 0.0,
            cost_day: 0.0,
            cost_ema: 0.0,
            rev_month: 0.0,
            input_month: 0.0,
            wage_month: 0.0,
            other_month: 0.0,
            va_per_worker: or(self.sector_income[job], 400.0),
            va_ema: or(self.sector_va[job], 400.0),
            input_day: 0.0,
            profit_last_month: 0.0,
            arrears: 0.0,
            offer_wage: 0.0,
            vacancies: 0.0,
            founded: self.day,
            fee: 0.0,
            acts_day: 0.0,
            occupancy: 0.8,
            premium: 0.0,
            markup: 0.05,
            insured_n: 0.0,
            insured_units: 0.0,
            premiums_month: 0.0,
            claims_month: 0.0,
            unit_days: 0.0,
            claims_per_unit: 0.0,
            lost_month: 0.0,
            bonds: 0.0,
        });
        self.agents[owner].shares.insert(id, 1.0);
        self.alive_biz.push(id);
        id
    }
}
