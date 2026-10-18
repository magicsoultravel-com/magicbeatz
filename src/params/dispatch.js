/**
 * MIDI CC -> knob -> param dispatcher.
 * console.js stays thin: normalize, learn-swallow, delegate here.
 */
import { bindingFor, knobsForCC } from './bindings.js';
import { getParam } from './registry.js';
import { normToParam, paramToNorm } from './scale.js';
import { pickupGate, relativeDelta, hintKnobMode } from './knobModes.js';
import { resolveBinding } from './coreParams.js';

export function dispatchCC({ cc, value, map, getPattern, onKnobUI }) {
  const norm = Math.min(1, Math.max(0, (value & 0x7f) / 127));
  const hits = knobsForCC(map, cc);
  const results = [];
  for (const knob of hits) {
    const binding = bindingFor(map, knob.id);
    if (!binding?.paramId) {
      onKnobUI?.(knob.id, { norm, stale: false, unmapped: true });
      results.push({ knobId: knob.id, applied: false, reason: 'unmapped' });
      continue;
    }
    const { desc, stale } = resolveBinding(binding, getPattern?.());
    if (!desc || desc.disabled) {
      onKnobUI?.(knob.id, { norm, stale: true });
      results.push({ knobId: knob.id, applied: false, reason: 'stale' });
      continue;
    }
    const mode = binding.modeOverride || knob.mode || 'absolute';

    if (mode === 'relative') {
      const cur = desc.get();
      const curNorm = paramToNorm(cur, binding, desc);
      const nextNorm = Math.min(1, Math.max(0, curNorm + relativeDelta(value)));
      try { desc.set(normToParam(nextNorm, binding, desc)); } catch { /* ignore */ }
      onKnobUI?.(knob.id, { norm: nextNorm, stale, waiting: false });
      results.push({ knobId: knob.id, applied: true, mode });
      continue;
    }

    // absolute + pickup share the gate; absolute always applies
    const hinted = hintKnobMode(knob.id, value);
    const curNorm = paramToNorm(desc.get(), binding, desc);
    const gate = pickupGate(norm, curNorm, mode);
    if (!gate.apply) {
      onKnobUI?.(knob.id, { norm, paramNorm: curNorm, stale, waiting: true, hinted });
      results.push({ knobId: knob.id, applied: false, reason: 'pickup', hinted });
      continue;
    }
    try { desc.set(normToParam(norm, binding, desc)); } catch { /* ignore */ }
    onKnobUI?.(knob.id, { norm, stale, waiting: false, hinted });
    results.push({ knobId: knob.id, applied: true, mode, hinted });
  }
  return results;
}

/** Push current param values back to knob arcs (e.g. after UI slider drag). */
export function refreshKnobUIFromParams(map, getPattern, onKnobUI) {
  for (const binding of map.bindings) {
    if (!binding?.paramId) {
      onKnobUI?.(binding.knobId, { norm: 0, unmapped: true });
      continue;
    }
    const { desc, stale } = resolveBinding(binding, getPattern?.());
    if (!desc || desc.disabled) {
      onKnobUI?.(binding.knobId, { norm: 0, stale: true });
      continue;
    }
    try {
      onKnobUI?.(binding.knobId, { norm: paramToNorm(desc.get(), binding, desc), stale });
    } catch { /* ignore */ }
  }
}
