import {
  DEFAULT_INIT, DEFAULT_POLICY, EVENT_DEFS, FOOD_GOODS, GOODS, GOOD_DEFS, JOBS, JOB_DEFS, K,
  MARKET_JOBS, PUBLIC_JOBS, RETAIL_GOODS, RETAIL_MARGIN0,
  type EventKind, type FiscalRule, type Good, type InitConfig, type Job, type JobCategory, type Policy,
} from './config';
import { callAuction, type Order } from './market';
import {
  Rng, clamp, gini, invAdd, invAddBatches, invExpire, invExpiringBy, invQty, invTake,
  type Batch, type Inventory,
} from './util';

export type Status = 'enfant' | 'actif' | 'chomeur' | 'retraite';
export type DeathCause = 'age' | 'faim' | 'maladie';
export const STATE_ID = -1;

export interface Agent {
  id: number;
  alive: boolean;
  born: number; // jour de naissance (peut être négatif)
  parent: number;
  children: number[];
  money: number; // centimes
  edu: number;
  xp: number;
  health: number;
  sick: boolean;
  /** Maladie grave (longue, souvent mortelle sans soins). */
  severe: boolean;
  /** Journées de soin restantes pour guérir. */
  careNeed: number;
  status: Status;
  job: Job | null;
  biz: number; // entreprise où il travaille, -1 sinon
  publicJob: boolean;
  food: Inventory; // stock du foyer (utilisé si chef de foyer)
  fed: number; // part du besoin alimentaire couverte hier
  hunger: number; // moyenne glissante du déficit alimentaire (0..1)
  cold: boolean;
  /** Appétit au-delà du besoin (0..0.3) : on mange plus et mieux quand on est à l'aise. */
  appetite: number;
  income: number; // revenus du mois en cours (centimes)
  lastIncome: number; // revenus du mois précédent
  prefs: Partial<Record<Good, number>>;
  shares: Map<number, number>; // entreprise -> part du capital
  deathDay: number;
  deathCause: DeathCause | null;
  jobSince: number;
  inherited: number; // total hérité (centimes)
  /** Assureur santé du foyer (entreprise), -1 si non assuré. Porté par le chef de foyer. */
  insurer: number;
  /** Dernière visite chez le médecin (jour). */
  lastCare: number;
  /** Fin de l'effet du dernier suivi (jour). */
  careUntil: number;
  /** Quintile de patrimoine (0..4) relevé chaque fin d'année. */
  quintiles: number[];
  /** Obligations d'État détenues (nominal, centimes) : épargne placée, pas de la monnaie. */
  bonds: number;
}

export interface Business {
  id: number;
  alive: boolean;
  job: Job;
  owner: number; // patron = plus gros actionnaire
  shares: Map<number, number>; // agent (ou STATE_ID) -> part
  workers: number[];
  wages: Map<number, number>; // centimes / jour, pour les salariés (pas le patron)
  cash: number;
  inv: Inventory;
  tools: number;
  ask: Partial<Record<Good, number>>; // croyances de prix de vente en gros
  bid: Partial<Record<Good, number>>; // croyances de prix d'achat
  retail: Partial<Record<Good, number>>; // marge appliquée au coût d'achat (commerçants)
  avgCost: Partial<Record<Good, number>>; // coût d'achat moyen du stock (commerçants)
  salesEma: Partial<Record<Good, number>>;
  /** Ventes en gros moyennes par produit (unités/jour), pour planifier la production. */
  outSales: Partial<Record<Good, number>>;
  /** Production moyenne par produit (unités/jour). */
  prodEma: Partial<Record<Good, number>>;
  potential: number; // lots possibles par jour (ou unités vendables pour un commerce)
  revDay: number;
  costDay: number;
  costEma: number;
  revMonth: number;
  inputMonth: number;
  wageMonth: number;
  otherMonth: number;
  vaPerWorker: number; // valeur ajoutée par travailleur et par jour, mois précédent (centimes)
  /** Valeur ajoutée par travailleur et par jour, moyenne glissante (~20 jours). */
  vaEma: number;
  inputDay: number;
  profitLastMonth: number;
  arrears: number;
  offerWage: number;
  vacancies: number;
  founded: number;
  /** Médecin : honoraires par acte (centimes, 0 = à initialiser). */
  fee: number;
  /** Médecin : actes réalisés aujourd'hui, et taux d'occupation lissé. */
  actsDay: number;
  occupancy: number;
  /** Assureur : prime mensuelle pour une unité de risque (adulte de 40 à 59 ans), centimes. */
  premium: number;
  /** Assureur : marge visée au-delà des coûts (sinistres + gestion). */
  markup: number;
  /** Assureur : personnes assurées et unités de risque (pondérées) au dernier relevé. */
  insuredN: number;
  insuredUnits: number;
  /** Assureur : cumuls du mois (centimes) et unités de risque × jours. */
  premiumsMonth: number;
  claimsMonth: number;
  unitDays: number;
  /** Assureur : sinistres par unité de risque et par mois (moyenne glissante, centimes). */
  claimsPerUnit: number;
  /** Assureur : foyers perdus ce mois (impayés, départs). */
  lostMonth: number;
  /** Obligations d'État détenues (nominal, centimes) : trésorerie oisive placée. */
  bonds: number;
}

/**
 * Tranche d'obligations d'État émise lors d'une enchère mensuelle : même taux (coupon annuel versé
 * chaque mois) et même échéance pour tous les détenteurs. Clé du détenteur : id de l'habitant
 * (≥ 0) ou −2 − id de l'entreprise.
 */
export interface Bond {
  id: number;
  issued: number;
  maturity: number;
  rate: number;
  holders: Map<number, number>;
}

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

type RevKey = 'tva' | 'impotRevenu' | 'impotSocietes' | 'impotFortune' | 'succession' | 'loyers' | 'cotisationsSante' | 'dividendes' | 'profitsBC';
type SpendKey = 'salaires' | 'pensions' | 'aideSociale' | 'revenuUniversel' | 'remboursementsSante' | 'subsidesPrimes' | 'achats' | 'aideUrgence' | 'interets' | 'redistribution';
export const REV_KEYS: RevKey[] = ['tva', 'impotRevenu', 'impotSocietes', 'impotFortune', 'succession', 'loyers', 'cotisationsSante', 'dividendes', 'profitsBC'];
/** Détenteurs spéciaux d'obligations : banque centrale et investisseurs étrangers. */
export const CB_KEY = -1;
export const FOREIGN_KEY = -1e9;
/** Origines de la monnaie créée (net des destructions, centimes). */
export type MoneySource = 'bc' | 'banque' | 'etranger';

/** Crédit bancaire à une entreprise (remboursé chaque mois). */
export interface Loan {
  biz: number;
  principal: number;
  rate: number;
  monthsLeft: number;
  missed: number;
}
export const SPEND_KEYS: SpendKey[] = ['salaires', 'pensions', 'aideSociale', 'revenuUniversel', 'remboursementsSante', 'subsidesPrimes', 'achats', 'aideUrgence', 'interets', 'redistribution'];
export type { RevKey, SpendKey };

export type FlowNode = 'menages' | 'production' | 'transformation' | 'commerce' | 'sante' | 'assurance' | 'etat';

/** Classe de risque santé selon l'âge (1 = adulte de 40 à 59 ans) : base des primes modulées. */
export function riskClass(ageY: number): number {
  return ageY < 16 ? 0.5 : ageY < 40 ? 0.6 : ageY < 60 ? 1 : ageY < 75 ? 2.2 : 3.5;
}

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

const D = K.daysPerYear;
const emptyGoods = (): Partial<Record<Good, number>> => ({});
const zeroJobs = (): Record<Job, number> => Object.fromEntries(JOBS.map((j) => [j, 0])) as Record<Job, number>;
const zeroRev = (): Record<RevKey, number> => Object.fromEntries(REV_KEYS.map((k) => [k, 0])) as Record<RevKey, number>;
const zeroSpend = (): Record<SpendKey, number> => Object.fromEntries(SPEND_KEYS.map((k) => [k, 0])) as Record<SpendKey, number>;

export class Simulation {
  day = 0;
  rng: Rng;
  policy: Policy;
  init: InitConfig;
  agents: Agent[] = [];
  businesses: Business[] = [];
  treasury = 0;
  initialMoney = 0;
  fishStock = K.fishK * 0.6;
  forestStock = K.forestK * 0.7;
  events = new Map<EventKind, number>();
  lastW: Record<Good, number>; // dernier prix de gros
  lastR: Record<Good, number>; // dernier prix de détail
  /** Demande des ménages au marché de détail la veille (unités), pour l'approvisionnement des commerces. */
  retailDemand: Record<Good, number> = Object.fromEntries(GOODS.map((g) => [g, 0])) as Record<Good, number>;
  /** Demandes non servies la veille (unités), au détail et en gros : signal pour produire/stocker plus. */
  retailUnmet: Record<Good, number> = Object.fromEntries(GOODS.map((g) => [g, 0])) as Record<Good, number>;
  wholesaleUnmet: Record<Good, number> = Object.fromEntries(GOODS.map((g) => [g, 0])) as Record<Good, number>;
  private lastWDemand: Record<Good, number> = Object.fromEntries(GOODS.map((g) => [g, 0])) as Record<Good, number>;
  /** Capacité totale par produit (unités/jour) et capacité totale des commerces. */
  private capByGood: Record<Good, number> = Object.fromEntries(GOODS.map((g) => [g, 0])) as Record<Good, number>;
  private shopCapTotal = 1;
  cpiBase = 0;
  sectorIncome: Record<Job, number> = zeroJobs(); // centimes / jour
  /** Revenu moyen d'un actif (centimes/jour) : sert de « coût du travail » de référence. */
  avgIncome = 400;
  /** Valeur ajoutée courante par travailleur dans chaque métier (centimes/jour) : ce qu'on espère y gagner. */
  sectorVA: Record<Job, number> = zeroJobs();
  history: DayStats[] = [];
  causesTotal: Record<DeathCause, number> = { age: 0, faim: 0, maladie: 0 };
  flowsMonth = new Map<string, number>();
  flowsPrev = new Map<string, number>();
  stateMonth = { revenue: zeroRev(), spending: zeroSpend() };
  statePrevMonth = { revenue: zeroRev(), spending: zeroSpend() };
  moneyError = 0;
  /** Gazette de l'île : faits marquants, du plus ancien au plus récent (300 au plus). */
  news: NewsItem[] = [];
  /** Plus grande taille d'entreprise déjà atteinte (pour la gazette). */
  private recordFirm = 2;
  /** IPC lissé (base 100), mis à jour chaque mois pour l'indexation. */
  cpiIndex = 100;
  /** Honoraires moyens par acte (centimes), pondérés par les actes réalisés. */
  avgFee = 0;
  /** Actes demandés la veille sans médecin disponible : signal de pénurie pour les honoraires. */
  careShortage = 0;

  // --- budget et dette publique
  /** Obligations en circulation (une tranche par enchère). */
  debt: Bond[] = [];
  /** Total du nominal en circulation (centimes). */
  debtTotal = 0;
  private nextBondId = 1;
  /** Budget de l'année en cours (null avant le premier vote, à la fin du premier mois). */
  budget: Budget | null = null;
  /** Part des besoins financée (coupes au prorata imposées par la règle budgétaire). */
  budgetCut = 1;
  /** Besoins de dépenses du mois (avant coupes), pour estimer le budget suivant. */
  private needMonth: Record<SpendKey, number> = zeroSpend();
  /** Comptes mensuels (centimes) : recettes, dépenses, PIB, besoins ; 48 derniers mois. */
  monthLog: { rev: number; spend: number; gdp: number; ix: number; cut: number; bought: number; needs: Record<SpendKey, number> }[] = [];
  private monthGdp = 0;
  /** Tension sur la dette (0..1) : monte après une enchère ratée ou un défaut, puis retombe. */
  debtStress = 0;
  /** Taux de la dernière enchère (annuel). */
  lastRate = 0;
  /** Record de dette / PIB (pour la gazette). */
  private debtRecord = 0.05;
  /** Aides d'urgence promises et pas encore versées (entreprise, centimes restants, versement par jour). */
  pendingRelief: { biz: number; left: number; daily: number }[] = [];
  /** Achats publics : prix d'achat appris par bien (centimes). */
  private stateBid: Partial<Record<Good, number>> = {};
  private lastDebtHolders = [0, 0, 0, 0, 0, 0, 0, 0];

  // --- monnaie, banques, reste du monde
  /** Masse monétaire attendue : initiale + création nette (sert au contrôle de conservation). */
  moneyBase = 0;
  moneyCreated: Record<MoneySource, number> = { bc: 0, banque: 0, etranger: 0 };
  /** Obligations détenues par la banque centrale et par l'étranger (nominal, centimes). */
  cbBonds = 0;
  foreignBonds = 0;
  /** Taux directeur de la banque centrale (annuel) et inflation sur 12 mois. */
  policyRate = 0.02;
  inflation = 0;
  loans: Loan[] = [];
  bankLoansTotal = 0;
  /** Fonds propres de la banque : intérêts retenus moins pertes sur crédits (centimes). */
  bankEquity = 0;
  private bankIncomeMonth = 0;
  private cpiLog: number[] = [];

  // compteurs journaliers
  private d = this.freshDaily();
  private lastGini = { w: 0, i: 0, top10: 0, bottom50: 0 };
  private lastP9010 = 1;

  private meanMoney = 1;

  constructor(init: Partial<InitConfig> = {}, policy: Partial<Policy> = {}) {
    this.init = { ...DEFAULT_INIT, ...init };
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.rng = new Rng(this.init.seed);
    this.lastW = Object.fromEntries(GOODS.map((g) => [g, GOOD_DEFS[g].wholesale0])) as Record<Good, number>;
    this.lastR = Object.fromEntries(GOODS.map((g) => [g, (GOOD_DEFS[g].wholesale0 + RETAIL_MARGIN0) * (1 + this.policy.vat)])) as Record<Good, number>;
    for (const g of RETAIL_GOODS) this.retailDemand[g] = g === 'bois' ? 100 : g === 'artisanat' ? 150 : 400;
    for (const j of JOBS) this.sectorVA[j] = 400;
    this.populate();
    this.cpiBase = this.cpiRaw();
    this.recordStats();
  }

  private freshDaily() {
    return {
      births: 0,
      selfConsumed: 0,
      deaths: { age: 0, faim: 0, maladie: 0 } as Record<DeathCause, number>,
      gdp: 0,
      wholesaleValue: 0,
      retailVolume: emptyGoods(),
      wholesaleVolume: emptyGoods(),
      production: emptyGoods(),
      waste: emptyGoods(),
      unmet: emptyGoods(),
      revenue: zeroRev(),
      spending: zeroSpend(),
      paidRatio: 1,
      flows: new Map<string, number>(),
      careActs: 0,
      careDenied: 0,
      careNoDoctor: 0,
      sickUntreated: 0,
      careSpend: { menages: 0, secu: 0, assurance: 0 },
      borrowing: 0,
      repayment: 0,
    };
  }

  // =========================================================================
  // Initialisation

  private populate(): void {
    const { population, moneyPerInhabitant, stateShare } = this.init;
    const rng = this.rng;
    const total = population * moneyPerInhabitant * 100;
    this.initialMoney = total;
    this.moneyBase = total;
    this.treasury = Math.round(total * stateShare);
    const perHead = Math.floor((total - this.treasury) / population);
    this.treasury = total - perHead * population; // le reste de la division va à l'État

    // pyramide des âges : plate jusqu'à 65 ans puis décroissante
    const ageW: number[] = [];
    for (let a = 0; a < 95; a++) ageW.push(a < 65 ? 1 : Math.exp(-(a - 65) / 8));
    for (let i = 0; i < population; i++) {
      const ageY = rng.weighted(ageW) + rng.next();
      const a = this.newAgent(-Math.round(ageY * D), -1);
      a.money = perHead;
      if (ageY >= K.adultAge) {
        a.edu = clamp(0.55 + 0.2 * rng.normal(), 0.05, 1);
      } else {
        a.edu = clamp((ageY - K.schoolStart) / 10, 0, 1) * 0.9;
      }
      a.health = clamp(92 - Math.max(0, ageY - 50) * 0.6 + rng.normal() * 4, 30, 100);
      // visites de suivi déjà étalées dans le temps
      a.lastCare = -Math.floor(rng.next() * K.followUpEvery);
      a.careUntil = a.lastCare + K.careDays;
    }
    // familles : chaque enfant reçoit un parent plus âgé de 18 à 45 ans
    const adults = this.agents.filter((a) => this.ageY(a) >= 20 && this.ageY(a) < 60);
    for (const c of this.agents) {
      if (this.ageY(c) >= K.adultAge) continue;
      const cands = adults.filter((p) => {
        const diff = this.ageY(p) - this.ageY(c);
        return diff >= 18 && diff <= 45 && p.children.length < 4;
      });
      if (!cands.length) continue;
      const p = rng.pick(cands);
      c.parent = p.id;
      p.children.push(c.id);
    }
    // nourriture de départ : 2 jours par foyer
    for (const a of this.agents) {
      if (!this.isHead(a)) continue;
      const need = this.householdNeed(a);
      for (const g of FOOD_GOODS) {
        const share = (a.prefs[g] ?? 0) / FOOD_GOODS.reduce((s, x) => s + (a.prefs[x] ?? 0), 0);
        invAdd(a.food, g, (need * 2 * share) / GOOD_DEFS[g].nutrition, GOOD_DEFS[g].shelf);
      }
      invAdd(a.food, 'bois', this.householdSize(a) * K.firewoodPerPerson * 5, GOOD_DEFS.bois.shelf);
    }
    // métiers
    const working = rng.shuffle(this.agents.filter((a) => this.ageY(a) >= K.adultAge && this.ageY(a) < this.policy.retirementAge));
    for (const a of this.agents) {
      const y = this.ageY(a);
      if (y < K.adultAge) a.status = 'enfant';
      else if (y >= this.policy.retirementAge) a.status = 'retraite';
    }
    // métiers qualifiés d'abord (les plus éduqués) : médecins libéraux, enseignants, assureurs
    const byEdu = [...working].sort((x, y) => y.edu - x.edu);
    const mShare = MARKET_JOBS.reduce((s, j) => s + JOB_DEFS[j].share, 0);
    const nTeach = Math.round((this.policy.teachersPer1000 * population) / 1000);
    const nDoc = Math.round((JOB_DEFS.medecin.share / mShare) * (working.length - nTeach));
    const nIns = Math.max(1, Math.round((JOB_DEFS.assureur.share / mShare) * (working.length - nTeach)));
    let k = 0;
    for (let i = 0; i < nDoc && k < byEdu.length; i++, k++) this.startIndependent(byEdu[k], 'medecin', true);
    for (let i = 0; i < nTeach && k < byEdu.length; i++, k++) this.makePublic(byEdu[k], 'enseignant');
    for (let i = 0; i < nIns && k < byEdu.length; i++, k++) this.startIndependent(byEdu[k], 'assureur', true);
    const rest = working.filter((a) => !a.publicJob && a.biz < 0);
    const jobs = MARKET_JOBS.filter((j) => j !== 'medecin' && j !== 'assureur');
    const weights = jobs.map((j) => JOB_DEFS[j].share);
    const wSum = weights.reduce((s, x) => s + x, 0);
    const quotas = jobs.map((_, i) => Math.round((weights[i] / wSum) * rest.length));
    let idx = 0;
    for (let ji = 0; ji < jobs.length; ji++) {
      for (let n = 0; n < quotas[ji] && idx < rest.length; n++) this.startIndependent(rest[idx++], jobs[ji], true);
    }
    while (idx < rest.length) this.startIndependent(rest[idx++], 'cerealier', true);
    for (const j of JOBS) this.sectorIncome[j] = 400;
    this.computeCapacities();
    this.chooseInsurance();
  }

  private newAgent(born: number, parent: number): Agent {
    const prefs: Partial<Record<Good, number>> = {};
    const base: Partial<Record<Good, number>> = { pain: 0.35, poisson_prep: 0.15, viande: 0.12, fromage: 0.08, lait: 0.08, oeufs: 0.1, fruits: 0.12 };
    const p = parent >= 0 ? this.agents[parent].prefs : base;
    for (const g of FOOD_GOODS) prefs[g] = Math.max(0.01, (p[g] ?? 0.1) * Math.exp(0.35 * this.rng.normal()));
    const a: Agent = {
      id: this.agents.length, alive: true, born, parent, children: [], money: 0,
      edu: 0, xp: 0, health: 90, sick: false, severe: false, careNeed: 0, status: 'enfant', job: null, biz: -1, publicJob: false,
      food: new Map(), fed: 1, hunger: 0, cold: false, appetite: 0, income: 0, lastIncome: 0, prefs,
      shares: new Map(), deathDay: -1, deathCause: null, jobSince: 0, inherited: 0, quintiles: [],
      insurer: -1, lastCare: -1e6, careUntil: -1, bonds: 0,
    };
    this.agents.push(a);
    return a;
  }

