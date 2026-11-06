import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CAPTURE_TRACKS,
  applyCaptureHits,
  captureColumnSnapshot,
  channelMidi,
  columnNotes,
  ensurePitchRow,
  expandChordPadHit,
  findPitchRow,
  insertPitchRow,
  midiNote,
  moveColumn,
  moveStep,
  noteMidi,
  padPerformNotes,
  pasteColumnSnapshot,
  pitchLabel,
  planCapture,
  pruneEmptyNoteRows,
  quantizeStepIndex,
  recordGroupKey,
  restoreTake,
  rowMatchesNote,
  secondsPerStep,
  snapshotTake,
  splitCaptureBuffer,
} from '../src/sequencer/notes.js';
import { createChannel } from '../src/sequencer/pattern.js';

/** Minimal pattern double: pitch rows in the order they were inserted. */
function makePattern(channels = [], len = 16) {
  return {
    channels: channels.map((ch) => createChannel({
      steps: Array.from({ length: len }, () => null),
      ...ch,
    })),
  };
}

function pitchRow(pitch, octave, extra = {}) {
  return { type: 'note', instrumentId: 'rhodes', pitch, octave, name: 'rhodes', ...extra };
}

test('pitch labels and MIDI maths stay in sync with the keys UI', () => {
  assert.equal(pitchLabel('C', 4), 'C4');
  assert.equal(pitchLabel(), 'C4');
  assert.equal(noteMidi({ pitch: 'A', octave: 4 }), 69);
  assert.equal(noteMidi({ pitch: 'C', octave: 4 }), 60);
  assert.equal(noteMidi({ pitch: 'A', octave: 3 }), 57);
  assert.equal(noteMidi(null), null);
  assert.deepEqual(midiNote(69), { pitch: 'A', octave: 4 });
  assert.deepEqual(midiNote(60), { pitch: 'C', octave: 4 });
  assert.equal(channelMidi({ pitch: 'G', octave: 5 }), 79);
});

test('rows are identified by instrument + pitch + octave, never by instrument alone', () => {
  const row = createChannel(pitchRow('C', 4));
  assert.equal(rowMatchesNote(row, { instrumentId: 'rhodes', pitch: 'C', octave: 4 }), true);
  assert.equal(rowMatchesNote(row, { instrumentId: 'rhodes', pitch: 'C', octave: 5 }), false);
  assert.equal(rowMatchesNote(row, { instrumentId: 'rhodes', pitch: 'D', octave: 4 }), false);
  assert.equal(rowMatchesNote(row, { instrumentId: 'wurli', pitch: 'C', octave: 4 }), false);
  // Drum and chord rows are never pitch targets.
  const drum = createChannel({ type: 'percussion', voiceId: 'kick' });
  assert.equal(rowMatchesNote(drum, { instrumentId: '', pitch: 'C', octave: 4 }), false);
});

test('ensurePitchRow reuses the existing row and only creates once', () => {
  const pat = makePattern([], 8);
  const first = ensurePitchRow(pat, { instrumentId: 'rhodes', pitch: 'E', octave: 4 }, { len: 8 });
  assert.equal(first.created, true);
  assert.equal(first.blocked, false);
  assert.equal(pat.channels.length, 1);
  assert.equal(first.channel.steps.length, 8);
  assert.equal(first.channel.type, 'note');
  assert.equal(first.channel.instrumentId, 'rhodes');
  assert.equal(first.channel.pitch, 'E');
  assert.equal(first.channel.octave, 4);

  const again = ensurePitchRow(pat, { instrumentId: 'rhodes', pitch: 'E', octave: 4 }, { len: 8 });
  assert.equal(again.created, false);
  assert.equal(again.channel, first.channel);
  assert.equal(pat.channels.length, 1);
  assert.equal(findPitchRow(pat, { instrumentId: 'rhodes', pitch: 'E', octave: 4 }), first.channel);
  assert.equal(findPitchRow(pat, { instrumentId: 'rhodes', pitch: 'F', octave: 4 }), null);
});

