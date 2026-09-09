// Client de l'export RUM SpeedCurve et attribution INP par article.
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { percentile } from './stats.js';

const API = 'https://api.speedcurve.com/v1/lux/export';

// L'export n'a pas de ligne d'en-tete. SpeedCurve garantit que l'ordre ne change pas,
// mais peut ajouter des colonnes. Les index sont ceux du schema public a 85 colonnes.
const FALLBACK_INDEX = {
  page_id: 0,
  epoch: 2,
  pathname: 67,
  interaction_to_next_paint: 68,
  inp_element_selector: 69,
  inp_start_time: 70,
  inp_input_delay: 71,
  inp_processing_time: 72,
  inp_presentation_delay: 73,
};
const REQUIRED = ['page_id', 'pathname', 'interaction_to_next_paint'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url, options, label, timeout, attempt = 0) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
  if ((response.status === 429 || response.status >= 500) && attempt < 2) {
    await response.body?.cancel();
    const retryAfter = Number(response.headers.get('retry-after')) * 1000;
    await sleep(retryAfter || (attempt + 1) * 20_000);
    return get(url, options, label, timeout, attempt + 1);
  }
  if (!response.ok) {
    const message = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new Error(`${label} ${response.status}${message ? `: ${message}` : ''}`);
  }
  return response;
}

function indexes(cells) {
  if (cells.includes('pathname') && cells.includes('interaction_to_next_paint')) {
    return {
      header: true,
      values: Object.fromEntries(cells.map((name, index) => [name, index])),
    };
  }
  return { header: false, values: FALLBACK_INDEX };
}

const number = (value) => {
  if (value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function parseRow(cells, index, date) {
  const inp = number(cells[index.interaction_to_next_paint]);
  if (!(inp > 0)) return null;
  const pageId = cells[index.page_id];
  const pathname = cells[index.pathname];
  if (!pageId || !pathname) return null;
  return {
    id: `${date}:${pageId}`,
    pathname,
    epoch: number(cells[index.epoch]) ?? 0,
    inp,
    selector: cells[index.inp_element_selector]?.trim() || null,
    start: number(cells[index.inp_start_time]) ?? 0,
    input: number(cells[index.inp_input_delay]),
    processing: number(cells[index.inp_processing_time]),
    presentation: number(cells[index.inp_presentation_delay]),
  };
}

// Garde la derniere mise a jour INP de chaque page vue. Les interactions envoyees
// apres le beacon principal reutilisent le meme page_id.
export async function fetchRumDay(date, pathnames) {
  const key = process.env.SPEEDCURVE_API_KEY;
  if (!key) throw new Error('SPEEDCURVE_API_KEY manquante');

  const endpoint = new URL(API);
  endpoint.searchParams.set('date', date);
  const auth = Buffer.from(`${key}:`).toString('base64');
  const exportResponse = await get(
    endpoint,
    { headers: { Authorization: `Basic ${auth}` } },
    'SpeedCurve',
    30_000
  );
  const payload = await exportResponse.json();
  if (!payload.download_url) throw new Error('SpeedCurve: download_url absente');

  const download = await get(payload.download_url, {}, 'Export RUM', 300_000);
  if (!download.body) throw new Error('Export RUM: corps vide');

  const compressed = Readable.fromWeb(download.body);
  const gunzip = createGunzip();
  compressed.on('error', (error) => gunzip.destroy(error));
  compressed.pipe(gunzip);
  const lines = createInterface({ input: gunzip, crlfDelay: Infinity });
  const views = new Map();
  let index;

  try {
    for await (const rawLine of lines) {
      if (!rawLine) continue;
      const cells = rawLine.replace(/^\uFEFF/, '').split('^');
      if (!index) {
        const schema = indexes(cells);
        index = schema.values;
        for (const field of REQUIRED) {
          if (index[field] == null) throw new Error(`Export RUM: colonne ${field} absente`);
        }
        if (schema.header) continue;
      }

      const row = parseRow(cells, index, date);
      if (!row || !pathnames.has(row.pathname)) continue;
      const previous = views.get(row.id);
      if (!previous || row.epoch > previous.epoch ||
          (row.epoch === previous.epoch && row.start >= previous.start)) {
        views.set(row.id, row);
      }
    }
  } finally {
    lines.close();
    compressed.destroy();
    gunzip.destroy();
  }
  return [...views.values()];
}

const roundedPercentile = (values, p) => {
  const valid = values.filter((value) => value != null);
  const result = percentile(valid, p);
  return result == null ? null : Math.round(result);
};

export function aggregateRum(records) {
  const byPath = new Map();
  for (const record of records) (byPath.get(record.pathname) ?? byPath.set(record.pathname, []).get(record.pathname)).push(record);

  return new Map([...byPath].map(([pathname, pageViews]) => {
    const byElement = new Map();
    for (const view of pageViews) {
      if (view.selector) (byElement.get(view.selector) ?? byElement.set(view.selector, []).get(view.selector)).push(view);
    }
    const elements = [...byElement].map(([selector, views]) => ({
      selector,
      n: views.length,
      inpMedian: roundedPercentile(views.map((view) => view.inp), 50),
    })).sort((a, b) => b.n - a.n || b.inpMedian - a.inpMedian || a.selector.localeCompare(b.selector)).slice(0, 5);

    return [pathname, {
      n: pageViews.length,
      inpP75: roundedPercentile(pageViews.map((view) => view.inp), 75),
      phases: {
        input: roundedPercentile(pageViews.map((view) => view.input), 50),
        processing: roundedPercentile(pageViews.map((view) => view.processing), 50),
        presentation: roundedPercentile(pageViews.map((view) => view.presentation), 50),
      },
      elements,
    }];
  }));
}

const fixture = aggregateRum([
  { pathname: '/article', inp: 100, input: 10, processing: 20, presentation: 30, selector: '#menu' },
  { pathname: '/article', inp: 200, input: 20, processing: 30, presentation: 40, selector: '#menu' },
  { pathname: '/article', inp: 300, input: 30, processing: 40, presentation: 50, selector: '#menu' },
  { pathname: '/article', inp: 400, input: 40, processing: 50, presentation: 60, selector: '.search' },
]).get('/article');
console.assert(fixture.n === 4 && fixture.inpP75 === 325, 'RUM: p75 par page vue');
console.assert(fixture.phases.processing === 35, 'RUM: mediane des phases');
console.assert(fixture.elements[0].selector === '#menu' && fixture.elements[0].n === 3, 'RUM: top elements');
