//! Simulation multi-agents de l'île (port fidèle de `src/sim/sim.ts`).
//!
//! Les identifiants d'habitants et d'entreprises sont leurs indices dans `agents` et `businesses`.
//! L'argent est en centimes entiers stockés en f64, comme dans la version TypeScript : on garde la
//! même arithmétique flottante pour reproduire exactement les trajectoires calibrées.

mod demography;
mod finance;
mod health;
mod init;
mod monthly;
mod production;
mod retail;
mod stats;
mod ui;
mod wholesale;

pub use stats::DayStats;
pub use ui::{AgentRow, AgentsQuery};

use crate::config::*;
use crate::util::*;
use serde::{Serialize, Serializer};

pub const STATE_ID: i64 = -1;

#[cfg(feature = "profile")]
thread_local! {
    /// Temps cumulé par phase de la journée (secondes).
    pub static PROFILE: std::cell::RefCell<[f64; 32]> = const { std::cell::RefCell::new([0.0; 32]) };
}
#[cfg(feature = "profile")]
pub const PHASES: [&str; 32] = [
    "événements", "recensement", "équipements publics", "repousse", "péremption", "capacités", "production", "marché de gros",
    "marché de détail", "consommation", "vols", "santé", "finances entreprises", "versements État", "école", "démographie",
    "VA sectorielle", "reconversions", "mensuel", "statistiques",
    "  détail : offres", "  détail : ordres des ménages", "  détail : enchères", "  détail : marges", "  détail : IPC",
    "  détail : autoconsommation", "  conso : tri", "  conso : manger", "  conso : chauffage", "    enchère (tri)", "    transfert de stock", "-",
];

/// Chronomètre un bloc (fonctionnalité `profile`).
#[macro_export]
macro_rules! prof {
    ($i:expr, $e:block) => {{
        #[cfg(feature = "profile")]
        let t0 = std::time::Instant::now();
        let r = $e;
        #[cfg(feature = "profile")]
        $crate::sim::PROFILE.with(|p| p.borrow_mut()[$i] += t0.elapsed().as_secs_f64());
        r
    }};
}
/// Détenteurs spéciaux d'obligations : banque centrale et investisseurs étrangers.
pub const CB_KEY: i64 = -1;
pub const FOREIGN_KEY: i64 = -1_000_000_000;
pub const D: f64 = k::DAYS_PER_YEAR;

pub type GoodOpt = [Option<f64>; NG];
pub const NO_GOODS: GoodOpt = [None; NG];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Enfant,
    Actif,
    Chomeur,
    Retraite,
}
impl Status {
    pub fn id(self) -> &'static str {
        match self {
            Status::Enfant => "enfant",
            Status::Actif => "actif",
            Status::Chomeur => "chomeur",
            Status::Retraite => "retraite",
        }
    }
}
impl Serialize for Status {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.id())
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DeathCause {
    Age = 0,
    Faim = 1,
    Maladie = 2,
}
impl DeathCause {
    pub fn id(self) -> &'static str {
        match self {
            DeathCause::Age => "age",
            DeathCause::Faim => "faim",
            DeathCause::Maladie => "maladie",
        }
    }
}

/// Nœuds des flux d'argent (diagramme de Sankey).
pub type FlowNode = u8;
pub const MENAGES: FlowNode = 0;
pub const F_PRODUCTION: FlowNode = 1;
pub const F_TRANSFORMATION: FlowNode = 2;
pub const F_COMMERCE: FlowNode = 3;
pub const F_SANTE: FlowNode = 4;
pub const F_ASSURANCE: FlowNode = 5;
pub const ETAT: FlowNode = 6;
pub const FLOW_IDS: [&str; 7] = ["menages", "production", "transformation", "commerce", "sante", "assurance", "etat"];
pub type Flows = FlowMap;

// Recettes et dépenses publiques
pub type RevKey = usize;
pub const NREV: usize = 11;
pub const TVA: RevKey = 0;
pub const IMPOT_REVENU: RevKey = 1;
pub const IMPOT_SOCIETES: RevKey = 2;
pub const IMPOT_FORTUNE: RevKey = 3;
pub const SUCCESSION: RevKey = 4;
pub const LOYERS: RevKey = 5;
pub const COTISATIONS_SANTE: RevKey = 6;
pub const DIVIDENDES: RevKey = 7;
pub const PROFITS_BC: RevKey = 8;
pub const TAXE_CARBONE: RevKey = 9;
pub const VENTES_PUBLIQUES: RevKey = 10;
pub const REV_IDS: [&str; NREV] = [
    "tva", "impotRevenu", "impotSocietes", "impotFortune", "succession", "loyers", "cotisationsSante", "dividendes",
    "profitsBC", "taxeCarbone", "ventesPubliques",
];

