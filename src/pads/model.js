/**
 * Pad map: 8 visible pads × Bank A/B = 16 mappings (DeepSeek: document bank model).
 * Hardware layout: bottom row P1-4, top row P5-8 — matches MK3 pad order.
 * Each pad = a "tab": { target: drum | note | chord, ...params, curve, gain, midiNote, midiChannel }.
 *
 * Routing model (DeepSeek fix): route by (channel, note) MEMBERSHIP, not channel role.
 * incoming (ch, note) -> lookup (ch, note) in active bank -> drum hit? fire : piano range? play piano : ignore.
 * Factory presets: pads Ch 10 (index 9), keys Ch 1 (index 0) — presets, not rules.
 */
import { MBZ_PADMAP_KEY } from '../state/store.js';
import {
  defaultKitForBank,
  kitBankVoices,
  canonicalDrumVoice,
  resolveKit,
  resolveSound,
  DEFAULT_INSTRUMENT_ID,
} from '../audio/catalog.js';

export const PAD_ORDER = [5, 6, 7, 8, 1, 2, 3, 4]; // display order: top row then bottom
export const PAD_SCHEMA = 3;
export const DEFAULT_PAD_CHANNEL = 9; // Ch 10 zero-based
export const DEFAULT_KEYS_CHANNEL = 0; // Ch 1 zero-based

/** GM-ish pad notes for each bank; the kit decides the actual sample voice. */
const BANK_NOTES = {
  A: [36, 38, 42, 46, 39, 43, 47, 45],
  B: [48, 50, 51, 49, 52, 53, 55, 57],
};

function defaultBank(bank) {
  const kitId = defaultKitForBank(bank);
  const voices = kitBankVoices(kitId, bank);
  return voices.map((voiceId, i) => ({
    pad: i + 1,
    midiNote: BANK_NOTES[bank][i],
    target: 'drum',
    voiceId,
  }));
}

function withDefaults(entry) {
  const voiceId = canonicalDrumVoice(entry?.voiceId) || entry?.voiceId || 'kick';
  const sound = resolveSound(entry?.instrumentId);
  const instrumentId = sound?.kind === 'pitched' ? sound.id : DEFAULT_INSTRUMENT_ID;
  return {
    curve: 'linear',
    gain: 0.9,
    pitch: 'C',
    octave: 4,
    instrumentId,
    chordName: 'C',
    chordMode: 'named',
    scaleKey: 'Ionian',
    degree: 0,
    midiChannel: DEFAULT_PAD_CHANNEL,
    ...entry,
    voiceId: entry?.target === 'drum' || !entry?.target ? voiceId : entry?.voiceId,
    instrumentId,
    chordName: entry?.chordName || 'C',
    octave: entry?.octave ?? 4,
    pitch: entry?.pitch || 'C',
    chordMode: entry?.chordMode === 'degree' ? 'degree' : 'named',
  };
}

export function defaultPadMap() {
  const map = {
    A: {},
    B: {},
    kits: {
      A: defaultKitForBank('A'),
      B: defaultKitForBank('B'),
    },
    keysChannel: DEFAULT_KEYS_CHANNEL,
  };
  for (const e of defaultBank('A')) map.A[e.pad] = withDefaults({ ...e, bank: 'A' });
  for (const e of defaultBank('B')) map.B[e.pad] = withDefaults({ ...e, bank: 'B' });
  return map;
}

/** Explicit migration (v1/v2 -> v3): stamp channel, kit banks and aliases. */
export function migratePadMap(raw) {
  const map = {
    A: {},
    B: {},
    kits: {
      A: resolveKit(raw?.kits?.A)?.id || defaultKitForBank('A'),
      B: resolveKit(raw?.kits?.B)?.id || defaultKitForBank('B'),
    },
    keysChannel: DEFAULT_KEYS_CHANNEL,
  };
  for (const b of ['A', 'B']) {
    for (const [k, v] of Object.entries(raw?.[b] || {})) {
      map[b][k] = withDefaults({ ...v, midiChannel: v?.midiChannel ?? DEFAULT_PAD_CHANNEL });
    }
  }
  if (typeof raw?.keysChannel === 'number') map.keysChannel = raw.keysChannel;
  // Fill any missing pads from defaults
  const fresh = defaultPadMap();
  for (const b of ['A', 'B']) {
    for (const [k, v] of Object.entries(fresh[b])) {
      if (!map[b][k]) map[b][k] = v;
    }
  }
  return map;
}

export function loadPadMap() {
  try {
    const raw = localStorage.getItem(MBZ_PADMAP_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.schemaVersion === PAD_SCHEMA
        && parsed.map?.A && parsed.map?.B && parsed.map?.kits) {
        return parsed.map;
      }
      if (parsed && parsed.map?.A && parsed.map?.B) {
        const migrated = migratePadMap(parsed.map);
        savePadMap(migrated);
        return migrated;
      }
      // Bare v1 map without version wrapper
      if (parsed?.A && parsed?.B && !parsed.schemaVersion) {
        const migrated = migratePadMap(parsed);
        savePadMap(migrated);
        return migrated;
      }
    }
  } catch { /* ignore */ }
  const map = defaultPadMap();
  savePadMap(map);
  return map;
}

export function savePadMap(map) {
  try {
    localStorage.setItem(MBZ_PADMAP_KEY, JSON.stringify({ schemaVersion: PAD_SCHEMA, map }));
  } catch { /* ignore */ }
}

/** Find pad by (channel, note) in the ACTIVE bank. Channel-aware, falls back to note-only. */
export function findPadByNote(map, bankId, note, channel) {
  const bucket = map?.[bankId] || {};
  if (channel != null) {
    for (const [padNum, entry] of Object.entries(bucket)) {
      if (entry?.midiNote === note && (entry?.midiChannel ?? DEFAULT_PAD_CHANNEL) === channel) {
        return { padNum: Number(padNum), entry };
      }
    }
    return null;
  }
  // Degraded: channel stripped — note-only lookup
  for (const [padNum, entry] of Object.entries(bucket)) {
    if (entry?.midiNote === note) return { padNum: Number(padNum), entry };
  }
  return null;
}

/** All pads (both banks) claiming the same (channel, note) — for collision warnings. */
export function padCollisions(map, ignoreBank, ignorePad, note, channel) {
  const out = [];
  for (const b of ['A', 'B']) {
    for (const [padNum, entry] of Object.entries(map?.[b] || {})) {
      if (b === ignoreBank && Number(padNum) === Number(ignorePad)) continue;
      if (entry?.midiNote === note && (entry?.midiChannel ?? DEFAULT_PAD_CHANNEL) === (channel ?? DEFAULT_PAD_CHANNEL)) {
        out.push(`${b}${padNum}`);
      }
    }
  }
  return out;
}

/** Velocity curves — shared by pads + keys. */
export function applyCurve(velocity, curve) {
  const v = Math.min(1, Math.max(0, velocity ?? 0.8));
  if (curve === 'soft') return Math.pow(v, 0.6);
  if (curve === 'hard') return Math.pow(v, 1.8);
  if (curve === 'fixed') return 0.9;
  return v;
}

/** CC-learn pending slot: { kind: 'knob', index } or { kind:'pad', bank, pad } or null. */
export let learnSlot = null;
export function setLearnSlot(slot) { learnSlot = slot; }
export function getLearnSlot() { return learnSlot; }
