import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GRID_VIEW_PREFS,
  GRID_VIEW_MODES,
  GRID_VIEW_PREFS_KEY,
  STAFF_LINE_COUNT,
  accidentalFor,
  buildStaffGroups,
  diatonicStep,
  layoutStaffGroup,
  normalizeGridViewPrefs,
  staffRangeLabel,
  staffStepX,
} from '../src/sequencer/staff.js';
import { createChannel } from '../src/sequencer/pattern.js';
import { pitchToMidi } from '../src/midi/notes.js';

/** Sparse step list from { stepIndex: velocity } — everything else is a rest. */
function stepsWith(hits = {}, len = 16) {
  const steps = Array.from({ length: len }, () => null);
  for (const [index, velocity] of Object.entries(hits)) {
    steps[Number(index)] = { velocity };
  }
  return steps;
}

function noteRow(id, { instrumentId, pitch, octave, hits = {} }) {
  return createChannel({
    id, type: 'note', instrumentId, name: instrumentId, pitch, octave, steps: stepsWith(hits),
  });
}

function drumRow(id, voiceId, hits = {}) {
  return createChannel({
    id, type: 'percussion', voiceId, name: voiceId, steps: stepsWith(hits),
  });
}

const label = (id) => (id ? `label:${id}` : '');

test('staff view pref defaults to the step grid and survives garbage', () => {
  assert.equal(GRID_VIEW_PREFS_KEY, 'magicbeatz-grid-view-v1');
  assert.deepEqual(DEFAULT_GRID_VIEW_PREFS, { mode: 'grid' });
  assert.deepEqual(GRID_VIEW_MODES, ['grid', 'staff']);
  assert.deepEqual(normalizeGridViewPrefs(null), { mode: 'grid' });
  assert.deepEqual(normalizeGridViewPrefs('nope'), { mode: 'grid' });
  assert.deepEqual(normalizeGridViewPrefs({ mode: 'staff' }), { mode: 'staff' });
  assert.deepEqual(normalizeGridViewPrefs({ mode: 'STAFF' }), { mode: 'grid' });
  assert.deepEqual(normalizeGridViewPrefs({ mode: 'grid', extra: 1 }), { mode: 'grid' });
});

test('pitch rows merge into one staff per instrument, empty rows drop out', () => {
  const pattern = {
    channels: [
      noteRow('n1', { instrumentId: 'splendid-grand', pitch: 'C', octave: 4, hits: { 0: 0.9, 8: 0.7 } }),
      noteRow('n2', { instrumentId: 'splendid-grand', pitch: 'E', octave: 4, hits: { 0: 0.8 } }),
      noteRow('n3', { instrumentId: 'splendid-grand', pitch: 'G', octave: 4, hits: { 4: 0.8 } }),
      noteRow('n4', { instrumentId: 'bass-sub', pitch: 'C', octave: 2, hits: { 2: 1 } }),
      noteRow('n5', { instrumentId: 'wurli', pitch: 'D', octave: 3 }),
      drumRow('p1', 'kick', { 0: 0.9, 4: 0.9 }),
      drumRow('p2', 'snare'),
    ],
  };
  const groups = buildStaffGroups(pattern, { stepCount: 16, instrumentLabel: label });
  assert.deepEqual(groups.map((g) => g.key), ['note:splendid-grand', 'note:bass-sub', 'percussion:p1']);
  assert.deepEqual(groups.map((g) => g.kind), ['note', 'note', 'percussion']);

  const grand = groups[0];
  assert.equal(grand.label, 'label:splendid-grand');
  assert.deepEqual(grand.channelIds, ['n1', 'n2', 'n3']);
  assert.equal(grand.noteCount, 4);
  assert.equal(grand.steps.length, 16);
  assert.equal(grand.steps[0].length, 2); // C4 + E4 on the same step
  assert.equal(grand.steps[4].length, 1);
  assert.equal(grand.steps[8].length, 1);
  assert.equal(grand.steps[1].length, 0);
  assert.equal(grand.minMidi, pitchToMidi('C', 4));
  assert.equal(grand.maxMidi, pitchToMidi('G', 4));

  const bass = groups[1];
  assert.deepEqual(bass.channelIds, ['n4']);
  assert.equal(bass.noteCount, 1);

  const kick = groups[2];
  assert.equal(kick.label, 'kick');
  assert.equal(kick.noteCount, 2);
  assert.equal(kick.minMidi, null);
  assert.deepEqual(kick.steps[0].map((hit) => hit.midi), [null]);
});

test('chord tracks stay one row and resolve to their voicing', () => {
  const chordRow = createChannel({
    id: 'c1',
    type: 'chord',
    instrumentId: 'keys-pluck',
    chordName: 'Cmaj7',
    name: 'keys',
    steps: stepsWith({ 0: 0.8, 8: 0.6 }),
  });
  const voicing = [{ pitch: 'C', octave: 4 }, { pitch: 'E', octave: 4 }, { pitch: 'G', octave: 4 }];
  const groups = buildStaffGroups({ channels: [chordRow] }, {
    stepCount: 16,
    instrumentLabel: label,
    resolveChordNotes: () => voicing,
  });
  assert.equal(groups.length, 1);
  const chord = groups[0];
  assert.equal(chord.kind, 'chord');
  assert.equal(chord.label, 'label:keys-pluck');
  assert.equal(chord.steps[0].length, 3);
  assert.equal(chord.steps[8].length, 3);
  assert.equal(chord.noteCount, 6);
  assert.equal(chord.minMidi, pitchToMidi('C', 4));
  assert.equal(chord.maxMidi, pitchToMidi('G', 4));

  // No theory data yet: the hit must still show up (middle line, no pitch).
  const bare = buildStaffGroups({ channels: [chordRow] }, { stepCount: 16 });
  assert.equal(bare[0].steps[0].length, 1);
  assert.equal(bare[0].steps[0][0].midi, null);
  assert.equal(bare[0].noteCount, 2);
});

