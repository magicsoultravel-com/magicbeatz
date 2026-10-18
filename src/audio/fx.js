/**
 * Master FX chain — persistent post-master nodes for performance FX.
 * Lazy-built on first gesture (same rule as getMasterBus — never creates
 * an AudioContext pre-gesture). All MIDI-driven writes use setTargetAtTime
 * to avoid zipper noise from 7-bit CC steps.
 *
 * Chain:
 *   masterGain -> toneFilter -> dry -> destination
 *                         \-> delay -> delayFb -^  (feedback loop)
 *                         \-> delayWet -> destination
 *                         \-> convolver -> verbWet -> destination
 *
 * Feedback is hard-capped in the setters (never in UI code) so min/max
 * windowing can't blow up the loop.
 */
import { getAudioContext, peekAudioContext, getMasterBus, registerFxPeek } from './context.js';

export const FILTER_MIN_HZ = 80;
export const FILTER_MAX_HZ = 18000;
const MAX_FEEDBACK = 0.6;
const SMOOTH_TC = 0.03;

// Module-level last-set values — params stay readable pre-gesture.
let filterHz = FILTER_MAX_HZ;
let delayMix = 0;
let reverbMix = 0;
let delayTimeSec = 0.32;

let chain = null;

function makeImpulse(ctx, seconds = 1.5) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(1, len, rate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  }
  return buf;
}

function smooth(param, value) {
  try {
    const ctx = peekAudioContext();
    if (!ctx || !param) return false;
    param.setTargetAtTime(value, ctx.currentTime, SMOOTH_TC);
    return true;
  } catch { return false; }
}

/** Build (or return) the chain. Creates context — call from gesture/MIDI path only. */
export function getFxChain() {
  if (chain && chain.ctx === peekAudioContext()) return chain;
  const ctx = getAudioContext();
  const master = getMasterBus();

  const toneFilter = ctx.createBiquadFilter();
  toneFilter.type = 'lowpass';
  toneFilter.frequency.value = filterHz;
  toneFilter.Q.value = 0.7;

  const dry = ctx.createGain();
  dry.gain.value = 1;

  const delay = ctx.createDelay(2.0);
  delay.delayTime.value = delayTimeSec;
  const delayFb = ctx.createGain();
  delayFb.gain.value = 0.3;
  const delayWet = ctx.createGain();
  delayWet.gain.value = 0;

  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(ctx);
  const verbWet = ctx.createGain();
  verbWet.gain.value = 0;

  // Rewire: master was -> destination; now master -> filter -> dry -> destination.
  try { master.disconnect(); } catch { /* first build */ }
  master.connect(toneFilter);
  toneFilter.connect(dry);
  dry.connect(ctx.destination);

  toneFilter.connect(delay);
  delay.connect(delayFb);
  delayFb.connect(delay);
  delay.connect(delayWet);
  delayWet.connect(ctx.destination);

  toneFilter.connect(convolver);
  convolver.connect(verbWet);
  verbWet.connect(ctx.destination);

  // Re-apply stored values post-build (e.g. knob moved pre-gesture).
  toneFilter.frequency.value = filterHz;
  delayWet.gain.value = delayMix * 0.5;
  verbWet.gain.value = reverbMix * 0.6;
  delay.delayTime.value = delayTimeSec;

  chain = {
    ctx, toneFilter, dry, delay, delayFb, delayWet, convolver, verbWet,
  };
  return chain;
}

/** Read-only peek — null until first gesture (chain not built). */
export function peekFxChain() {
  return chain && chain.ctx === peekAudioContext() ? chain : null;
}

// Let context.js route master -> filter after context resets.
registerFxPeek((ctx) => (chain && chain.ctx === ctx ? chain : null));

// ---- filter ----
export function setFilterHz(hz) {
  filterHz = Math.min(FILTER_MAX_HZ, Math.max(FILTER_MIN_HZ, Number(hz) || FILTER_MAX_HZ));
  const c = peekFxChain() || (peekAudioContext() ? getFxChain() : null);
  if (c) smooth(c.toneFilter.frequency, filterHz);
}
export function peekFilterHz() { return filterHz; }

// ---- delay ----
export function setDelayMix(mix) {
  delayMix = Math.min(1, Math.max(0, Number(mix) || 0));
  const fb = Math.min(MAX_FEEDBACK, 0.25 + delayMix * 0.3);
  const c = peekFxChain() || (peekAudioContext() ? getFxChain() : null);
  if (c) {
    smooth(c.delayWet.gain, delayMix * 0.5);
    smooth(c.delayFb.gain, fb);
  }
}
export function peekDelayMix() { return delayMix; }

/** Optional tempo-sync: dotted-eighth at current BPM. Call on transport change. */
export function syncDelayToBpm(bpm) {
  const b = Math.min(250, Math.max(30, Number(bpm) || 120));
  delayTimeSec = (60 / b) * 0.75;
  const c = peekFxChain();
  if (c) smooth(c.delay.delayTime, delayTimeSec);
}

// ---- reverb ----
export function setReverbMix(mix) {
  reverbMix = Math.min(1, Math.max(0, Number(mix) || 0));
  const c = peekFxChain() || (peekAudioContext() ? getFxChain() : null);
  if (c) smooth(c.verbWet.gain, reverbMix * 0.6);
}
export function peekReverbMix() { return reverbMix; }
