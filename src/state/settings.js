/**
 * Console defaults — single source for knob CCs, curves, octave limits.
 * Live values stay in src/main.js; these are the factory presets.
 */

/** MPK mini MK3 factory CCs for K1-K8 (learnable at runtime). */
export const DEFAULT_KNOB_CC = [70, 71, 72, 73, 74, 75, 76, 77];

/** K1 starts at 80% (swing), K2 at 0% (BPM offset), rest at 50%+. */
export const DEFAULT_KNOB_VAL = [0.8, 0, 0.5, 0.8, 0.8, 0.8, 0.8, 0.8];

export const CURVE_OPTIONS = ['linear', 'soft', 'hard', 'fixed'];

export const MIN_OCTAVE = 1;
export const MAX_OCTAVE = 5;
export const DEFAULT_OCTAVE = 3;

export const DEFAULT_KEYS_INSTRUMENT = 'piano';