  private newBusiness(job: Job, owner: Agent): Business {
    const b: Business = {
      id: this.businesses.length, alive: true, job, owner: owner.id, shares: new Map([[owner.id, 1]]),
      workers: [], wages: new Map(), cash: 0, inv: new Map(), tools: 0,
      ask: {}, bid: {}, retail: {}, avgCost: {}, salesEma: {}, outSales: {}, prodEma: {}, potential: 0,
      revDay: 0, costDay: 0, costEma: 0, revMonth: 0, inputMonth: 0, wageMonth: 0, otherMonth: 0,
      vaPerWorker: this.sectorIncome[job] || 400, vaEma: this.sectorVA[job] || 400, inputDay: 0, profitLastMonth: 0, arrears: 0, offerWage: 0, vacancies: 0,
      founded: this.day,
      fee: 0, actsDay: 0, occupancy: 0.8, premium: 0, markup: 0.05, insuredN: 0, insuredUnits: 0,
      premiumsMonth: 0, claimsMonth: 0, unitDays: 0, claimsPerUnit: 0, lostMonth: 0, bonds: 0,
    };
    owner.shares.set(b.id, 1);
    this.businesses.push(b);
    return b;
  }

  // =========================================================================
  // Helpers

  ageY(a: Agent): number {
    return (this.day - a.born) / D;
  }
  isHead(a: Agent): boolean {
    if (!a.alive) return false;
    if (this.ageY(a) >= K.adultAge) return true;
    return a.parent < 0 || !this.agents[a.parent].alive;
  }
  dependents(a: Agent): Agent[] {
    const out: Agent[] = [];
    for (const id of a.children) {
      const c = this.agents[id];
      if (c.alive && this.ageY(c) < K.adultAge) out.push(c);
    }
    return out;
  }
  householdSize(a: Agent): number {
    return 1 + this.dependents(a).length;
  }
  needOf(a: Agent): number {
    return this.ageY(a) < K.adultAge ? K.childNeed : 1;
  }
  householdNeed(a: Agent): number {
    let n = this.needOf(a);
    for (const c of this.dependents(a)) n += this.needOf(c);
    return n;
  }
  productivity(a: Agent): number {
    if (!a.alive || a.sick) return 0;
    return (0.7 + 0.6 * a.edu) * (0.5 + (0.5 * a.health) / 100) * (0.85 + 0.3 * a.xp);
  }
  maxHealth(a: Agent): number {
    return 100 - Math.max(0, this.ageY(a) - 45) * 0.9;
  }
  catOf(b: Business): FlowNode {
    return JOB_DEFS[b.job].cat as Exclude<JobCategory, 'service'>;
  }
  private flow(from: FlowNode, to: FlowNode, cents: number): void {
    if (cents <= 0) return;
    const k = `${from}>${to}`;
    this.flowsMonth.set(k, (this.flowsMonth.get(k) ?? 0) + cents);
    this.d.flows.set(k, (this.d.flows.get(k) ?? 0) + cents);
  }
  say(kind: NewsItem['kind'], text: string): void {
    this.news.push({ day: this.day, kind, text });
    if (this.news.length > 300) this.news.splice(0, this.news.length - 300);
  }
  private payAgent(a: Agent, cents: number, taxable = true): void {
    a.money += cents;
    if (taxable) a.income += cents;
  }
  private askOf(b: Business, g: Good): number {
    return (b.ask[g] ??= this.lastW[g]);
  }
  private bidOf(b: Business, g: Good): number {
    return (b.bid[g] ??= this.lastW[g]);
  }
  /** Revenu de référence ramené à un lot de production (centimes). */
  laborPerBatch(job: Job): number {
    return this.avgIncome / Math.max(0.1, JOB_DEFS[job].batches * 1.3);
  }

  /** Marge du commerçant (multiplicateur du coût d'achat). */
  private markupOf(b: Business, g: Good): number {
    return (b.retail[g] ??= 1.15);
  }
  /** Prix de détail TTC affiché : coût d'achat moyen × marge × (1 + TVA). */
  private retailOf(b: Business, g: Good): number {
    const cost = (b.avgCost[g] ?? this.lastW[g]) + (this.avgIncome / K.shopCapacity) * 0.5;
    return cost * this.markupOf(b, g) * (1 + this.policy.vat);
  }
  bizValue(b: Business): number {
    let v = b.cash + b.bonds + b.tools * this.lastW.outils * 0.7;
    for (const [g, batches] of b.inv) for (const x of batches) v += x.q * this.lastW[g];
    return v;
  }
  private recomputeOwner(b: Business): void {
    let best = -1;
    let bestS = -1;
    for (const [id, s] of b.shares) {
      if (id === STATE_ID) continue;
      if (s > bestS) {
        bestS = s;
        best = id;
      }
    }
    if (best >= 0 && best !== b.owner) {
      b.owner = best;
      b.wages.delete(best);
    } else if (best < 0) b.owner = STATE_ID;
  }
  private eventFactor(job: Job): number {
    let f = 1;
    if (this.events.has('mauvaise_recolte') && (job === 'cerealier' || job === 'arboriculteur' || job === 'eleveur')) f *= 0.5;
    if (this.events.has('tempete') && job === 'pecheur') f = 0;
    return f;
  }

  // =========================================================================
  // Boucle quotidienne

  step(): void {
    this.day++;
    this.d = this.freshDaily();
    for (const b of this.businesses) if (b.alive) { b.revDay = 0; b.costDay = 0; b.inputDay = 0; }
    this.tickEvents();
    this.regrow();
    this.expire();
    this.computeCapacities();
    this.produce();
    this.wholesaleMarket();
    this.retailMarket();
    this.consume();
    this.healthcare();
    this.businessFinance();
    this.statePayments();
    this.schooling();
    this.demography();
    if (this.day % 7 === 0) this.updateSectorVA();
    this.careerReviews();
    this.monthGdp += this.d.gdp;
    if (this.day % K.daysPerMonth === 0) this.monthly();
    this.recordStats();
  }

  triggerEvent(kind: EventKind): void {
    this.events.set(kind, EVENT_DEFS[kind].days);
    this.say('evenement', `${EVENT_DEFS[kind].label} ! ${EVENT_DEFS[kind].desc}.`);
    this.promiseRelief(kind);
    if (kind === 'tempete') for (const b of this.businesses) if (b.alive) b.tools *= 0.7;
    if (kind === 'incendie') this.forestStock *= 0.4;
  }

  private tickEvents(): void {
    for (const [k, v] of this.events) {
      if (v <= 1) this.events.delete(k);
      else this.events.set(k, v - 1);
    }
  }

  private regrow(): void {
    this.fishStock += K.fishR * this.fishStock * (1 - this.fishStock / K.fishK);
    this.forestStock += K.forestR * this.forestStock * (1 - this.forestStock / K.forestK);
    this.fishStock = Math.max(10, this.fishStock);
    this.forestStock = Math.max(10, this.forestStock);
  }

  private expire(): void {
    for (const b of this.businesses) if (b.alive) invExpire(b.inv, this.day, this.d.waste);
    for (const a of this.agents) if (a.alive && a.food.size) invExpire(a.food, this.day, this.d.waste);
  }

  /** Capacité de production (lots/jour) ou de vente (unités/jour) de chaque entreprise. */
  private computeCapacities(): void {
    const n: Record<Job, number> = zeroJobs();
    const raw: Business[] = [];
    for (const b of this.businesses) {
      if (!b.alive) continue;
      n[b.job] += b.workers.length;
    }
    let fishDemand = 0;
    let woodDemand = 0;
    for (const b of this.businesses) {
      if (!b.alive) continue;
      const def = JOB_DEFS[b.job];
      const nw = b.workers.length;
      if (!nw) {
        b.potential = 0;
        continue;
      }
      let L = 0;
      for (const id of b.workers) L += this.productivity(this.agents[id]);
      const toolF = 1 + K.toolBonus * Math.min(1, b.tools / nw);
      const scaleF = 1 + Math.min(K.scaleBonusMax, K.scaleBonusPerWorker * (nw - 1));
      if (def.cat === 'commerce') {
        b.potential = K.shopCapacity * L * (0.6 + 0.4 * Math.min(1, b.tools / nw)) * scaleF;
        continue;
      }
      // médecin : actes par jour ; un cabinet équipé (outils) soigne plus vite
      if (def.cat === 'sante') {
        b.potential = K.actsPerDoctor * L * (0.75 + 0.25 * Math.min(1, b.tools / nw));
        continue;
      }
      // assureur : nombre de personnes qu'il peut assurer
      if (def.cat === 'assurance') {
        b.potential = K.contractsPerInsurer * L * scaleF;
        continue;
      }
      let nat = this.eventFactor(b.job);
      if (def.natural?.kind === 'land') nat *= n[b.job] <= def.natural.cap ? 1 : Math.sqrt(def.natural.cap / n[b.job]);
      b.potential = L * toolF * scaleF * nat * def.batches;
      if (def.natural?.kind === 'fish') { b.potential *= Math.pow(Math.min(1, this.fishStock / (0.5 * K.fishK)), 0.7); fishDemand += b.potential; raw.push(b); }
      if (def.natural?.kind === 'forest') { b.potential *= Math.pow(Math.min(1, this.forestStock / (0.5 * K.forestK)), 0.7); woodDemand += b.potential; raw.push(b); }
    }
    // stock naturel et quotas : on ne peut pas prélever plus que ce qui existe ou que le quota
    const fishMax = Math.min(this.fishStock * 0.5, this.policy.fishingQuota > 0 ? this.policy.fishingQuota : Infinity);
    const woodMax = Math.min(this.forestStock * 0.5, this.policy.loggingQuota > 0 ? this.policy.loggingQuota : Infinity);
    const fishF = fishDemand > fishMax ? fishMax / fishDemand : 1;
    const woodF = woodDemand > woodMax ? woodMax / woodDemand : 1;
    for (const b of raw) b.potential *= b.job === 'pecheur' ? fishF : woodF;
    for (const g of GOODS) this.capByGood[g] = 0;
    this.shopCapTotal = 0;
    for (const b of this.businesses) {
      if (!b.alive || b.potential <= 0) continue;
      const def = JOB_DEFS[b.job];
      if (def.cat === 'commerce') this.shopCapTotal += b.potential;
      for (const [g, q] of Object.entries(def.outputs) as [Good, number][]) this.capByGood[g] += b.potential * q;
    }
    this.shopCapTotal = Math.max(1, this.shopCapTotal);
  }

  private produce(): void {
    for (const b of this.businesses) {
      if (!b.alive || b.potential <= 0) continue;
      const def = JOB_DEFS[b.job];
      if (def.cat !== 'production' && def.cat !== 'transformation') continue;
      let batches = b.potential;
      for (const [g, q] of Object.entries(def.inputs) as [Good, number][]) batches = Math.min(batches, invQty(b.inv, g) / q);
      if (def.cat === 'transformation') batches = Math.min(batches, this.plannedBatches(b));
      for (const [g, q] of Object.entries(def.outputs) as [Good, number][]) b.prodEma[g] = (b.prodEma[g] ?? batches * q) * 0.85 + Math.max(0, batches) * q * 0.15;
      if (batches <= 1e-6) continue;
      for (const [g, q] of Object.entries(def.inputs) as [Good, number][]) invTake(b.inv, g, batches * q);
      for (const [g, q] of Object.entries(def.outputs) as [Good, number][]) {
        const out = batches * q;
        invAdd(b.inv, g, out, this.day + GOOD_DEFS[g].shelf);
        this.d.production[g] = (this.d.production[g] ?? 0) + out;
        if (g === 'poisson') this.fishStock = Math.max(10, this.fishStock - out);
        if (g === 'bois') this.forestStock = Math.max(10, this.forestStock - out);
      }
      for (const id of b.workers) {
        const a = this.agents[id];
        if (!a.sick) a.xp = Math.min(1, a.xp + 1 / 180);
      }
    }
  }

  /**
   * Un transformateur ne produit que ce qu'il pense vendre : stock cible = quelques jours de ventes
   * récentes (moins pour les produits périssables), plus une marge pour tester la demande.
   */
  private plannedBatches(b: Business): number {
    const def = JOB_DEFS[b.job];
    let plan = Infinity;
    for (const [g, q] of Object.entries(def.outputs) as [Good, number][]) {
      // ventes récentes + part de la demande restée non servie hier (au prorata de la capacité)
      const unmet = Math.max(0, this.wholesaleUnmet[g]) * ((b.potential * q) / Math.max(1e-6, this.capByGood[g]));
      const sales = (b.outSales[g] ?? b.potential * q) + unmet;
      const days = GOOD_DEFS[g].shelf <= 4 ? 1.5 : 5;
      const target = sales * days + b.potential * q * 0.25;
      plan = Math.min(plan, Math.max(0, target - invQty(b.inv, g)) / q);
    }
    return Math.min(b.potential, plan);
  }

  // ------------------------------------------------------------------ marché de gros

  private wholesaleMarket(): void {
    const rng = this.rng;
    const bids = new Map<Good, Order[]>();
    const asks = new Map<Good, Order[]>();
    for (const g of GOODS) { bids.set(g, []); asks.set(g, []); }
    const offered = new Map<number, Partial<Record<Good, number>>>();
    const wanted = new Map<number, Partial<Record<Good, number>>>();
    const vat = this.policy.vat;

    for (const b of this.businesses) {
      if (!b.alive) continue;
      const def = JOB_DEFS[b.job];
      const nw = b.workers.length;
      // charpentier : se sert d'abord dans sa production pour s'équiper
      if (b.job === 'charpentier' && b.tools < nw) {
        const take = Math.min(nw - b.tools, invQty(b.inv, 'outils'));
        if (take > 0) { invTake(b.inv, 'outils', take); b.tools += take; }
      }
      // --- offres de vente : tout ce qui n'est pas un intrant (ni un bien de détail pour un commerçant)
      const off: Partial<Record<Good, number>> = {};
      for (const [g] of b.inv) {
        if (def.inputs[g] !== undefined) continue;
        if (def.cat === 'commerce' && GOOD_DEFS[g].retail) continue;
        const qty = invQty(b.inv, g);
        if (qty <= 1e-6) continue;
        const exp = invExpiringBy(b.inv, g, this.day + 1);
        // un transformateur ne vend pas (hors invendus périssables) sous le coût de ses intrants
        if (def.outputs[g] !== undefined && def.cat === 'transformation') {
          let unitCost = this.laborPerBatch(b.job) * 0.7;
          for (const [ig, iq] of Object.entries(def.inputs) as [Good, number][]) unitCost += iq * this.lastW[ig];
          const floor = unitCost / def.outputs[g]! / Object.keys(def.outputs).length;
          if (this.askOf(b, g) < floor) b.ask[g] = floor;
        }
        // producteur : prix de réserve = 30 % de la valeur de son travail ; en dessous il préfère garder
        if (def.outputs[g] !== undefined && def.cat === 'production') {
          const floor = (this.laborPerBatch(b.job) * 0.3) / def.outputs[g]! / Object.keys(def.outputs).length;
          if (this.askOf(b, g) < floor) b.ask[g] = floor;
        }
        const p = this.askOf(b, g);
        if (exp > 1e-6) asks.get(g)!.push({ owner: b.id, qty: exp, price: Math.max(1, p * 0.6), filled: 0, tag: 1 });
        if (qty - exp > 1e-6) asks.get(g)!.push({ owner: b.id, qty: qty - exp, price: Math.max(1, p * rng.range(0.97, 1.03)), filled: 0 });
        off[g] = qty;
      }
      offered.set(b.id, off);
      if (!nw) continue;
      // --- demandes d'achat
      const want: { g: Good; q: number; p: number }[] = [];
      if (def.cat === 'transformation') {
        // on ne paie jamais un intrant plus cher que ce que rapporte le lot produit ; si l'intrant
        // se raréfie, son prix monte et le prix plancher du produit fini suit (coût répercuté)
        let outValue = 0;
        for (const [g, q] of Object.entries(def.outputs) as [Good, number][]) outValue += q * Math.max(this.lastW[g], this.askOf(b, g));
        outValue = Math.max(outValue * 0.3, outValue * 0.95 - this.laborPerBatch(b.job) * 0.5);
        const inputs = Object.entries(def.inputs) as [Good, number][];
        const plan = Math.min(b.potential, this.plannedBatches(b) * 0.5 + Math.max(...(Object.entries(def.outputs) as [Good, number][]).map(([g, q]) => ((b.outSales[g] ?? b.potential * q) + Math.max(0, this.wholesaleUnmet[g]) * ((b.potential * q) / Math.max(1e-6, this.capByGood[g]))) / q)) * 1.15 + b.potential * 0.15);
        for (const [g, q] of inputs) {
          const target = plan * q * (GOOD_DEFS[g].shelf <= 4 ? 1.5 : 3);
          const need = target - invQty(b.inv, g);
          if (need <= 0.01) continue;
          const maxP = outValue / (q * inputs.length);
          want.push({ g, q: need, p: Math.min(this.bidOf(b, g), maxP) * rng.range(0.98, 1.02) });
        }
      } else if (def.cat === 'commerce') {
        const w = this.retailWeights(b);
        let tot = 0;
        const tgt: Partial<Record<Good, number>> = {};
        for (const g of RETAIL_GOODS) {
          // ventes récentes + 15 % de la capacité pour tester la demande, dans la limite de la capacité
          const days = GOOD_DEFS[g].shelf <= 4 ? 1.3 : 3;
          const unmet = this.retailUnmet[g] * (b.potential / this.shopCapTotal);
          tgt[g] = ((b.salesEma[g] ?? 0) * 1.2 + unmet + 0.1 * b.potential * w[g]!) * days;
          tot += tgt[g]! / days;
        }
        const capF = tot > b.potential ? b.potential / tot : 1;
        for (const g of RETAIL_GOODS) {
          const need = tgt[g]! * capF - invQty(b.inv, g);
          if (need <= 0.01) continue;
          const maxP = (this.lastR[g] / (1 + vat)) * 0.95;
          want.push({ g, q: need, p: Math.min(this.bidOf(b, g), maxP) * rng.range(0.98, 1.02) });
        }
      }
      if (b.tools < nw * 0.95 && b.job !== 'charpentier' && def.cat !== 'assurance') {
        const gainPerDay = K.toolBonus * Math.max(50, b.vaPerWorker);
        const maxP = gainPerDay * 50;
        want.push({ g: 'outils', q: Math.min(2, nw - b.tools), p: Math.min(this.bidOf(b, 'outils'), maxP) * rng.range(0.98, 1.02) });
      }
      // budget : 90 % de la trésorerie
      const budget = b.cash * 0.9;
      let cost = 0;
      for (const x of want) cost += x.q * x.p;
      const scale = cost > budget ? budget / cost : 1;
      const wmap: Partial<Record<Good, number>> = {};
      for (const x of want) {
        const q = x.q * scale;
        if (q <= 1e-4 || x.p < 1) continue;
        bids.get(x.g)!.push({ owner: b.id, qty: q, price: x.p, filled: 0 });
        wmap[x.g] = q;
      }
      wanted.set(b.id, wmap);
    }
    // achats publics : l'État passe ses ordres comme un acheteur ordinaire, dans la limite de son budget
    const stateWant = this.publicPurchaseOrders();
    for (const x of stateWant) bids.get(x.g)!.push({ owner: STATE_ID, qty: x.q, price: x.p, filled: 0 });
    const stateGot = new Map<Good, Batch[]>();

    const sold = new Map<number, Partial<Record<Good, number>>>();
    const bought = new Map<number, Partial<Record<Good, number>>>();
    for (const g of GOODS) {
      const res = callAuction(bids.get(g)!, asks.get(g)!, rng);
      this.wholesaleUnmet[g] = res.demand - res.volume;
      this.lastWDemand[g] = res.demand;
      if (res.price === null) continue;
      const p = res.price;
      let vol = 0;
      for (const m of res.matches) {
        if (m.bid.owner === STATE_ID) {
          const seller = this.businesses[m.ask.owner];
          let q = m.qty;
          let cost = Math.round(p * q);
          const cash = Math.max(0, this.treasury);
          if (cost > cash) {
            q = cash / p;
            cost = Math.min(cash, Math.round(p * q));
          }
          if (q <= 1e-6 || cost <= 0) continue;
          const got = invTake(seller.inv, g, q);
          const arr = stateGot.get(g) ?? [];
          arr.push(...got);
          stateGot.set(g, arr);
          this.stateOut('achats', cost);
          seller.cash += cost;
          seller.revDay += cost;
          seller.revMonth += cost;
          this.flow('etat', this.catOf(seller), cost);
          const s = sold.get(seller.id) ?? {};
          s[g] = (s[g] ?? 0) + q;
          sold.set(seller.id, s);
          vol += q;
          this.d.wholesaleValue += cost;
          continue;
        }
        const buyer = this.businesses[m.bid.owner];
        const seller = this.businesses[m.ask.owner];
        let q = m.qty;
        let cost = Math.round(p * q);
        if (cost > buyer.cash) {
          q = buyer.cash / p;
          cost = Math.min(buyer.cash, Math.round(p * q));
        }
        if (q <= 1e-6 || cost <= 0) continue;
        const got = invTake(seller.inv, g, q);
        if (g === 'outils') buyer.tools += q;
        else {
          if (JOB_DEFS[buyer.job].cat === 'commerce') {
            const before = invQty(buyer.inv, g);
            buyer.avgCost[g] = ((buyer.avgCost[g] ?? p) * before + p * q) / (before + q);
          }
          invAddBatches(buyer.inv, g, got);
        }
        buyer.cash -= cost;
        seller.cash += cost;
        seller.revDay += cost;
        seller.revMonth += cost;
        buyer.costDay += cost;
        if (g === 'outils') buyer.otherMonth += cost;
        else {
          buyer.inputMonth += cost;
          buyer.inputDay += cost;
        }
        this.flow(this.catOf(buyer), this.catOf(seller), cost);
        const s = sold.get(seller.id) ?? {};
        s[g] = (s[g] ?? 0) + q;
        sold.set(seller.id, s);
        const bb = bought.get(buyer.id) ?? {};
        bb[g] = (bb[g] ?? 0) + q;
        bought.set(buyer.id, bb);
        vol += q;
        this.d.wholesaleValue += cost;
      }
      if (vol > 0) {
        this.lastW[g] = p;
        this.d.wholesaleVolume[g] = vol;
      }
    }
    // apprentissage des prix
    for (const [id, off] of offered) {
      const b = this.businesses[id];
      for (const [g, q] of Object.entries(off) as [Good, number][]) {
        const s = sold.get(id)?.[g] ?? 0;
        const flow = Math.max(1e-3, b.prodEma[g] ?? 0);
        let np = this.adaptAsk(this.askOf(b, g), s / q, (q - s) / flow, GOOD_DEFS[g].shelf <= 4 ? 0.5 : 4, this.lastW[g]);
        // rupture avec des acheteurs restés sur leur faim : hausse plus franche
        if (s / q >= 0.98 && this.wholesaleUnmet[g] > 0.05 * Math.max(1, this.lastWDemand[g])) np *= 1 + rng.range(0.02, 0.06);
        b.ask[g] = np;
      }
      for (const g of Object.keys(JOB_DEFS[b.job].outputs) as Good[]) {
        const s = sold.get(id)?.[g] ?? 0;
        b.outSales[g] = (b.outSales[g] ?? s) * 0.8 + s * 0.2;
      }
    }
    for (const [id, w] of wanted) {
      const b = this.businesses[id];
      for (const [g, q] of Object.entries(w) as [Good, number][]) {
        const got = bought.get(id)?.[g] ?? 0;
        b.bid[g] = this.adaptBid(this.bidOf(b, g), got / q, this.lastW[g]);
      }
    }
    this.deliverPublicPurchases(stateWant, stateGot);
  }

