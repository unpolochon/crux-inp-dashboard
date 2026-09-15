// Collecte CrUX -> data.json (utilisé par le dashboard).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { queryRecord, queryHistory, fetchArticles, fetchFeeds, pool } from './crux.js';
import { fetchRumDay, aggregateRum, fetchSyntheticTests, fetchHarHosts } from './speedcurve.js';
import { aggregate } from './stats.js';
import { openDb } from './db.js';

const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));
const log = (...a) => console.log(...a);
const METRIC = 'interaction_to_next_paint';
// ARTICLES_SOURCE=sitemap|rss (défaut rss, seule source accessible depuis GitHub Actions).
const source = process.env.ARTICLES_SOURCE ?? 'rss';
if (!['sitemap', 'rss'].includes(source)) throw new Error(`ARTICLES_SOURCE=${source} : attendu sitemap ou rss`);

log('→ origine (mobile)…');
const [originPhone, historyPhone] = await Promise.all([
  queryRecord({ origin: cfg.origin }, 'PHONE'),
  queryHistory({ origin: cfg.origin }, 'PHONE'),
]);

log('→ pages clés…');
const targets = cfg.pages.flatMap((p) => p.formFactors.map((ff) => ({ ...p, formFactor: ff })));
const pages = (
  await pool(targets, 5, async (t) => {
    const [rec, hist] = await Promise.all([
      queryRecord({ url: t.url }, t.formFactor),
      queryHistory({ url: t.url }, t.formFactor),
    ]);
    log(`   ${rec ? '✓' : '·'} ${t.label} [${t.formFactor}]`);
    return {
      id: t.id, label: t.label, url: t.url, formFactor: t.formFactor,
      metrics: rec?.metrics ?? null,
      history: hist?.[METRIC] ?? null,
    };
  })
).filter(Boolean);

// ARTICLES_SOURCE (voir en tête) : le sitemap news est bloqué (403 Akamai) depuis GitHub
// Actions mais reste la source la plus complète en local ; les flux RSS ne remontent qu'aux 100
// derniers articles, d'où l'accumulation dans metrics.sqlite et la relecture de J-2 depuis la base.
log(`→ articles J-${cfg.articlesLagDays} (${source})…`);
const db = openDb();
let date, urls, allUrls, meta;
if (source === 'sitemap') {
  ({ date, urls, allUrls, meta } = await fetchArticles(cfg, cfg.articlesLagDays));
  log(`   ${urls.length} articles publiés le ${date} (${allUrls.length} dans le sitemap)`);
} else {
  const feed = await fetchFeeds(cfg);
  db.addArticles(feed);
  ({ date, urls, allUrls, meta } = db.articles(cfg.articlesLagDays));
  log(`   ${feed.length} articles dans les flux, ${urls.length} publiés le ${date} (${allUrls.length} récents en base)`);
}

const articleGroups = [];
const byUrl = new Map();
for (const g of cfg.articleGroups) {
  // Les rubriques de niche publient peu : si rien à J-2, on élargit aux articles récents (~3 semaines).
  let scope = 'J-' + cfg.articlesLagDays;
  let sample = urls.filter((u) => u.includes(g.prefix));
  if (!sample.length && g.prefix) {
    sample = allUrls.filter((u) => u.includes(g.prefix));
    scope = 'flux récent';
  }
  // Le groupe "all" doit couvrir tous les articles J-2 (sinon le tableau rate les pires, cf. bug constaté) ;
  // seules les rubriques de niche (élargies aux articles récents) sont plafonnées pour limiter les appels CrUX.
  if (g.id !== 'all') sample = sample.slice(0, cfg.articlesSampleSize);
  if (!sample.length) continue;
  const recs = (await pool(sample, 5, (u) => queryRecord({ url: u }, 'PHONE'))).filter(Boolean);
  log(`   ${g.label} (${scope}): ${recs.length}/${sample.length} avec données CrUX`);
  if (recs.length) articleGroups.push({ ...g, date, scope, queried: sample.length, metrics: aggregate(recs) });

  // Détail par article pour le tableau : dédupliqué par URL (les rubriques recoupent "all").
  for (const r of recs) {
    const a = { url: r.key.url, ...meta.get(r.key.url), ...r.metrics[METRIC] };
    if (a.p75 != null) byUrl.set(a.url, a);
  }
}
const articles = [...byUrl.values()].sort((a, b) => b.p75 - a.p75);

