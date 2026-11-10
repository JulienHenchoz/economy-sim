//! État du générateur aléatoire après n jours (diagnostic).
use ile::Simulation;
fn main() {
    let days: usize = std::env::args().nth(1).and_then(|x| x.parse().ok()).unwrap_or(360);
    let mut sim = Simulation::from_json(&serde_json::json!({ "seed": 42 }), &serde_json::json!({}));
    let s0 = sim.rng.state();
    for _ in 0..days { sim.step(); }
    let s1 = sim.rng.state();
    let calls = (s1 - s0) / 1831565813.0;
    println!("{} jours : ~{:.0} tirages ({:.0}/jour), état {:.3e} (2^{:.1})", days, calls, calls / days as f64, s1, s1.log2());
}