  /**
   * Besoins d'achats publics du jour : pain et fruits pour les cantines (`schoolMeals` unités de
   * nutrition par enfant), bois pour chauffer l'école, outils pour l'entretien. Le budget voté n'en
   * finance qu'une part ; les quantités sont réduites d'autant.
   */
  private publicPurchaseOrders(): { g: Good; q: number; p: number }[] {
    const p = this.policy;
    let kids = 0;
    let pop = 0;
    for (const a of this.agents) {
      if (!a.alive) continue;
      pop++;
      if (this.ageY(a) < K.adultAge) kids++;
    }
    const pupils = Math.min(kids, this.agents.reduce((s, a) => s + (a.alive && a.publicJob ? 1 : 0), 0) * K.pupilsPerTeacher);
    const meals = kids * p.schoolMeals;
    const want: { g: Good; q: number }[] = [
      { g: 'pain', q: (meals * 0.6) / GOOD_DEFS.pain.nutrition },
      { g: 'fruits', q: (meals * 0.4) / GOOD_DEFS.fruits.nutrition },
      { g: 'bois', q: pupils * 0.04 },
      { g: 'outils', q: pop * 0.0005 },
    ];
    const out: { g: Good; q: number; p: number }[] = [];
    let need = 0;
    for (const x of want) {
      if (x.q <= 0.01) continue;
      // l'État suit le marché (au plus 10 % au-dessus du dernier prix) et ne prend pas plus de 15 %
      // de la capacité de production du bien : il ne doit pas affamer les commerces
      const price = Math.min((this.stateBid[x.g] ??= this.lastW[x.g]), this.lastW[x.g] * 1.1);
      this.stateBid[x.g] = price;
      const q = Math.min(x.q, 0.15 * this.capByGood[x.g]);
      need += x.q * price;
      if (q > 0.01) out.push({ g: x.g, q, p: price });
    }
    this.needMonth.achats += need;
    // part financée, et jamais plus que la moitié de la caisse du jour
    const sc = Math.min(this.budgetCut, need > 0 ? Math.max(0, this.treasury) * 0.5 / need : 0);
    for (const x of out) x.q *= sc;
    return out.filter((x) => x.q > 1e-3);
  }

  /** Livraison : repas des cantines dans le garde-manger des foyers avec enfants ; bois et outils consommés. */
  private deliverPublicPurchases(want: { g: Good; q: number; p: number }[], got: Map<Good, Batch[]>): void {
    for (const x of want) {
      let q = 0;
      for (const b of got.get(x.g) ?? []) q += b.q;
      // prix appris : servi → on baisse doucement, pas servi → on monte vers le marché
      this.stateBid[x.g] = this.adaptBid(x.p, q / x.q, this.lastW[x.g]);
    }
    const food = FOOD_GOODS.filter((g) => got.has(g));
    if (!food.length) return;
    const homes: { h: Agent; kids: number }[] = [];
    let kids = 0;
    for (const a of this.agents) {
      if (!this.isHead(a)) continue;
      const n = a.status === 'enfant' ? 1 + this.dependents(a).length : this.dependents(a).length;
      if (n > 0) {
        homes.push({ h: a, kids: n });
        kids += n;
      }
    }
    if (!kids) return;
    for (const g of food) {
      for (const batch of got.get(g)!) {
        for (const { h, kids: n } of homes) invAdd(h.food, g, (batch.q * n) / kids, batch.exp);
      }
    }
  }

  /**
   * Ajustement du prix demandé : tout vendu → on monte ; stock restant supérieur à la cible
   * (exprimée en jours de production) → on baisse, d'autant plus que l'excès est grand.
   */
  private adaptAsk(p: number, fill: number, stockDays: number, targetDays: number, market: number): number {
    const r = this.rng;
    if (fill >= 0.98) p = Math.max(p * (1 + r.range(0.01, 0.04)), (p + market) / 2);
    else if (stockDays > targetDays * 1.2) p *= 1 - r.range(0.01, 0.04) * Math.min(1, (stockDays - targetDays) / (targetDays + 1));
    else if (stockDays < targetDays * 0.8) p *= 1 + r.range(0, 0.02);
    return clamp(p, 1, 1e6);
  }
  private adaptBid(p: number, fill: number, market: number): number {
    const r = this.rng;
    if (fill < 0.9) p = Math.max(p * (1 + r.range(0.03, 0.08) * (1 - fill)), Math.min(market, p * 1.15));
    else p *= 1 - r.range(0, 0.02);
    return clamp(p, 1, 1e6);
  }

  /**
   * Répartition de la capacité de vente d'un commerce entre les produits : moitié selon ses
   * propres ventes, moitié selon la demande totale observée la veille (les files d'attente).
   */
  private retailWeights(b: Business): Partial<Record<Good, number>> {
    const w: Partial<Record<Good, number>> = {};
    let s = 0;
    let sales = 0;
    let dem = 0;
    for (const g of RETAIL_GOODS) {
      sales += b.salesEma[g] ?? 0;
      dem += this.retailDemand[g];
    }
    for (const g of RETAIL_GOODS) {
      const own = sales > 0 ? (b.salesEma[g] ?? 0) / sales : 1 / RETAIL_GOODS.length;
      const mkt = dem > 0 ? this.retailDemand[g] / dem : 1 / RETAIL_GOODS.length;
      w[g] = 0.4 * own + 0.6 * mkt + 0.01;
      s += w[g]!;
    }
    for (const g of RETAIL_GOODS) w[g]! /= s;
    return w;
  }

  // ------------------------------------------------------------------ marché de détail

  private retailMarket(): void {
    const rng = this.rng;
    const vat = this.policy.vat;
    const bids = new Map<Good, Order[]>();
    const asks = new Map<Good, Order[]>();
    for (const g of RETAIL_GOODS) { bids.set(g, []); asks.set(g, []); }
    const offered = new Map<number, Partial<Record<Good, number>>>();

    for (const b of this.businesses) {
      if (!b.alive || JOB_DEFS[b.job].cat !== 'commerce' || !b.workers.length) continue;
      const w = this.retailWeights(b);
      const off: Partial<Record<Good, number>> = {};
      let tot = 0;
      for (const g of RETAIL_GOODS) {
        off[g] = Math.min(invQty(b.inv, g), b.potential * w[g]! * 1.6);
        tot += off[g]!;
      }
      const sc = tot > b.potential ? b.potential / tot : 1;
      for (const g of RETAIL_GOODS) {
        const q = off[g]! * sc;
        if (q <= 1e-6) { delete off[g]; continue; }
        off[g] = q;
        const exp = Math.min(q, invExpiringBy(b.inv, g, this.day));
        const p = this.retailOf(b, g);
        if (exp > 1e-6) asks.get(g)!.push({ owner: b.id, qty: exp, price: Math.max(1, p * 0.6), filled: 0, tag: 1 });
        if (q - exp > 1e-6) asks.get(g)!.push({ owner: b.id, qty: q - exp, price: Math.max(1, p * rng.range(0.97, 1.03)), filled: 0 });
      }
      offered.set(b.id, off);
    }

    // ménages
    let totMoney = 0;
    let nAd = 0;
    for (const a of this.agents) if (a.alive && a.status !== 'enfant') { totMoney += a.money; nAd++; }
    this.meanMoney = Math.max(100, totMoney / Math.max(1, nAd));
    for (const a of this.agents) {
      if (!this.isHead(a)) continue;
      const need = this.householdNeed(a);
      this.selfConsume(a, need);
      let stockNut = 0;
      for (const g of FOOD_GOODS) stockNut += invQty(a.food, g) * GOOD_DEFS[g].nutrition;
      // loi d'Engel simplifiée : à l'aise, on achète jusqu'à 30 % de plus que le strict besoin
      const affluence = clamp(a.money / Math.max(1, need * this.costPerNutrition() * 60) - 1, 0, 1);
      a.appetite = 0.3 * affluence;
      const want = Math.max(0, need * (1 + a.appetite) * K.foodBufferDays - stockNut);
      const u = a.hunger;
      const wf = 1 + 0.12 * Math.log10(1 + a.money / this.meanMoney);
      const dayInMonth = (this.day % K.daysPerMonth) || K.daysPerMonth;
      const dailyIncome = Math.max(a.lastIncome / K.daysPerMonth, a.income / dayInMonth);
      const orders: { g: Good; q: number; p: number }[] = [];
      if (want > 0.01) {
        let sScore = 0;
        const score: Partial<Record<Good, number>> = {};
        for (const g of FOOD_GOODS) {
          score[g] = (a.prefs[g] ?? 0.1) * Math.pow(GOOD_DEFS[g].nutrition / Math.max(1, this.lastR[g]), 1.5);
          sScore += score[g]!;
        }
        for (const g of FOOD_GOODS) {
          const q = (want * score[g]!) / sScore / GOOD_DEFS[g].nutrition;
          if (q < 0.01) continue;
          // surenchère modeste (même affamé) : sinon les enchères se composent jour après jour
          orders.push({ g, q, p: Math.max(1, this.lastR[g] * (1.03 + 0.12 * u) * wf * rng.range(0.97, 1.04)) });
        }
      }
      let cost = 0;
      for (const o of orders) cost += o.q * o.p;
      // la nourriture passe avant tout : jusqu'au quart de l'épargne par jour (90 % si affamé)
      const budget = a.money * (0.25 + 0.65 * Math.min(1, u * 3));
      const sc = cost > budget ? budget / Math.max(1, cost) : 1;
      let spent = 0;
      for (const o of orders) {
        const q = o.q * sc;
        if (q < 0.005) continue;
        bids.get(o.g)!.push({ owner: a.id, qty: q, price: o.p, filled: 0 });
        spent += q * o.p;
      }
      // confort (artisanat) : une part du revenu et de l'épargne au-delà d'un matelas de précaution
      const foodCostDay = need * this.costPerNutrition();
      const free = a.money * 0.95 - spent;
      const disc = Math.min(free, Math.max(0, 0.1 * dailyIncome + (a.money - foodCostDay * K.savingsBufferDays) / 120));
      if (disc > 1 && a.hunger < 0.1) {
        const p = this.lastR.artisanat * rng.range(0.97, 1.08);
        const q = disc / p;
        if (q > 0.005) {
          bids.get('artisanat')!.push({ owner: a.id, qty: q, price: p, filled: 0 });
          spent += q * p;
        }
      }
      // bois de chauffage, après la nourriture
      const wood = this.householdSize(a) * K.firewoodPerPerson * 4 - invQty(a.food, 'bois');
      if (wood > 0.05) {
        const p = this.lastR.bois * (a.cold ? 1.04 : 1.01) * rng.range(0.97, 1.03);
        // le chauffage ne prend pas plus de 10 % du budget : trop cher, on accepte d'avoir froid
        const woodBudget = Math.min(Math.max(0, a.money * 0.95 - spent), 0.1 * (dailyIncome + a.money / 30) * 4);
        const q = Math.min(wood, woodBudget / p);
        if (q > 0.01) bids.get('bois')!.push({ owner: a.id, qty: q, price: p, filled: 0 });
      }
    }

    const sold = new Map<number, Partial<Record<Good, number>>>();
    for (const g of RETAIL_GOODS) {
      const bl = bids.get(g)!;
      const res = callAuction(bl, asks.get(g)!, rng);
      const prevR = this.lastR[g];
      let filledQ = 0;
      if (res.price !== null) {
        const p = res.price;
        let vol = 0;
        for (const m of res.matches) {
          const a = this.agents[m.bid.owner];
          const shop = this.businesses[m.ask.owner];
          let q = m.qty;
          let cost = Math.round(p * q);
          if (cost > a.money) {
            q = a.money / p;
            cost = Math.min(a.money, Math.round(p * q));
          }
          if (q <= 1e-6 || cost <= 0) continue;
          invAddBatches(a.food, g, invTake(shop.inv, g, q));
          const tax = Math.round((cost * vat) / (1 + vat));
          a.money -= cost;
          shop.cash += cost - tax;
          shop.revDay += cost - tax;
          shop.revMonth += cost - tax;
          this.collect('tva', tax);
          this.flow('menages', 'commerce', cost);
          this.flow('commerce', 'etat', tax);
          const s = sold.get(shop.id) ?? {};
          s[g] = (s[g] ?? 0) + q;
          sold.set(shop.id, s);
          vol += q;
          this.d.gdp += cost;
        }
        filledQ = vol;
        if (vol > 0) {
          this.lastR[g] = p;
          this.d.retailVolume[g] = vol;
        }
      }
      this.d.unmet[g] = Math.max(0, res.demand - filledQ);
      // file d'attente devant des rayons vides : le prix de référence monte. Sinon, figé faute de
      // ventes (ou fixé par quelques invendus bradés), il plafonne les achats en gros des commerçants,
      // la filière ne peut plus suivre ses coûts et s'éteint alors que les ménages ont de quoi payer
      const short = res.demand > 0 ? this.d.unmet[g]! / res.demand : 0;
      if (short > 0.5) this.lastR[g] = Math.max(this.lastR[g], prevR);
      this.retailDemand[g] = res.demand;
      this.retailUnmet[g] = this.d.unmet[g]!;
    }
    for (const [id, off] of offered) {
      const b = this.businesses[id];
      for (const g of RETAIL_GOODS) {
        const s = sold.get(id)?.[g] ?? 0;
        b.salesEma[g] = (b.salesEma[g] ?? s) * 0.85 + s * 0.15;
        const q = off[g];
        if (!q) continue;
        // marge : monte si tout part et que le rayon est vide, baisse s'il reste des invendus
        const f = s / q;
        let m = this.markupOf(b, g);
        const stockDays = invQty(b.inv, g) / Math.max(0.5, b.salesEma[g] ?? 0);
        const target = GOOD_DEFS[g].shelf <= 4 ? 0.5 : 3;
        const shortage = this.retailUnmet[g] > 0.05 * Math.max(1, this.retailDemand[g]);
        // concurrence : sans pénurie, la marge revient doucement vers une marge « normale » de 10 %
        m -= 0.01 * (m - 1.1);
        if (f >= 0.98 && shortage) m *= 1 + rng.range(0.005, 0.03);
        else if (stockDays > target) m *= 1 - rng.range(0.01, 0.04) * Math.min(1, (stockDays - target) / (target + 1));
        b.retail[g] = clamp(m, 1.0, 1.6);
      }
    }
  }

  /**
   * Autoconsommation : un indépendant qui produit de la nourriture en prélève pour son foyer
   * (un jour de besoin au plus), sans passer par le marché. Amortit les famines chez les producteurs.
   */
  private selfConsume(a: Agent, need: number): void {
    if (a.biz < 0) return;
    const b = this.businesses[a.biz];
    if (b.owner !== a.id || b.workers.length !== 1 || JOB_DEFS[b.job].cat === 'commerce') return;
    let have = 0;
    for (const g of FOOD_GOODS) have += invQty(a.food, g) * GOOD_DEFS[g].nutrition;
    let missing = need - have;
    for (const g of FOOD_GOODS) {
      if (missing <= 0) break;
      const avail = invQty(b.inv, g);
      if (avail <= 0) continue;
      const q = Math.min(avail, missing / GOOD_DEFS[g].nutrition);
      invAddBatches(a.food, g, invTake(b.inv, g, q));
      missing -= q * GOOD_DEFS[g].nutrition;
      this.d.selfConsumed += q * GOOD_DEFS[g].nutrition;
    }
  }

  /** Coût moyen d'une unité de nutrition au détail (centimes), panier type. */
  costPerNutrition(): number {
    let best = Infinity;
    let avg = 0;
    let n = 0;
    for (const g of FOOD_GOODS) {
      const c = this.lastR[g] / GOOD_DEFS[g].nutrition;
      best = Math.min(best, c);
      avg += c;
      n++;
    }
    return (best + avg / n) / 2;
  }

  // ------------------------------------------------------------------ consommation

  private consume(): void {
    for (const a of this.agents) {
      if (!this.isHead(a)) continue;
      const members = [a, ...this.dependents(a)];
      const need = members.reduce((s, m) => s + this.needOf(m), 0);
      const eat = need * (1 + a.appetite);
      let got = 0;
      // manger d'abord ce qui périme le plus vite
      const order = FOOD_GOODS.filter((g) => invQty(a.food, g) > 1e-9).sort(
        (x, y) => (a.food.get(x)![0]?.exp ?? 1e9) - (a.food.get(y)![0]?.exp ?? 1e9),
      );
      for (const g of order) {
        if (got >= eat - 1e-9) break;
        const nut = GOOD_DEFS[g].nutrition;
        const q = Math.min(invQty(a.food, g), (eat - got) / nut);
        invTake(a.food, g, q);
        got += q * nut;
      }
      const r = need > 0 ? Math.min(1, got / need) : 1;
      const art = invQty(a.food, 'artisanat');
      if (art > 0) invTake(a.food, 'artisanat', art * K.comfortWear);
      const woodNeed = members.length * K.firewoodPerPerson;
      const wood = Math.min(woodNeed, invQty(a.food, 'bois'));
      invTake(a.food, 'bois', wood);
      const cold = wood < woodNeed * 0.8;
      for (const m of members) {
        m.fed = r;
        m.hunger = m.hunger * 0.75 + (1 - r) * 0.25;
        m.cold = cold;
      }
    }
  }

  // ------------------------------------------------------------------ finances des entreprises

  private businessFinance(): void {
    const p = this.policy;
    for (const b of this.businesses) {
      if (!b.alive) continue;
      const cat = this.catOf(b);
      // salaires
      let totW = 0;
      for (const id of b.workers) totW += b.wages.get(id) ?? 0;
      if (totW > 0) {
        const ratio = b.cash >= totW ? 1 : b.cash / totW;
        if (ratio < 1) b.arrears++;
        for (const id of b.workers) {
          const w = Math.floor((b.wages.get(id) ?? 0) * ratio);
          if (w <= 0) continue;
          b.cash -= w;
          this.payAgent(this.agents[id], w);
          b.costDay += w;
          b.wageMonth += w;
          this.flow(cat, 'menages', w);
        }
      }
      // locaux commerciaux
      if (cat === 'commerce' && b.workers.length) {
        const rent = Math.min(b.cash, Math.round(p.shopRent * 100 * (1 + 0.3 * (b.workers.length - 1))));
        if (rent > 0) {
          b.cash -= rent;
          b.costDay += rent;
          b.otherMonth += rent;
          this.collect('loyers', rent);
          this.flow(cat, 'etat', rent);
        }
      }
      b.tools *= 1 - K.toolDepreciation;
      b.costEma = b.costEma * 0.9 + b.costDay * 0.1;
      if (b.workers.length) {
        const rent = cat === 'commerce' ? p.shopRent * 100 * (1 + 0.3 * (b.workers.length - 1)) : 0;
        b.vaEma = b.vaEma * 0.95 + ((b.revDay - b.inputDay - rent) / b.workers.length) * 0.05;
      }
      const reserve = this.reserveOf(b);
      // apport du patron si l'entreprise manque de fonds pour ses achats
      const owner = b.owner >= 0 ? this.agents[b.owner] : null;
      if (owner?.alive && b.cash < reserve * 0.3 && cat !== 'production' && b.workers.includes(owner.id)) {
        const inj = Math.min(Math.floor(owner.money * 0.3), Math.round(reserve * 0.5 - b.cash));
        if (inj > 0) {
          owner.money -= inj;
          b.cash += inj;
        }
      }
      // dividendes : une part de l'excédent de trésorerie (moins si l'entreprise grandit, pour financer
      // ses embauches : elle garde de quoi payer un nouveau salarié pendant 15 jours)
      const keep = reserve + (b.workers.length > 1 || b.vaPerWorker * 0.7 > this.policy.minWage * 100 * 1.1 ? b.offerWage * 15 : 0);
      if (b.cash > keep) {
        const div = Math.floor((b.cash - keep) * 0.3);
        let paid = 0;
        for (const [id, s] of b.shares) {
          const x = Math.floor(div * s);
          if (x <= 0) continue;
          paid += x;
          if (id === STATE_ID) {
            this.collect('dividendes', x);
            this.flow(cat, 'etat', x);
          } else {
            this.payAgent(this.agents[id], x);
            this.flow(cat, 'menages', x);
          }
        }
        b.cash -= paid;
      }
    }
  }