pub type SpendKey = usize;
pub const NSPEND: usize = 21;
pub const EDUCATION: SpendKey = 0;
pub const ADMINISTRATION: SpendKey = 1;
pub const SECURITE: SpendKey = 2;
pub const SANTE_PUBLIQUE: SpendKey = 3;
pub const ENVIRONNEMENT: SpendKey = 4;
pub const PENSIONS: SpendKey = 5;
pub const AIDE_SOCIALE: SpendKey = 6;
pub const ALLOCATIONS_FAMILIALES: SpendKey = 7;
pub const INDEMNITES_MALADIE: SpendKey = 8;
pub const CHOMAGE: SpendKey = 9;
pub const REVENU_UNIVERSEL: SpendKey = 10;
pub const REMBOURSEMENTS_SANTE: SpendKey = 11;
pub const SUBSIDES_PRIMES: SpendKey = 12;
pub const CANTINES: SpendKey = 13;
pub const INVESTISSEMENT: SpendKey = 14;
pub const LOGEMENT: SpendKey = 15;
pub const CULTURE: SpendKey = 16;
pub const AGRICULTURE: SpendKey = 17;
pub const AIDE_URGENCE: SpendKey = 18;
pub const INTERETS: SpendKey = 19;
pub const REDISTRIBUTION: SpendKey = 20;
pub const SPEND_IDS: [&str; NSPEND] = [
    "education", "administration", "securite", "santePublique", "environnement", "pensions", "aideSociale",
    "allocationsFamiliales", "indemnitesMaladie", "chomage", "revenuUniversel", "remboursementsSante", "subsidesPrimes",
    "cantines", "investissement", "logement", "culture", "agriculture", "aideUrgence", "interets", "redistribution",
];
/// Postes hors règle budgétaire (exceptionnels ou contreparties).
pub fn off_budget(k: SpendKey) -> bool {
    k == AIDE_URGENCE || k == INTERETS || k == REDISTRIBUTION
}
/// Poste budgétaire des salaires de chaque fonction publique.
pub fn staff_key(j: Job) -> SpendKey {
    match j {
        ENSEIGNANT => EDUCATION,
        ADMINISTRATEUR => ADMINISTRATION,
        POLICIER => SECURITE,
        INFIRMIER => SANTE_PUBLIQUE,
        GARDE => ENVIRONNEMENT,
        _ => INVESTISSEMENT,
    }
}

/// Origines de la monnaie créée.
pub const BC: usize = 0;
pub const BANQUE: usize = 1;
pub const ETRANGER: usize = 2;

/// Classe de risque santé selon l'âge (1 = adulte de 40 à 59 ans).
pub fn risk_class(age_y: f64) -> f64 {
    if age_y < 16.0 {
        0.5
    } else if age_y < 40.0 {
        0.6
    } else if age_y < 60.0 {
        1.0
    } else if age_y < 75.0 {
        2.2
    } else {
        3.5
    }
}

const FIRST: [&str; 40] = [
    "Ana", "Bastien", "Chloé", "Dario", "Élise", "Fabien", "Gaëlle", "Hugo", "Inès", "Jules", "Katia", "Léo", "Maëlle", "Noé",
    "Olga", "Pablo", "Quentin", "Rose", "Sacha", "Tilio", "Ulla", "Victor", "Wanda", "Yann", "Zoé", "Aurèle", "Bérénice", "Côme",
    "Dina", "Ewan", "Flore", "Gaspard", "Hélène", "Ilan", "Jade", "Kenzo", "Lou", "Marius", "Nina", "Oscar",
];
const LAST: [&str; 20] = [
    "Marin", "Dupré", "Lebois", "Fournier", "Pêcheux", "Moulin", "Berger", "Laforêt", "Meunier", "Boucher", "Rivière", "Rocher",
    "Sablon", "Vallée", "Corail", "Goéland", "Ponant", "Levant", "Brume", "Salin",
];
pub fn agent_name(id: i64) -> String {
    let id = id.max(0) as usize;
    format!("{} {}", FIRST[(id * 7) % FIRST.len()], LAST[(id * 13 + id / FIRST.len()) % LAST.len()])
}

/// « du pain », « de la viande »… pour la gazette.
pub const OF_GOOD: [&str; NG] = [
    "du blé", "du pain", "du poisson frais", "du poisson préparé", "du bétail", "de la viande", "du lait", "du fromage",
    "des œufs", "des fruits", "du bois", "des outils", "de l’artisanat", "de l’énergie",
];

#[derive(Clone)]
pub struct Agent {
    pub id: usize,
    pub alive: bool,
    pub born: i64,
    pub parent: i64,
    pub children: Vec<usize>,
    pub money: f64,
    pub edu: f64,
    pub xp: f64,
    pub health: f64,
    pub sick: bool,
    pub severe: bool,
    pub care_need: f64,
    pub status: Status,
    pub job: Option<Job>,
    pub biz: i64,
    pub public_job: bool,
    pub food: Inv,
    pub fed: f64,
    pub hunger: f64,
    pub cold: bool,
    pub appetite: f64,
    pub income: f64,
    pub last_income: f64,
    pub prefs: GoodOpt,
    pub shares: OrderedMap<usize, f64>,
    pub death_day: i64,
    pub death_cause: Option<DeathCause>,
    pub job_since: i64,
    pub inherited: f64,
    pub insurer: i64,
    pub last_care: f64,
    pub care_until: f64,
    /// Quintile de patrimoine par année (-1 = pas de relevé).
    pub quintiles: Vec<i8>,
    pub bonds: f64,
}