test('ensurePitchRow needs an instrument and respects the track cap', () => {
  const pat = makePattern([], 4);
  assert.deepEqual(ensurePitchRow(pat, { pitch: 'C', octave: 4 }), {
    channel: null, created: false, blocked: false,
  });
  const full = makePattern(
    Array.from({ length: MAX_CAPTURE_TRACKS }, (_, i) => pitchRow('C', 1 + (i % 4))),
    4,
  );
  const res = ensurePitchRow(full, { instrumentId: 'rhodes', pitch: 'A', octave: 6 }, { len: 4 });
  assert.equal(res.channel, null);
  assert.equal(res.blocked, true);
  assert.equal(full.channels.length, MAX_CAPTURE_TRACKS);
});

test('pitch rows sort into their instrument block, highest note first', () => {
  const pat = makePattern([
    { type: 'percussion', voiceId: 'kick', name: 'kick' },
    pitchRow('C', 4),
    { type: 'chord', instrumentId: 'keys-pluck', chordName: 'C', name: 'chords' },
  ], 4);
  insertPitchRow(pat, createChannel(pitchRow('G', 4)));
  insertPitchRow(pat, createChannel(pitchRow('E', 4)));
  insertPitchRow(pat, createChannel(pitchRow('C', 5)));
  const names = pat.channels.map((ch) => (ch.type === 'note' ? `${ch.pitch}${ch.octave}` : ch.type));
  // Recording C-E-G ascending leaves the chord stacked high→low, drums untouched.
  assert.deepEqual(names, ['percussion', 'C5', 'G4', 'E4', 'C4', 'chord']);
});

test('a second instrument gets its own contiguous block', () => {
  const pat = makePattern([pitchRow('C', 4)], 4);
  insertPitchRow(pat, createChannel({ ...pitchRow('A', 4), instrumentId: 'wurli' }));
  insertPitchRow(pat, createChannel(pitchRow('D', 4)));
  assert.deepEqual(
    pat.channels.map((ch) => `${ch.instrumentId}:${ch.pitch}${ch.octave}`),
    // D4 sorts above C4 inside the same instrument block; the second instrument
    // starts its own block after it.
    ['rhodes:D4', 'rhodes:C4', 'wurli:A4'],
  );
});

test('quantize snaps to the nearest 16th, locks to the origin and wraps', () => {
  const step = 0.125; // 16th at 120 bpm
  assert.equal(secondsPerStep(120), step);
  assert.equal(quantizeStepIndex(0, 0, step, 16), 0);
  assert.equal(quantizeStepIndex(0.06, 0, step, 16), 0); // slightly late is still step 0
  assert.equal(quantizeStepIndex(0.07, 0, step, 16), 1); // past the midpoint
  assert.equal(quantizeStepIndex(1.0, 0, step, 16), 8);
  assert.equal(quantizeStepIndex(2.0, 0, step, 16), 0); // one bar later wraps
  assert.equal(quantizeStepIndex(2.06, 0, step, 16), 0);
  assert.equal(quantizeStepIndex(0.5, 0.5, step, 16), 0); // origin-relative
  // A hit scheduled just before a pass boundary belongs to the last step of the
  // pass it was played in (the perform clock schedules ~100 ms ahead), so
  // negative offsets wrap backwards instead of clamping onto step 0.
  assert.equal(quantizeStepIndex(0.38, 0.5, step, 16), 15);
  assert.equal(quantizeStepIndex(0.25, 0.5, step, 16), 14);
  assert.equal(quantizeStepIndex(-0.125, 0, step, 16), 15); // one step before the origin
  assert.equal(quantizeStepIndex(Number.NaN, 0, step, 16), 0);
  // 6/8 bar = 24 steps: step 24 lands back on the downbeat.
  assert.equal(quantizeStepIndex(3.0, 0, step, 24), 0);
  assert.equal(quantizeStepIndex(2.875, 0, step, 24), 23);
});

test('planCapture pairs every hit with its step and skips junk', () => {
  const plan = planCapture(
    [{ t: 0, kind: 'key', pitch: 'C' }, { t: 0.13, kind: 'key', pitch: 'E' }, null, { kind: 'key' }],
    { originTime: 0, stepSeconds: 0.125, stepCount: 16 },
  );
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((p) => p.stepIndex), [0, 1]);
  assert.equal(plan[1].hit.pitch, 'E');
  assert.deepEqual(planCapture(null), []);
});