  /** Trésorerie que l'entreprise garde avant de verser des dividendes. */
  reserveOf(b: Business): number {
    // un assureur garde des provisions : deux mois de sinistres
    if (b.job === 'assureur') return Math.max(5000, b.claimsPerUnit * b.insuredUnits * 2);
    return Math.max(3000, b.costEma * 4);
  }

  private collect(k: RevKey, cents: number): void {
    if (cents <= 0) return;
    this.treasury += cents;
    this.d.revenue[k] += cents;
    this.stateMonth.revenue[k] += cents;
  }

  private spend(k: SpendKey, a: Agent, cents: number, taxable: boolean): void {
    if (cents <= 0) return;
    this.treasury -= cents;
    this.payAgent(a, cents, taxable);
    this.d.spending[k] += cents;
    this.stateMonth.spending[k] += cents;
    this.flow('etat', 'menages', cents);
  }

  // ------------------------------------------------------------------ État

  private statePayments(): void {
    const p = this.policy;
    const ix = this.indexFactor();
    const cut = this.budgetCut;
    const civil: Agent[] = [];
    const retirees: Agent[] = [];
    const adults: Agent[] = [];
    const poor: Agent[] = [];
    for (const a of this.agents) {
      if (!a.alive) continue;
      if (a.publicJob) civil.push(a);
      if (a.status === 'retraite') retirees.push(a);
      if (a.status !== 'enfant') adults.push(a);
      if (this.isHead(a) && a.money < p.socialAidThreshold * 100 * this.householdSize(a) * ix) poor.push(a);
    }
    // aide d'urgence promise après une catastrophe : dépense exceptionnelle, hors règle budgétaire
    if (this.pendingRelief.length) {
      for (const r of this.pendingRelief) {
        const b = this.businesses[r.biz];
        const x = Math.min(r.left, r.daily, Math.max(0, this.treasury));
        if (!b.alive) { r.left = 0; continue; }
        if (x <= 0) continue;
        r.left -= x;
        this.stateOut('aideUrgence', x);
        b.cash += x;
        this.flow('etat', this.catOf(b), x);
      }
      this.pendingRelief = this.pendingRelief.filter((r) => r.left > 0);
    }
    // montants dus (besoins) ; le budget voté n'en finance qu'une part (`cut`), le salaire des
    // enseignants n'est pas coupé (on en recrute moins)
    const plan: [SpendKey, Agent[], (a: Agent) => number, boolean, number][] = [
      ['salaires', civil, () => Math.round(p.publicSalary * 100 * ix), true, 1],
      ['pensions', retirees, () => Math.round(p.pension * 100 * ix), true, cut],
      // aide sociale : par membre du foyer, pour remonter vers le seuil
      ['aideSociale', poor, (a) => {
        const n = this.householdSize(a);
        return Math.min(Math.round(p.socialAidAmount * 100 * ix * n), Math.round(p.socialAidThreshold * 100 * ix * n) - a.money);
      }, false, cut],
      ['revenuUniversel', adults, () => Math.round(p.ubi * 100 * ix), false, cut],
    ];
    let worst = 1;
    for (const [k, list, amount, taxable, share] of plan) {
      let tot = 0;
      for (const a of list) tot += Math.max(0, amount(a));
      this.needMonth[k] += tot;
      tot *= share;
      if (tot <= 0) continue;
      const ratio = this.treasury >= tot ? 1 : Math.max(0, this.treasury) / tot;
      worst = Math.min(worst, ratio);
      for (const a of list) this.spend(k, a, Math.floor(Math.max(0, amount(a)) * share * ratio), taxable);
    }
    this.d.paidRatio = worst;
  }

  /** Sortie de caisse de l'État sans bénéficiaire habitant (l'appelant crédite le destinataire). */
  private stateOut(k: SpendKey, cents: number): void {
    if (cents <= 0) return;
    this.treasury -= cents;
    this.d.spending[k] += cents;
    this.stateMonth.spending[k] += cents;
  }

  // ------------------------------------------------------------------ santé, école

  /** Probabilité quotidienne de tomber malade (hors épidémie). */
  private sickProb(a: Agent): number {
    return 0.0012 * (1 + this.ageY(a) / 40) * (1 + 2 * (1 - a.health / 100)) * (a.fed < 0.7 ? 2 : 1);
  }

  /** Part des maladies qui sont graves : croît avec l'âge. */
  private severeShare(a: Agent): number {
    return 0.06 + 0.0025 * this.ageY(a);
  }

  /** Plafond de santé : baisse avec l'âge ; un suivi médical récent en rattrape une partie. */
  healthCeiling(a: Agent): number {
    const base = this.maxHealth(a);
    if (this.day > a.careUntil) return base;
    return base + 0.4 * (100 - base);
  }

  /** Honoraires d'un médecin par acte (centimes) ; initialisés sur le revenu de référence. */
  private feeOf(b: Business): number {
    if (b.fee <= 0) b.fee = this.refFee();
    return b.fee;
  }
  /** Honoraires « normaux » : un revenu un peu supérieur à la moyenne pour un cabinet bien rempli. */
  private refFee(): number {
    return Math.max(10, (this.avgIncome * 1.3) / K.actsPerDoctor);
  }

  /** Assureur santé encore en activité ? */
  private validInsurer(id: number): Business | null {
    if (id < 0) return null;
    const b = this.businesses[id];
    return b.alive && b.job === 'assureur' && b.workers.length ? b : null;
  }

  /** Unités de risque d'un foyer (somme des classes de risque modulées par la réglementation). */
  private householdUnits(h: Agent): number {
    const r = this.policy.insuranceRiskRating;
    let u = Math.pow(riskClass(this.ageY(h)), r);
    for (const c of this.dependents(h)) u += Math.pow(riskClass(this.ageY(c)), r);
    return u;
  }

  /** Part d'une prime mensuelle que l'État prend en charge (subside), en centimes. */
  private subsidyOf(h: Agent, monthly: number): number {
    const cap = this.policy.premiumIncomeCap;
    if (cap <= 0) return 0;
    return Math.max(0, monthly - Math.round(cap * h.lastIncome));
  }

  /**
   * Soins. Les médecins sont libéraux : chacun fixe ses honoraires par acte, les patients vont chez le
   * moins cher qui a encore de la place. Les malades passent en premier (les plus atteints d'abord),
   * puis le suivi des personnes âgées. Le prix est payé par la sécurité sociale (une part d'un tarif de
   * référence), puis l'assureur du foyer (une part du reste), le solde par le foyer : s'il ne peut ou ne
   * veut pas le payer, il renonce aux soins.
   */
  private healthcare(): void {
    const rng = this.rng;
    const p = this.policy;
    const ix = this.indexFactor();
    const epi = this.events.has('epidemie') ? 8 : 1;
    this.collectPremiums();
    const sick: Agent[] = [];
    const follow: Agent[] = [];
    for (const a of this.agents) {
      if (!a.alive) continue;
      if (!a.sick && rng.next() < this.sickProb(a) * epi) {
        a.sick = true;
        a.severe = rng.next() < this.severeShare(a);
        a.careNeed = a.severe ? K.severeActs : 1;
      }
      if (a.sick) sick.push(a);
      else if (this.ageY(a) >= K.followUpAge && this.day - a.lastCare >= K.followUpEvery) follow.push(a);
    }
    sick.sort((x, y) => x.health - y.health);
    const patients = [...sick, ...rng.shuffle(follow)];
    const docs = this.businesses.filter((b) => b.alive && b.job === 'medecin' && b.potential > 0);
    for (const b of docs) b.actsDay = 0;
    docs.sort((x, y) => this.feeOf(x) - this.feeOf(y));
    let di = 0;
    let shortage = 0;
    let feeSum = 0;
    const foodDay = this.costPerNutrition();
    const treated = new Set<number>();
    for (const a of patients) {
      const acts = 1;
      while (di < docs.length && docs[di].actsDay + acts > docs[di].potential + 0.5) di++;
      const payer = this.isHead(a) ? a : this.agents[a.parent];
      if (di >= docs.length) {
        if (payer.money > 0) shortage += acts;
        this.d.careNoDoctor += acts;
        continue;
      }
      const doc = docs[di];
      const price = Math.round(this.feeOf(doc) * acts);
      // sécurité sociale : une part du tarif de référence (le dépassement reste à la charge du patient) ;
      // pour un foyer modeste, une part des honoraires réels
      let secu = Math.round(p.secuRate * Math.min(price, p.secuTariff * 100 * ix * acts));
      if (payer.money < 4 * p.socialAidThreshold * 100 * ix * this.householdSize(payer)) secu = Math.max(secu, Math.round(p.secuRatePoor * price));
      // budget voté : la sécu ne rembourse que la part financée des besoins
      const secuNeed = secu;
      secu = Math.min(price, Math.round(secu * this.budgetCut));
      secu = Math.max(0, Math.min(secu, this.treasury));
      // assureur : une part de ce qui reste
      const ins = this.validInsurer(payer.insurer);
      let insPay = ins ? Math.round(p.insuranceCoverage * (price - secu)) : 0;
      if (ins) insPay = Math.max(0, Math.min(insPay, ins.cash));
      const oop = price - secu - insPay;
      // ce que le foyer accepte de payer : la nourriture passe avant tout (il garde cinq jours de
      // nourriture) ; pour une maladie, une grosse part du reste ; pour un suivi, une petite part de ce
      // qui dépasse son épargne de précaution
      const foodNeed = this.householdNeed(payer) * foodDay;
      const room = a.sick
        ? Math.max(0, payer.money - foodNeed * 5) * (a.health < 50 ? 0.8 : 0.5)
        : Math.max(0, payer.money - foodNeed * K.savingsBufferDays) * 0.1;
      if (oop > room) {
        this.d.careDenied += acts;
        continue;
      }
      this.needMonth.remboursementsSante += secuNeed;
      if (secu > 0) {
        this.treasury -= secu;
        this.d.spending.remboursementsSante += secu;
        this.stateMonth.spending.remboursementsSante += secu;
        this.flow('etat', 'sante', secu);
      }
      if (ins && insPay > 0) {
        ins.cash -= insPay;
        ins.costDay += insPay;
        ins.inputDay += insPay;
        ins.inputMonth += insPay;
        ins.claimsMonth += insPay;
        this.flow('assurance', 'sante', insPay);
      }
      if (oop > 0) {
        payer.money -= oop;
        this.flow('menages', 'sante', oop);
      }
      doc.cash += price;
      doc.revDay += price;
      doc.revMonth += price;
      doc.actsDay += acts;
      for (const id of doc.workers) {
        const w = this.agents[id];
        if (!w.sick) w.xp = Math.min(1, w.xp + 1 / 180);
      }
      this.d.careActs += acts;
      this.d.careSpend.menages += oop;
      this.d.careSpend.secu += secu;
      this.d.careSpend.assurance += insPay;
      feeSum += price;
      a.lastCare = this.day;
      if (a.sick) {
        treated.add(a.id);
        a.careNeed -= acts;
        if (a.careNeed <= 0) {
          a.sick = false;
          a.severe = false;
          a.health = Math.min(this.healthCeiling(a), a.health + 4);
        }
      } else {
        a.careUntil = this.day + K.careDays;
        a.health = Math.min(this.healthCeiling(a), a.health + 3);
      }
    }
    this.careShortage = shortage;
    if (this.d.careActs > 0) this.avgFee = feeSum / this.d.careActs;
    else if (!this.avgFee) this.avgFee = this.refFee();
    // honoraires : cabinet plein et patients refoulés → hausse ; cabinet peu occupé → baisse
    const ref = this.refFee();
    const floor = (this.avgIncome * 0.4) / K.actsPerDoctor;
    for (const b of docs) {
      const cap = Math.max(1, Math.floor(b.potential + 0.5));
      b.occupancy = b.occupancy * 0.9 + Math.min(1, b.actsDay / cap) * 0.1;
      let f = this.feeOf(b);
      if (b.occupancy >= 0.9 && shortage > 0) f *= 1 + rng.range(0.002, 0.01);
      else if (b.occupancy < 0.7) f *= 1 - rng.range(0.003, 0.015) * (0.7 - b.occupancy) / 0.7;
      b.fee = clamp(f, floor, ref * 3);
    }
    for (const a of this.agents) {
      if (!a.alive) continue;
      const y = this.ageY(a);
      if (a.sick && !treated.has(a.id)) {
        this.d.sickUntreated++;
        // sans soins, une maladie grave ronge la santé et guérit rarement d'elle-même
        a.health -= a.severe ? 2.5 : y < 10 || y > 65 ? 3 : 2;
        if (rng.next() < (a.severe ? 0.04 : 0.07)) {
          a.sick = false;
          a.severe = false;
        }
      }
      if (a.fed >= 0.9) a.health += 0.4;
      else a.health -= 4 * Math.pow(1 - a.fed, 1.4);
      if (a.cold) a.health -= 0.15;
      a.health = Math.min(a.health, this.healthCeiling(a));
    }
  }

  /**
   * Primes d'assurance, prélevées chaque jour (1/30 de la prime mensuelle). Le subside de l'État
   * paie la part qui dépasse le plafond fixé en pourcentage du revenu. Un foyer qui ne peut pas payer
   * sa part perd sa couverture.
   */
  private collectPremiums(): void {
    for (const b of this.businesses) if (b.alive && b.job === 'assureur') { b.insuredN = 0; b.insuredUnits = 0; }
    for (const h of this.agents) {
      if (h.insurer < 0) continue;
      const b = this.isHead(h) ? this.validInsurer(h.insurer) : null;
      if (!b) {
        h.insurer = -1;
        continue;
      }
      const units = this.householdUnits(h);
      const monthly = Math.round(b.premium * units);
      const due = Math.round(monthly / K.daysPerMonth);
      let state = Math.min(due, Math.round(this.subsidyOf(h, monthly) / K.daysPerMonth));
      this.needMonth.subsidesPrimes += Math.max(0, state);
      state = Math.max(0, Math.min(Math.round(state * this.budgetCut), due, this.treasury));
      const own = due - state;
      if (h.money < own) {
        h.insurer = -1;
        b.lostMonth++;
        continue;
      }
      h.money -= own;
      this.flow('menages', 'assurance', own);
      if (state > 0) {
        this.treasury -= state;
        this.d.spending.subsidesPrimes += state;
        this.stateMonth.spending.subsidesPrimes += state;
        this.flow('etat', 'assurance', state);
      }
      b.cash += due;
      b.revDay += due;
      b.revMonth += due;
      b.premiumsMonth += due;
      b.insuredN += this.householdSize(h);
      b.insuredUnits += units;
      b.unitDays += units;
    }
  }

  /**
   * Tarifs des assureurs (chaque mois) : prime par unité de risque = sinistres moyens + frais de
   * gestion (le travail de l'équipe), majorés d'une marge qui monte quand l'assureur est plein et
   * baisse quand il perd des clients. Si la réglementation impose une part minimale de primes
   * reversée en soins, l'excédent est remboursé aux assurés.
   */
  private priceInsurance(): void {
    const p = this.policy;
    const rng = this.rng;
    const industry = this.actuarialClaims();
    for (const b of this.businesses) {
      if (!b.alive || b.job !== 'assureur' || !b.workers.length) continue;
      const units = b.unitDays / K.daysPerMonth;
      if (units > 0.5) b.claimsPerUnit = b.claimsPerUnit * 0.3 + (b.claimsMonth / units) * 0.7;
      // remboursement de l'excédent de primes (ratio sinistres / primes minimal)
      if (p.insuranceMinLossRatio > 0 && b.premiumsMonth > 0) {
        const rebate = Math.min(b.cash, Math.round(b.premiumsMonth * p.insuranceMinLossRatio - b.claimsMonth));
        if (rebate > 0) this.rebate(b, rebate);
      }
      // sinistres attendus : statistiques de la population, corrigées par sa propre expérience
      // à mesure que son portefeuille grandit (crédibilité)
      const cred = units / (units + 300);
      const claims = cred * b.claimsPerUnit + (1 - cred) * industry;
      const admin = (this.avgIncome * K.daysPerMonth * b.workers.length) / Math.max(units, 0.4 * K.contractsPerInsurer * b.workers.length);
      // provisions entamées : on remonte la marge pour les reconstituer
      if (b.cash < this.reserveOf(b) * 0.5 && units > 10) b.markup += 0.05;
      else if (b.insuredN >= b.potential * 0.95) b.markup += 0.03;
      else if (b.lostMonth > 0.1 * Math.max(5, b.insuredN / 2)) b.markup -= 0.04;
      else b.markup -= 0.01 * (b.markup - 0.05) + rng.range(-0.005, 0.005);
      b.markup = clamp(b.markup, -0.1, 0.6);
      const target = Math.max(5, (claims + admin) * (1 + b.markup));
      b.premium = b.premium > 0 ? b.premium * 0.5 + target * 0.5 : target;
      b.premiumsMonth = b.claimsMonth = b.unitDays = b.lostMonth = 0;
    }
  }

  /**
   * Sinistres mensuels attendus par unité de risque si toute la population était assurée (centimes) :
   * ce que l'assureur peut estimer sans connaître ses clients. Les assurés réels peuvent être plus
   * risqués (antisélection), d'où la correction par l'expérience.
   */
  private actuarialClaims(): number {
    const p = this.policy;
    const fee = this.avgFee || this.refFee();
    const secuShare = p.secuRate * Math.min(1, (p.secuTariff * 100 * this.indexFactor()) / fee);
    let cost = 0;
    let units = 0;
    for (const a of this.agents) {
      if (!a.alive) continue;
      cost += this.expectedCare(a);
      units += Math.pow(riskClass(this.ageY(a)), p.insuranceRiskRating);
    }
    return units > 0 ? ((cost / units) * (1 - secuShare) * p.insuranceCoverage) : 0;
  }

  /** Rend `cents` aux foyers assurés par `b`, au prorata de leurs unités de risque. */
  private rebate(b: Business, cents: number): void {
    const heads = this.agents.filter((h) => h.insurer === b.id && this.isHead(h));
    const units = heads.map((h) => this.householdUnits(h));
    const tot = units.reduce((s, x) => s + x, 0);
    if (tot <= 0) return;
    let paid = 0;
    heads.forEach((h, i) => {
      const x = Math.floor((cents * units[i]) / tot);
      if (x <= 0) return;
      h.money += x;
      paid += x;
    });
    b.cash -= paid;
    b.inputMonth += paid;
    b.vaEma -= (paid / Math.max(1, b.workers.length)) * 0.05;
    this.flow('assurance', 'menages', paid);
  }

  /** Coût de soins mensuel attendu d'une personne (centimes), avant sécu et assurance. */
  private expectedCare(a: Agent): number {
    const perEpisode = 1 + this.severeShare(a) * (K.severeActs - 1);
    const acts = K.daysPerMonth * this.sickProb(a) * perEpisode + (this.ageY(a) >= K.followUpAge ? K.daysPerMonth / K.followUpEvery : 0);
    return acts * this.avgFee;
  }

  /**
   * Choix d'assurance des foyers (chaque mois). Obligatoire : chacun prend l'offre la moins chère.
   * Sinon, un foyer s'assure si la prime (après subside) ne dépasse pas ce qu'il s'attend à se faire
   * rembourser, majoré de son aversion au risque, et s'il peut la payer. Le foyer connaît son propre
   * risque (âge, santé), l'assureur seulement l'âge : de là vient l'antisélection.
   */
  private chooseInsurance(): void {
    const p = this.policy;
    const rng = this.rng;
    const ix = this.indexFactor();
    const offers = this.businesses.filter((b) => b.alive && b.job === 'assureur' && b.workers.length);
    const fresh = offers.filter((b) => b.premium <= 0);
    if (fresh.length) {
      // nouvel assureur : il s'aligne sur le marché, ou sur les statistiques s'il est seul
      const others = offers.filter((b) => b.premium > 0);
      const market = others.length ? others.reduce((s, b) => s + b.premium, 0) / others.length : 0;
      const est = this.actuarialClaims() * 1.3 + (this.avgIncome * K.daysPerMonth) / (0.4 * K.contractsPerInsurer);
      for (const b of fresh) b.premium = market || est;
    }
    if (!offers.length) {
      for (const h of this.agents) h.insurer = -1;
      return;
    }
    const seats = new Map<number, number>();
    for (const b of offers) seats.set(b.id, b.potential - b.insuredN);
    const fee = this.avgFee || this.refFee();
    const secuShare = p.secuRate * Math.min(1, (p.secuTariff * 100 * ix) / fee);
    const heads = rng.shuffle(this.agents.filter((h) => this.isHead(h)));
    for (const h of heads) {
      const cur = this.validInsurer(h.insurer);
      // inertie : un foyer sur quatre réexamine son contrat chaque mois (sauf s'il doit en trouver un)
      const must = p.insuranceMandatory ? !cur : h.insurer >= 0 && !cur;
      if (!must && rng.next() > 0.25) continue;
      const units = this.householdUnits(h);
      const size = this.householdSize(h);
      let best: Business | null = null;
      let bestP = Infinity;
      for (const b of offers) {
        const pr = b.premium * rng.range(0.97, 1.03);
        if (b !== cur && (seats.get(b.id) ?? 0) < size) continue;
        if (pr < bestP) { bestP = pr; best = b; }
      }
      if (!best) continue;
      const net = (b: Business) => {
        const m = b.premium * units;
        return m - this.subsidyOf(h, m);
      };
      let choice: Business | null;
      if (p.insuranceMandatory) choice = cur && net(cur) <= net(best) * 1.05 ? cur : best;
      else {
        let expected = this.expectedCare(h);
        for (const c of this.dependents(h)) expected += this.expectedCare(c);
        const covered = expected * (1 - secuShare) * p.insuranceCoverage;
        // une maladie non couverte coûterait une grosse part de l'épargne : on tient davantage à s'assurer
        const episode = fee * K.severeActs * (1 - secuShare);
        const aversion = 1.4 + (episode > 0.3 * h.money ? 0.8 : 0);
        const budget = 0.12 * h.lastIncome + 0.04 * h.money;
        const ok = (b: Business) => net(b) <= covered * aversion * (b === cur ? 1.15 : 1) && net(b) <= budget;
        choice = cur && ok(cur) && net(cur) <= net(best) * 1.05 ? cur : ok(best) ? best : null;
      }
      if (choice !== cur) {
        if (cur) cur.lostMonth++;
        if (choice) seats.set(choice.id, (seats.get(choice.id) ?? 0) - size);
        h.insurer = choice ? choice.id : -1;
      }
    }
  }

