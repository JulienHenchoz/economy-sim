//! Données pour l'interface (mêmes formes JSON que la version TypeScript).

use super::*;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Clone, Serialize)]
pub struct AgentRow {
    pub id: usize,
    pub name: String,
    pub age: f64,
    pub status: Status,
    pub job: String,
    pub role: String,
    pub money: f64,
    pub wealth: f64,
    pub income: f64,
    pub health: f64,
    pub edu: f64,
    pub insured: bool,
    pub bonds: f64,
}

#[derive(Deserialize)]
pub struct AgentsQuery {
    pub sort: String,
    pub dir: f64,
    #[serde(default)]
    pub job: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub search: String,
    pub limit: usize,
}

fn job_label(j: Option<Job>) -> String {
    match j {
        Some(j) => JOB_DEFS[j].label.to_string(),
        None => "—".to_string(),
    }
}

impl Simulation {
    pub fn agent_row(&self, a: usize, values: Option<&[Option<f64>]>) -> AgentRow {
        let ag = &self.agents[a];
        let mut role = "—".to_string();
        if ag.public_job {
            role = "Fonctionnaire".into();
        } else if ag.biz >= 0 {
            let b = &self.businesses[ag.biz as usize];
            role = if b.workers.len() == 1 {
                "Indépendant".into()
            } else if b.owner == a as i64 {
                format!("Patron ({} pers.)", b.workers.len())
            } else {
                "Salarié".into()
            };
        } else if !ag.shares.is_empty() && ag.status != Status::Enfant {
            role = "Rentier".into();
        }
        let ins = if self.is_head(a) || ag.parent < 0 { ag.insurer } else { self.agents[ag.parent as usize].insurer };
        AgentRow {
            id: a,
            name: agent_name(a as i64),
            age: floor(self.age_y(a)),
            status: ag.status,
            job: job_label(ag.job),
            role,
            money: ag.money / 100.0,
            wealth: self.wealth_of(a, values) / 100.0,
            income: ag.last_income / 100.0 / k::DAYS_PER_MONTH,
            health: ag.health,
            edu: ag.edu,
            insured: self.valid_insurer(ins).is_some(),
            bonds: ag.bonds / 100.0,
        }
    }

