/**
 * Parameter registry — "everything is a Param".
 * Knobs, UI sliders, and future automation all read/write through here.
 *
 * Descriptor:
 * { id, label, short, group, min, max, unit, curveHint,
 *   get(), set(v), format(v), fromNorm(n), toNorm(v) }
 * Groups: transport | mix | synth | fx | unmapped
 */

export const PARAM_GROUPS = {
  transport: { label: 'Transport', color: '#6aa8ff' },
  mix: { label: 'Mix', color: '#ff9d5d' },
  synth: { label: 'Synth / FX', color: '#c07bff' },
  unmapped: { label: 'Unmapped', color: '#8a8496' },
};

const defs = new Map();

export function registerParam(desc) {
  if (!desc?.id || typeof desc.get !== 'function' || typeof desc.set !== 'function') {
    throw new Error('registerParam needs { id, get, set }');
  }
  defs.set(desc.id, {
    group: 'mix',
    min: 0,
    max: 1,
    unit: '',
    curveHint: 'linear',
    format: (v) => String(v),
    short: desc.label || desc.id,
    ...desc,
  });
  return desc.id;
}

export function unregisterParam(id) { defs.delete(id); }
export function getParam(id) { return defs.get(id) || null; }
export function listParams() { return [...defs.values()]; }

export function listParamsByGroup() {
  const out = {};
  for (const d of defs.values()) {
    if (!out[d.group]) out[d.group] = [];
    out[d.group].push(d);
  }
  return out;
}

export function clearDynamicParams(prefix = 'ch:') {
  for (const id of [...defs.keys()]) {
    if (id.startsWith(prefix)) defs.delete(id);
  }
}
