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
