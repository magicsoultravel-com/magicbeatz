/**
 * Metronome + count-in math (src/sequencer/metronome.js).
 *
 * Pure helpers only — no audio imports — so node tests can import this file
 * directly, the same split src/keys/perform.js uses. The click synth lives in
 * src/audio/metronome.js.
 *
 * One grid step is a 16th note (STEPS_PER_BEAT) and the console's beat count is
 * the top number of the time signature, so 4/4 shows 4 lights, 6/8 shows 6.
 */
import { STEPS_PER_BEAT } from './pattern.js';

export const METRONOME_PREFS_KEY = 'magicbeatz-metronome-v1';

/** The count-in is always exactly one bar of the current signature. */
export const COUNT_IN_BARS = 1;

/** Click audible by default; the transport mute button turns it off. */
export const DEFAULT_METRONOME_PREFS = Object.freeze({ enabled: true });

/** Normalize a stored pref object (anything unusable falls back to audible). */
export function normalizeMetronomePrefs(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_METRONOME_PREFS };
  return { enabled: raw.enabled !== false };
}

/** Seconds per beat — invalid tempo falls back to 120 BPM. */
export function secondsPerBeat(bpm) {
  const tempo = Number(bpm);
  const safe = Number.isFinite(tempo) && tempo > 0 ? tempo : 120;
  return 60 / safe;
}

/** Length of the count-in in seconds (bars x beats x seconds-per-beat). */
export function countInSeconds(bpm, beats, bars = COUNT_IN_BARS) {
  const perBar = Math.max(1, Math.floor(Number(beats) || 4));
  const barCount = Math.max(1, Math.floor(Number(bars) || COUNT_IN_BARS));
  return secondsPerBeat(bpm) * perBar * barCount;
}

/**
 * Beat position of a 16th-note step.
 * Beat 1 of every bar is the accent. Swing only offsets odd 16ths, so beat
 * steps (multiples of STEPS_PER_BEAT) always land on the grid.
 */
export function beatInfoForStep(stepIndex, beats = 4) {
  const perBar = Math.max(1, Math.floor(Number(beats) || 4));
  const step = Math.max(0, Math.floor(Number(stepIndex) || 0));
  const inBeat = step % STEPS_PER_BEAT;
  const beatIndex = Math.floor(step / STEPS_PER_BEAT) % perBar;
  return {
    isBeat: inBeat === 0,
    beatIndex,
    isAccent: inBeat === 0 && beatIndex === 0,
  };
}

/**
 * Click times for a count-in: one entry per beat, accent on each bar's beat 1.
 * `when` values are absolute AudioContext seconds so the caller can schedule
 * the first played step on the last entry's beat.
 */
export function countInClickPlan(startSec, bpm, beats, bars = COUNT_IN_BARS) {
  const perBar = Math.max(1, Math.floor(Number(beats) || 4));
  const barCount = Math.max(1, Math.floor(Number(bars) || COUNT_IN_BARS));
  const spb = secondsPerBeat(bpm);
  const start = Number.isFinite(Number(startSec)) ? Number(startSec) : 0;
  const plan = [];
  for (let i = 0; i < perBar * barCount; i += 1) {
    const beatIndex = i % perBar;
    plan.push({ when: start + i * spb, beatIndex, accent: beatIndex === 0 });
  }
  return plan;
}
