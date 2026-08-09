// Collecte CrUX -> data.json (utilisé par le dashboard).
import { readFileSync, writeFileSync } from 'node:fs';
import { queryRecord, queryHistory, fetchArticles, pool } from './crux.js';

const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));
const log = (...a) => console.log(...a);

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Moyenne des p75 / densités d'un lot d'articles, par métrique.
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
      p75: mean(ms.map((m) => m.p75)),
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
const { date, urls, allUrls } = await fetchArticles(cfg, cfg.articlesLagDays);
log(`   ${urls.length} articles publiés le ${date}`);

const articleGroups = [];
for (const g of cfg.articleGroups) {
  // Les rubriques de niche publient peu : si rien à J-2, on élargit à tout le sitemap news (~3 semaines).
  let scope = 'J-' + cfg.articlesLagDays;
  let sample = urls.filter((u) => u.includes(g.prefix));
  if (!sample.length && g.prefix) {
    sample = allUrls.filter((u) => u.includes(g.prefix));
    scope = 'sitemap récent';
  }
  sample = sample.slice(0, cfg.articlesSampleSize);
  if (!sample.length) continue;
  const recs = (await pool(sample, 5, (u) => queryRecord({ url: u }, 'PHONE'))).filter(Boolean);
  log(`   ${g.label} (${scope}): ${recs.length}/${sample.length} avec données CrUX`);
  if (recs.length) articleGroups.push({ ...g, date, scope, queried: sample.length, metrics: aggregate(recs) });
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
    },
    null,
    2
  )
);
log('✓ data.json écrit');
