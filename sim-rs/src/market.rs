//! Enchère double à prix uniforme (« call market »).

use crate::util::{ord, Rng};

/// Ordre d'achat ou de vente. `owner` est un identifiant opaque pour l'appelant.
#[derive(Clone, Copy, Debug)]
pub struct Order {
    pub owner: i64,
    pub qty: f64,
    /// Prix limite en centimes par unité.
    pub price: f64,
    /// Donnée libre (0 = aucune).
    pub tag: i32,
}

impl Order {
    pub fn new(owner: i64, qty: f64, price: f64) -> Order {
        Order { owner, qty, price, tag: 0 }
    }
    pub fn tagged(owner: i64, qty: f64, price: f64, tag: i32) -> Order {
        Order { owner, qty, price, tag }
    }
}

/// Appariement : indices dans les tableaux d'ordres (triés par l'enchère).
#[derive(Clone, Copy, Debug)]
pub struct Match {
    pub bid: usize,
    pub ask: usize,
    pub qty: f64,
}

pub struct AuctionResult {
    pub price: Option<f64>,
    pub volume: f64,
    pub matches: Vec<Match>,
    pub demand: f64,
    pub supply: f64,
}

/// Les ordres d'achat sont triés par prix décroissant, ceux de vente par prix croissant (après un
/// mélange pour départager les prix égaux) ; on apparie tant que l'acheteur offre au moins le prix
/// demandé. Toutes les transactions se font au même prix : le milieu entre la dernière offre et la
/// dernière demande servies. Les tableaux sont triés sur place.
pub fn call_auction(bids: &mut [Order], asks: &mut [Order], rng: &mut Rng) -> AuctionResult {
    let mut demand = 0.0;
    let mut supply = 0.0;
    for b in bids.iter() {
        demand += b.qty;
    }
    for a in asks.iter() {
        supply += a.qty;
    }
    let mut res = AuctionResult { price: None, volume: 0.0, matches: Vec::new(), demand, supply };
    if bids.is_empty() || asks.is_empty() {
        return res;
    }
    rng.shuffle(bids);
    bids.sort_by(|x, y| ord(y.price - x.price));
    rng.shuffle(asks);
    asks.sort_by(|x, y| ord(x.price - y.price));
    let mut i = 0;
    let mut j = 0;
    let mut rem_b = bids[0].qty;
    let mut rem_a = asks[0].qty;
    let mut last_b = 0.0;
    let mut last_a = 0.0;
    while i < bids.len() && j < asks.len() && bids[i].price >= asks[j].price {
        let q = crate::util::mn(rem_b, rem_a);
        if q > 1e-9 {
            res.matches.push(Match { bid: i, ask: j, qty: q });
            res.volume += q;
            last_b = bids[i].price;
            last_a = asks[j].price;
        }
        rem_b -= q;
        rem_a -= q;
        if rem_b <= 1e-9 {
            i += 1;
            rem_b = if i < bids.len() { bids[i].qty } else { 0.0 };
        }
        if rem_a <= 1e-9 {
            j += 1;
            rem_a = if j < asks.len() { asks[j].qty } else { 0.0 };
        }
    }
    if res.volume > 0.0 {
        res.price = Some((last_b + last_a) / 2.0);
    }
    res
}
