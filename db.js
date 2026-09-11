// Stockage des métriques agrégées (CrUX et RUM) dans metrics.sqlite, versionné.
// ponytail: une seule table, clé primaire (date, source, kind, id). Pas d'attribution INP
// (éléments, phases, articles) : seulement les agrégats p75/good/ni/poor par entité et par jour.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS metrics (
    date    TEXT NOT NULL,   -- YYYY-MM-DD, jour de la collecte
    source  TEXT NOT NULL,   -- 'crux' | 'rum'
    kind    TEXT NOT NULL,   -- 'origin' | 'page' | 'group'
    id      TEXT NOT NULL,   -- 'origin', cfg.pages[].id ou cfg.articleGroups[].id
    p75     REAL NOT NULL,
    good    REAL, ni REAL, poor REAL,
    samples INTEGER,         -- CrUX groupes : articles agrégés ; RUM : pages vues (n)
    PRIMARY KEY (date, source, kind, id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS articles (
    url       TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    published TEXT,            -- YYYY-MM-DD depuis l'URL, NULL si l'URL n'est pas datée
    seen      TEXT NOT NULL    -- YYYY-MM-DD, première apparition dans un flux RSS
  ) STRICT`;

// Fenêtre "récent" pour les rubriques de niche, comme l'ancien sitemap news (~3 semaines).
const RECENT_DAYS = 21;

export function openDb(path = new URL('./metrics.sqlite', import.meta.url).pathname) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const replace = db.prepare(
    'INSERT OR REPLACE INTO metrics (date, source, kind, id, p75, good, ni, poor, samples) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const ignore = db.prepare(
    'INSERT OR IGNORE INTO metrics (date, source, kind, id, p75, good, ni, poor, samples) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const select = db.prepare(
    'SELECT date, p75, good, ni, poor, samples FROM metrics WHERE source = ? AND kind = ? AND id = ? ORDER BY date'
  );
  const addArticle = db.prepare('INSERT OR IGNORE INTO articles (url, title, published, seen) VALUES (?, ?, ?, ?)');
  const recent = db.prepare(`SELECT url, title, published FROM articles WHERE seen >= ? ORDER BY published DESC, url`);
  // ponytail: purge à 30 j pour garder metrics.sqlite (versionné 3x/jour) petit. Étendre si un
  // historique par article devient utile.
  const purge = db.prepare('DELETE FROM articles WHERE seen < ?');
  const isoDaysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const write = (stmt, rows) => {
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        if (r.p75 == null) continue;
        stmt.run(r.date, r.source, r.kind, r.id, r.p75, r.good ?? null, r.ni ?? null, r.poor ?? null, r.samples ?? null);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  return {
    /** Écrit les lignes ; une re-collecte le même jour remplace le point du jour. */
    upsert: (rows) => write(replace, rows),
    /** Écrit sans écraser : un backfill ne remplace jamais un relevé quotidien réel. */
    insertMissing: (rows) => write(ignore, rows),
    /** Série ordonnée par date, même forme que l'ancien history.json. */
    series: (source, kind, id) => select.all(source, kind, id).map((r) => ({ ...r })),
    /** Mémorise les articles vus dans les flux ; la première date d'apparition est conservée. */
    addArticles: (items, today = isoDaysAgo(0)) => {
      db.exec('BEGIN');
      for (const a of items) addArticle.run(a.url, a.title, a.published ?? null, today);
      purge.run(isoDaysAgo(30));
      db.exec('COMMIT');
    },
    /** Articles publiés à J-lag (urls) et tous les articles récents (allUrls), même forme que l'ancien fetchArticles. */
    articles: (lagDays) => {
      const iso = isoDaysAgo(lagDays);
      const rows = recent.all(isoDaysAgo(RECENT_DAYS));
      return {
        date: iso.split('-').reverse().join('-'),
        urls: rows.filter((r) => r.published === iso).map((r) => r.url),
        allUrls: rows.map((r) => r.url),
        meta: new Map(rows.map((r) => [r.url, { title: r.title, published: r.published }])),
      };
    },
  };
}

const t = openDb(':memory:');
t.upsert([{ date: '2026-09-02', source: 'crux', kind: 'group', id: 'all', p75: 300, samples: 10 }]);
t.upsert([{ date: '2026-09-01', source: 'crux', kind: 'group', id: 'all', p75: 250, good: 0.7 }]);
t.upsert([{ date: '2026-09-02', source: 'crux', kind: 'group', id: 'all', p75: 310, samples: 12 }]);
t.insertMissing([{ date: '2026-09-02', source: 'crux', kind: 'group', id: 'all', p75: 999 }]);
t.upsert([{ date: '2026-09-03', source: 'crux', kind: 'group', id: 'all', p75: null }]);
const s = t.series('crux', 'group', 'all');
console.assert(s.length === 2, 'db: doublon remplacé, p75 null ignoré');
console.assert(s[0].date === '2026-09-01' && s[0].good === 0.7 && s[0].ni === null, 'db: ordre et colonnes');
console.assert(s[1].p75 === 310 && s[1].samples === 12, 'db: INSERT OR REPLACE, backfill n’écrase pas');
console.assert(t.series('rum', 'group', 'all').length === 0, 'db: clé source distincte');

{
  const iso = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  const dated = `https://x.fr/sports/a-${iso.split('-').reverse().join('-')}-A.php`;
  t.addArticles([
    { url: dated, title: 'A', published: iso },
    { url: 'https://x.fr/jardin/b.php', title: 'B', published: null },
  ], '2026-09-11');
  t.addArticles([{ url: dated, title: 'A2', published: iso }], '2026-09-12');
  const a = t.articles(2);
  console.assert(a.date === iso.split('-').reverse().join('-'), 'articles: date jj-mm-aaaa');
  console.assert(a.allUrls.length === 2 && a.meta.get(dated).title === 'A', 'articles: INSERT OR IGNORE, meta');
  console.assert(a.urls.length === 1 && a.urls[0] === dated, 'articles: J-2 = publié ce jour-là');
  console.assert(a.meta.get('https://x.fr/jardin/b.php').published === null, 'articles: sans date -> récent uniquement');
}