#[derive(Clone)]
pub struct Business {
    pub id: usize,
    pub alive: bool,
    pub job: Job,
    pub owner: i64,
    pub shares: OrderedMap<i64, f64>,
    pub workers: Vec<usize>,
    pub wages: OrderedMap<usize, f64>,
    pub cash: f64,
    pub inv: Inv,
    pub tools: f64,
    pub ask: GoodOpt,
    pub bid: GoodOpt,
    pub retail: GoodOpt,
    pub avg_cost: GoodOpt,
    pub sales_ema: GoodOpt,
    pub out_sales: GoodOpt,
    pub prod_ema: GoodOpt,
    pub potential: f64,
    pub rev_day: f64,
    pub cost_day: f64,
    pub cost_ema: f64,
    pub rev_month: f64,
    pub input_month: f64,
    pub wage_month: f64,
    pub other_month: f64,
    pub va_per_worker: f64,
    pub va_ema: f64,
    pub input_day: f64,
    pub profit_last_month: f64,
    pub arrears: f64,
    pub offer_wage: f64,
    pub vacancies: f64,
    pub founded: i64,
    pub fee: f64,
    pub acts_day: f64,
    pub occupancy: f64,
    pub premium: f64,
    pub markup: f64,
    pub insured_n: f64,
    pub insured_units: f64,
    pub premiums_month: f64,
    pub claims_month: f64,
    pub unit_days: f64,
    pub claims_per_unit: f64,
    pub lost_month: f64,
    pub bonds: f64,
}

#[derive(Clone)]
pub struct Bond {
    pub id: i64,
    pub issued: i64,
    pub maturity: i64,
    pub rate: f64,
    pub holders: OrderedMap<i64, f64>,
}

#[derive(Clone, Serialize)]
pub struct Budget {
    pub day: i64,
    pub rule: FiscalRule,
    pub revenue: f64,
    pub gdp: f64,
    #[serde(serialize_with = "ser_spend")]
    pub needs: [f64; NSPEND],
    #[serde(serialize_with = "ser_spend")]
    pub envelopes: [f64; NSPEND],
    #[serde(rename = "allowedDeficit")]
    pub allowed_deficit: f64,
    pub planned: f64,
    pub cut: f64,
}

#[derive(Clone)]
pub struct Loan {
    pub biz: usize,
    pub principal: f64,
    pub rate: f64,
    pub months_left: f64,
    pub missed: f64,
}

#[derive(Clone)]
pub struct MonthLog {
    pub rev: f64,
    pub spend: f64,
    pub gdp: f64,
    pub ix: f64,
    pub cut: f64,
    pub bought: [f64; NSPEND],
    pub needs: [f64; NSPEND],
}

#[derive(Clone)]
pub struct Relief {
    pub biz: usize,
    pub left: f64,
    pub daily: f64,
}

#[derive(Clone, Serialize)]
pub struct NewsItem {
    pub day: i64,
    pub kind: &'static str,
    pub text: String,
}

#[derive(Clone, Serialize)]
pub struct StateMonth {
    #[serde(serialize_with = "ser_rev")]
    pub revenue: [f64; NREV],
    #[serde(serialize_with = "ser_spend")]
    pub spending: [f64; NSPEND],
}
impl StateMonth {
    fn zero() -> StateMonth {
        StateMonth { revenue: [0.0; NREV], spending: [0.0; NSPEND] }
    }
}

pub fn ser_keys<S: Serializer>(ids: &[&str], v: &[f64], s: S) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;
    let mut m = s.serialize_map(Some(ids.len()))?;
    for (k, x) in ids.iter().zip(v) {
        m.serialize_entry(k, x)?;
    }
    m.end()
}
pub fn ser_rev<S: Serializer>(v: &[f64; NREV], s: S) -> Result<S::Ok, S::Error> {
    ser_keys(&REV_IDS, v, s)
}
pub fn ser_spend<S: Serializer>(v: &[f64; NSPEND], s: S) -> Result<S::Ok, S::Error> {
    ser_keys(&SPEND_IDS, v, s)
}

/// Compteurs du jour.
#[derive(Clone)]
pub struct Daily {
    pub births: f64,
    pub self_consumed: f64,
    pub deaths: [f64; 3],
    pub gdp: f64,
    pub wholesale_value: f64,
    pub retail_volume: GoodOpt,
    pub wholesale_volume: GoodOpt,
    pub production: GoodOpt,
    pub waste: GoodOpt,
    pub unmet: GoodOpt,
    pub revenue: [f64; NREV],
    pub spending: [f64; NSPEND],
    pub paid_ratio: f64,
    pub flows: Flows,
    pub care_acts: f64,
    pub care_denied: f64,
    pub care_no_doctor: f64,
    pub sick_untreated: f64,
    /// ménages, sécu, assurance
    pub care_spend: [f64; 3],
    pub borrowing: f64,
    pub repayment: f64,
    /// pétrole, gaz, vert
    pub energy_by_source: [f64; 3],
    /// machines, ménages
    pub energy_use: [f64; 2],
    pub emissions: f64,
    pub thefts: f64,
    pub silo_trade: f64,
    pub cold: f64,
    pub death_ages: f64,
    pub infant_deaths: f64,
}

