/**
 * Standalone audio context + master bus for magicbeatz.
 * (Slimmed from guitarsuite src/audio.js — no guitar helpers.)
 *
 * Autoplay rule: the context must be created/resumed inside a user gesture
 * (Chrome logs "The AudioContext was not allowed to start" otherwise).
 * `getAudioContext()` is gesture-safe (creates + resumes). `peekAudioContext()`
 * never creates — for scheduler math / non-gesture paths. `ensureAudio()`
 * wires a one-time unlock on first pointerdown/keydown as a backstop.
 */

let audioCtx = null;
let masterGain = null;
let unlockArmed = false;

function armUnlock() {
  if (unlockArmed || typeof window === 'undefined') return;
  unlockArmed = true;
  const unlock = () => {
    try {
      if (audioCtx && audioCtx.state === 'suspended') void audioCtx.resume();
    } catch { /* ignore */ }
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
}

/** Create/resume the shared context. Call only from a user gesture. */
export function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    armUnlock();
  }
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume();
  }
  return audioCtx;
}

/** Read-only access without creating (null until first gesture). */
export function peekAudioContext() {
  return audioCtx;
}

/** Idempotent gesture entry: create + resume, safe to call from any handler. */
export function ensureAudio() {
  return getAudioContext();
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
