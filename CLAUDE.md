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
- `src/ui/map.ts` : carte Canvas animée (zones par métier, habitants colorés par quintile de patrimoine,
  pièces = flux d'argent du jour, alimentée par `Simulation.mapState()`). Gazette : `Simulation.news`.
- `src/main.ts` + `src/style.css` + `index.html` : interface (curseurs de politique, onglets, Chart.js +
  `chartjs-chart-sankey`). Les réglages et l'onglet actif sont gardés dans `localStorage` (préfixe `ile:`).

## Règles du modèle (résumé)

- Un pas = un jour (mois 30 j, an 360 j). **Masse monétaire fixe en centimes entiers** : aucun écu créé ou
  détruit. `scripts/headless.ts` s'arrête si la conservation est violée ; l'UI l'affiche (KPI « Masse monétaire »).
- Chaîne : producteurs (blé, poisson, lait+bétail, œufs, fruits, bois) → transformateurs (boulanger,
  poissonnier, boucher, fromager, charpentier → outils, artisan → artisanat) → commerçants (seuls à vendre
  aux ménages, capacité limitée, taxe sur les locaux) → ménages. Enseignants payés par l'État ; médecins
  libéraux et assureurs santé (voir ci-dessous).
- Deux enchères par bien et par jour : gros (entre entreprises) puis détail. Prix appris par les vendeurs
  (stock en jours de production vs cible), marges des commerçants plafonnées à 1,6, transformateurs ancrés
  sur un revenu de référence (`avgIncome`).
- Entreprises : tout le monde démarre indépendant ; recrutement, fusion d'indépendants en difficulté
  (**patron = plus gros apport en capital**, parts au prorata), salaires = 70 % de la VA par travailleur.
- Reconversions étalées (1/30 des actifs par jour), attrait d'un métier plafonné à 3× le revenu moyen.
- État : impôts (revenu à deux tranches, TVA, sociétés, fortune, succession, locaux), dépenses (fonction
  publique, pensions, aide sociale par membre du foyer, revenu universel), indexation sur l'IPC, reversement
  de l'excédent au-delà de `surplusDays` jours de dépenses.
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

Au 2026-11-09, sur 8 graines × 6 ans : aucun effondrement, aucun décès de faim. Après la privatisation de la
santé, sur 20 graines × 6 ans : 2 crises alimentaires (graine 4 : 25 morts, graine 11 : 110), contre 3 pour
la version précédente sur les mêmes graines (graine 14 : 6, 17 : 300, 18 : 1) — le cycle du blé, pas la santé.
Le préréglage « Laisser-faire » s'effondre (famine la première année), déjà avant la santé. Les crises
restent possibles, c'est assumé et expliqué dans l'onglet « Le modèle ».

Tester une modification du modèle sur plusieurs graines avant de la déployer (le Pi est lent : ~1 min par
graine et par 6 ans, lancer en parallèle) :

```bash
npx tsx scripts/multi.ts 6 1 2      # résumé annuel par graine (pop, faim, IPC, Gini) ; POLICY='{…}' pour une politique
npx tsx scripts/headless.ts 1440 42 90   # détail tous les 90 jours (prix, emplois, revenus)
npx tsx scripts/hungry.ts 720       # qui a faim, avec quel argent et quel revenu
npx tsx scripts/nutri.ts 150        # nutrition produite / vendue / gaspillée vs besoin
npx tsx scripts/debug.ts 30 42 5    # marchés jour par jour
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

Crédit et banque (création monétaire), logement et rente foncière, commerce extérieur, anticipations
des agents, plusieurs biens d'artisanat, comparaison automatique de politiques (plusieurs graines).
