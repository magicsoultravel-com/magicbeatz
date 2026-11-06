/**
 * End-to-end data flows used by the grid UI (capture, step editor, tidy).
 *
 * These mirror the console's call sequences with plain data so the UI paths are
 * covered without a DOM: the console only turns these rows into buttons.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CAPTURE_TRACKS, captureColumnSnapshot, channelMidi, columnNotes,
  ensurePitchRow, insertPitchRow, midiNote, moveColumn, pasteColumnSnapshot,
  planCapture, pruneEmptyNoteRows, secondsPerStep,
} from '../src/sequencer/notes.js';
import { createChannel, createEmptyPattern, DEFAULT_VELOCITY } from '../src/sequencer/pattern.js';

const clip = () => {
  const pat = createEmptyPattern({ name: 'Pattern 1', bars: 1 });
  pat.channels = []; // start from an empty grid, like "clear" leaves it
  return pat;
};

/** The console's `ensureKeyRow`: reuse the pitch row, or insert one by name. */
function keyRow(pat, note) {
  return ensurePitchRow(pat, note, { len: 16, name: note.instrumentId });
}

/** The console's `ensureDrumRow` without the pad-kit lookup. */
function drumRow(pat, voiceId, kitId = 'acoustic') {
  const existing = pat.channels.find((c) => c.type === 'percussion' && c.voiceId === voiceId);
  if (existing) {
    existing.kitId = kitId;
    return { channel: existing, created: false };
  }
  const channel = createChannel({
    type: 'percussion', voiceId, kitId, name: voiceId,
    steps: Array.from({ length: 16 }, () => null),
  });
  pat.channels.push(channel);
  return { channel, created: true };
}

/** The console's `commitCapture`. */
function commit(pat, hits, { originTime = 10, bpm = 120 } = {}) {
  const stepSeconds = secondsPerStep(bpm);
  for (const { hit, stepIndex } of planCapture(hits, { originTime, stepSeconds, stepCount: 16 })) {
    const target = hit.kind === 'pad' ? drumRow(pat, hit.voiceId) : keyRow(pat, hit);
    target.channel.steps[stepIndex] = { velocity: hit.velocity ?? DEFAULT_VELOCITY };
  }
}

/** The console's `transposeColumn` (including the emptied-row clean-up). */
function transposeColumn(pat, stepIndex, semis) {
  const moves = [];
  for (const ch of pat.channels) {
    if (ch.type !== 'note' || !ch.steps?.[stepIndex]) continue;
    const target = midiNote((channelMidi(ch) ?? 60) + semis);
    moves.push({ ch, target, velocity: ch.steps[stepIndex].velocity });
  }
  for (const move of moves) move.ch.steps[stepIndex] = null;
  for (const move of moves) {
    keyRow(pat, { instrumentId: move.ch.instrumentId, ...move.target })
      .channel.steps[stepIndex] = { velocity: move.velocity };
  }
  for (const move of moves) {
    if (move.ch.steps.some(Boolean)) continue;
    const index = pat.channels.indexOf(move.ch);
    if (index >= 0) pat.channels.splice(index, 1);
  }
  return moves.length;
}

/** Toggle one pitch into a column, like the mini keyboard does. */
function toggle(pat, stepIndex, instrumentId, pitch, octave, velocity = 0.8) {
  const res = keyRow(pat, { instrumentId, pitch, octave });
  if (res.channel.steps[stepIndex]) {
    res.channel.steps[stepIndex] = null;
    return res;
  }
  res.channel.steps[stepIndex] = { velocity };
  return res;
}

test('a recorded chord lands as one column of pitch rows', () => {
  const pat = clip();
  const sps = secondsPerStep(120);
  commit(pat, [
    { kind: 'key', instrumentId: 'rhodes', pitch: 'C', octave: 4, velocity: 0.8, t: 10 },
    { kind: 'key', instrumentId: 'rhodes', pitch: 'E', octave: 4, velocity: 0.7, t: 10 + sps * 0.1 },
    { kind: 'key', instrumentId: 'rhodes', pitch: 'G', octave: 4, velocity: 0.6, t: 10 + sps * 0.1 },
  ]);
  assert.equal(pat.channels.length, 3);
  assert.deepEqual(
    pat.channels.map((c) => `${c.pitch}${c.octave}`),
    ['G4', 'E4', 'C4'], // highest first, like a piano roll
  );
  assert.deepEqual(pat.channels.map((c) => c.steps[0]?.velocity), [0.6, 0.7, 0.8]);
  assert.equal(columnNotes(pat, 0).length, 3);
  assert.equal(columnNotes(pat, 1).length, 0);
});

