# Attribution INP par script pour les articles du dashboard CrUX

## Contexte

Le dashboard (`collect.js` -> `data.json` -> `index.html`) liste les articles J-2 triés par INP p75 mobile (CrUX). Il dit *quels* articles sont mauvais, pas *pourquoi*. Objectif : pour les articles mauvais, afficher les scripts / composants probablement responsables. Deux sources étudiées : API Google, API SpeedCurve.

## Résultat de l'étude de faisabilité

### Google

| API | Attribution script INP ? | Verdict |
|---|---|---|
| CrUX API (déjà utilisée) | Non. Uniquement p75 + histogramme. | Rien de plus à en tirer. |
| PageSpeed Insights API v5 (Lighthouse 13) | Pas d'attribution INP directe : Lighthouse ne clique pas, donc l'insight `inp-breakdown-insight` sort "non applicable" (code : `if (!insight.longestInteractionEvent) return`). | **Proxy exploitable** : audits main-thread au chargement, qui listent les scripts qui bloquent le thread principal, cause n°1 d'un mauvais INP sur un site média (pubs, consent, analytics). |

Audits PSI utiles (tous présents dans la catégorie performance de Lighthouse 13) :
- `bootup-time` : CPU par URL de script (`url`, `total`, `scripting`, `scriptParseCompile`).
- `third-parties-insight` : temps main-thread et temps bloquant par entité tierce (Google Ads, Didomi, etc.), avec sous-items par URL.
- `long-tasks` : liste des long tasks (url, start, duration).
- `total-blocking-time` : valeur TBT, meilleur proxy lab de l'INP.
- `mainthread-work-breakdown` : répartition script eval / style / layout.

Contraintes PSI : `strategy=mobile`, `category=performance`, ~30-60 s par URL, quota par défaut 25 000/jour et 400/100 s (à vérifier dans la console Google Cloud). Il faut activer "PageSpeed Insights API" sur le projet GCP de la clé existante (même clé possible) ou créer une clé dédiée.

### SpeedCurve

