//! Taille des stocks (nombre de lots) après n jours.
use ile::config::*;
use ile::Simulation;
fn main() {
    let days: usize = std::env::args().nth(1).and_then(|x| x.parse().ok()).unwrap_or(720);
    let mut sim = Simulation::from_json(&serde_json::json!({ "seed": 42 }), &serde_json::json!({}));
    for _ in 0..days {
        sim.step();
    }
    let mut a = [0usize; NG];
    let mut na = 0;
    for ag in &sim.agents {
        if !ag.alive { continue; }
        na += 1;
        for (g, b) in ag.food.iter() { a[g] += b.len(); }
    }
    let mut b = [0usize; NG];
    let mut nb = 0;
    for x in &sim.businesses {
        if !x.alive { continue; }
        nb += 1;
        for (g, l) in x.inv.iter() { b[g] += l.len(); }
    }
    println!("{} habitants ({} au total), {} entreprises ({} au total), Agent {} o, Business {} o", na, sim.agents.len(), nb, sim.businesses.len(), std::mem::size_of::<ile::sim::Agent>(), std::mem::size_of::<ile::sim::Business>());
    for g in 0..NG {
        println!("{:>12}  lots/habitant {:>7.2}  lots/entreprise {:>7.2}", GOOD_IDS[g], a[g] as f64 / na as f64, b[g] as f64 / nb as f64);
    }
}