  private schooling(): void {
    let teachers = 0;
    const kids: Agent[] = [];
    for (const a of this.agents) {
      if (!a.alive) continue;
      if (a.publicJob && a.job === 'enseignant' && !a.sick) teachers++;
      const y = this.ageY(a);
      if (y >= K.schoolStart && y < K.adultAge) kids.push(a);
    }
    const pr = kids.length ? Math.min(1, (teachers * K.pupilsPerTeacher) / kids.length) : 0;
    for (const k of kids) {
      if (k.sick) continue;
      k.edu = Math.min(1, k.edu + (this.rng.next() < pr ? 1 / (10 * D) : 0.15 / (10 * D)));
    }
  }

  // ------------------------------------------------------------------ démographie

  private demography(): void {
    const rng = this.rng;
    const p = this.policy;
    const n = this.agents.length;
    for (let i = 0; i < n; i++) {
      const a = this.agents[i];
      if (!a.alive) continue;
      const y = this.ageY(a);
      if (a.health <= 0) {
        this.die(a, a.hunger > 0.3 ? 'faim' : 'maladie');
        continue;
      }
      const m = 0.00005 * Math.exp(0.095 * y) + (y < 5 ? 0.003 : 0);
      if (rng.next() < (m / D) * (1 + 2 * (1 - a.health / 100))) {
        this.die(a, y > 55 ? 'age' : 'maladie');
        continue;
      }
      // passage à l'âge adulte
      if (a.status === 'enfant' && y >= K.adultAge) {
        a.status = 'chomeur';
        this.chooseJob(a);
      }
      // retraite
      if ((a.status === 'actif' || a.status === 'chomeur') && y >= p.retirementAge) this.retire(a);
      // naissances
      if (y >= 18 && y < 42 && a.health > 50 && a.hunger < 0.2) {
        const kids = a.children.filter((c) => this.agents[c].alive && this.ageY(this.agents[c]) < K.adultAge).length;
        if (kids < 4) {
          const wealthF = clamp(a.money / (60 * 250), 0.3, 1.3);
          if (rng.next() < (1.15 / (25 * D)) * wealthF) {
            const c = this.newAgent(this.day, a.id);
            c.health = 90;
            a.children.push(c.id);
            this.d.births++;
          }
        }
      }
    }
  }

  private retire(a: Agent): void {
    this.leaveWork(a);
    a.status = 'retraite';
    a.job = null;
  }

  /** Retire l'agent de son poste (entreprise ou fonction publique), sans changer son statut. */
  private leaveWork(a: Agent): void {
    if (a.publicJob) {
      a.publicJob = false;
      a.job = null;
    }
    if (a.biz >= 0) {
      const b = this.businesses[a.biz];
      b.workers = b.workers.filter((x) => x !== a.id);
      b.wages.delete(a.id);
      a.biz = -1;
      if (b.alive && !b.workers.length) this.dissolve(b);
    }
  }

  private die(a: Agent, cause: DeathCause): void {
    this.leaveWork(a);
    a.alive = false;
    a.deathDay = this.day;
    a.deathCause = cause;
    a.sick = false;
    a.severe = false;
    a.insurer = -1;
    this.d.deaths[cause]++;
    this.causesTotal[cause]++;
    const heirs = a.children.map((c) => this.agents[c]).filter((c) => c.alive);
    const w = this.wealthOf(a);
    if (w > this.meanMoney * 8 && w > 100000) {
      this.say('deces', `Décès de ${agentName(a.id)} (${Math.floor(this.ageY(a))} ans), une des grandes fortunes de l'île (${Math.round(w / 100)} écus). ${heirs.length ? `${heirs.length} enfant(s) héritent.` : 'Sans enfant : tout revient à l’État.'}`);
    }
    // succession : argent taxé puis partagé, parts d'entreprises transmises
    const tax = Math.round(a.money * this.policy.inheritanceTax);
    if (tax > 0) {
      a.money -= tax;
      this.collect('succession', tax);
      this.flow('menages', 'etat', tax);
    }
    if (heirs.length) {
      const each = Math.floor(a.money / heirs.length);
      let rest = a.money - each * heirs.length;
      for (const h of heirs) {
        const x = each + (rest > 0 ? 1 : 0);
        if (rest > 0) rest--;
        h.money += x;
        h.inherited += x;
      }
      const heir0 = heirs.reduce((x, y) => (this.ageY(x) >= this.ageY(y) ? x : y));
      for (const [g, b] of a.food) invAddBatches(heir0.food, g, b);
    } else if (a.money > 0) {
      this.collect('succession', a.money);
      this.flow('menages', 'etat', a.money);
    }
    a.money = 0;
    a.food.clear();
    // obligations : la part taxée est annulée (l'État reprend sa dette), le reste va aux enfants
    if (a.bonds > 0) this.moveBonds(a.id, heirs.map((h) => ({ key: h.id, share: 1 / heirs.length })), this.policy.inheritanceTax);
    for (const [bid, s] of a.shares) {
      const b = this.businesses[bid];
      b.shares.delete(a.id);
      if (!b.alive) continue;
      if (heirs.length) {
        for (const h of heirs) {
          const ns = (b.shares.get(h.id) ?? 0) + s / heirs.length;
          b.shares.set(h.id, ns);
          h.shares.set(bid, ns);
        }
      } else {
        b.shares.set(STATE_ID, (b.shares.get(STATE_ID) ?? 0) + s);
      }
      this.recomputeOwner(b);
    }
    a.shares.clear();
  }

  /** Ferme une entreprise : trésorerie aux actionnaires, stock et outils revendus à un confrère. */
  private dissolve(b: Business): void {
    if (!b.alive) return;
    b.alive = false;
    // revente du stock et des outils à moitié prix au confrère le plus riche
    const peers = this.businesses.filter((x) => x.alive && x.job === b.job && x.workers.length);
    const buyer = peers.length ? peers.reduce((x, y) => (x.cash >= y.cash ? x : y)) : null;
    const value = this.bizValue(b) - b.cash - b.bonds;
    if (buyer && value > 0) {
      const price = Math.min(Math.floor(value * 0.5), Math.floor(buyer.cash * 0.5));
      const frac = price / (value * 0.5);
      buyer.cash -= price;
      b.cash += price;
      buyer.tools += b.tools * frac;
      for (const [g, batches] of b.inv) for (const x of batches) invAdd(buyer.inv, g, x.q * frac, x.exp);
      this.flow(this.catOf(buyer), this.catOf(b), price);
    }
    b.inv.clear();
    b.tools = 0;
    let paid = 0;
    const entries = [...b.shares];
    for (const [id, s] of entries) {
      const x = Math.floor(b.cash * s);
      paid += x;
      if (id === STATE_ID) this.collect('dividendes', x);
      else this.agents[id].money += x;
    }
    // reste d'arrondi au patron (ou à l'État)
    const rest = b.cash - paid;
    if (rest > 0) {
      if (b.owner >= 0) this.agents[b.owner].money += rest;
      else this.collect('dividendes', rest);
    }
    b.cash = 0;
    // obligations : partagées entre les actionnaires (la part de l'État est annulée)
    if (b.bonds > 0) this.moveBonds(-2 - b.id, entries.map(([id, s]) => ({ key: id === STATE_ID ? null : id, share: s })), 0);
    for (const [id] of entries) if (id !== STATE_ID) this.agents[id].shares.delete(b.id);
    b.shares.clear();
    for (const id of b.workers) {
      const w = this.agents[id];
      w.biz = -1;
      if (w.alive && w.status === 'actif') {
        w.status = 'chomeur';
        w.job = null;
      }
    }
    b.workers = [];
  }

  // ------------------------------------------------------------------ emploi

  private startIndependent(a: Agent, job: Job, initial = false): Business {
    const b = this.newBusiness(job, a);
    b.workers.push(a.id);
    a.biz = b.id;
    a.job = job;
    a.status = 'actif';
    a.jobSince = this.day;
    const capital = Math.floor(a.money * (initial ? 0.2 : 0.3));
    a.money -= capital;
    b.cash += capital;
    if (initial) {
      b.tools = 1;
      const def = JOB_DEFS[job];
      // stock de départ pour que le premier jour ne soit pas une famine
      const pot = def.batches * 1.4;
      for (const [g, q] of Object.entries(def.inputs) as [Good, number][]) invAdd(b.inv, g, pot * q * 2, this.day + GOOD_DEFS[g].shelf);
      if (def.cat === 'commerce') {
        for (const g of RETAIL_GOODS) {
          const share = g === 'bois' ? 0.04 : 0.137;
          invAdd(b.inv, g, K.shopCapacity * 1.3 * share, this.day + Math.min(GOOD_DEFS[g].shelf, 3));
          b.salesEma[g] = K.shopCapacity * share;
        }
      }
    }
    return b;
  }

  private makePublic(a: Agent, job: Job): void {
    this.leaveWork(a);
    a.publicJob = true;
    a.job = job;
    a.status = 'actif';
    a.jobSince = this.day;
  }

  /** Poids d'un secteur dans le choix d'un métier : croît plus vite que le revenu moyen (puissance 1,5). */
  private jobAttractiveness(income: number): number {
    return Math.pow(Math.max(1, this.cappedVA(income)), 1.5);
  }

  /** Un pic de prix ne fait pas croire à une fortune durable : on plafonne à 3× le revenu moyen. */
  private cappedVA(v: number): number {
    return Math.min(v, this.avgIncome * 3);
  }

  private eligible(a: Agent, j: Job): boolean {
    return a.edu >= JOB_DEFS[j].minEdu;
  }

  /** Choix d'un emploi pour un chômeur : poste salarié vacant ou installation à son compte. */
  private chooseJob(a: Agent, exclude?: Job): void {
    const rng = this.rng;
    const jobs = MARKET_JOBS.filter((j) => j !== exclude && this.eligible(a, j));
    const incs = jobs.map((j) => this.sectorVA[j]);
    const ji = rng.weighted(incs.map((x) => this.jobAttractiveness(x)));
    const job = jobs[ji];
    const expected = incs[ji];
    // un poste salarié vaut mieux s'il paie au moins 90 % du revenu espéré à son compte
    let best: Business | null = null;
    for (const b of this.businesses) {
      if (!b.alive || b.vacancies <= 0 || !this.eligible(a, b.job)) continue;
      if (b.offerWage >= expected * 0.9 && (!best || b.offerWage > best.offerWage)) best = b;
    }
    if (best) this.hire(best, a, best.offerWage);
    else this.startIndependent(a, job);
  }

  private hire(b: Business, a: Agent, wage: number): void {
    this.leaveWork(a);
    b.workers.push(a.id);
    b.wages.set(a.id, wage);
    b.vacancies--;
    a.biz = b.id;
    a.job = b.job;
    a.status = 'actif';
    a.jobSince = this.day;
    a.xp *= 0.5;
  }

  /**
   * Fusion : l'indépendant `joiner` apporte son entreprise `src` et `extra` centimes d'épargne
   * à `dst`. Les parts sont recalculées au prorata des apports ; le plus gros apporteur devient
   * (ou reste) le patron.
   */
  private mergeInto(dst: Business, src: Business, joiner: Agent, extra: number, wage: number): void {
    const vD = Math.max(1, this.bizValue(dst));
    joiner.money -= extra;
    src.cash += extra;
    const vS = Math.max(0, this.bizValue(src));
    const tot = vD + vS;
    for (const [id, s] of dst.shares) {
      const ns = (s * vD) / tot;
      dst.shares.set(id, ns);
      if (id !== STATE_ID) this.agents[id].shares.set(dst.id, ns);
    }
    for (const [id, s] of src.shares) {
      const ns = (dst.shares.get(id) ?? 0) + (s * vS) / tot;
      dst.shares.set(id, ns);
      if (id !== STATE_ID) {
        this.agents[id].shares.set(dst.id, ns);
        this.agents[id].shares.delete(src.id);
      }
    }
    dst.cash += src.cash;
    if (src.bonds > 0) this.moveBonds(-2 - src.id, [{ key: -2 - dst.id, share: 1 }], 0);
    for (const l of this.loans) if (l.biz === src.id) l.biz = dst.id;
    dst.tools += src.tools;
    if (src.job === 'assureur') for (const h of this.agents) if (h.insurer === src.id) h.insurer = dst.id;
    for (const [g, batches] of src.inv) invAddBatches(dst.inv, g, batches);
    for (const id of src.workers) this.agents[id].biz = -1;
    src.cash = 0;
    src.tools = 0;
    src.inv.clear();
    src.shares.clear();
    src.workers = [];
    src.alive = false;
    dst.workers.push(joiner.id);
    joiner.biz = dst.id;
    joiner.job = dst.job;
    joiner.status = 'actif';
    const prevOwner = dst.owner;
    this.recomputeOwner(dst);
    const n = dst.workers.length;
    const label = JOB_DEFS[dst.job].label.toLowerCase();
    if (dst.owner !== prevOwner && dst.owner >= 0 && prevOwner >= 0 && n >= 4) {
      this.say('entreprise', `${agentName(dst.owner)} apporte plus de capital que ${agentName(prevOwner)} et prend la tête de l'entreprise (${label}, ${n} pers.).`);
    }
    if (n > this.recordFirm) {
      this.recordFirm = n;
      this.say('entreprise', `Record : l'entreprise de ${agentName(dst.owner)} (${label}) compte désormais ${n} personnes, la plus grande de l'île.`);
    }
    for (const id of dst.workers) {
      if (id === dst.owner) dst.wages.delete(id);
      else if (!dst.wages.has(id)) dst.wages.set(id, wage);
    }
  }

  // ------------------------------------------------------------------ mensuel

  private monthly(): void {
    const p = this.policy;
    const rng = this.rng;
    // --- impôts
    const values = new Map<number, number>();
    for (const b of this.businesses) if (b.alive) values.set(b.id, this.bizValue(b));
    for (const a of this.agents) {
      if (!a.alive) continue;
      const I = a.income / 100;
      let tax = Math.round((p.incomeTaxLow * Math.min(I, p.incomeTaxThreshold) + p.incomeTaxHigh * Math.max(0, I - p.incomeTaxThreshold)) * 100);
      tax = Math.min(tax, a.money);
      if (tax > 0) {
        a.money -= tax;
        this.collect('impotRevenu', tax);
        this.flow('menages', 'etat', tax);
      }
      // cotisation à l'assurance maladie publique, proportionnelle aux revenus
      const cot = Math.min(a.money, Math.round(a.income * p.secuContribution));
      if (cot > 0) {
        a.money -= cot;
        this.collect('cotisationsSante', cot);
        this.flow('menages', 'etat', cot);
      }
      if (p.wealthTax > 0) {
        let w = a.money + a.bonds;
        for (const [bid, s] of a.shares) w += s * (values.get(bid) ?? 0);
        const t = Math.min(a.money, Math.round(Math.max(0, w - p.wealthTaxThreshold * 100) * (p.wealthTax / 12)));
        if (t > 0) {
          a.money -= t;
          this.collect('impotFortune', t);
          this.flow('menages', 'etat', t);
        }
      }
      a.lastIncome = a.income;
      a.income = 0;
    }
    for (const b of this.businesses) {
      if (!b.alive) continue;
      const profit = b.revMonth - b.inputMonth - b.wageMonth - b.otherMonth;
      const t = Math.min(b.cash, Math.round(Math.max(0, profit) * p.corporateTax));
      if (t > 0) {
        b.cash -= t;
        this.collect('impotSocietes', t);
        this.flow(this.catOf(b), 'etat', t);
      }
      const nw = Math.max(1, b.workers.length);
      b.vaPerWorker = (b.revMonth - b.inputMonth - b.otherMonth) / nw / K.daysPerMonth;
      b.profitLastMonth = profit;
      b.revMonth = b.inputMonth = b.wageMonth = b.otherMonth = 0;
    }
    // --- revenus moyens par secteur (revenu d'activité du mois écoulé)
    const sum = zeroJobs();
    const cnt = zeroJobs();
    for (const a of this.agents) {
      if (!a.alive || a.status !== 'actif' || !a.job) continue;
      if (this.day - a.jobSince < 25) continue;
      sum[a.job] += a.lastIncome / K.daysPerMonth;
      cnt[a.job]++;
    }
    let tot = 0;
    let n = 0;
    for (const j of JOBS) {
      if (cnt[j]) this.sectorIncome[j] = this.sectorIncome[j] * 0.5 + (sum[j] / cnt[j]) * 0.5;
      tot += sum[j];
      n += cnt[j];
    }
    if (n) this.avgIncome = this.avgIncome * 0.5 + (tot / n) * 0.5;
    this.reorganize();
    this.publicHiring();
    // chômeurs restants
    for (const a of this.agents) if (a.alive && a.status === 'chomeur') this.chooseJob(a);
    this.priceInsurance();
    this.chooseInsurance();
    this.monthlyNews();
    if (this.day % D === 0) this.recordQuintiles();
    this.compact();
    const lastMonth = this.history.slice(-K.daysPerMonth);
    if (lastMonth.length) this.cpiIndex = lastMonth.reduce((x, r) => x + r.cpi, 0) / lastMonth.length;
    // --- monnaie : taux directeur, crédit bancaire
    this.monetaryPolicy();
    this.bankCredit();
    // --- budget et dette : coupons, bilan du mois, vote du budget annuel, emprunts et remboursements
    this.payCoupons();
    this.closeMonth();
    if (this.day === K.daysPerMonth || this.day % D === 0) this.voteBudget(true);
    else if (this.day % 90 === 0 && this.budget) this.voteBudget(false);
    this.manageDebt();
    this.redistributeSurplus();
    this.debtStress *= 0.85;
    // --- comptes de l'État et flux
    this.statePrevMonth = this.stateMonth;
    this.stateMonth = { revenue: zeroRev(), spending: zeroSpend() };
    this.flowsPrev = this.flowsMonth;
    this.flowsMonth = new Map();
  }

  // ------------------------------------------------------------------ budget et dette publique

  /** PIB des 12 derniers mois (centimes), annualisé au début de la simulation. */
  gdpYear(): number {
    const m = this.monthLog.slice(-12);
    if (!m.length) return Math.max(1, this.monthGdp * (D / Math.max(1, this.day)));
    return Math.max(1, (m.reduce((s, x) => s + x.gdp, 0) * 12) / m.length);
  }

  /** Taux moyen de la dette en circulation (annuel). */
  avgDebtRate(): number {
    let n = 0;
    let r = 0;
    for (const t of this.debt) {
      let q = 0;
      for (const v of t.holders.values()) q += v;
      n += q;
      r += q * t.rate;
    }
    return n > 0 ? r / n : 0;
  }

  /** Ajoute (ou retire, si négatif) du nominal à un détenteur. */
  private holdBond(t: Bond, key: number, cents: number): void {
    if (!cents) return;
    const v = (t.holders.get(key) ?? 0) + cents;
    if (v > 0) t.holders.set(key, v);
    else t.holders.delete(key);
    if (key === CB_KEY) this.cbBonds += cents;
    else if (key === FOREIGN_KEY) this.foreignBonds += cents;
    else if (key >= 0) this.agents[key].bonds += cents;
    else this.businesses[-2 - key].bonds += cents;
  }

  /** Création (cents > 0) ou destruction (cents < 0) de monnaie, par origine. */
  private mint(src: MoneySource, cents: number): void {
    this.moneyBase += cents;
    this.moneyCreated[src] += cents;
  }

