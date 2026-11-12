/**
 * Staff view — one musical staff per instrument (src/sequencer/staff.js).
 *
 * The grid stores one channel per sounding pitch, so a recorded part can span a
 * dozen rows for a single instrument. This module collapses those rows: note
 * channels are grouped by `instrumentId` (the same grouping the record/replace
 * logic uses), percussion voices and chord tracks keep one row each, and rows
 * that hold no steps are dropped. Every hit is then placed on a five-line staff
 * by its written pitch (diatonic line/space + accidental), with ledger lines
 * for notes outside the staff.
 *
 * Everything here is pure data — no DOM, no audio — so the grouping and the
 * notation maths are testable under `node --test`. The console only turns these
 * groups into elements.
 */
import { pitchToMidi, pitchOctFromMidi } from '../midi/notes.js';

export const GRID_VIEW_PREFS_KEY = 'magicbeatz-grid-view-v1';
export const GRID_VIEW_MODES = Object.freeze(['grid', 'staff']);
export const DEFAULT_GRID_VIEW_PREFS = Object.freeze({ mode: 'grid' });

/** Normalize a stored grid-view pref (anything unusable falls back to grid). */
export function normalizeGridViewPrefs(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_GRID_VIEW_PREFS };
  return { mode: raw.mode === 'staff' ? 'staff' : 'grid' };
}

// ---------- staff geometry (kept in sync with app.css) ----------

/** Lines in one staff; two diatonic steps (line → space → line) per gap. */
export const STAFF_LINE_COUNT = 5;
/** Pixels between adjacent staff lines. */
export const STAFF_LINE_GAP = 10;
/** Pixels per diatonic step (line → space). */
export const STAFF_DIATONIC_PX = STAFF_LINE_GAP / 2;
/** Breathing room above the highest / below the lowest ink. */
export const STAFF_PAD_Y = 12;
/** One step column: 22px cell + 4px gap, matching .mbz-ch-row. */
export const STAFF_COL_W = 22;
export const STAFF_COL_GAP = 4;
export const STAFF_COL_PITCH = STAFF_COL_W + STAFF_COL_GAP;
/** Percussion rows are a single line, like a neutral drum staff. */
export const STAFF_PERC_ROW_H = 38;
/** Shortest pitched staff (five lines + padding). */
export const STAFF_MIN_ROW_H = 52;

const LETTER_STEP = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

/** Diatonic line/space index of a written pitch (C4 = 28, C5 = 35, …). */
export function diatonicStep(pitch = 'C', octave = 4) {
  const letter = String(pitch || 'C').trim().charAt(0).toUpperCase();
  const base = LETTER_STEP[letter] ?? 0;
  const oct = Number(octave);
  const safeOct = Number.isFinite(oct) ? Math.round(oct) : 4;
  return 7 * safeOct + base;
}

/** '#' / 'b' for chromatic spellings; natural letters share their line. */
export function accidentalFor(pitch = '') {
  const p = String(pitch || '');
  if (p.includes('#')) return '#';
  if (p.includes('b')) return 'b';
  return '';
}

/** Horizontal centre of a step column inside the staff sheet. */
export function staffStepX(stepIndex) {
  const step = Math.max(0, Math.round(Number(stepIndex) || 0));
  return step * STAFF_COL_PITCH + STAFF_COL_W / 2;
}

// ---------- grouping ----------

function velocityOf(step) {
  const v = Number(step?.velocity);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
}

function noteHit(channel, step) {
  const pitch = channel.pitch || 'C';
  const octave = channel.octave ?? 4;
  const midi = pitchToMidi(pitch, octave);
  return {
    midi: Number.isFinite(midi) ? midi : null,
    pitch,
    octave,
    velocity: velocityOf(step),
    channelId: channel.id,
  };
}

/**
 * One entry per visible instrument row.
 *
 * @param {object} pattern clip
 * @param {{
 *   stepCount?: number,
 *   hideEmpty?: boolean,
 *   instrumentLabel?: (id: string) => string,
 *   resolveChordNotes?: (channel: object, stepIndex: number) => Array<{pitch: string, octave?: number}>,
 * }} [opts]
 * @returns {Array<{
 *   key: string, kind: 'note'|'percussion'|'chord', label: string,
 *   instrumentId: string, voiceId: string, channelIds: string[],
 *   steps: Array<Array<object>>, noteCount: number,
 *   minMidi: number|null, maxMidi: number|null,
 * }>}
 */
