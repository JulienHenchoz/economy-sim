import type { Rng } from './util';

/**
 * Ordre d'achat ou de vente dans une enchère.
 * `owner` est un identifiant opaque pour l'appelant (entreprise ou ménage).
 */
export interface Order {
  owner: number;
  qty: number;
  /** Prix limite en centimes par unité. */
  price: number;
  filled: number;
  /** Donnée libre (ex. : ordre "produits bientôt périmés"). */
  tag?: number;
}

export interface Match {
  bid: Order;
  ask: Order;
  qty: number;
}

export interface AuctionResult {
  /** Prix d'équilibre uniforme (centimes), null si aucun échange. */
  price: number | null;
  volume: number;
  matches: Match[];
  /** Demande et offre totales soumises (pour les graphiques). */
  demand: number;
  supply: number;
}

/**
 * Enchère double à prix uniforme (« call market ») : les ordres d'achat sont triés par prix
 * décroissant, ceux de vente par prix croissant, on apparie tant que l'acheteur offre au moins
 * le prix demandé. Toutes les transactions se font au même prix : le milieu entre la dernière
 * offre et la dernière demande servies. Aucun acheteur ne paie plus que sa limite, aucun
 * vendeur ne reçoit moins que la sienne.
 */
export function callAuction(bids: Order[], asks: Order[], rng: Rng): AuctionResult {
  let demand = 0;
  let supply = 0;
  for (const b of bids) demand += b.qty;
  for (const a of asks) supply += a.qty;
  const res: AuctionResult = { price: null, volume: 0, matches: [], demand, supply };
  if (!bids.length || !asks.length) return res;
  // Mélange avant tri pour départager équitablement les prix identiques.
  rng.shuffle(bids).sort((x, y) => y.price - x.price);
  rng.shuffle(asks).sort((x, y) => x.price - y.price);
  let i = 0;
  let j = 0;
  let remB = bids[0].qty;
  let remA = asks[0].qty;
  let lastB = 0;
  let lastA = 0;
  while (i < bids.length && j < asks.length && bids[i].price >= asks[j].price) {
    const q = Math.min(remB, remA);
    if (q > 1e-9) {
      res.matches.push({ bid: bids[i], ask: asks[j], qty: q });
      res.volume += q;
      lastB = bids[i].price;
      lastA = asks[j].price;
    }
    remB -= q;
    remA -= q;
    if (remB <= 1e-9) {
      i++;
      remB = i < bids.length ? bids[i].qty : 0;
    }
    if (remA <= 1e-9) {
      j++;
      remA = j < asks.length ? asks[j].qty : 0;
    }
  }
  if (res.volume > 0) res.price = (lastB + lastA) / 2;
  return res;
}
