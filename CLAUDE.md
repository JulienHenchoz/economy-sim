# Économie de l'île — simulation

Simulation multi-agents d'une île de 1000 habitants : production, transformation, commerce, marchés aux
enchères, entreprises, démographie, santé, éducation et État. But : observer la circulation de l'argent,
les inégalités et l'effet des politiques publiques. Projet perso de Julien, servi sur **https://economy.lan**.

## Architecture

- **Tout tourne dans le navigateur.** Le conteneur `economy` (nginx non privilégié, port 8080) ne sert que
  des fichiers statiques ; aucune donnée côté serveur, aucun secret.
- `src/sim/` : le modèle, sans dépendance au DOM (utilisable dans Node).
  - `config.ts` : biens, métiers (productivités, intrants), constantes `K`, politique par défaut, événements.
  - `sim.ts` : classe `Simulation` (boucle quotidienne `step()`, statistiques `history`, `snapshot()` pour l'UI).
  - `market.ts` : enchère double à prix uniforme (call market).
  - `util.ts` : RNG reproductible (mulberry32), stocks périssables par lots, Gini.
- `src/worker.ts` : fait tourner la simulation dans un Web Worker, envoie l'historique par paquets (4 Hz).
- Ligne du temps (dans le worker) : `saveState`/`restoreState` (`sim.ts`) clonent tout l'état sauf
  l'historique (structuredClone + prototypes). Instantané mensuel sur la dernière année, annuel au-delà
  (3 à 5 Mo chacun). Branches = simulations vivantes indépendantes qui partagent les instantanés
  antérieurs au point de départ. Restauration déterministe vérifiée par `scripts/restore.ts`.
- Onglet « Bilan » (`QUALITY` dans `main.ts`) : 24 indicateurs sur 12 mois, seuils réussite/échec fixes,
  tendance et mini-courbe ; onglet « Énergie ».
- `src/ui/map.ts` : carte Canvas animée (zones par métier, habitants colorés par quintile de patrimoine,
  pièces = flux d'argent du jour, alimentée par `Simulation.mapState()`). Gazette : `Simulation.news`.
- `src/main.ts` + `src/style.css` + `index.html` : interface (curseurs de politique, onglets, Chart.js +
  `chartjs-chart-sankey`). Les réglages et l'onglet actif sont gardés dans `localStorage` (préfixe `ile:`).

## Règles du modèle (résumé)

- Un pas = un jour (mois 30 j, an 360 j). Monnaie en **centimes entiers**. Depuis le 2026-11-09 (branche
  budget-dette-monnaie), **la masse monétaire n'est plus fixe** : banque centrale, crédit bancaire et
  étranger créent ou détruisent de la monnaie, mais chaque mouvement passe par `mint()` ;
  `moneyError` = total − `moneyBase` (initiale + création nette) doit rester à 0. `scripts/headless.ts`
  s'arrête sinon ; l'UI l'affiche (KPI « Masse monétaire », « comptes justes »).
- Chaîne : producteurs (blé, poisson, lait+bétail, œufs, fruits, bois, énergie) → transformateurs (boulanger,
  poissonnier, boucher, fromager, charpentier → outils, artisan → artisanat) → commerçants (seuls à vendre
  aux ménages, capacité limitée, taxe sur les locaux) → ménages. Enseignants payés par l'État ; médecins
  libéraux et assureurs santé (voir ci-dessous).
- Deux enchères par bien et par jour : gros (entre entreprises) puis détail. Prix appris par les vendeurs
  (stock en jours de production vs cible), marges des commerçants plafonnées à 1,6, transformateurs ancrés
  sur un revenu de référence (`avgIncome`).
- Entreprises : tout le monde démarre indépendant ; recrutement, fusion d'indépendants en difficulté
  (**patron = plus gros apport en capital**, parts au prorata), salaires = 70 % de la VA par travailleur.
- Reconversions étalées (1/30 des actifs par jour), attrait d'un métier plafonné à 3× le revenu moyen.
- Énergie (bien `energie`, depuis le 2026-11-09) : pétroliers et gaziers (gisements finis `oilReserve`,
  `gasReserve`, émissions `EMISSIONS`), énergie verte (sans outils ≈ rien). Usages : chauffage des ménages
  (bois ou énergie, part ∝ prix^-3) et machines des producteurs `MECHANIZED` (+25 % tant qu'alimentées,
  carburant non revendu). Pollution (stock, résorption 1/720 j) : maladies jusqu'à ×2, poissons −30 %.
  Taxe carbone (recette `taxeCarbone`), subvention verte (poste `environnement`).
- IPC **chaîné** (`updateCpi`) : variations quotidiennes pondérées par les dépenses des ménages (30 j).
- État : impôts (revenu à deux tranches, TVA, sociétés, fortune, succession, locaux, carbone), dépenses par
  fonction (`SPEND_KEYS` : éducation, administration, police, santé publique, environnement, pensions, aide
  sociale, allocations familiales, indemnités maladie, chômage, revenu universel, soins, cantines,
  infrastructures, logement, culture, agriculture ; aide d'urgence), indexation sur l'IPC du mois.
- Services publics (`PUBLIC_JOBS`, effectifs ‰ par levier, `STAFF_KEY` → poste) : effet **neutre à
  l'effectif de référence** (`K.adminRef`…) : administration → part des impôts directs perçue (80-100 %),
  police → vols des foyers affamés (`crime()`), infirmiers → maladies ±15 %, gardes → repousse ±15 %,
  cantonniers (moitié de `publicInvestment`) + bois/outils → `infra` (productivité 0,9-1,1). Logements
  sociaux (chauffage ÷2, foyers modestes), matériel scolaire et culture (couvertures `schoolCov`,
  `cultureCov`), irrigation (`landBonus` : capacité des terres), silo à blé (`siloOrders` : achète sous
  `grainFloor` × valeur du travail, revend au-dessus de 150 %, ordres `tag 7` au marché de gros). Dividende public au-delà de
  `surplusDays` jours (désactivé par défaut) ; sans dette, filet automatique au-delà de 90 jours.
- Budget (`voteBudget`, fin du 1er mois puis chaque année, rectificatif tous les 90 j) : besoins chiffrés
  (effectifs × montants, 12 derniers mois pour aides et soins, achats **que le marché a pu fournir**,
  intérêts) ; l'État dépense recettes prévues + déficit permis par `fiscalRule` (`equilibre`,
  `cibleDeficit`, `freinDette`) et `debtCeiling` ; enveloppes au prorata (`budgetCut` 0,3 à 1,6, pas de
  10 points par vote annuel, 5 par rectificatif).
- Dette (`issueBonds`, `manageDebt`) : obligations à 360 j, coupon mensuel, enchère uniforme entre ménages
  (au-delà de 30 j de dépenses), entreprises, étranger (`foreignDebtCap`, 3 % + prime) et banque centrale
  (prêteur en dernier ressort, `cbFinancing`). Emprunt mensuel + **avance de trésorerie** en cours de mois
  si la caisse ne couvre pas les versements du jour. Détenteurs : id ≥ 0 habitant, −2−id entreprise,
  `CB_KEY`, `FOREIGN_KEY` ; héritage, fusion et dissolution déplacent les titres (`moveBonds`).
- Monnaie (`monetaryPolicy`, `bankCredit`) : inflation = 12 mois / 12 mois précédents (relevés à partir du
  6e mois ; 6/6 mois avant deux ans), taux directeur Taylor lissé (¼ de l'écart par mois, 0-20 %, neutre
  la 1re année) ; achats d'obligations si inflation < cible ; crédit aux entreprises dès l'an 2 (24 mois,
  taux directeur + `bankSpread`, plafond `creditLimit` × PIB de départ, intérêts aux déposants).
- Santé (`healthcare()`, privatisée le 2026-11-09) : maladies bénignes (1 journée de soin) ou graves
  (10 journées, mortelles sans soins), suivi mensuel des 60 ans et plus. **Médecins libéraux** (≈ 1 acte
  par jour) : honoraires appris (cabinet plein → hausse, peu occupé → baisse, plancher 0,4 × `avgIncome`,
  plafond 3 × la référence), les patients vont chez le moins cher. Payeurs dans l'ordre : **sécu**
  (`secuRate` × tarif de référence, `secuRatePoor` des honoraires réels pour les foyers modestes ; financée
  par `secuContribution` sur les revenus), **assureur** du foyer (`insuranceCoverage` du reste), puis le
  foyer (il garde 5 jours de nourriture, sinon il renonce). **Assureurs** (métier `assureur`, ~1000
  personnes par travailleur) : prime par unité de risque (classe d'âge ^ `insuranceRiskRating`), sinistres
  estimés par crédibilité (statistiques de la population → expérience propre), réserve de 2 mois de
  sinistres. Foyers : 1/4 réexamine son contrat chaque mois (inertie) ; facultatif → s'assure si la prime
  nette du subside (`premiumIncomeCap`) ≤ remboursement attendu × aversion au risque ; obligatoire → le
  moins cher. `insuranceMinLossRatio` : excédent de primes rendu aux assurés. `npx tsx scripts/sante.ts
  1440 42 90 '{"secuRate":0}'` résume le marché des soins.

## Calibrage et pièges connus

Le modèle a été longuement stabilisé (voir l'historique dans la conversation du 2026-11-08). Les
mécanismes qui le tiennent et qu'il ne faut pas retirer à la légère :

- signaux de **demande non servie** (`retailUnmet`, `wholesaleUnmet`) pour éviter que la production
  planifiée ne s'auto-entretienne à zéro ;
- prix des vendeurs fondés sur le **stock en jours de production** (pas sur la part du stock vendue) ;
- surenchère des ménages modeste (sinon hyperinflation par composition jour après jour) ;
- budget chauffage plafonné, demande d'artisanat limitée (budget discrétionnaire), conservation courte du
  blé (60 j) pour éviter les cycles du porc mortels ;
- autoconsommation des indépendants qui produisent de la nourriture ;
- **prix de réserve des producteurs** (30 % de la valeur de leur travail) : sans lui, un gros stock fait
  tomber le prix du blé à 1 centime, les céréaliers partent et la famine suit des mois plus tard.
- santé : les soins passent après la nourriture (sinon une maladie grave vide l'épargne et affame le foyer,
  famines en série) ; l'étape `healthcare()` tourne **avant** `businessFinance()` (sinon honoraires et
  primes ne comptent pas dans la VA, médecins et assureurs se croient sans revenu et partent) ; sans
  `secuRatePoor`, les pauvres non assurés meurent de maladies graves (population en baisse lente).
- **prix de détail sans cliquet** : si plus de la moitié de la demande d'un bien n'est pas servie, `lastR` ne
  baisse pas. Sinon des invendus bradés le tirent vers zéro ; or il plafonne les achats en gros des
  commerçants (`maxP`), qui ne suivent plus le prix de gros : la filière du pain s'éteint et la famine vient
  alors que les ménages ont de l'argent. Le faire **monter** dans ce cas (+1 à 5 %/j) déclenche des
  hyperinflations.
- budget : sans dette, l'État ne doit pas thésauriser (déflation puis famine) → filet de 90 jours ;
  compter les achats publics non servis dans les besoins fait couper les autres enveloppes (déficit réalisé
  0,3 % au lieu de la cible) ; recaler **toutes** les enveloppes sur la dépense réelle déstabilise.
- avance de trésorerie : sans elle, la caisse se vide avant les impôts de fin de mois (jusqu'à 250 j sur
  6 ans), pensions et aides suspendues, crises plus fréquentes.
- IPC à poids fixes : un bien devenu rare et cher (poisson) gonflait l'IPC alors que personne n'en
  achetait plus ; l'indexation faisait exploser pensions et aides (déficits de 10 %, spirales) → IPC chaîné.
- détail : aucune vente alors que des commerces proposent → `lastR` se rapproche de l'offre la moins chère
  (sans ce tâtonnement, l'énergie et le bois ne s'échangeaient pas pendant le premier mois : froid général).
- prêteur en dernier ressort suspendu au-delà de 10 % d'inflation (sinon il valide les spirales).
- services publics : coupes budgétaires → moins d'administrateurs → moins d'impôts perçus → plus de
  coupes (boucle réelle, à surveiller si les impôts baissent fortement).
- inflation de la banque centrale : ne pas mesurer sur les 6 premiers mois (prix de départ 100 → 200),
  sinon taux directeur à 20 % toute la 2e année. Le taux directeur oscille quand même beaucoup (récoltes).

Au 2026-11-09, sur 8 graines × 6 ans : aucun effondrement, aucun décès de faim. Après la privatisation de la
santé, sur 20 graines × 6 ans : 2 crises alimentaires (graine 4 : 25 morts, graine 11 : 110), contre 3 pour
la version précédente sur les mêmes graines (graine 14 : 6, 17 : 300, 18 : 1) — le cycle du blé, pas la santé.
Le préréglage « Laisser-faire » s'effondre (famine la première année), déjà avant la santé. Les crises
restent possibles, c'est assumé et expliqué dans l'onglet « Le modèle ».

Après budget complet, énergie et IPC chaîné (2026-11-09, Mac, 64 graines × 6 ans) : 518 décès de faim,
4 crises (graines 14, 18, 29, 51), aucune dérive inflationniste ; population médiane 1014, Gini 0,31, déficit
2,4 %, dette 16 % à 6 ans (vers le plafond de 60 % en plusieurs décennies), taux 2,4 %, trésorerie 19 j,
~20 % d'années excédentaires (années de déflation). État-providence tient désormais (0 décès sur 8 graines).

Avant cela, branche budget-dette-monnaie, mesuré sur Mac le 2026-11-09 (les trajectoires diffèrent du Pi : comparer
sur la même machine), 64 graines × 6 ans : `main` 3539 décès de faim (10 crises), branche 381 (3 crises :
graines 7, 8, 33) et 6 dérives inflationnistes sans famine (flambée du blé → indexation → déficit financé
par la BC, IPC × 3-4). Déficit moyen 1,5-3 % du PIB, dette/PIB vers le plafond de 20 % en 12 ans, taux
2-4 %, trésorerie 17-20 j, Gini 0,27-0,35. « État-providence » s'effondre sur la moitié des graines (déjà sur
`main`). Journal : `docs/calibrage-budget-dette-monnaie.md`, sorties : `docs/runs/mac-*.txt`.

Tester une modification du modèle sur plusieurs graines avant de la déployer (le Pi est lent : ~1 min par
graine et par 6 ans, ~35 s sur Mac ; lancer en parallèle) :

```bash
npx tsx scripts/multi.ts 6 1 2      # résumé annuel par graine (pop, faim, IPC, Gini) ; POLICY='{…}' pour une politique
npx tsx scripts/headless.ts 1440 42 90   # détail tous les 90 jours (prix, emplois, revenus)
npx tsx scripts/hungry.ts 720       # qui a faim, avec quel argent et quel revenu
npx tsx scripts/nutri.ts 150        # nutrition produite / vendue / gaspillée vs besoin
npx tsx scripts/debug.ts 30 42 5    # marchés jour par jour
npx tsx scripts/budget.ts 6 1 '{…}' # budget annuel : recettes, dépenses par poste, budget voté, monnaie
npx tsx scripts/services.ts 1080 1 90 # énergie, fonctionnaires, équipements publics, silo, vols, froid
npx tsx scripts/restore.ts          # instantanés déterministes (jours 360 et 1000) : doit afficher IDENTIQUE
```

## Commandes

```bash
npm ci                 # dépendances (node_modules exclu du backup)
npm run dev            # serveur de dev Vite (--host)
npm run build          # tsc + vite build -> dist/
docker compose build && docker compose up -d   # redéploie economy.lan
```

Le nom `economy.lan` est dans `traefik/domains.txt` (certificat mkcert régénéré le 2026-11-08) ; entrée
Homepage dans le groupe « Documents ». Pas de port publié : uniquement via Traefik.

## Pistes v2

Prêts aux ménages, logement et rente foncière, commerce extérieur, anticipations
des agents, plusieurs biens d'artisanat, comparaison automatique de politiques (plusieurs graines).
