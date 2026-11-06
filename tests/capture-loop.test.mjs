import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCaptureHits,
  columnNotes,
  ensurePitchRow,
  restoreTake,
  snapshotTake,
  splitCaptureBuffer,
} from '../src/sequencer/notes.js';
import { createChannel } from '../src/sequencer/pattern.js';

/**
 * Console-shaped recording harness: a loop pass is [origin, origin + bar), the
 * transport commits at every wrap and the buffer keeps hits stamped beyond the
 * wrap (the perform clock schedules ~100 ms ahead).
 */
const STEP = 0.125; // 16th at 120 bpm
const BAR = 2.0; // 16 steps

function makeClip(len = 16) {
  return { id: 'p1', channels: [] };
}

function makeLoop(pat, len = 16) {
  const state = { buffer: [], origin: 0, mode: 'overdub' };
  const writers = {
    ensureKey: (note) => ensurePitchRow(pat, note, { len }),
    ensureDrum: (hit) => {
      const voiceId = hit.entry?.voiceId || 'kick';
      const found = pat.channels.find((c) => c.type === 'percussion' && c.voiceId === voiceId);
      if (found) return { channel: found, created: false, blocked: false };
      const channel = createChannel({
        type: 'percussion',
        voiceId,
        steps: Array.from({ length: len }, () => null),
      });
      pat.channels.push(channel);
      return { channel, created: true, blocked: false };
    },
  };
  return {
    state,
    /** A hit the player just made, stamped at the current audio time. */
    hit(t, pitch, extra = {}) {
      state.buffer.push({ t, kind: 'key', pitch, octave: 4, instrumentId: 'rhodes', velocity: 0.8, ...extra });
    },
    /** Transport wrap: commit what belongs to the pass that just ended. */
    wrap(when, engine) {
      const res = engine({ until: when });
      state.origin = when;
      return res;
    },
    commit(engine, opts) {
      return engine(opts);
    },
    engine: (opts = {}) => {
      const split = splitCaptureBuffer(state.buffer, opts.until ?? Infinity);
      state.buffer = split.pending;
      return applyCaptureHits(pat, split.ready, {
        originTime: state.origin,
        stepSeconds: STEP,
        stepCount: len,
        mode: state.mode,
        ...writers,
      });
    },
    /** The grid as the user reads it: step -> sorted pitches. */
    rows(stepIndex) {
      return columnNotes(pat, stepIndex).map((n) => n.pitch);
    },
  };
}

test('a two-pass take folds onto the grid instead of collapsing onto step 0', () => {
  const pat = makeClip();
  const loop = makeLoop(pat);

  // Pass 1 starts on the count-in downbeat: C on step 2, E on step 7.
  loop.hit(0.25, 'C');
  loop.hit(0.9, 'E');
  const first = loop.wrap(BAR, loop.engine);
  assert.equal(first.written, 2);
  assert.deepEqual(loop.rows(2), ['C']);
  assert.deepEqual(loop.rows(7), ['E']);

  // Pass 2: the player plays G on step 2 and A on step 7 again. A frozen origin
  // (or the old "clamp negatives to 0") used to fold every one of these onto
  // step 0; each hit has to land on the step it was played on.
  loop.hit(2.25, 'G');
  loop.hit(2.9, 'A');
  loop.wrap(BAR * 2, loop.engine);
  assert.deepEqual(loop.rows(2), ['C', 'G']);
  assert.deepEqual(loop.rows(7), ['E', 'A']);
  assert.deepEqual(loop.rows(0), []);
});

test('hits already scheduled for the next pass stay buffered across a wrap', () => {
  const pat = makeClip();
  const loop = makeLoop(pat);

  loop.hit(1.5, 'C'); // step 12 of pass 1
  loop.hit(2.02, 'D'); // 20 ms after the wrap: already scheduled, next pass step 0
  loop.wrap(BAR, loop.engine);
  assert.deepEqual(loop.rows(12), ['C']);
  assert.deepEqual(loop.rows(0), [], 'not written yet — it belongs to the next pass');
  assert.equal(loop.state.buffer.length, 1);

  loop.wrap(BAR * 2, loop.engine);
  assert.deepEqual(loop.rows(0), ['D']);
  assert.equal(loop.state.buffer.length, 0);
});

test('a hit near the wrap snaps to the nearest boundary, never a bar away', () => {
  const early = makeLoop(makeClip());
  early.hit(1.88, 'C'); // 0.12 s before the boundary → nearest step is 15
  early.wrap(BAR, early.engine);
  assert.deepEqual(early.rows(15), ['C']);
  assert.deepEqual(early.rows(0), []);

  const late = makeLoop(makeClip());
  late.hit(1.96, 'D'); // 0.04 s before the boundary → the downbeat is nearer
  late.wrap(BAR, late.engine);
  assert.deepEqual(late.rows(0), ['D']);
  assert.deepEqual(late.rows(15), []);
});

test('a hit stamped before the pass origin stays on its own step', () => {
  // Arming mid-play hands over the origin of the running loop, so a hit can be
  // stamped slightly *before* it. It belongs to the last steps of the pass, not
  // to step 0 (the old clamp folded every early hit onto the downbeat).
  const loop = makeLoop(makeClip());
  loop.state.origin = BAR;
  loop.hit(BAR - 0.25, 'C'); // two 16ths before the origin → step 14
  loop.engine();
  assert.deepEqual(loop.rows(14), ['C']);
  assert.deepEqual(loop.rows(0), []);
});

test('replace mode fixes a replayed bar mid-loop and leaves the rest alone', () => {
  const pat = makeClip();
  const loop = makeLoop(pat);

  // Pass 1: a C+E dyad on step 4 and a G on step 10.
  loop.hit(0.5, 'C');
  loop.hit(0.5, 'E');
  loop.hit(1.25, 'G');
  loop.wrap(BAR, loop.engine);

  // Pass 2 replays step 4 as A only: replace drops C and E there, G survives.
  loop.state.mode = 'replace';
  loop.hit(2.5, 'A');
  const second = loop.wrap(BAR * 2, loop.engine);
  assert.equal(second.cleared, 2);
  assert.deepEqual(loop.rows(4), ['A']);
  assert.deepEqual(loop.rows(10), ['G']);
});

test('a mid-loop take can be rolled back to how the clip looked when armed', () => {
  const pat = makeClip();
  pat.channels.push(createChannel({
    type: 'note', instrumentId: 'rhodes', pitch: 'C', octave: 4, name: 'rhodes',
    steps: Array.from({ length: 16 }, () => null),
  }));
  pat.channels[0].steps[0] = { velocity: 0.5 };
  const loop = makeLoop(pat);
  const snap = snapshotTake(pat);

  loop.hit(0.25, 'C'); // fills the row that already existed
  loop.wrap(BAR, loop.engine);
  loop.hit(0.5, 'E'); // opens a new row
  loop.wrap(BAR * 2, loop.engine);
  assert.equal(pat.channels.length, 2);

  const res = restoreTake(pat, snap);
  assert.deepEqual(res, { restored: true, removed: 1 });
  assert.equal(pat.channels.length, 1);
  assert.deepEqual(pat.channels[0].steps[0], { velocity: 0.5 });
  assert.equal(pat.channels[0].steps[2], null);
});
