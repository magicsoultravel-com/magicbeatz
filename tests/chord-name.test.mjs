import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chordIntervalTable, chordLabel, nameChord } from '../src/theory/chords.js';

/** Helper: note stack from pitch-class letters, all in octave 4 unless given. */
const stack = (...names) => names.map((n) => ({ pitch: n.slice(0, -1), octave: Number(n.slice(-1)) }));

test('triads and sevenths are named from their sounding stack', () => {
  assert.deepEqual(nameChord(stack('C4', 'E4', 'G4')), { root: 'C', suffix: '' });
  assert.equal(chordLabel(stack('C4', 'E4', 'G4')), 'C');
  assert.equal(chordLabel(stack('C4', 'Eb4', 'G4')), 'Cm');
  assert.equal(chordLabel(stack('C4', 'E4', 'G4', 'B4')), 'Cmaj7');
  assert.equal(chordLabel(stack('C4', 'E4', 'G4', 'Bb4')), 'C7');
  assert.equal(chordLabel(stack('C4', 'Eb4', 'G4', 'Bb4')), 'Cm7');
  assert.equal(chordLabel(stack('C4', 'E4', 'G#4')), 'Caug');
  assert.equal(chordLabel(stack('C4', 'Eb4', 'Gb4')), 'Cdim');
  assert.equal(chordLabel(stack('C4', 'D4', 'G4')), 'Csus2');
  assert.equal(chordLabel(stack('C4', 'F4', 'G4')), 'Csus4');
  assert.equal(chordLabel(stack('C4', 'E4', 'G4', 'A4')), 'C6');
});

test('the bass note wins when two names fit the same stack', () => {
  // C-E-G-A is C6 over a C bass but Am7 over an A bass.
  assert.equal(chordLabel(stack('C4', 'E4', 'G4', 'A4')), 'C6');
  assert.equal(chordLabel(stack('A3', 'C4', 'E4', 'G4')), 'Am7');
  assert.equal(chordLabel(stack('E3', 'G3', 'B3')), 'Em');
  assert.equal(chordLabel(stack('A3', 'C4', 'E4')), 'Am');
});

test('inversions still name the chord, and octave doubling is irrelevant', () => {
  assert.equal(chordLabel(stack('E4', 'G4', 'C5')), 'C');
  assert.equal(chordLabel(stack('G3', 'C4', 'E4')), 'C');
  assert.equal(chordLabel(stack('C3', 'C4', 'E4', 'G4', 'C5')), 'C');
  assert.equal(chordLabel(stack('A3', 'C4', 'E4', 'G4', 'A4')), 'Am7');
});

test('unnameable stacks and thin stacks return nothing', () => {
  assert.equal(nameChord([]), null);
  assert.equal(nameChord(stack('C4')), null); // one note is not a chord
  assert.equal(nameChord(stack('C4', 'C5')), null); // same pitch class
  assert.equal(chordLabel(stack('C4', 'C#4', 'D4')), ''); // cluster, no exact match
  assert.equal(chordLabel(stack('C4', 'D4', 'E4', 'F#4', 'G#4')), '');
  assert.equal(nameChord(null), null);
});

test('theory data drives the table and the fallback fills the gaps', () => {
  const theory = {
    maj7: { short: 'Cmaj7', intervals: '0 4 7 11' },
    custom: { short: 'Cquartal', intervals: '0 5 10' },
  };
  const table = chordIntervalTable(theory);
  assert.equal(table.get('maj7'), '0 4 7 11');
  assert.equal(table.get('quartal'), '0 5 10');
  assert.equal(table.get('m7'), '0 3 7 10'); // fallback survives

  // A spread triad still resolves through the theory entry, and the caller has
  // to hand the data over — without it only the fallback names exist.
  assert.equal(chordLabel(stack('C4', 'F4', 'A#4'), theory), 'Cquartal');
  assert.equal(chordLabel(stack('C3', 'E3', 'G3', 'Bb3'), theory), 'C7');
});
