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
  ) STRICT`;

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
