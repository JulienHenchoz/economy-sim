//! Définitions statiques : biens, métiers, paramètres par défaut (copie de `src/sim/config.ts`).
//! Unité monétaire : l'écu. En interne tout l'argent est en CENTIMES ENTIERS (stockés en f64).

use serde::{Deserialize, Serialize};

pub type Good = usize;
pub const NG: usize = 14;
pub const BLE: Good = 0;
pub const PAIN: Good = 1;
pub const POISSON: Good = 2;
pub const POISSON_PREP: Good = 3;
pub const BETAIL: Good = 4;
pub const VIANDE: Good = 5;
pub const LAIT: Good = 6;
pub const FROMAGE: Good = 7;
pub const OEUFS: Good = 8;
pub const FRUITS: Good = 9;
pub const BOIS: Good = 10;
pub const OUTILS: Good = 11;
pub const ARTISANAT: Good = 12;
pub const ENERGIE: Good = 13;

pub const GOOD_IDS: [&str; NG] = [
    "ble", "pain", "poisson", "poisson_prep", "betail", "viande", "lait", "fromage", "oeufs", "fruits", "bois", "outils",
    "artisanat", "energie",
];

pub struct GoodDef {
    pub label: &'static str,
    pub shelf: f64,
    pub nutrition: f64,
    pub retail: bool,
    pub wholesale0: f64,
}

pub const GOOD_DEFS: [GoodDef; NG] = [
    GoodDef { label: "Blé", shelf: 60.0, nutrition: 0.0, retail: false, wholesale0: 108.0 },
    GoodDef { label: "Pain", shelf: 3.0, nutrition: 0.5, retail: true, wholesale0: 75.0 },
    GoodDef { label: "Poisson frais", shelf: 2.0, nutrition: 0.0, retail: false, wholesale0: 85.0 },
    GoodDef { label: "Poisson préparé", shelf: 10.0, nutrition: 0.5, retail: true, wholesale0: 112.0 },
    GoodDef { label: "Bétail", shelf: 120.0, nutrition: 0.0, retail: false, wholesale0: 500.0 },
    GoodDef { label: "Viande", shelf: 4.0, nutrition: 0.6, retail: true, wholesale0: 103.0 },
    GoodDef { label: "Lait", shelf: 3.0, nutrition: 0.25, retail: true, wholesale0: 25.0 },
    GoodDef { label: "Fromage", shelf: 30.0, nutrition: 0.5, retail: true, wholesale0: 91.0 },
    GoodDef { label: "Œufs", shelf: 14.0, nutrition: 0.25, retail: true, wholesale0: 35.0 },
    GoodDef { label: "Fruits", shelf: 10.0, nutrition: 0.2, retail: true, wholesale0: 37.0 },
    GoodDef { label: "Bois", shelf: 1e7, nutrition: 0.0, retail: true, wholesale0: 121.0 },
    GoodDef { label: "Outils", shelf: 1e7, nutrition: 0.0, retail: false, wholesale0: 643.0 },
    GoodDef { label: "Artisanat", shelf: 1e7, nutrition: 0.0, retail: true, wholesale0: 250.0 },
    GoodDef { label: "Énergie", shelf: 90.0, nutrition: 0.0, retail: true, wholesale0: 90.0 },
];

pub const RETAIL_GOODS: [Good; 10] = [PAIN, POISSON_PREP, VIANDE, LAIT, FROMAGE, OEUFS, FRUITS, BOIS, ARTISANAT, ENERGIE];
pub const FOOD_GOODS: [Good; 7] = [PAIN, POISSON_PREP, VIANDE, LAIT, FROMAGE, OEUFS, FRUITS];

pub const RETAIL_MARGIN0: f64 = 14.0;