  /**
   * Transmet toutes les obligations d'un détenteur : une part `cancel` est annulée (la dette
   * s'éteint, par exemple les droits de succession), le reste est partagé selon `to` (`key` null =
   * annulé aussi). Le nominal reste entier : le reste d'arrondi va au premier destinataire.
   */
  private moveBonds(from: number, to: { key: number | null; share: number }[], cancel: number): void {
    for (const t of this.debt) {
      const n = t.holders.get(from);
      if (!n) continue;
      this.holdBond(t, from, -n);
      let rest = n - Math.round(n * cancel);
      const parts = to.map((x) => ({ key: x.key, q: Math.floor(rest * x.share) }));
      const given = parts.reduce((s, x) => s + x.q, 0);
      const first = parts.find((x) => x.key !== null);
      if (first) first.q += rest - given;
      for (const x of parts) {
        if (x.key === null || x.q <= 0) continue;
        this.holdBond(t, x.key, x.q);
        rest -= x.q;
      }
      this.debtTotal -= rest; // part annulée
    }
    this.debt = this.debt.filter((t) => t.holders.size > 0);
  }

  /** Coupons mensuels (1/12 du taux annuel). S'ils ne peuvent être payés en entier : défaut partiel. */
  private payCoupons(): void {
    let due = 0;
    for (const t of this.debt) for (const n of t.holders.values()) due += Math.floor((n * t.rate) / 12);
    if (due <= 0) return;
    const ratio = this.treasury >= due ? 1 : Math.max(0, this.treasury) / due;
    for (const t of this.debt) {
      for (const [k, n] of t.holders) {
        const c = Math.floor(Math.floor((n * t.rate) / 12) * ratio);
        if (c <= 0) continue;
        if (k === CB_KEY) {
          // coupon versé à la banque centrale : son bénéfice est reversé aussitôt à l'État
          this.stateOut('interets', c);
          this.collect('profitsBC', c);
        } else if (k === FOREIGN_KEY) {
          // coupon versé à l'étranger : de la monnaie quitte l'île
          this.stateOut('interets', c);
          this.mint('etranger', -c);
        } else if (k >= 0) this.spend('interets', this.agents[k], c, true);
        else {
          const b = this.businesses[-2 - k];
          this.stateOut('interets', c);
          b.cash += c;
          this.flow('etat', this.catOf(b), c);
        }
      }
    }
    if (ratio < 0.999) {
      this.debtStress = 1;
      this.say('crise', `Défaut partiel : l'État n'a pu verser que ${Math.round(ratio * 100)} % des intérêts dus à ses créanciers.`);
    }
  }

  /** Bilan du mois écoulé, pour les prévisions du budget. */
  private closeMonth(): void {
    const rev = REV_KEYS.reduce((s, k) => s + this.stateMonth.revenue[k], 0);
    const spend = SPEND_KEYS.reduce((s, k) => s + this.stateMonth.spending[k], 0);
    this.needMonth.interets = this.stateMonth.spending.interets;
    this.needMonth.redistribution = this.stateMonth.spending.redistribution;
    this.monthLog.push({ rev, spend: spend - this.stateMonth.spending.aideUrgence, gdp: this.monthGdp, ix: this.indexFactor(), cut: this.budgetCut, bought: this.stateMonth.spending.achats, needs: this.needMonth });
    if (this.monthLog.length > 48) this.monthLog.shift();
    this.needMonth = zeroSpend();
    this.monthGdp = 0;
  }

