import type { Good } from './config';

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(arr: T[]): T {
    return arr[this.int(arr.length)];
  }
  normal(): number {
    const u = Math.max(1e-12, this.next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  /** Choix pondéré : renvoie l'indice. */
  weighted(weights: number[]): number {
    let tot = 0;
    for (const w of weights) tot += Math.max(0, w);
    if (tot <= 0) return this.int(weights.length);
    let r = this.next() * tot;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }
}

// ---------------------------------------------------------------------------
// Stocks périssables : lots { quantité, jour d'expiration }, triés par expiration croissante.

export interface Batch {
  q: number;
  exp: number;
}
export type Inventory = Map<Good, Batch[]>;

export function invQty(inv: Inventory, g: Good): number {
  const b = inv.get(g);
  if (!b) return 0;
  let s = 0;
  for (const x of b) s += x.q;
  return s;
}

export function invAdd(inv: Inventory, g: Good, q: number, exp: number): void {
  if (q <= 1e-9) return;
  let b = inv.get(g);
  if (!b) {
    b = [];
    inv.set(g, b);
  }
  const last = b[b.length - 1];
  if (last && last.exp === exp) {
    last.q += q;
    return;
  }
  // insertion triée (presque toujours en fin)
  let i = b.length;
  while (i > 0 && b[i - 1].exp > exp) i--;
  b.splice(i, 0, { q, exp });
}

export function invAddBatches(inv: Inventory, g: Good, batches: Batch[]): void {
  for (const x of batches) invAdd(inv, g, x.q, x.exp);
}

/** Retire `q` unités (les plus anciennes d'abord) et renvoie les lots retirés. */
export function invTake(inv: Inventory, g: Good, q: number): Batch[] {
  const b = inv.get(g);
  const out: Batch[] = [];
  if (!b) return out;
  let rest = q;
  while (rest > 1e-9 && b.length) {
    const x = b[0];
    if (x.q <= rest + 1e-9) {
      out.push(x);
      rest -= x.q;
      b.shift();
    } else {
      out.push({ q: rest, exp: x.exp });
      x.q -= rest;
      rest = 0;
    }
  }
  return out;
}

/** Quantité qui expire au plus tard le jour `day`. */
export function invExpiringBy(inv: Inventory, g: Good, day: number): number {
  const b = inv.get(g);
  if (!b) return 0;
  let s = 0;
  for (const x of b) {
    if (x.exp > day) break;
    s += x.q;
  }
  return s;
}

/** Supprime les lots périmés, renvoie la quantité perdue par bien. */
export function invExpire(inv: Inventory, day: number, lost: Partial<Record<Good, number>>): void {
  for (const [g, b] of inv) {
    let i = 0;
    let s = 0;
    while (i < b.length && b[i].exp < day) {
      s += b[i].q;
      i++;
    }
    if (i) {
      b.splice(0, i);
      lost[g] = (lost[g] ?? 0) + s;
    }
  }
}

export function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

/** Coefficient de Gini d'une liste de valeurs (valeurs négatives ramenées à 0). */
export function gini(values: number[]): number {
  const v = values.map((x) => Math.max(0, x)).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return 0;
  let cum = 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    cum += v[i];
    weighted += (i + 1) * v[i];
  }
  if (cum <= 0) return 0;
  return (2 * weighted) / (n * cum) - (n + 1) / n;
}