test('columnNotes reads the whole column, low to high, respecting mute and solo', () => {
  const pat = makePattern([pitchRow('C', 4), pitchRow('E', 4), pitchRow('G', 4)], 4);
  for (const ch of pat.channels) ch.steps[1] = { velocity: 0.8 };
  const notes = columnNotes(pat, 1);
  assert.deepEqual(notes.map((n) => `${n.pitch}${n.octave}`), ['C4', 'E4', 'G4']);
  assert.equal(notes[0].instrumentId, 'rhodes');
  assert.equal(columnNotes(pat, 0).length, 0);

  pat.channels[1].mute = true;
  assert.deepEqual(columnNotes(pat, 1).map((n) => n.pitch), ['C', 'G']);

  pat.channels[1].mute = false;
  pat.channels[2].solo = true;
  assert.deepEqual(columnNotes(pat, 1).map((n) => n.pitch), ['G']);
});

test('columnNotes folds chord rows into the sounding notes', () => {
  const pat = makePattern([
    pitchRow('C', 4),
    { type: 'chord', instrumentId: 'keys-pluck', chordName: 'Am', chordMode: 'named', name: 'chords' },
  ], 4);
  pat.channels[0].steps[0] = { velocity: 0.8 };
  pat.channels[1].steps[0] = { velocity: 0.8 };
  const notes = columnNotes(pat, 0);
  assert.equal(notes.length, 4); // C4 pitch row + the A minor triad
  assert.deepEqual([...new Set(notes.map((n) => n.pitch))].sort(), ['A', 'C', 'E']);
  const midis = notes.map((n) => noteMidi(n));
  assert.deepEqual(midis, [...midis].sort((a, b) => a - b)); // low → high
});

test('moveStep moves a hit and swaps when the destination is taken', () => {
  const pat = makePattern([pitchRow('C', 4)], 4);
  const id = pat.channels[0].id;
  pat.channels[0].steps[0] = { velocity: 0.4 };
  assert.equal(moveStep(pat, { channelId: id, stepIndex: 0 }, { channelId: id, stepIndex: 2 }), true);
  assert.equal(pat.channels[0].steps[0], null);
  assert.deepEqual(pat.channels[0].steps[2], { velocity: 0.4 });

  pat.channels[0].steps[1] = { velocity: 0.9 };
  moveStep(pat, { channelId: id, stepIndex: 2 }, { channelId: id, stepIndex: 1 });
  assert.deepEqual(pat.channels[0].steps[1], { velocity: 0.4 });
  assert.deepEqual(pat.channels[0].steps[2], { velocity: 0.9 });

  // Nothing to move, cross-row drags and no-op drags are rejected.
  assert.equal(moveStep(pat, { channelId: id, stepIndex: 3 }, { channelId: id, stepIndex: 0 }), false);
  assert.equal(moveStep(pat, { channelId: id, stepIndex: 1 }, { channelId: 'other', stepIndex: 0 }), false);
  assert.equal(moveStep(pat, { channelId: id, stepIndex: 1 }, { channelId: id, stepIndex: 1 }), false);
});

test('moveColumn shifts the whole chord across every row', () => {
  const pat = makePattern([pitchRow('C', 4), pitchRow('E', 4)], 4);
  pat.channels[0].steps[0] = { velocity: 0.8 };
  pat.channels[1].steps[0] = { velocity: 0.6 };
  assert.equal(moveColumn(pat, 0, 2), true);
  assert.equal(pat.channels[0].steps[0], null);
  assert.deepEqual(pat.channels[1].steps[2], { velocity: 0.6 });

  // Swapping into an occupied column keeps both hits.
  pat.channels[0].steps[1] = { velocity: 0.5 };
  moveColumn(pat, 2, 1);
  assert.deepEqual(pat.channels[0].steps[1], { velocity: 0.8 }); // the moved chord
  assert.deepEqual(pat.channels[0].steps[2], { velocity: 0.5 }); // the displaced hit
  assert.deepEqual(pat.channels[1].steps[1], { velocity: 0.6 });
  assert.deepEqual(pat.channels[1].steps[2], null);
  assert.equal(moveColumn(pat, 1, 1), false);
});

test('empty instrument rows can be pruned, drums and chords stay', () => {
  const pat = makePattern([
    { type: 'percussion', voiceId: 'kick', name: 'kick' },
    { type: 'chord', instrumentId: 'keys-pluck', chordName: 'C', name: 'chords' },
    pitchRow('C', 4),
    pitchRow('D', 4),
  ], 4);
  pat.channels[2].steps[0] = { velocity: 0.8 };
  assert.equal(pruneEmptyNoteRows(pat), 1);
  assert.deepEqual(pat.channels.map((ch) => ch.type), ['percussion', 'chord', 'note']);
  assert.equal(pruneEmptyNoteRows(pat), 0);
});

