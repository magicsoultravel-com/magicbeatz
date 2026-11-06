/**
 * Metronome click (src/audio/metronome.js).
 *
 * A short, dry osc blip routed through the master bus so master gain / FX
 * routing apply exactly like every other voice. Timing math lives in
 * src/sequencer/metronome.js — this file is browser-only.
 */
import { getAudioContext, getMasterBus } from './context.js';

const NORMAL_HZ = 880;
const ACCENT_HZ = 1760;

/** Schedule one click at an absolute AudioContext time (defaults to now).
 *  Returns `{ gain, until }` so the caller can silence a click that is already
 *  scheduled but not yet heard (muting mid count-in). */
export function playMetronomeClick(when, { accent = false, gain = 1 } = {}) {
  const ctx = getAudioContext();
  const t = Number.isFinite(when) ? Math.max(ctx.currentTime, when) : ctx.currentTime;
  const scale = Number.isFinite(gain) ? gain : 1;
  const level = Math.max(0.0001, (accent ? 0.3 : 0.18) * scale);

  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = accent ? 'square' : 'triangle';
  osc.frequency.setValueAtTime(accent ? ACCENT_HZ : NORMAL_HZ, t);
  // ~3 ms attack + short decay: a tick, never a pop.
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(level, t + 0.003);
  env.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
  osc.connect(env);
  env.connect(getMasterBus());
  osc.start(t);
  osc.stop(t + 0.06);
  return { gain: env, until: t + 0.06 };
}
