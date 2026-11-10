//! Statistiques quotidiennes (une ligne d'historique par jour, en écus).

use super::*;
use serde::ser::SerializeMap;

/// Objet `Partial<Record<Good, number>>` : seules les clés présentes sont écrites.
#[derive(Clone, Copy)]
pub struct GoodMap(pub GoodOpt);
impl Serialize for GoodMap {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(None)?;
        for g in 0..NG {
            if let Some(v) = self.0[g] {
                m.serialize_entry(GOOD_IDS[g], &v)?;
            }
        }
        m.end()
    }
}

#[derive(Clone, Copy)]
pub struct JobMap(pub [f64; NJ]);
impl Serialize for JobMap {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        ser_keys(&JOB_IDS, &self.0, s)
    }
}

fn ser_deaths<S: Serializer>(v: &[f64; 3], s: S) -> Result<S::Ok, S::Error> {
    ser_keys(&["age", "faim", "maladie"], v, s)
}
fn ser_care<S: Serializer>(v: &[f64; 3], s: S) -> Result<S::Ok, S::Error> {
    ser_keys(&["menages", "secu", "assurance"], v, s)
}
fn ser_money_src<S: Serializer>(v: &[f64; 3], s: S) -> Result<S::Ok, S::Error> {
    ser_keys(&["bc", "banque", "etranger"], v, s)
}
fn ser_energy_src<S: Serializer>(v: &[f64; 3], s: S) -> Result<S::Ok, S::Error> {
    ser_keys(&["petrole", "gaz", "vert"], v, s)
}
fn ser_energy_use<S: Serializer>(v: &[f64; 2], s: S) -> Result<S::Ok, S::Error> {
    ser_keys(&["machines", "menages"], v, s)
}
fn ser_staff<S: Serializer>(v: &[f64; 5], s: S) -> Result<S::Ok, S::Error> {
    ser_keys(&["administration", "police", "sante", "nature", "ecoles"], v, s)
}

/// Ligne d'historique (une par jour). Valeurs monétaires en écus.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayStats {
    pub day: i64,
    pub population: f64,
    pub enfants: f64,
    pub actifs: f64,
    pub chomeurs: f64,
    pub retraites: f64,
    pub births: f64,
    #[serde(serialize_with = "ser_deaths")]
    pub deaths: [f64; 3],
    pub gdp: f64,
    pub wholesale_value: f64,
    pub retail_price: GoodMap,
    pub wholesale_price: GoodMap,
    pub retail_volume: GoodMap,
    pub wholesale_volume: GoodMap,
    pub production: GoodMap,
    pub waste: GoodMap,
    pub unmet_demand: GoodMap,
    pub workers_by_job: JobMap,
    pub income_by_job: JobMap,
    pub gini_wealth: f64,
    pub gini_income: f64,
    pub top10_wealth: f64,
    pub bottom50_wealth: f64,
    pub avg_health: f64,
    pub avg_edu_adults: f64,
    pub hunger_rate: f64,
    pub sick_rate: f64,
    pub treasury: f64,
    #[serde(serialize_with = "ser_rev")]
    pub revenue: [f64; NREV],
    #[serde(serialize_with = "ser_spend")]
    pub spending: [f64; NSPEND],
    pub paid_ratio: f64,
    pub money_households: f64,
    pub money_businesses: f64,
    pub money_total: f64,
    pub fish_stock: f64,
    pub forest_stock: f64,
    pub firms: f64,
    pub independents: f64,
    pub avg_firm_size: f64,
    pub biggest_firm: f64,
    pub employees: f64,
    pub public_employees: f64,
    pub cpi: f64,
    pub velocity: f64,
    #[serde(rename = "p90p10")]
    pub p90p10: f64,
    pub care_acts: f64,
    pub care_denied: f64,
    pub care_no_doctor: f64,
    pub sick_untreated: f64,
    #[serde(serialize_with = "ser_care")]
    pub care_spend: [f64; 3],
    pub avg_fee: f64,
    pub avg_premium: f64,
    pub insured_rate: f64,
    pub debt: f64,
    pub debt_ratio: f64,
    pub deficit_ratio: f64,
    pub avg_rate: f64,
    pub last_rate: f64,
    pub borrowing: f64,
    pub repayment: f64,
    pub debt_holders: [f64; 8],
    pub nfa_households: f64,
    pub nfa_businesses: f64,
    pub nfa_public: f64,
    pub budget_cut: f64,
    #[serde(serialize_with = "ser_money_src")]
    pub money_created: [f64; 3],
    pub policy_rate: f64,
    pub inflation: f64,
    pub bank_loans: f64,
    pub cb_debt: f64,
    pub foreign_debt: f64,
    pub bank_equity: f64,
    #[serde(serialize_with = "ser_energy_src")]
    pub energy_by_source: [f64; 3],
    #[serde(serialize_with = "ser_energy_use")]
    pub energy_use: [f64; 2],
    pub emissions: f64,
    pub pollution: f64,
    pub oil_left: f64,
    pub gas_left: f64,
    #[serde(serialize_with = "ser_staff")]
    pub staff_cov: [f64; 5],
    pub tax_eff: f64,
    pub infra_cov: f64,
    pub social_housing: f64,
    pub land_bonus: f64,
    pub silo_stock: f64,
    pub school_cov: f64,
    pub culture_cov: f64,
    pub thefts: f64,
    pub cold_rate: f64,
    pub poor_rate: f64,
    pub death_ages: f64,
    pub infant_deaths: f64,
}