impl Daily {
    fn fresh() -> Daily {
        Daily {
            births: 0.0,
            self_consumed: 0.0,
            deaths: [0.0; 3],
            gdp: 0.0,
            wholesale_value: 0.0,
            retail_volume: NO_GOODS,
            wholesale_volume: NO_GOODS,
            production: NO_GOODS,
            waste: NO_GOODS,
            unmet: NO_GOODS,
            revenue: [0.0; NREV],
            spending: [0.0; NSPEND],
            paid_ratio: 1.0,
            flows: Flows::new(),
            care_acts: 0.0,
            care_denied: 0.0,
            care_no_doctor: 0.0,
            sick_untreated: 0.0,
            care_spend: [0.0; 3],
            borrowing: 0.0,
            repayment: 0.0,
            energy_by_source: [0.0; 3],
            energy_use: [0.0; 2],
            emissions: 0.0,
            thefts: 0.0,
            silo_trade: 0.0,
            cold: 0.0,
            death_ages: 0.0,
            infant_deaths: 0.0,
        }
    }
}

#[derive(Clone, Default)]
pub struct LastGini {
    pub w: f64,
    pub i: f64,
    pub top10: f64,
    pub bottom50: f64,
}

#[derive(Clone)]
pub struct Simulation {
    pub day: i64,
    /// Mode de compatibilité avec la version TypeScript (voir `InitConfig::legacy`).
    pub legacy: bool,
    pub rng: Rng,
    pub policy: Policy,
    pub init: InitConfig,
    pub agents: Vec<Agent>,
    pub businesses: Vec<Business>,
    /// Identifiants des habitants et entreprises en vie, par ordre croissant : les boucles ne
    /// parcourent qu'eux (les disparus s'accumulent sur de longues périodes).
    pub alive_agents: Vec<usize>,
    pub alive_biz: Vec<usize>,
    /// Disparus depuis le dernier compactage mensuel.
    dead_agents_pending: Vec<usize>,
    dead_biz_pending: Vec<usize>,
    pub treasury: f64,
    pub initial_money: f64,
    pub fish_stock: f64,
    pub forest_stock: f64,
    /// Événements en cours (ordre d'insertion), jours restants.
    pub events: Vec<(EventKind, i64)>,
    pub last_w: [f64; NG],
    pub last_r: [f64; NG],
    pub retail_demand: [f64; NG],
    pub retail_unmet: [f64; NG],
    pub wholesale_unmet: [f64; NG],
    last_w_demand: [f64; NG],
    cap_by_good: [f64; NG],
    shop_cap_total: f64,
    pub cpi_chain: f64,
    /// Poids de l'IPC chaîné, dans l'ordre de déclaration de la version TS.
    cpi_share: Vec<(Good, f64)>,
    pub sector_income: [f64; NJ],
    pub avg_income: f64,
    pub sector_va: [f64; NJ],
    /// Historique quotidien. `history_offset` = nombre de jours déjà retirés du début (mode sans interface).
    pub history: Vec<DayStats>,
    pub history_offset: usize,
    /// Nombre maximal de jours gardés (0 = tout garder).
    pub history_cap: usize,
    pub causes_total: [f64; 3],
    pub flows_month: Flows,
    pub flows_prev: Flows,
    pub state_month: StateMonth,
    pub state_prev_month: StateMonth,
    pub money_error: f64,
    pub news: Vec<NewsItem>,
    record_firm: f64,
    pub cpi_index: f64,
    pub avg_fee: f64,
    pub care_shortage: f64,

    // budget et dette publique
    pub debt: Vec<Bond>,
    pub debt_total: f64,
    next_bond_id: i64,
    pub budget: Option<Budget>,
    pub budget_cut: f64,
    need_month: [f64; NSPEND],
    pub month_log: Vec<MonthLog>,
    month_gdp: f64,
    pub debt_stress: f64,
    pub last_rate: f64,
    debt_record: f64,
    pub pending_relief: Vec<Relief>,
    state_bid: GoodOpt,
    bought_month: [f64; NSPEND],

    // services publics, infrastructures, environnement, énergie
    pub infra: f64,
    pub housing: f64,
    /// Foyers logés (indexé par id du chef de foyer).
    pub housed: Vec<bool>,
    pub land_bonus: f64,
    pub school_cov: f64,
    pub culture_cov: f64,
    pub silo: Inv,
    pub pop_n: f64,
    pub kids_n: f64,
    pub staff_n: [f64; NJ],
    env_sick: f64,
    pub tax_eff: f64,
    pub oil_reserve: f64,
    pub gas_reserve: f64,
    pub pollution: f64,
    last_debt_holders: [f64; 8],

