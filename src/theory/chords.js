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
} from './music.js';

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
  const FALLBACK = {
    '': '0 4 7', m: '0 3 7', dim: '0 3 6', aug: '0 4 8',
    7: '0 4 7 10', maj7: '0 4 7 11', m7: '0 3 7 10',
    dim7: '0 3 6 9', m7b5: '0 3 6 10', sus2: '0 2 7', sus4: '0 5 7',
    '6': '0 4 7 9', m6: '0 3 7 9', 9: '0 4 7 10 14', m9: '0 3 7 10 14',
    add9: '0 4 7 14', madd9: '0 3 7 14',
  };
  return { root, intervals: FALLBACK[rest] || '0 4 7' };
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
