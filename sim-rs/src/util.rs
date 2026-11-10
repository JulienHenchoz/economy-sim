//! Outils : sémantique numérique de JavaScript, générateur pseudo-aléatoire, stocks périssables, Gini.
//!
//! Le modèle a été calibré en TypeScript : pour reproduire exactement ses trajectoires, on imite les
//! fonctions de JS (Math.max qui propage NaN, Math.round qui arrondit .5 vers +∞, fonctions
//! transcendantes de fdlibm comme V8) et l'ordre d'insertion des Map.

use crate::config::{Good, NG};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

// ---------------------------------------------------------------------------------------------
// Sémantique de Math.*

#[inline]
pub fn mx(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a > b {
        a
    } else if b > a {
        b
    } else if a == 0.0 && b == 0.0 {
        // Math.max(-0, 0) = 0
        if a.is_sign_positive() { a } else { b }
    } else {
        a
    }
}

#[inline]
pub fn mn(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a < b {
        a
    } else if b < a {
        b
    } else if a == 0.0 && b == 0.0 {
        // Math.min(0, -0) = -0
        if a.is_sign_negative() { a } else { b }
    } else {
        a
    }
}

/// Math.round : la moitié est arrondie vers +∞.
#[inline]
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    let r = if x - f >= 0.5 { f + 1.0 } else { f };
    // Math.round(-0.3) = -0
    if r == 0.0 && x.is_sign_negative() { -0.0 } else { r }
}

#[inline]
pub fn floor(x: f64) -> f64 {
    x.floor()
}
#[inline]
pub fn ceil(x: f64) -> f64 {
    x.ceil()
}
#[inline]
pub fn pow(a: f64, b: f64) -> f64 {
    // cas particuliers où JS diffère de C (1 ** NaN = NaN, (±1) ** ±∞ = NaN)
    if b.is_nan() {
        return f64::NAN;
    }
    if b.is_infinite() && (a == 1.0 || a == -1.0) {
        return f64::NAN;
    }
    crate::v8math::pow(a, b)
}
#[inline]
pub fn exp(x: f64) -> f64 {
    crate::v8math::exp(x)
}
#[inline]
pub fn ln(x: f64) -> f64 {
    crate::v8math::log(x)
}
#[inline]
pub fn log10(x: f64) -> f64 {
    crate::v8math::log10(x)
}
#[inline]
pub fn sqrt(x: f64) -> f64 {
    x.sqrt()
}
#[inline]
pub fn cos(x: f64) -> f64 {
    crate::v8math::cos(x)
}

pub fn clamp(x: f64, a: f64, b: f64) -> f64 {
    if x < a {
        a
    } else if x > b {
        b
    } else {
        x
    }
}