    // monnaie, banques, reste du monde
    pub money_base: f64,
    pub money_created: [f64; 3],
    pub cb_bonds: f64,
    pub foreign_bonds: f64,
    pub policy_rate: f64,
    pub inflation: f64,
    pub loans: Vec<Loan>,
    pub bank_loans_total: f64,
    pub bank_equity: f64,
    bank_income_month: f64,
    cpi_log: Vec<f64>,

    pub d: Daily,
    last_gini: LastGini,
    last_p9010: f64,
    mean_money: f64,
}

impl Simulation {
    pub fn new(init: InitConfig, policy: Policy) -> Simulation {
        let rng = Rng::with_mode(init.seed, init.legacy);
        let mut last_w = [0.0; NG];
        let mut last_r = [0.0; NG];
        for g in 0..NG {
            last_w[g] = GOOD_DEFS[g].wholesale0;
            last_r[g] = (GOOD_DEFS[g].wholesale0 + RETAIL_MARGIN0) * (1.0 + policy.vat);
        }
        let mut retail_demand = [0.0; NG];
        for g in RETAIL_GOODS {
            retail_demand[g] = match g {
                BOIS => 100.0,
                ENERGIE => 50.0,
                ARTISANAT => 150.0,
                _ => 400.0,
            };
        }
        let mut s = Simulation {
            day: 0,
            legacy: init.legacy,
            rng,
            policy,
            init,
            agents: Vec::new(),
            businesses: Vec::new(),
            alive_agents: Vec::new(),
            alive_biz: Vec::new(),
            dead_agents_pending: Vec::new(),
            dead_biz_pending: Vec::new(),
            treasury: 0.0,
            initial_money: 0.0,
            fish_stock: k::FISH_K * 0.6,
            forest_stock: k::FOREST_K * 0.7,
            events: Vec::new(),
            last_w,
            last_r,
            retail_demand,
            retail_unmet: [0.0; NG],
            wholesale_unmet: [0.0; NG],
            last_w_demand: [0.0; NG],
            cap_by_good: [0.0; NG],
            shop_cap_total: 1.0,
            cpi_chain: 100.0,
            cpi_share: vec![
                (PAIN, 0.33),
                (POISSON_PREP, 0.14),
                (VIANDE, 0.11),
                (FROMAGE, 0.08),
                (LAIT, 0.08),
                (OEUFS, 0.09),
                (FRUITS, 0.11),
                (BOIS, 0.03),
                (ENERGIE, 0.03),
            ],
            sector_income: [0.0; NJ],
            avg_income: 400.0,
            sector_va: [400.0; NJ],
            history: Vec::new(),
            history_offset: 0,
            history_cap: 0,
            causes_total: [0.0; 3],
            flows_month: Flows::new(),
            flows_prev: Flows::new(),
            state_month: StateMonth::zero(),
            state_prev_month: StateMonth::zero(),
            money_error: 0.0,
            news: Vec::new(),
            record_firm: 2.0,
            cpi_index: 100.0,
            avg_fee: 0.0,
            care_shortage: 0.0,
            debt: Vec::new(),
            debt_total: 0.0,
            next_bond_id: 1,
            budget: None,
            budget_cut: 1.0,
            need_month: [0.0; NSPEND],
            month_log: Vec::new(),
            month_gdp: 0.0,
            debt_stress: 0.0,
            last_rate: 0.0,
            debt_record: 0.05,
            pending_relief: Vec::new(),
            state_bid: NO_GOODS,
            bought_month: [0.0; NSPEND],
            infra: 0.0,
            housing: 0.0,
            housed: Vec::new(),
            land_bonus: 0.0,
            school_cov: 1.0,
            culture_cov: 1.0,
            silo: Inv::new(),
            pop_n: 1.0,
            kids_n: 0.0,
            staff_n: [0.0; NJ],
            env_sick: 1.0,
            tax_eff: 1.0,
            oil_reserve: k::OIL_RESERVE,
            gas_reserve: k::GAS_RESERVE,
            pollution: 0.0,
            last_debt_holders: [0.0; 8],
            money_base: 0.0,
            money_created: [0.0; 3],
            cb_bonds: 0.0,
            foreign_bonds: 0.0,
            policy_rate: 0.02,
            inflation: 0.0,
            loans: Vec::new(),
            bank_loans_total: 0.0,
            bank_equity: 0.0,
            bank_income_month: 0.0,
            cpi_log: Vec::new(),
            d: Daily::fresh(),
            last_gini: LastGini::default(),
            last_p9010: 1.0,
            mean_money: 1.0,
        };
        s.populate();
        s.record_stats();
        s
    }

    /// Construit depuis des réglages partiels (objets JSON `Partial<InitConfig>`, `Partial<Policy>`).
    pub fn from_json(init: &serde_json::Value, policy: &serde_json::Value) -> Simulation {
        Simulation::new(default_init().merged(init), default_policy().merged(policy))
    }

    // =========================================================================
    // Helpers