// Les articles J-2 changent chaque jour : CrUX n'a pas d'historique pour eux. On enregistre nous-mêmes
// les agrégats du jour dans metrics.sqlite (versionné, survit à la régénération de data.json).
// Une re-collecte le même jour remplace le point du jour au lieu de le doubler.
const today = new Date().toISOString().slice(0, 10);
const row = (kind, id, m) => ({ date: today, source: 'crux', kind, id, ...m });
db.upsert([
  row('origin', 'origin', originPhone?.metrics?.[METRIC]),
  ...pages.map((p) => row('page', p.id, p.metrics?.[METRIC])),
  ...articleGroups.map((g) => row('group', g.id, g.metrics[METRIC])),
]);
for (const g of articleGroups) g.history = db.series('crux', 'group', g.id);
log(`→ metrics.sqlite: ${articleGroups.length} groupes, ${articleGroups.find((g) => g.id === 'all')?.history.length ?? 0} relevés pour "all"`);

const rumDates = [];
let rumElements = [];
const rumEnabled = cfg.rum?.enabled !== false && !process.argv.includes('--no-rum');
if (rumEnabled && process.env.SPEEDCURVE_API_KEY) {
  log('→ attribution INP SpeedCurve RUM…');
  // ponytail: tous les records des pathnames rubrique sont gardes en memoire pour calculer le p75
  // exact. Si le volume homepage devient un probleme, passer a une agregation en flux (t-digest
  // ou echantillonnage par reservoir) plutot qu'a un plafond par pathname, qui biaiserait le p75.
  const articlePaths = new Set(articles.map((article) => new URL(article.url).pathname));
  // Le filtre SpeedCurve est une egalite exacte : on tente les deux formes, avec et sans slash final.
  const sectionPaths = new Set(cfg.pages.flatMap((page) => {
    const pathname = new URL(page.url).pathname;
    return pathname === '/' ? [pathname] : [pathname, pathname.replace(/\/$/, '')];
  }));
  const pathnames = new Set([...articlePaths, ...sectionPaths]);
  const dateForLag = (lag) => new Date(Date.now() - lag * 864e5).toISOString().slice(0, 10).replaceAll('-', '');
  const lags = new Date().getUTCHours() >= 5 ? [2, 1] : [2];
  const records = [];
  for (const lag of lags) {
    const rumDate = dateForLag(lag);
    try {
      const day = await fetchRumDay(rumDate, pathnames);
      for (const view of day) records.push(view);
      rumDates.push(rumDate);
      log(`   ✓ ${rumDate}: ${day.length} pages vues mobile avec INP`);
    } catch (error) {
      log(`   ! ${rumDate}: ${error.message}`);
    }
  }

  const rumByPath = aggregateRum(records);
  const rumForPath = (pathname) =>
    rumByPath.get(pathname) ?? rumByPath.get(pathname.replace(/\/$/, '')) ?? null;
  let enriched = 0;
  for (const article of articles) {
    const rum = rumForPath(new URL(article.url).pathname);
    if (rum) {
      article.rum = rum;
      enriched++;
    }
  }
  log(`   ${records.length.toLocaleString('fr-FR')} pages vues mobile retenues (${sectionPaths.size} pathnames rubrique)`);
  log(`   ${enriched}/${articles.length} articles enrichis`);

  // Agregat terrain par page rubrique, puis par groupe d'articles : meme semantique de prefixe
  // que le cote CrUX, et zero appel API en plus (l'export du jour est deja en memoire).
  for (const page of pages) page.rum = rumForPath(new URL(page.url).pathname);
  for (const group of articleGroups) {
    const views = records.filter((view) =>
      articlePaths.has(view.pathname) && view.pathname.includes(group.prefix));
    group.rum = views.length ? aggregateRum(views, () => group.id).get(group.id) : null;
  }
  log(`   terrain: ${pages.filter((p) => p.rum).length}/${pages.length} rubriques, ` +
      `${articleGroups.filter((g) => g.rum).length}/${articleGroups.length} groupes d'articles`);

  // Agrégats terrain en base, datés du jour de collecte (l'export couvre J-2 et J-1) : même
  // sémantique que les lignes CrUX, "ce que le dashboard affichait ce jour-là".
  // ponytail: seulement p75/good/ni/poor/n. Les phases et éléments (attribution) restent hors base.
  const rumRow = (kind, id, rum) =>
    ({ date: today, source: 'rum', kind, id, p75: rum?.inpP75, good: rum?.good, ni: rum?.ni, poor: rum?.poor, samples: rum?.n });
  db.upsert([
    ...pages.map((p) => rumRow('page', p.id, p.rum)),
    ...articleGroups.map((g) => rumRow('group', g.id, g.rum)),
  ]);

  // Top des elements responsables de l'INP, tous pathnames confondus : la liste de ce qu'il faut
  // corriger en premier. Trie par nombre d'interactions au-dessus du seuil "bon" (200 ms), pas par
  // volume brut : un element tres sollicite mais rapide n'est pas un probleme a corriger.
  const withSelector = records.filter((view) => view.selector);
  rumElements = [...aggregateRum(withSelector, (view) => view.selector)]
    .map(([selector, { elements: _nested, ...agg }]) => ({
      selector,
      ...agg,
      slow: Math.round(agg.n * (agg.ni + agg.poor)),
    }))
    .sort((a, b) => b.slow - a.slow || b.inpP75 - a.inpP75 || a.selector.localeCompare(b.selector))
    .slice(0, 20);
  log(`   ${rumElements.length} elements en tete d'attribution ` +
      `(sur ${new Set(withSelector.map((view) => view.selector)).size} selecteurs distincts)`);
} else {
  log(`→ attribution INP SpeedCurve ignorée (${rumEnabled ? 'clé absente' : 'désactivée'})`);
}