/// Résultat d'un comparateur JS (nombre) → Ordering, NaN valant 0.
#[inline]
pub fn ord(v: f64) -> Ordering {
    if v < 0.0 {
        Ordering::Less
    } else if v > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// `a || b` sur des nombres : `b` si `a` vaut 0 ou NaN.
#[inline]
pub fn or(a: f64, b: f64) -> f64 {
    if a == 0.0 || a.is_nan() { b } else { a }
}

/// Affichage d'un nombre comme `${x}` en JS (entiers sans décimale, -0 → 0).
pub fn js_num(x: f64) -> String {
    if x == 0.0 {
        return "0".into();
    }
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    format!("{}", x)
}

/// x.toFixed(d)
pub fn fixed(x: f64, d: usize) -> String {
    format!("{:.*}", d, x)
}

// ---------------------------------------------------------------------------------------------
// Générateur pseudo-aléatoire reproductible (mulberry32, version JS).

/// Générateur pseudo-aléatoire reproductible.
///
/// Par défaut SplitMix64 (état 64 bits, période 2^64). En mode `legacy`, le mulberry32 de la version
/// TypeScript, état compris : `this.s += 0x6d2b79f5` n'y est jamais ramené modulo 2^32, l'état grandit
/// en flottant et perd ses bits de poids faible au-delà de 2^53 (après ~7 mois simulés). La période
/// de la suite se réduit alors : ~2 ans de tirages au bout de 80 ans, ~47 jours au bout de 1 200 ans.
#[derive(Clone, Serialize, Deserialize)]
pub struct Rng {
    s: f64,
    x: u64,
    legacy: bool,
}

#[inline]
pub fn to_uint32(x: f64) -> u32 {
    // cas courant (entier positif < 2^64) : la conversion entière est exacte et bien plus rapide que fmod
    if x >= 0.0 && x < 18446744073709551616.0 {
        return x as u64 as u32;
    }
    if !x.is_finite() {
        return 0;
    }
    let mut r = x.trunc() % 4294967296.0;
    if r < 0.0 {
        r += 4294967296.0;
    }
    r as u32
}

impl Rng {
    pub fn new(seed: f64) -> Rng {
        Rng::with_mode(seed, false)
    }
    pub fn with_mode(seed: f64, legacy: bool) -> Rng {
        let s = to_uint32(seed) as f64;
        let x = (seed.trunc() as i64 as u64) ^ 0x2545_F491_4F6C_DD1D;
        Rng { s: if s == 0.0 { 1.0 } else { s }, x, legacy }
    }
    /// État interne (diagnostic).
    pub fn state(&self) -> f64 {
        self.s
    }
    #[inline]
    pub fn next(&mut self) -> f64 {
        #[cfg(feature = "profile")]
        COUNTS.with(|c| c.borrow_mut()[3] += 1);
        if !self.legacy {
            // SplitMix64, 53 bits de mantisse
            self.x = self.x.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.x;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^= z >> 31;
            return (z >> 11) as f64 * (1.0 / 9007199254740992.0);
        }
        self.s += 1831565813.0; // 0x6d2b79f5
        let mut t = to_uint32(self.s);
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
    #[inline]
    pub fn range(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.next()
    }
    #[inline]
    pub fn int(&mut self, n: usize) -> usize {
        (self.next() * n as f64).floor() as usize
    }
    pub fn normal(&mut self) -> f64 {
        let u = mx(1e-12, self.next());
        sqrt(-2.0 * ln(u)) * cos(2.0 * std::f64::consts::PI * self.next())
    }
    pub fn shuffle<T>(&mut self, arr: &mut [T]) {
        let n = arr.len();
        if n < 2 {
            return;
        }
        for i in (1..n).rev() {
            let j = self.int(i + 1);
            arr.swap(i, j);
        }
    }
    /// Choix pondéré : renvoie l'indice.
    pub fn weighted(&mut self, weights: &[f64]) -> usize {
        let mut tot = 0.0;
        for &w in weights {
            tot += mx(0.0, w);
        }
        if !(tot > 0.0) {
            // JS : `if (tot <= 0)` ; NaN passe outre et retombe sur le dernier indice
            if tot <= 0.0 {
                return self.int(weights.len());
            }
        }
        let mut r = self.next() * tot;
        for (i, &w) in weights.iter().enumerate() {
            r -= mx(0.0, w);
            if r <= 0.0 {
                return i;
            }
        }
        weights.len() - 1
    }
}

// ---------------------------------------------------------------------------------------------
// Stocks périssables : lots { quantité, jour d'expiration }, triés par expiration croissante.
// Les biens gardent leur ordre d'insertion (comme les clés d'une Map JS), même vidés.

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Batch {
    pub q: f64,
    pub exp: f64,
}

/// Stock d'un habitant ou d'une entreprise : tous les lots dans un seul tableau contigu, groupés par
/// bien (segments dans l'ordre où les biens sont apparus), chaque segment trié par expiration.
/// Un seul bloc mémoire par stock : beaucoup moins de défauts de cache que des listes séparées.
#[derive(Clone, Default)]
pub struct Inv {
    /// biens dans l'ordre d'apparition
    order: [u8; NG],
    n: u8,
    /// position de chaque bien dans `order`, 255 = absent
    pos: [u8; NG],
    start: [u32; NG],
    len: [u32; NG],
    data: Vec<Batch>,
}

impl Inv {
    pub fn new() -> Inv {
        Inv { order: [0; NG], n: 0, pos: [255; NG], start: [0; NG], len: [0; NG], data: Vec::new() }
    }
    /// Nombre de biens présents (taille de la Map JS).
    #[inline]
    pub fn size(&self) -> usize {
        self.n as usize
    }
    pub fn clear(&mut self) {
        *self = Inv::new();
    }
    #[inline]
    fn has(&self, g: Good) -> bool {
        self.pos[g] != 255
    }
    #[inline]
    fn seg(&self, g: Good) -> &[Batch] {
        let s = self.start[g] as usize;
        &self.data[s..s + self.len[g] as usize]
    }
    /// Lots d'un bien (None si le bien n'a jamais été présent).
    #[inline]
    pub fn get(&self, g: Good) -> Option<&[Batch]> {
        if self.has(g) { Some(self.seg(g)) } else { None }
    }
    fn ensure(&mut self, g: Good) {
        if !self.has(g) {
            self.pos[g] = self.n;
            self.order[self.n as usize] = g as u8;
            self.n += 1;
            self.start[g] = self.data.len() as u32;
            self.len[g] = 0;
        }
    }
    /// Décale les segments qui suivent `g` de `d` cases.
    #[inline]
    fn shift_after(&mut self, g: Good, d: i64) {
        for i in (self.pos[g] as usize + 1)..self.n as usize {
            let h = self.order[i] as usize;
            self.start[h] = (self.start[h] as i64 + d) as u32;
        }
    }
    /// Biens dans l'ordre d'insertion.
    pub fn goods(&self) -> impl Iterator<Item = Good> + '_ {
        self.order[..self.n as usize].iter().map(|&g| g as usize)
    }
    pub fn iter(&self) -> impl Iterator<Item = (Good, &[Batch])> {
        self.order[..self.n as usize].iter().map(move |&g| (g as usize, self.seg(g as usize)))
    }

    #[inline]
    pub fn qty(&self, g: Good) -> f64 {
        #[cfg(feature = "profile")]
        COUNTS.with(|c| {
            let mut c = c.borrow_mut();
            c[0] += 1;
            c[1] += self.len[g] as u64;
        });
        if !self.has(g) {
            return 0.0;
        }
        let mut s = 0.0;
        for x in self.seg(g) {
            s += x.q;
        }
        s
    }

    pub fn add(&mut self, g: Good, q: f64, exp: f64) {
        if q <= 1e-9 {
            return;
        }
        #[cfg(feature = "profile")]
        COUNTS.with(|c| c.borrow_mut()[2] += 1);
        self.ensure(g);
        let s = self.start[g] as usize;
        let l = self.len[g] as usize;
        if l > 0 && self.data[s + l - 1].exp == exp {
            self.data[s + l - 1].q += q;
            return;
        }
        // insertion triée (presque toujours en fin de segment)
        let mut i = l;
        while i > 0 && self.data[s + i - 1].exp > exp {
            i -= 1;
        }
        self.data.insert(s + i, Batch { q, exp });
        self.len[g] += 1;
        self.shift_after(g, 1);
    }

    pub fn add_batches(&mut self, g: Good, batches: &[Batch]) {
        for x in batches {
            self.add(g, x.q, x.exp);
        }
    }

    /// Retire les `k` premiers lots du bien `g`.
    fn drop_front(&mut self, g: Good, k: usize) {
        if k == 0 {
            return;
        }
        let s = self.start[g] as usize;
        self.data.drain(s..s + k);
        self.len[g] -= k as u32;
        self.shift_after(g, -(k as i64));
    }

    /// Retire `q` unités (les plus anciennes d'abord) et renvoie les lots retirés.
    pub fn take(&mut self, g: Good, q: f64) -> Vec<Batch> {
        let mut out = Vec::new();
        if !self.has(g) {
            return out;
        }
        let s = self.start[g] as usize;
        let l = self.len[g] as usize;
        let mut rest = q;
        let mut k = 0;
        while rest > 1e-9 && k < l {
            let x = self.data[s + k];
            if x.q <= rest + 1e-9 {
                out.push(x);
                rest -= x.q;
                k += 1;
            } else {
                out.push(Batch { q: rest, exp: x.exp });
                self.data[s + k].q -= rest;
                rest = 0.0;
            }
        }
        self.drop_front(g, k);
        out
    }

    /// `take` suivi de `dst.add_batches`, sans allocation.
    pub fn move_to(&mut self, g: Good, q: f64, dst: &mut Inv) {
        if !self.has(g) {
            return;
        }
        let s = self.start[g] as usize;
        let l = self.len[g] as usize;
        let mut rest = q;
        let mut k = 0;
        while rest > 1e-9 && k < l {
            let x = self.data[s + k];
            if x.q <= rest + 1e-9 {
                rest -= x.q;
                k += 1;
                dst.add(g, x.q, x.exp);
            } else {
                self.data[s + k].q -= rest;
                dst.add(g, rest, x.exp);
                rest = 0.0;
            }
        }
        self.drop_front(g, k);
    }

    /// Comme `take`, sans renvoyer les lots.
    pub fn remove(&mut self, g: Good, q: f64) {
        if !self.has(g) {
            return;
        }
        let s = self.start[g] as usize;
        let l = self.len[g] as usize;
        let mut rest = q;
        let mut k = 0;
        while rest > 1e-9 && k < l {
            let x = self.data[s + k];
            if x.q <= rest + 1e-9 {
                rest -= x.q;
                k += 1;
            } else {
                self.data[s + k].q -= rest;
                rest = 0.0;
            }
        }
        self.drop_front(g, k);
    }

    /// Quantité qui expire au plus tard le jour `day`.
    pub fn expiring_by(&self, g: Good, day: f64) -> f64 {
        if !self.has(g) {
            return 0.0;
        }
        let mut s = 0.0;
        for x in self.seg(g) {
            if x.exp > day {
                break;
            }
            s += x.q;
        }
        s
    }

    /// Supprime les lots périmés, ajoute la quantité perdue par bien à `lost`.
    pub fn expire(&mut self, day: f64, lost: &mut [Option<f64>; NG]) {
        for i in 0..self.n as usize {
            let g = self.order[i] as usize;
            let st = self.start[g] as usize;
            let l = self.len[g] as usize;
            let mut k = 0;
            let mut s = 0.0;
            while k < l && self.data[st + k].exp < day {
                s += self.data[st + k].q;
                k += 1;
            }
            if k > 0 {
                self.drop_front(g, k);
                lost[g] = Some(lost[g].unwrap_or(0.0) + s);
            }
        }
    }

    /// Expiration du premier lot (ou 1e9 si vide).
    pub fn first_exp(&self, g: Good) -> f64 {
        match self.get(g) {
            Some(b) if !b.is_empty() => b[0].exp,
            _ => 1e9,
        }
    }
}

/// Coefficient de Gini d'une liste de valeurs (valeurs négatives ramenées à 0).
pub fn gini(values: &[f64]) -> f64 {
    let mut v: Vec<f64> = values.iter().map(|&x| mx(0.0, x)).collect();
    v.sort_by(|a, b| ord(a - b));
    let n = v.len();
    if n == 0 {
        return 0.0;
    }
    let mut cum = 0.0;
    let mut weighted = 0.0;
    for (i, &x) in v.iter().enumerate() {
        cum += x;
        weighted += (i as f64 + 1.0) * x;
    }
    if cum <= 0.0 {
        return 0.0;
    }
    (2.0 * weighted) / (n as f64 * cum) - (n as f64 + 1.0) / n as f64
}

/// Somme des éléments dans l'ordre (comme reduce).
#[inline]
pub fn sum(it: impl IntoIterator<Item = f64>) -> f64 {
    let mut s = 0.0;
    for x in it {
        s += x;
    }
    s
}

// ---------------------------------------------------------------------------------------------
// Tables à clés entières : hachage rapide (FxHash) mais ordre d'insertion conservé (IndexMap),
// comme les Map de JavaScript.

#[derive(Default, Clone, Copy)]
pub struct FxHasher(u64);
impl std::hash::Hasher for FxHasher {
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u64(b as u64);
        }
    }
    #[inline]
    fn write_u64(&mut self, i: u64) {
        self.0 = (self.0.rotate_left(5) ^ i).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    #[inline]
    fn write_i64(&mut self, i: i64) {
        self.write_u64(i as u64);
    }
    #[inline]
    fn write_usize(&mut self, i: usize) {
        self.write_u64(i as u64);
    }
    #[inline]
    fn finish(&self) -> u64 {
        self.0
    }
}
pub type FxBuild = std::hash::BuildHasherDefault<FxHasher>;
pub type OrderedMap<K, V> = indexmap::IndexMap<K, V, FxBuild>;

