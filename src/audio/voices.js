/**
 * Synth voices for magicBeatz — percussion one-shots + pitched instruments.
 * All route through the master bus.
 */
import { getAudioContext, getMasterBus, peekAudioContext } from './context.js';
import { pitchToIndex } from '../theory/music.js';
import { resolveInstrument } from './instruments.js';
import { ensureSample, isSampleReady, playSample, startSampleSustain, stopSampleSustain } from './sampler.js';

function connectVoice(gainNode) {
  gainNode.connect(getMasterBus());
}

function noiseBuffer(ctx, durationSec = 0.2) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * durationSec));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  return buf;
}

export function velGain(velocity, base) {
  const v = Math.min(1, Math.max(0, velocity ?? 0.8));
  return base * (0.35 + 0.65 * v);
}

export function pitchToFreq(pitch, octave = 4) {
  const idx = pitchToIndex(pitch);
  if (idx < 0) return null;
  const midi = 60 + (octave - 4) * 12 + idx;
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Kick: sine pitch drop. */
export function playKick(when, velocity = 0.8) {
  const ctx = getAudioContext();
  const t = when ?? ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.08);
  const g = velGain(velocity, 0.55);
  gain.gain.setValueAtTime(g, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
  osc.connect(gain);
  connectVoice(gain);
  osc.start(t);
  osc.stop(t + 0.3);
}

/** Snare: noise burst + short tone. */
export function playSnare(when, velocity = 0.8) {
  const ctx = getAudioContext();
  const t = when ?? ctx.currentTime;
  const g = velGain(velocity, 0.35);

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx, 0.25);
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'highpass';
  noiseFilter.frequency.value = 1000;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(g, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  connectVoice(noiseGain);
  noise.start(t);
  noise.stop(t + 0.2);

  const osc = ctx.createOscillator();
  const oscGain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = 180;
  oscGain.gain.setValueAtTime(g * 0.6, t);
  oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  osc.connect(oscGain);
  connectVoice(oscGain);
  osc.start(t);
  osc.stop(t + 0.14);
}

function playHat(when, velocity, open) {
  const ctx = getAudioContext();
  const t = when ?? ctx.currentTime;
  const g = velGain(velocity, open ? 0.22 : 0.18);
  const decay = open ? 0.35 : 0.06;

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx, open ? 0.4 : 0.1);
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 7000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(g, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + decay);
  noise.connect(filter);
  filter.connect(gain);
  connectVoice(gain);
  noise.start(t);
  noise.stop(t + decay + 0.02);
}

export function playClosedHat(when, velocity = 0.8) {
  playHat(when, velocity, false);
}

export function playOpenHat(when, velocity = 0.8) {
  playHat(when, velocity, true);
}

/** Clap: staggered noise bursts. */
export function playClap(when, velocity = 0.8) {
  const ctx = getAudioContext();
  const t = when ?? ctx.currentTime;
  const g = velGain(velocity, 0.28);
  const offsets = [0, 0.012, 0.024];

  for (const off of offsets) {
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx, 0.15);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1500;
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    const start = t + off;
    gain.gain.setValueAtTime(g * (off === 0 ? 0.7 : 1), start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.12);
    noise.connect(filter);
    filter.connect(gain);
    connectVoice(gain);
    noise.start(start);
    noise.stop(start + 0.14);
  }
}

