// Définitions statiques : biens, métiers, paramètres par défaut.
// Unité monétaire : l'écu. En interne tout l'argent est en CENTIMES ENTIERS (conservation exacte).

export const GOODS = [
  'ble', 'pain', 'poisson', 'poisson_prep', 'betail', 'viande',
  'lait', 'fromage', 'oeufs', 'fruits', 'bois', 'outils', 'artisanat',
] as const;
export type Good = (typeof GOODS)[number];

export interface GoodDef {
  id: Good;
  label: string;
  /** Durée de conservation en jours. */
  shelf: number;
  /** Valeur nutritive d'une unité (1 = besoin quotidien d'un adulte). 0 = non alimentaire. */
  nutrition: number;
  /** Vendu aux ménages par les commerçants. */
  retail: boolean;
  /** Prix de gros initial (centimes). */
  wholesale0: number;
  color: string;
}

export const GOOD_DEFS: Record<Good, GoodDef> = {
  ble:          { id: 'ble',          label: 'Blé',            shelf: 60,    nutrition: 0,    retail: false, wholesale0: 108, color: '#d4a72c' },
  pain:         { id: 'pain',         label: 'Pain',           shelf: 3,     nutrition: 0.5,  retail: true,  wholesale0: 75,  color: '#b7791f' },
  poisson:      { id: 'poisson',      label: 'Poisson frais',  shelf: 2,     nutrition: 0,    retail: false, wholesale0: 85,  color: '#4fa3d1' },
  poisson_prep: { id: 'poisson_prep', label: 'Poisson préparé', shelf: 10,   nutrition: 0.5,  retail: true,  wholesale0: 112, color: '#2b6cb0' },
  betail:       { id: 'betail',       label: 'Bétail',         shelf: 120,   nutrition: 0,    retail: false, wholesale0: 500, color: '#8c5a3c' },
  viande:       { id: 'viande',       label: 'Viande',         shelf: 4,     nutrition: 0.6,  retail: true,  wholesale0: 103, color: '#c53030' },
  lait:         { id: 'lait',         label: 'Lait',           shelf: 3,     nutrition: 0.25, retail: true,  wholesale0: 25,  color: '#a0aec0' },
  fromage:      { id: 'fromage',      label: 'Fromage',        shelf: 30,    nutrition: 0.5,  retail: true,  wholesale0: 91,  color: '#ecc94b' },
  oeufs:        { id: 'oeufs',        label: 'Œufs',           shelf: 14,    nutrition: 0.25, retail: true,  wholesale0: 35,  color: '#ed8936' },
  fruits:       { id: 'fruits',       label: 'Fruits',         shelf: 10,    nutrition: 0.2,  retail: true,  wholesale0: 37,  color: '#48bb78' },
  bois:         { id: 'bois',         label: 'Bois',           shelf: 1e7,   nutrition: 0,    retail: true,  wholesale0: 121, color: '#744210' },
  outils:       { id: 'outils',       label: 'Outils',         shelf: 1e7,   nutrition: 0,    retail: false, wholesale0: 643, color: '#718096' },
  artisanat:    { id: 'artisanat',    label: 'Artisanat',      shelf: 1e7,   nutrition: 0,    retail: true,  wholesale0: 250, color: '#d53f8c' },
};

export const RETAIL_GOODS: Good[] = GOODS.filter((g) => GOOD_DEFS[g].retail);
export const FOOD_GOODS: Good[] = GOODS.filter((g) => GOOD_DEFS[g].nutrition > 0);

/** Marge initiale du commerçant (centimes par unité) pour calculer les prix de détail de départ. */
export const RETAIL_MARGIN0 = 14;

export const JOBS = [
  'cerealier', 'pecheur', 'eleveur', 'aviculteur', 'arboriculteur', 'bucheron',
  'boulanger', 'poissonnier', 'boucher', 'fromager', 'charpentier', 'artisan',
  'commercant', 'medecin', 'assureur', 'enseignant',
] as const;
export type Job = (typeof JOBS)[number];
export type JobCategory = 'production' | 'transformation' | 'commerce' | 'sante' | 'assurance' | 'service';

export type Natural =
  | { kind: 'land'; cap: number } // rendements décroissants au-delà de `cap` travailleurs
  | { kind: 'fish' }
  | { kind: 'forest' };

