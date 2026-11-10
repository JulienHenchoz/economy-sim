//! Écrit l'historique quotidien en JSON (une ligne par jour) pour comparer avec la version TypeScript :
//! golden <jours> <graine> [politique JSON] [événements JSON]
use ile::Simulation;
use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let days: usize = args.get(1).and_then(|x| x.parse().ok()).unwrap_or(360);
    let seed: f64 = args.get(2).and_then(|x| x.parse().ok()).unwrap_or(42.0);
    let policy: serde_json::Value = args.get(3).map(|x| serde_json::from_str(x).expect("politique JSON")).unwrap_or(serde_json::json!({}));
    // événements déclenchés à des jours donnés : '{"200":"tempete","400":"epidemie"}'
    let events: serde_json::Value = args.get(4).map(|x| serde_json::from_str(x).expect("événements JSON")).unwrap_or(serde_json::json!({}));
    let mut sim = Simulation::from_json(&serde_json::json!({ "seed": seed, "legacy": true }), &policy);
    let out = std::io::stdout();
    let mut out = std::io::BufWriter::new(out.lock());
    writeln!(out, "{}", serde_json::to_string(&sim.history[0]).unwrap()).unwrap();
    for _ in 0..days {
        if let Some(k) = events.get(sim.day.to_string()).and_then(|v| v.as_str()).and_then(ile::config::EventKind::from_id) {
            sim.trigger_event(k);
        }
        sim.step();
        writeln!(out, "{}", serde_json::to_string(sim.history.last().unwrap()).unwrap()).unwrap();
    }
    let news: Vec<String> = sim.news.iter().map(|n| format!("j{} {}", n.day, n.text)).collect();
    writeln!(out, "{}", serde_json::to_string(&serde_json::json!({ "news": news })).unwrap()).unwrap();
}
