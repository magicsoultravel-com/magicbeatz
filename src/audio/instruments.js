/**
 * Instrument registry — single source of truth for categories + engines.
 *
 * engine 'synth'  → play in src/audio/voices.js (instant, offline)
 * engine 'sample' → lazy smplr instrument in src/audio/sampler.js,
 *                   synth fallback voice until loaded (or offline).
 *
 * Legacy ids keep working: unknown instrumentId resolves to the category
 * default, never silent. `banks` mirrors the old INSTRUMENT_OPTIONS shape
 * so pattern.js filtering is unchanged.
 */

export const INSTRUMENT_CATEGORIES = [
  'Piano / Keys',
  'Bass',
  'Guitar / Pluck',
  'Strings / Orch',
  'Leads',
];

export const INSTRUMENTS = [
  // Piano / Keys
  { id: 'grand', label: 'grand piano', category: 'Piano / Keys', engine: 'sample', banks: ['note', 'chord'], fallback: 'piano', aliases: ['piano'] },
  { id: 'e-piano', label: 'e-piano', category: 'Piano / Keys', engine: 'sample', banks: ['note', 'chord'], fallback: 'keys-pluck' },
  { id: 'keys-pluck', label: 'keys', category: 'Piano / Keys', engine: 'synth', banks: ['note', 'chord'] },
  { id: 'keys-pad', label: 'pad', category: 'Piano / Keys', engine: 'synth', banks: ['note', 'chord'] },
  { id: 'keys-bell', label: 'bell', category: 'Piano / Keys', engine: 'synth', banks: ['note', 'chord'] },
  { id: 'piano-synth', label: 'piano (synth)', category: 'Piano / Keys', engine: 'synth', banks: ['note', 'chord'] },
  // Bass
  { id: 'upright', label: 'upright bass', category: 'Bass', engine: 'sample', banks: ['note'], fallback: 'bass-sub' },
  { id: 'bass-sub', label: 'bass sub', category: 'Bass', engine: 'synth', banks: ['note'] },
  { id: 'bass-growl', label: 'bass growl', category: 'Bass', engine: 'synth', banks: ['note'] },
  { id: 'bass-pluck', label: 'bass pluck', category: 'Bass', engine: 'synth', banks: ['note'] },
  { id: 'bass-finger', label: 'bass finger', category: 'Bass', engine: 'synth', banks: ['note'] },
  // Guitar / Pluck
  { id: 'nylon', label: 'nylon guitar', category: 'Guitar / Pluck', engine: 'sample', banks: ['note', 'chord'], fallback: 'guitar' },
  { id: 'guitar', label: 'guitar (synth)', category: 'Guitar / Pluck', engine: 'synth', banks: ['note', 'chord'] },
  { id: 'steel-drum', label: 'steel drum', category: 'Guitar / Pluck', engine: 'synth', banks: ['note'] },
  // Strings / Orch
  { id: 'strings', label: 'strings', category: 'Strings / Orch', engine: 'synth', banks: ['note', 'chord'] },
  { id: 'violin', label: 'violin', category: 'Strings / Orch', engine: 'synth', banks: ['note'] },
  // Leads (samples pointless here — synth only)
  { id: 'lead-square', label: 'lead sq', category: 'Leads', engine: 'synth', banks: ['note'] },
  { id: 'lead-saw', label: 'lead saw', category: 'Leads', engine: 'synth', banks: ['note'] },
];

const BY_ID = new Map(INSTRUMENTS.map((i) => [i.id, i]));
const ALIASES = new Map();
for (const inst of INSTRUMENTS) {
  for (const a of inst.aliases || []) ALIASES.set(a, inst.id);
}

/** Resolve any legacy/unknown id to a registry entry — never undefined. */
export function resolveInstrument(id) {
  if (BY_ID.has(id)) return BY_ID.get(id);
  if (ALIASES.has(id)) return BY_ID.get(ALIASES.get(id));
  return BY_ID.get('keys-pluck');
}

/** Flat options list (old INSTRUMENT_OPTIONS shape + category/engine). */
export function instrumentOptions() {
  return INSTRUMENTS.map(({ id, label, banks, category, engine }) => ({ id, label, banks, category, engine }));
}

export function instrumentOptionsForType(type) {
  const bank = type === 'chord' ? 'chord' : 'note';
  return instrumentOptions().filter((o) => o.banks.includes(bank));
}

/** Category default for fallback (first entry of the category). */
export function categoryDefault(category) {
  return INSTRUMENTS.find((i) => i.category === category) || BY_ID.get('keys-pluck');
}
