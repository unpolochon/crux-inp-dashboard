// Seuils Core Web Vitals pour l'INP, partagés par toutes les vues.
export const INP = { key: 'interaction_to_next_paint', label: 'INP', unit: 'ms', good: 200, poor: 500 };

/** Note un p75 : 'good' <=200 ms, 'ni' <=500 ms, 'poor' au-dela. */
export const rate = (v) => (v == null ? null : v <= INP.good ? 'good' : v <= INP.poor ? 'ni' : 'poor');

export const RATING_BG = { good: 'bg-good', ni: 'bg-ni', poor: 'bg-poor' };
export const RATING_TEXT = { good: 'text-good', ni: 'text-ni', poor: 'text-poor' };

export const ms = (v) => (v == null ? '-' : Math.round(v).toLocaleString('fr-FR'));
export const num = (v) => (v ?? 0).toLocaleString('fr-FR');
export const pct = (v) => (v == null ? '-' : `${(v * 100).toFixed(0)} %`);
export const dayFR = (s) => (s ? s.slice(0, 10).split('-').reverse().join('/') : '-');
/** 20260907 -> 07/09 */
export const rumDayFR = (s) => `${s.slice(6, 8)}/${s.slice(4, 6)}`;
