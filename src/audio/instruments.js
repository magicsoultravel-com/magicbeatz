/**
 * Instrument registry — sampled instruments backed by the unified catalog.
 */
import {
  SOUNDS,
  DEFAULT_INSTRUMENT_ID,
  DEFAULT_DRUM_KIT_ID,
  resolveSoundOr,
  soundsForTarget,
  categoriesForKind,
} from './catalog.js';

export {
  resolveSoundOr as resolveSound,
  soundsForTarget,
  categoriesForKind,
  DEFAULT_INSTRUMENT_ID,
  DEFAULT_DRUM_KIT_ID,
} from './catalog.js';

export const INSTRUMENT_CATEGORIES = categoriesForKind('pitched');

export const INSTRUMENTS = SOUNDS
  .filter((s) => s.kind === 'pitched')
  .map((s) => ({
    id: s.id,
    label: s.label,
    category: s.category,
    engine: s.engine,
    banks: (s.targets || []).slice(),
    aliases: s.aliases || [],
    tags: s.tags || [],
    sample: !!s.sample,
    source: s.source,
    sustain: s.sustain !== false,
  }));

const BY_ID = new Map(INSTRUMENTS.map((i) => [i.id, i]));
const DEFAULT_INSTRUMENT = BY_ID.get(DEFAULT_INSTRUMENT_ID) || INSTRUMENTS[0] || null;

export function resolveInstrument(id) {
  const entry = resolveSoundOr('pitched', id);
  return (entry && BY_ID.get(entry.id)) || DEFAULT_INSTRUMENT;
}

export function instrumentSupportsSustain(id) {
  return resolveInstrument(id)?.sustain !== false;
}

export function instrumentLabel(id) {
  return resolveInstrument(id)?.label || String(id || '');
}

export function instrumentOptions() {
  return INSTRUMENTS.map(({ id, label, banks, category, engine, tags, source }) => ({
    id, label, banks, category, engine, tags, source,
  }));
}

export function instrumentOptionsForType(type) {
  const bank = type === 'chord' ? 'chord' : 'note';
  return instrumentOptions().filter((o) => o.banks.includes(bank));
}

export function categoryDefault(category) {
  return INSTRUMENTS.find((i) => i.category === category) || DEFAULT_INSTRUMENT;
}

export function resolveDrum(id) {
  return resolveSoundOr('drum', id);
}

export function drumVoiceLabel(id) {
  return resolveDrum(id)?.label || String(id || '');
}
