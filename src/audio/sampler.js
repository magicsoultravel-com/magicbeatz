/**
 * smplr sample bridge — lazy sampled instruments + drum machines.
 *
 * - Catalog sounds resolve to smplr factories at first use.
 * - Drum kits are cached as `drum:<kitId>` instances.
 * - Instances connect to our master bus (destination: getMasterBus()).
 * - Samples never fall back to a fake synth: while loading they are silent,
 *   and the UI shows queued/loading/error state.
 * - Status listeners drive the console pill, sound browser rows and buttons.
 *
 * Importing 'smplr' is static so Vite bundles it; samples themselves stream
 * from the CDN on first use and are cached by smplr's storage.
 */
import {
  SplendidGrandPiano,
  Soundfont,
  Smolken,
  ElectricPiano,
  Mellotron,
  DrumMachine,
} from 'smplr';
import { ensureAudio, getMasterBus, peekAudioContext } from './context.js';
import { pitchToMidi } from '../midi/notes.js';
import {
  resolveSound,
  resolveKitOr,
  kitSampleForVoice,
  DEFAULT_INSTRUMENT_ID,
} from './catalog.js';

const statusListeners = new Set();
let status = {};
const progress = {};
const lastProgressNotify = {};

function setStatus(id, state) {
  if (status[id] === state) return;
  status = { ...status, [id]: state };
  for (const fn of statusListeners) {
    try { fn(id, state, status); } catch { /* ignore */ }
  }
}

function setProgress(id, loaded, total) {
  progress[id] = { loaded: loaded || 0, total: total || 0 };
  const now = Date.now();
  if (now - (lastProgressNotify[id] || 0) < 120) return;
  lastProgressNotify[id] = now;
  for (const fn of statusListeners) {
    try { fn(id, 'loading', status); } catch { /* ignore */ }
  }
}

export function onSamplerStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

export function samplerStatus() { return status; }

/** Rich status for the browser/buttons: { state, loaded, total }. */
export function sampleStatus(id) {
  return {
    state: status[id] || 'idle',
    loaded: progress[id]?.loaded || 0,
    total: progress[id]?.total || 0,
  };
}

const instances = new Map(); // id → { inst, ready: Promise }
const pending = new Map(); // id → Promise (dedupe concurrent loads)

function canonicalId(id) {
  if (!id) return '';
  if (String(id).startsWith('drum:')) return String(id);
  return resolveSound(id)?.id || '';
}

/** Cache id for a drum kit. */
export function drumSampleId(kitId) {
  return `drum:${resolveKitOr(kitId)?.id || 'studio'}`;
}

function makeFactory(id) {
  if (id.startsWith('drum:')) {
    const kit = resolveKitOr(id.slice(5));
    if (!kit) return null;
    return (ctx, dest, onProgress) => DrumMachine(ctx, {
      destination: dest,
      instrument: kit.machine,
      onLoadProgress: onProgress,
    });
  }
  const sound = resolveSound(id);
  if (!sound || sound.engine !== 'sample' || !sound.source) return null;
  const src = sound.source;
  if (src.type === 'splendid') {
    return (ctx, dest, onProgress) => SplendidGrandPiano(ctx, {
      destination: dest,
      onLoadProgress: onProgress,
    });
  }
  if (src.type === 'soundfont') {
    return (ctx, dest, onProgress) => Soundfont(ctx, {
      destination: dest,
      kit: 'MusyngKite',
      instrument: src.instrument,
      formats: ['m4a', 'ogg'],
      onLoadProgress: onProgress,
    });
  }
  if (src.type === 'electricPiano') {
    return (ctx, dest, onProgress) => ElectricPiano(ctx, {
      destination: dest,
      instrument: src.instrument,
      onLoadProgress: onProgress,
    });
  }
  if (src.type === 'smolken') {
    return (ctx, dest, onProgress) => Smolken(ctx, {
      destination: dest,
      instrument: src.instrument,
      onLoadProgress: onProgress,
    });
  }
  if (src.type === 'mellotron') {
    return (ctx, dest, onProgress) => Mellotron(ctx, {
      destination: dest,
      instrument: src.instrument,
      onLoadProgress: onProgress,
    });
  }
  return null;
}

/** Load (or return cached) smplr instance for a catalog sound / kit id. */
export function ensureSample(rawId) {
  const id = canonicalId(rawId);
  if (!id) return Promise.resolve(null);
  if (instances.has(id)) return instances.get(id).ready;
  if (pending.has(id)) return pending.get(id);
  const factory = makeFactory(id);
  if (!factory) return Promise.resolve(null);
  // No AudioContext before a gesture — mark pending; real load happens on
  // first ensureAudio(). Avoids the Chrome autoplay warning entirely.
  if (!peekAudioContext()) {
    setStatus(id, 'pending-gesture');
    return Promise.resolve(null);
  }
  setStatus(id, 'loading');
  setProgress(id, 0, 0);
  const p = (async () => {
    try {
      const ctx = ensureAudio();
      const inst = factory(ctx, getMasterBus(), (p) => setProgress(id, p?.loaded, p?.total));
      await inst.load;
      instances.set(id, { inst, ready: Promise.resolve(inst) });
      setStatus(id, 'ready');
      return inst;
    } catch (err) {
      console.warn(`[sampler] ${id} failed:`, err?.message || err);
      setStatus(id, 'error');
      return null;
    } finally {
      pending.delete(id);
    }
  })();
  pending.set(id, p);
  return p;
}

