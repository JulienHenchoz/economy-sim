//! Mesure de vitesse : bench <jours> <graine>
use ile::Simulation;
fn main() {
    let days: usize = std::env::args().nth(1).and_then(|x| x.parse().ok()).unwrap_or(2160);
    let seed: f64 = std::env::args().nth(2).and_then(|x| x.parse().ok()).unwrap_or(42.0);
    let mut sim = Simulation::from_json(&serde_json::json!({ "seed": seed }), &serde_json::json!({}));
    let t0 = std::time::Instant::now();
    for _ in 0..days {
        sim.step();
    }
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    println!("{} jours en {:.0} ms ({:.2} ms/jour), population {}", days, ms, ms / days as f64, sim.history.last().unwrap().population);
    #[cfg(feature = "profile")]
    ile::sim::PROFILE.with(|p| {
        let p = p.borrow();
        let mut v: Vec<(usize, f64)> = p.iter().copied().enumerate().collect();
        v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        ile::util::COUNTS.with(|c| {
            let c = c.borrow();
            let d = days as f64;
            println!("  par jour : qty {:.0} (lots lus {:.0}), add {:.0}, tirages {:.0}", c[0] as f64 / d, c[1] as f64 / d, c[2] as f64 / d, c[3] as f64 / d);
        });
        for (i, t) in v {
            println!("  {:>5.1} %  {}", t * 1000.0 / ms * 100.0, ile::sim::PHASES[i]);
        }
    });
}
