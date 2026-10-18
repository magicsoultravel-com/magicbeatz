/**
 * Shared MIDI note helpers — single source of truth for pitch<->MIDI.
 * Extracted from src/sections/magicBeatz.js (PITCH_ORDER, pitchOctFromMidi,
 * pitchToMidi, midiFromBase) so the dock and the magicbeatz console can't drift.
 */
import { CHROMATIC, pitchToIndex } from '../theory/music.js';

export const PITCH_ORDER = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiFromBase(baseOct, semis) {
  return (baseOct + 1) * 12 + semis;
}

export function pitchOctFromMidi(midi) {
  return {
    pitch: PITCH_ORDER[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
  };
}

export function pitchToMidi(pitch, octave) {
  const idx = PITCH_ORDER.indexOf(pitch);
  if (idx < 0) {
    const fallback = pitchToIndex(pitch);
    if (fallback < 0) return null;
    return (octave + 1) * 12 + fallback;
  }
  return (octave + 1) * 12 + idx;
}

export function isBlackPitch(pitch) {
  return String(pitch).includes('#');
}

/** Computer keyboard → semitone offset from visible C (baseOct). A always = C on screen. */
export const PC_NOTE_OFFSETS = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4,
  KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9,
  KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14,
  KeyP: 15, Semicolon: 16, Quote: 17, BracketRight: 18, Backslash: 19,
};

export function midiRangeForKeys(baseOct) {
  const start = midiFromBase(baseOct, 0);
  return { start, end: start + 24 }; // 25 keys C..C
}