    /// Habitants en vie (copie de la liste : on peut modifier la simulation en la parcourant).
    #[inline]
    pub fn aa(&self) -> Vec<usize> {
        self.alive_agents.clone()
    }
    /// Entreprises en vie (copie de la liste).
    #[inline]
    pub fn ab(&self) -> Vec<usize> {
        self.alive_biz.clone()
    }
    pub(crate) fn mark_agent_dead(&mut self, a: usize) {
        if let Ok(i) = self.alive_agents.binary_search(&a) {
            self.alive_agents.remove(i);
        }
        self.dead_agents_pending.push(a);
    }
    pub(crate) fn mark_biz_dead(&mut self, b: usize) {
        if let Ok(i) = self.alive_biz.binary_search(&b) {
            self.alive_biz.remove(i);
        }
        self.dead_biz_pending.push(b);
    }

    #[inline]
    pub fn age_y(&self, a: usize) -> f64 {
        (self.day - self.agents[a].born) as f64 / D
    }
    #[inline]
    pub fn is_head(&self, a: usize) -> bool {
        let ag = &self.agents[a];
        if !ag.alive {
            return false;
        }
        if self.age_y(a) >= k::ADULT_AGE {
            return true;
        }
        ag.parent < 0 || !self.agents[ag.parent as usize].alive
    }
    pub fn dependents(&self, a: usize) -> Vec<usize> {
        let mut out = Vec::new();
        for &c in &self.agents[a].children {
            if self.agents[c].alive && self.age_y(c) < k::ADULT_AGE {
                out.push(c);
            }
        }
        out
    }
    #[inline]
    pub fn n_dependents(&self, a: usize) -> usize {
        let mut n = 0;
        for &c in &self.agents[a].children {
            if self.agents[c].alive && self.age_y(c) < k::ADULT_AGE {
                n += 1;
            }
        }
        n
    }
    #[inline]
    pub fn household_size(&self, a: usize) -> f64 {
        1.0 + self.n_dependents(a) as f64
    }
    #[inline]
    pub fn need_of(&self, a: usize) -> f64 {
        if self.age_y(a) < k::ADULT_AGE { k::CHILD_NEED } else { 1.0 }
    }
    pub fn household_need(&self, a: usize) -> f64 {
        let mut n = self.need_of(a);
        for &c in &self.agents[a].children {
            if self.agents[c].alive && self.age_y(c) < k::ADULT_AGE {
                n += self.need_of(c);
            }
        }
        n
    }
    #[inline]
    pub fn productivity(&self, a: usize) -> f64 {
        let ag = &self.agents[a];
        if !ag.alive || ag.sick {
            return 0.0;
        }
        (0.7 + 0.6 * ag.edu) * (0.5 + (0.5 * ag.health) / 100.0) * (0.85 + 0.3 * ag.xp)
    }
    pub fn max_health(&self, a: usize) -> f64 {
        100.0 - mx(0.0, self.age_y(a) - 45.0) * 0.9
    }
    pub fn cat_of(&self, b: usize) -> FlowNode {
        match JOB_DEFS[self.businesses[b].job].cat {
            Cat::Production => F_PRODUCTION,
            Cat::Transformation => F_TRANSFORMATION,
            Cat::Commerce => F_COMMERCE,
            Cat::Sante => F_SANTE,
            Cat::Assurance => F_ASSURANCE,
            Cat::Service => ETAT,
        }
    }
    pub(crate) fn flow(&mut self, from: FlowNode, to: FlowNode, cents: f64) {
        if !(cents > 0.0) {
            // JS : `if (cents <= 0) return` (NaN passe)
            if cents <= 0.0 {
                return;
            }
        }
        self.flows_month.add(from, to, cents);
        self.d.flows.add(from, to, cents);
    }
    pub fn say(&mut self, kind: &'static str, text: String) {
        self.news.push(NewsItem { day: self.day, kind, text });
        if self.news.len() > 300 {
            let n = self.news.len() - 300;
            self.news.drain(0..n);
        }
    }
    #[inline]
    pub(crate) fn pay_agent(&mut self, a: usize, cents: f64, taxable: bool) {
        let ag = &mut self.agents[a];
        ag.money += cents;
        if taxable {
            ag.income += cents;
        }
    }
    #[inline]
    pub(crate) fn ask_of(&mut self, b: usize, g: Good) -> f64 {
        let lw = self.last_w[g];
        *self.businesses[b].ask[g].get_or_insert(lw)
    }
    #[inline]
    pub(crate) fn bid_of(&mut self, b: usize, g: Good) -> f64 {
        let lw = self.last_w[g];
        *self.businesses[b].bid[g].get_or_insert(lw)
    }
    /// Revenu de référence ramené à un lot de production (centimes).
    pub fn labor_per_batch(&self, job: Job) -> f64 {
        self.avg_income / mx(0.1, JOB_DEFS[job].batches * 1.3)
    }
    pub(crate) fn markup_of(&mut self, b: usize, g: Good) -> f64 {
        *self.businesses[b].retail[g].get_or_insert(1.15)
    }
    /// Prix de détail TTC affiché.
    pub(crate) fn retail_of(&mut self, b: usize, g: Good) -> f64 {
        let cost = self.businesses[b].avg_cost[g].unwrap_or(self.last_w[g]) + (self.avg_income / k::SHOP_CAPACITY) * 0.5;
        cost * self.markup_of(b, g) * (1.0 + self.policy.vat)
    }
    pub fn biz_value(&self, b: usize) -> f64 {
        let x = &self.businesses[b];
        let mut v = x.cash + x.bonds + x.tools * self.last_w[OUTILS] * 0.7;
        for (g, batches) in x.inv.iter() {
            for y in batches {
                v += y.q * self.last_w[g];
            }
        }
        v
    }
    pub(crate) fn recompute_owner(&mut self, b: usize) {
        let mut best: i64 = -1;
        let mut best_s = -1.0;
        for (&id, &s) in &self.businesses[b].shares {
            if id == STATE_ID {
                continue;
            }
            if s > best_s {
                best_s = s;
                best = id;
            }
        }
        let biz = &mut self.businesses[b];
        if best >= 0 && best != biz.owner {
            biz.owner = best;
            biz.wages.shift_remove(&(best as usize));
        } else if best < 0 {
            biz.owner = STATE_ID;
        }
    }
    pub fn has_event(&self, k: EventKind) -> bool {
        self.events.iter().any(|x| x.0 == k)
    }
    fn event_factor(&self, job: Job) -> f64 {
        let mut f = 1.0;
        if self.has_event(EventKind::MauvaiseRecolte) && (job == CEREALIER || job == ARBORICULTEUR || job == ELEVEUR) {
            f *= 0.5;
        }
        if self.has_event(EventKind::Tempete) && job == PECHEUR {
            f = 0.0;
        }
        f
    }
    pub fn is_housed(&self, a: usize) -> bool {
        self.housed.get(a).copied().unwrap_or(false)
    }

