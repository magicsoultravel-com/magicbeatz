import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARRANGE_LENGTH_OPTIONS,
  DEFAULT_ARRANGE_BARS,
  MAX_ARRANGE_BARS,
  arrangementBars,
  arrangementToSlots,
  arrangerLanesToSlots,
  arrangerSlotsToLanes,
  createArrangementClip,
  createDefaultProject,
  normalizeArrangeBars,
  parseProject,
  resolveArrangerStep,
  serializeProject,
} from '../src/sequencer/project.js';
import {
  beatsFromTimeSignature,
  createEmptyPattern,
  stepsPerBar,
} from '../src/sequencer/pattern.js';

const clip = (patternId, startSlot, lengthSlot) => (
  createArrangementClip({ patternId, startSlot, lengthSlot })
);

const barStepsFor = (project) => stepsPerBar(
  beatsFromTimeSignature(project.timeSignature),
);

test('fresh projects keep one bar per slot with sixteen bars ready to scroll', () => {
  const project = createDefaultProject();

  assert.equal(project.version, 6);
  assert.equal(project.patterns.length, 5);
  assert.equal(project.patterns[0].channels.length, 8);
  assert.equal(project.arrangeBars, 16);
  assert.equal(arrangementBars(project), 16);
  assert.equal(project.arranger.lanes.length, 8);

  const starter = project.arranger.lanes[0].arrangement;
  const starterBars = project.patterns[0].bars;
  assert.equal(starter.length, 1);
  assert.equal(starter[0].startSlot, 0);
  assert.equal(starter[0].lengthSlot, starterBars);

  const slots = arrangementToSlots(starter, project.arrangeBars);
  assert.equal(slots.length, 16);
  assert.deepEqual(
    slots.slice(0, starterBars),
    Array(starterBars).fill(project.activePatternId),
  );
  assert.equal(slots[starterBars], '');
  project.arranger.lanes.slice(1).forEach((lane) => {
    assert.deepEqual(lane.arrangement, []);
  });
});

test('the timeline offers 16/32/64 bars and clamps hand-edited lengths', () => {
  assert.deepEqual(ARRANGE_LENGTH_OPTIONS, [16, 32, 64]);
  assert.equal(DEFAULT_ARRANGE_BARS, 16);
  assert.equal(MAX_ARRANGE_BARS, 64);
  assert.equal(normalizeArrangeBars('32'), 32);
  assert.equal(normalizeArrangeBars(0), 1);
  assert.equal(normalizeArrangeBars(999), 64);
  assert.equal(normalizeArrangeBars('not a length'), 16);
});

test('bar-based serialization round-trips layers without a slot division', () => {
  const project = createDefaultProject();
  const patternId = project.activePatternId;
  project.arrangeBars = 32;
  project.playMode = 'song';
  project.arrangeLoop = false;
  project.bpm = 93;
  project.swing = 0.25;
  project.arranger.lanes[2].arrangement = [clip(patternId, 6, 4)];

  const parsed = parseProject(serializeProject(project));

  assert.equal(parsed.version, 6);
  assert.equal(parsed.arrangeBars, 32);
  assert.equal(parsed.playMode, 'song');
  assert.equal(parsed.arrangeLoop, false);
  assert.equal(parsed.bpm, 93);
  assert.equal(parsed.swing, 0.25);
  assert.equal(parsed.arranger.lanes[2].arrangement.length, 1);
  assert.equal(parsed.arranger.lanes[2].arrangement[0].startSlot, 6);
  assert.equal(parsed.arranger.lanes[2].arrangement[0].lengthSlot, 4);
  assert.equal(parsed.arranger.lanes[2].arrangement[0].patternId, patternId);
  assert.equal('arrangement' in parsed, false);
});

test('bare v6 projects omit arrangeBars and fall back to sixteen bars', () => {
  const raw = serializeProject(createDefaultProject());
  delete raw.arrangeBars;

  const parsed = parseProject(raw);

  assert.equal(parsed.version, 6);
  assert.equal(parsed.arrangeBars, 16);
});