export interface JobDef {
  id: Job;
  label: string;
  cat: JobCategory;
  /** Intrants consommés par lot. */
  inputs: Partial<Record<Good, number>>;
  /** Produits sortis par lot. */
  outputs: Partial<Record<Good, number>>;
  /** Lots par travailleur et par jour (productivité 1, sans outils). */
  batches: number;
  natural?: Natural;
  /** Part initiale des actifs. */
  share: number;
  /** Niveau d'éducation minimal pour exercer. */
  minEdu: number;
  color: string;
}

export const JOB_DEFS: Record<Job, JobDef> = {
  cerealier:     { id: 'cerealier',     label: 'Céréalier',     cat: 'production',     inputs: {},            outputs: { ble: 1 },                  batches: 3.2,  natural: { kind: 'land', cap: 110 }, share: 0.12,  minEdu: 0,    color: '#d4a72c' },
  pecheur:       { id: 'pecheur',       label: 'Pêcheur',       cat: 'production',     inputs: {},            outputs: { poisson: 1 },              batches: 3.8,  natural: { kind: 'fish' },           share: 0.08,  minEdu: 0,    color: '#4fa3d1' },
  eleveur:       { id: 'eleveur',       label: 'Éleveur',       cat: 'production',     inputs: {},            outputs: { lait: 7.6, betail: 0.30 }, batches: 1,    natural: { kind: 'land', cap: 85 },  share: 0.09,  minEdu: 0,    color: '#8c5a3c' },
  aviculteur:    { id: 'aviculteur',    label: 'Aviculteur',    cat: 'production',     inputs: {},            outputs: { oeufs: 1 },                batches: 9.7,  share: 0.045, minEdu: 0,    color: '#ed8936' },
  arboriculteur: { id: 'arboriculteur', label: 'Arboriculteur', cat: 'production',     inputs: {},            outputs: { fruits: 1 },               batches: 9.2,  natural: { kind: 'land', cap: 65 },  share: 0.07,  minEdu: 0,    color: '#48bb78' },
  bucheron:      { id: 'bucheron',      label: 'Bûcheron',      cat: 'production',     inputs: {},            outputs: { bois: 1 },                 batches: 2.8,  natural: { kind: 'forest' },         share: 0.045, minEdu: 0,    color: '#744210' },
  boulanger:     { id: 'boulanger',     label: 'Boulanger',     cat: 'transformation', inputs: { ble: 1 },     outputs: { pain: 2 },                 batches: 6.9,  share: 0.07, minEdu: 0.2,  color: '#b7791f' },
  poissonnier:   { id: 'poissonnier',   label: 'Poissonnier',   cat: 'transformation', inputs: { poisson: 1 }, outputs: { poisson_prep: 1 },         batches: 12.3, share: 0.025, minEdu: 0.2,  color: '#2b6cb0' },
  boucher:       { id: 'boucher',       label: 'Boucher',       cat: 'transformation', inputs: { betail: 1 },  outputs: { viande: 8 },               batches: 1.05, share: 0.025, minEdu: 0.2,  color: '#c53030' },
  fromager:      { id: 'fromager',      label: 'Fromager',      cat: 'transformation', inputs: { lait: 2 },    outputs: { fromage: 1 },              batches: 8.4,  share: 0.02,  minEdu: 0.2,  color: '#ecc94b' },
  charpentier:   { id: 'charpentier',   label: 'Charpentier',   cat: 'transformation', inputs: { bois: 3 },    outputs: { outils: 1 },               batches: 1.2,  share: 0.008, minEdu: 0.3,  color: '#718096' },
  artisan:       { id: 'artisan',       label: 'Artisan',       cat: 'transformation', inputs: { bois: 0.3 },  outputs: { artisanat: 1 },            batches: 2.0,  share: 0.05,  minEdu: 0.2,  color: '#d53f8c' },
  commercant:    { id: 'commercant',    label: 'Commerçant',    cat: 'commerce',       inputs: {},            outputs: {},                          batches: 0,    share: 0.08,  minEdu: 0.3,  color: '#805ad5' },
  medecin:       { id: 'medecin',       label: 'Médecin',       cat: 'sante',          inputs: {},            outputs: {},                          batches: 0,    share: 0.02,  minEdu: 0.75, color: '#e53e3e' },
  assureur:      { id: 'assureur',      label: 'Assureur santé', cat: 'assurance',     inputs: {},            outputs: {},                          batches: 0,    share: 0.003, minEdu: 0.5,  color: '#3182ce' },
  enseignant:    { id: 'enseignant',    label: 'Enseignant',    cat: 'service',        inputs: {},            outputs: {},                          batches: 0,    share: 0.02,  minEdu: 0.6,  color: '#319795' },
};

