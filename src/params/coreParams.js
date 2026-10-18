/**
 * Register the built-in params against live app state.
 * Called once from console.js with accessor hooks — the registry
 * never imports console state directly (avoids cycles).
 */
import { registerParam, clearDynamicParams, getParam } from './registry.js';
import { clampBpm, clamp01 } from '../sequencer/pattern.js';
import { formatPct, formatBpm, formatDb, formatHz } from './scale.js';
import {
  FILTER_MIN_HZ, FILTER_MAX_HZ,
  setFilterHz, peekFilterHz,
  setDelayMix, peekDelayMix,
  setReverbMix, peekReverbMix,
  syncDelayToBpm,
} from '../audio/fx.js';

export function registerCoreParams(deps) {
  const {
    getProject, syncTransportUI, persist, getMasterGain, peekMasterGain,
  } = deps;

  registerParam({
    id: 'swing', label: 'Swing', short: 'Swing', group: 'transport',
    min: 0, max: 1, unit: '%',
    get: () => clamp01(getProject().swing ?? 0),
    set: (v) => {
      getProject().swing = clamp01(v);
      syncTransportUI(); persist();
    },
    format: formatPct,
    fromNorm: (n) => clamp01(n),
    toNorm: (v) => clamp01(v),
  });

  registerParam({
    id: 'bpm', label: 'Tempo (BPM)', short: 'BPM', group: 'transport',
    min: 30, max: 250, unit: 'bpm',
    get: () => clampBpm(getProject().bpm ?? 120),
    set: (v) => {
      getProject().bpm = clampBpm(Math.round(v));
      syncTransportUI(); persist();
    },
    format: formatBpm,
    // Slight exponential feel would bunch low-end; keep linear over the
    // binding window so Min/Max (e.g. 120..140) behave predictably.
    fromNorm: (n) => 30 + clamp01(n) * 220,
    toNorm: (v) => (clampBpm(v) - 30) / 220,
  });

  registerParam({
    id: 'master', label: 'Master Volume', short: 'Master', group: 'mix',
    min: 0, max: 1, unit: 'dB', curveHint: 'exp',
    get: () => peekMasterGain?.() ?? 1,
    set: (v) => { try { getMasterGain().gain.value = clamp01(v); } catch { /* pre-gesture */ } },
    format: formatDb,
    fromNorm: (n) => clamp01(n) ** 1.5, // perceptual loudness
    toNorm: (v) => clamp01(v) ** (1 / 1.5),
  });

  // Master-chain performance FX — same ids as the old disabled stubs,
  // so any stored bindings light up automatically once nodes exist.
  registerParam({
    id: 'filter', label: 'Filter Cutoff', short: 'Filter', group: 'synth',
    min: FILTER_MIN_HZ, max: FILTER_MAX_HZ, unit: 'Hz', curveHint: 'exp',
    get: () => peekFilterHz(),
    set: (v) => { setFilterHz(v); },
    format: formatHz,
    // LOG sweep — linear would bunch all audible action at the top.
    fromNorm: (n) => FILTER_MIN_HZ * ((FILTER_MAX_HZ / FILTER_MIN_HZ) ** clamp01(n)),
    toNorm: (v) => Math.log(Math.max(FILTER_MIN_HZ, v) / FILTER_MIN_HZ)
      / Math.log(FILTER_MAX_HZ / FILTER_MIN_HZ),
  });

  registerParam({
    id: 'delayMix', label: 'Delay Mix', short: 'Delay', group: 'synth',
    min: 0, max: 1, unit: '%',
    get: () => peekDelayMix(),
    set: (v) => { setDelayMix(v); },
    format: formatPct,
    fromNorm: (n) => clamp01(n),
    toNorm: (v) => clamp01(v),
  });

  registerParam({
    id: 'reverbMix', label: 'Reverb Mix', short: 'Verb', group: 'synth',
    min: 0, max: 1, unit: '%',
    get: () => peekReverbMix(),
    set: (v) => { setReverbMix(v); },
    format: formatPct,
    fromNorm: (n) => clamp01(n),
    toNorm: (v) => clamp01(v),
  });
}

export { syncDelayToBpm };

/** Rebuild per-channel gain params for the active pattern. */
export function registerChannelGains(activePattern, { persist, renderGrid } = {}) {
  clearDynamicParams('ch:');
  if (!activePattern) return;
  activePattern.channels.forEach((ch, idx) => {
    const name = ch.name || ch.voiceId || ch.type || `ch${idx + 1}`;
    registerParam({
      id: `ch:${idx}:gain`,
      channelId: ch.id, // stable id — survives reorder
      label: `${name} gain`,
      short: name.length > 10 ? name.slice(0, 10) : name,
      group: 'mix', min: 0, max: 1, unit: '%',
      get: () => clamp01(ch.gain ?? 0.8),
      set: (v) => {
        ch.gain = clamp01(v);
        persist?.(); renderGrid?.();
      },
      format: formatPct,
      fromNorm: (n) => clamp01(n),
      toNorm: (v) => clamp01(v),
    });
  });
}

/** Resolve a binding paramId against the live registry.
 *  Returns { desc, stale }. `ch:<idx>:gain` ids are positional per
 *  active pattern; a pattern switch changes what they point at, so we
 *  flag stale when the channelId under that index changed. */
export function resolveBinding(binding, activePattern) {
  if (!binding?.paramId) return { desc: null, stale: false };
  const desc = getParam(binding.paramId);
  if (!desc) return { desc: null, stale: true };
  const m = /^ch:(\d+):gain$/.exec(binding.paramId);
  if (m && activePattern) {
    const idx = Number(m[1]);
    const ch = activePattern.channels?.[idx];
    if (!ch) return { desc, stale: true };
    if (desc.channelId && ch.id && desc.channelId !== ch.id) {
      return { desc, stale: true }; // pattern changed under us
    }
  }
  return { desc, stale: !!desc.disabled };
}
