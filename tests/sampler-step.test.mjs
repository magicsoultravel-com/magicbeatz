import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSampleStepEvent } from '../src/audio/sampler.js';
import { ARP_GATE, REPEAT_GATE, rateSeconds } from '../src/keys/perform.js';

const RATES = ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'];

test('a repeat step is a short gated note, not a held sample', () => {
  const step = rateSeconds('1/16', 120); // 125 ms
  const event = buildSampleStepEvent({
    midi: 60,
    velocity: 0.85,
    time: 2.5,
    gateSec: step * REPEAT_GATE, // 75 ms
    releaseSec: 0.02,
    seq: 3,
  });

  assert.equal(event.note, 60);
  assert.equal(event.velocity, 108); // 0.85 * 127
  assert.equal(event.time, 2.5); // scheduled on the audio clock, not "now"
  assert.ok(Math.abs(event.duration - 0.075) < 1e-9);
  // Short fade instead of smplr's 300 ms preset release.
  assert.equal(event.ampRelease, 0.02);
  assert.ok(event.duration + event.ampRelease < step);
  assert.equal(event.stopId, 'step:3');
});

test('each step gets its own stopId so a gate cannot cut a later step', () => {
  const ids = new Set();
  for (let seq = 1; seq <= 8; seq += 1) {
    ids.add(buildSampleStepEvent({ midi: 60, time: 1, gateSec: 0.05, releaseSec: 0.01, seq }).stopId);
  }
  assert.equal(ids.size, 8);
});

test('step events clamp silly values instead of scheduling silence', () => {
  const tiny = buildSampleStepEvent({ midi: 60, gateSec: 0, releaseSec: -1 });
  assert.equal(tiny.duration, 0.02);
  assert.equal(tiny.ampRelease, 0.005);
  assert.equal(tiny.velocity, 108); // default velocity
  assert.equal(tiny.time, undefined); // play immediately when no time is given

  const huge = buildSampleStepEvent({ midi: 60, gateSec: 99, releaseSec: 5, velocity: 3 });
  assert.equal(huge.duration, 8);
  assert.equal(huge.ampRelease, 0.2);
  assert.equal(huge.velocity, 127);
});

test('step tails fit inside the step at every rate and tempo', () => {
  for (const rate of RATES) {
    for (const bpm of [30, 120, 250]) {
      const step = rateSeconds(rate, bpm);
      for (const ratio of [REPEAT_GATE, ARP_GATE]) {
        const gate = step * ratio;
        const event = buildSampleStepEvent({
          midi: 60,
          gateSec: gate,
          releaseSec: Math.min(0.04, gate * 0.25),
        });
        assert.ok(
          event.duration + event.ampRelease <= step + 1e-9,
          `${rate} @ ${bpm} bpm overruns its step`,
        );
      }
    }
  }
});
