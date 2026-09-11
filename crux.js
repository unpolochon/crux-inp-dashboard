// Client CrUX + collecte des URLs d'articles.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const API = 'https://chromeuxreport.googleapis.com/v1/records';
const KEY = process.env.CRUX_API_KEY;
if (!KEY) throw new Error('CRUX_API_KEY manquante');

// ponytail: on ne suit plus que l'INP mobile, cf. demande utilisateur.
const METRICS = ['interaction_to_next_paint'];

// Limiteur de débit proactif : CrUX autorise 150 requêtes/minute. On espace nous-mêmes les
// appels (1 toutes les 400 ms) pour ne quasiment jamais taper le quota, au lieu de foncer et
// de subir des 429 en boucle qui peuvent faire échouer toute la collecte.
const MIN_INTERVAL_MS = 60_000 / 150;

// Calcul pur (testable sans horloge réelle) : temps d'attente et prochain slot libre.
function nextSlotFor(now, prevSlot, intervalMs) {
  const wait = Math.max(0, prevSlot - now);
  return { wait, slot: Math.max(now, prevSlot) + intervalMs };
}
console.assert(nextSlotFor(0, 0, 400).wait === 0, 'throttle: premier appel immédiat');
console.assert(nextSlotFor(0, 0, 400).slot === 400, 'throttle: slot suivant +400ms');
console.assert(nextSlotFor(100, 400, 400).wait === 300, 'throttle: attente si en avance sur le slot');
console.assert(nextSlotFor(900, 400, 400).wait === 0, 'throttle: pas d’attente si déjà en retard');

let nextSlot = 0;
async function throttle() {
  const { wait, slot } = nextSlotFor(Date.now(), nextSlot, MIN_INTERVAL_MS);
  nextSlot = slot;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

async function post(endpoint, body, attempt = 0) {
  await throttle();
  const r = await fetch(`${API}:${endpoint}?key=${KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) {
    // 404 = pas assez de trafic pour cette URL, cas normal et fréquent.
    if (j.error.code === 404) return null;
    // 429 = quota 150 req/min dépassé (plan gratuit) ; on retente après une pause plutôt que d'échouer la collecte.
    if (j.error.code === 429 && attempt < 5) {
      await new Promise((res) => setTimeout(res, 12000));
      return post(endpoint, body, attempt + 1);
    }
    throw new Error(`CrUX ${j.error.code}: ${j.error.message}`);
  }
  return j.record;
}

// Normalise un record CrUX en { lcp: {p75, good, ni, poor}, ... }
function normalize(record) {
  if (!record) return null;
  const out = { key: record.key, metrics: {} };
  // Un record peut exister sans la métrique demandée (trafic suffisant, mais pas d'interaction mesurée).
  for (const [name, m] of Object.entries(record.metrics ?? {})) {
    if (!m.percentiles || m.percentiles.p75 == null) continue;
    const h = m.histogram || [];
    out.metrics[name] = {
      p75: Number(m.percentiles.p75),
      good: h[0]?.density ?? null,
      ni: h[1]?.density ?? null,
      poor: h[2]?.density ?? null,
    };
  }
  return out;
}

export const queryRecord = async (target, formFactor) =>
  normalize(await post('queryRecord', { ...target, formFactor, metrics: METRICS }));

export async function queryHistory(target, formFactor) {
  const rec = await post('queryHistoryRecord', { ...target, formFactor, metrics: METRICS });
  if (!rec) return null;
  const dates = rec.collectionPeriods.map((p) => {
    const d = p.lastDate;
    return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
  });
  const series = {};
  for (const [name, m] of Object.entries(rec.metrics ?? {})) {
    const p75s = m.percentilesTimeseries?.p75s;
    if (!p75s) continue;
    const bins = m.histogramTimeseries || [];
    series[name] = dates.map((date, i) => ({
      date,
      p75: p75s[i] == null ? null : Number(p75s[i]),
      good: bins[0]?.densities?.[i] ?? null,
      ni: bins[1]?.densities?.[i] ?? null,
      poor: bins[2]?.densities?.[i] ?? null,
    }));
  }
  return series;
}

// Exécute des tâches avec une concurrence bornée (l'API CrUX rate-limit vite).
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

// Articles publiés à J-lag, extraits du sitemap news (URLs datées jj-mm-aaaa).
export async function fetchArticles(cfg, lagDays) {
  const d = new Date(Date.now() - lagDays * 864e5);
  const stamp = [d.getDate(), d.getMonth() + 1, d.getFullYear()]
    .map((n, i) => (i < 2 ? String(n).padStart(2, '0') : n))
    .join('-');

  const pages = await Promise.all(
    cfg.sitemapPages.map((from) =>
      fetch(cfg.sitemapUrl + from, { headers: { 'User-Agent': UA } })
        .then((r) => (r.ok ? r.text() : (console.log(`   ! sitemap from=${from}: HTTP ${r.status}`), '')))
        .catch((e) => (console.log(`   ! sitemap from=${from}: ${e.message}`), ''))
    )
  );
  // Titre + date de publication viennent du sitemap news : évite un fetch HTML par article.
  const meta = new Map();
  for (const xml of pages) {
    for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
      const loc = m[1].match(/<loc>([^<]+)<\/loc>/)?.[1];
      if (!loc) continue;
      meta.set(loc, {
        title: m[1].match(/<news:title><!\[CDATA\[([\s\S]*?)\]\]><\/news:title>/)?.[1]?.trim() ?? loc,
        published: m[1].match(/<news:publication_date>([^<]+)</)?.[1] ?? null,
      });
    }
  }
  const urls = [...meta.keys()];
  // Un sitemap vide (CDN qui bloque, panne) doit faire echouer la collecte, pas publier un dashboard vide.
  if (!urls.length) throw new Error('sitemap news vide : aucune URL récupérée');
  return { date: stamp, urls: urls.filter((u) => u.includes(stamp)), allUrls: urls, meta };
}

// Titre lisible depuis le slug d'URL (les sources sans sitemap n'ont pas de <news:title>).
const slugTitle = (path) =>
  path.split('/').pop().replace(/\.php$/, '').replace(/-[A-Z0-9]{20,}$/, '')
    .replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
console.assert(slugTitle('/jardin/actu/mon-chat-dort-12-heures-JRZSWXAPVBGHJFCHI7546QAWCI.php')
  === 'Mon chat dort 12 heures', 'slugTitle: id retiré, tirets remplacés');

// Certaines rubriques (Jardin) sont absentes du sitemap news : on récupère leurs articles
// depuis la page rubrique. Pas de date de publication disponible par cette voie.
export async function fetchSectionArticles(sectionUrl, prefix) {
  // UA complet obligatoire : le CDN renvoie 403 sur un User-Agent court.
  const html = await fetch(sectionUrl, { headers: { 'User-Agent': UA } })
    .then((r) => r.text())
    .catch(() => '');
  const origin = new URL(sectionUrl).origin;
  const paths = [...new Set([...html.matchAll(/"(\/[^"]*\.php)"/g)].map((m) => m[1]))]
    .filter((p) => p.startsWith(prefix));
  const meta = new Map(paths.map((p) => [origin + p, { title: slugTitle(p), published: null }]));
  return { urls: [...meta.keys()], meta };
}
