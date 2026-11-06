import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNT_IN_BARS,
  METRONOME_PREFS_KEY,
  beatInfoForStep,
  countInClickPlan,
  countInSeconds,
  normalizeMetronomePrefs,
  secondsPerBeat,
} from '../src/sequencer/metronome.js';
import { STEPS_PER_BEAT } from '../src/sequencer/pattern.js';

test('metronome pref defaults to audible and survives garbage', () => {
  assert.equal(METRONOME_PREFS_KEY, 'magicbeatz-metronome-v1');
  assert.deepEqual(normalizeMetronomePrefs(null), { enabled: true });
  assert.deepEqual(normalizeMetronomePrefs('nope'), { enabled: true });
  assert.deepEqual(normalizeMetronomePrefs({ enabled: false }), { enabled: false });
  assert.deepEqual(normalizeMetronomePrefs({ enabled: 0 }), { enabled: true });
});

test('beat info lands one light per beat with an accented downbeat', () => {
  assert.deepEqual(beatInfoForStep(0, 4), { isBeat: true, beatIndex: 0, isAccent: true });
  assert.deepEqual(beatInfoForStep(STEPS_PER_BEAT, 4), { isBeat: true, beatIndex: 1, isAccent: false });
  assert.deepEqual(beatInfoForStep(STEPS_PER_BEAT * 3, 4), { isBeat: true, beatIndex: 3, isAccent: false });
  // 16ths inside a beat never light up.
  assert.deepEqual(beatInfoForStep(5, 4), { isBeat: false, beatIndex: 1, isAccent: false });
  assert.equal(beatInfoForStep(7, 4).isBeat, false);
  // 6/8 has six lights; the bar wraps back onto the accent at step 24.
  assert.deepEqual(beatInfoForStep(STEPS_PER_BEAT * 5, 6), { isBeat: true, beatIndex: 5, isAccent: false });
  assert.deepEqual(beatInfoForStep(STEPS_PER_BEAT * 6, 6), { isBeat: true, beatIndex: 0, isAccent: true });
  // Defensive: negative or junk input stays on beat 1.
  assert.deepEqual(beatInfoForStep(-4, 4), { isBeat: true, beatIndex: 0, isAccent: true });
  assert.deepEqual(beatInfoForStep(undefined, 4), { isBeat: true, beatIndex: 0, isAccent: true });
});

test('count-in is one bar of the signature and follows the tempo', () => {
  assert.equal(COUNT_IN_BARS, 1);
  assert.equal(secondsPerBeat(120), 0.5);
  assert.equal(secondsPerBeat(0), 0.5); // invalid tempo falls back to 120
  assert.equal(countInSeconds(120, 4), 2);
  assert.equal(countInSeconds(120, 3), 1.5);
  assert.equal(countInSeconds(120, 6), 3);
  assert.equal(countInSeconds(60, 4), 4);
});

test('count-in click plan puts one click on every beat, accent on beat 1', () => {
  const plan = countInClickPlan(10, 120, 4);
  assert.equal(plan.length, 4);
  assert.deepEqual(plan.map((c) => c.when), [10, 10.5, 11, 11.5]);
  assert.deepEqual(plan.map((c) => c.beatIndex), [0, 1, 2, 3]);
  assert.deepEqual(plan.map((c) => c.accent), [true, false, false, false]);

  const sixEight = countInClickPlan(0, 120, 6);
  assert.equal(sixEight.length, 6);
  assert.equal(sixEight[5].when, 2.5);

  // 3/4: three clicks, last one exactly one count-in length after the start.
  const waltz = countInClickPlan(4, 120, 3);
  assert.equal(waltz.length, 3);
  assert.equal(waltz[waltz.length - 1].when + secondsPerBeat(120), 4 + countInSeconds(120, 3));
});

test('count-in plan spans several bars with an accent on each bar', () => {
  const plan = countInClickPlan(0, 120, 4, 2);
  assert.equal(plan.length, 8);
  assert.deepEqual(
    plan.filter((c) => c.accent).map((c) => c.when),
    [0, 2],
  );
  assert.equal(plan[4].beatIndex, 0);
});
