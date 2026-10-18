/**
 * Absolute vs relative knob handling + pickup (soft-takeover).
 * MPK Mini MK3 knobs default to absolute 0..127 but can be flipped
 * to relative in the Akai editor. One module owns that decision.
 */

export const KNOB_MODES = ['absolute', 'pickup', 'relative'];

const PICKUP_WINDOW = 0.08;
const recent = new Map(); // knobId -> last few raw values for auto-hint

/** Heuristic: relative knobs only ever send {1,127} or {63,65} / {62..66}. */
export function hintKnobMode(knobId, rawValue) {
  const hist = recent.get(knobId) || [];
  hist.push(rawValue & 0x7f);
  if (hist.length > 8) hist.shift();
  recent.set(knobId, hist);
  if (hist.length < 4) return null;
  const relSets = [
    new Set([1, 127]),
    new Set([63, 65]),
    new Set([62, 63, 64, 65, 66]),
  ];
  if (relSets.some((s) => hist.every((v) => s.has(v)))) return 'relative';
  const spread = Math.max(...hist) - Math.min(...hist);
  if (spread > 20) return 'absolute';
  return null;
}

/**
 * Absolute/pickup: should we apply this incoming norm?
 * Returns { apply:boolean, waiting:boolean } — waiting means
 * "move knob closer to ghost value" for the UI.
 */
export function pickupGate(knobNorm, paramNorm, mode = 'absolute') {
  if (mode !== 'pickup') return { apply: true, waiting: false };
  const dist = Math.abs(knobNorm - paramNorm);
  if (dist <= PICKUP_WINDOW) return { apply: true, waiting: false };
  return { apply: false, waiting: true };
}

/**
 * Relative: convert raw CC value into a signed delta step.
 * Supports the two common MPK encodings:
 *  - two's complement style: 1 = +1, 127 = -1
 *  - offset-binary style: 65 = +1, 63 = -1 (center 64)
 */
export function relativeDelta(rawValue, speed = 2) {
  const v = rawValue & 0x7f;
  let step = 0;
  if (v === 1) step = 1;
  else if (v === 127) step = -1;
  else if (v >= 65 && v <= 66) step = v - 64;
  else if (v >= 62 && v <= 63) step = v - 64;
  else if (v <= 5) step = 1; // some firmwares send small ints as +
  else if (v >= 122) step = -1;
  const normStep = (1 / 127) * speed;
  return step * normStep;
}
