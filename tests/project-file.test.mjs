import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createArrangementClip,
  createDefaultProject,
  serializeProject,
} from '../src/sequencer/project.js';
import {
  PROJECT_FILE_KIND,
  PROJECT_FILE_SCHEMA,
  ProjectFileError,
  buildProjectFile,
  parseProjectFile,
  projectFileName,
  stringifyProjectFile,
  summarizeProject,
} from '../src/state/project-file.js';

test('export envelope is self-describing and matches the storage schema', () => {
  const project = createDefaultProject();
  const date = new Date(Date.UTC(2026, 10, 14, 15, 30));
  const file = buildProjectFile(project, date);

  assert.equal(file.kind, PROJECT_FILE_KIND);
  assert.equal(file.app, 'magicbeatz');
  assert.equal(file.schemaVersion, PROJECT_FILE_SCHEMA);
  assert.equal(file.savedAt, date.toISOString());
  assert.equal(file.project.version, 5);
  assert.equal(file.project.patterns.length, 5);

  const text = stringifyProjectFile(project, date);
  assert.ok(text.endsWith('\n'));
  assert.match(text, /\n {2}"kind": "magicbeatz-project"/);
});

test('full round-trip preserves grids, steps and both timelines', () => {
  const project = createDefaultProject();
  const patternId = project.activePatternId;
  project.bpm = 93;
  project.swing = 0.25;
  project.arrangeDiv = 2;
  project.arrangeBars = 16;
  project.arrangeLoop = false;
  project.playMode = 'song';
  project.arrangeView = 'arranger';
  project.arrangement = [
    createArrangementClip({ patternId, startSlot: 6, lengthSlot: 4 }, 2),
  ];
  project.arranger.lanes[2].arrangement = [
    createArrangementClip({ patternId, startSlot: 2, lengthSlot: 2 }, 2),
  ];
  const sourceKick = project.patterns[0].channels[0];
  sourceKick.name = 'kick A';
  sourceKick.steps[3] = { velocity: 0.57 };
  project.patterns[0].channels[1].mute = true;

  const parsed = parseProjectFile(stringifyProjectFile(project));

  assert.equal(parsed.version, 5);
  assert.equal(parsed.bpm, 93);
  assert.equal(parsed.swing, 0.25);
  assert.equal(parsed.playMode, 'song');
  assert.equal(parsed.arrangeLoop, false);
  assert.equal(parsed.arrangeView, 'arranger');
  assert.equal(parsed.arrangeDiv, 2);
  assert.equal(parsed.arrangeBars, 16);
  assert.equal(parsed.activePatternId, patternId);
  assert.deepEqual(
    parsed.patterns.map((p) => p.id),
    project.patterns.map((p) => p.id),
  );

  const parsedKick = parsed.patterns[0].channels[0];
  assert.equal(parsedKick.name, 'kick A');
  assert.equal(parsedKick.steps[3].velocity, 0.57);
  assert.deepEqual(parsedKick.steps, sourceKick.steps);
  assert.equal(parsed.patterns[0].channels[1].mute, true);

  assert.equal(parsed.arrangement.length, 1);
  assert.equal(parsed.arrangement[0].patternId, patternId);
  assert.equal(parsed.arrangement[0].startSlot, 6);
  assert.equal(parsed.arrangement[0].lengthSlot, 4);

  assert.equal(parsed.arranger.lanes.length, 8);
  assert.equal(parsed.arranger.lanes[2].arrangement.length, 1);
  assert.equal(parsed.arranger.lanes[2].arrangement[0].startSlot, 2);
  assert.equal(parsed.arranger.lanes[2].arrangement[0].lengthSlot, 2);
});

test('bare serialized projects import through the normal migration path', () => {
  const parsed = parseProjectFile(JSON.stringify(serializeProject(createDefaultProject())));

  assert.equal(parsed.version, 5);
  assert.equal(parsed.patterns.length, 5);
  assert.equal(parsed.arrangeBars, 16);
});

test('the localStorage envelope imports like an export file', () => {
  const project = createDefaultProject();
  const stored = JSON.stringify({
    schemaVersion: 1,
    savedAt: '2026-11-14T15:30:00.000Z',
    project: serializeProject(project),
  });

  const parsed = parseProjectFile(stored);

  assert.equal(parsed.patterns.length, project.patterns.length);
  assert.equal(parsed.patterns[0].id, project.patterns[0].id);
});

test('legacy v1 pattern documents still import', () => {
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

  const parsed = parseProjectFile(JSON.stringify(legacy));

  assert.equal(parsed.version, 5);
  assert.equal(parsed.bpm, 110);
  assert.equal(parsed.patterns.length, 1);
  assert.equal(parsed.patterns[0].channels[0].name, 'kick');
  assert.equal(parsed.patterns[0].channels[0].steps[0].velocity, 0.8);
  assert.equal(parsed.arrangement.length, 1);
});

test('invalid files are rejected before any state changes', () => {
  const bad = [
    ['', /not valid JSON/],
    ['   ', /not valid JSON/],
    ['{oops', /not valid JSON/],
    ['[]', /not a magicbeatz project/],
    ['null', /not a magicbeatz project/],
    ['42', /not a magicbeatz project/],
    ['{"hello":1}', /not a magicbeatz project/],
    ['{"project":42}', /not a magicbeatz project/],
    ['{"project":{"foo":1}}', /no grids/],
    ['{"patterns":[]}', /no grids/],
  ];

  for (const [text, pattern] of bad) {
    assert.throws(() => parseProjectFile(text), (err) => {
      assert.ok(err instanceof ProjectFileError, `expected ProjectFileError for ${text}`);
      assert.match(err.message, pattern);
      return true;
    });
  }
});

test('file names are filesystem-safe and follow the active grid', () => {
  const project = createDefaultProject();
  const date = new Date(2026, 10, 14, 15, 30);

  project.patterns[0].name = 'My Grid / Take 2';
  assert.equal(projectFileName(project, date), 'magicbeatz-my-grid-take-2-20261114-1530.json');

  project.patterns[0].name = '***';
  assert.equal(projectFileName(project, date), 'magicbeatz-project-20261114-1530.json');

  project.patterns[0].name = 'Café Groove 🎛';
  assert.equal(projectFileName(project, date), 'magicbeatz-cafe-groove-20261114-1530.json');
});

test('summaries report grid count and timeline length', () => {
  const project = createDefaultProject();
  assert.deepEqual(summarizeProject(project), { grids: 5, bars: 16 });

  project.arrangeBars = 4;
  assert.equal(summarizeProject(project).bars, 4);
});
