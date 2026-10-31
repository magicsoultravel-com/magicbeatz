/**
 * Sound catalog — single source of truth for sampled instruments + drum kits.
 *
 * Data lives in src/data/instruments.js (editable without touching logic).
 * This module adds resolution helpers, aliases, target filtering and the
 * logical-voice → kit-sample lookup used by the audio layer.
 */
import catalogData from '../data/instruments.js';

export const SOUND_SCHEMA_VERSION = catalogData.schemaVersion || 1;
export const SOUND_CATEGORIES = catalogData.categories || [];
export const DEFAULT_INSTRUMENT_ID = catalogData.defaultInstrumentId || 'grand';
export const DEFAULT_DRUM_KIT_ID = catalogData.defaultDrumKitId || 'studio';
export const DEFAULT_KIT_BANKS = { ...(catalogData.defaultKitBanks || { A: 'studio', B: '808' }) };

/** Drum voices are logical pads; each kit supplies its own sample names. */
const DRUM_SOUNDS = (catalogData.drumVoices || []).map((v) => ({
  id: v.id,
  kind: 'drum',
  label: v.label || v.id,
  category: 'Drums',
  engine: 'sample',
  targets: ['drum'],
  sample: true,
  aliases: v.aliases || [],
}));

export const SOUNDS = [...DRUM_SOUNDS, ...(catalogData.sounds || [])];

const BY_ID = new Map(SOUNDS.map((s) => [s.id, s]));
const ALIASES = new Map();
for (const s of SOUNDS) {
  for (const a of s.aliases || []) {
    if (!BY_ID.has(a) && !ALIASES.has(a)) ALIASES.set(a, s.id);
  }
}

/** Resolve any id/alias to a catalog entry, or null if unknown. */
export function resolveSound(id) {
  if (!id) return null;
  if (BY_ID.has(id)) return BY_ID.get(id);
  if (ALIASES.has(id)) return BY_ID.get(ALIASES.get(id));
  return null;
}

/** Resolve to a sound of a given kind, never null (falls back to kind default). */
export function resolveSoundOr(kind, id) {
  const entry = resolveSound(id);
  if (entry && entry.kind === kind) return entry;
  const defaultId = kind === 'drum' ? 'kick' : DEFAULT_INSTRUMENT_ID;
  return resolveSound(defaultId) || SOUNDS.find((s) => s.kind === kind) || null;
}

/** All sounds usable for a given target ('drum' | 'note' | 'chord'). */
export function soundsForTarget(target) {
  return SOUNDS.filter((s) => Array.isArray(s.targets) && s.targets.includes(target));
}

/** Sounds of a kind. */
export function soundsOfKind(kind) {
  return SOUNDS.filter((s) => s.kind === kind);
}

/** Categories that contain at least one sound of the given kind. */
export function categoriesForKind(kind) {
  const used = new Set(SOUNDS.filter((s) => s.kind === kind).map((s) => s.category));
  const ordered = [...SOUND_CATEGORIES, ...used];
  return ordered.filter((c, i) => used.has(c) && ordered.indexOf(c) === i);
}

export function isSampleSound(s) {
  return !!s?.sample || s?.engine === 'sample';
}

// ---------- drum kits ----------

export const KITS = catalogData.kits || [];
const KITS_BY_ID = new Map(KITS.map((k) => [k.id, k]));

/** Resolve a kit by id, or null. */
export function resolveKit(id) {
  return id ? KITS_BY_ID.get(id) || null : null;
}

/** Resolve a kit by id, falling back to the default room kit. */
export function resolveKitOr(id) {
  return resolveKit(id) || resolveKit(DEFAULT_DRUM_KIT_ID) || KITS[0] || null;
}

/** Kit assigned to a pad bank by default. */
export function defaultKitForBank(bank) {
  return resolveKitOr(DEFAULT_KIT_BANKS[bank] || DEFAULT_DRUM_KIT_ID).id;
}

/** Canonical logical drum voice id (follows legacy aliases), or null. */
export function canonicalDrumVoice(id) {
  const sound = resolveSound(id);
  return sound?.kind === 'drum' ? sound.id : null;
}

/** Sample name a kit uses for a logical voice. */
export function kitSampleForVoice(kitId, voiceId) {
  const kit = resolveKitOr(kitId);
  const voice = canonicalDrumVoice(voiceId);
  if (!kit) return '';
  if (voice && kit.voices?.[voice]) return kit.voices[voice];
  // Unknown/legacy voice: keep the pad audible with the kit's kick.
  return kit.voices?.kick || Object.values(kit.voices || {})[0] || '';
}

/** Ordered logical voices for a bank of a kit. */
export function kitBankVoices(kitId, bank) {
  const kit = resolveKitOr(kitId);
  const raw = kit?.banks?.[bank] || kit?.banks?.A || [];
  return raw.map(canonicalDrumVoice).filter(Boolean);
}

/** Kit options for pickers. */
export function kitOptions() {
  return KITS.map((k) => ({
    id: k.id,
    label: k.label,
    machine: k.machine,
    category: k.category || 'Kit',
    description: k.description || '',
  }));
}
