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
 *
 * NOTE: static import keeps Vite builds working. Plain `file://` or static
 * servers without a bundler need an import map — see index.html.
 */
import { SplendidGrandPiano, Soundfont, Smolken, ElectricPiano } from 'smplr';
import { ensureAudio, getMasterBus, peekAudioContext } from './context.js';
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

/** Registry id → smplr factory. Keep lazy: constructed on first gesture. */
const FACTORIES = {
  grand: (ctx, dest) => SplendidGrandPiano(ctx, { destination: dest }),
  // Greg Sullivan Wurlitzer pack has corrupt/undecodable ogg on some builds
  // (ab6mp.ogg EncodingError) — use FluidR3 GM e-piano from the same family
  // as the working nylon path instead.
  'e-piano': (ctx, dest) => Soundfont(ctx, { destination: dest, instrument: 'electric_piano_1', formats: ['m4a', 'ogg'] }),
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
  // No AudioContext before a gesture — mark pending, real load happens on
  // first ensureAudio(). Avoids the Chrome autoplay warning entirely.
  if (!peekAudioContext()) {
    setStatus(id, 'pending-gesture');
    return Promise.resolve(null);
  }
  setStatus(id, 'loading');
  const p = (async () => {
    try {
      const ctx = ensureAudio();
      const inst = factory(ctx, getMasterBus());
      await inst.load;
      instances.set(id, { inst, ready: Promise.resolve(inst) });
      setStatus(id, 'ready');
      return inst;
    } catch (err) {
      // One bad sample (e.g. corrupt ogg) must not hang the instrument in
      // 'loading' — mark error so UI falls back to synth and can retry.
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

/** Preload the default piano — call only from a user gesture. */
export function preloadDefaults() {
  if (!peekAudioContext()) {
    setStatus('grand', 'pending-gesture');
    return;
  }
  ensureSample('grand');
}

/** Kick off pending loads after first gesture (called by ensureAudio paths). */
export function flushPendingLoads() {
  for (const [id, state] of Object.entries(samplerStatus())) {
    if (state === 'pending-gesture') ensureSample(id);
  }
  // Always want grand ready; if never requested, request now (post-gesture).
  if (!instances.has('grand') && !pending.has('grand')) ensureSample('grand');
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
    const ctx = peekAudioContext() || ensureAudio();
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