test('column snapshots copy between columns and create rows on paste', () => {
  const src = makePattern([pitchRow('C', 4), pitchRow('G', 4)], 4);
  src.channels[0].steps[0] = { velocity: 0.5 };
  src.channels[1].steps[0] = { velocity: 0.7 };
  const snap = captureColumnSnapshot(src, 0);
  assert.deepEqual(snap.map((n) => `${n.pitch}${n.octave}`), ['C4', 'G4']);
  assert.deepEqual(snap.map((n) => n.velocity), [0.5, 0.7]);

  const dst = makePattern([], 4);
  assert.equal(pasteColumnSnapshot(dst, 2, snap, { len: 4 }), 2);
  assert.equal(dst.channels.length, 2);
  const byPitch = new Map(dst.channels.map((ch) => [`${ch.pitch}${ch.octave}`, ch]));
  assert.deepEqual(byPitch.get('C4').steps[2], { velocity: 0.5 });
  assert.deepEqual(byPitch.get('G4').steps[2], { velocity: 0.7 });
  assert.equal(byPitch.get('C4').steps[0], null);
  assert.deepEqual(pasteColumnSnapshot(dst, 2, null), 0);
});

test('a take is split at the pass boundary so the loop can commit each pass', () => {
  const hits = [
    { t: 1.0, kind: 'key', pitch: 'C', instrumentId: 'rhodes' },
    { t: 1.9, kind: 'key', pitch: 'E', instrumentId: 'rhodes' },
    { t: 2.05, kind: 'key', pitch: 'G', instrumentId: 'rhodes' }, // already scheduled for the next pass
    { kind: 'key', pitch: 'B' }, // junk without a timestamp still drains
  ];
  const { ready, pending } = splitCaptureBuffer(hits, 2.0);
  assert.deepEqual(ready.map((h) => h.pitch), ['C', 'E', 'B']);
  assert.deepEqual(pending.map((h) => h.pitch), ['G']);
  const all = splitCaptureBuffer(hits);
  assert.equal(all.ready.length, 4);
  assert.equal(all.pending.length, 0);
  assert.deepEqual(splitCaptureBuffer(null), { ready: [], pending: [] });
});

/** ensure callbacks for applyCaptureHits, without the console's DOM side. */
function captureWriters(pat, len = 16) {
  return {
    ensureKey: (note) => ensurePitchRow(pat, note, { len }),
    ensureDrum: (hit) => {
      const voiceId = hit.entry?.voiceId || 'kick';
      const found = pat.channels.find((c) => c.type === 'percussion' && c.voiceId === voiceId);
      if (found) return { channel: found, created: false, blocked: false };
      const channel = createChannel({
        type: 'percussion',
        voiceId,
        kitId: hit.entry?.kitId || 'kit',
        steps: Array.from({ length: len }, () => null),
      });
      pat.channels.push(channel);
      return { channel, created: true, blocked: false };
    },
  };
}

const keyHit = (t, pitch, extra = {}) => ({
  t, kind: 'key', pitch, octave: 4, instrumentId: 'rhodes', velocity: 0.8, ...extra,
});
const padHit = (t, entry) => ({ t, kind: 'pad', bank: 'A', pad: 1, entry, velocity: 0.7 });

test('overdub merges passes while replace rewrites the steps it re-plays', () => {
  const pat = makePattern([], 16);
  const base = { originTime: 0, stepSeconds: 0.125, stepCount: 16, ...captureWriters(pat) };

  // Pass 1: a C+E dyad on step 8.
  applyCaptureHits(pat, [keyHit(1.0, 'C'), keyHit(1.0, 'E', { velocity: 0.7 })], base);
  assert.equal(pat.channels.length, 2);
  assert.deepEqual(columnNotes(pat, 8).map((n) => n.pitch), ['C', 'E']);

  // Pass 2 in replace mode plays only G there: the stale C and E must go.
  const res = applyCaptureHits(pat, [keyHit(3.0, 'G')], { ...base, originTime: 2.0, mode: 'replace' });
  assert.equal(res.cleared, 2);
  assert.deepEqual(columnNotes(pat, 8).map((n) => n.pitch), ['G']);
  assert.equal(pat.channels.length, 3, 'rows stay until tidy, no row churn');

  // Pass 3 in overdub mode adds D to the same step instead of replacing it.
  applyCaptureHits(pat, [keyHit(3.0, 'D')], { ...base, originTime: 2.0 });
  assert.deepEqual(columnNotes(pat, 8).map((n) => n.pitch), ['D', 'G']);
});

