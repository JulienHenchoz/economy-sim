# Budget, dette, monnaie : journal de calibrage (2026-11-09, sur le Pi)

Branche `wip/budget-dette-monnaie`. **Rien n'est déployé** : economy.lan sert toujours `main`.
Les sorties brutes de `scripts/multi.ts` sont dans `docs/runs/` (8 graines × 6 ans, sauf mention).

## Ce qui est codé

- **Budget annuel** (`voteBudget`, fin du 1er mois puis chaque année, budget rectificatif tous les
  90 jours) : besoins = effectifs × montants (salaires, pensions, revenu universel) + 12 derniers mois
  (aide sociale, remboursements, subsides, achats) + intérêts. Recettes prévues = 12 derniers mois.
  Règle `fiscalRule` : `equilibre`, `cibleDeficit` (`deficitTarget`), `freinDette` ; `debtCeiling`
  (approche en douceur, 1/3 de la marge par an) pour toutes les règles.
- **Budget symétrique** : l'État dépense recettes + déficit permis, au prorata des besoins
  (`budgetCut` entre 0,3 et 1,3, pas de 10 points au vote annuel et de 5 au rectificatif). Sans
  dette, pas d'excédent exigé et la trésorerie au-delà de 2 mois est remise en circulation.
  Raison : avec un budget qui ne fait que couper, l'État excédentaire thésaurise → déflation →
  famine (runs E). Le « dividende public » (`surplusDays`) est désactivé par défaut.
- **Dette** : obligations à 360 j, coupon mensuel, enchère uniforme (`issueBonds`, `callAuction`).
  Prêteurs : ménages au-delà d'un coussin de 30 j de dépenses, entreprises (trésorerie oisive),
  étranger (`foreignDebtCap`, taux mondial 3 % + prime), banque centrale. Tranches en `debt[]`,
  clé du détenteur : id habitant ≥ 0, entreprise −2−id, `CB_KEY` = −1, `FOREIGN_KEY` = −1e9.
  Héritage (part taxée annulée), dissolution et fusion d'entreprises gérées (`moveBonds`).
- **Achats publics** (`publicPurchaseOrders`) : pain/fruits pour les cantines (`schoolMeals`), bois,
  outils, au marché de gros ; au plus 15 % de la capacité et 10 % au-dessus du dernier prix.
- **Aide d'urgence** (`promiseRelief`, `disasterRelief`) après mauvaise récolte, tempête, incendie.
- **Création monétaire** (demande de Julien en cours de route) : la masse monétaire n'est plus fixe.
  Contrôle : `moneyBase` = initiale + création nette (`mint`), `moneyError` = total − `moneyBase`
  (reste 0 sur tous les runs).
  - Banque centrale (`monetaryPolicy`, `cbPurchaseTarget`) : inflation = moyenne des prix sur 12 mois
    / 12 mois précédents ; taux directeur Taylor (2 % + π + 0,5 (π − cible)), lissé (¼ de l'écart par
    mois), borné à 0-20 %. Achète à l'enchère quand π < cible, prêteur en dernier ressort, limite
    `cbFinancing`. Ses coupons reviennent à l'État (`profitsBC`).
  - Banque (`bankCredit`) : prêts aux entreprises sur 24 mois, taux directeur + `bankSpread`, plafond
    `creditLimit` × PIB de départ, ≤ 1 % de la masse par mois, à partir de la 2e année, demande qui
    baisse avec le taux. Intérêts : 10 % en fonds propres, 90 % aux déposants. Défaut après 3 impayés.
- UI : leviers « Budget et dette » et « Monnaie et banques », onglet État (dette/PIB, déficit, taux,
  détenteurs, soldes sectoriels, financement, budget voté), onglet Monnaie, KPI, onglet « Le modèle ».

## Calibrage par défaut actuel (config.ts)

Impôt revenu 8 % / 22 %, TVA 9 %, sociétés 10 %, pension 3,5, 12 enseignants ‰ à 5,5, aide sociale
seuil 8 / montant 2,5, sécu 80 %, cantines 0,4, `cibleDeficit` 3 %, plafond 20 %, aide d'urgence
50 %, cible d'inflation 2 %, financement monétaire 30 %, crédit 15 %, marge 3 %, dette extérieure 5 %.

## Résultats (graines 1 à 8, 6 ans)

| Run | Version | Crises alimentaires |
|-----|---------|---------------------|
| base | `main` (monnaie fixe, dividende public) | graine 4 an 2 (25 morts) |
| E | budget qui ne fait que couper, impôts bas | 4, 6 (déflation, trésor 80-100 j) |
| H | budget symétrique, impôts anciens | 7 (an 2), 8 (17 morts) |
| I | + rectificatif trimestriel, impôts 8/22/9/10 | 4, 5, 8 |
| N (graines 1, 4, 5, 8) | + banque centrale, crédit, étranger, inflation lissée | **aucune** |
| P | + taux lissé + enveloppes recalées sur la dépense réelle | 1, 2, 3, 7, 8 (abandonné) |
| Q (partiel) | P sans le recalage, plafond étranger ancré | 1 (an 3, déflation), 7 (an 2, inflation) |

Constats :
- Sans création monétaire, l'île à monnaie fixe dépend du reversement d'excédent (≈ revenu universel
  de 0,9 é/j) ; toute thésaurisation publique ou privée → déflation → producteurs ruinés → famine.
- Le cycle des prix (récoltes) fait osciller l'IPC de ±30 %/an : un taux directeur Taylor brut
  bascule entre 0 et 20 %. N (taux non lissé) a pourtant été le plus stable : le lissage est suspect.
- Déficit réalisé en moyenne 0,5-1 % du PIB (cible 3 %) : les besoins chiffrés ne sont pas tous
  dépensés. Le recalage sur la dépense réelle (P) fait grossir l'État à 130 % et déstabilise.
- Les crises restantes viennent d'une boucle prix-revenu : boom (déficit, crédit ou monnaie BC)
  → inflation → famine ; ou déflation → famine. Les deux se voient sur la même graine selon le réglage.
- Taux de la dette plausibles (1-5 %), détention concentrée (quintile 5 ≈ 35-40 %), trésorerie
  15-25 jours, dette/PIB 5-15 % : ces critères sont tenus.

## Reste à faire

1. Retrouver la stabilité de N sur les 8 graines (comparer N vs Q : lissage du taux, plafond
   étranger), puis tenir les critères du brief (déficit moyen 1-4 %, dette/PIB stable, taux 1-8 %,
   Gini 0,30-0,35, pop ≈ 1000, pas de famine au-delà de `main` sur les mêmes graines).
2. Tester `equilibre`, un déficit forcé à 8 % (`{"deficitTarget":0.08,"debtCeiling":0}`), île fermée
   (`{"foreignDebtCap":0,"cbFinancing":0,"creditLimit":0}`), préréglages.
3. `scripts/restore.ts` (instantanés déterministes), `npm run build`, test navigateur sans erreur.
4. Mettre à jour CLAUDE.md (architecture, pièges, masse monétaire non fixe) et `headless.ts`.
5. Déploiement sur le Pi (economy.lan) uniquement après validation.
