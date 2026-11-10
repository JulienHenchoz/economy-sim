// Types des données échangées avec le cœur Rust (WebAssembly) : mêmes formes JSON que l'ancien
// modèle TypeScript (reference-ts/sim.ts), dont ils sont extraits.
import type { EventKind, FiscalRule, Good, Job } from './config';

export type Status = 'enfant' | 'actif' | 'chomeur' | 'retraite';
export type DeathCause = 'age' | 'faim' | 'maladie';

/** Budget annuel voté (centimes, montants annuels). */
export interface Budget {
  day: number;
  rule: FiscalRule;
  revenue: number; // recettes prévues (moyenne des 12 derniers mois)
  gdp: number; // PIB prévu
  needs: Record<SpendKey, number>; // besoins estimés
  envelopes: Record<SpendKey, number>; // enveloppes votées
  allowedDeficit: number; // déficit permis par la règle
  planned: number; // dépenses votées
  cut: number; // part des besoins financée (1 = tout)
}

export type RevKey = 'tva' | 'impotRevenu' | 'impotSocietes' | 'impotFortune' | 'succession' | 'loyers' | 'cotisationsSante' | 'dividendes' | 'profitsBC' | 'taxeCarbone' | 'ventesPubliques';
export type SpendKey =
  | 'education' | 'administration' | 'securite' | 'santePublique' | 'environnement'
  | 'pensions' | 'aideSociale' | 'allocationsFamiliales' | 'indemnitesMaladie' | 'chomage' | 'revenuUniversel'
  | 'remboursementsSante' | 'subsidesPrimes'
  | 'cantines' | 'investissement' | 'logement' | 'culture' | 'agriculture'
  | 'aideUrgence' | 'interets' | 'redistribution';
export const REV_KEYS: RevKey[] = ['tva', 'impotRevenu', 'impotSocietes', 'impotFortune', 'succession', 'loyers', 'cotisationsSante', 'dividendes', 'profitsBC', 'taxeCarbone', 'ventesPubliques'];

/** Origines de la monnaie créée (net des destructions, centimes). */
export type MoneySource = 'bc' | 'banque' | 'etranger';
export const SPEND_KEYS: SpendKey[] = [
  'education', 'administration', 'securite', 'santePublique', 'environnement',
  'pensions', 'aideSociale', 'allocationsFamiliales', 'indemnitesMaladie', 'chomage', 'revenuUniversel',
  'remboursementsSante', 'subsidesPrimes',
  'cantines', 'investissement', 'logement', 'culture', 'agriculture',
  'aideUrgence', 'interets', 'redistribution',
];

export type FlowNode = 'menages' | 'production' | 'transformation' | 'commerce' | 'sante' | 'assurance' | 'etat';

