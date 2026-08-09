// Collecte CrUX -> data.json (utilisé par le dashboard).
import { readFileSync, writeFileSync } from 'node:fs';
import { queryRecord, queryHistory, fetchArticles, pool } from './crux.js';

const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));
const log = (...a) => console.log(...a);
const METRIC = 'interaction_to_next_paint';

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Percentile (rang interpolé) d'un tableau de valeurs.
function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

// ponytail: auto-contrôle en tête de collecte plutôt qu'un fichier de test dédié.
console.assert(percentile([10], 75) === 10, 'percentile: valeur unique');
console.assert(percentile([1, 2, 3, 4, 5], 75) === 4, 'percentile: rang entier');
console.assert(percentile([1, 2, 3, 4], 75) === 3.25, 'percentile: rang interpolé');
console.assert(percentile([], 75) === null, 'percentile: vide');

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
let articles = [];
for (const g of cfg.articleGroups) {
  // Les rubriques de niche publient peu : si rien à J-2, on élargit à tout le sitemap news (~3 semaines).
  let scope = 'J-' + cfg.articlesLagDays;
  let sample = urls.filter((u) => u.includes(g.prefix));
  if (!sample.length && g.prefix) {
    sample = allUrls.filter((u) => u.includes(g.prefix));
    scope = 'sitemap récent';
  }
  // Le groupe "all" doit couvrir tous les articles J-2 (sinon le tableau rate les pires, cf. bug constaté) ;
  // seules les rubriques de niche (élargies au sitemap ~3 semaines) sont plafonnées pour limiter les appels CrUX.
  if (g.id !== 'all') sample = sample.slice(0, cfg.articlesSampleSize);
  if (!sample.length) continue;
  const recs = (await pool(sample, 5, (u) => queryRecord({ url: u }, 'PHONE'))).filter(Boolean);
  log(`   ${g.label} (${scope}): ${recs.length}/${sample.length} avec données CrUX`);
  if (recs.length) articleGroups.push({ ...g, date, scope, queried: sample.length, metrics: aggregate(recs) });

  // Le groupe "all" interroge déjà chaque article : on garde le détail pour le tableau par article.
  if (g.id === 'all') {
    articles = recs
      .map((r) => ({ url: r.key.url, ...meta.get(r.key.url), ...r.metrics[METRIC] }))
      .filter((a) => a.p75 != null)
      .sort((a, b) => b.p75 - a.p75);
  }
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
    },
    null,
    2
  )
);
log('✓ data.json écrit');
