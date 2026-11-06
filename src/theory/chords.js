/**
 * Standalone chord resolution for magicbeatz (theory triads, no guitar shapes).
 *
 * The suite voiced named chords through 6-string guitar shapes
 * (getVoicedChord). magicbeatz is a beatbox, not a fretboard, so named
 * chords resolve data-driven: match the chord-name suffix against
 * chords-theory.json intervals, then spread pitch classes across octaves.
 * Degree chords resolve against the active scale like the suite did.
 */
import {
  CHROMATIC,
  getDiatonicTriads,
  getRoot,
  getTheoryNotes,
  normalizePitch,
  pitchToIndex,
} from './music.js';

/** Common suffixes; also the preference order when naming a stack. */
const FALLBACK_INTERVALS = {
  '': '0 4 7', m: '0 3 7', dim: '0 3 6', aug: '0 4 8',
  7: '0 4 7 10', maj7: '0 4 7 11', m7: '0 3 7 10',
  dim7: '0 3 6 9', m7b5: '0 3 6 10', sus2: '0 2 7', sus4: '0 5 7',
  6: '0 4 7 9', m6: '0 3 7 9', 9: '0 4 7 10 14', m9: '0 3 7 10 14',
  add9: '0 4 7 14', madd9: '0 3 7 14',
};

/** Spread pitch classes across registers so chords don't stack on one octave. */
export function spreadChordPitches(notes) {
  const unique = [...new Set((notes || []).map(normalizePitch).filter(Boolean))];
  return unique.map((pitch, i) => ({
    pitch,
    octave: 3 + Math.floor(i / 3),
  }));
}

/** Suffix of a theory short symbol with its root stripped (e.g. "Cm7" -> "m7"). */
function theorySuffix(short) {
  const m = String(short || '').match(/^[A-G][#b]?/);
  return m ? String(short).slice(m[0].length) : String(short || '');
}

/** Intervals for a named chord: theory-data match first, common-suffix fallback. */
export function intervalsForChordName(name, chordsTheory = {}) {
  const root = normalizePitch(getRoot(String(name || 'C')));
  const rest = String(name || '').slice(getRoot(String(name || 'C')).length);
  for (const data of Object.values(chordsTheory || {})) {
    if (!data || typeof data.intervals !== 'string') continue;
    if (theorySuffix(data.short) === rest) return { root, intervals: data.intervals };
  }
  return { root, intervals: FALLBACK_INTERVALS[rest] || '0 4 7' };
}

/** Pitch-class set of an interval string ("0 4 7 14" -> [0, 2, 4, 7]). */
function intervalClasses(intervals) {
  const set = new Set(
    String(intervals || '')
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isFinite(n))
      .map((n) => ((n % 12) + 12) % 12),
  );
  return [...set].sort((a, b) => a - b);
}

/** Every suffix we can name, mapped to its pitch-class set (theory data wins). */
export function chordIntervalTable(chordsTheory = {}) {
  const map = new Map();
  for (const data of Object.values(chordsTheory || {})) {
    if (!data || typeof data.intervals !== 'string') continue;
    const suffix = theorySuffix(data.short);
    if (!map.has(suffix)) map.set(suffix, data.intervals);
  }
  for (const [suffix, intervals] of Object.entries(FALLBACK_INTERVALS)) {
    if (!map.has(suffix)) map.set(suffix, intervals);
  }
  return map;
}

/**
 * Name a stack of notes by inverting the interval table: try each sounding
 * pitch as the root (bass note first, because that is what players hear) and
 * keep the first exact pitch-class match. Returns null when nothing fits —
 * callers show no badge rather than a wrong chord symbol.
 * @param {Array<{pitch: string, octave?: number}>} notes
 * @returns {{root: string, suffix: string}|null}
 */
export function nameChord(notes, chordsTheory = {}) {
  const midis = [];
  for (const note of notes || []) {
    const idx = pitchToIndex(note?.pitch);
    if (idx < 0) continue;
    midis.push(idx + ((note.octave ?? 4) + 1) * 12);
  }
  if (!midis.length) return null;
  midis.sort((a, b) => a - b);
  // Distinct pitch classes, and the bass-first order to try as roots.
  const classes = [...new Set(midis.map((m) => m % 12))].sort((a, b) => a - b);
  if (classes.length < 2) return null;
  const rootOrder = [...new Set(midis.map((m) => m % 12))];
  const table = chordIntervalTable(chordsTheory);
  const rank = new Map([...table.keys()].map((suffix, i) => [suffix, i]));
  for (const rootPc of rootOrder) {
    const rel = classes.map((pc) => (pc - rootPc + 12) % 12).sort((a, b) => a - b);
    let best = null;
    for (const [suffix, intervals] of table) {
      const set = intervalClasses(intervals);
      if (set.length !== rel.length) continue;
      let match = true;
      for (let i = 0; i < set.length; i += 1) {
        if (set[i] !== rel[i]) { match = false; break; }
      }
      if (!match) continue;
      const order = rank.get(suffix) ?? 999;
      if (!best || order < best.order) best = { suffix, order };
    }
    if (best) return { root: CHROMATIC[rootPc], suffix: best.suffix };
  }
  return null;
}

/** "Am7" for a stack of notes, or '' when it isn't a chord we can name. */
export function chordLabel(notes, chordsTheory = {}) {
  const found = nameChord(notes, chordsTheory);
  return found ? `${found.root}${found.suffix}` : '';
}

/**
 * Resolve a channel's chord to playable [{pitch, octave}] entries.
 * @param {object} channel {chordMode, chordName, scaleKey, degree}
 * @param {object} ctx {scalesJson, chordsTheory, hub}
 */
export function chordEntriesFor(channel = {}, ctx = {}) {
  const { scalesJson = {}, chordsTheory = {}, hub = null } = ctx;
  if (channel.chordMode === 'degree') {
    const root = hub?.getRoot?.() || 'C';
    const steps = scalesJson?.[channel.scaleKey || 'Ionian']?.steps;
    if (!steps?.length) return [];
    const triad = getDiatonicTriads(root, steps)[channel.degree ?? 0];
    if (!triad?.notes?.length) return [];
    return spreadChordPitches(triad.notes);
  }
  const name = channel.chordName || channel.voiceId;
  if (!name) return [];
  const { root, intervals } = intervalsForChordName(name, chordsTheory);
  return spreadChordPitches(getTheoryNotes(root, intervals));
}

/** Chord names sorted musically, for the pad-map editors. */
export function chordNameOptions(chordsJson, chordsTheory = {}) {
  const fromDb = Object.keys(chordsJson || {});
  const fromTheory = (CHROMATIC || []).flatMap((root) =>
    Object.values(chordsTheory || {})
      .map((d) => (d?.short ? root + theorySuffix(d.short) : null))
      .filter(Boolean),
  );
  return [...new Set([...fromDb, ...fromTheory])].sort();
}
