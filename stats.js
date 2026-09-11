// Percentile par rang interpole, partage par les aggregations CrUX et RUM.
export function percentile(xs, p) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const low = Math.floor(index), high = Math.ceil(index);
  return low === high
    ? sorted[low]
    : sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

console.assert(percentile([10], 75) === 10, 'percentile: valeur unique');
console.assert(percentile([1, 2, 3, 4, 5], 75) === 4, 'percentile: rang entier');
console.assert(percentile([1, 2, 3, 4], 75) === 3.25, 'percentile: rang interpole');
console.assert(percentile([], 75) === null, 'percentile: vide');

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Le "p75" d'un groupe d'articles est le p75 des p75 par article (comme Grafana),
// pas leur moyenne : une moyenne lisse les gros écarts et sous-estime les pires cas.
// Les densités good/ni/poor restent moyennées (ce sont déjà des proportions).
export function aggregate(records) {
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