export const MARKET_JOBS: Job[] = JOBS.filter((j) => JOB_DEFS[j].cat !== 'service');
export const PUBLIC_JOBS: Job[] = ['enseignant'];

/** Constantes du modèle (non réglables dans l'UI). */
export const K = {
  daysPerYear: 360,
  daysPerMonth: 30,
  adultAge: 16,
  schoolStart: 6,
  /** Unités vendues par jour et par commerçant (productivité 1, magasin équipé). */
  shopCapacity: 80,
  /** Gain de productivité apporté par un outil par travailleur. */
  toolBonus: 0.5,
  toolDepreciation: 0.01,
  /** Bonus d'échelle par travailleur supplémentaire dans une entreprise, plafonné. */
  scaleBonusPerWorker: 0.05,
  scaleBonusMax: 0.25,
  childNeed: 0.7,
  firewoodPerPerson: 0.1,
  foodBufferDays: 2,
  fishK: 24000,
  fishR: 0.07,
  forestK: 60000,
  forestR: 0.02,
  /** Actes (journées de soin) par médecin et par jour (productivité 1, cabinet équipé). */
  actsPerDoctor: 1,
  /** Journées de soin pour guérir une maladie grave (une maladie bénigne : 1). */
  severeActs: 10,
  /** Âge à partir duquel on consulte régulièrement (suivi). */
  followUpAge: 60,
  /** Intervalle souhaité entre deux visites de suivi (jours). */
  followUpEvery: 30,
  /** Durée de l'effet d'une visite de suivi (jours) : le plafond de santé dû à l'âge remonte. */
  careDays: 40,
  /** Personnes qu'un assureur gère (productivité 1). */
  contractsPerInsurer: 1000,
  pupilsPerTeacher: 25,
  /** Usure quotidienne des biens d'artisanat possédés par les ménages. */
  comfortWear: 0.01,
  /** Jours de nourriture gardés en épargne de précaution avant toute dépense de confort. */
  savingsBufferDays: 20,
  /** Trésorerie visée par l'État, en jours de dépenses : il emprunte pour la maintenir. */
  treasuryDays: 20,
  /** Durée des obligations d'État (jours) ; coupon versé chaque mois. */
  bondMaturity: 360,
  /** Coussin de précaution d'un ménage avant de placer son épargne (jours de dépenses). */
  bondCushionDays: 30,
  /** Taux maximal que l'État accepte de payer lors d'une enchère (annuel). */
  bondMaxRate: 0.25,
  /** Taux auquel les investisseurs étrangers prêtent à un État sans risque (annuel). */
  worldRate: 0.03,
  /** Durée des crédits bancaires (mois, remboursement à annuités constantes en capital). */
  loanMonths: 24,
};

export type FiscalRule = 'equilibre' | 'cibleDeficit' | 'freinDette';

export const FISCAL_RULES: Record<FiscalRule, string> = {
  equilibre: 'Équilibre',
  cibleDeficit: 'Déficit plafonné',
  freinDette: 'Frein à l’endettement',
};

