import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARRANGER_LANES,
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

function clip(patternId, startSlot, lengthSlot, div = 4) {
  return createArrangementClip({ patternId, startSlot, lengthSlot }, div);
}

function resolveLane(project, laneIndex, step = 0) {
  const lanes = resolveArrangerStep(project, step, project.arrangeBars * project.arrangeDiv);
  return lanes[laneIndex];
}

test('a fresh project opens eight empty whole-Grid layers with no channel bindings', () => {
  const project = createDefaultProject();

  assert.equal(project.version, 5);
  assert.equal(project.arranger.lanes.length, ARRANGER_LANES);
  project.arranger.lanes.forEach((lane, index) => {
    assert.deepEqual(Object.keys(lane).sort(), ['arrangement', 'id']);
    assert.equal(lane.id, `lane-${index + 1}`);
    assert.equal('channelId' in lane, false);
    assert.deepEqual(lane.arrangement, []);
  });

  const slots = arrangerLanesToSlots(project.arranger, 64, project.arrangeDiv);
  assert.equal(slots.length, ARRANGER_LANES);
  assert.deepEqual(Object.keys(slots[0]).sort(), ['id', 'slots']);
  assert.deepEqual(slots[0].slots, Array(64).fill(''));
});

test('any Grid can be painted into any layer', () => {
  const project = createDefaultProject();
  const grid = project.patterns[2];

  project.arranger.lanes[5].arrangement = [clip(grid.id, 0, 8, project.arrangeDiv)];
  const resolved = resolveLane(project, 5, 0);

  assert.equal(resolved.pattern.id, grid.id);
  assert.equal(resolved.clip.patternId, grid.id);
  assert.equal(resolved.laneId, 'lane-6');
  assert.equal(resolved.laneIndex, 5);
  assert.equal('channel' in resolved, false);
  assert.equal('laneChannelId' in resolved, false);
});

test('two layers holding different whole Grids both resolve at the same step', () => {
  const project = createDefaultProject();
  const gridA = project.patterns[1];
  const gridB = project.patterns[2];

  project.arranger.lanes[0].arrangement = [clip(gridA.id, 0, 8, project.arrangeDiv)];
  project.arranger.lanes[1].arrangement = [clip(gridB.id, 0, 8, project.arrangeDiv)];

  const lanes = resolveArrangerStep(project, 5, 64);
  assert.equal(lanes.length, ARRANGER_LANES);
  assert.equal(lanes[0].pattern.id, gridA.id);
  assert.equal(lanes[1].pattern.id, gridB.id);
  assert.equal(lanes[0].slotIndex, lanes[1].slotIndex);
  assert.equal(lanes[0].localStep, lanes[1].localStep);
  // Resolution yields the whole Grid, not one channel from it.
  assert.equal(lanes[0].pattern.channels.length, gridA.channels.length);
  assert.ok(lanes[0].pattern.channels.length > 1);
});

test('the same Grid in several layers resolves once per layer with its own local step', () => {
  const project = createDefaultProject();
  const grid = project.patterns[0];
  const d = project.arrangeDiv;

  project.arranger.lanes[0].arrangement = [clip(grid.id, 0, 16, d)];
  project.arranger.lanes[1].arrangement = [clip(grid.id, 1, 16, d)];
  project.arranger.lanes[2].arrangement = [clip(grid.id, 2, 16, d)];

  // div 4 → 4 steps per slot, so step 8 is the start of slot 2.
  const lanes = resolveArrangerStep(project, 8, 64);
  const layers = [lanes[0], lanes[1], lanes[2]];

  assert.deepEqual(layers.map((lane) => lane?.pattern.id), [grid.id, grid.id, grid.id]);
  assert.deepEqual(layers.map((lane) => lane?.localStep), [8, 4, 0]);
  assert.deepEqual(layers.map((lane) => lane?.laneId), ['lane-1', 'lane-2', 'lane-3']);
});

test('grids with different bar lengths start their local step independently per clip', () => {
  const project = createDefaultProject();
  const oneBar = project.patterns[0];
  const twoBar = createEmptyPattern({
    name: 'two bar grid',
    bars: 2,
    timeSignature: project.timeSignature,
  });
  project.patterns.push(twoBar);
  const d = project.arrangeDiv;
  const barSteps = stepsPerBar(beatsFromTimeSignature(project.timeSignature));
  const slotSteps = barSteps / d;

  project.arranger.lanes[0].arrangement = [clip(oneBar.id, 0, 16, d)];
  project.arranger.lanes[1].arrangement = [clip(twoBar.id, 0, 16, d)];
  project.arranger.lanes[2].arrangement = [clip(twoBar.id, 2, 12, d)];

  const lanes = resolveArrangerStep(project, 24, 64);
  assert.equal(lanes[0].localStep, 24 % barSteps); // 1-bar grid wrapped inside
  assert.equal(lanes[1].localStep, 24 % (2 * barSteps)); // 2-bar grid still mid-pattern
  assert.equal(lanes[2].localStep, 24 - 2 * slotSteps); // starts two slots in

  // Lane 2 restarts at step 0 relative to its own clip start.
  const restart = resolveArrangerStep(project, 8, 64);
  assert.equal(restart[2].localStep, 0);
  assert.equal(restart[0].localStep, 8);
  assert.equal(restart[1].localStep, 8);
});

