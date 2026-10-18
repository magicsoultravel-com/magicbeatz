/**
 * Standalone audio context + master bus for magicbeatz.
 * (Slimmed from guitarsuite src/audio.js — no guitar helpers.)
 */

let audioCtx = null;
let masterGain = null;

/** Shared AudioContext; resumes on first use (call from a user gesture). */
export function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

/** Master bus — all voices connect here before destination. */
export function getMasterBus() {
  const ctx = getAudioContext();
  if (!masterGain || masterGain.context !== ctx) {
    masterGain = ctx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(ctx.destination);
  }
  return masterGain;
}