test('explicit short timeline lengths survive a save and load', () => {
  const project = createDefaultProject();
  project.arrangeBars = 4;

  const parsed = parseProject(serializeProject(project));

  assert.equal(parsed.arrangeBars, 4);
  assert.equal(arrangementBars(parsed), 4);
  assert.equal(arrangementToSlots(parsed.arranger.lanes[0].arrangement, 4).length, 4);
});

test('clips beyond the stored length expand the timeline instead of clipping', () => {
  const project = createDefaultProject();
  const patternId = project.activePatternId;
  project.arrangeBars = 4;
  project.arranger.lanes[0].arrangement = [clip(patternId, 32, 4)];

  const parsed = parseProject(serializeProject(project));

  assert.equal(parsed.arrangeBars, 36);
  assert.equal(parsed.arranger.lanes[0].arrangement[0].startSlot, 32);
});

test('empty trailing bars survive a slots round-trip', () => {
  const project = createDefaultProject();
  const patternId = project.activePatternId;
  project.arranger.lanes[0].arrangement = [clip(patternId, 0, 1)];

  const slots = arrangerLanesToSlots(project.arranger, project.arrangeBars);
  assert.equal(slots[0].slots.length, 16);
  assert.equal(slots[0].slots[0], patternId);
  assert.equal(slots[0].slots[1], '');

  project.arranger = arrangerSlotsToLanes(slots);
  const parsed = parseProject(serializeProject(project));

  assert.equal(parsed.arrangeBars, 16);
  assert.equal(parsed.arranger.lanes[0].arrangement.length, 1);
  assert.equal(parsed.arranger.lanes[0].arrangement[0].lengthSlot, 1);
});

test('legacy v1 pattern documents become one bar-based layer clip', () => {
  const legacy = {
    version: 1,
    bpm: 110,
    timeSignature: [4, 4],
    swing: 0.1,
    bars: 1,
    channels: [{
      id: 'ch-legacy',
      name: 'kick',
      type: 'percussion',
      voiceId: 'kick',
      steps: [{ velocity: 0.8 }, null, null, null],
    }],
  };

  const parsed = parseProject(legacy);

  assert.equal(parsed.version, 6);
  assert.equal(parsed.arrangeBars, 16);
  assert.equal(parsed.arranger.lanes.length, 8);
  assert.equal(parsed.arranger.lanes[0].arrangement.length, 1);
  assert.equal(parsed.arranger.lanes[0].arrangement[0].startSlot, 0);
  assert.equal(parsed.arranger.lanes[0].arrangement[0].lengthSlot, 1);
  assert.equal('arrangement' in parsed, false);
});

test('v5 Looper sub-slots collapse onto whole bars', () => {
  const raw = serializeProject(createDefaultProject());
  const patternId = raw.activePatternId;
  raw.version = 5;
  raw.arrangeDiv = 4;
  delete raw.arranger;
  raw.arrangement = [
    clip(patternId, 4, 4),
    clip(patternId, 8, 4),
  ];

  const parsed = parseProject(raw);

  assert.equal(parsed.version, 6);
  assert.equal('arrangement' in parsed, false);
  assert.equal('arrangeDiv' in parsed, false);
  const slots = arrangementToSlots(
    parsed.arranger.lanes[0].arrangement,
    parsed.arrangeBars,
  );
  assert.deepEqual(slots.slice(0, 3), ['', patternId, patternId]);
  assert.equal(slots[3], '');
});

test('v5 Arranger clips with a sub-bar division snap to bars', () => {
  const raw = serializeProject(createDefaultProject());
  const patternId = raw.activePatternId;
  raw.version = 5;
  raw.arrangeDiv = 2;
  delete raw.arrangement;
  raw.arranger.lanes.forEach((lane) => { lane.arrangement = []; });
  raw.arranger.lanes[4].arrangement = [
    clip(patternId, 1, 1),
    clip(patternId, 3, 1),
  ];

  const parsed = parseProject(raw);

  const slots = arrangementToSlots(
    parsed.arranger.lanes[4].arrangement,
    parsed.arrangeBars,
  );
  assert.deepEqual(slots.slice(0, 3), [patternId, patternId, '']);
});

