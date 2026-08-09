// Client CrUX + collecte des URLs d'articles.
const API = 'https://chromeuxreport.googleapis.com/v1/records';
const KEY = process.env.CRUX_API_KEY;
if (!KEY) throw new Error('CRUX_API_KEY manquante');

// ponytail: on ne suit plus que l'INP mobile, cf. demande utilisateur.
const METRICS = ['interaction_to_next_paint'];

async function post(endpoint, body, attempt = 0) {
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
  for (const [name, m] of Object.entries(rec.metrics)) {
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
      fetch(cfg.sitemapUrl + from, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } })
        .then((r) => r.text())
        .catch(() => '')
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
  return { date: stamp, urls: urls.filter((u) => u.includes(stamp)), allUrls: urls, meta };
}
