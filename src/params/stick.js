/**
 * Stick map persistence — assignable joystick targets with on-screen fallback.
 * MPK mini MK3 stick = X pitchbend (0xE0, bipolar) + Y CC (default CC1, unipolar).
 * When hardware is dead / remapped in the MPK Editor, the on-screen stick +
 * sliders drive the same targets, and Y-CC learn rebinds to any CC.
 */

export const STICKMAP_KEY = 'magicbeatz-stickmap-v1';
export const STICKMAP_SCHEMA = 1;

/** X targets: bipolar -1..+1 (center 0). */
export const STICK_X_OPTIONS = [
  { id: 'bend', label: 'Pitch bend ±2st' },
  { id: 'filter', label: 'Filter cutoff' },
  { id: 'delayMix', label: 'Delay mix' },
  { id: 'reverbMix', label: 'Reverb mix' },
  { id: 'off', label: 'Off' },
];

/** Y targets: unipolar 0..1. */
export const STICK_Y_OPTIONS = [
  { id: 'vibrato', label: 'Vibrato / mod' },
  { id: 'filter', label: 'Filter cutoff' },
  { id: 'delayMix', label: 'Delay mix' },
  { id: 'reverbMix', label: 'Reverb mix' },
  { id: 'master', label: 'Master volume' },
  { id: 'off', label: 'Off' },
];

/** X source: MK3 sends pitchbend, but the MPK Editor can remap X to a CC. */
export const STICK_X_SOURCES = [
  { id: 'auto', label: 'Pitchbend (auto)' },
  { id: 'bend', label: 'Pitchbend only' },
  { id: 'cc', label: 'CC only' },
];

export const BEND_RANGE_CENTS = 200; // ±2 semitones, the MPK mini classic
export const VIBRATO_MAX_CENTS = 45;

export function defaultStickMap() {
  return {
    xTarget: 'bend',
    yTarget: 'vibrato',
    yCC: 1,
    xCC: 16, // only used when xSource === 'cc'
    xSource: 'auto',
    springX: true,
    springY: true,
  };
}

function validId(list, v, fallback) {
  return list.some((o) => o.id === v) ? v : fallback;
}

export function loadStickMap() {
  try {
    const raw = localStorage.getItem(STICKMAP_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p?.schemaVersion === STICKMAP_SCHEMA) return sanitize(p);
    }
  } catch { /* ignore -> factory */ }
  const fresh = defaultStickMap();
  saveStickMap(fresh);
  return fresh;
}

function sanitize(p) {
  const d = defaultStickMap();
  const num = (v, fb) => (Number.isFinite(Number(v)) ? Math.min(127, Math.max(0, Number(v) | 0)) : fb);
  return {
    xTarget: validId(STICK_X_OPTIONS, p.xTarget, d.xTarget),
    yTarget: validId(STICK_Y_OPTIONS, p.yTarget, d.yTarget),
    yCC: num(p.yCC, d.yCC),
    xCC: num(p.xCC, d.xCC),
    xSource: validId(STICK_X_SOURCES, p.xSource, d.xSource),
    springX: p.springX !== false,
    springY: p.springY !== false,
  };
}

export function saveStickMap(map) {
  try {
    localStorage.setItem(STICKMAP_KEY, JSON.stringify({
      schemaVersion: STICKMAP_SCHEMA,
      savedAt: new Date().toISOString(),
      ...map,
    }));
  } catch { /* ignore */ }
}