pub struct Money {
    pub households: f64,
    pub businesses: f64,
    pub total: f64,
}

impl Simulation {
    pub fn wealth_of(&self, a: usize, values: Option<&[Option<f64>]>) -> f64 {
        let ag = &self.agents[a];
        let mut w = ag.money + ag.bonds;
        for (&bid, &s) in &ag.shares {
            let v = match values.and_then(|v| v.get(bid).copied().flatten()) {
                Some(v) => v,
                None => self.biz_value(bid),
            };
            w += s * v;
        }
        w
    }

    /// Valeur de chaque entreprise vivante (indexé par id, None si disparue).
    pub fn biz_values(&self) -> Vec<Option<f64>> {
        let mut v = vec![None; self.businesses.len()];
        for &b in &self.alive_biz {
            v[b] = Some(self.biz_value(b));
        }
        v
    }

    pub fn total_money(&self) -> Money {
        let mut h = 0.0;
        let mut b = 0.0;
        if self.legacy {
            // la version TypeScript parcourait aussi les disparus (dont certains gardaient de l'argent)
            for a in &self.agents {
                h += a.money;
            }
            for x in &self.businesses {
                b += x.cash;
            }
        } else {
            for &a in &self.alive_agents {
                h += self.agents[a].money;
            }
            for &x in &self.alive_biz {
                b += self.businesses[x].cash;
            }
        }
        Money { households: h, businesses: b, total: h + b + self.treasury }
    }

