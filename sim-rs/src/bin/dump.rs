//! État détaillé après n jours (débogage de la comparaison avec la version TypeScript).
use ile::config::*;
use ile::Simulation;
use serde_json::{json, Map, Value};

fn inv(i: &ile::util::Inv) -> Value {
    let mut m = Map::new();
    for (g, b) in i.iter() {
        m.insert(GOOD_IDS[g].into(), json!(b.iter().map(|x| [x.q, x.exp]).collect::<Vec<_>>()));
    }
    Value::Object(m)
}
fn gm(o: &[Option<f64>; NG]) -> Value {
    let mut m = Map::new();
    for g in 0..NG {
        if let Some(v) = o[g] {
            m.insert(GOOD_IDS[g].into(), json!(v));
        }
    }
    Value::Object(m)
}
fn ga(o: &[f64; NG]) -> Value {
    let mut m = Map::new();
    for g in 0..NG {
        m.insert(GOOD_IDS[g].into(), json!(o[g]));
    }
    Value::Object(m)
}

fn main() {
    let days: usize = std::env::args().nth(1).and_then(|x| x.parse().ok()).unwrap_or(1);
    let mut sim = Simulation::from_json(&json!({ "seed": 42, "legacy": true }), &json!({}));
    for _ in 0..days {
        sim.step();
    }
    let agents: Vec<Value> = sim.agents.iter().map(|a| json!({ "money": a.money, "health": a.health, "xp": a.xp, "edu": a.edu, "fed": a.fed, "hunger": a.hunger, "appetite": a.appetite, "income": a.income, "sick": a.sick, "insurer": a.insurer, "prefs": gm(&a.prefs), "food": inv(&a.food), "bonds": a.bonds })).collect();
    let biz: Vec<Value> = sim.businesses.iter().map(|b| json!({ "cash": b.cash, "tools": b.tools, "potential": b.potential, "ask": gm(&b.ask), "bid": gm(&b.bid), "retail": gm(&b.retail), "avgCost": gm(&b.avg_cost), "salesEma": gm(&b.sales_ema), "outSales": gm(&b.out_sales), "prodEma": gm(&b.prod_ema), "vaEma": b.va_ema, "costEma": b.cost_ema, "fee": b.fee, "premium": b.premium, "inv": inv(&b.inv) })).collect();
    let g = json!({ "treasury": sim.treasury, "lastW": ga(&sim.last_w), "lastR": ga(&sim.last_r), "infra": sim.infra, "housing": sim.housing, "cultureCov": sim.culture_cov, "schoolCov": sim.school_cov, "fish": sim.fish_stock, "forest": sim.forest_stock, "cpi": sim.cpi_chain, "avgFee": sim.avg_fee, "landBonus": sim.land_bonus });
    println!("{}", json!({ "agents": agents, "biz": biz, "g": g }));
}