// Scripts tiers : poids et CPU par domaine, depuis le HAR du run médian des tests synthétiques
// SpeedCurve (un test mobile par jour et par page suivie). Seuls les jours absents de la base sont
// téléchargés : le premier passage remonte cfg.scripts.days jours, les suivants un HAR par page.
// ponytail: agrégation par domaine, pas par URL de script (les URLs portent des cache-busters) ;
// pas d'attribution INP par script, la donnée n'existe pas hors UI SpeedCurve (cf. PLAN-inp-attribution.md).
const scripts = [];
if (cfg.scripts && process.env.SPEEDCURVE_API_KEY && !process.argv.includes('--no-scripts')) {
  const { days, browser } = cfg.scripts;
  log(`→ scripts tiers SpeedCurve synthétique (${browser}, ${days} j)…`);
  const firstParty = new URL(cfg.origin).hostname.split('.').slice(-2).join('.');
  for (const page of cfg.scripts.pages) {
    let url = null;
    try {
      const synthetic = await fetchSyntheticTests(page.urlId, days, browser);
      url = synthetic.url;
      const known = db.scriptDays(page.id);
      const missing = synthetic.tests.filter((test) => !known.has(test.day));
      await pool(missing, 3, async (test) => {
        try {
          db.addScripts(page.id, test.day, await fetchHarHosts(test), days);
        } catch (error) {
          log(`   ! ${page.label} ${test.day}: ${error.message}`);
        }
      });
      log(`   ${page.label}: ${synthetic.tests.length} tests, ${missing.length} HAR téléchargés`);
    } catch (error) {
      log(`   ! ${page.label}: ${error.message}`);
    }
    const rows = db.scripts(page.id, days);
    if (!rows.length) continue;
    const dates = [...new Set(rows.map((r) => r.date))];
    const byHost = new Map();
    for (const { host, ...point } of rows) (byHost.get(host) ?? byHost.set(host, []).get(host)).push(point);
    const inpSource = page.inp.kind === 'page'
      ? pages.find((p) => p.id === page.inp.id)
      : articleGroups.find((g) => g.id === page.inp.id);
    scripts.push({
      id: page.id, label: page.label, url, browser, dates,
      inp: { crux: inpSource?.metrics?.[METRIC]?.p75 ?? null, rum: inpSource?.rum?.inpP75 ?? null },
      // Seuls les domaines vus au dernier test sont listés (les gagnants d'enchères pub varient) ;
      // leur historique couvre tous les jours où ils apparaissent.
      hosts: [...byHost]
        .map(([host, series]) => ({ host, firstParty: host.endsWith(firstParty), series }))
        .filter((h) => h.series.at(-1).date === dates.at(-1))
        .sort((a, b) => b.series.at(-1).cpu - a.series.at(-1).cpu || b.series.at(-1).bytes - a.series.at(-1).bytes),
    });
  }
} else {
  log('→ scripts tiers SpeedCurve ignorés');
}

mkdirSync(new URL('./public/', import.meta.url), { recursive: true }); // public/ ne contient que data.json, non versionné
writeFileSync(
  new URL('./public/data.json', import.meta.url),
  JSON.stringify(
    {
      collectedAt: new Date().toISOString(),
      origin: cfg.origin,
      articlesDate: date,
      origins: { PHONE: originPhone?.metrics ?? null },
      history: { PHONE: historyPhone },
      pages,
      articleGroups,
      articles,
      rumDates,
      rumElements,
      scripts,
    },
    null,
    2
  )
);
log('✓ data.json écrit');