function playTomAt(when, velocity, startHz, endHz) {
  const ctx = getAudioContext();
  const t = when ?? ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(startHz, t);
  osc.frequency.exponentialRampToValueAtTime(endHz, t + 0.12);
  const g = velGain(velocity, 0.4);
  gain.gain.setValueAtTime(g, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  osc.connect(gain);
  connectVoice(gain);
  osc.start(t);
  osc.stop(t + 0.32);
}

export function playTom(when, velocity = 0.8) {
  playTomAt(when, velocity, 120, 70);
}

export function playHiTom(when, velocity = 0.8) {
  playTomAt(when, velocity, 220, 140);
}

export function playMidTom(when, velocity = 0.8) {
  playTomAt(when, velocity, 160, 95);
}

/** Rim click. */
export function playRim(when, velocity = 0.8) {
  const ctx = getAudioContext();
  const t = when ?? ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = 800;
  const g = velGain(velocity, 0.12);
  gain.gain.setValueAtTime(g, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
  osc.connect(gain);
  connectVoice(gain);
  osc.start(t);
  osc.stop(t + 0.05);
}

export function playCowbell(when, velocity = 0.8) {
  const ctx = getAudioContext();
  const t = when ?? ctx.currentTime;
  const g = velGain(velocity, 0.2);
  for (const freq of [560, 845]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(g * 0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.connect(gain);
    connectVoice(gain);
    osc.start(t);
    osc.stop(t + 0.2);
  }
}

export function playShaker(when, velocity = 0.8) {
  const ctx = getAudioContext();
  const t = when ?? ctx.currentTime;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx, 0.12);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 6000;
  filter.Q.value = 1.2;
  const gain = ctx.createGain();
  const g = velGain(velocity, 0.16);
  gain.gain.setValueAtTime(g, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
  noise.connect(filter);
  filter.connect(gain);
  connectVoice(gain);
  noise.start(t);
  noise.stop(t + 0.1);
}

export function playRide(when, velocity = 0.8) {
  const ctx = getAudioContext();
  const t = when ?? ctx.currentTime;
  const g = velGain(velocity, 0.12);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = 520;
  gain.gain.setValueAtTime(g, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
  osc.connect(gain);
  connectVoice(gain);
  osc.start(t);
  osc.stop(t + 0.6);

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx, 0.4);
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 8000;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(g * 0.4, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
  noise.connect(filter);
  filter.connect(ng);
  connectVoice(ng);
  noise.start(t);
  noise.stop(t + 0.42);
}

export function playCrash(when, velocity = 0.8) {
  const ctx = getAudioContext();
  const t = when ?? ctx.currentTime;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx, 0.8);
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 4000;
  const gain = ctx.createGain();
  const g = velGain(velocity, 0.28);
  gain.gain.setValueAtTime(g, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
  noise.connect(filter);
  filter.connect(gain);
  connectVoice(gain);
  noise.start(t);
  noise.stop(t + 0.75);
}

export const PERCUSSION_PLAYERS = {
  kick: playKick,
  snare: playSnare,
  'closed-hat': playClosedHat,
  'open-hat': playOpenHat,
  clap: playClap,
  tom: playTom,
  'hi-tom': playHiTom,
  'mid-tom': playMidTom,
  rim: playRim,
  cowbell: playCowbell,
  shaker: playShaker,
  ride: playRide,
  crash: playCrash,
};

/** —— pitched instruments —— */

function playOscTone({
  when,
  freq,
  velocity,
  type = 'sine',
  baseGain = 0.25,
  attack = 0.01,
  decay = 0.4,
  filterFreq = null,
}) {
  if (!freq) return;
  const ctx = getAudioContext();
  const t = when ?? ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const g = velGain(velocity, baseGain);
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.linearRampToValueAtTime(g, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.001, t + attack + decay);

  if (filterFreq) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    osc.connect(filter);
    filter.connect(gain);
  } else {
    osc.connect(gain);
  }
  connectVoice(gain);
  osc.start(t);
  osc.stop(t + attack + decay + 0.05);
}

export function playGuitarTone(pitch, octave, when, velocity = 0.8) {
  playOscTone({
    when,
    freq: pitchToFreq(pitch, octave),
    velocity,
    type: 'sine',
    baseGain: 0.22,
    attack: 0.01,
    decay: 0.5,
  });
}

export function playBassSub(pitch, octave, when, velocity = 0.8) {
  playOscTone({
    when,
    freq: pitchToFreq(pitch, octave),
    velocity,
    type: 'sine',
    baseGain: 0.45,
    attack: 0.01,
    decay: 0.45,
    filterFreq: 280,
  });
}

export function playBassGrowl(pitch, octave, when, velocity = 0.8) {
  const freq = pitchToFreq(pitch, octave);
  if (!freq) return;
  playOscTone({
    when,
    freq,
    velocity,
    type: 'sawtooth',
    baseGain: 0.22,
    attack: 0.02,
    decay: 0.4,
    filterFreq: 600,
  });
}

export function playBassPluck(pitch, octave, when, velocity = 0.8) {
  playOscTone({
    when,
    freq: pitchToFreq(pitch, octave),
    velocity,
    type: 'triangle',
    baseGain: 0.3,
    attack: 0.005,
    decay: 0.28,
    filterFreq: 900,
  });
}

export function playKeysPluck(pitch, octave, when, velocity = 0.8) {
  playOscTone({
    when,
    freq: pitchToFreq(pitch, octave),
    velocity,
    type: 'triangle',
    baseGain: 0.2,
    attack: 0.008,
    decay: 0.55,
  });
}

export function playKeysPad(pitch, octave, when, velocity = 0.8) {
  const freq = pitchToFreq(pitch, octave);
  if (!freq) return;
  const ctx = getAudioContext();
  const t = when ?? ctx.currentTime;
  const g = velGain(velocity, 0.12);
  for (const detune of [-6, 0, 7]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.detune.value = detune;
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(g, t + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    osc.connect(gain);
    connectVoice(gain);
    osc.start(t);
    osc.stop(t + 0.95);
  }
}

export function playKeysBell(pitch, octave, when, velocity = 0.8) {
  const freq = pitchToFreq(pitch, octave);
  if (!freq) return;
  playOscTone({
    when,
    freq,
    velocity,
    type: 'sine',
    baseGain: 0.18,
    attack: 0.005,
    decay: 0.7,
  });
  playOscTone({
    when,
    freq: freq * 2.01,
    velocity: velocity * 0.5,
    type: 'sine',
    baseGain: 0.08,
    attack: 0.005,
    decay: 0.4,
  });
}

export function playLeadSquare(pitch, octave, when, velocity = 0.8) {
  playOscTone({
    when,
    freq: pitchToFreq(pitch, octave),
    velocity,
    type: 'square',
    baseGain: 0.12,
    attack: 0.01,
    decay: 0.35,
    filterFreq: 2200,
  });
}

export function playLeadSaw(pitch, octave, when, velocity = 0.8) {
  playOscTone({
    when,
    freq: pitchToFreq(pitch, octave),
    velocity,
    type: 'sawtooth',
    baseGain: 0.14,
    attack: 0.015,
    decay: 0.4,
    filterFreq: 1800,
  });
}

/** Acoustic-ish piano: layered harmonics, quick hammer, medium decay. */
export function playPiano(pitch, octave, when, velocity = 0.8) {
  const freq = pitchToFreq(pitch, octave);
  if (!freq) return;
  const ctx = getAudioContext();
  const t = when ?? ctx.currentTime;
  const g = velGain(velocity, 0.22);
  const partials = [
    { mult: 1, type: 'triangle', level: 1, decay: 1.4 },
    { mult: 2, type: 'sine', level: 0.35, decay: 0.7 },
    { mult: 3, type: 'sine', level: 0.12, decay: 0.35 },
  ];
  for (const p of partials) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = p.type;
    osc.frequency.value = freq * p.mult;
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(g * p.level, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, t + p.decay);
    osc.connect(gain);
    connectVoice(gain);
    osc.start(t);
    osc.stop(t + p.decay + 0.05);
  }
}

/** Steel drum / pan — metallic inharmonic partials, short. */
export function playSteelDrum(pitch, octave, when, velocity = 0.8) {
  const freq = pitchToFreq(pitch, octave);
  if (!freq) return;
  const ctx = getAudioContext();
  const t = when ?? ctx.currentTime;
  const g = velGain(velocity, 0.2);
  const partials = [1, 1.5, 2.01, 2.76, 3.5];
  partials.forEach((mult, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = i % 2 ? 'triangle' : 'sine';
    osc.frequency.value = freq * mult;
    const level = g * (0.5 / (i + 1));
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(level, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45 + i * 0.05);
    osc.connect(gain);
    connectVoice(gain);
    osc.start(t);
    osc.stop(t + 0.6);
  });
}

/** Soft string ensemble — slow attack, layered sines. */
export function playStrings(pitch, octave, when, velocity = 0.8) {
  const freq = pitchToFreq(pitch, octave);
  if (!freq) return;
  const ctx = getAudioContext();
  const t = when ?? ctx.currentTime;
  const g = velGain(velocity, 0.1);
  for (const detune of [-8, -3, 0, 4, 9]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    osc.detune.value = detune;
    filter.type = 'lowpass';
    filter.frequency.value = 1400;
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(g, t + 0.18);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
    osc.connect(filter);
    filter.connect(gain);
    connectVoice(gain);
    osc.start(t);
    osc.stop(t + 1.15);
  }
}

/** Solo violin-ish — bright saw + vibrato via LFO detune. */
export function playViolin(pitch, octave, when, velocity = 0.8) {
  const freq = pitchToFreq(pitch, octave);
  if (!freq) return;
  const ctx = getAudioContext();
  const t = when ?? ctx.currentTime;
  const g = velGain(velocity, 0.16);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  osc.type = 'sawtooth';
  osc.frequency.value = freq;
  filter.type = 'bandpass';
  filter.frequency.value = freq * 2.2;
  filter.Q.value = 2.5;
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 5.5;
  lfoGain.gain.value = 8;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.detune);
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.linearRampToValueAtTime(g, t + 0.08);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.85);
  osc.connect(filter);
  filter.connect(gain);
  connectVoice(gain);
  osc.start(t);
  lfo.start(t);
  osc.stop(t + 0.9);
  lfo.stop(t + 0.9);
}

/** Fingered electric bass — short plucky triangle + sub. */
export function playBassFinger(pitch, octave, when, velocity = 0.8) {
  const freq = pitchToFreq(pitch, octave);
  if (!freq) return;
  playOscTone({
    when,
    freq,
    velocity,
    type: 'triangle',
    baseGain: 0.32,
    attack: 0.005,
    decay: 0.35,
    filterFreq: 700,
  });
  playOscTone({
    when,
    freq: freq * 0.5,
    velocity: velocity * 0.7,
    type: 'sine',
    baseGain: 0.22,
    attack: 0.005,
    decay: 0.4,
    filterFreq: 200,
  });
}

export const PITCHED_PLAYERS = {
  guitar: playGuitarTone,
  piano: playPiano,
  'piano-synth': playPiano,
  'steel-drum': playSteelDrum,
  'bass-sub': playBassSub,
  'bass-growl': playBassGrowl,
  'bass-pluck': playBassPluck,
  'bass-finger': playBassFinger,
  'keys-pluck': playKeysPluck,
  'keys-pad': playKeysPad,
  'keys-bell': playKeysBell,
  'lead-square': playLeadSquare,
  'lead-saw': playLeadSaw,
  strings: playStrings,
  violin: playViolin,
};

/** Instruments that sustain while a key is held (keyboard). */
export const SUSTAIN_INSTRUMENTS = new Set([
  'grand',
  'e-piano',
  'nylon',
  'upright',
  'piano',
  'guitar',
  'bass-sub',
  'bass-growl',
  'bass-pluck',
  'bass-finger',
  'keys-pluck',
  'keys-pad',
  'keys-bell',
  'lead-square',
  'lead-saw',
  'strings',
  'violin',
]);

const activeSustains = new Map();

/** Live stick performance state (joystick X/Y fallback when hardware is dead). */
let stickBendCents = 0;
let stickVibrato = 0; // 0..1
const STICK_VIBRATO_MAX_CENTS = 45;
const STICK_VIBRATO_HZ = 5.5;

function applyStickToEntry(entry) {
  if (!entry?.oscs) return;
  const ctx = peekAudioContext();
  const t = ctx ? ctx.currentTime : 0;
  for (const o of entry.oscs) {
    try {
      const base = Number(o.baseDetune) || 0;
      o.osc.detune.setTargetAtTime(base + stickBendCents, t, 0.015);
    } catch { /* ignore */ }
  }
  for (const g of entry.vibGains || []) {
    try {
      g.gain.setTargetAtTime(stickVibrato * STICK_VIBRATO_MAX_CENTS, t, 0.03);
    } catch { /* ignore */ }
  }
}

/** Joystick X: bend held synth sustains ±cents. Samples can't bend — no-op there. */
export function setStickBendCents(cents) {
  const v = Number(cents);
  stickBendCents = Number.isFinite(v) ? Math.min(400, Math.max(-400, v)) : 0;
  for (const entry of activeSustains.values()) applyStickToEntry(entry);
}

/** Joystick Y (mod): vibrato depth on held synth sustains. */
export function setStickVibrato(amount) {
  const v = Number(amount);
  stickVibrato = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  for (const entry of activeSustains.values()) applyStickToEntry(entry);
}

function sustainKey(instrumentId, pitch, octave) {
  return `${instrumentId}|${pitch}|${octave}`;
}

/**
 * Start a gated sustained note (hold until stopPitchedSustain).
 * Returns key string, or null if one-shot was used instead.
 */
export function startPitchedSustain(instrumentId, pitch, octave, velocity = 0.85) {
  const resolved = resolveInstrument(instrumentId || 'grand');
  if (resolved.engine === 'sample') {
    const stopSample = startSampleSustain(resolved.id, pitch, octave, velocity);
    if (stopSample) {
      const key = `sample|${resolved.id}|${pitch}|${octave}|${Date.now().toString(36)}`;
      sampleSustains.set(key, stopSample);
      return key;
    }
    const fallback = resolveInstrument(resolved.fallback || 'piano');
    const id = fallback.id;
    void id;
  }
  const id = resolved.engine === 'sample' ? (resolved.fallback || 'piano') : resolved.id;
  const freq = pitchToFreq(pitch, octave);
  if (!freq) return null;

  if (!SUSTAIN_INSTRUMENTS.has(id)) {
    playPitchedInstrument(id, pitch, octave, undefined, velocity);
    return null;
  }

  const key = sustainKey(id, pitch, octave);
  stopPitchedSustain(key);

  const ctx = getAudioContext();
  const t = ctx.currentTime;
  const g = velGain(velocity, id === 'strings' || id === 'keys-pad' ? 0.12 : 0.2);
  const nodes = [];
  const gains = [];
  const oscs = [];
  const vibGains = [];

  const specs = sustainVoiceSpecs(id, freq);
  for (const spec of specs) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = spec.type;
    osc.frequency.value = spec.freq;
    const baseDetune = (spec.detune || 0) + stickBendCents;
    osc.detune.value = baseDetune;
    oscs.push({ osc, baseDetune: spec.detune || 0 });
    let last = osc;
    if (spec.filterFreq) {
      const filter = ctx.createBiquadFilter();
      filter.type = spec.filterType || 'lowpass';
      filter.frequency.value = spec.filterFreq;
      if (spec.Q) filter.Q.value = spec.Q;
      osc.connect(filter);
      last = filter;
      nodes.push(filter);
    }
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(g * (spec.level ?? 1), t + (spec.attack ?? 0.02));
    last.connect(gain);
    connectVoice(gain);
    osc.start(t);
    nodes.push(osc, gain);
    gains.push(gain);

    if (spec.lfoHz) {
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = spec.lfoHz;
      lfoGain.gain.value = spec.lfoDepth || 6;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.detune);
      lfo.start(t);
      nodes.push(lfo, lfoGain);
    }
    // Always-on stick vibrato LFO (depth driven by stick Y, 0 = silent).
    {
      const vib = ctx.createOscillator();
      const vibGain = ctx.createGain();
      vib.frequency.value = STICK_VIBRATO_HZ;
      vibGain.gain.value = stickVibrato * STICK_VIBRATO_MAX_CENTS;
      vib.connect(vibGain);
      vibGain.connect(osc.detune);
      vib.start(t);
      nodes.push(vib, vibGain);
      vibGains.push(vibGain);
    }
  }

  activeSustains.set(key, { nodes, gains, oscs, vibGains });
  return key;
}