  /**
   * Vote du budget annuel (fin du premier mois, puis chaque début d'année). Besoins : effectifs
   * actuels × montants pour les salaires, pensions et revenu universel ; 12 derniers mois pour l'aide
   * sociale, la santé et les achats ; intérêts de la dette en circulation. Recettes prévues : moyenne
   * des 12 derniers mois. La règle fixe le déficit permis ; au-delà, les enveloppes sont réduites au
   * prorata (les intérêts ne se coupent pas).
   */
  private voteBudget(annual: boolean): void {
    const p = this.policy;
    const months = this.monthLog.slice(-12);
    if (!months.length) return;
    // indexation moyenne de l'année écoulée (l'IPC mensuel est trop volatil pour chiffrer un budget)
    const ix = months.reduce((s, m) => s + m.ix, 0) / months.length;
    const ann = 12 / months.length;
    const revenue = months.reduce((s, m) => s + m.rev, 0) * ann;
    const gdp = this.gdpYear();
    let pop = 0, retirees = 0, adults = 0;
    for (const a of this.agents) {
      if (!a.alive) continue;
      pop++;
      if (a.status === 'retraite') retirees++;
      if (a.status !== 'enfant') adults++;
    }
    const needs = zeroSpend();
    needs.salaires = Math.round((p.teachersPer1000 * pop) / 1000) * p.publicSalary * 100 * ix * D;
    needs.pensions = retirees * p.pension * 100 * ix * D;
    needs.revenuUniversel = adults * p.ubi * 100 * ix * D;
    for (const k of ['aideSociale', 'remboursementsSante', 'subsidesPrimes', 'achats'] as SpendKey[]) {
      needs[k] = months.reduce((s, m) => s + m.needs[k], 0) * ann;
    }
    // achats : seulement ce que le marché a pu fournir (ramené à un budget sans coupe). Les commandes
    // publiques sont plafonnées par la capacité des producteurs ; compter les commandes non servies
    // ferait réduire les autres enveloppes pour une dépense qui n'a pas lieu
    needs.achats = Math.min(needs.achats, months.reduce((s, m) => s + m.bought / Math.max(0.3, m.cut), 0) * ann);
    // intérêts : la dette actuelle à son taux, plus le nouvel emprunt de l'année à mi-parcours
    let coupons = 0;
    for (const t of this.debt) for (const n of t.holders.values()) coupons += n * t.rate;
    let allowed = this.allowedDeficit(revenue, gdp);
    // sans dette, pas d'excédent à dégager (il n'y a rien à rembourser) ; une trésorerie au-delà de
    // deux mois de dépenses est remise en circulation dans l'année
    const spentYear = months.reduce((s, m) => s + m.spend, 0) * ann;
    if (this.debtTotal <= 0) allowed = Math.max(allowed, 0) + Math.max(0, this.treasury - spentYear / 6);
    const base = needs.salaires + needs.pensions + needs.revenuUniversel + needs.aideSociale + needs.remboursementsSante + needs.subsidesPrimes + needs.achats;
    needs.interets = coupons + Math.max(0, base + coupons - revenue) * Math.max(this.lastRate, 0.02) * 0.5;
    // l'État dépense ses recettes plus le déficit permis : si c'est moins que les besoins, les
    // enveloppes sont réduites au prorata ; si c'est plus, elles sont augmentées (jusqu'à 130 %)
    const ruleCut = base > 0 ? clamp((revenue + allowed - needs.interets) / base, 0.3, 1.3) : 1;
    // trajectoire d'ajustement : 10 points au plus au vote annuel, 5 à chaque budget rectificatif
    // (tous les trois mois) ; l'écart restant est un dérapage, emprunté comme le reste
    const step = annual ? 0.1 : 0.05;
    const cut = clamp(ruleCut, Math.max(0.3, this.budgetCut - step), Math.min(1.3, this.budgetCut + step));
    const envelopes = zeroSpend();
    for (const k of SPEND_KEYS) envelopes[k] = Math.round(k === 'interets' ? needs[k] : needs[k] * cut);
    for (const k of SPEND_KEYS) needs[k] = Math.round(needs[k]);
    const prev = this.budgetCut;
    this.budgetCut = cut;
    if (!annual) {
      if (this.budget) {
        this.budget.cut = cut;
        this.budget.planned = Math.round(base * cut + needs.interets);
        for (const k of SPEND_KEYS) this.budget.envelopes[k] = Math.round(k === 'interets' ? needs[k] : needs[k] * cut);
      }
      if (Math.abs(cut - prev) >= 0.049) this.say('politique', `Budget rectificatif : les enveloppes passent de ${Math.round(prev * 100)} % à ${Math.round(cut * 100)} % des besoins (${cut < prev ? 'recettes plus faibles ou déficit trop élevé' : 'recettes meilleures que prévu'}).`);
      return;
    }
    this.budget = { day: this.day, rule: p.fiscalRule, revenue: Math.round(revenue), gdp: Math.round(gdp), needs, envelopes, allowedDeficit: Math.round(allowed), planned: Math.round(base * cut + needs.interets), cut };
    const year = Math.floor(this.day / D) + 1;
    const bal = (revenue - (base * cut + needs.interets)) / gdp;
    let text = `Budget de l'an ${year} : ${Math.round((base * cut + needs.interets) / 100000)} k écus de dépenses pour ${Math.round(revenue / 100000)} k de recettes prévues, ${bal < 0 ? `déficit de ${(-bal * 100).toFixed(1)} %` : `excédent de ${(bal * 100).toFixed(1)} %`} du PIB.`;
    if (cut < 0.995) text += ` La règle budgétaire impose des coupes de ${Math.round((1 - cut) * 100)} % sur les pensions, aides, soins, achats et postes d'enseignants${ruleCut < cut - 0.005 ? ` (elle en demandait ${Math.round((1 - ruleCut) * 100)} % : l'ajustement est étalé)` : ''}.`;
    else if (cut > 1.005) text += ` Les recettes permettent d'aller au-delà des besoins : pensions, aides, soins, achats et postes d'enseignants sont relevés de ${Math.round((cut - 1) * 100)} %.`;
    else if (prev < 0.995) text += ' Les coupes de l’an dernier sont levées.';
    this.say('politique', text);
  }

  /** Déficit permis par la règle budgétaire (centimes, négatif = excédent exigé). */
  private allowedDeficit(revenue: number, gdp: number): number {
    const p = this.policy;
    let allowed = 0;
    if (p.fiscalRule === 'cibleDeficit') allowed = p.deficitTarget * gdp;
    else if (p.fiscalRule === 'freinDette') {
      // frein à l'endettement : dépenses ≤ recettes × (PIB tendanciel / PIB) ; équilibre sur le cycle
      const m = this.monthLog.slice(-36);
      const trend = (m.reduce((s, x) => s + x.gdp, 0) * 12) / Math.max(1, m.length);
      allowed = revenue * (clamp(trend / gdp, 0.9, 1.1) - 1);
    }
    // plafond de dette : on s'en approche en douceur (un tiers de la marge restante par an)
    if (p.debtCeiling > 0) allowed = Math.min(allowed, (p.debtCeiling * gdp - this.debtTotal) / 3);
    return allowed;
  }

  /**
   * Trésorerie : l'État rembourse les obligations échues et emprunte de quoi couvrir le mois à venir
   * (dépenses courantes moins recettes encaissées au fil des jours, plus 5 jours de marge et les
   * aides d'urgence promises). Les impôts mensuels arrivent en fin de mois.
   */
  private manageDebt(): void {
    const sm = this.stateMonth;
    const daily = SPEND_KEYS.reduce((s, k) => s + (k === 'interets' || k === 'redistribution' ? 0 : sm.spending[k]), 0);
    const inflow = sm.revenue.tva + sm.revenue.loyers + sm.revenue.succession + sm.revenue.dividendes;
    let maturing = 0;
    for (const t of this.debt) if (t.maturity <= this.day) for (const n of t.holders.values()) maturing += n;
    const relief = this.pendingRelief.reduce((s, r) => s + r.left, 0);
    const need = maturing + Math.max(0, daily - inflow) + daily / 6 + relief - this.treasury;
    if (need > 1000) this.issueBonds(Math.round(need));
    this.repayMaturing();
    const ratio = this.debtTotal / this.gdpYear();
    if (ratio > this.debtRecord + 0.05) {
      this.debtRecord = ratio;
      this.say('crise', `Record : la dette publique atteint ${Math.round(ratio * 100)} % du PIB (${Math.round(this.debtTotal / 100000)} k écus).`);
    }
  }

  /** Remboursement des obligations échues ; si la caisse ne suffit pas, le reste est prolongé de 3 mois. */
  private repayMaturing(): void {
    const due = this.debt.filter((t) => t.maturity <= this.day);
    if (!due.length) return;
    let total = 0;
    for (const t of due) for (const n of t.holders.values()) total += n;
    const ratio = this.treasury >= total ? 1 : Math.max(0, this.treasury) / total;
    for (const t of due) {
      for (const [k, n] of [...t.holders]) {
        const x = Math.floor(n * ratio);
        if (x <= 0) continue;
        this.holdBond(t, k, -x);
        this.treasury -= x;
        this.debtTotal -= x;
        this.d.repayment += x;
        if (k === CB_KEY) this.mint('bc', -x); // la banque centrale détruit la monnaie remboursée
        else if (k === FOREIGN_KEY) this.mint('etranger', -x);
        else if (k >= 0) this.agents[k].money += x;
        else this.businesses[-2 - k].cash += x;
      }
      if (t.holders.size) t.maturity = this.day + 90;
    }
    this.debt = this.debt.filter((t) => t.holders.size > 0);
    if (ratio < 0.999) {
      this.debtStress = 1;
      this.say('crise', `Défaut : l'État ne rembourse que ${Math.round(ratio * 100)} % des obligations échues, le reste est prolongé de trois mois.`);
    }
  }

  /** Prime de risque exigée par les prêteurs : croît avec la dette / PIB et après une crise. */
  private riskPremium(): number {
    const r = this.debtTotal / this.gdpYear();
    return 0.2 * r * r + 0.04 * this.debtStress;
  }

  /**
   * Émission d'obligations par enchère (prix uniforme). Prêteurs : les foyers dont l'épargne dépasse
   * un coussin de précaution, et les entreprises qui ont de la trésorerie oisive. Chacun propose la
   * moitié de ce qu'il peut placer, en trois tranches, à un taux exigé qui croît avec la part de son
   * patrimoine déjà placée en obligations (plus la prime de risque). Le taux retenu est celui du
   * dernier prêteur servi. Si l'offre ne suffit pas, l'État emprunte moins : pas de création monétaire.
   */
  private issueBonds(amount: number): void {
    const prem = this.riskPremium();
    const bids: Order[] = [];
    const rates = new Map<number, number>(); // tag → taux
    let tag = 0;
    const P = (r: number) => 1e6 / (1 + r);
    const cpn = this.costPerNutrition();
    const offer = (key: number, money: number, bonds: number, investable: number, base: number, slope: number) => {
      const willing = investable * 0.5;
      if (willing < 1000) return;
      for (let i = 1; i <= 3; i++) {
        const sh = (bonds + (willing * i) / 3) / Math.max(1, bonds + money);
        const r = base + prem + slope * sh * sh;
        rates.set(++tag, r);
        bids.push({ owner: key, qty: willing / 3, price: P(r), filled: 0, tag });
      }
    };
    for (const a of this.agents) {
      if (!this.isHead(a) || a.status === 'enfant' || a.money <= 0) continue;
      const cushion = this.householdNeed(a) * cpn * 1.6 * K.bondCushionDays;
      // impatience propre à chacun (0,7 à 1,3)
      const taste = 0.7 + 0.6 * ((a.id * 0.6180339887) % 1);
      offer(a.id, a.money, a.bonds, a.money - cushion, 0.01 * taste, 0.08 * taste);
    }
    for (const b of this.businesses) {
      if (!b.alive || !b.workers.length) continue;
      const idle = b.cash - this.reserveOf(b) * 1.5 - b.offerWage * b.workers.length * 30;
      offer(-2 - b.id, b.cash, b.bonds, idle, 0.015, 0.08);
    }
    // investisseurs étrangers : taux mondial + prime de risque, dans la limite du plafond
    const p = this.policy;
    const gdp = this.gdpYear();
    // plafond ancré sur le PIB de départ (5 fois la masse monétaire initiale) : il ne gonfle pas avec l'inflation
    const foreignRoom = Math.max(0, p.foreignDebtCap * this.initialMoney * 5 - this.foreignBonds);
    if (foreignRoom > 1000) {
      const r = K.worldRate + prem * 1.5;
      rates.set(++tag, r);
      bids.push({ owner: FOREIGN_KEY, qty: Math.min(foreignRoom, amount), price: P(r), filled: 0, tag });
    }
    // banque centrale : achète au taux directeur ce que sa politique monétaire demande
    const cbRoom = Math.max(0, p.cbFinancing * (this.debtTotal + amount) - this.cbBonds);
    const cbWant = Math.min(cbRoom, this.cbPurchaseTarget());
    if (cbWant > 1000) {
      rates.set(++tag, this.policyRate);
      bids.push({ owner: CB_KEY, qty: cbWant, price: P(this.policyRate), filled: 0, tag });
    }
    const ask: Order = { owner: STATE_ID, qty: amount, price: P(K.bondMaxRate), filled: 0 };
    const res = callAuction(bids, [ask], this.rng);
    let rate = 0;
    for (const m of res.matches) rate = Math.max(rate, rates.get(m.bid.tag!) ?? 0);
    // prêteur en dernier ressort : la banque centrale complète une enchère ratée (dans sa limite)
    const placed = res.matches.reduce((s, m) => s + m.qty, 0);
    const lastResort = Math.min(Math.max(0, amount - placed) , Math.max(0, cbRoom - res.matches.filter((m) => m.bid.owner === CB_KEY).reduce((s, m) => s + m.qty, 0)));
    if (lastResort > 1000) {
      res.matches.push({ bid: { owner: CB_KEY, qty: lastResort, price: 0, filled: 0 }, ask, qty: lastResort });
      rate = Math.max(rate, this.policyRate);
      this.say('crise', `La banque centrale vole au secours de l'État : elle achète ${Math.round(lastResort / 100)} écus d'obligations que personne ne voulait, avec de la monnaie nouvelle.`);
    }
    if (!res.matches.length) {
      this.debtStress = 1;
      this.say('crise', `Enchère ratée : personne ne prête à l'État à moins de ${Math.round(K.bondMaxRate * 100)} %. Faute de liquidités, il ne pourra pas tout payer.`);
      return;
    }
    const t: Bond = { id: this.nextBondId++, issued: this.day, maturity: this.day + K.bondMaturity, rate, holders: new Map() };
    let sold = 0;
    for (const m of res.matches) {
      const key = m.bid.owner;
      if (key === CB_KEY || key === FOREIGN_KEY) {
        // monnaie nouvelle (banque centrale) ou venue de l'étranger
        const x = Math.floor(m.qty);
        if (x <= 0) continue;
        this.mint(key === CB_KEY ? 'bc' : 'etranger', x);
        this.treasury += x;
        this.holdBond(t, key, x);
        sold += x;
        continue;
      }
      const holder = key >= 0 ? this.agents[key] : null;
      const biz = key < 0 ? this.businesses[-2 - key] : null;
      const cash = holder ? holder.money : biz!.cash;
      const x = Math.min(cash, Math.floor(m.qty));
      if (x <= 0) continue;
      if (holder) holder.money -= x;
      else biz!.cash -= x;
      this.treasury += x;
      this.holdBond(t, key, x);
      sold += x;
    }
    if (sold <= 0) return;
    this.debt.push(t);
    this.debtTotal += sold;
    this.d.borrowing += sold;
    const prev = this.lastRate;
    this.lastRate = rate;
    if (sold < amount * 0.9) {
      this.debtStress = Math.min(1, this.debtStress + 0.5);
      this.say('crise', `Enchère ratée : l'État ne place que ${Math.round((sold / amount) * 100)} % des obligations voulues (${Math.round(sold / 100)} écus sur ${Math.round(amount / 100)}), au taux de ${(rate * 100).toFixed(1)} %.`);
    } else if (prev > 0 && rate > prev + 0.015 && rate > 0.05) {
      this.say('crise', `Le taux de la dette s'envole : ${(prev * 100).toFixed(1)} % → ${(rate * 100).toFixed(1)} % à la dernière enchère.`);
    }
  }

  /**
   * Aide d'urgence après une catastrophe : une part (`disasterRelief`) des pertes estimées des
   * indépendants et entreprises touchés, versée sur 30 jours. Dépense exceptionnelle, empruntée
   * hors règle budgétaire.
   */
  private promiseRelief(kind: EventKind): void {
    const rate = this.policy.disasterRelief;
    if (rate <= 0 || kind === 'epidemie') return;
    let total = 0;
    let n = 0;
    for (const b of this.businesses) {
      if (!b.alive || !b.workers.length) continue;
      const va = Math.max(0, b.vaEma) * b.workers.length;
      let loss = 0;
      if (kind === 'mauvaise_recolte' && (b.job === 'cerealier' || b.job === 'arboriculteur' || b.job === 'eleveur')) loss = 0.5 * va * EVENT_DEFS[kind].days;
      if (kind === 'tempete') loss = (b.job === 'pecheur' ? va * EVENT_DEFS[kind].days : 0) + b.tools * 0.3 * this.lastW.outils;
      if (kind === 'incendie' && b.job === 'bucheron') loss = 0.5 * va * 60;
      const x = Math.round(loss * rate);
      if (x < 100) continue;
      this.pendingRelief.push({ biz: b.id, left: x, daily: Math.ceil(x / 30) });
      total += x;
      n++;
    }
    if (n) this.say('politique', `Aide d'urgence : l'État promet ${Math.round(total / 100)} écus à ${n} entreprises et indépendants touchés (${Math.round(rate * 100)} % des pertes estimées), versés sur un mois et empruntés hors budget.`);
  }


  // ------------------------------------------------------------------ banque centrale et banque

  /**
   * Politique monétaire (chaque mois) : inflation sur 12 mois, taux directeur selon une règle de
   * Taylor simplifiée (taux neutre 2 % + inflation + moitié de l'écart à la cible), entre 0 et 20 %.
   */
  private monetaryPolicy(): void {
    this.cpiLog.push(this.cpiIndex);
    if (this.cpiLog.length > 24) this.cpiLog.shift();
    // l'IPC mensuel est très volatil (cycles des récoltes) : inflation = prix moyens des 12 derniers
    // mois / prix moyens des 12 mois précédents
    const n = this.cpiLog.length;
    if (n >= 24) {
      const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
      this.inflation = avg(this.cpiLog.slice(12)) / avg(this.cpiLog.slice(0, 12)) - 1;
    } else if (n >= 7) {
      const h = Math.floor(n / 2);
      const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
      this.inflation = Math.pow(avg(this.cpiLog.slice(h)) / avg(this.cpiLog.slice(0, h)), 12 / h) - 1;
    } else this.inflation = 0;
    const t = this.policy.inflationTarget;
    // les prix de départ s'ajustent la première année : la banque centrale ne réagit qu'ensuite
    // (taux neutre : 2 % réels + la cible)
    if (this.day < D) {
      this.policyRate = 0.02 + t;
      return;
    }
    // ajustement progressif (lissage des banques centrales) : un quart de l'écart chaque mois
    const taylor = clamp(0.02 + this.inflation + 0.5 * (this.inflation - t), 0, 0.2);
    this.policyRate += 0.25 * (taylor - this.policyRate);
  }

  /**
   * Achats d'obligations visés par la banque centrale à l'enchère du mois : d'autant plus que
   * l'inflation est sous la cible (création monétaire contre la déflation) ; rien si elle est au-dessus
   * (ses titres arrivent à échéance et la monnaie remboursée est détruite).
   */
  private cbPurchaseTarget(): number {
    const gap = this.policy.inflationTarget - this.inflation;
    if (gap <= 0 || this.day < D) return 0;
    return this.moneyBase * 0.01 * Math.min(3, gap / 0.02);
  }

  /**
   * Crédit bancaire aux entreprises (chaque mois). Une entreprise rentable qui manque de trésorerie
   * ou qui veut embaucher ou s'équiper emprunte, si la mensualité ne dépasse pas 30 % de sa valeur
   * ajoutée. Le prêt crée de la monnaie (un dépôt), le remboursement du capital la détruit. Les
   * intérêts vont à la banque : elle en garde 10 % en fonds propres (plus après des pertes) et verse
   * le reste aux déposants, au prorata de leur épargne. Trois mensualités impayées : défaut, la
   * banque perd le capital restant.
   */
  private bankCredit(): void {
    const p = this.policy;
    const rate = this.policyRate + p.bankSpread;
    // remboursements
    const keep: Loan[] = [];
    for (const l of this.loans) {
      const b = this.businesses[l.biz];
      if (!b.alive) {
        this.loanLoss(l);
        continue;
      }
      const cap = Math.ceil(l.principal / Math.max(1, l.monthsLeft));
      const int = Math.round((l.principal * l.rate) / 12);
      if (b.cash >= cap + int) {
        b.cash -= cap + int;
        b.otherMonth += int;
        l.principal -= cap;
        l.monthsLeft--;
        this.bankLoansTotal -= cap;
        this.mint('banque', -cap);
        this.bankIncomeMonth += int;
        this.flow(this.catOf(b), 'menages', int);
        l.missed = 0;
      } else if (++l.missed >= 3) {
        this.loanLoss(l);
        continue;
      }
      if (l.principal > 0) keep.push(l);
    }
    this.loans = keep;
    // intérêts : fonds propres puis déposants
    if (this.bankIncomeMonth > 0) {
      const retain = Math.round(this.bankIncomeMonth * (this.bankEquity < 0 ? 1 : 0.1));
      this.bankEquity += retain;
      this.mint('banque', -retain);
      let pay = this.bankIncomeMonth - retain;
      const savers = this.agents.filter((a) => a.alive && a.money > 0 && a.status !== 'enfant');
      const tot = savers.reduce((s, a) => s + a.money, 0);
      if (tot > 0 && pay > 0) {
        let paid = 0;
        for (const a of savers) {
          const x = Math.floor((pay * a.money) / tot);
          if (x <= 0) continue;
          this.payAgent(a, x);
          paid += x;
        }
        // reste d'arrondi : fonds propres
        this.bankEquity += pay - paid;
        this.mint('banque', -(pay - paid));
      }
      this.bankIncomeMonth = 0;
    }
    // nouveaux crédits : à partir de la 2e année (les prix de départ se sont ajustés), plafond ancré
    // sur le PIB de départ (5 fois la masse monétaire initiale) pour ne pas s'auto-entretenir avec
    // l'inflation, et au plus 1 % de la masse monétaire de crédits nouveaux par mois
    const cap = p.creditLimit * this.initialMoney * 5;
    if (p.creditLimit <= 0 || this.day < D || this.bankEquity < -0.1 * cap) return;
    let room = Math.min(cap - this.bankLoansTotal, this.moneyBase * 0.01);
    // la demande de crédit baisse avec le taux : nulle à 15 %
    const appetite = clamp(1 - rate / 0.15, 0, 1);
    const owed = new Map<number, number>();
    for (const l of this.loans) owed.set(l.biz, (owed.get(l.biz) ?? 0) + l.principal);
    const cands = this.businesses.filter((b) => b.alive && b.workers.length && b.vaPerWorker > 0);
    // les plus rentables d'abord
    cands.sort((x, y) => y.vaPerWorker - x.vaPerWorker);
    for (const b of cands) {
      if (room <= 1000) break;
      const nw = b.workers.length;
      const reserve = this.reserveOf(b);
      let want = 0;
      if (b.cash < reserve) want += reserve * 1.5 - b.cash;
      if (b.vacancies > 0 || (b.vaPerWorker * 0.7 >= p.minWage * 100 * this.indexFactor() * 1.1 && b.cash < b.offerWage * 40 + reserve)) want += b.offerWage * 30;
      if (b.tools < nw * 0.95 && b.job !== 'charpentier') want += (nw - b.tools) * this.lastW.outils;
      want *= appetite * 0.5;
      if (want < 2000) continue;
      // capacité de remboursement : mensualités ≤ 30 % de la valeur ajoutée mensuelle
      const vaMonth = b.vaPerWorker * nw * K.daysPerMonth;
      const debt = owed.get(b.id) ?? 0;
      const maxDebt = (vaMonth * 0.3) / (1 / K.loanMonths + rate / 12);
      const x = Math.floor(Math.min(want, maxDebt - debt, room));
      if (x < 2000) continue;
      this.loans.push({ biz: b.id, principal: x, rate, monthsLeft: K.loanMonths, missed: 0 });
      this.bankLoansTotal += x;
      this.mint('banque', x);
      b.cash += x;
      room -= x;
      owed.set(b.id, debt + x);
    }
  }

  /** Défaut d'un emprunteur : la banque perd le capital ; la monnaie déjà prêtée reste en circulation. */
  private loanLoss(l: Loan): void {
    this.bankEquity -= l.principal;
    this.bankLoansTotal -= l.principal;
    l.principal = 0;
  }

  /** Valeur ajoutée moyenne par travailleur dans chaque métier, pondérée par les effectifs. */
  private updateSectorVA(): void {
    const sum = zeroJobs();
    const cnt = zeroJobs();
    for (const b of this.businesses) {
      if (!b.alive || !b.workers.length) continue;
      sum[b.job] += b.vaEma * b.workers.length;
      cnt[b.job] += b.workers.length;
    }
    for (const j of MARKET_JOBS) {
      // métier déserté : on garde la dernière valeur connue, qui remonte avec les prix
      if (cnt[j]) this.sectorVA[j] = sum[j] / cnt[j];
    }
    for (const j of PUBLIC_JOBS) this.sectorVA[j] = this.policy.publicSalary * 100 * this.indexFactor();
  }

  /**
   * Facteur d'indexation des montants publics (pensions, aides, salaires publics et minimum) :
   * l'IPC moyen du mois écoulé / 100 si l'indexation est active, sinon 1.
   */
  indexFactor(): number {
    return this.policy.indexation ? clamp(this.cpiIndex / 100, 0.05, 50) : 1;
  }

  /** Revenu courant d'un actif, tel qu'il le perçoit (centimes/jour). */
  private currentEarnings(a: Agent): number {
    if (a.publicJob) return this.policy.publicSalary * 100 * this.indexFactor();
    if (a.biz < 0) return 0;
    const b = this.businesses[a.biz];
    if (b.owner !== a.id) return b.wages.get(a.id) ?? 0;
    return b.vaEma;
  }

  /**
   * Reconversions, étalées : chaque jour, un trentième des actifs réexamine son métier. S'il gagne
   * nettement moins que ce qu'offre un autre métier, il change avec une probabilité qui croît
   * avec l'écart.
   */
  private careerReviews(): void {
    const rng = this.rng;
    const slot = this.day % K.daysPerMonth;
    for (const a of this.agents) {
      if (a.id % K.daysPerMonth !== slot) continue;
      if (!a.alive || a.status !== 'actif' || !a.job || a.publicJob) continue;
      if (this.day - a.jobSince < 45) continue;
      const b = a.biz >= 0 ? this.businesses[a.biz] : null;
      if (b && b.owner === a.id && b.workers.length > 1) continue; // un patron ne quitte pas son entreprise
      const own = this.currentEarnings(a);
      const jobs = MARKET_JOBS.filter((j) => j !== a.job && this.eligible(a, j));
      const vas = jobs.map((j) => this.cappedVA(this.sectorVA[j]));
      const alt = Math.max(...vas);
      if (own >= alt * 0.7) continue;
      const gap = Math.min(1, (alt - Math.max(0, own)) / Math.max(50, alt));
      // lent pour un petit écart, rapide quand le métier ne nourrit plus son homme
      if (rng.next() > 0.03 * gap + 0.15 * Math.max(0, gap - 0.6)) continue;
      const nj = jobs[rng.weighted(vas.map((x) => (x > own * 1.25 ? this.jobAttractiveness(x) : 0)))];
      if (b && b.workers.length === 1 && b.owner === a.id) {
        // indépendant : il change d'activité en gardant son entreprise (stock revendu peu à peu)
        b.job = nj;
        b.bid = {};
        b.retail = {};
        b.salesEma = {};
        b.outSales = {};
        b.prodEma = {};
        b.fee = 0;
        b.premium = 0;
        b.vaEma = this.sectorVA[nj];
        a.job = nj;
        a.xp = 0;
        a.jobSince = this.day;
      } else {
        const old = a.job;
        this.leaveWork(a);
        a.status = 'chomeur';
        a.job = null;
        this.chooseJob(a, old);
      }
    }
  }

  /** Faits marquants du mois pour la gazette. */
  private monthlyNews(): void {
    const h = this.history;
    if (h.length < 31) return;
    const now = h[h.length - 1];
    const before = h[h.length - 31];
    for (const g of RETAIL_GOODS) {
      const a = before.retailPrice[g];
      const b = now.retailPrice[g];
      if (!a || !b) continue;
      const r = b / a - 1;
      if (r > 0.4) this.say('prix', `Flambée du prix ${GOOD_DEFS[g].label.toLowerCase() === 'œufs' ? 'des œufs' : `du ${GOOD_DEFS[g].label.toLowerCase()}`} : +${Math.round(r * 100)} % en un mois (${b.toFixed(2)} é).`);
      else if (r < -0.35) this.say('prix', `Le prix ${GOOD_DEFS[g].label.toLowerCase() === 'œufs' ? 'des œufs' : `du ${GOOD_DEFS[g].label.toLowerCase()}`} s'effondre : ${Math.round(r * 100)} % en un mois.`);
    }
    const month = h.slice(-30);
    const famine = month.reduce((x, r) => x + r.deaths.faim, 0);
    if (famine >= 5) this.say('crise', `Famine : ${famine} habitants sont morts de faim ce mois-ci.`);
    const hunger = month.reduce((x, r) => x + r.hungerRate, 0) / month.length;
    if (hunger > 0.1) this.say('crise', `${Math.round(hunger * 100)} % des habitants ont faim.`);
    if (month.some((r) => r.paidRatio < 0.95)) this.say('crise', `Les caisses de l'État sont vides : pensions et aides n'ont pas pu être entièrement versées.`);
    if (this.fishStock < 0.3 * K.fishK) this.say('ressource', `Surpêche : il ne reste que ${Math.round((this.fishStock / K.fishK) * 100)} % du stock de poissons.`);
    if (this.forestStock < 0.3 * K.forestK) this.say('ressource', `Déforestation : la forêt est réduite à ${Math.round((this.forestStock / K.forestK) * 100)} %.`);
    if (h.length >= 91) {
      const old = h[h.length - 91];
      for (const j of MARKET_JOBS) {
        const a = old.workersByJob[j];
        const b = now.workersByJob[j];
        if (a >= 15 && b < a * 0.6) this.say('societe', `Exode : les ${JOB_DEFS[j].label.toLowerCase()}s passent de ${a} à ${b} en trois mois.`);
        if (b >= 15 && b > Math.max(a, 5) * 1.6) this.say('societe', `Ruée vers le métier de ${JOB_DEFS[j].label.toLowerCase()} : ${a} → ${b} en trois mois.`);
      }
    }
  }

  /** Quintile de patrimoine de chaque adulte, relevé une fois par an (mobilité sociale). */
  private recordQuintiles(): void {
    const values = this.bizValues();
    const adults = this.agents.filter((a) => a.alive && a.status !== 'enfant');
    const sorted = adults.map((a) => ({ a, w: this.wealthOf(a, values) })).sort((x, y) => x.w - y.w);
    sorted.forEach(({ a }, i) => {
      a.quintiles[Math.floor(this.day / D)] = Math.min(4, Math.floor((i / sorted.length) * 5));
    });
  }

  /** Vide les données des entreprises disparues (allège les instantanés). */
  private compact(): void {
    for (const b of this.businesses) {
      if (b.alive || !b.inv) continue;
      b.inv = new Map();
      b.shares = new Map();
      b.wages = new Map();
      b.ask = {};
      b.bid = {};
      b.retail = {};
      b.avgCost = {};
      b.salesEma = {};
      b.outSales = {};
      b.prodEma = {};
      b.workers = [];
    }
    for (const a of this.agents) if (!a.alive) a.prefs = {};
  }

  /** Embauches, licenciements, salaires et regroupements d'indépendants. */
  private reorganize(): void {
    const p = this.policy;
    const rng = this.rng;
    const minWage = Math.round(p.minWage * 100 * this.indexFactor());
    for (const b of this.businesses) {
      b.vacancies = 0;
      if (!b.alive || !b.workers.length) continue;
      const va = b.vaPerWorker;
      // salaires : 70 % de la valeur ajoutée par travailleur, jamais sous le salaire minimum
      b.offerWage = Math.max(minWage, Math.round(va * 0.7));
      for (const id of b.workers) if (id !== b.owner) b.wages.set(id, b.offerWage);
      // licenciement si la valeur ajoutée ne couvre plus le salaire
      const employees = b.workers.filter((id) => id !== b.owner);
      if (employees.length && (b.arrears >= 3 || va < b.offerWage * 0.95)) {
        employees.sort((x, y) => (this.agents[x].shares.get(b.id) ?? 0) - (this.agents[y].shares.get(b.id) ?? 0) || this.productivity(this.agents[x]) - this.productivity(this.agents[y]));
        const fired = this.agents[employees[0]];
        this.leaveWork(fired);
        fired.status = 'chomeur';
        fired.job = null;
      } else if (va * 0.7 >= minWage * 1.1 && b.cash > b.offerWage * 10 + this.reserveOf(b) && b.arrears === 0) {
        // embauche si la trésorerie couvre dix jours de salaire en plus de la réserve
        b.vacancies = b.cash > b.offerWage * 40 + this.reserveOf(b) ? 2 : 1;
      }
      b.arrears = 0;
    }
    // indépendants en difficulté : rejoindre une entreprise qui recrute, ou se regrouper entre eux
    const bySector = new Map<Job, Business[]>();
    for (const b of this.businesses) {
      if (!b.alive || b.workers.length !== 1 || b.owner !== b.workers[0]) continue;
      const arr = bySector.get(b.job) ?? [];
      arr.push(b);
      bySector.set(b.job, arr);
    }
    for (const [job, solos] of bySector) {
      const sectorInc = this.sectorVA[job];
      const struggling = rng.shuffle(solos.filter((b) => b.vaEma < sectorInc * 0.8));
      const hiring = this.businesses.filter((b) => b.alive && b.job === job && b.vacancies > 0);
      const leftovers: Business[] = [];
      for (const s of struggling) {
        if (!s.alive || s.workers.length !== 1) continue;
        const a = this.agents[s.owner];
        const h = hiring.find((x) => x.vacancies > 0 && x.id !== s.id && x.offerWage > s.vaEma);
        if (h) {
          h.vacancies--;
          this.mergeInto(h, s, a, 0, h.offerWage);
        } else leftovers.push(s);
      }
      // regroupement de deux indépendants : le plus gros apport devient patron
      for (let i = 0; i + 1 < leftovers.length; i += 2) {
        if (rng.next() > 0.3) continue;
        const A = leftovers[i];
        const B = leftovers[i + 1];
        if (!A.alive || !B.alive || A.workers.length !== 1 || B.workers.length !== 1) continue;
        const a = this.agents[A.owner];
        const bb = this.agents[B.owner];
        const ca = this.bizValue(A) + a.money * 0.25;
        const cb = this.bizValue(B) + bb.money * 0.25;
        const [dst, src, joiner] = ca >= cb ? [A, B, bb] : [B, A, a];
        const owner = this.agents[dst.owner];
        const extraOwner = Math.floor(owner.money * 0.25);
        owner.money -= extraOwner;
        dst.cash += extraOwner;
        const wage = Math.max(minWage, Math.round(((A.vaPerWorker + B.vaPerWorker) / 2) * 0.7));
        this.mergeInto(dst, src, joiner, Math.floor(joiner.money * 0.25), wage);
        if (rng.next() < 0.25) this.say('entreprise', `${agentName(owner.id)} et ${agentName(joiner.id)}, ${JOB_DEFS[job].label.toLowerCase()}s en difficulté, s'associent. ${agentName(dst.owner)} devient patron·ne (plus gros apport).`);
      }
    }
  }

  /**
   * « Dividende public » (levier, désactivé par défaut) : la trésorerie au-delà de N jours de
   * dépenses courantes est reversée à parts égales aux adultes. Un État excédentaire sans dette
   * retire sinon de la monnaie du circuit (déflation).
   */
  private redistributeSurplus(): void {
    const p = this.policy;
    if (p.surplusDays <= 0) return;
    const sp = this.stateMonth.spending;
    const monthly = sp.salaires + sp.pensions + sp.aideSociale + sp.revenuUniversel + sp.remboursementsSante + sp.subsidesPrimes + sp.achats + sp.interets;
    const target = (monthly / K.daysPerMonth) * p.surplusDays;
    const excess = this.treasury - target;
    if (excess <= 0) return;
    const adults = this.agents.filter((a) => a.alive && a.status !== 'enfant');
    if (!adults.length) return;
    const each = Math.floor(excess / adults.length);
    if (each <= 0) return;
    for (const a of adults) this.spend('redistribution', a, each, false);
  }

  private publicHiring(): void {
    const p = this.policy;
    const pop = this.agents.reduce((s, a) => s + (a.alive ? 1 : 0), 0);
    const salary = p.publicSalary * 100 * this.indexFactor();
    for (const job of PUBLIC_JOBS) {
      // le budget voté peut imposer moins de postes que prévu (coupes au prorata)
      const target = Math.round(((p.teachersPer1000 * pop) / 1000) * this.budgetCut);
      const current = this.agents.filter((a) => a.alive && a.publicJob && a.job === job);
      if (current.length > target) {
        current.sort((x, y) => y.jobSince - x.jobSince);
        for (const a of current.slice(0, current.length - target)) {
          this.leaveWork(a);
          a.status = 'chomeur';
          this.chooseJob(a);
        }
      } else if (current.length < target) {
        const cands = this.agents.filter((a) => {
          if (!a.alive || a.publicJob || (a.status !== 'actif' && a.status !== 'chomeur')) return false;
          if (!this.eligible(a, job)) return false;
          if (a.biz >= 0) {
            const b = this.businesses[a.biz];
            if (b.owner === a.id && b.workers.length > 1) return false;
          }
          return a.status === 'chomeur' || a.lastIncome / K.daysPerMonth < salary * 1.1;
        });
        cands.sort((x, y) => y.edu - x.edu);
        for (const a of cands.slice(0, target - current.length)) this.makePublic(a, job);
      }
      // fonctionnaires mal payés (État à court d'argent) : démission possible
      for (const a of current) {
        if (!a.alive || !a.publicJob) continue;
        if (this.d.paidRatio < 0.8 && this.rng.next() < 0.2) {
          this.leaveWork(a);
          a.status = 'chomeur';
          this.chooseJob(a);
        }
      }
    }
  }

  // =========================================================================
  // Statistiques

  private cpiRaw(): number {
    const w: Partial<Record<Good, number>> = { pain: 0.35, poisson_prep: 0.15, viande: 0.12, fromage: 0.08, lait: 0.08, oeufs: 0.1, fruits: 0.12, bois: 0.05 };
    let s = 0;
    for (const g of RETAIL_GOODS) s += (w[g] ?? 0) * this.lastR[g];
    return s;
  }

  wealthOf(a: Agent, values?: Map<number, number>): number {
    let w = a.money + a.bonds;
    for (const [bid, s] of a.shares) w += s * (values?.get(bid) ?? this.bizValue(this.businesses[bid]));
    return w;
  }

  private bizValues(): Map<number, number> {
    const m = new Map<number, number>();
    for (const b of this.businesses) if (b.alive) m.set(b.id, this.bizValue(b));
    return m;
  }

  totalMoney(): { households: number; businesses: number; total: number } {
    let h = 0;
    let b = 0;
    for (const a of this.agents) h += a.money;
    for (const x of this.businesses) b += x.cash;
    return { households: h, businesses: b, total: h + b + this.treasury };
  }

  private recordStats(): void {
    const money = this.totalMoney();
    this.moneyError = money.total - this.moneyBase;
    let pop = 0, enfants = 0, actifs = 0, chomeurs = 0, retraites = 0, health = 0, eduSum = 0, eduN = 0, hungry = 0, sick = 0, pubEmp = 0;
    const workersByJob = zeroJobs();
    for (const a of this.agents) {
      if (!a.alive) continue;
      pop++;
      health += a.health;
      if (a.fed < 0.9) hungry++;
      if (a.sick) sick++;
      if (a.status === 'enfant') enfants++;
      else {
        eduSum += a.edu;
        eduN++;
      }
      if (a.status === 'actif') {
        actifs++;
        if (a.job) workersByJob[a.job]++;
        if (a.publicJob) pubEmp++;
      }
      if (a.status === 'chomeur') chomeurs++;
      if (a.status === 'retraite') retraites++;
    }
    let firms = 0, indep = 0, firmWorkers = 0, biggest = 0, employees = 0;
    for (const b of this.businesses) {
      if (!b.alive || !b.workers.length) continue;
      if (b.workers.length >= 2) {
        firms++;
        firmWorkers += b.workers.length;
        employees += b.workers.length - 1;
      } else indep++;
      biggest = Math.max(biggest, b.workers.length);
    }
    if (this.day % 5 === 0 || this.day <= 1) {
      const values = this.bizValues();
      const adults = this.agents.filter((a) => a.alive && a.status !== 'enfant');
      const w = adults.map((a) => this.wealthOf(a, values));
      this.lastGini.w = gini(w);
      this.lastGini.i = gini(adults.map((a) => a.lastIncome || a.income));
      const inc = adults.filter((a) => a.status === 'actif').map((a) => a.lastIncome).sort((x, y) => x - y);
      if (inc.length > 20) this.lastP9010 = inc[Math.floor(inc.length * 0.9)] / Math.max(100, inc[Math.floor(inc.length * 0.1)]);
      const sorted = [...w].sort((x, y) => x - y);
      const tot = sorted.reduce((s, x) => s + Math.max(0, x), 0) || 1;
      const n = sorted.length;
      this.lastGini.top10 = sorted.slice(Math.floor(n * 0.9)).reduce((s, x) => s + Math.max(0, x), 0) / tot;
      // détention de la dette par quintile de patrimoine (adultes), puis par les entreprises
      const dh = [0, 0, 0, 0, 0, 0, 0, 0];
      if (this.debtTotal > 0) {
        const order = adults.map((a, i) => ({ a, w: w[i] })).sort((x, y) => x.w - y.w);
        order.forEach(({ a }, i) => (dh[Math.min(4, Math.floor((i / order.length) * 5))] += a.bonds));
        for (const b of this.businesses) if (b.alive) dh[5] += b.bonds;
        dh[6] = this.cbBonds;
        dh[7] = this.foreignBonds;
        const tb = dh.reduce((s, x) => s + x, 0) || 1;
        for (let i = 0; i < 8; i++) dh[i] /= tb;
      }
      this.lastDebtHolders = dh;
      this.lastGini.bottom50 = sorted.slice(0, Math.floor(n * 0.5)).reduce((s, x) => s + Math.max(0, x), 0) / tot;
    }
    let insured = 0;
    for (const a of this.agents) if (this.isHead(a) && this.validInsurer(a.insurer)) insured += this.householdSize(a);
    let bondsA = 0;
    let bondsB = 0;
    for (const a of this.agents) bondsA += a.bonds;
    for (const b of this.businesses) bondsB += b.bonds;
    const gdpY = this.gdpYear();
    const log = this.monthLog.slice(-12);
    const defY = log.length ? log.reduce((s, m) => s + m.spend - m.rev, 0) / Math.max(1, log.reduce((s, m) => s + m.gdp, 0)) : 0;
    let premW = 0;
    let premU = 0;
    for (const b of this.businesses) {
      if (!b.alive || b.job !== 'assureur' || !b.workers.length) continue;
      premW += b.premium * Math.max(1, b.insuredUnits);
      premU += Math.max(1, b.insuredUnits);
    }
    const e = (x: number) => x / 100;
    const mapE = (r: Partial<Record<Good, number>>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, e(v as number)])) as Partial<Record<Good, number>>;
    const incomeByJob = zeroJobs();
    for (const j of JOBS) incomeByJob[j] = e(this.sectorIncome[j]);
    const row: DayStats = {
      day: this.day,
      population: pop, enfants, actifs, chomeurs, retraites,
      births: this.d.births, deaths: { ...this.d.deaths },
      gdp: e(this.d.gdp), wholesaleValue: e(this.d.wholesaleValue),
      retailPrice: mapE(Object.fromEntries(RETAIL_GOODS.map((g) => [g, this.lastR[g]]))),
      wholesalePrice: mapE(Object.fromEntries(GOODS.map((g) => [g, this.lastW[g]]))),
      retailVolume: { ...this.d.retailVolume }, wholesaleVolume: { ...this.d.wholesaleVolume },
      production: { ...this.d.production }, waste: { ...this.d.waste }, unmetDemand: { ...this.d.unmet },
      workersByJob, incomeByJob,
      giniWealth: this.lastGini.w, giniIncome: this.lastGini.i, top10Wealth: this.lastGini.top10, bottom50Wealth: this.lastGini.bottom50,
      avgHealth: pop ? health / pop : 0, avgEduAdults: eduN ? eduSum / eduN : 0,
      hungerRate: pop ? hungry / pop : 0, sickRate: pop ? sick / pop : 0,
      treasury: e(this.treasury),
      revenue: Object.fromEntries(REV_KEYS.map((k) => [k, e(this.d.revenue[k])])) as Record<RevKey, number>,
      spending: Object.fromEntries(SPEND_KEYS.map((k) => [k, e(this.d.spending[k])])) as Record<SpendKey, number>,
      paidRatio: this.d.paidRatio,
      moneyHouseholds: e(money.households), moneyBusinesses: e(money.businesses), moneyTotal: e(money.total),
      fishStock: this.fishStock, forestStock: this.forestStock,
      firms, independents: indep, avgFirmSize: firms ? firmWorkers / firms : 0, biggestFirm: biggest,
      employees, publicEmployees: pubEmp,
      cpi: (this.cpiRaw() / this.cpiBase) * 100,
      velocity: money.total > 0 ? (this.d.gdp * D) / money.total : 0,
      p90p10: this.lastP9010,
      careActs: this.d.careActs, careDenied: this.d.careDenied, careNoDoctor: this.d.careNoDoctor, sickUntreated: this.d.sickUntreated,
      careSpend: { menages: e(this.d.careSpend.menages), secu: e(this.d.careSpend.secu), assurance: e(this.d.careSpend.assurance) },
      avgFee: e(this.avgFee), avgPremium: premU ? e(premW / premU) : 0,
      insuredRate: pop ? insured / pop : 0,
      debt: e(this.debtTotal), debtRatio: this.debtTotal / gdpY, deficitRatio: defY,
      avgRate: this.avgDebtRate(), lastRate: this.lastRate,
      borrowing: e(this.d.borrowing), repayment: e(this.d.repayment),
      debtHolders: [...this.lastDebtHolders],
      nfaHouseholds: e(money.households + bondsA), nfaBusinesses: e(money.businesses + bondsB - this.bankLoansTotal), nfaPublic: e(this.treasury - this.debtTotal),
      budgetCut: this.budgetCut,
      moneyCreated: { bc: e(this.moneyCreated.bc), banque: e(this.moneyCreated.banque), etranger: e(this.moneyCreated.etranger) },
      policyRate: this.policyRate, inflation: this.inflation,
      bankLoans: e(this.bankLoansTotal), cbDebt: e(this.cbBonds), foreignDebt: e(this.foreignBonds), bankEquity: e(this.bankEquity),
    };
    this.history.push(row);
  }

  // =========================================================================
  // Données pour l'interface

  agentRow(a: Agent, values?: Map<number, number>): AgentRow {
    let role = '—';
    if (a.publicJob) role = 'Fonctionnaire';
    else if (a.biz >= 0) {
      const b = this.businesses[a.biz];
      role = b.workers.length === 1 ? 'Indépendant' : b.owner === a.id ? `Patron (${b.workers.length} pers.)` : 'Salarié';
    } else if (a.shares.size && a.status !== 'enfant') role = 'Rentier';
    return {
      id: a.id,
      name: agentName(a.id),
      age: Math.floor(this.ageY(a)),
      status: a.status,
      job: a.job ? JOB_DEFS[a.job].label : '—',
      role,
      money: a.money / 100,
      wealth: this.wealthOf(a, values) / 100,
      income: a.lastIncome / 100 / K.daysPerMonth,
      health: a.health,
      edu: a.edu,
      insured: !!this.validInsurer(this.isHead(a) || a.parent < 0 ? a.insurer : this.agents[a.parent].insurer),
      bonds: a.bonds / 100,
    };
  }

  snapshot(): Snapshot {
    const values = this.bizValues();
    const alive = this.agents.filter((a) => a.alive);
    const adults = alive.filter((a) => a.status !== 'enfant');
    const wealth = adults.map((a) => ({ a, w: this.wealthOf(a, values) }));
    const lorenz = (vals: number[]): [number, number][] => {
      const v = vals.map((x) => Math.max(0, x)).sort((x, y) => x - y);
      const tot = v.reduce((s, x) => s + x, 0) || 1;
      const out: [number, number][] = [[0, 0]];
      let cum = 0;
      const step = Math.max(1, Math.floor(v.length / 50));
      for (let i = 0; i < v.length; i++) {
        cum += v[i];
        if ((i + 1) % step === 0 || i === v.length - 1) out.push([(i + 1) / v.length, cum / tot]);
      }
      return out;
    };
    // histogramme logarithmique du patrimoine (écus)
    const edges = [0, 10, 25, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, Infinity];
    const hist = edges.slice(0, -1).map((lo, i) => ({ label: edges[i + 1] === Infinity ? `> ${lo}` : `${lo}–${edges[i + 1]}`, count: 0 }));
    for (const { w } of wealth) {
      const x = w / 100;
      let i = edges.findIndex((e, k) => x >= e && x < edges[k + 1]);
      if (i < 0) i = 0;
      hist[i].count++;
    }
    const pyramid: Snapshot['pyramid'] = [];
    for (let lo = 0; lo < 100; lo += 5) pyramid.push({ age: `${lo}–${lo + 4}`, actifs: 0, enfants: 0, retraites: 0, chomeurs: 0 });
    for (const a of alive) {
      const i = Math.min(19, Math.floor(this.ageY(a) / 5));
      const s = a.status === 'actif' ? 'actifs' : a.status === 'enfant' ? 'enfants' : a.status === 'retraite' ? 'retraites' : 'chomeurs';
      pyramid[i][s]++;
    }
    const jobs = JOBS.map((j) => {
      const ws = adults.filter((a) => a.status === 'actif' && a.job === j);
      const bs = this.businesses.filter((b) => b.alive && b.job === j && b.workers.length);
      return {
        job: j,
        label: JOB_DEFS[j].label,
        workers: ws.length,
        avgIncome: this.sectorIncome[j] / 100,
        avgWealth: ws.length ? ws.reduce((s, a) => s + this.wealthOf(a, values), 0) / ws.length / 100 : 0,
        firms: bs.filter((b) => b.workers.length > 1).length,
        independents: bs.filter((b) => b.workers.length === 1).length,
        employees: bs.reduce((s, b) => s + Math.max(0, b.workers.length - 1), 0),
        topShare: ws.length ? Math.max(0, ...bs.map((b) => b.workers.length)) / ws.length : 0,
      };
    });
    const firmsTable = this.businesses
      .filter((b) => b.alive && b.workers.length > 1)
      .sort((x, y) => y.workers.length - x.workers.length || y.cash - x.cash)
      .slice(0, 25)
      .map((b) => ({
        id: b.id, job: JOB_DEFS[b.job].label, patron: b.owner, patronName: b.owner >= 0 ? agentName(b.owner) : 'État',
        workers: b.workers.length, cash: b.cash / 100, wage: b.offerWage / 100, va: b.vaPerWorker / 100,
        tools: b.tools, founded: b.founded, shareholders: b.shares.size,
      }));
    const last = this.history[this.history.length - 1];
    const goods = GOODS.map((g) => {
      let sb = 0;
      let sh = 0;
      for (const b of this.businesses) if (b.alive) sb += invQty(b.inv, g);
      for (const a of alive) if (a.food.size) sh += invQty(a.food, g);
      return {
        good: g, label: GOOD_DEFS[g].label,
        retail: GOOD_DEFS[g].retail ? this.lastR[g] / 100 : null,
        wholesale: this.lastW[g] / 100,
        stockBiz: sb, stockHouseholds: sh,
        retailVol: last.retailVolume[g] ?? 0, wholesaleVol: last.wholesaleVolume[g] ?? 0,
        waste: last.waste[g] ?? 0, production: last.production[g] ?? 0,
      };
    });
    // flux du mois précédent (ou en cours si premier mois) ; transformation <-> production en net
    const src = this.flowsPrev.size ? this.flowsPrev : this.flowsMonth;
    const fl = new Map(src);
    const pt = fl.get('production>transformation') ?? 0;
    const tp = fl.get('transformation>production') ?? 0;
    fl.delete('production>transformation');
    fl.delete('transformation>production');
    if (tp > pt) fl.set('transformation>production', tp - pt);
    else if (pt > tp) fl.set('production>transformation', pt - tp);
    const flows: Snapshot['flows'] = [];
    for (const [k, v] of fl) {
      const [from, to] = k.split('>') as [FlowNode, FlowNode];
      if (from === to || v <= 0) continue;
      flows.push({ from, to, value: v / 100 });
    }
    const sortedW = [...wealth].sort((x, y) => y.w - x.w);
    const kpi: Record<string, number> = {
      population: last.population,
      gdp: last.gdp,
      giniWealth: last.giniWealth,
      giniIncome: last.giniIncome,
      treasury: last.treasury,
      hungerRate: last.hungerRate,
      unemployment: last.actifs + last.chomeurs ? last.chomeurs / (last.actifs + last.chomeurs) : 0,
      cpi: last.cpi,
      moneyError: this.moneyError / 100,
      moneyTotal: last.moneyTotal,
      avgHealth: last.avgHealth,
      firms: last.firms,
      top10: last.top10Wealth,
      fish: this.fishStock / K.fishK,
      forest: this.forestStock / K.forestK,
      debt: last.debt,
      debtRatio: last.debtRatio,
      deficitRatio: last.deficitRatio,
      lastRate: last.lastRate,
      policyRate: last.policyRate,
      inflation: last.inflation,
      moneyCreated: last.moneyCreated.bc + last.moneyCreated.banque + last.moneyCreated.etranger,
    };
    return {
      day: this.day,
      kpi,
      lorenzWealth: lorenz(wealth.map((x) => x.w)),
      lorenzIncome: lorenz(adults.map((a) => a.lastIncome)),
      wealthHist: hist,
      pyramid,
      jobs,
      firmsTable,
      goods,
      flows,
      richest: sortedW.slice(0, 15).map((x) => this.agentRow(x.a, values)),
      poorest: sortedW.slice(-15).reverse().map((x) => this.agentRow(x.a, values)),
      stateMonth: this.statePrevMonth,
      budget: this.budget,
      debtInfo: this.debtInfo(),
      causesTotal: { ...this.causesTotal },
      events: [...this.events].map(([kind, daysLeft]) => ({ kind, label: EVENT_DEFS[kind].label, daysLeft })),
      ...this.mobility(),
      news: this.news.slice(-60),
    };
  }

  private debtInfo(): Snapshot['debtInfo'] {
    let next = Infinity;
    let nextAmount = 0;
    let ha = 0;
    let hb = 0;
    for (const t of this.debt) {
      let q = 0;
      for (const [k, v] of t.holders) {
        q += v;
        if (k >= 0) ha++;
        else if (k !== CB_KEY && k !== FOREIGN_KEY) hb++;
      }
      if (t.maturity < next) {
        next = t.maturity;
        nextAmount = q;
      } else if (t.maturity === next) nextAmount += q;
    }
    return { tranches: this.debt.length, total: this.debtTotal / 100, avgRate: this.avgDebtRate(), nextMaturity: Number.isFinite(next) ? next : -1, nextAmount: nextAmount / 100, holdersAgents: ha, holdersBiz: hb };
  }

  /** Mobilité sociale : quintile d'il y a jusqu'à 5 ans → quintile du dernier relevé annuel. */
  private mobility(): { mobility: number[][]; mobilityYears: number } {
    const last = Math.floor(this.day / D);
    const years = Math.min(5, last - 1);
    const m = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
    if (years < 1) return { mobility: m, mobilityYears: 0 };
    for (const a of this.agents) {
      if (!a.alive) continue;
      const q0 = a.quintiles[last - years];
      const q1 = a.quintiles[last];
      if (q0 === undefined || q1 === undefined) continue;
      m[q0][q1]++;
    }
    return { mobility: m, mobilityYears: years };
  }

  /** Données compactes pour la carte de l'île. */
  mapState(): MapState {
    const values = this.bizValues();
    const alive = this.agents.filter((a) => a.alive);
    const adults = alive.filter((a) => a.status !== 'enfant');
    const ranked = adults.map((a) => ({ id: a.id, w: this.wealthOf(a, values) })).sort((x, y) => x.w - y.w);
    const rank = new Map<number, number>();
    ranked.forEach((x, i) => rank.set(x.id, ranked.length > 1 ? i / (ranked.length - 1) : 0.5));
    const statusIdx: Record<Status, number> = { enfant: 0, actif: 1, chomeur: 2, retraite: 3 };
    const agents: MapAgent[] = alive.map((a) => {
      const head = this.isHead(a) ? a.id : a.parent;
      const b = a.biz >= 0 ? this.businesses[a.biz] : null;
      return {
        id: a.id,
        job: a.job ? JOBS.indexOf(a.job) : -1,
        status: statusIdx[a.status],
        biz: a.biz,
        home: head,
        rank: rank.get(a.id) ?? rank.get(head) ?? 0.5,
        hunger: a.hunger,
        sick: a.sick,
        publicJob: a.publicJob,
        boss: !!b && b.owner === a.id && b.workers.length > 1,
      };
    });
    const last = this.history[this.history.length - 1];
    const flows: MapState['flows'] = [];
    for (const [k, v] of this.d.flows) {
      const [from, to] = k.split('>') as [FlowNode, FlowNode];
      if (from !== to) flows.push({ from, to, value: v / 100 });
    }
    return {
      day: this.day,
      agents,
      fish: this.fishStock / K.fishK,
      forest: this.forestStock / K.forestK,
      production: { ...(last?.production ?? {}) },
      shops: this.businesses.filter((b) => b.alive && b.job === 'commercant' && b.workers.length).length,
      flows,
      hungerRate: last?.hungerRate ?? 0,
      events: [...this.events.keys()],
    };
  }

  agentDetail(id: number) {
    const a = this.agents[id];
    if (!a) return null;
    const values = this.bizValues();
    const b = a.biz >= 0 ? this.businesses[a.biz] : null;
    return {
      ...this.agentRow(a, values),
      alive: a.alive,
      deathCause: a.deathCause,
      deathDay: a.deathDay,
      parent: a.parent >= 0 ? { id: a.parent, name: agentName(a.parent), alive: this.agents[a.parent].alive } : null,
      children: a.children.map((c) => ({ id: c, name: agentName(c), alive: this.agents[c].alive, age: Math.floor(this.ageY(this.agents[c])) })),
      inherited: a.inherited / 100,
      sick: a.sick,
      hunger: a.hunger,
      business: b
        ? { id: b.id, job: JOB_DEFS[b.job].label, workers: b.workers.length, owner: b.owner, ownerName: b.owner >= 0 ? agentName(b.owner) : 'État', cash: b.cash / 100, tools: b.tools, wage: (b.wages.get(a.id) ?? 0) / 100 }
        : null,
      shares: [...a.shares].map(([bid, s]) => ({ biz: bid, job: JOB_DEFS[this.businesses[bid].job].label, share: s, value: (s * (values.get(bid) ?? 0)) / 100 })),
      food: [...a.food].map(([g]) => ({ good: GOOD_DEFS[g].label, qty: invQty(a.food, g) })).filter((x) => x.qty > 0.01),
    };
  }

  setPolicy(p: Partial<Policy>): void {
    this.policy = { ...this.policy, ...p };
  }
}

/** Instantané complet de l'état (sans l'historique), pour revenir en arrière. */
export type SimState = Omit<Simulation, 'history'>;

export function saveState(sim: Simulation): SimState {
  const h = sim.history;
  sim.history = [];
  try {
    return structuredClone(sim) as SimState;
  } finally {
    sim.history = h;
  }
}

/** Reconstruit une simulation vivante à partir d'un instantané (copié : l'instantané reste intact). */
export function restoreState(state: SimState, history: DayStats[]): Simulation {
  const c = structuredClone(state) as Simulation;
  Object.setPrototypeOf(c, Simulation.prototype);
  Object.setPrototypeOf(c.rng, Rng.prototype);
  c.history = history;
  return c;
}