test('replace is per instrument group, so drums and keys never eat each other', () => {
  const pat = makePattern([], 16);
  const opts = {
    originTime: 0, stepSeconds: 0.125, stepCount: 16, mode: 'replace', ...captureWriters(pat),
  };
  applyCaptureHits(pat, [padHit(0, { target: 'drum', voiceId: 'kick' }), keyHit(0, 'C')], opts);
  assert.equal(pat.channels.length, 2);
  applyCaptureHits(pat, [keyHit(0, 'E')], opts);
  const kick = pat.channels.find((c) => c.type === 'percussion');
  assert.ok(kick.steps[0], 'the kick on step 0 survives a keys-only pass');
  assert.deepEqual(columnNotes(pat, 0).map((n) => n.pitch), ['E']);
});

test('chord pads expand to pitch rows and can feed repeat/arp', () => {
  const hit = { kind: 'pad', bank: 'B', pad: 3, velocity: 0.66, entry: { target: 'chord', instrumentId: 'keys-pluck' } };
  const triad = [{ pitch: 'C', octave: 4 }, { pitch: 'E', octave: 4 }, { pitch: 'G', octave: 4 }];
  const expanded = expandChordPadHit(hit, triad);
  assert.deepEqual(expanded.map((n) => `${n.pitch}${n.octave}`), ['C4', 'E4', 'G4']);
  assert.ok(expanded.every((n) => n.instrumentId === 'keys-pluck' && n.velocity === 0.66));
  assert.deepEqual(expandChordPadHit(hit, []), []);

  // Drum pads never feed the arp; note and chord pads do.
  assert.deepEqual(padPerformNotes({ target: 'drum', voiceId: 'kick' }, triad), []);
  assert.deepEqual(padPerformNotes({ target: 'note', instrumentId: 'wurli', pitch: 'A', octave: 3 }, []), [
    { instrumentId: 'wurli', pitch: 'A', octave: 3 },
  ]);
  assert.deepEqual(padPerformNotes({ target: 'chord', instrumentId: 'keys-pluck' }, triad).length, 3);
});

test('undo take restores the steps and drops the rows the take created', () => {
  const pat = makePattern([pitchRow('C', 4)], 4);
  pat.id = 'p1';
  pat.channels[0].steps[1] = { velocity: 0.5 };
  const snap = snapshotTake(pat);
  pat.channels[0].steps[1] = { velocity: 0.9 };
  ensurePitchRow(pat, { instrumentId: 'rhodes', pitch: 'G', octave: 4 }, { len: 4 }).channel.steps[2] = { velocity: 0.7 };
  assert.equal(pat.channels.length, 2);

  assert.deepEqual(restoreTake(pat, snap), { restored: true, removed: 1 });
  assert.equal(pat.channels.length, 1);
  assert.equal(pat.channels[0].steps[1].velocity, 0.5);
  assert.equal(pat.channels[0].steps[2], null);
  // A snapshot for another clip is refused instead of writing into the wrong clip.
  assert.deepEqual(restoreTake(pat, { ...snap, patternId: 'p2' }), { restored: false, removed: 0 });
  assert.deepEqual(restoreTake(pat, null), { restored: false, removed: 0 });
});

test('record groups keep instruments apart and fold all drums together', () => {
  assert.equal(recordGroupKey(createChannel(pitchRow('C', 4))), 'note:rhodes');
  assert.equal(recordGroupKey(createChannel(pitchRow('C', 4, { instrumentId: 'wurli' }))), 'note:wurli');
  assert.equal(recordGroupKey(createChannel({ type: 'percussion', voiceId: 'kick' })), 'percussion');
  assert.equal(recordGroupKey(createChannel({ type: 'chord', instrumentId: 'keys-pluck' })), '');
  assert.equal(recordGroupKey(null), '');
});

