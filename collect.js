// Collecte CrUX -> data.json (utilisé par le dashboard).
import { readFileSync, writeFileSync } from 'node:fs';
import { queryRecord, queryHistory, fetchArticles, fetchSectionArticles, pool } from './crux.js';
import { fetchRumDay, aggregateRum } from './speedcurve.js';
import { percentile } from './stats.js';

const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));
const log = (...a) => console.log(...a);
const METRIC = 'interaction_to_next_paint';

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Le "p75" d'un groupe d'articles est le p75 des p75 par article (comme Grafana),
// pas leur moyenne : une moyenne lisse les gros écarts et sous-estime les pires cas.
// Les densités good/ni/poor restent moyennées (ce sont déjà des proportions).
function aggregate(records) {
  const byMetric = {};
  for (const r of records) {
    for (const [name, m] of Object.entries(r.metrics)) {
      (byMetric[name] ??= []).push(m);
    }
  }
  const out = {};
  for (const [name, ms] of Object.entries(byMetric)) {
    out[name] = {
      p75: percentile(ms.map((m) => m.p75).filter((v) => v != null), 75),
      good: mean(ms.map((m) => m.good).filter((v) => v != null)),
      ni: mean(ms.map((m) => m.ni).filter((v) => v != null)),
      poor: mean(ms.map((m) => m.poor).filter((v) => v != null)),
      samples: ms.length,
    };
  }
  return out;
}

log('→ origine (mobile)…');
const [originPhone, historyPhone] = await Promise.all([
  queryRecord({ origin: cfg.origin }, 'PHONE'),
  queryHistory({ origin: cfg.origin }, 'PHONE'),
]);

log('→ pages clés…');
const targets = cfg.pages.flatMap((p) => p.formFactors.map((ff) => ({ ...p, formFactor: ff })));
const pages = (
  await pool(targets, 5, async (t) => {
    const rec = await queryRecord({ url: t.url }, t.formFactor);
    log(`   ${rec ? '✓' : '·'} ${t.label} [${t.formFactor}]`);
    return { id: t.id, label: t.label, url: t.url, formFactor: t.formFactor, metrics: rec?.metrics ?? null };
  })
).filter(Boolean);

log(`→ articles J-${cfg.articlesLagDays}…`);
const { date, urls, allUrls, meta } = await fetchArticles(cfg, cfg.articlesLagDays);
log(`   ${urls.length} articles publiés le ${date}`);

const articleGroups = [];
const byUrl = new Map();
for (const g of cfg.articleGroups) {
  // Les rubriques de niche publient peu : si rien à J-2, on élargit à tout le sitemap news (~3 semaines).
  let scope = 'J-' + cfg.articlesLagDays;
  let sample = urls.filter((u) => u.includes(g.prefix));
  if (!sample.length && g.prefix) {
    sample = allUrls.filter((u) => u.includes(g.prefix));
    scope = 'sitemap récent';
  }
  // Jardin n'apparaît pas du tout dans le sitemap news : on scrape la page rubrique.
  if (!sample.length && g.sectionUrl) {
    const sec = await fetchSectionArticles(g.sectionUrl, g.prefix);
    for (const [u, m] of sec.meta) meta.set(u, m);
    sample = sec.urls;
    scope = 'page rubrique';
  }
  // Le groupe "all" doit couvrir tous les articles J-2 (sinon le tableau rate les pires, cf. bug constaté) ;
  // seules les rubriques de niche (élargies au sitemap ~3 semaines) sont plafonnées pour limiter les appels CrUX.
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

const rumDates = [];
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
} else {
  log(`→ attribution INP SpeedCurve ignorée (${rumEnabled ? 'clé absente' : 'désactivée'})`);
}

writeFileSync(
  new URL('./data.json', import.meta.url),
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
    },
    null,
    2
  )
);
log('✓ data.json écrit');