test('written pitch maps to a diatonic line/space index with accidentals', () => {
  assert.equal(diatonicStep('C', 4), 28);
  assert.equal(diatonicStep('C#', 4), 28); // sharps keep the letter's line
  assert.equal(diatonicStep('E', 4), 30);
  assert.equal(diatonicStep('B', 4), 34);
  assert.equal(diatonicStep('C', 5), 35);
  assert.equal(diatonicStep('E', 2), 16);
  assert.equal(diatonicStep(undefined, undefined), 28); // defensive default
  assert.equal(accidentalFor('C#'), '#');
  assert.equal(accidentalFor('Db'), 'b');
  assert.equal(accidentalFor('C'), '');
  assert.equal(staffStepX(0), 11);
  assert.equal(staffStepX(4), 4 * 26 + 11);
});

test('layout centres five lines on the register and places notes by pitch', () => {
  const pattern = {
    channels: [
      noteRow('a', { instrumentId: 'grand', pitch: 'C', octave: 4, hits: { 0: 0.8 } }),
      noteRow('b', { instrumentId: 'grand', pitch: 'G', octave: 4, hits: { 4: 0.8 } }),
    ],
  };
  const [group] = buildStaffGroups(pattern, { stepCount: 16, instrumentLabel: () => 'grand' });
  const layout = layoutStaffGroup(group);
  assert.equal(layout.kind, 'note');
  assert.equal(layout.lines.length, STAFF_LINE_COUNT);
  assert.deepEqual(layout.lines.map((line) => line.y), [12, 22, 32, 42, 52]);
  assert.equal(layout.height, 64); // 8 diatonic steps * 5px + 2 * 12px padding
  assert.equal(layout.ledgers.length, 0);

  const c4 = layout.notes.find((note) => note.pitch === 'C');
  const g4 = layout.notes.find((note) => note.pitch === 'G');
  assert.equal(c4.y, 42); // bottom line
  assert.equal(g4.y, 22); // fourth line up
  assert.equal(c4.x, staffStepX(0));
  assert.equal(g4.x, staffStepX(4));
  assert.equal(g4.y < c4.y, true, 'higher pitch sits higher on the page');
});

test('notes outside the staff grow the row and get ledger lines', () => {
  const pattern = {
    channels: [
      noteRow('lo', { instrumentId: 'bass', pitch: 'C', octave: 2, hits: { 0: 0.8 } }),
      noteRow('hi', { instrumentId: 'bass', pitch: 'G', octave: 4, hits: { 4: 0.8 } }),
    ],
  };
  const [group] = buildStaffGroups(pattern, { stepCount: 16, instrumentLabel: () => 'bass' });
  const layout = layoutStaffGroup(group);
  // C2..G4 spans 18 diatonic steps → 18 * 5px + 24px padding.
  assert.equal(layout.height, 114);
  assert.equal(layout.ledgers.length, 4); // two above the staff, two below
  const c2 = layout.notes.find((note) => note.pitch === 'C' && note.octave === 2);
  assert.equal(c2.y, 102);
  assert.deepEqual(
    [...new Set(layout.ledgers.map((ledger) => ledger.x))].sort((a, b) => a - b),
    [staffStepX(0), staffStepX(4)],
  );
});

test('percussion rows are a single line with one mark per hit', () => {
  const groups = buildStaffGroups({ channels: [drumRow('p1', 'kick', { 0: 0.9, 6: 0.4 })] }, { stepCount: 16 });
  const layout = layoutStaffGroup(groups[0]);
  assert.equal(layout.lines.length, 1);
  assert.equal(layout.height, 38);
  assert.equal(layout.notes.length, 2);
  assert.equal(layout.ledgers.length, 0);
  assert.equal(layout.notes[0].y, 19);
  assert.equal(layout.notes[0].x, staffStepX(0));
  assert.equal(layout.notes[1].x, staffStepX(6));
});

test('staff head pill shows the written range or a hit count', () => {
  const wide = buildStaffGroups({
    channels: [
      noteRow('a', { instrumentId: 'grand', pitch: 'C', octave: 4, hits: { 0: 0.8 } }),
      noteRow('b', { instrumentId: 'grand', pitch: 'G', octave: 4, hits: { 4: 0.8 } }),
    ],
  }, { stepCount: 16 });
  assert.equal(staffRangeLabel(wide[0]), 'C4–G4');

  const single = buildStaffGroups({
    channels: [noteRow('a', { instrumentId: 'grand', pitch: 'A', octave: 3, hits: { 2: 0.8 } })],
  }, { stepCount: 16 });
  assert.equal(staffRangeLabel(single[0]), 'A3');

  const drums = buildStaffGroups({ channels: [drumRow('p1', 'kick', { 0: 0.9, 4: 0.9 })] }, { stepCount: 16 });
  assert.equal(staffRangeLabel(drums[0]), '2 hits');
  assert.equal(staffRangeLabel({ kind: 'percussion', noteCount: 1 }), '1 hit');
  assert.equal(staffRangeLabel(null), '');
});
