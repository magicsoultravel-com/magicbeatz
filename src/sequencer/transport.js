import { getAudioContext } from '../audio/context.js';
import { STEPS_PER_BEAT } from './pattern.js';

const LOOKAHEAD_SEC = 0.1;
const SCHEDULE_AHEAD_SEC = 0.25;

/**
 * 16th-note step transport with swing.
 * Prefer getTotalSteps for Song mode; otherwise bars × beats × 16ths.
 *
 * @param {{
 *   getBpm: () => number,
 *   getBeatsPerMeasure: () => number,
 *   getBars?: () => number,
 *   getTotalSteps?: () => number,
 *   getSwing: () => number,
 *   onStep: (stepIndex: number, totalSteps: number, when: number) => void,
 * }} opts
 */
export function createStepTransport({
  getBpm,
  getBeatsPerMeasure,
  getBars,
  getTotalSteps,
  getSwing,
  onStep,
}) {
  let timerId = null;
  let nextNoteTime = 0;
  let currentStep = -1;
  let running = false;

  function secondsPerStep() {
    const bpm = getBpm();
    if (!bpm || bpm <= 0) return 0;
    return 60 / bpm / STEPS_PER_BEAT;
  }

  function totalStepCount() {
    if (typeof getTotalSteps === 'function') {
      const n = getTotalSteps();
      if (n > 0) return n;
    }
    const beats = Math.max(1, getBeatsPerMeasure?.() || 4);
    const bars = Math.max(1, getBars?.() || 1);
    return bars * beats * STEPS_PER_BEAT;
  }

  function swingOffset(stepIndex, sps) {
    const swing = Math.min(1, Math.max(0, getSwing?.() ?? 0));
    if (!swing) return 0;
    const withinBeat = stepIndex % STEPS_PER_BEAT;
    if (withinBeat % 2 === 1) {
      return sps * swing * 0.5;
    }
    return 0;
  }

  function schedule() {
    if (!running) return;
    const ctx = getAudioContext();
    const sps = secondsPerStep();
    if (!sps) {
      stop();
      return;
    }

    const total = Math.max(1, totalStepCount());
    while (nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD_SEC) {
      currentStep = (currentStep + 1) % total;
      const when = nextNoteTime + swingOffset(currentStep, sps);
      try {
        onStep(currentStep, total, when);
      } catch (err) {
        console.error(err);
      }
      nextNoteTime += sps;
    }
  }

  function tick() {
    schedule();
    if (running) {
      timerId = window.setTimeout(tick, LOOKAHEAD_SEC * 1000);
    }
  }

  function stop() {
    running = false;
    if (timerId != null) {
      clearTimeout(timerId);
      timerId = null;
    }
    currentStep = -1;
  }

  return {
    isRunning() {
      return running;
    },

    start() {
      stop();
      const sps = secondsPerStep();
      if (!sps) return false;
      const ctx = getAudioContext();
      running = true;
      currentStep = -1;
      nextNoteTime = ctx.currentTime + 0.05;
      tick();
      return true;
    },

    stop,
  };
}