export function ensureDrumKit(kitId) {
  return ensureSample(drumSampleId(kitId));
}

export function isSampleReady(rawId) {
  return instances.has(canonicalId(rawId));
}

/** Preload the selected default instrument — call only from a user gesture. */
export function preloadDefaults(id = DEFAULT_INSTRUMENT_ID) {
  const sound = resolveSound(id);
  const soundId = sound?.kind === 'pitched' ? sound.id : DEFAULT_INSTRUMENT_ID;
  if (!peekAudioContext()) {
    setStatus(soundId, 'pending-gesture');
    return;
  }
  ensureSample(soundId);
}

/** Kick off pending loads after first gesture (called by gesture paths). */
export function flushPendingLoads() {
  for (const [id, state] of Object.entries(samplerStatus())) {
    if (state === 'pending-gesture') ensureSample(id);
  }
}


function midiFor(pitch, octave) {
  const midi = pitchToMidi(pitch, octave);
  return typeof midi === 'number' ? midi : null;
}

function scheduleTime(when) {
  const ctx = peekAudioContext() || ensureAudio();
  if (when == null) return { ctx, time: undefined };
  const delay = Math.max(0, when - ctx.currentTime);
  return { ctx, time: delay > 0.001 ? ctx.currentTime + delay : undefined };
}

/**
 * Play a sampled pitched note.
 * Returns true only when the sample instance is ready; callers stay silent
 * (and the UI shows loading) rather than substituting a synth.
 */
export function playSample(id, pitch, octave, when, velocity = 0.8) {
  const entry = instances.get(canonicalId(id));
  if (!entry) {
    ensureSample(id);
    return false;
  }
  const midi = midiFor(pitch, octave);
  if (midi == null) return false;
  try {
    const { time } = scheduleTime(when);
    entry.inst.start({ note: midi, velocity: Math.round(velocity * 127), time });
    return true;
  } catch (err) {
    console.warn(`[sampler] play ${id} failed:`, err?.message || err);
    return false;
  }
}

/** Play a logical drum voice from a sampled kit. */
export function playDrumSample(kitId, voiceId, when, velocity = 0.8) {
  const id = drumSampleId(kitId);
  const entry = instances.get(id);
  if (!entry) {
    ensureSample(id);
    return false;
  }
  const sample = kitSampleForVoice(kitId, voiceId);
  if (!sample) return false;
  try {
    const { time } = scheduleTime(when);
    entry.inst.start({
      note: sample,
      velocity: Math.round(velocity * 127),
      time,
      stopId: `voice:${voiceId}`,
    });
    return true;
  } catch (err) {
    console.warn(`[sampler] drum ${kitId}/${voiceId} failed:`, err?.message || err);
    return false;
  }
}

/** Start a sampled sustain (keyboard hold). Returns stop fn or null. */
export function startSampleSustain(id, pitch, octave, velocity = 0.85, when) {
  const entry = instances.get(canonicalId(id));
  if (!entry) {
    ensureSample(id);
    return null;
  }
  const midi = midiFor(pitch, octave);
  if (midi == null) return null;
  try {
    const { time } = scheduleTime(when);
    const stop = entry.inst.start({ note: midi, velocity: Math.round(velocity * 127), time });
    return typeof stop === 'function' ? stop : null;
  } catch {
    return null;
  }
}

let stepVoiceSeq = 0;

/**
 * smplr note event for one gated performance step.
 * `duration` makes smplr stop the voice on the audio clock; `ampRelease` keeps
 * the fade short so the note clears before the next retrigger (presets default
 * to 300 ms, which smeared repeats into one long tone). `stopId` is unique per
 * step because smplr's stop fn stops *every* voice sharing an id — including a
 * later step already scheduled inside the lookahead window.
 */
function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function buildSampleStepEvent({ midi, velocity = 0.85, time, gateSec = 0.12, releaseSec = 0.03, seq = 1 }) {
  return {
    note: midi,
    velocity: Math.round(clampNum(velocity, 0, 1, 0.85) * 127),
    time,
    duration: clampNum(gateSec, 0.02, 8, 0.12),
    ampRelease: clampNum(releaseSec, 0.005, 0.2, 0.03),
    stopId: `step:${seq}`,
  };
}

/**
 * Gated sampled performance step (note repeat / arpeggiator).
 * @returns {boolean} true when the sample was ready and the step scheduled
 */
export function playSampleStep(id, pitch, octave, when, velocity = 0.85, gateSec = 0.12, releaseSec = 0.03) {
  const entry = instances.get(canonicalId(id));
  if (!entry) {
    ensureSample(id);
    return false;
  }
  const midi = midiFor(pitch, octave);
  if (midi == null) return false;
  try {
    const { time } = scheduleTime(when);
    stepVoiceSeq += 1;
    entry.inst.start(buildSampleStepEvent({
      midi, velocity, time, gateSec, releaseSec, seq: stepVoiceSeq,
    }));
    return true;
  } catch {
    return false;
  }
}

/** smplr start() returns a stop fn; one-shots ring out naturally. */
export function stopSampleSustain(stopFn) {
  try {
    if (typeof stopFn === 'function') stopFn();
  } catch { /* ignore */ }
}

/** Debug helper for the browser/status UI. */
export function loadedSampleIds() {
  return [...instances.keys()];
}