test('a second take overdubs its own steps and reuses rows', () => {
  const pat = clip();
  const sps = secondsPerStep(120);
  commit(pat, [{ kind: 'key', instrumentId: 'rhodes', pitch: 'C', octave: 4, t: 10 }]);
  commit(pat, [{ kind: 'key', instrumentId: 'rhodes', pitch: 'C', octave: 4, velocity: 0.3, t: 10 + 4 * sps }]);
  assert.equal(pat.channels.length, 1, 'same pitch reuses its row');
  assert.equal(pat.channels[0].steps[0].velocity, DEFAULT_VELOCITY);
  assert.equal(pat.channels[0].steps[4].velocity, 0.3);

  // Another instrument on the same pitch gets its own row, after the block.
  commit(pat, [{ kind: 'key', instrumentId: 'wurli', pitch: 'C', octave: 4, t: 10 }]);
  assert.deepEqual(pat.channels.map((c) => c.instrumentId), ['rhodes', 'wurli']);
});

test('drum hits reuse their voice row instead of stacking', () => {
  const pat = clip();
  const sps = secondsPerStep(120);
  commit(pat, [
    { kind: 'pad', voiceId: 'kick', t: 10 },
    { kind: 'pad', voiceId: 'hat', t: 10 + sps },
    { kind: 'pad', voiceId: 'kick', t: 10 + 2 * sps },
  ]);
  assert.equal(pat.channels.length, 2);
  assert.equal(pat.channels[0].voiceId, 'kick');
  assert.ok(pat.channels[0].steps[0] && pat.channels[0].steps[2]);
  assert.ok(pat.channels[1].steps[1]);
});

test('capture stops creating rows at the row cap', () => {
  const pat = clip();
  for (let i = 0; i < MAX_CAPTURE_TRACKS; i += 1) {
    keyRow(pat, { instrumentId: 'rhodes', ...midiNote(48 + i) });
  }
  assert.equal(pat.channels.length, MAX_CAPTURE_TRACKS);
  const blocked = keyRow(pat, { instrumentId: 'rhodes', ...midiNote(90) });
  assert.equal(blocked.channel, null);
  assert.equal(blocked.blocked, true);
  assert.equal(pat.channels.length, MAX_CAPTURE_TRACKS);
});


test('the step editor writes, transposes and copies columns', () => {
  const pat = clip();
  for (const pitch of ['C', 'E', 'G']) toggle(pat, 4, 'rhodes', pitch, 4);
  assert.equal(columnNotes(pat, 4).length, 3);

  // +12 then -12 must reuse the same three rows, not pile up octaves.
  assert.equal(transposeColumn(pat, 4, 12), 3);
  assert.deepEqual(pat.channels.map((c) => `${c.pitch}${c.octave}`), ['G5', 'E5', 'C5']);
  assert.equal(pat.channels.length, 3);
  assert.equal(transposeColumn(pat, 4, -12), 3);
  assert.deepEqual(pat.channels.map((c) => `${c.pitch}${c.octave}`), ['G4', 'E4', 'C4']);
  assert.equal(pat.channels.length, 3);

  const snap = captureColumnSnapshot(pat, 4);
  assert.equal(snap.length, 3);
  assert.equal(pasteColumnSnapshot(pat, 8, snap, { len: 16 }), 3);
  assert.equal(columnNotes(pat, 8).length, 3, 'paste created no new rows');
  assert.equal(pat.channels.length, 3);

  // Toggling the same key twice removes it again.
  toggle(pat, 4, 'rhodes', 'C', 4);
  assert.equal(columnNotes(pat, 4).length, 2);
});

test('tidy drops only empty note rows and keeps drum rows', () => {
  const pat = clip();
  keyRow(pat, { instrumentId: 'rhodes', pitch: 'C', octave: 4 }).channel.steps[0] = { velocity: 0.8 };
  keyRow(pat, { instrumentId: 'rhodes', pitch: 'D', octave: 4 }); // never used
  drumRow(pat, 'kick'); // an empty drum row must survive
  assert.equal(pat.channels.length, 3);
  assert.equal(pruneEmptyNoteRows(pat), 1);
  assert.deepEqual(pat.channels.map((c) => c.type), ['note', 'percussion']);
  assert.equal(pruneEmptyNoteRows(pat), 0);
});

test('moving a captured chord column keeps every row together', () => {
  const pat = clip();
  for (const pitch of ['C', 'E', 'G']) toggle(pat, 0, 'rhodes', pitch, 4);
  assert.equal(moveColumn(pat, 0, 6), true);
  assert.equal(columnNotes(pat, 0).length, 0);
  assert.equal(columnNotes(pat, 6).length, 3);
});

test('a new pitch row is inserted inside its own instrument block', () => {
  const pat = clip();
  drumRow(pat, 'kick');
  keyRow(pat, { instrumentId: 'rhodes', pitch: 'C', octave: 4 });
  drumRow(pat, 'snare');
  insertPitchRow(pat, createChannel({
    type: 'note',
    instrumentId: 'wurli',
    pitch: 'C',
    octave: 2,
    steps: Array.from({ length: 16 }, () => null),
  }));
  assert.deepEqual(
    pat.channels.map((c) => `${c.type}:${c.voiceId || c.instrumentId}`),
    ['percussion:kick', 'note:rhodes', 'percussion:snare', 'note:wurli'],
  );
});