function sustainVoiceSpecs(id, freq) {
  if (id === 'piano') {
    return [
      { type: 'triangle', freq, level: 1, attack: 0.01 },
      { type: 'sine', freq: freq * 2, level: 0.3, attack: 0.01 },
      { type: 'sine', freq: freq * 3, level: 0.1, attack: 0.01 },
    ];
  }
  if (id === 'strings' || id === 'keys-pad') {
    return [-8, -3, 0, 4, 9].map((d) => ({
      type: 'sawtooth', freq, detune: d, level: 0.45, attack: 0.15, filterFreq: 1400,
    }));
  }
  if (id === 'violin') {
    return [{
      type: 'sawtooth', freq, level: 1, attack: 0.08,
      filterFreq: freq * 2.2, filterType: 'bandpass', Q: 2.5, lfoHz: 5.5, lfoDepth: 8,
    }];
  }
  if (id.startsWith('bass')) {
    const type = id === 'bass-growl' ? 'sawtooth' : id === 'bass-pluck' ? 'triangle' : 'sine';
    return [{ type, freq, level: 1, attack: 0.02, filterFreq: id === 'bass-sub' ? 280 : 700 }];
  }
  if (id === 'lead-square') {
    return [{ type: 'square', freq, level: 0.7, attack: 0.02, filterFreq: 2200 }];
  }
  if (id === 'lead-saw') {
    return [{ type: 'sawtooth', freq, level: 0.7, attack: 0.02, filterFreq: 1800 }];
  }
  if (id === 'keys-bell') {
    return [
      { type: 'sine', freq, level: 1, attack: 0.01 },
      { type: 'sine', freq: freq * 2.01, level: 0.4, attack: 0.01 },
    ];
  }
  if (id === 'keys-pluck' || id === 'guitar') {
    return [{ type: id === 'guitar' ? 'sine' : 'triangle', freq, level: 1, attack: 0.01 }];
  }
  return [{ type: 'triangle', freq, level: 1, attack: 0.02 }];
}