    // =========================================================================
    // Boucle quotidienne

    pub fn step(&mut self) {
        self.day += 1;
        self.d = Daily::fresh();
        for &bi in &self.alive_biz {
            let b = &mut self.businesses[bi];
            if b.alive {
                b.rev_day = 0.0;
                b.cost_day = 0.0;
                b.input_day = 0.0;
            }
        }
        macro_rules! phase {
            ($i:expr, $e:expr) => {{
                #[cfg(feature = "profile")]
                let t0 = std::time::Instant::now();
                $e;
                #[cfg(feature = "profile")]
                PROFILE.with(|p| p.borrow_mut()[$i] += t0.elapsed().as_secs_f64());
                #[cfg(feature = "check")]
                for b in &self.businesses {
                    if !b.alive && b.cash != 0.0 {
                        eprintln!("jour {} phase {} : entreprise disparue {} avec {} centimes", self.day, $i, b.id, b.cash);
                    }
                }
            }};
        }
        phase!(0, self.tick_events());
        phase!(1, self.census());
        phase!(2, self.public_capital());
        phase!(3, self.regrow());
        phase!(4, self.expire());
        phase!(5, self.compute_capacities());
        phase!(6, self.produce());
        phase!(7, self.wholesale_market());
        phase!(8, self.retail_market());
        phase!(9, self.consume());
        phase!(10, self.crime());
        phase!(11, self.healthcare());
        phase!(12, self.business_finance());
        phase!(13, self.state_payments());
        phase!(14, self.schooling());
        phase!(15, self.demography());
        if self.day % 7 == 0 {
            phase!(16, self.update_sector_va());
        }
        phase!(17, self.career_reviews());
        self.month_gdp += self.d.gdp;
        if self.day % 30 == 0 {
            phase!(18, self.monthly());
        }
        phase!(19, self.record_stats());
    }

    /// Recensement du jour : population, effectifs publics, facteur de maladie.
    fn census(&mut self) {
        let mut pop = 0.0;
        let mut kids = 0.0;
        for j in PUBLIC_JOBS {
            self.staff_n[j] = 0.0;
        }
        for a in self.aa() {
            if !self.agents[a].alive {
                continue;
            }
            pop += 1.0;
            if self.age_y(a) < k::ADULT_AGE {
                kids += 1.0;
            }
            let ag = &self.agents[a];
            if ag.public_job && !ag.sick {
                if let Some(j) = ag.job {
                    self.staff_n[j] += 1.0;
                }
            }
        }
        self.pop_n = pop;
        self.kids_n = kids;
        self.env_sick = (1.15 - 0.15 * self.staff_cov(INFIRMIER, k::NURSE_REF))
            * (1.0 + 0.5 * mn(2.0, self.pollution / k::POLLUTION_REF));
    }

    /// Effectif d'une fonction publique rapporté à sa référence pour 1000 habitants (0 à 2).
    pub fn staff_cov(&self, job: Job, ref_per1000: f64) -> f64 {
        mn(2.0, self.staff_n[job] / mx(0.5, (ref_per1000 * self.pop_n) / 1000.0))
    }

    fn public_capital(&mut self) {
        self.infra *= 1.0 - 1.0 / k::INFRA_LIFE;
        self.infra += self.staff_n[CANTONNIER] * self.policy.public_salary * 100.0;
        self.housing *= 1.0 - 1.0 / k::HOUSING_LIFE;
        self.land_bonus *= 1.0 - 1.0 / k::LAND_LIFE;
        if self.day % 30 == 1 {
            self.assign_housing();
        }
    }

