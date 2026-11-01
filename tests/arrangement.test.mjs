import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arrangementBars,
  arrangementToSlots,
  createArrangementClip,
  createDefaultProject,
  ensureArrangementSlots,
  parseProject,
  resampleSlots,
  resolveArrangementStep,
  serializeProject,
} from '../src/sequencer/project.js';
import { beatsFromTimeSignature, stepsPerBar } from '../src/sequencer/pattern.js';

test('fresh project opens on the 16-bar canvas with the 8-track starter', () => {
  const project = createDefaultProject();

  assert.equal(project.patterns.length, 5);
  assert.equal(project.patterns[0].channels.length, 8);
  assert.equal(project.arrangeBars, 16);
  assert.equal(arrangementBars(project), 16);

  const slots = arrangementToSlots(
    project.arrangement,
    project.arrangeBars * project.arrangeDiv,
    project.arrangeDiv,
  );
  assert.equal(slots.length, 64);
  assert.deepEqual(slots.slice(0, 4), Array(4).fill(project.activePatternId));
  assert.equal(slots[4], '');
});

test('serialization round-trip preserves arrangement length and settings', () => {
  const project = createDefaultProject();
  const patternId = project.activePatternId;
  project.arrangeDiv = 2;
  project.arrangeBars = 16;
  project.playMode = 'song';
  project.arrangeLoop = false;
  project.arrangement = [
    createArrangementClip({ patternId, startSlot: 6, lengthSlot: 4 }, 2),
  ];

  const parsed = parseProject(serializeProject(project));

  assert.equal(parsed.arrangeBars, 16);
  assert.equal(parsed.arrangeDiv, 2);
  assert.equal(parsed.playMode, 'song');
  assert.equal(parsed.arrangeLoop, false);
  assert.equal(parsed.arrangement.length, 1);
  assert.equal(parsed.arrangement[0].startSlot, 6);
  assert.equal(parsed.arrangement[0].lengthSlot, 4);
});

test('legacy projects without arrangeBars migrate to 16 bars', () => {
  const raw = serializeProject(createDefaultProject());
  delete raw.arrangeBars;

  const parsed = parseProject(raw);
  assert.equal(parsed.arrangeBars, 16);
});

test('empty trailing bars survive a slots round-trip', () => {
  const project = createDefaultProject();
  project.arrangement = [
    createArrangementClip({
      patternId: project.activePatternId,
      startSlot: 0,
      lengthSlot: 4,
    }, project.arrangeDiv),
  ];
  const slots = ensureArrangementSlots(project);

  assert.equal(slots.length, 64);
  assert.equal(slots.slice(4).every((slot) => slot === ''), true);
  assert.equal(project.arrangeBars, 16);
  assert.equal(project.arrangement.length, 1);

  const parsed = parseProject(serializeProject(project));
  assert.equal(parsed.arrangeBars, 16);
  assert.equal(parsed.arrangement.length, 1);
});

test('legacy v1 pattern documents migrate onto the 16-bar canvas', () => {
  const parsed = parseProject({
    bpm: 100,
    timeSignature: [4, 4],
    swing: 0,
    bars: 1,
    channels: [],
  });

  assert.equal(parsed.bpm, 100);
  assert.equal(parsed.patterns.length, 1);
  assert.equal(parsed.arrangeBars, 16);
});

test('an explicit short arrangement length is preserved', () => {
  const raw = serializeProject(createDefaultProject());
  raw.arrangeBars = 4;

  const parsed = parseProject(raw);
  assert.equal(parsed.arrangeBars, 4);
});

test('clips beyond the stored length expand the timeline', () => {
  const raw = serializeProject(createDefaultProject());
  raw.arrangeBars = 4;
  raw.arrangement = [{
    ...raw.arrangement[0],
    startSlot: 32,
    lengthSlot: 4,
  }];

  const parsed = parseProject(raw);
  assert.equal(parsed.arrangeBars, 9);
});

test('resolution changes keep the 16-bar canvas and clip positions', () => {
  const project = createDefaultProject();
  const patternId = project.activePatternId;
  const slots = Array.from({ length: 64 }, (_, i) => (i < 4 ? patternId : ''));

  const halfBar = resampleSlots(slots, 4, 2);
  assert.equal(halfBar.length, 32);
  assert.deepEqual(halfBar.slice(0, 2), [patternId, patternId]);
  assert.equal(halfBar[2], '');

  const bar = resampleSlots(halfBar, 2, 1);
  assert.equal(bar.length, 16);
  assert.equal(bar[0], patternId);
  assert.equal(bar[1], '');

  const back = resampleSlots(bar, 1, 4);
  assert.equal(back.length, 64);
  assert.deepEqual(back.slice(0, 4), Array(4).fill(patternId));
});

test('song resolution finds clips, reserves rests and wraps within clips', () => {
  const project = createDefaultProject();
  const patternId = project.activePatternId;
  project.arrangeDiv = 4;
  project.arrangeBars = 16;
  project.arrangement = [
    createArrangementClip({ patternId, startSlot: 0, lengthSlot: 8 }, 4),
    createArrangementClip({ patternId, startSlot: 60, lengthSlot: 4 }, 4),
  ];

  const first = resolveArrangementStep(project, 0, 64);
  assert.equal(first.slotIndex, 0);
  assert.equal(first.localStep, 0);

  const wrapped = resolveArrangementStep(project, 20, 64);
  assert.equal(wrapped.slotIndex, 5);
  assert.equal(wrapped.localStep, 4);

  assert.equal(resolveArrangementStep(project, 32, 64), null);

  const lastBar = resolveArrangementStep(project, 240, 64);
  assert.equal(lastBar.slotIndex, 60);
  assert.equal(lastBar.localStep, 0);

  const barSteps = stepsPerBar(beatsFromTimeSignature(project.timeSignature));
  assert.equal(arrangementBars(project) * barSteps, 256);
});
