//! Interface WebAssembly (sans wasm-bindgen) : des fonctions `extern "C"` qui échangent du JSON
//! par la mémoire linéaire. Le Web Worker (`src/sim/wasm.ts`) les enveloppe.
//!
//! Les simulations et les instantanés de la ligne du temps vivent ici, désignés par un numéro.
//! Un instantané est une copie de l'état sans l'historique : le restaurer recopie l'état et reprend
//! les lignes d'historique d'une simulation existante.

use crate::config::EventKind;
use crate::sim::{AgentsQuery, Simulation};
use std::cell::RefCell;

thread_local! {
    static SIMS: RefCell<Vec<Option<Simulation>>> = const { RefCell::new(Vec::new()) };
    static SNAPS: RefCell<Vec<Option<Simulation>>> = const { RefCell::new(Vec::new()) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn put(store: &'static std::thread::LocalKey<RefCell<Vec<Option<Simulation>>>>, s: Simulation) -> u32 {
    store.with(|v| {
        let mut v = v.borrow_mut();
        if let Some(i) = v.iter().position(|x| x.is_none()) {
            v[i] = Some(s);
            i as u32
        } else {
            v.push(Some(s));
            (v.len() - 1) as u32
        }
    })
}

fn with_sim<R>(id: u32, f: impl FnOnce(&mut Simulation) -> R) -> R {
    SIMS.with(|v| f(v.borrow_mut()[id as usize].as_mut().expect("simulation inconnue")))
}

fn output(s: String) -> u32 {
    OUT.with(|o| {
        let mut o = o.borrow_mut();
        o.clear();
        o.extend_from_slice(s.as_bytes());
        o.len() as u32
    })
}

fn input(ptr: *mut u8, len: u32) -> String {
    let bytes = unsafe { Vec::from_raw_parts(ptr, len as usize, len as usize) };
    String::from_utf8(bytes).unwrap_or_default()
}

fn json(ptr: *mut u8, len: u32) -> serde_json::Value {
    serde_json::from_str(&input(ptr, len)).unwrap_or(serde_json::Value::Null)
}

fn news_kind(k: &str) -> &'static str {
    match k {
        "politique" => "politique",
        "evenement" => "evenement",
        "prix" => "prix",
        "entreprise" => "entreprise",
        "deces" => "deces",
        "crise" => "crise",
        "ressource" => "ressource",
        _ => "societe",
    }
}

/// Réserve `len` octets pour un texte envoyé par JavaScript (libéré par la fonction qui le lit).
#[no_mangle]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(len as usize);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

/// Nouvelle simulation : `{ "init": {...}, "policy": {...} }` (réglages partiels).
#[no_mangle]
pub extern "C" fn sim_new(ptr: *mut u8, len: u32) -> u32 {
    let v = json(ptr, len);
    let s = Simulation::from_json(&v["init"], &v["policy"]);
    put(&SIMS, s)
}

#[no_mangle]
pub extern "C" fn sim_free(id: u32) {
    SIMS.with(|v| v.borrow_mut()[id as usize] = None);
}

#[no_mangle]
pub extern "C" fn sim_step(id: u32, days: u32) {
    with_sim(id, |s| {
        for _ in 0..days {
            s.step();
        }
    });
}

#[no_mangle]
pub extern "C" fn sim_day(id: u32) -> f64 {
    with_sim(id, |s| s.day as f64)
}

#[no_mangle]
pub extern "C" fn sim_all_dead(id: u32) -> u32 {
    with_sim(id, |s| s.all_dead() as u32)
}

#[no_mangle]
pub extern "C" fn sim_history_len(id: u32) -> u32 {
    with_sim(id, |s| s.history.len() as u32)
}

/// Lignes d'historique à partir de l'indice `from` (tableau JSON).
#[no_mangle]
pub extern "C" fn sim_history(id: u32, from: u32) -> u32 {
    let s = with_sim(id, |s| serde_json::to_string(&s.history[(from as usize).min(s.history.len())..]).unwrap());
    output(s)
}

#[no_mangle]
pub extern "C" fn sim_snapshot(id: u32) -> u32 {
    output(with_sim(id, |s| s.snapshot().to_string()))
}

#[no_mangle]
pub extern "C" fn sim_map(id: u32) -> u32 {
    output(with_sim(id, |s| s.map_state().to_string()))
}

#[no_mangle]
pub extern "C" fn sim_policy(id: u32) -> u32 {
    output(with_sim(id, |s| serde_json::to_string(&s.policy).unwrap()))
}

#[no_mangle]
pub extern "C" fn sim_init(id: u32) -> u32 {
    output(with_sim(id, |s| serde_json::to_string(&s.init).unwrap()))
}

#[no_mangle]
pub extern "C" fn sim_set_policy(id: u32, ptr: *mut u8, len: u32) {
    let v = json(ptr, len);
    with_sim(id, |s| s.set_policy(&v));
}

/// Fait de la gazette : `{ "kind": "...", "text": "..." }`.
#[no_mangle]
pub extern "C" fn sim_say(id: u32, ptr: *mut u8, len: u32) {
    let v = json(ptr, len);
    let kind = news_kind(v["kind"].as_str().unwrap_or(""));
    let text = v["text"].as_str().unwrap_or("").to_string();
    with_sim(id, |s| s.say(kind, text));
}

/// Déclenche un événement (identifiant en texte brut, par exemple `tempete`).
#[no_mangle]
pub extern "C" fn sim_event(id: u32, ptr: *mut u8, len: u32) {
    let k = input(ptr, len);
    if let Some(kind) = EventKind::from_id(&k) {
        with_sim(id, |s| s.trigger_event(kind));
    }
}

/// Texte du dernier fait de la gazette.
#[no_mangle]
pub extern "C" fn sim_last_news(id: u32) -> u32 {
    output(with_sim(id, |s| s.news.last().map(|n| n.text.clone()).unwrap_or_default()))
}

#[no_mangle]
pub extern "C" fn sim_agent(id: u32, agent: u32) -> u32 {
    output(with_sim(id, |s| s.agent_detail(agent as usize).to_string()))
}

/// Liste des habitants : `{ sort, dir, job, status, search, limit }`.
#[no_mangle]
pub extern "C" fn sim_agents(id: u32, ptr: *mut u8, len: u32) -> u32 {
    let q: Option<AgentsQuery> = serde_json::from_str(&input(ptr, len)).ok();
    output(match q {
        Some(q) => with_sim(id, |s| s.agents_query(&q).to_string()),
        None => "{\"rows\":[],\"total\":0}".to_string(),
    })
}

/// Instantané de l'état (sans l'historique).
#[no_mangle]
pub extern "C" fn snap_save(id: u32) -> u32 {
    let st = with_sim(id, |s| {
        let h = std::mem::take(&mut s.history);
        let c = s.clone();
        s.history = h;
        c
    });
    put(&SNAPS, st)
}

#[no_mangle]
pub extern "C" fn snap_free(snap: u32) {
    SNAPS.with(|v| v.borrow_mut()[snap as usize] = None);
}

/// Simulation vivante reconstruite à partir d'un instantané et des `rows` premières lignes
/// d'historique de la simulation `src`.
#[no_mangle]
pub extern "C" fn sim_restore(snap: u32, src: u32, rows: u32) -> u32 {
    let mut s = SNAPS.with(|v| v.borrow()[snap as usize].as_ref().expect("instantané inconnu").clone());
    s.history = with_sim(src, |x| x.history[..(rows as usize).min(x.history.len())].to_vec());
    put(&SIMS, s)
}