L'attribution exacte qu'on veut (scripts attribués à l'INP via Long Animation Frames, lux.js >= 4.1) **existe dans SpeedCurve mais uniquement dans l'UI** (Vitals dashboard, table "scripts during INP", filtrable par page label). Elle n'est exposée par aucune API :
- **RUM Export API** (`GET https://api.speedcurve.com/v1/lux/export?date=YYYYMMDD[&hour=H]`, Basic Auth, 3 req/min, CSV gzippé délimité par `^`, 85 colonnes) : contient par page vue `pathname`, `interaction_to_next_paint`, `inp_element_selector`, `inp_input_delay`, `inp_processing_time`, `inp_presentation_delay`, `long_tasks` (résumé chiffré sans URL de script). **Pas de colonnes LoAF / scripts.** Prérequis : cocher "Enable RUM export API" dans les settings RUM de l'équipe ; les données ne sont générées qu'à partir de l'activation.
- **Queries API v2 (beta)** : renvoie uniquement des séries temporelles / valeurs agrégées d'un chart existant créé dans l'UI. Pas de table de scripts, pas de breakdown par URL.
- **API synthetic** (`/v1/tests/{id}`) : agrégats `third_party_cpu`, `first_party_cpu`, `long_tasks`, lien HAR. Pas d'interaction non plus, et seulement pour les URLs monitorées, pas les articles du jour.

Ce que SpeedCurve apporte tout de même, par article : décomposition terrain de l'INP en 3 phases + l'élément sur lequel l'utilisateur a interagi (`inp_element_selector`). Un sélecteur type `.ad-slot`, `#didomi-notice`, `button.nav-burger` est un indice de composant fautif très concret, complémentaire du proxy PSI.

### Conclusion

- Aucune API (Google ou SpeedCurve) ne donne "le script responsable de l'INP terrain" par article. Cette donnée n'existe qu'en RUM instrumenté (LoAF) ; SpeedCurve la collecte mais ne l'expose que dans son UI.
- Le meilleur compromis implémentable : **PSI (scripts lourds au chargement, proxy lab)** + **SpeedCurve RUM export (élément et phase de l'INP terrain)**. Les deux se croisent bien : PSI dit "le script X mange 800 ms de main thread", SpeedCurve dit "l'INP se joue sur le clic sur le bandeau consent, 70 % en processing time".

## Implémentation

Principe ponytail : zéro dépendance, stdlib Node 22 uniquement, un fichier par source, tout atterrit dans `data.json` sous chaque article, l'UI ajoute un `<details>` natif par ligne.

### Phase 1 : PSI (Google)

**Nouveau `psi.js`** (~60 lignes), même style que `crux.js` :
- `runPsi(url)` : `GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=...&strategy=mobile&category=performance&key=${PSI_API_KEY ?? CRUX_API_KEY}`.
- Retry simple sur 429/500 (réutiliser le pattern `attempt < N` de `crux.js:44`), timeout via `AbortSignal.timeout(90_000)`.
- Extraction dans un objet compact :
  ```js
  { tbt, scripts: [{url, total, scripting}] /* top 8 de bootup-time */,
    thirdParties: [{entity, mainThread, blocking}] /* top 8 de third-parties-insight */,
    longTasks: n, lighthouseVersion, fetchedAt }
  ```
- Une garde `console.assert` sur la fonction pure d'extraction avec un fixture minimal inline (même approche que `crux.js:20-23`).

**`collect.js`** : après le tri à la ligne 100, prendre les articles `p75 > 200` (seuil `cfg.psi.threshold`), plafonner à `cfg.psi.max` (défaut 15 : ~10 min de collecte, quota négligeable), `pool(..., 2, ...)` et attacher `a.lab = await runPsi(a.url)`. Échec PSI = `a.lab = null`, on ne casse pas la collecte. Flag `--no-psi` (ou `cfg.psi.enabled=false`) pour garder une collecte CrUX rapide.

**`config.json`** : `"psi": { "enabled": true, "threshold": 200, "max": 15 }`.

**`.env`** : `PSI_API_KEY` optionnelle (retombe sur `CRUX_API_KEY`). Le fichier `.env` est déjà gitignoré.

### Phase 2 : SpeedCurve RUM export (conditionnelle aux prérequis)

**Nouveau `speedcurve.js`** (~80 lignes) :
- `fetchRumDay(dateYYYYMMDD)` : `GET /v1/lux/export?date=...` avec `Authorization: Basic base64(SPEEDCURVE_API_KEY + ':')`, puis téléchargement de l'URL S3 pré-signée, `zlib.createGunzip()` + `readline` en streaming (le CSV d'une journée d'un site média peut être gros ; on ne charge jamais tout en mémoire).
- Filtre à la volée : garder les lignes dont `pathname` est dans le Set des pathnames des articles du tableau **et** `interaction_to_next_paint` > 0.
- Agrégation par pathname : `n`, `inpP75` (réutiliser `percentile()` de `collect.js:12`, à exporter), médianes des 3 phases, top 5 `inp_element_selector` avec compte et INP médian par sélecteur.
- Sortie : `a.rum = { n, inpP75, phases: {input, processing, presentation}, elements: [{selector, n, inpMedian}] }`.
- Parsing CSV : `split('^')`, colonnes lues par nom depuis la ligne d'en-tête (la doc prévient que des colonnes peuvent s'ajouter).

**`collect.js`** : lancer pour le jour J-1 (export dispo après 5 h UTC) et éventuellement J-2 pour coller aux articles J-2. Ignoré si `SPEEDCURVE_API_KEY` absente.

Prérequis côté utilisateur, hors code : activer "Enable RUM export API" dans SpeedCurve (Settings > RUM), récupérer la clé API, vérifier que le RUM SpeedCurve n'est pas trop échantillonné pour avoir des page vues par article.

### UI (`index.html`)

Dans `table()` (`index.html:106`), transformer la ligne en `<tr>` + une seconde `<tr>` de détail masquée via `<details>` natif dans la cellule Article (pas de JS d'ouverture/fermeture). Contenu du détail :
- Bloc **Lab (PSI)** : TBT, puis une mini-table `Script | CPU ms` (top 8, URLs tronquées au host + fichier) et `Tiers | main thread ms | bloquant ms`.
- Bloc **Terrain (SpeedCurve RUM)** : n page vues, INP p75, barre 3 segments des phases (réutiliser `distro()` / `.bar` existants avec des couleurs neutres), liste des sélecteurs les plus fréquents.
- Une puce dans la colonne Article ("lab", "rum") pour signaler qu'un détail existe ; les articles sans détail gardent la ligne actuelle.
- Ajouter la mention des sources dans `#meta`.

### Fichiers touchés

- `psi.js` (nouveau), `speedcurve.js` (nouveau)
- `collect.js` : export de `percentile`, enrichissement des articles après la ligne 100
- `config.json` : bloc `psi`
- `index.html` : `table()` + quelques règles CSS pour `details`
- `.env` : `PSI_API_KEY` (optionnel), `SPEEDCURVE_API_KEY`

Hors périmètre, à dire une fois : la vraie attribution terrain par script exige d'ajouter le build "attribution" de `web-vitals` (ou d'attendre que SpeedCurve expose ses données LoAF en export). À reconsidérer si le proxy PSI ne suffit pas.

## Vérification

1. `curl` manuel d'un `runPagespeed` sur le pire article de `data.json` pour vérifier que la clé fonctionne et que `bootup-time` / `third-parties-insight` sont bien présents dans la réponse (sinon adapter les ids).
2. `npm run collect` : vérifier dans la sortie le nombre d'articles enrichis, et dans `data.json` la présence de `lab` (et `rum`) sur les articles > 200 ms.
3. `npm run serve` puis ouvrir `http://localhost:4321` avec chrome-devtools : les lignes rouges/jaunes ont un `<details>`, ouverture affiche les scripts triés, aucune erreur console, table lisible sur 390 px de large.
4. SpeedCurve : `curl -u $SPEEDCURVE_API_KEY: "https://api.speedcurve.com/v1/lux/export?date=YYYYMMDD"` doit renvoyer une URL S3 ; premier run le lendemain de l'activation du toggle.
5. Les `console.assert` inline des fonctions d'extraction passent au démarrage de la collecte.