/** Ligne d'historique (une par jour). Valeurs monétaires en écus. */
export interface DayStats {
  day: number;
  population: number;
  enfants: number;
  actifs: number;
  chomeurs: number;
  retraites: number;
  births: number;
  deaths: Record<DeathCause, number>;
  gdp: number; // ventes au détail TTC du jour
  wholesaleValue: number;
  retailPrice: Partial<Record<Good, number>>;
  wholesalePrice: Partial<Record<Good, number>>;
  retailVolume: Partial<Record<Good, number>>;
  wholesaleVolume: Partial<Record<Good, number>>;
  production: Partial<Record<Good, number>>;
  waste: Partial<Record<Good, number>>;
  unmetDemand: Partial<Record<Good, number>>;
  workersByJob: Record<Job, number>;
  incomeByJob: Record<Job, number>; // revenu moyen par jour (écus), mois précédent
  giniWealth: number;
  giniIncome: number;
  top10Wealth: number;
  bottom50Wealth: number;
  avgHealth: number;
  avgEduAdults: number;
  hungerRate: number; // part des habitants nourris à moins de 90 %
  sickRate: number;
  treasury: number;
  revenue: Record<RevKey, number>;
  spending: Record<SpendKey, number>;
  paidRatio: number;
  moneyHouseholds: number;
  moneyBusinesses: number;
  moneyTotal: number;
  fishStock: number;
  forestStock: number;
  firms: number; // entreprises d'au moins 2 personnes
  independents: number;
  avgFirmSize: number;
  biggestFirm: number;
  employees: number; // salariés du privé
  publicEmployees: number;
  cpi: number; // indice des prix à la consommation (base 100 au jour 1)
  velocity: number; // ventes de détail annualisées / masse monétaire
  /** Revenu du 90e centile / revenu du 10e centile (adultes actifs). */
  p90p10: number;
  /** Santé : actes réalisés, actes refusés faute d'argent, actes non servis faute de médecin (jour). */
  careActs: number;
  careDenied: number;
  careNoDoctor: number;
  /** Malades non soignés aujourd'hui. */
  sickUntreated: number;
  /** Dépense de soins du jour (écus) selon le payeur. */
  careSpend: { menages: number; secu: number; assurance: number };
  /** Honoraires moyens par acte (écus) et prime moyenne par unité de risque et par mois (écus). */
  avgFee: number;
  avgPremium: number;
  /** Part des habitants couverts par une assurance privée. */
  insuredRate: number;
  /** Dette publique (écus), rapportée au PIB des 12 derniers mois ; déficit des 12 derniers mois / PIB. */
  debt: number;
  debtRatio: number;
  deficitRatio: number;
  /** Taux moyen de la dette (annuel, pondéré par le nominal) et taux de la dernière enchère. */
  avgRate: number;
  lastRate: number;
  /** Emprunts levés et remboursés ce jour (écus) : hors impôts et hors dépenses. */
  borrowing: number;
  repayment: number;
  /** Part de la dette détenue par chaque quintile de patrimoine des adultes (0 = plus pauvres), les entreprises, la banque centrale, l'étranger. */
  debtHolders: number[];
  /** Actifs financiers nets par secteur (écus) : monnaie + obligations ; État : trésorerie − dette. */
  nfaHouseholds: number;
  nfaBusinesses: number;
  nfaPublic: number;
  /** Part des besoins de dépenses financée par le budget de l'année (1 = aucune coupe). */
  budgetCut: number;
  /** Monnaie créée (nette) depuis le début, par origine (écus). */
  moneyCreated: Record<MoneySource, number>;
  /** Taux directeur (annuel) et inflation sur 12 mois. */
  policyRate: number;
  inflation: number;
  /** Encours des crédits bancaires (écus), dette détenue par la banque centrale et par l'étranger (écus). */
  bankLoans: number;
  cbDebt: number;
  foreignDebt: number;
  /** Fonds propres de la banque (écus). */
  bankEquity: number;
  /** Énergie produite par source et consommée (unités/jour), émissions du jour, pollution / référence, gisements restants (part). */
  energyBySource: { petrole: number; gaz: number; vert: number };
  energyUse: { machines: number; menages: number };
  emissions: number;
  pollution: number;
  oilLeft: number;
  gasLeft: number;
  /** Services publics : effectif rapporté à la référence (1 = niveau par défaut) ; part des impôts perçue. */
  staffCov: { administration: number; police: number; sante: number; nature: number; ecoles: number };
  taxEff: number;
  /** Équipements publics : infrastructures / référence, logements sociaux, capacité des terres (+ part), blé en silo. */
  infraCov: number;
  socialHousing: number;
  landBonus: number;
  siloStock: number;
  schoolCov: number;
  cultureCov: number;
  /** Vols du jour, habitants qui ont froid, foyers sous le seuil de l'aide sociale (part), âge cumulé des décès, décès avant 1 an. */
  thefts: number;
  coldRate: number;
  poorRate: number;
  deathAges: number;
  infantDeaths: number;
}

