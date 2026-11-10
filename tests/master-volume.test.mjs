import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getMasterBus, peekMasterGain, peekMasterLevel, setMasterLevel,
} from '../src/audio/context.js';
import { getParam } from '../src/params/registry.js';
import { registerCoreParams } from '../src/params/coreParams.js';

/** Minimal AudioParam stub — setTargetAtTime lands immediately (no clock here). */
function fakeParam(value = 1) {
  return {
    value,
    targets: [],
    setTargetAtTime(v) { this.value = v; this.targets.push(v); },
  };
}

/** Minimal context: only what context.js touches before the FX chain exists. */
class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.destination = { name: 'destination' };
  }

  resume() {}

  createGain() {
    return { gain: fakeParam(1), connect() {}, disconnect() {} };
  }
}

test('master level stores pre-gesture and lands on the bus at build', () => {
  assert.equal(peekMasterLevel(), 1, 'factory default is unity');
  assert.equal(peekMasterGain(), null, 'no bus before the first gesture');

  assert.equal(setMasterLevel(0.4), 0.4);
  assert.equal(peekMasterLevel(), 0.4, 'stored before any AudioContext exists');
  assert.equal(peekMasterGain(), null, 'still no bus, level is only mirrored');

  globalThis.window = { AudioContext: FakeAudioContext, addEventListener() {} };
  const bus = getMasterBus();
  assert.equal(bus.gain.value, 0.4, 'first bus comes up at the stored level');
});

test('setMasterLevel ramps the live gain and clamps out-of-range input', () => {
  const bus = getMasterBus();
  setMasterLevel(0.25);
  assert.deepEqual(bus.gain.targets, [0.25], 'smoothed, not a hard jump');
  assert.equal(peekMasterLevel(), 0.25);
  assert.equal(peekMasterGain(), 0.25);

  setMasterLevel(9);
  assert.equal(peekMasterLevel(), 1);
  setMasterLevel(-1);
  assert.equal(peekMasterLevel(), 0);
});

test('master param descriptor reads/writes through the context hooks', () => {
  const written = [];
  const fakeProject = { swing: 0, bpm: 120 };
  registerCoreParams({
    getProject: () => fakeProject,
    syncTransportUI: () => {},
    persist: () => {},
    setMasterLevel: (v) => { written.push(v); },
    peekMasterLevel: () => 0.75,
  });

  const desc = getParam('master');
  assert.ok(desc, 'master param is registered for knobs + stick targets');
  assert.equal(desc.id, 'master');
  assert.equal(desc.group, 'mix');
  assert.equal(desc.get(), 0.75, 'reads the stored level, not the AudioParam');

  desc.set(0.25);
  desc.set(4); // clamped 0..1 before it reaches the bus
  assert.deepEqual(written, [0.25, 1]);

  // The strip slider relies on this round-trip (norm -> value -> norm).
  for (const n of [0, 0.1, 0.5, 0.9, 1]) {
    assert.ok(Math.abs(desc.toNorm(desc.fromNorm(n)) - n) < 1e-9, `norm ${n} round-trips`);
  }
  assert.equal(desc.format(1), '0.0dB');
  assert.equal(desc.format(0), '-inf');
});