test('v4 projects drop channel-bound layers but keep the Looper as layer one', () => {
  const raw = serializeProject(createDefaultProject());
  const patternId = raw.activePatternId;
  raw.version = 4;
  raw.arrangeDiv = 4;
  delete raw.arranger;
  raw.arrangement = [
    clip(patternId, 0, 4),
    clip(patternId, 8, 4),
  ];

  const parsed = parseProject(raw);

  assert.equal(parsed.version, 6);
  assert.equal('arrangement' in parsed, false);
  assert.equal(parsed.arranger.lanes.length, 8);
  parsed.arranger.lanes.forEach((lane) => {
    assert.equal('channelId' in lane, false);
  });
  const slots = arrangementToSlots(
    parsed.arranger.lanes[0].arrangement,
    parsed.arrangeBars,
  );
  assert.deepEqual(slots.slice(0, 4), [patternId, '', patternId, '']);
  parsed.arranger.lanes.slice(1).forEach((lane) => {
    assert.deepEqual(lane.arrangement, []);
  });
});

test('legacy projects seed the active Grid on the first layer only', () => {
  for (const version of [undefined, 2, 3]) {
    const raw = serializeProject(createDefaultProject());
    if (version === undefined) delete raw.version;
    else raw.version = version;
    delete raw.arranger;
    delete raw.arrangement;

    const parsed = parseProject(raw);

    assert.equal(parsed.version, 6);
    assert.equal(parsed.arranger.lanes.length, 8);
    parsed.arranger.lanes.forEach((lane, index) => {
      assert.equal(lane.id, `lane-${index + 1}`);
      assert.equal('channelId' in lane, false);
      if (index === 0) {
        assert.equal(lane.arrangement.length, 1);
        assert.equal(lane.arrangement[0].startSlot, 0);
        assert.equal(lane.arrangement[0].lengthSlot, parsed.patterns[0].bars);
      } else {
        assert.deepEqual(lane.arrangement, []);
      }
    });
    assert.equal('arrangement' in parsed, false);
  }
});



test('resolution treats every slot as a full bar and wraps long Grids', () => {
  const project = createDefaultProject();
  const fourBars = createEmptyPattern({
    name: 'four bar grid',
    bars: 4,
    timeSignature: project.timeSignature,
  });
  project.patterns.push(fourBars);
  const barSteps = barStepsFor(project);

  project.arranger.lanes[0].arrangement = [clip(fourBars.id, 0, 8)];
  project.arranger.lanes[1].arrangement = [clip(fourBars.id, 1, 8)];
  project.arranger.lanes[2].arrangement = [clip(fourBars.id, 2, 8)];

  const lanes = resolveArrangerStep(project, 2 * barSteps + 5, project.arrangeBars);
  assert.deepEqual(
    lanes.slice(0, 3).map((lane) => lane?.localStep),
    [2 * barSteps + 5, barSteps + 5, 5],
  );
  assert.deepEqual(
    lanes.slice(0, 3).map((lane) => lane?.laneId),
    ['lane-1', 'lane-2', 'lane-3'],
  );

  // One step later the same clips advance together.
  const next = resolveArrangerStep(project, 2 * barSteps + 6, project.arrangeBars);
  assert.deepEqual(
    next.slice(0, 3).map((lane) => lane?.localStep),
    [2 * barSteps + 6, barSteps + 6, 6],
  );
});

test('steps outside every clip resolve to silence', () => {
  const project = createDefaultProject();
  const patternId = project.activePatternId;
  project.arranger.lanes[0].arrangement = [clip(patternId, 0, 2)];

  const lanes = resolveArrangerStep(
    project,
    4 * barStepsFor(project),
    project.arrangeBars,
  );

  assert.equal(lanes.every((lane) => lane === null), true);
});
