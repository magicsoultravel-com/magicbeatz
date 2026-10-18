/**
 * smplr sample bridge — lazy sampled instruments with synth fallback.
 *
 * - Each 'sample' registry entry maps to a smplr factory call.
 * - Instances connect to our master bus (destination: getMasterBus()).
 * - Until loaded (or offline), play falls back to the registry `fallback`
 *   synth voice — never silent, never blocking.
 * - Status listeners drive the UI pill + per-instrument spinner:
 *   'loading' | 'ready' | 'offline' | 'error:<id>'.
 *
 * Importing 'smplr' is static so Vite bundles it; samples themselves stream
 * from CDN on first use and are cached by smplr's storage.
 */
import { SplendidGrandPiano, Soundfont, Smolken, ElectricPiano } from 'smplr';
import { getAudioContext, getMasterBus } from './context.js';
import { pitchToMidi } from '../midi/notes.js';

const statusListeners = new Set();
let status = {};
function setStatus(id, state) {
  status = { ...status, [id]: state };
  for (const fn of statusListeners) {
    try { fn(id, state, status); } catch { /* ignore */ }
  }
}
export function onSamplerStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}
export function samplerStatus() { return status; }

/** Registry id → smplr factory. Keep lazy: constructed on first request. */
const FACTORIES = {
  grand: (ctx, dest) => SplendidGrandPiano(ctx, { destination: dest }),
  'e-piano': (ctx, dest) => ElectricPiano(ctx, { destination: dest, instrument: 'WurlitzerEP200' }),
  nylon: (ctx, dest) => Soundfont(ctx, { destination: dest, instrument: 'acoustic_guitar_nylon' }),
  upright: (ctx, dest) => Smolken(ctx, { destination: dest, instrument: 'Pizzicato' }),
};

const instances = new Map(); // id → { inst, ready: Promise }
const pending = new Map(); // id → Promise (dedupe concurrent loads)

function midiFor(pitch, octave) {
  const midi = pitchToMidi(pitch, octave);
  return typeof midi === 'number' ? midi : null;
}

/** Load (or return cached) smplr instance for a sample instrument. */
export function ensureSample(id) {
  if (instances.has(id)) return instances.get(id).ready;
  if (pending.has(id)) return pending.get(id);
  const factory = FACTORIES[id];
  if (!factory) return Promise.resolve(null);
  setStatus(id, 'loading');
  const p = (async () => {
    try {
      const ctx = getAudioContext();
      const inst = factory(ctx, getMasterBus());
      await inst.load;
      instances.set(id, { inst, ready: Promise.resolve(inst) });
      setStatus(id, 'ready');
      return inst;
    } catch (err) {
      console.warn(`[sampler] ${id} failed, synth fallback:`, err?.message || err);
      setStatus(id, 'error');
      return null;
    } finally {
      pending.delete(id);
    }
  })();
  pending.set(id, p);
  return p;
}

export function isSampleReady(id) {
  return instances.has(id);
}

/** Preload the default piano at boot (fire-and-forget, non-blocking). */
export function preloadDefaults() {
  ensureSample('grand');
}

/**
 * Play a sampled note. Returns true if handled (instance ready),
 * false → caller should use the synth fallback voice.
 */
export function playSample(id, pitch, octave, when, velocity = 0.8) {
  const entry = instances.get(id);
  if (!entry) {
    ensureSample(id); // kick off load for next time
    return false;
  }
  const midi = midiFor(pitch, octave);
  if (midi == null) return false;
  try {
    const ctx = getAudioContext();
    const delay = when == null ? 0 : Math.max(0, when - ctx.currentTime);
    const time = delay > 0.001 ? ctx.currentTime + delay : undefined;
    entry.inst.start({ note: midi, velocity: Math.round(velocity * 127), time });
    return true;
  } catch (err) {
    console.warn(`[sampler] play ${id} failed:`, err?.message || err);
    return false;
  }
}

/**
 * Start a sampled sustain (keyboard hold). Returns stop fn or null.
 */
export function startSampleSustain(id, pitch, octave, velocity = 0.85) {
  const entry = instances.get(id);
  if (!entry) {
    ensureSample(id);
    return null;
  }
  const midi = midiFor(pitch, octave);
  if (midi == null) return null;
  try {
    const stop = entry.inst.start({ note: midi, velocity: Math.round(velocity * 127) });
    return typeof stop === 'function' ? stop : null;
  } catch {
    return null;
  }
}

/** Duration helper: smplr start() returns a stop fn; one-shots ring out. */
export function stopSampleSustain(stopFn) {
  try {
    if (typeof stopFn === 'function') stopFn();
  } catch { /* ignore */ }
}
