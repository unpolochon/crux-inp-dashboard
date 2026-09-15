// Client de l'export RUM SpeedCurve et attribution INP par article.
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { percentile } from './stats.js';

const API = 'https://api.speedcurve.com/v1/lux/export';
const API_SYNTHETIC = 'https://api.speedcurve.com/v1';

// L'export n'a pas de ligne d'en-tete. SpeedCurve garantit que l'ordre ne change pas,
// mais peut ajouter des colonnes. Les index sont ceux du schema public a 85 colonnes.
const FALLBACK_INDEX = {
  page_id: 0,
  epoch: 2,
  device_type: 55,
  pathname: 67,
  interaction_to_next_paint: 68,
  inp_element_selector: 69,
  inp_start_time: 70,
  inp_input_delay: 71,
  inp_processing_time: 72,
  inp_presentation_delay: 73,
};
const REQUIRED = ['page_id', 'device_type', 'pathname', 'interaction_to_next_paint'];

// Le dashboard entier est mobile (CrUX est interroge en formFactor PHONE) : on ne garde que les
// pages vues mobile. 'tablet' est exclu, comme CrUX qui separe PHONE et TABLET.
const DEVICE = 'mobile';

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
    device: cells[index.device_type],
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
function authHeaders() {
  const key = process.env.SPEEDCURVE_API_KEY;
  if (!key) throw new Error('SPEEDCURVE_API_KEY manquante');
  return { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` };
}

export async function fetchRumDay(date, pathnames) {
  const endpoint = new URL(API);
  endpoint.searchParams.set('date', date);
  const exportResponse = await get(endpoint, { headers: authHeaders() }, 'SpeedCurve', 30_000);
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
  let index, withInp = 0, mobileRows = 0;

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
      if (!row) continue;
      withInp++;
      if (row.device !== DEVICE) continue;
      mobileRows++;
      if (!pathnames.has(row.pathname)) continue;
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
  if (withInp && !mobileRows) {
    throw new Error(`Export RUM: 0 page vue ${DEVICE} sur ${withInp} avec INP ` +
      `(colonne device_type deplacee ? verifier l'index ${FALLBACK_INDEX.device_type})`);
  }
  return [...views.values()];
}

// Seuils INP Core Web Vitals, fixes par spec : bon <= 200 ms, mauvais > 500 ms. Le RUM donne
// les valeurs brutes, donc les parts sont exactes la ou CrUX ne fournit que des densites bucketisees.
const share = (views, test) => views.filter(test).length / views.length;

const roundedPercentile = (values, p) => {
  const valid = values.filter((value) => value != null);
  const result = percentile(valid, p);
  return result == null ? null : Math.round(result);
};

export function aggregateRum(records, key = (record) => record.pathname) {
  const byPath = new Map();
  for (const record of records) {
    const k = key(record);
    (byPath.get(k) ?? byPath.set(k, []).get(k)).push(record);
  }

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
      good: share(pageViews, (view) => view.inp <= 200),
      ni: share(pageViews, (view) => view.inp > 200 && view.inp <= 500),
      poor: share(pageViews, (view) => view.inp > 500),
      phases: {
        input: roundedPercentile(pageViews.map((view) => view.input), 50),
        processing: roundedPercentile(pageViews.map((view) => view.processing), 50),
        presentation: roundedPercentile(pageViews.map((view) => view.presentation), 50),
      },
      elements,
    }];
  }));
}

const fixtureViews = [
  { pathname: '/article', inp: 100, input: 10, processing: 20, presentation: 30, selector: '#menu' },
  { pathname: '/article', inp: 200, input: 20, processing: 30, presentation: 40, selector: '#menu' },
  { pathname: '/article', inp: 300, input: 30, processing: 40, presentation: 50, selector: '#menu' },
  { pathname: '/article', inp: 400, input: 40, processing: 50, presentation: 60, selector: '.search' },
];
const fixture = aggregateRum(fixtureViews).get('/article');
console.assert(fixture.n === 4 && fixture.inpP75 === 325, 'RUM: p75 par page vue');
console.assert(fixture.phases.processing === 35, 'RUM: mediane des phases');
console.assert(fixture.elements[0].selector === '#menu' && fixture.elements[0].n === 3, 'RUM: top elements');
console.assert(fixture.good === 0.5 && fixture.ni === 0.5 && fixture.poor === 0, 'RUM: densites good/ni/poor');
console.assert(aggregateRum(fixtureViews, () => 'grp').get('grp').n === 4, 'RUM: cle de regroupement');

// --- Synthetique : poids et CPU par domaine, depuis le HAR du run median d'un test quotidien.
// L'API /v1/tests ne donne que les totaux first/third party ; le detail par domaine n'existe que
// dans le HAR WebPageTest, ou chaque requete porte _cpuTimes (EvaluateScript, v8.compile, FunctionCall).

/** Tests d'une URL SpeedCurve sur `days` jours : un par jour (le plus recent) pour le navigateur demande. */
export async function fetchSyntheticTests(urlId, days, browser) {
  const response = await get(`${API_SYNTHETIC}/urls/${urlId}?days=${days}`, { headers: authHeaders() }, 'SpeedCurve', 30_000);
  const { url, tests } = await response.json();
  const byDay = new Map();
  for (const test of tests) {
    if (test.browser !== browser || !test.har) continue;
    if (!byDay.has(test.day) || test.timestamp > byDay.get(test.day).timestamp) byDay.set(test.day, test);
  }
  return { url, tests: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)) };
}

/** Agrege les requetes d'un run par domaine : requetes, octets transferes, CPU main thread (ms). */
export function hostsFromHar(har, run) {
  const byHost = new Map();
  for (const entry of har.log.entries) {
    if (entry._run !== run) continue;
    const host = entry._host || '(sans hôte)';
    const agg = byHost.get(host) ?? byHost.set(host, { host, requests: 0, bytes: 0, cpu: 0 }).get(host);
    agg.requests++;
    agg.bytes += entry._bytesIn ?? 0;
    for (const ms of Object.values(entry._cpuTimes ?? {})) agg.cpu += ms;
  }
  return [...byHost.values()].map((agg) => ({ ...agg, cpu: Math.round(agg.cpu) }));
}

/** Telecharge le HAR d'un test (~5 Mo, sans authentification) et l'agrege par domaine. */
export async function fetchHarHosts(test) {
  const response = await get(test.har, {}, 'HAR', 120_000);
  const hosts = hostsFromHar(await response.json(), test.run);
  if (!hosts.length) throw new Error(`HAR ${test.test_id}: aucune requête pour le run ${test.run}`);
  return hosts;
}

{
  const har = { log: { entries: [
    { _run: 1, _host: 'a.com', _bytesIn: 100, _cpuTimes: { EvaluateScript: 10, FunctionCall: 5.4 } },
    { _run: 1, _host: 'a.com', _bytesIn: 50 },
    { _run: 2, _host: 'a.com', _bytesIn: 999, _cpuTimes: { EvaluateScript: 999 } },
    { _run: 1, _host: 'b.com', _bytesIn: 7, _cpuTimes: {} },
  ] } };
  const hosts = hostsFromHar(har, 1);
  const a = hosts.find((h) => h.host === 'a.com');
  console.assert(hosts.length === 2 && a.requests === 2 && a.bytes === 150 && a.cpu === 15, 'HAR: agregation par domaine du seul run demande');
  console.assert(hosts.find((h) => h.host === 'b.com').cpu === 0, 'HAR: requete sans CPU');
}