const sampleSustains = new Map();

export function stopPitchedSustain(key) {
  if (!key) return;
  if (sampleSustains.has(key)) {
    stopSampleSustain(sampleSustains.get(key));
    sampleSustains.delete(key);
    return;
  }
  const entry = activeSustains.get(key);
  if (!entry) return;
  activeSustains.delete(key);
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  for (const gain of entry.gains) {
    try {
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(Math.max(0.001, gain.gain.value), t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    } catch { /* ignore */ }
  }
  window.setTimeout(() => {
    for (const node of entry.nodes) {
      try {
        if (typeof node.stop === 'function') node.stop();
        if (typeof node.disconnect === 'function') node.disconnect();
      } catch { /* ignore */ }
    }
  }, 100);
}

export function stopAllPitchedSustain() {
  for (const key of [...sampleSustains.keys()]) stopPitchedSustain(key);
  for (const key of [...activeSustains.keys()]) stopPitchedSustain(key);
}

/**
 * Play a pitched note with instrumentId.
 * @param {string} instrumentId
 * @param {string} pitch
 * @param {number} octave
 * @param {number} [when]
 * @param {number} [velocity]
 */
export function playPitchedInstrument(instrumentId, pitch, octave, when, velocity = 0.8) {
  const resolved = resolveInstrument(instrumentId);
  if (resolved.engine === 'sample') {
    if (playSample(resolved.id, pitch, octave, when, velocity)) return;
    const fallback = PITCHED_PLAYERS[resolved.fallback] || PITCHED_PLAYERS.guitar;
    fallback(pitch, octave, when, velocity);
    return;
  }
  const play = PITCHED_PLAYERS[resolved.id] || PITCHED_PLAYERS.guitar;
  play(pitch, octave, when, velocity);
}

/**
 * Strum chord notes with instrument.
 * @param {string} instrumentId
 * @param {Array<{ pitch: string, octave?: number }>} entries
 * @param {number} [when]
 * @param {number} [velocity]
 * @param {number} [gapSec]
 */
export function playPitchedChord(instrumentId, entries, when, velocity = 0.8, gapSec = 0.045) {
  if (!entries?.length) return;
  entries.forEach((entry, i) => {
    const t = when == null ? undefined : when + i * gapSec;
    playPitchedInstrument(instrumentId, entry.pitch, entry.octave ?? 4, t, velocity);
  });
}