export interface Policy {
  // Impôts
  incomeTaxLow: number; // taux sur la tranche basse du revenu mensuel
  incomeTaxHigh: number; // taux au-delà du seuil
  incomeTaxThreshold: number; // écus / mois
  vat: number;
  corporateTax: number; // sur le bénéfice mensuel des entreprises
  wealthTax: number; // taux annuel sur le patrimoine au-delà du seuil
  wealthTaxThreshold: number; // écus
  inheritanceTax: number;
  // Dépenses
  teachersPer1000: number;
  publicSalary: number; // écus / jour
  pension: number; // écus / jour
  retirementAge: number;
  ubi: number; // revenu universel, écus / jour / adulte
  socialAidThreshold: number; // écus par membre du foyer : en dessous, l'État complète
  socialAidAmount: number; // écus / jour / membre du foyer
  // Santé : sécurité sociale (cotisation sur les revenus, remboursement d'une part d'un tarif de référence)
  secuContribution: number; // part des revenus du mois prélevée pour l'assurance maladie publique
  secuRate: number; // part du tarif de référence remboursée par la sécurité sociale (0 = pas de sécu)
  secuTariff: number; // écus par acte : tarif de référence (indexé), au-delà = dépassement d'honoraires
  secuRatePoor: number; // part des honoraires remboursée aux foyers modestes (épargne < 4 × seuil de l'aide sociale)
  // Santé : assurance privée (contrat standard réglementé, vendu par les assureurs)
  insuranceMandatory: boolean; // chaque foyer doit s'assurer
  insuranceCoverage: number; // part du reste à charge (après sécu) prise en charge par l'assureur
  insuranceRiskRating: number; // 0 = prime identique pour tous, 1 = prime selon le risque lié à l'âge
  premiumIncomeCap: number; // subside : la prime d'un foyer ne dépasse pas cette part de son revenu (0 = pas de subside)
  insuranceMinLossRatio: number; // part minimale des primes reversée en soins, le surplus est remboursé (0 = libre)
  indexation: boolean; // pensions, aides, salaires publics et minimum suivent l'IPC
  surplusDays: number; // au-delà de N jours de dépenses en trésorerie, l'excédent est reversé aux habitants (0 = jamais)
  schoolMeals: number; // cantines : nutrition fournie par enfant et par jour (pain et fruits achetés en gros)
  // Budget et dette
  fiscalRule: FiscalRule; // règle budgétaire appliquée au budget annuel
  deficitTarget: number; // déficit maximal (part du PIB annuel) pour la règle « cibleDeficit »
  debtCeiling: number; // plafond de dette (part du PIB annuel), 0 = aucun ; s'applique à toutes les règles
  disasterRelief: number; // aide d'urgence après une catastrophe, part des pertes estimées
  // Monnaie, banques et dette extérieure
  inflationTarget: number; // cible d'inflation annuelle de la banque centrale
  cbFinancing: number; // part maximale de la dette publique que la banque centrale peut détenir (0 = interdit)
  creditLimit: number; // encours maximal des crédits bancaires aux entreprises (part du PIB), 0 = pas de crédit
  bankSpread: number; // marge de la banque au-dessus du taux directeur (annuelle)
  foreignDebtCap: number; // part maximale de la dette détenue à l'étranger (part du PIB), 0 = île fermée
  // Réglementation
  minWage: number; // écus / jour
  shopRent: number; // écus / jour / commerce (taxe sur les locaux)
  fishingQuota: number; // unités / jour, 0 = pas de quota
  loggingQuota: number; // unités / jour, 0 = pas de quota
}

export const DEFAULT_POLICY: Policy = {
  incomeTaxLow: 0.08,
  incomeTaxHigh: 0.22,
  incomeTaxThreshold: 150,
  vat: 0.09,
  corporateTax: 0.1,
  wealthTax: 0,
  wealthTaxThreshold: 2000,
  inheritanceTax: 0.2,
  teachersPer1000: 12,
  publicSalary: 5.5,
  pension: 3.5,
  retirementAge: 65,
  ubi: 0,
  socialAidThreshold: 8,
  socialAidAmount: 2.5,
  secuContribution: 0.02,
  secuRate: 0.8,
  secuTariff: 4,
  secuRatePoor: 1,
  insuranceMandatory: false,
  insuranceCoverage: 1,
  insuranceRiskRating: 1,
  premiumIncomeCap: 0,
  insuranceMinLossRatio: 0,
  indexation: true,
  surplusDays: 0,
  schoolMeals: 0.4,
  fiscalRule: 'cibleDeficit',
  deficitTarget: 0.03,
  debtCeiling: 0.2,
  disasterRelief: 0.5,
  inflationTarget: 0.02,
  cbFinancing: 0.3,
  creditLimit: 0.15,
  bankSpread: 0.03,
  foreignDebtCap: 0.05,
  minWage: 2.5,
  shopRent: 1.5,
  fishingQuota: 0,
  loggingQuota: 0,
};

export interface InitConfig {
  seed: number;
  population: number;
  moneyPerInhabitant: number; // écus
  stateShare: number; // part de la masse monétaire initiale détenue par l'État
}

export const DEFAULT_INIT: InitConfig = {
  seed: 42,
  population: 1000,
  moneyPerInhabitant: 300,
  stateShare: 0.1,
};

export type EventKind = 'mauvaise_recolte' | 'tempete' | 'epidemie' | 'incendie';

export const EVENT_DEFS: Record<EventKind, { label: string; days: number; desc: string }> = {
  mauvaise_recolte: { label: 'Mauvaise récolte', days: 90, desc: 'Blé, fruits et élevage à −50 % pendant 90 jours' },
  tempete: { label: 'Tempête', days: 30, desc: 'Pêche impossible 30 jours, 30 % des outils détruits' },
  epidemie: { label: 'Épidémie', days: 45, desc: 'Risque de maladie ×8 pendant 45 jours' },
  incendie: { label: 'Incendie de forêt', days: 1, desc: 'La forêt perd 60 % de son stock' },
};