    /// Logements sociaux : aux foyers les plus modestes (épargne par membre), révisé chaque mois.
    fn assign_housing(&mut self) {
        let n = floor(self.housing);
        let mut heads: Vec<(usize, f64)> = Vec::new();
        for a in self.aa() {
            if self.is_head(a) {
                heads.push((a, self.agents[a].money / self.household_size(a)));
            }
        }
        heads.sort_by(|x, y| ord(x.1 - y.1));
        self.housed = vec![false; self.agents.len()];
        let n = if n > 0.0 { n as usize } else { 0 };
        for &(a, _) in heads.iter().take(n) {
            self.housed[a] = true;
        }
    }

    /// Vols : un foyer affamé et sans argent peut voler de la nourriture dans un commerce.
    fn crime(&mut self) {
        let police = self.staff_cov(POLICIER, k::POLICE_REF);
        let p = 0.08 * mx(0.1, 1.3 - 0.5 * police) * mx(0.0, 1.0 - self.policy.social_aid_amount / 6.0);
        let shops: Vec<usize> = self.ab().into_iter()
            .filter(|&i| {
                let b = &self.businesses[i];
                b.alive && b.job == COMMERCANT && !b.workers.is_empty()
            })
            .collect();
        if shops.is_empty() {
            return;
        }
        let cpn = self.cost_per_nutrition();
        for a in self.aa() {
            if !self.is_head(a) || self.agents[a].hunger < 0.25 {
                continue;
            }
            let need = self.household_need(a);
            if self.agents[a].money > need * cpn {
                continue;
            }
            if self.rng.next() >= p {
                continue;
            }
            let shop = shops[self.rng.int(shops.len())];
            let mut want = need * 2.0;
            for g in FOOD_GOODS {
                if want <= 0.0 {
                    break;
                }
                let nut = GOOD_DEFS[g].nutrition;
                let q = mn(self.businesses[shop].inv.qty(g), want / nut);
                if q <= 1e-6 {
                    continue;
                }
                let got = self.businesses[shop].inv.take(g, q);
                for b in got {
                    self.agents[a].food.add(g, b.q * 0.67, b.exp);
                }
                self.d.waste[g] = Some(self.d.waste[g].unwrap_or(0.0) + q * 0.33);
                want -= q * nut;
            }
            if want < need * 2.0 {
                self.d.thefts += 1.0;
            }
        }
    }

    pub fn trigger_event(&mut self, kind: EventKind) {
        if let Some(e) = self.events.iter_mut().find(|x| x.0 == kind) {
            e.1 = kind.days();
        } else {
            self.events.push((kind, kind.days()));
        }
        self.say("evenement", format!("{} ! {}.", kind.label(), kind.desc()));
        self.promise_relief(kind);
        if kind == EventKind::Tempete {
            for &bi in &self.alive_biz {
                let b = &mut self.businesses[bi];
                if b.alive {
                    b.tools *= 0.7;
                }
            }
        }
        if kind == EventKind::Incendie {
            self.forest_stock *= 0.4;
        }
    }

    fn tick_events(&mut self) {
        self.events.retain_mut(|e| {
            if e.1 <= 1 {
                false
            } else {
                e.1 -= 1;
                true
            }
        });
    }

    fn regrow(&mut self) {
        let env = 0.85 + 0.15 * self.staff_cov(GARDE, k::RANGER_REF);
        let pol = 1.0 - 0.3 * mn(1.0, self.pollution / k::POLLUTION_REF);
        self.fish_stock += k::FISH_R * env * pol * self.fish_stock * (1.0 - self.fish_stock / k::FISH_K);
        self.forest_stock += k::FOREST_R * env * self.forest_stock * (1.0 - self.forest_stock / k::FOREST_K);
        self.pollution *= 1.0 - k::POLLUTION_DECAY;
        self.fish_stock = mx(10.0, self.fish_stock);
        self.forest_stock = mx(10.0, self.forest_stock);
    }

    fn expire(&mut self) {
        let day = self.day as f64;
        for &bi in &self.alive_biz {
            let b = &mut self.businesses[bi];
            if b.alive {
                b.inv.expire(day, &mut self.d.waste);
            }
        }
        for &ai in &self.alive_agents {
            let a = &mut self.agents[ai];
            if a.alive && a.food.size() > 0 {
                a.food.expire(day, &mut self.d.waste);
            }
        }
    }

    pub fn set_policy(&mut self, partial: &serde_json::Value) {
        self.policy = self.policy.merged(partial);
    }

    pub fn all_dead(&self) -> bool {
        self.alive_agents.is_empty()
    }

    /// Ligne d'historique du jour `day` (si encore gardée).
    pub fn row(&self, day: usize) -> Option<&DayStats> {
        day.checked_sub(self.history_offset).and_then(|i| self.history.get(i))
    }
    pub fn history_len(&self) -> usize {
        self.history_offset + self.history.len()
    }
}