pub type Job = usize;
pub const NJ: usize = 24;
pub const CEREALIER: Job = 0;
pub const PECHEUR: Job = 1;
pub const ELEVEUR: Job = 2;
pub const AVICULTEUR: Job = 3;
pub const ARBORICULTEUR: Job = 4;
pub const BUCHERON: Job = 5;
pub const BOULANGER: Job = 6;
pub const POISSONNIER: Job = 7;
pub const BOUCHER: Job = 8;
pub const FROMAGER: Job = 9;
pub const CHARPENTIER: Job = 10;
pub const ARTISAN: Job = 11;
pub const COMMERCANT: Job = 12;
pub const MEDECIN: Job = 13;
pub const ASSUREUR: Job = 14;
pub const PETROLIER: Job = 15;
pub const GAZIER: Job = 16;
pub const ENERGIE_VERTE: Job = 17;
pub const ENSEIGNANT: Job = 18;
pub const ADMINISTRATEUR: Job = 19;
pub const POLICIER: Job = 20;
pub const INFIRMIER: Job = 21;
pub const GARDE: Job = 22;
pub const CANTONNIER: Job = 23;

pub const JOB_IDS: [&str; NJ] = [
    "cerealier", "pecheur", "eleveur", "aviculteur", "arboriculteur", "bucheron", "boulanger", "poissonnier", "boucher",
    "fromager", "charpentier", "artisan", "commercant", "medecin", "assureur", "petrolier", "gazier", "energieVerte",
    "enseignant", "administrateur", "policier", "infirmier", "garde", "cantonnier",
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cat {
    Production,
    Transformation,
    Commerce,
    Sante,
    Assurance,
    Service,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Natural {
    None,
    Land(f64),
    Fish,
    Forest,
    Oil,
    Gas,
}

pub struct JobDef {
    pub label: &'static str,
    pub cat: Cat,
    /// Intrants consommés par lot (ordre de déclaration).
    pub inputs: &'static [(Good, f64)],
    /// Produits sortis par lot.
    pub outputs: &'static [(Good, f64)],
    pub batches: f64,
    pub natural: Natural,
    pub share: f64,
    pub min_edu: f64,
}

impl JobDef {
    pub fn input(&self, g: Good) -> Option<f64> {
        self.inputs.iter().find(|x| x.0 == g).map(|x| x.1)
    }
    pub fn output(&self, g: Good) -> Option<f64> {
        self.outputs.iter().find(|x| x.0 == g).map(|x| x.1)
    }
}

use Cat::*;
pub const JOB_DEFS: [JobDef; NJ] = [
    JobDef { label: "Céréalier", cat: Production, inputs: &[], outputs: &[(BLE, 1.0)], batches: 3.2, natural: Natural::Land(110.0), share: 0.12, min_edu: 0.0 },
    JobDef { label: "Pêcheur", cat: Production, inputs: &[], outputs: &[(POISSON, 1.0)], batches: 3.8, natural: Natural::Fish, share: 0.08, min_edu: 0.0 },
    JobDef { label: "Éleveur", cat: Production, inputs: &[], outputs: &[(LAIT, 7.6), (BETAIL, 0.30)], batches: 1.0, natural: Natural::Land(85.0), share: 0.09, min_edu: 0.0 },
    JobDef { label: "Aviculteur", cat: Production, inputs: &[], outputs: &[(OEUFS, 1.0)], batches: 9.7, natural: Natural::None, share: 0.045, min_edu: 0.0 },
    JobDef { label: "Arboriculteur", cat: Production, inputs: &[], outputs: &[(FRUITS, 1.0)], batches: 9.2, natural: Natural::Land(65.0), share: 0.07, min_edu: 0.0 },
    JobDef { label: "Bûcheron", cat: Production, inputs: &[], outputs: &[(BOIS, 1.0)], batches: 2.8, natural: Natural::Forest, share: 0.045, min_edu: 0.0 },
    JobDef { label: "Boulanger", cat: Transformation, inputs: &[(BLE, 1.0)], outputs: &[(PAIN, 2.0)], batches: 6.9, natural: Natural::None, share: 0.07, min_edu: 0.2 },
    JobDef { label: "Poissonnier", cat: Transformation, inputs: &[(POISSON, 1.0)], outputs: &[(POISSON_PREP, 1.0)], batches: 12.3, natural: Natural::None, share: 0.025, min_edu: 0.2 },
    JobDef { label: "Boucher", cat: Transformation, inputs: &[(BETAIL, 1.0)], outputs: &[(VIANDE, 8.0)], batches: 1.05, natural: Natural::None, share: 0.025, min_edu: 0.2 },
    JobDef { label: "Fromager", cat: Transformation, inputs: &[(LAIT, 2.0)], outputs: &[(FROMAGE, 1.0)], batches: 8.4, natural: Natural::None, share: 0.02, min_edu: 0.2 },
    JobDef { label: "Charpentier", cat: Transformation, inputs: &[(BOIS, 3.0)], outputs: &[(OUTILS, 1.0)], batches: 1.2, natural: Natural::None, share: 0.008, min_edu: 0.3 },
    JobDef { label: "Artisan", cat: Transformation, inputs: &[(BOIS, 0.3)], outputs: &[(ARTISANAT, 1.0)], batches: 2.0, natural: Natural::None, share: 0.05, min_edu: 0.2 },
    JobDef { label: "Commerçant", cat: Commerce, inputs: &[], outputs: &[], batches: 0.0, natural: Natural::None, share: 0.08, min_edu: 0.3 },
    JobDef { label: "Médecin", cat: Sante, inputs: &[], outputs: &[], batches: 0.0, natural: Natural::None, share: 0.02, min_edu: 0.75 },
    JobDef { label: "Assureur santé", cat: Assurance, inputs: &[], outputs: &[], batches: 0.0, natural: Natural::None, share: 0.003, min_edu: 0.5 },
    JobDef { label: "Pétrolier", cat: Production, inputs: &[], outputs: &[(ENERGIE, 1.0)], batches: 7.0, natural: Natural::Oil, share: 0.007, min_edu: 0.2 },
    JobDef { label: "Gazier", cat: Production, inputs: &[], outputs: &[(ENERGIE, 1.0)], batches: 5.0, natural: Natural::Gas, share: 0.007, min_edu: 0.2 },
    JobDef { label: "Énergie verte", cat: Production, inputs: &[], outputs: &[(ENERGIE, 1.0)], batches: 5.5, natural: Natural::None, share: 0.007, min_edu: 0.3 },
    JobDef { label: "Enseignant", cat: Service, inputs: &[], outputs: &[], batches: 0.0, natural: Natural::None, share: 0.02, min_edu: 0.6 },
    JobDef { label: "Administrateur", cat: Service, inputs: &[], outputs: &[], batches: 0.0, natural: Natural::None, share: 0.0, min_edu: 0.45 },
    JobDef { label: "Policier", cat: Service, inputs: &[], outputs: &[], batches: 0.0, natural: Natural::None, share: 0.0, min_edu: 0.25 },
    JobDef { label: "Infirmier", cat: Service, inputs: &[], outputs: &[], batches: 0.0, natural: Natural::None, share: 0.0, min_edu: 0.5 },
    JobDef { label: "Garde nature", cat: Service, inputs: &[], outputs: &[], batches: 0.0, natural: Natural::None, share: 0.0, min_edu: 0.15 },
    JobDef { label: "Travaux publics", cat: Service, inputs: &[], outputs: &[], batches: 0.0, natural: Natural::None, share: 0.0, min_edu: 0.1 },
];

/// Métiers marchands (hors fonction publique), dans l'ordre de JOBS.
pub const MARKET_JOBS: [Job; 18] = [
    CEREALIER, PECHEUR, ELEVEUR, AVICULTEUR, ARBORICULTEUR, BUCHERON, BOULANGER, POISSONNIER, BOUCHER, FROMAGER, CHARPENTIER,
    ARTISAN, COMMERCANT, MEDECIN, ASSUREUR, PETROLIER, GAZIER, ENERGIE_VERTE,
];
pub const PUBLIC_JOBS: [Job; 6] = [ENSEIGNANT, ADMINISTRATEUR, POLICIER, INFIRMIER, GARDE, CANTONNIER];

pub fn emissions(j: Job) -> f64 {
    match j {
        PETROLIER => 1.0,
        GAZIER => 0.55,
        _ => 0.0,
    }
}
/// Producteurs qui équipent leurs travailleurs de machines alimentées en énergie.
pub fn mechanized(j: Job) -> bool {
    matches!(j, CEREALIER | PECHEUR | ELEVEUR | AVICULTEUR | ARBORICULTEUR | BUCHERON)
}

/// Constantes du modèle (non réglables dans l'UI).
pub mod k {
    pub const DAYS_PER_YEAR: f64 = 360.0;
    pub const DAYS_PER_MONTH: f64 = 30.0;
    pub const ADULT_AGE: f64 = 16.0;
    pub const SCHOOL_START: f64 = 6.0;
    pub const SHOP_CAPACITY: f64 = 80.0;
    pub const TOOL_BONUS: f64 = 0.5;
    pub const TOOL_DEPRECIATION: f64 = 0.01;
    pub const SCALE_BONUS_PER_WORKER: f64 = 0.05;
    pub const SCALE_BONUS_MAX: f64 = 0.25;
    pub const CHILD_NEED: f64 = 0.7;
    pub const FIREWOOD_PER_PERSON: f64 = 0.1;
    pub const FOOD_BUFFER_DAYS: f64 = 2.0;
    pub const FISH_K: f64 = 24000.0;
    pub const FISH_R: f64 = 0.07;
    pub const FOREST_K: f64 = 60000.0;
    pub const FOREST_R: f64 = 0.02;
    pub const ACTS_PER_DOCTOR: f64 = 1.0;
    pub const SEVERE_ACTS: f64 = 10.0;
    pub const FOLLOW_UP_AGE: f64 = 60.0;
    pub const FOLLOW_UP_EVERY: f64 = 30.0;
    pub const CARE_DAYS: f64 = 40.0;
    pub const CONTRACTS_PER_INSURER: f64 = 1000.0;
    pub const PUPILS_PER_TEACHER: f64 = 25.0;
    pub const COMFORT_WEAR: f64 = 0.01;
    pub const SAVINGS_BUFFER_DAYS: f64 = 20.0;
    pub const TREASURY_DAYS: f64 = 20.0;
    pub const BOND_MATURITY: f64 = 360.0;
    pub const BOND_CUSHION_DAYS: f64 = 30.0;
    pub const BOND_MAX_RATE: f64 = 0.25;
    pub const WORLD_RATE: f64 = 0.03;
    pub const LOAN_MONTHS: f64 = 24.0;
    pub const OIL_RESERVE: f64 = 400000.0;
    pub const GAS_RESERVE: f64 = 300000.0;
    pub const ENERGY_PER_WORKER: f64 = 0.3;
    pub const ENERGY_BONUS: f64 = 0.25;
    pub const POLLUTION_DECAY: f64 = 1.0 / 720.0;
    pub const POLLUTION_REF: f64 = 120.0 * 720.0;
    pub const ADMIN_REF: f64 = 8.0;
    pub const POLICE_REF: f64 = 3.0;
    pub const NURSE_REF: f64 = 5.0;
    pub const RANGER_REF: f64 = 1.5;
    pub const INFRA_PER_CAPITA: f64 = 1000.0;
    pub const INFRA_LIFE: f64 = 20.0 * 360.0;
    pub const HOUSING_WOOD: f64 = 25.0;
    pub const HOUSING_TOOLS: f64 = 1.0;
    pub const HOUSING_LIFE: f64 = 40.0 * 360.0;
    pub const LAND_PER_TOOL: f64 = 0.000015;
    pub const LAND_LIFE: f64 = 30.0 * 360.0;
    pub const SILO_SHELF: f64 = 360.0;
    pub const SILO_DAYS: f64 = 60.0;
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum FiscalRule {
    #[serde(rename = "equilibre")]
    Equilibre,
    #[serde(rename = "cibleDeficit")]
    CibleDeficit,
    #[serde(rename = "freinDette")]
    FreinDette,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub income_tax_low: f64,
    pub income_tax_high: f64,
    pub income_tax_threshold: f64,
    pub vat: f64,
    pub corporate_tax: f64,
    pub wealth_tax: f64,
    pub wealth_tax_threshold: f64,
    pub inheritance_tax: f64,
    pub teachers_per1000: f64,
    pub public_salary: f64,
    pub pension: f64,
    pub retirement_age: f64,
    pub ubi: f64,
    pub social_aid_threshold: f64,
    pub social_aid_amount: f64,
    pub secu_contribution: f64,
    pub secu_rate: f64,
    pub secu_tariff: f64,
    pub secu_rate_poor: f64,
    pub insurance_mandatory: bool,
    pub insurance_coverage: f64,
    pub insurance_risk_rating: f64,
    pub premium_income_cap: f64,
    pub insurance_min_loss_ratio: f64,
    pub indexation: bool,
    pub surplus_days: f64,
    pub school_meals: f64,
    pub fiscal_rule: FiscalRule,
    pub deficit_target: f64,
    pub debt_ceiling: f64,
    pub disaster_relief: f64,
    pub inflation_target: f64,
    pub cb_financing: f64,
    pub credit_limit: f64,
    pub bank_spread: f64,
    pub foreign_debt_cap: f64,
    pub admin_per1000: f64,
    pub police_per1000: f64,
    pub nurses_per1000: f64,
    pub rangers_per1000: f64,
    pub family_allowance: f64,
    pub sick_pay: f64,
    pub unemployment_benefit: f64,
    pub public_investment: f64,
    pub school_supplies: f64,
    pub social_housing: f64,
    pub culture: f64,
    pub land_improvement: f64,
    pub grain_reserve: bool,
    pub grain_floor: f64,
    pub carbon_tax: f64,
    pub green_subsidy: f64,
    pub min_wage: f64,
    pub shop_rent: f64,
    pub fishing_quota: f64,
    pub logging_quota: f64,
}

pub fn default_policy() -> Policy {
    Policy {
        income_tax_low: 0.1,
        income_tax_high: 0.25,
        income_tax_threshold: 150.0,
        vat: 0.1,
        corporate_tax: 0.1,
        wealth_tax: 0.0,
        wealth_tax_threshold: 2000.0,
        inheritance_tax: 0.2,
        teachers_per1000: 12.0,
        public_salary: 5.5,
        pension: 3.5,
        retirement_age: 65.0,
        ubi: 0.0,
        social_aid_threshold: 8.0,
        social_aid_amount: 2.5,
        secu_contribution: 0.02,
        secu_rate: 0.8,
        secu_tariff: 4.0,
        secu_rate_poor: 1.0,
        insurance_mandatory: false,
        insurance_coverage: 1.0,
        insurance_risk_rating: 1.0,
        premium_income_cap: 0.0,
        insurance_min_loss_ratio: 0.0,
        indexation: true,
        surplus_days: 0.0,
        school_meals: 0.4,
        fiscal_rule: FiscalRule::CibleDeficit,
        deficit_target: 0.03,
        debt_ceiling: 0.6,
        disaster_relief: 0.5,
        inflation_target: 0.02,
        cb_financing: 0.3,
        credit_limit: 0.15,
        bank_spread: 0.03,
        foreign_debt_cap: 0.05,
        admin_per1000: 8.0,
        police_per1000: 3.0,
        nurses_per1000: 5.0,
        rangers_per1000: 1.5,
        family_allowance: 0.4,
        sick_pay: 2.0,
        unemployment_benefit: 2.5,
        public_investment: 0.02,
        school_supplies: 10.0,
        social_housing: 0.1,
        culture: 8.0,
        land_improvement: 0.004,
        grain_reserve: true,
        grain_floor: 0.6,
        carbon_tax: 0.0,
        green_subsidy: 0.1,
        min_wage: 2.5,
        shop_rent: 1.5,
        fishing_quota: 0.0,
        logging_quota: 0.0,
    }
}

impl Policy {
    /// Effectif pour 1000 habitants fixé par la politique (STAFF_POLICY), hors travaux publics.
    pub fn staff_per1000(&self, j: Job) -> f64 {
        match j {
            ENSEIGNANT => self.teachers_per1000,
            ADMINISTRATEUR => self.admin_per1000,
            POLICIER => self.police_per1000,
            INFIRMIER => self.nurses_per1000,
            GARDE => self.rangers_per1000,
            _ => 0.0,
        }
    }
    /// Applique un réglage partiel (objet JSON `Partial<Policy>`).
    pub fn merged(&self, partial: &serde_json::Value) -> Policy {
        let mut v = serde_json::to_value(self).expect("policy");
        if let (Some(dst), Some(src)) = (v.as_object_mut(), partial.as_object()) {
            for (k, x) in src {
                if dst.contains_key(k) && !x.is_null() {
                    dst.insert(k.clone(), x.clone());
                }
            }
        }
        serde_json::from_value(v.clone()).unwrap_or_else(|_| self.clone())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitConfig {
    pub seed: f64,
    pub population: f64,
    pub money_per_inhabitant: f64,
    pub state_share: f64,
    /// Reproduit au bit près l'ancienne version TypeScript (générateur aléatoire mulberry32 en
    /// flottant, bugs compris) : sert uniquement à vérifier le port (scripts/golden-all.sh).
    #[serde(default)]
    pub legacy: bool,
}

pub fn default_init() -> InitConfig {
    InitConfig { seed: 42.0, population: 1000.0, money_per_inhabitant: 300.0, state_share: 0.1, legacy: false }
}

impl InitConfig {
    pub fn merged(&self, partial: &serde_json::Value) -> InitConfig {
        let mut v = serde_json::to_value(self).expect("init");
        if let (Some(dst), Some(src)) = (v.as_object_mut(), partial.as_object()) {
            for (k, x) in src {
                if dst.contains_key(k) && !x.is_null() {
                    dst.insert(k.clone(), x.clone());
                }
            }
        }
        serde_json::from_value(v).unwrap_or_else(|_| self.clone())
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum EventKind {
    MauvaiseRecolte,
    Tempete,
    Epidemie,
    Incendie,
}

impl EventKind {
    pub fn id(self) -> &'static str {
        match self {
            EventKind::MauvaiseRecolte => "mauvaise_recolte",
            EventKind::Tempete => "tempete",
            EventKind::Epidemie => "epidemie",
            EventKind::Incendie => "incendie",
        }
    }
    pub fn from_id(s: &str) -> Option<EventKind> {
        match s {
            "mauvaise_recolte" => Some(EventKind::MauvaiseRecolte),
            "tempete" => Some(EventKind::Tempete),
            "epidemie" => Some(EventKind::Epidemie),
            "incendie" => Some(EventKind::Incendie),
            _ => None,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            EventKind::MauvaiseRecolte => "Mauvaise récolte",
            EventKind::Tempete => "Tempête",
            EventKind::Epidemie => "Épidémie",
            EventKind::Incendie => "Incendie de forêt",
        }
    }
    pub fn days(self) -> i64 {
        match self {
            EventKind::MauvaiseRecolte => 90,
            EventKind::Tempete => 30,
            EventKind::Epidemie => 45,
            EventKind::Incendie => 1,
        }
    }
    pub fn desc(self) -> &'static str {
        match self {
            EventKind::MauvaiseRecolte => "Blé, fruits et élevage à −50 % pendant 90 jours",
            EventKind::Tempete => "Pêche impossible 30 jours, 30 % des outils détruits",
            EventKind::Epidemie => "Risque de maladie ×8 pendant 45 jours",
            EventKind::Incendie => "La forêt perd 60 % de son stock",
        }
    }
}
