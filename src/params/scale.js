/**
 * Scaling helpers — single place where 0..127 becomes music.
 *
 * Pipeline: CC(0..127) -> norm(0..1) -> curve -> binding window -> param value
 * Reverse:  param value -> norm (for UI arcs / pickup comparison).
 */

export const CURVES = ['linear', 'exp', 'step'];

export function applyCurve(norm, curve = 'linear') {
  const n = Math.min(1, Math.max(0, Number(norm) || 0));
  if (curve === 'exp') return n * n; // perceptual-ish (volume, filter feel)
  if (curve === 'step') return n > 0.5 ? 1 : 0;
  return n;
}

export function invertCurve(shaped, curve = 'linear') {
  const s = Math.min(1, Math.max(0, Number(shaped) || 0));
  if (curve === 'exp') return Math.sqrt(s);
  return s; // linear + step are not cleanly invertible; best-effort
}

/** Apply binding min/max window (both 0..1) after curve. */
export function applyWindow(shaped, min = 0, max = 1) {
  const lo = Math.min(1, Math.max(0, Number(min) ?? 0));
  const hi = Math.min(1, Math.max(0, Number(max) ?? 1));
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return a + shaped * (b - a);
}

export function invertWindow(ranged, min = 0, max = 1) {
  const lo = Math.min(1, Math.max(0, Number(min) ?? 0));
  const hi = Math.min(1, Math.max(0, Number(max) ?? 1));
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  if (b - a < 1e-6) return 0;
  return Math.min(1, Math.max(0, (ranged - a) / (b - a)));
}

/** Full forward: norm -> musical value via descriptor hooks. */
export function normToParam(norm, binding, desc) {
  const shaped = applyCurve(norm, binding?.curve || 'linear');
  const ranged = applyWindow(shaped, binding?.min ?? 0, binding?.max ?? 1);
  if (typeof desc?.fromNorm === 'function') return desc.fromNorm(ranged);
  const min = desc?.min ?? 0;
  const max = desc?.max ?? 1;
  return min + ranged * (max - min);
}

/** Full reverse: musical value -> norm (for arcs + pickup). */
export function paramToNorm(value, binding, desc) {
  let ranged = 0;
  if (typeof desc?.toNorm === 'function') {
    ranged = desc.toNorm(value);
  } else {
    const min = desc?.min ?? 0;
    const max = desc?.max ?? 1;
    ranged = (max - min) < 1e-9 ? 0 : (value - min) / (max - min);
  }
  const unwindowed = invertWindow(ranged, binding?.min ?? 0, binding?.max ?? 1);
  return invertCurve(unwindowed, binding?.curve || 'linear');
}

export const formatPct = (v) => `${Math.round(v * 100)}%`;
export const formatBpm = (v) => `${Math.round(v)}`;
export const formatDb = (v) => (v <= 0.001 ? '-inf' : `${(20 * Math.log10(Math.max(1e-3, v))).toFixed(1)}dB`);
export const formatHz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}kHz` : `${Math.round(v)}Hz`);
