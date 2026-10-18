/**
 * Knob map persistence — KnobSlot + Binding split.
 * Mirrors pads/model.js conventions: versioned key + migration.
 */
import { DEFAULT_KNOB_CC } from '../state/settings.js';

export const KNOBMAP_KEY = 'magicbeatz-knobmap-v1';
export const KNOBMAP_SCHEMA = 1;

export const KNOB_IDS = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8'];

/** Factory default: K1 swing, K2 bpm, K3+ first 6 channel gains. */
export function defaultKnobMap() {
  const knobs = KNOB_IDS.map((id, i) => ({
    id,
    cc: DEFAULT_KNOB_CC[i] ?? 70 + i,
    channel: null, // null = any channel
    mode: i < 2 ? 'pickup' : 'absolute',
  }));
  const bindings = [
    { knobId: 'K1', paramId: 'swing', min: 0, max: 1, curve: 'linear' },
    { knobId: 'K2', paramId: 'bpm', min: 0, max: 1, curve: 'linear' },
  ];
  for (let i = 2; i < 8; i += 1) {
    bindings.push({
      knobId: KNOB_IDS[i],
      paramId: `ch:${i - 2}:gain`, // resolved dynamically against active pattern
      min: 0, max: 1, curve: 'linear',
    });
  }
  return { knobs, bindings };
}

export function loadKnobMap() {
  try {
    const raw = localStorage.getItem(KNOBMAP_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.schemaVersion === KNOBMAP_SCHEMA && Array.isArray(parsed.knobs)) {
        return sanitize(parsed);
      }
    }
  } catch { /* ignore -> factory */ }
  const fresh = defaultKnobMap();
  saveKnobMap(fresh);
  return fresh;
}

function sanitize(parsed) {
  const fresh = defaultKnobMap();
  const knobs = KNOB_IDS.map((id, i) => {
    const found = parsed.knobs.find((k) => k.id === id);
    return {
      id,
      cc: Number.isFinite(found?.cc) ? Math.min(127, Math.max(0, found.cc | 0)) : fresh.knobs[i].cc,
      channel: Number.isFinite(found?.channel) ? found.channel : null,
      mode: ['absolute', 'pickup', 'relative'].includes(found?.mode) ? found.mode : fresh.knobs[i].mode,
    };
  });
  const bindings = KNOB_IDS.map((id) => {
    const found = parsed.bindings?.find((b) => b.knobId === id);
    if (!found) return { knobId: id, paramId: null, min: 0, max: 1, curve: 'linear' };
    return {
      knobId: id,
      paramId: typeof found.paramId === 'string' ? found.paramId : null,
      min: Math.min(1, Math.max(0, Number(found.min) ?? 0)),
      max: Math.min(1, Math.max(0, Number(found.max) ?? 1)),
      curve: ['linear', 'exp', 'step'].includes(found.curve) ? found.curve : 'linear',
    };
  });
  return { knobs, bindings };
}

export function saveKnobMap(map) {
  try {
    localStorage.setItem(KNOBMAP_KEY, JSON.stringify({
      schemaVersion: KNOBMAP_SCHEMA,
      savedAt: new Date().toISOString(),
      ...map,
    }));
  } catch { /* ignore */ }
}

export function bindingFor(map, knobId) {
  return map.bindings.find((b) => b.knobId === knobId) || null;
}

export function knobsForCC(map, cc) {
  return map.knobs.filter((k) => k.cc === cc);
}

/** Amber-warning helper: duplicate CCs or duplicate param targets. */
export function knobConflicts(map) {
  const out = new Map(); // knobId -> [reasons]
  const byCC = new Map();
  for (const k of map.knobs) {
    if (!byCC.has(k.cc)) byCC.set(k.cc, []);
    byCC.get(k.cc).push(k.id);
  }
  for (const [, ids] of byCC) {
    if (ids.length > 1) {
      for (const id of ids) {
        if (!out.has(id)) out.set(id, []);
        out.get(id).push(`shares CC with ${ids.filter((x) => x !== id).join(', ')}`);
      }
    }
  }
  const byParam = new Map();
  for (const b of map.bindings) {
    if (!b.paramId) continue;
    if (!byParam.has(b.paramId)) byParam.set(b.paramId, []);
    byParam.get(b.paramId).push(b.knobId);
  }
  for (const [pid, ids] of byParam) {
    if (ids.length > 1) {
      for (const id of ids) {
        if (!out.has(id)) out.set(id, []);
        out.get(id).push(`shares target ${pid} with ${ids.filter((x) => x !== id).join(', ')}`);
      }
    }
  }
  return out;
}