/// Flux d'argent entre les 7 nœuds (ménages, secteurs, État) : tableau fixe, avec l'ordre de
/// première apparition des couples (pour l'affichage, comme une Map JS).
#[derive(Clone, Default)]
pub struct FlowMap {
    v: [[f64; 7]; 7],
    order: Vec<(u8, u8)>,
}
impl FlowMap {
    pub fn new() -> FlowMap {
        FlowMap::default()
    }
    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }
    #[inline]
    pub fn add(&mut self, from: u8, to: u8, x: f64) {
        let c = &mut self.v[from as usize][to as usize];
        if !self.order.contains(&(from, to)) {
            self.order.push((from, to));
            *c = 0.0;
        }
        *c += x;
    }
    pub fn get(&self, k: (u8, u8)) -> Option<f64> {
        if self.order.contains(&k) { Some(self.v[k.0 as usize][k.1 as usize]) } else { None }
    }
    pub fn remove(&mut self, k: (u8, u8)) {
        self.order.retain(|x| *x != k);
    }
    pub fn insert(&mut self, k: (u8, u8), x: f64) {
        if !self.order.contains(&k) {
            self.order.push(k);
        }
        self.v[k.0 as usize][k.1 as usize] = x;
    }
    pub fn iter(&self) -> impl Iterator<Item = ((u8, u8), f64)> + '_ {
        self.order.iter().map(|&k| (k, self.v[k.0 as usize][k.1 as usize]))
    }
}

#[cfg(feature = "profile")]
thread_local! {
    /// Compteurs : appels à qty, lots parcourus par qty, appels à add, tirages aléatoires.
    pub static COUNTS: std::cell::RefCell<[u64; 4]> = const { std::cell::RefCell::new([0; 4]) };
}