    pub fn snapshot(&self) -> Value {
        let values = self.biz_values();
        let alive: Vec<usize> = self.aa().into_iter().filter(|&a| self.agents[a].alive).collect();
        let adults: Vec<usize> = alive.iter().copied().filter(|&a| self.agents[a].status != Status::Enfant).collect();
        let wealth: Vec<(usize, f64)> = adults.iter().map(|&a| (a, self.wealth_of(a, Some(&values)))).collect();
        let lorenz = |vals: Vec<f64>| -> Vec<[f64; 2]> {
            let mut v: Vec<f64> = vals.iter().map(|&x| mx(0.0, x)).collect();
            v.sort_by(|x, y| ord(x - y));
            let mut tot = 0.0;
            for &x in &v {
                tot += x;
            }
            let tot = or(tot, 1.0);
            let mut out = vec![[0.0, 0.0]];
            let mut cum = 0.0;
            let step = (v.len() / 50).max(1);
            for i in 0..v.len() {
                cum += v[i];
                if (i + 1) % step == 0 || i == v.len() - 1 {
                    out.push([(i + 1) as f64 / v.len() as f64, cum / tot]);
                }
            }
            out
        };
        // histogramme logarithmique du patrimoine (écus)
        let edges = [0.0, 10.0, 25.0, 50.0, 100.0, 200.0, 400.0, 800.0, 1600.0, 3200.0, 6400.0, 12800.0, 25600.0, f64::INFINITY];
        let mut hist: Vec<(String, u32)> = (0..edges.len() - 1)
            .map(|i| {
                let lo = edges[i];
                let label = if edges[i + 1].is_infinite() { format!("> {}", lo) } else { format!("{}–{}", lo, edges[i + 1]) };
                (label, 0)
            })
            .collect();
        for &(_, w) in &wealth {
            let x = w / 100.0;
            let mut idx = None;
            for kk in 0..edges.len() - 1 {
                if x >= edges[kk] && x < edges[kk + 1] {
                    idx = Some(kk);
                    break;
                }
            }
            hist[idx.unwrap_or(0)].1 += 1;
        }
        let mut pyramid: Vec<[u32; 4]> = vec![[0; 4]; 20]; // actifs, enfants, retraites, chomeurs
        for &a in &alive {
            let i = mn(19.0, floor(self.age_y(a) / 5.0)).max(0.0) as usize;
            let s = match self.agents[a].status {
                Status::Actif => 0,
                Status::Enfant => 1,
                Status::Retraite => 2,
                Status::Chomeur => 3,
            };
            pyramid[i][s] += 1;
        }
        let pyramid: Vec<Value> = pyramid
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let lo = i * 5;
                json!({ "age": format!("{}–{}", lo, lo + 4), "actifs": c[0], "enfants": c[1], "retraites": c[2], "chomeurs": c[3] })
            })
            .collect();
        let jobs: Vec<Value> = (0..NJ)
            .map(|j| {
                let ws: Vec<usize> = adults.iter().copied().filter(|&a| self.agents[a].status == Status::Actif && self.agents[a].job == Some(j)).collect();
                let bs: Vec<&Business> = self.businesses.iter().filter(|b| b.alive && b.job == j && !b.workers.is_empty()).collect();
                let wl = ws.len() as f64;
                let mut avg_wealth = 0.0;
                if !ws.is_empty() {
                    let mut s = 0.0;
                    for &a in &ws {
                        s += self.wealth_of(a, Some(&values));
                    }
                    avg_wealth = s / wl / 100.0;
                }
                let mut top = 0.0f64;
                for b in &bs {
                    top = mx(top, b.workers.len() as f64);
                }
                json!({
                    "job": JOB_IDS[j],
                    "label": JOB_DEFS[j].label,
                    "workers": ws.len(),
                    "avgIncome": self.sector_income[j] / 100.0,
                    "avgWealth": avg_wealth,
                    "firms": bs.iter().filter(|b| b.workers.len() > 1).count(),
                    "independents": bs.iter().filter(|b| b.workers.len() == 1).count(),
                    "employees": bs.iter().map(|b| b.workers.len().saturating_sub(1)).sum::<usize>(),
                    "topShare": if ws.is_empty() { 0.0 } else { top / wl },
                })
            })
            .collect();
        let mut firms: Vec<&Business> = self.businesses.iter().filter(|b| b.alive && b.workers.len() > 1).collect();
        firms.sort_by(|x, y| {
            let v = y.workers.len() as f64 - x.workers.len() as f64;
            ord(if v == 0.0 { y.cash - x.cash } else { v })
        });
        let firms_table: Vec<Value> = firms
            .iter()
            .take(25)
            .map(|b| {
                json!({
                    "id": b.id, "job": JOB_DEFS[b.job].label, "patron": b.owner,
                    "patronName": if b.owner >= 0 { agent_name(b.owner) } else { "État".to_string() },
                    "workers": b.workers.len(), "cash": b.cash / 100.0, "wage": b.offer_wage / 100.0, "va": b.va_per_worker / 100.0,
                    "tools": b.tools, "founded": b.founded, "shareholders": b.shares.len(),
                })
            })
            .collect();
        let last = self.history.last();
        let goods: Vec<Value> = (0..NG)
            .map(|g| {
                let mut sb = 0.0;
                let mut sh = 0.0;
                for b in self.alive_biz.iter().map(|&i| &self.businesses[i]) {
                    if b.alive {
                        sb += b.inv.qty(g);
                    }
                }
                for &a in &alive {
                    if self.agents[a].food.size() > 0 {
                        sh += self.agents[a].food.qty(g);
                    }
                }
                let lv = |f: fn(&DayStats) -> &GoodOpt| last.and_then(|r| f(r)[g]).unwrap_or(0.0);
                json!({
                    "good": GOOD_IDS[g], "label": GOOD_DEFS[g].label,
                    "retail": if GOOD_DEFS[g].retail { Some(self.last_r[g] / 100.0) } else { None },
                    "wholesale": self.last_w[g] / 100.0,
                    "stockBiz": sb, "stockHouseholds": sh,
                    "retailVol": lv(|r| &r.retail_volume.0), "wholesaleVol": lv(|r| &r.wholesale_volume.0),
                    "waste": lv(|r| &r.waste.0), "production": lv(|r| &r.production.0),
                })
            })
            .collect();
        // flux du mois précédent (ou en cours si premier mois) ; transformation <-> production en net
        let src = if !self.flows_prev.is_empty() { &self.flows_prev } else { &self.flows_month };
        let mut fl = src.clone();
        let pt = fl.get((F_PRODUCTION, F_TRANSFORMATION)).unwrap_or(0.0);
        let tp = fl.get((F_TRANSFORMATION, F_PRODUCTION)).unwrap_or(0.0);
        fl.remove((F_PRODUCTION, F_TRANSFORMATION));
        fl.remove((F_TRANSFORMATION, F_PRODUCTION));
        if tp > pt {
            fl.insert((F_TRANSFORMATION, F_PRODUCTION), tp - pt);
        } else if pt > tp {
            fl.insert((F_PRODUCTION, F_TRANSFORMATION), pt - tp);
        }
        let flows = flows_json(&fl, true);
        let mut sorted_w = wealth.clone();
        sorted_w.sort_by(|x, y| ord(y.1 - x.1));
        let kpi = match last {
            Some(l) => json!({
                "population": l.population,
                "gdp": l.gdp,
                "giniWealth": l.gini_wealth,
                "giniIncome": l.gini_income,
                "treasury": l.treasury,
                "hungerRate": l.hunger_rate,
                "unemployment": if l.actifs + l.chomeurs != 0.0 { l.chomeurs / (l.actifs + l.chomeurs) } else { 0.0 },
                "cpi": l.cpi,
                "moneyError": self.money_error / 100.0,
                "moneyTotal": l.money_total,
                "avgHealth": l.avg_health,
                "firms": l.firms,
                "top10": l.top10_wealth,
                "fish": self.fish_stock / k::FISH_K,
                "forest": self.forest_stock / k::FOREST_K,
                "debt": l.debt,
                "debtRatio": l.debt_ratio,
                "deficitRatio": l.deficit_ratio,
                "lastRate": l.last_rate,
                "policyRate": l.policy_rate,
                "inflation": l.inflation,
                "moneyCreated": l.money_created[0] + l.money_created[1] + l.money_created[2],
            }),
            None => json!({}),
        };
        let richest: Vec<AgentRow> = sorted_w.iter().take(15).map(|x| self.agent_row(x.0, Some(&values))).collect();
        let n = sorted_w.len();
        let poorest: Vec<AgentRow> = sorted_w[n.saturating_sub(15)..].iter().rev().map(|x| self.agent_row(x.0, Some(&values))).collect();
        let (mobility, mobility_years) = self.mobility();
        let events: Vec<Value> = self.events.iter().map(|&(kd, left)| json!({ "kind": kd.id(), "label": kd.label(), "daysLeft": left })).collect();
        let news = &self.news[self.news.len().saturating_sub(60)..];
        json!({
            "day": self.day,
            "kpi": kpi,
            "lorenzWealth": lorenz(wealth.iter().map(|x| x.1).collect()),
            "lorenzIncome": lorenz(adults.iter().map(|&a| self.agents[a].last_income).collect()),
            "wealthHist": hist.iter().map(|(l, c)| json!({ "label": l, "count": c })).collect::<Vec<_>>(),
            "pyramid": pyramid,
            "jobs": jobs,
            "firmsTable": firms_table,
            "goods": goods,
            "flows": flows,
            "richest": richest,
            "poorest": poorest,
            "stateMonth": self.state_prev_month,
            "budget": self.budget,
            "debtInfo": self.debt_info(),
            "causesTotal": { "age": self.causes_total[0], "faim": self.causes_total[1], "maladie": self.causes_total[2] },
            "events": events,
            "mobility": mobility,
            "mobilityYears": mobility_years,
            "news": news,
        })
    }

    fn debt_info(&self) -> Value {
        let mut next = f64::INFINITY;
        let mut next_amount = 0.0;
        let mut ha = 0;
        let mut hb = 0;
        for t in &self.debt {
            let mut q = 0.0;
            for (&kk, &v) in &t.holders {
                q += v;
                if kk >= 0 {
                    ha += 1;
                } else if kk != CB_KEY && kk != FOREIGN_KEY {
                    hb += 1;
                }
            }
            let m = t.maturity as f64;
            if m < next {
                next = m;
                next_amount = q;
            } else if m == next {
                next_amount += q;
            }
        }
        json!({
            "tranches": self.debt.len(), "total": self.debt_total / 100.0, "avgRate": self.avg_debt_rate(),
            "nextMaturity": if next.is_finite() { next } else { -1.0 }, "nextAmount": next_amount / 100.0,
            "holdersAgents": ha, "holdersBiz": hb,
        })
    }

    /// Mobilité sociale : quintile d'il y a jusqu'à 5 ans → quintile du dernier relevé annuel.
    fn mobility(&self) -> (Vec<[u32; 5]>, i64) {
        let last = self.day / 360;
        let years = (last - 1).min(5);
        let mut m = vec![[0u32; 5]; 5];
        if years < 1 {
            return (m, 0);
        }
        for a in self.alive_agents.iter().map(|&i| &self.agents[i]) {
            if !a.alive {
                continue;
            }
            let q0 = a.quintiles.get((last - years) as usize).copied().unwrap_or(-1);
            let q1 = a.quintiles.get(last as usize).copied().unwrap_or(-1);
            if q0 < 0 || q1 < 0 {
                continue;
            }
            m[q0 as usize][q1 as usize] += 1;
        }
        (m, years)
    }

    /// Données compactes pour la carte de l'île.
    pub fn map_state(&self) -> Value {
        let values = self.biz_values();
        let alive: Vec<usize> = self.aa().into_iter().filter(|&a| self.agents[a].alive).collect();
        let mut ranked: Vec<(usize, f64)> = alive
            .iter()
            .copied()
            .filter(|&a| self.agents[a].status != Status::Enfant)
            .map(|a| (a, self.wealth_of(a, Some(&values))))
            .collect();
        ranked.sort_by(|x, y| ord(x.1 - y.1));
        let mut rank: Vec<Option<f64>> = vec![None; self.agents.len()];
        let rl = ranked.len();
        for (i, &(a, _)) in ranked.iter().enumerate() {
            rank[a] = Some(if rl > 1 { i as f64 / (rl - 1) as f64 } else { 0.5 });
        }
        let agents: Vec<Value> = alive
            .iter()
            .map(|&a| {
                let ag = &self.agents[a];
                let head: i64 = if self.is_head(a) { a as i64 } else { ag.parent };
                let boss = ag.biz >= 0 && {
                    let b = &self.businesses[ag.biz as usize];
                    b.owner == a as i64 && b.workers.len() > 1
                };
                let r = rank[a].or_else(|| if head >= 0 { rank[head as usize] } else { None }).unwrap_or(0.5);
                json!({
                    "id": a,
                    "job": ag.job.map(|j| j as i64).unwrap_or(-1),
                    "status": match ag.status { Status::Enfant => 0, Status::Actif => 1, Status::Chomeur => 2, Status::Retraite => 3 },
                    "biz": ag.biz,
                    "home": head,
                    "rank": r,
                    "hunger": ag.hunger,
                    "sick": ag.sick,
                    "publicJob": ag.public_job,
                    "boss": boss,
                })
            })
            .collect();
        let last = self.history.last();
        json!({
            "day": self.day,
            "agents": agents,
            "fish": self.fish_stock / k::FISH_K,
            "forest": self.forest_stock / k::FOREST_K,
            "production": last.map(|r| serde_json::to_value(r.production).unwrap()).unwrap_or(json!({})),
            "shops": self.businesses.iter().filter(|b| b.alive && b.job == COMMERCANT && !b.workers.is_empty()).count(),
            "flows": flows_json(&self.d.flows, false),
            "hungerRate": last.map(|r| r.hunger_rate).unwrap_or(0.0),
            "events": self.events.iter().map(|e| e.0.id()).collect::<Vec<_>>(),
        })
    }

    pub fn agent_detail(&self, id: usize) -> Value {
        let Some(a) = self.agents.get(id) else { return Value::Null };
        let values = self.biz_values();
        let mut v = serde_json::to_value(self.agent_row(id, Some(&values))).unwrap();
        let o = v.as_object_mut().unwrap();
        o.insert("alive".into(), json!(a.alive));
        o.insert("deathCause".into(), json!(a.death_cause.map(|c| c.id())));
        o.insert("deathDay".into(), json!(a.death_day));
        o.insert(
            "parent".into(),
            if a.parent >= 0 {
                json!({ "id": a.parent, "name": agent_name(a.parent), "alive": self.agents[a.parent as usize].alive })
            } else {
                Value::Null
            },
        );
        o.insert(
            "children".into(),
            json!(a
                .children
                .iter()
                .map(|&c| json!({ "id": c, "name": agent_name(c as i64), "alive": self.agents[c].alive, "age": floor(self.age_y(c)) }))
                .collect::<Vec<_>>()),
        );
        o.insert("inherited".into(), json!(a.inherited / 100.0));
        o.insert("sick".into(), json!(a.sick));
        o.insert("hunger".into(), json!(a.hunger));
        o.insert(
            "business".into(),
            if a.biz >= 0 {
                let b = &self.businesses[a.biz as usize];
                json!({
                    "id": b.id, "job": JOB_DEFS[b.job].label, "workers": b.workers.len(), "owner": b.owner,
                    "ownerName": if b.owner >= 0 { agent_name(b.owner) } else { "État".to_string() },
                    "cash": b.cash / 100.0, "tools": b.tools, "wage": b.wages.get(&id).copied().unwrap_or(0.0) / 100.0,
                })
            } else {
                Value::Null
            },
        );
        o.insert(
            "shares".into(),
            json!(a
                .shares
                .iter()
                .map(|(&bid, &s)| json!({
                    "biz": bid, "job": JOB_DEFS[self.businesses[bid].job].label, "share": s,
                    "value": (s * values[bid].unwrap_or(0.0)) / 100.0,
                }))
                .collect::<Vec<_>>()),
        );
        o.insert(
            "food".into(),
            json!(a
                .food
                .goods()
                .map(|g| (g, a.food.qty(g)))
                .filter(|x| x.1 > 0.01)
                .map(|(g, q)| json!({ "good": GOOD_DEFS[g].label, "qty": q }))
                .collect::<Vec<_>>()),
        );
        v
    }

    /// Liste filtrée et triée des habitants (onglet « Habitants »).
    pub fn agents_query(&self, q: &AgentsQuery) -> Value {
        let values = self.biz_values();
        let search = q.search.trim().to_lowercase();
        let mut rows: Vec<AgentRow> = self.aa().into_iter()
            .filter(|&a| self.agents[a].alive)
            .filter(|&a| q.job.is_empty() || self.agents[a].job.map(|j| JOB_IDS[j] == q.job).unwrap_or(false))
            .filter(|&a| q.status.is_empty() || self.agents[a].status.id() == q.status)
            .map(|a| self.agent_row(a, Some(&values)))
            .filter(|r| search.is_empty() || r.name.to_lowercase().contains(&search) || r.id.to_string() == search)
            .collect();
        let key = |r: &AgentRow| match q.sort.as_str() {
            "income" => r.income,
            "age" => r.age,
            "health" => r.health,
            _ => r.wealth,
        };
        rows.sort_by(|x, y| ord((key(x) - key(y)) * q.dir));
        let total = rows.len();
        rows.truncate(q.limit);
        json!({ "rows": rows, "total": total })
    }
}

fn flows_json(fl: &Flows, positive_only: bool) -> Vec<Value> {
    let mut out = Vec::new();
    for ((from, to), v) in fl.iter() {
        if from == to || (positive_only && v <= 0.0) {
            continue;
        }
        out.push(json!({ "from": FLOW_IDS[from as usize], "to": FLOW_IDS[to as usize], "value": v / 100.0 }));
    }
    out
}