export interface Snapshot {
  day: number;
  kpi: Record<string, number>;
  lorenzWealth: [number, number][];
  lorenzIncome: [number, number][];
  wealthHist: { label: string; count: number }[];
  pyramid: { age: string; actifs: number; enfants: number; retraites: number; chomeurs: number }[];
  jobs: { job: Job; label: string; workers: number; avgIncome: number; avgWealth: number; firms: number; independents: number; employees: number; topShare: number }[];
  /** Mobilité : matrice [quintile il y a `mobilityYears` ans][quintile actuel] (nombre d'adultes). */
  mobility: number[][];
  mobilityYears: number;
  news: NewsItem[];
  firmsTable: { id: number; job: string; patron: number; patronName: string; workers: number; cash: number; wage: number; va: number; tools: number; founded: number; shareholders: number }[];
  goods: { good: Good; label: string; retail: number | null; wholesale: number | null; stockBiz: number; stockHouseholds: number; retailVol: number; wholesaleVol: number; waste: number; production: number }[];
  flows: { from: FlowNode; to: FlowNode; value: number }[];
  richest: AgentRow[];
  poorest: AgentRow[];
  stateMonth: { revenue: Record<RevKey, number>; spending: Record<SpendKey, number> };
  budget: Budget | null;
  debtInfo: { tranches: number; total: number; avgRate: number; nextMaturity: number; nextAmount: number; holdersAgents: number; holdersBiz: number };
  causesTotal: Record<DeathCause, number>;
  events: { kind: EventKind; label: string; daysLeft: number }[];
}

export interface NewsItem {
  day: number;
  kind: 'politique' | 'evenement' | 'prix' | 'entreprise' | 'deces' | 'crise' | 'ressource' | 'societe';
  text: string;
}

export interface MapAgent {
  id: number;
  job: number; // indice dans JOBS, -1 si aucun
  status: number; // 0 enfant, 1 actif, 2 chômeur, 3 retraité
  biz: number;
  home: number; // chef de foyer
  rank: number; // rang de patrimoine 0 (plus pauvre) .. 1 (plus riche)
  hunger: number;
  sick: boolean;
  publicJob: boolean;
  boss: boolean;
}

export interface MapState {
  day: number;
  agents: MapAgent[];
  fish: number;
  forest: number;
  production: Partial<Record<Good, number>>;
  shops: number;
  flows: { from: FlowNode; to: FlowNode; value: number }[];
  hungerRate: number;
  events: EventKind[];
}

export interface AgentRow {
  id: number;
  name: string;
  age: number;
  status: Status;
  job: string;
  role: string;
  money: number;
  wealth: number;
  income: number; // revenu journalier moyen du mois précédent
  health: number;
  edu: number;
  insured: boolean;
  bonds: number; // obligations d'État (écus)
}

const FIRST = ['Ana', 'Bastien', 'Chloé', 'Dario', 'Élise', 'Fabien', 'Gaëlle', 'Hugo', 'Inès', 'Jules', 'Katia', 'Léo', 'Maëlle', 'Noé', 'Olga', 'Pablo', 'Quentin', 'Rose', 'Sacha', 'Tilio', 'Ulla', 'Victor', 'Wanda', 'Yann', 'Zoé', 'Aurèle', 'Bérénice', 'Côme', 'Dina', 'Ewan', 'Flore', 'Gaspard', 'Hélène', 'Ilan', 'Jade', 'Kenzo', 'Lou', 'Marius', 'Nina', 'Oscar'];
const LAST = ['Marin', 'Dupré', 'Lebois', 'Fournier', 'Pêcheux', 'Moulin', 'Berger', 'Laforêt', 'Meunier', 'Boucher', 'Rivière', 'Rocher', 'Sablon', 'Vallée', 'Corail', 'Goéland', 'Ponant', 'Levant', 'Brume', 'Salin'];
export function agentName(id: number): string {
  return `${FIRST[(id * 7) % FIRST.length]} ${LAST[(id * 13 + Math.floor(id / FIRST.length)) % LAST.length]}`;
}