    pub(super) fn record_stats(&mut self) {
        let money = self.total_money();
        self.money_error = money.total - self.money_base;
        let (mut pop, mut enfants, mut actifs, mut chomeurs, mut retraites) = (0.0, 0.0, 0.0, 0.0, 0.0);
        let (mut health, mut edu_sum, mut edu_n, mut hungry, mut sick, mut pub_emp, mut heads, mut poor_heads) =
            (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        let poor_line = self.policy.social_aid_threshold * 100.0 * self.index_factor();
        let mut workers_by_job = [0.0; NJ];
        for a in self.aa() {
            let ag = &self.agents[a];
            if !ag.alive {
                continue;
            }
            pop += 1.0;
            health += ag.health;
            if ag.fed < 0.9 {
                hungry += 1.0;
            }
            if ag.sick {
                sick += 1.0;
            }
            if self.is_head(a) {
                heads += 1.0;
                if ag.money < poor_line * self.household_size(a) {
                    poor_heads += 1.0;
                }
            }
            if ag.status == Status::Enfant {
                enfants += 1.0;
            } else {
                edu_sum += ag.edu;
                edu_n += 1.0;
            }
            if ag.status == Status::Actif {
                actifs += 1.0;
                if let Some(j) = ag.job {
                    workers_by_job[j] += 1.0;
                }
                if ag.public_job {
                    pub_emp += 1.0;
                }
            }
            if ag.status == Status::Chomeur {
                chomeurs += 1.0;
            }
            if ag.status == Status::Retraite {
                retraites += 1.0;
            }
        }
        let (mut firms, mut indep, mut firm_workers, mut biggest, mut employees) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for b in self.alive_biz.iter().map(|&i| &self.businesses[i]) {
            if !b.alive || b.workers.is_empty() {
                continue;
            }
            let nw = b.workers.len() as f64;
            if nw >= 2.0 {
                firms += 1.0;
                firm_workers += nw;
                employees += nw - 1.0;
            } else {
                indep += 1.0;
            }
            biggest = mx(biggest, nw);
        }
        if self.day % 5 == 0 || self.day <= 1 {
            let values = self.biz_values();
            let adults: Vec<usize> = self.aa().into_iter().filter(|&a| self.agents[a].alive && self.agents[a].status != Status::Enfant).collect();
            let w: Vec<f64> = adults.iter().map(|&a| self.wealth_of(a, Some(&values))).collect();
            self.last_gini.w = gini(&w);
            let incs: Vec<f64> = adults.iter().map(|&a| or(self.agents[a].last_income, self.agents[a].income)).collect();
            self.last_gini.i = gini(&incs);
            let mut inc: Vec<f64> = adults.iter().filter(|&&a| self.agents[a].status == Status::Actif).map(|&a| self.agents[a].last_income).collect();
            inc.sort_by(|x, y| ord(x - y));
            if inc.len() > 20 {
                let l = inc.len() as f64;
                self.last_p9010 = inc[(l * 0.9).floor() as usize] / mx(100.0, inc[(l * 0.1).floor() as usize]);
            }
            let mut sorted = w.clone();
            sorted.sort_by(|x, y| ord(x - y));
            let mut tot = 0.0;
            for &x in &sorted {
                tot += mx(0.0, x);
            }
            let tot = or(tot, 1.0);
            let n = sorted.len() as f64;
            let mut top = 0.0;
            for &x in &sorted[(n * 0.9).floor() as usize..] {
                top += mx(0.0, x);
            }
            self.last_gini.top10 = top / tot;
            // détention de la dette par quintile de patrimoine (adultes), puis par les entreprises
            let mut dh = [0.0; 8];
            if self.debt_total > 0.0 {
                let mut order: Vec<(usize, f64)> = adults.iter().copied().zip(w.iter().copied()).collect();
                order.sort_by(|x, y| ord(x.1 - y.1));
                let ol = order.len() as f64;
                for (i, &(a, _)) in order.iter().enumerate() {
                    let q = mn(4.0, floor((i as f64 / ol) * 5.0)) as usize;
                    dh[q] += self.agents[a].bonds;
                }
                for b in self.alive_biz.iter().map(|&i| &self.businesses[i]) {
                    if b.alive {
                        dh[5] += b.bonds;
                    }
                }
                dh[6] = self.cb_bonds;
                dh[7] = self.foreign_bonds;
                let mut tb = 0.0;
                for &x in &dh {
                    tb += x;
                }
                let tb = or(tb, 1.0);
                for x in dh.iter_mut() {
                    *x /= tb;
                }
            }
            self.last_debt_holders = dh;
            let mut bot = 0.0;
            for &x in &sorted[..(n * 0.5).floor() as usize] {
                bot += mx(0.0, x);
            }
            self.last_gini.bottom50 = bot / tot;
        }
        let mut insured = 0.0;
        for a in self.aa() {
            if self.is_head(a) && self.valid_insurer(self.agents[a].insurer).is_some() {
                insured += self.household_size(a);
            }
        }
        let mut bonds_a = 0.0;
        let mut bonds_b = 0.0;
        if self.legacy {
            for a in &self.agents {
                bonds_a += a.bonds;
            }
            for b in &self.businesses {
                bonds_b += b.bonds;
            }
        } else {
            for &a in &self.alive_agents {
                bonds_a += self.agents[a].bonds;
            }
            for &b in &self.alive_biz {
                bonds_b += self.businesses[b].bonds;
            }
        }
        let gdp_y = self.gdp_year();
        let l = self.month_log.len();
        let log = &self.month_log[l.saturating_sub(12)..];
        let def_y = if log.is_empty() {
            0.0
        } else {
            let mut s = 0.0;
            let mut g = 0.0;
            for m in log {
                s = s + m.spend - m.rev;
                g += m.gdp;
            }
            s / mx(1.0, g)
        };
        let mut prem_w = 0.0;
        let mut prem_u = 0.0;
        for b in self.alive_biz.iter().map(|&i| &self.businesses[i]) {
            if !b.alive || b.job != ASSUREUR || b.workers.is_empty() {
                continue;
            }
            prem_w += b.premium * mx(1.0, b.insured_units);
            prem_u += mx(1.0, b.insured_units);
        }
        let e = |x: f64| x / 100.0;
        let mut retail_price = NO_GOODS;
        for g in RETAIL_GOODS {
            retail_price[g] = Some(e(self.last_r[g]));
        }
        let mut wholesale_price = NO_GOODS;
        for g in 0..NG {
            wholesale_price[g] = Some(e(self.last_w[g]));
        }
        let mut income_by_job = [0.0; NJ];
        for j in 0..NJ {
            income_by_job[j] = e(self.sector_income[j]);
        }
        let d = &self.d;
        let row = DayStats {
            day: self.day,
            population: pop,
            enfants,
            actifs,
            chomeurs,
            retraites,
            births: d.births,
            deaths: d.deaths,
            gdp: e(d.gdp),
            wholesale_value: e(d.wholesale_value),
            retail_price: GoodMap(retail_price),
            wholesale_price: GoodMap(wholesale_price),
            retail_volume: GoodMap(d.retail_volume),
            wholesale_volume: GoodMap(d.wholesale_volume),
            production: GoodMap(d.production),
            waste: GoodMap(d.waste),
            unmet_demand: GoodMap(d.unmet),
            workers_by_job: JobMap(workers_by_job),
            income_by_job: JobMap(income_by_job),
            gini_wealth: self.last_gini.w,
            gini_income: self.last_gini.i,
            top10_wealth: self.last_gini.top10,
            bottom50_wealth: self.last_gini.bottom50,
            avg_health: if pop != 0.0 { health / pop } else { 0.0 },
            avg_edu_adults: if edu_n != 0.0 { edu_sum / edu_n } else { 0.0 },
            hunger_rate: if pop != 0.0 { hungry / pop } else { 0.0 },
            sick_rate: if pop != 0.0 { sick / pop } else { 0.0 },
            treasury: e(self.treasury),
            revenue: d.revenue.map(e),
            spending: d.spending.map(e),
            paid_ratio: d.paid_ratio,
            money_households: e(money.households),
            money_businesses: e(money.businesses),
            money_total: e(money.total),
            fish_stock: self.fish_stock,
            forest_stock: self.forest_stock,
            firms,
            independents: indep,
            avg_firm_size: if firms != 0.0 { firm_workers / firms } else { 0.0 },
            biggest_firm: biggest,
            employees,
            public_employees: pub_emp,
            cpi: self.cpi_chain,
            velocity: if money.total > 0.0 { (d.gdp * D) / money.total } else { 0.0 },
            p90p10: self.last_p9010,
            care_acts: d.care_acts,
            care_denied: d.care_denied,
            care_no_doctor: d.care_no_doctor,
            sick_untreated: d.sick_untreated,
            care_spend: d.care_spend.map(e),
            avg_fee: e(self.avg_fee),
            avg_premium: if prem_u != 0.0 { e(prem_w / prem_u) } else { 0.0 },
            insured_rate: if pop != 0.0 { insured / pop } else { 0.0 },
            debt: e(self.debt_total),
            debt_ratio: self.debt_total / gdp_y,
            deficit_ratio: def_y,
            avg_rate: self.avg_debt_rate(),
            last_rate: self.last_rate,
            borrowing: e(d.borrowing),
            repayment: e(d.repayment),
            debt_holders: self.last_debt_holders,
            nfa_households: e(money.households + bonds_a),
            nfa_businesses: e(money.businesses + bonds_b - self.bank_loans_total),
            nfa_public: e(self.treasury - self.debt_total),
            budget_cut: self.budget_cut,
            money_created: self.money_created.map(e),
            policy_rate: self.policy_rate,
            inflation: self.inflation,
            bank_loans: e(self.bank_loans_total),
            cb_debt: e(self.cb_bonds),
            foreign_debt: e(self.foreign_bonds),
            bank_equity: e(self.bank_equity),
            energy_by_source: d.energy_by_source,
            energy_use: d.energy_use,
            emissions: d.emissions,
            pollution: self.pollution / k::POLLUTION_REF,
            oil_left: self.oil_reserve / k::OIL_RESERVE,
            gas_left: self.gas_reserve / k::GAS_RESERVE,
            staff_cov: [
                self.staff_cov(ADMINISTRATEUR, k::ADMIN_REF),
                self.staff_cov(POLICIER, k::POLICE_REF),
                self.staff_cov(INFIRMIER, k::NURSE_REF),
                self.staff_cov(GARDE, k::RANGER_REF),
                if self.kids_n != 0.0 {
                    mn(1.0, (self.staff_n[ENSEIGNANT] * k::PUPILS_PER_TEACHER) / mx(1.0, self.kids_n * 0.62))
                } else {
                    1.0
                },
            ],
            tax_eff: self.tax_eff,
            infra_cov: self.infra / mx(1.0, k::INFRA_PER_CAPITA * 100.0 * pop) / (2.0 / 3.0),
            social_housing: floor(self.housing),
            land_bonus: self.land_bonus,
            silo_stock: self.silo.qty(BLE),
            school_cov: self.school_cov,
            culture_cov: self.culture_cov,
            thefts: d.thefts,
            cold_rate: if pop != 0.0 { d.cold / pop } else { 0.0 },
            poor_rate: if heads != 0.0 { poor_heads / heads } else { 0.0 },
            death_ages: d.death_ages,
            infant_deaths: d.infant_deaths,
        };
        self.history.push(row);
        // mode sans interface : on ne garde que les derniers jours (le modèle relit au plus 91 jours)
        if self.history_cap > 0 && self.history.len() > 2 * self.history_cap {
            let n = self.history.len() - self.history_cap;
            self.history.drain(0..n);
            self.history_offset += n;
        }
    }
}
