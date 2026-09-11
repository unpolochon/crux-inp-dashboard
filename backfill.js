// Backfill de metrics.sqlite depuis l'API CrUX : un point par jour et par groupe d'articles.
// ponytail: CrUX n'a pas d'historique journalier par URL. On interroge aujourd'hui le record de
// chaque article du sitemap news (~2 semaines) et on l'agrege par jour de publication, date comme
// l'aurait fait la collecte quotidienne (publication + articlesLagDays). Approximation : le p75
// couvre toute la vie de l'article (fenetre 28 j), pas seulement ses 2 premiers jours.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { queryRecord, fetchArticles, pubDate, pool } from './crux.js';
import { aggregate } from './stats.js';
import { openDb } from './db.js';

const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));
const METRIC = 'interaction_to_next_paint';
const today = new Date().toISOString().slice(0, 10);

const plusDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
console.assert(plusDays('2026-08-31', 2) === '2026-09-02', 'plusDays: passage de mois');

// Certaines rubriques (Étudiant) n'ont pas de date dans l'URL : on prend celle du sitemap.
const { allUrls, meta } = await fetchArticles(cfg, cfg.articlesLagDays);
const dateOf = (url) => pubDate(url) ?? meta.get(url)?.published?.slice(0, 10) ?? null;
const dated = allUrls.filter(dateOf);
console.log(`→ ${dated.length} articles datés dans le sitemap, records CrUX…`);

// Cache par URL : ~3000 appels a 150/min, on ne veut pas tout refaire si la collecte plante.
const cacheFile = process.env.BACKFILL_CACHE ?? new URL('./.backfill-cache.json', import.meta.url);
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
let done = 0;
await pool(dated.filter((u) => !(u in cache)), 5, async (url) => {
  cache[url] = (await queryRecord({ url }, 'PHONE'))?.metrics?.[METRIC] ?? null;
  if (++done % 100 === 0) {
    console.log(`   ${done} appels`);
    writeFileSync(cacheFile, JSON.stringify(cache));
  }
});
writeFileSync(cacheFile, JSON.stringify(cache));

// Regroupe par jour de collecte equivalent ; les jours futurs (articles trop recents) sont ignores.
const byDate = new Map();
for (const url of dated) {
  const date = plusDays(dateOf(url), cfg.articlesLagDays);
  if (!cache[url] || date > today) continue;
  byDate.set(date, [...(byDate.get(date) ?? []), { url, metrics: { [METRIC]: cache[url] } }]);
}
console.log(`   ${[...byDate.values()].flat().length} avec données INP, ${byDate.size} jours`);

// INSERT OR IGNORE : un backfill ne remplace jamais un relevé quotidien déjà en base.
const db = openDb();
for (const g of cfg.articleGroups) {
  const added = [...byDate].sort()
    .map(([date, recs]) => [date, recs.filter((r) => r.url.includes(g.prefix))])
    .filter(([, recs]) => recs.length)
    .map(([date, recs]) => ({ date, source: 'crux', kind: 'group', id: g.id, ...aggregate(recs)[METRIC] }));
  if (!added.length) continue;
  db.insertMissing(added);
  console.log(`   ${g.label}: ${added.length} jours, ${added.map((p) => `${p.date.slice(5)} (${p.samples}, ${p.p75})`).join(' ')}`);
}
console.log('✓ metrics.sqlite mis à jour');

// data.json copie l'historique des groupes au moment de la collecte : sans ca, le dashboard
// ne voit les points backfill qu'a la prochaine collecte.
const dataFile = new URL('./public/data.json', import.meta.url);
if (existsSync(dataFile)) {
  const data = JSON.parse(readFileSync(dataFile, 'utf8'));
  for (const g of data.articleGroups ?? []) g.history = db.series('crux', 'group', g.id);
  writeFileSync(dataFile, JSON.stringify(data, null, 2));
  console.log('✓ data.json: historique des groupes rafraîchi');
}
