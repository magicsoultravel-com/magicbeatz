import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arrangementBars,
  arrangementToSlots,
  arrangerLanesToSlots,
  arrangerSlotsToLanes,
  createArrangementClip,
  createDefaultProject,
  duplicatePattern,
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

const resolve = (project, step) => (
  resolveArrangerStep(project, step, project.arrangeBars)
);

const barStepsFor = (project) => stepsPerBar(
  beatsFromTimeSignature(project.timeSignature),
);

test('a fresh project opens eight layers with only the active Grid seeded', () => {
  const project = createDefaultProject();
  const { lanes } = project.arranger;
  const active = project.patterns[0];

  assert.equal(project.version, 6);
  assert.equal(lanes.length, 8);
  assert.deepEqual(
    lanes.map((lane) => lane.id),
    ['lane-1', 'lane-2', 'lane-3', 'lane-4', 'lane-5', 'lane-6', 'lane-7', 'lane-8'],
  );
  lanes.forEach((lane) => {
    assert.deepEqual(Object.keys(lane).sort(), ['arrangement', 'id']);
    assert.equal('channelId' in lane, false);
  });

  assert.equal(lanes[0].arrangement.length, 1);
  assert.equal(lanes[0].arrangement[0].patternId, active.id);
  assert.equal(lanes[0].arrangement[0].startSlot, 0);
  assert.equal(lanes[0].arrangement[0].lengthSlot, active.bars);
  lanes.slice(1).forEach((lane) => {
    assert.deepEqual(lane.arrangement, []);
  });

  const slots = arrangementToSlots(lanes[0].arrangement, project.arrangeBars);
  assert.equal(slots.length, 16);
  assert.equal(slots[active.bars], '');
});

test('a Grid painted on one layer resolves only on that layer', () => {
  const project = createDefaultProject();
  const grid = project.patterns[0];

  project.arranger.lanes[5].arrangement = [clip(grid.id, 0, 8)];
  const lanes = resolve(project, 0);

  assert.equal(lanes[5].pattern.id, grid.id);
  assert.equal(lanes[5].localStep, 0);
  assert.equal(lanes[5].laneId, 'lane-6');
  assert.equal(lanes[2], null);
});

test('two layers with different Grids start at their own bar offsets', () => {
  const project = createDefaultProject();
  const twoBarA = createEmptyPattern({
    name: 'two bar A',
    bars: 2,
    timeSignature: project.timeSignature,
  });
  const twoBarB = createEmptyPattern({
    name: 'two bar B',
    bars: 2,
    timeSignature: project.timeSignature,
  });
  project.patterns.push(twoBarA, twoBarB);
  const barSteps = barStepsFor(project);

  project.arranger.lanes[0].arrangement = [clip(twoBarA.id, 0, 8)];
  project.arranger.lanes[1].arrangement = [clip(twoBarB.id, 3, 8)];

  const lanes = resolve(project, 3 * barSteps + 7);
  assert.equal(lanes[0].pattern.id, twoBarA.id);
  assert.equal(lanes[0].localStep, barSteps + 7);
  assert.equal(lanes[1].pattern.id, twoBarB.id);
  assert.equal(lanes[1].localStep, 7);
});

test('the same Grid in several layers keeps each clip local step', () => {
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

  const lanes = resolve(project, 2 * barSteps + 5);
  assert.deepEqual(
    lanes.slice(0, 3).map((lane) => lane?.pattern.id),
    [fourBars.id, fourBars.id, fourBars.id],
  );
  assert.deepEqual(
    lanes.slice(0, 3).map((lane) => lane?.localStep),
    [2 * barSteps + 5, barSteps + 5, 5],
  );
  assert.deepEqual(
    lanes.slice(0, 3).map((lane) => lane?.laneId),
    ['lane-1', 'lane-2', 'lane-3'],
  );
});

test('Grids with different bar lengths wrap independently per clip', () => {
  const project = createDefaultProject();
  const oneBar = project.patterns[0];
  const twoBar = createEmptyPattern({
    name: 'two bar grid',
    bars: 2,
    timeSignature: project.timeSignature,
  });
  project.patterns.push(twoBar);
  const barSteps = barStepsFor(project);

  project.arranger.lanes[0].arrangement = [clip(oneBar.id, 0, 8)];
  project.arranger.lanes[1].arrangement = [clip(twoBar.id, 0, 8)];
  project.arranger.lanes[2].arrangement = [clip(twoBar.id, 2, 8)];

  const lanes = resolve(project, 3 * barSteps + 5);
  assert.equal(lanes[0].localStep, 5); // one-bar Grid wrapped inside
  assert.equal(lanes[1].localStep, barSteps + 5); // two-bar Grid still mid-loop
  assert.equal(lanes[2].localStep, barSteps + 5); // same phase, different clip
});

