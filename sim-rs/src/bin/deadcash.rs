//! Diagnostic : entreprises disparues qui détiennent encore de l'argent.
use ile::Simulation;
fn main() {
    let days: i64 = std::env::args().nth(1).and_then(|x| x.parse().ok()).unwrap_or(60);
    let mut sim = Simulation::from_json(&serde_json::json!({ "seed": 42 }), &serde_json::json!({}));
    while sim.day < days {
        sim.step();
        for b in &sim.businesses {
            if !b.alive && (b.cash != 0.0 || b.bonds != 0.0) {
                println!("jour {} entreprise {} (métier {}) cash {} bonds {} fondée {}", sim.day, b.id, b.job, b.cash, b.bonds, b.founded);
            }
        }
        let listed: Vec<usize> = sim.alive_biz.clone();
        let real: Vec<usize> = (0..sim.businesses.len()).filter(|&i| sim.businesses[i].alive).collect();
        if listed != real { println!("jour {} : liste des vivantes incohérente {:?}", sim.day, real.iter().filter(|x| !listed.contains(x)).collect::<Vec<_>>()); }
    }
}
