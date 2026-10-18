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

/** Master bus — all voices connect here before destination.
 *  When the FX chain is built, getFxChain() re-routes master -> filter -> dry.
 *  Voices always connect to THIS node, so the rewire is transparent to them. */
export function getMasterBus() {
  const ctx = getAudioContext();
  if (!masterGain || masterGain.context !== ctx) {
    masterGain = ctx.createGain();
    masterGain.gain.value = 1;
    // If the FX chain already exists for this context it owns the routing;
    // otherwise direct to destination until the chain is built.
    try {
      const fx = peekFxForContext(ctx);
      if (fx) masterGain.connect(fx.toneFilter);
      else masterGain.connect(ctx.destination);
    } catch { masterGain.connect(ctx.destination); }
  }
  return masterGain;
}

/** Read-only peek — returns current gain without creating a context (null pre-gesture). */
export function peekMasterGain() {
  try {
    if (!masterGain) return null;
    return Math.min(1, Math.max(0, masterGain.gain.value));
  } catch { return null; }
}

/**
 * Cross-module hook so getMasterBus() can reconnect through the FX chain
 * after a context reset, without context.js importing fx.js (cycle).
 * fx.js registers its peek here on load.
 */
let fxPeek = null;
export function registerFxPeek(fn) { fxPeek = fn; }
function peekFxForContext(ctx) {
  try { return typeof fxPeek === 'function' ? fxPeek(ctx) : null; }
  catch { return null; }
}