test('editing tracks inside a Grid never changes lane content', () => {
  const project = createDefaultProject();
  const fourBars = createEmptyPattern({
    name: 'four bar grid',
    bars: 4,
    timeSignature: project.timeSignature,
  });
  project.patterns.push(fourBars);

  project.arranger.lanes[2].arrangement = [clip(fourBars.id, 4, 8)];
  const laneSnapshot = JSON.stringify(project.arranger.lanes[2]);

  fourBars.channels[0].name = 'renamed kick';
  fourBars.channels.reverse();
  fourBars.channels.splice(1, 1);

  assert.equal(JSON.stringify(project.arranger.lanes[2]), laneSnapshot);
  const resolved = resolve(project, 4 * barStepsFor(project) + 3)[2];
  assert.equal(resolved.pattern.id, fourBars.id);
  assert.equal(resolved.localStep, 3);
});

test('duplicating a Grid gives its tracks fresh independent ids', () => {
  const project = createDefaultProject();
  const src = project.patterns[0];
  const copy = duplicatePattern(src, 'copy');
  const srcIds = new Set(src.channels.map((ch) => ch.id));
  const copyIds = copy.channels.map((ch) => ch.id);

  assert.equal(copy.channels.length, src.channels.length);
  assert.equal(copyIds.every((id) => !srcIds.has(id)), true);
  assert.equal(new Set(copyIds).size, copyIds.length);
});

test('deleting a Grid drops its lane clips without touching other layers', () => {
  const project = createDefaultProject();
  const doomed = project.patterns[1];
  const keeper = project.patterns[2];

  project.arranger.lanes[0].arrangement = [clip(keeper.id, 0, 8)];
  project.arranger.lanes[3].arrangement = [
    clip(doomed.id, 0, 8),
    clip(keeper.id, 8, 8),
  ];

  const raw = serializeProject(project);
  raw.patterns = raw.patterns.filter((p) => p.id !== doomed.id);
  const parsed = parseProject(raw);

  assert.equal(parsed.arranger.lanes[0].arrangement.length, 1);
  assert.equal(parsed.arranger.lanes[3].arrangement.length, 1);
  assert.equal(parsed.arranger.lanes[3].arrangement[0].patternId, keeper.id);
  assert.equal(parsed.arranger.lanes[3].arrangement[0].startSlot, 8);
});


test('slot arrays round-trip all eight layers without losing arrangements', () => {
  const project = createDefaultProject();
  const [gridA, gridB] = project.patterns;
  const lanes = arrangerLanesToSlots(project.arranger, 64);
  assert.equal(lanes.length, 8);
  assert.equal(lanes[0].slots.length, 64);

  lanes[1].slots[0] = gridA.id;
  lanes[1].slots[1] = gridA.id;
  lanes[1].slots[4] = gridB.id;
  lanes[6].slots[40] = gridA.id;

  const arranger = arrangerSlotsToLanes(lanes);
  const restored = arrangerLanesToSlots(arranger, 64);

  assert.equal(arranger.lanes.length, 8);
  assert.deepEqual(Object.keys(arranger.lanes[0]).sort(), ['arrangement', 'id']);
  assert.equal(restored[1].id, lanes[1].id);
  assert.equal(restored[1].slots[0], gridA.id);
  assert.equal(restored[1].slots[1], gridA.id);
  assert.equal(restored[1].slots[4], gridB.id);
  assert.equal(restored[6].slots[40], gridA.id);
  // Contiguous identical Grids merge; a different Grid starts a new clip.
  assert.equal(arranger.lanes[1].arrangement.length, 2);
  assert.equal(arranger.lanes[1].arrangement[0].startSlot, 0);
  assert.equal(arranger.lanes[1].arrangement[0].lengthSlot, 2);
  assert.equal(arranger.lanes[1].arrangement[1].startSlot, 4);
  assert.equal(arranger.lanes[1].arrangement[1].lengthSlot, 1);
});

test('v6 serialization round-trips layers and the bar-based timeline length', () => {
  const project = createDefaultProject();
  const patternId = project.activePatternId;
  project.arrangeBars = 32;
  project.arranger.lanes[6].arrangement = [clip(patternId, 12, 4)];

  const parsed = parseProject(serializeProject(project));

  assert.equal(parsed.version, 6);
  assert.equal(parsed.arrangeBars, 32);
  assert.equal(arrangementBars(parsed), 32);
  assert.equal(parsed.arranger.lanes.length, 8);
  assert.equal('channelId' in parsed.arranger.lanes[6], false);
  assert.equal('arrangeView' in parsed, false);
  assert.equal(parsed.arranger.lanes[6].arrangement[0].startSlot, 12);
  assert.equal(parsed.arranger.lanes[6].arrangement[0].lengthSlot, 4);
  assert.equal(parsed.arranger.lanes[6].arrangement[0].patternId, patternId);
});


test('v4 migration clears channel-bound layers but preserves the Looper', () => {
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
  assert.equal('arrangeView' in parsed, false);
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

test('legacy projects seed eight layers and open on the Arranger', () => {
  for (const version of [undefined, 2, 3]) {
    const raw = serializeProject(createDefaultProject());
    if (version === undefined) delete raw.version;
    else raw.version = version;
    delete raw.arranger;
    delete raw.arrangement;

    const parsed = parseProject(raw);

    assert.equal(parsed.version, 6);
    assert.equal('arrangeView' in parsed, false);
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