export function buildStaffGroups(pattern, opts = {}) {
  const channels = Array.isArray(pattern?.channels) ? pattern.channels : [];
  const maxLen = channels.reduce((max, ch) => Math.max(max, ch?.steps?.length || 0), 0);
  const stepCount = Math.max(1, Math.round(Number(opts.stepCount) || maxLen || 16));
  const resolver = typeof opts.resolveChordNotes === 'function' ? opts.resolveChordNotes : null;
  const labelFor = typeof opts.instrumentLabel === 'function' ? opts.instrumentLabel : null;
  const groups = [];
  const byKey = new Map();

  const makeSteps = () => Array.from({ length: stepCount }, () => []);

  const makeGroup = (key, kind, partial) => {
    const group = {
      key,
      kind,
      label: '',
      instrumentId: '',
      voiceId: '',
      channelIds: [],
      steps: makeSteps(),
      noteCount: 0,
      minMidi: null,
      maxMidi: null,
      ...partial,
    };
    byKey.set(key, group);
    groups.push(group);
    return group;
  };

  const addHit = (group, midi, hit) => {
    group.steps[hit.stepIndex].push({ ...hit, midi });
    group.noteCount += 1;
    if (Number.isFinite(midi)) {
      group.minMidi = group.minMidi == null ? midi : Math.min(group.minMidi, midi);
      group.maxMidi = group.maxMidi == null ? midi : Math.max(group.maxMidi, midi);
    }
  };

  for (const ch of channels) {
    if (!ch?.steps) continue;
    const kind = ch.type === 'chord' ? 'chord' : ch.type === 'percussion' ? 'percussion' : 'note';

    if (kind === 'note') {
      // One row per instrument: every pitch row of that sound merges here.
      const key = `note:${ch.instrumentId || ''}`;
      let group = byKey.get(key);
      if (!group) {
        group = makeGroup(key, 'note', {
          instrumentId: ch.instrumentId || '',
          label: labelFor ? labelFor(ch.instrumentId || '') : (ch.name || ch.instrumentId || 'instrument'),
        });
      }
      group.channelIds.push(ch.id);
      for (let i = 0; i < stepCount; i += 1) {
        const step = ch.steps[i];
        if (!step) continue;
        const hit = noteHit(ch, step);
        addHit(group, hit.midi, { ...hit, stepIndex: i });
      }
      continue;
    }

    if (kind === 'percussion') {
      // A drum voice has no register: one row, one line.
      const key = `percussion:${ch.id}`;
      const group = makeGroup(key, 'percussion', {
        voiceId: ch.voiceId || '',
        label: ch.name || ch.voiceId || 'drum',
        channelIds: [ch.id],
      });
      for (let i = 0; i < stepCount; i += 1) {
        const step = ch.steps[i];
        if (!step) continue;
        addHit(group, null, {
          pitch: ch.voiceId || '',
          octave: null,
          velocity: velocityOf(step),
          channelId: ch.id,
          stepIndex: i,
        });
      }
      continue;
    }

    // Chord tracks keep their own row; each hit is its resolved chord.
    const key = `chord:${ch.id}`;
    const group = makeGroup(key, 'chord', {
      instrumentId: ch.instrumentId || '',
      label: labelFor && ch.instrumentId ? labelFor(ch.instrumentId) : (ch.name || ch.instrumentId || 'chord'),
      channelIds: [ch.id],
    });
    for (let i = 0; i < stepCount; i += 1) {
      const step = ch.steps[i];
      if (!step) continue;
      const resolved = resolver ? (resolver(ch, i) || []) : [];
      if (!resolved.length) {
        // Unknown voicing (or no theory data loaded yet): keep the hit visible.
        addHit(group, null, {
          pitch: ch.chordName || '',
          octave: null,
          velocity: velocityOf(step),
          channelId: ch.id,
          stepIndex: i,
        });
        continue;
      }
      for (const entry of resolved) {
        if (!entry?.pitch) continue;
        const pitch = entry.pitch;
        const octave = entry.octave ?? 4;
        const midi = pitchToMidi(pitch, octave);
        addHit(group, Number.isFinite(midi) ? midi : null, {
          pitch,
          octave,
          velocity: velocityOf(step),
          channelId: ch.id,
          stepIndex: i,
        });
      }
    }
  }

  if (opts.hideEmpty === false) return groups;
  return groups.filter((group) => group.noteCount > 0);
}