test('editing tracks inside a Grid never changes lane content', () => {
  const project = createDefaultProject();
  const grid = project.patterns[0];
  const d = project.arrangeDiv;

  project.arranger.lanes[2].arrangement = [clip(grid.id, 4, 8, d)];
  const laneSnapshot = JSON.stringify(project.arranger.lanes[2]);

  grid.channels[0].name = 'renamed kick';
  grid.channels.reverse();
  grid.channels.splice(1, 1);

  assert.equal(JSON.stringify(project.arranger.lanes[2]), laneSnapshot);
  const resolved = resolveLane(project, 2, 16);
  assert.equal(resolved.pattern.id, grid.id);
  assert.equal(resolved.localStep, 0);
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
  const d = project.arrangeDiv;

  project.arranger.lanes[0].arrangement = [clip(keeper.id, 0, 8, d)];
  project.arranger.lanes[3].arrangement = [clip(doomed.id, 0, 8, d), clip(keeper.id, 8, 8, d)];

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
  const lanes = arrangerLanesToSlots(project.arranger, 64, project.arrangeDiv);

  lanes[1].slots[0] = gridA.id;
  lanes[1].slots[1] = gridA.id;
  lanes[1].slots[4] = gridB.id;
  lanes[6].slots[40] = gridA.id;

  const arranger = arrangerSlotsToLanes(lanes, project.arrangeDiv);
  const restored = arrangerLanesToSlots(arranger, 64, project.arrangeDiv);

  assert.equal(arranger.lanes.length, ARRANGER_LANES);
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

test('v5 serialization round-trips layers and the active timeline view', () => {
  const project = createDefaultProject();
  const patternId = project.activePatternId;
  project.arrangeView = 'arranger';
  project.arranger.lanes[6].arrangement = [
    clip(patternId, 12, 4, project.arrangeDiv),
  ];

  const parsed = parseProject(serializeProject(project));

  assert.equal(parsed.version, 5);
  assert.equal(parsed.arrangeView, 'arranger');
  assert.equal(parsed.arranger.lanes.length, ARRANGER_LANES);
  assert.equal('channelId' in parsed.arranger.lanes[6], false);
  assert.equal(parsed.arranger.lanes[6].arrangement[0].startSlot, 12);
  assert.equal(parsed.arranger.lanes[6].arrangement[0].lengthSlot, 4);
  assert.equal(parsed.arranger.lanes[6].arrangement[0].patternId, patternId);
});

test('v4 migration clears the channel-filtered Arranger but preserves the Looper', () => {
  const project = createDefaultProject();
  const d = project.arrangeDiv;
  project.arranger.lanes[0].arrangement = [clip(project.patterns[0].id, 0, 4, d)];
  project.arranger.lanes[1].arrangement = [clip(project.patterns[1].id, 8, 4, d)];

  const raw = serializeProject(project);
  raw.version = 4;
  raw.arrangeView = 'arranger';
  // v4 lane records carried a channel binding.
  raw.arranger.lanes.forEach((lane) => { lane.channelId = 'trk-kick'; });
  const looperClips = raw.arrangement.length;

  const parsed = parseProject(raw);

  assert.equal(parsed.version, 5);
  assert.equal(parsed.arrangeView, 'looper');
  assert.equal(parsed.arranger.lanes.length, ARRANGER_LANES);
  parsed.arranger.lanes.forEach((lane) => {
    assert.deepEqual(lane.arrangement, []);
    assert.equal('channelId' in lane, false);
  });
  assert.equal(parsed.arrangement.length, looperClips);
  assert.equal(parsed.arrangement[0].patternId, project.patterns[0].id);
});

test('legacy projects seed eight empty layers and open on Looper', () => {
  for (const version of [undefined, 2, 3]) {
    const raw = serializeProject(createDefaultProject());
    if (version === undefined) delete raw.version;
    else raw.version = version;
    delete raw.arranger;
    delete raw.arrangeView;

    const parsed = parseProject(raw);

    assert.equal(parsed.version, 5);
    assert.equal(parsed.arrangeView, 'looper');
    assert.equal(parsed.arranger.lanes.length, ARRANGER_LANES);
    parsed.arranger.lanes.forEach((lane, index) => {
      assert.equal(lane.id, `lane-${index + 1}`);
      assert.deepEqual(lane.arrangement, []);
      assert.equal('channelId' in lane, false);
    });
    assert.equal(parsed.arrangement.length > 0, true);
  }
});