// ---------- notation layout ----------

/**
 * Place every hit of a group on its staff.
 *
 * The five lines are centred on the group's own register, so a bass part and a
 * piano part both read well without a clef setting; notes outside the staff get
 * ledger lines and the row grows to fit.
 *
 * @returns {{
 *   kind: string, height: number,
 *   lines: Array<{ y: number }>,
 *   ledgers: Array<{ x: number, y: number }>,
 *   notes: Array<object>,
 * }}
 */
export function layoutStaffGroup(group) {
  if (!group) return null;
  const hits = [];
  for (let stepIndex = 0; stepIndex < group.steps.length; stepIndex += 1) {
    for (const hit of group.steps[stepIndex]) {
      hits.push({ ...hit, step: stepIndex });
    }
  }

  if (group.kind === 'percussion') {
    const y = STAFF_PERC_ROW_H / 2;
    return {
      kind: group.kind,
      height: STAFF_PERC_ROW_H,
      lines: [{ y }],
      ledgers: [],
      notes: hits.map((hit) => ({ ...hit, x: staffStepX(hit.step), y })),
    };
  }

  const notes = hits.map((hit) => ({
    ...hit,
    diatonic: Number.isFinite(hit.midi) ? diatonicStep(hit.pitch, hit.octave ?? 4) : null,
    accidental: accidentalFor(hit.pitch),
    x: staffStepX(hit.step),
  }));
  const known = notes.filter((note) => note.diatonic != null);

  let center;
  if (known.length) {
    let lo = known[0].diatonic;
    let hi = known[0].diatonic;
    for (const note of known) {
      lo = Math.min(lo, note.diatonic);
      hi = Math.max(hi, note.diatonic);
    }
    center = Math.round((lo + hi) / 2);
  } else {
    center = diatonicStep('B', 4);
  }

  const half = Math.floor(STAFF_LINE_COUNT / 2); // 2 lines above / below the middle
  const staffTop = center + half * 2;
  const staffBottom = center - half * 2;
  let contentTop = staffTop;
  let contentBottom = staffBottom;
  for (const note of known) {
    contentTop = Math.max(contentTop, note.diatonic);
    contentBottom = Math.min(contentBottom, note.diatonic);
  }

  const spanH = (contentTop - contentBottom) * STAFF_DIATONIC_PX + STAFF_PAD_Y * 2;
  const height = Math.max(STAFF_MIN_ROW_H, spanH);
  const offsetY = (height - spanH) / 2;
  const yFor = (diatonic) => (contentTop - diatonic) * STAFF_DIATONIC_PX + STAFF_PAD_Y + offsetY;

  const lines = [];
  for (let i = 0; i < STAFF_LINE_COUNT; i += 1) {
    lines.push({ y: yFor(staffTop - i * 2) });
  }

  const ledgerKeys = new Set();
  const ledgers = [];
  const addLedger = (step, diatonic) => {
    const key = `${step}:${diatonic}`;
    if (ledgerKeys.has(key)) return;
    ledgerKeys.add(key);
    ledgers.push({ x: staffStepX(step), y: yFor(diatonic) });
  };
  for (const note of known) {
    if (note.diatonic > staffTop) {
      for (let d = staffTop + 2; d <= note.diatonic; d += 2) addLedger(note.step, d);
    } else if (note.diatonic < staffBottom) {
      for (let d = staffBottom - 2; d >= note.diatonic; d -= 2) addLedger(note.step, d);
    }
  }

  return {
    kind: group.kind,
    height,
    lines,
    ledgers,
    notes: notes.map((note) => ({
      ...note,
      y: note.diatonic == null ? yFor(center) : yFor(note.diatonic),
    })),
  };
}

/** Head pill: written range for pitched rows, hit count for drums. */
export function staffRangeLabel(group) {
  if (!group) return '';
  if (group.kind === 'percussion') {
    return group.noteCount ? `${group.noteCount} hit${group.noteCount === 1 ? '' : 's'}` : '';
  }
  if (group.minMidi == null || group.maxMidi == null) return '';
  const lo = pitchOctFromMidi(group.minMidi);
  const hi = pitchOctFromMidi(group.maxMidi);
  const loLabel = `${lo.pitch}${lo.octave}`;
  const hiLabel = `${hi.pitch}${hi.octave}`;
  return loLabel === hiLabel ? loLabel : `${loLabel}–${hiLabel}`;
}
