/**
 * Project document v2: pattern bank + arrangement playlist.
 */
import {
  STORAGE_KEY,
  MAX_BARS,
  STEPS_PER_BEAT,
  clampBpm,
  clamp01,
  beatsFromTimeSignature,
  totalSteps,
  createEmptyPattern,
  createChannel,
  createStep,
  serializeChannel,
  parsePatternChannels,
  parsePattern,
  nextPatternId,
  nextClipId,
  resizePatternSteps,
  DEFAULT_VELOCITY,
} from './pattern.js';

export function createArrangementClip(partial = {}) {
  return {
    id: partial.id || nextClipId(),
    patternId: partial.patternId,
    startBar: Math.max(0, parseInt(partial.startBar, 10) || 0),
    lengthBars: Math.min(MAX_BARS, Math.max(1, parseInt(partial.lengthBars, 10) || 1)),
  };
}

export function arrangementLengthBars(arrangement) {
  if (!arrangement?.length) return 0;
  return arrangement.reduce((max, clip) => Math.max(max, clip.startBar + clip.lengthBars), 0);
}

export const MAX_ARRANGE_BARS = 16;

/** Flatten clips → one patternId (or '') per bar slot. */
export function arrangementToSlots(arrangement, length) {
  const len = Math.max(1, length || arrangementLengthBars(arrangement) || 1);
  const slots = Array.from({ length: len }, () => '');
  for (const clip of arrangement || []) {
    if (!clip?.patternId) continue;
    for (let b = 0; b < clip.lengthBars; b += 1) {
      const i = clip.startBar + b;
      if (i >= 0 && i < len) slots[i] = clip.patternId;
    }
  }
  return slots;
}

/** Merge contiguous identical pattern ids into arrangement clips. */
export function slotsToArrangement(slots) {
  const clips = [];
  let i = 0;
  while (i < slots.length) {
    const id = slots[i];
    if (!id) {
      i += 1;
      continue;
    }
    let len = 1;
    while (i + len < slots.length && slots[i + len] === id) len += 1;
    clips.push(createArrangementClip({
      patternId: id,
      startBar: i,
      lengthBars: len,
    }));
    i += len;
  }
  return clips;
}

export function ensureArrangementSlots(project, minBars = 1) {
  const currentLen = Math.max(
    minBars,
    arrangementLengthBars(project.arrangement),
    1,
  );
  const slots = arrangementToSlots(project.arrangement, currentLen);
  project.arrangement = slotsToArrangement(slots);
  return slots;
}

/**
 * Resolve global step → active pattern + local step (Song mode).
 * @param {object} project
 * @param {number} globalStep
 * @param {number} [totalBarsOverride] prefer arrangement slot count when trailing empties exist
 * @returns {{ pattern: object, localStep: number, clip: object, globalBar: number, globalStep: number } | null}
 */
export function resolveArrangementStep(project, globalStep, totalBarsOverride) {
  const beats = beatsFromTimeSignature(project.timeSignature);
  const stepsPerBarCount = beats * STEPS_PER_BEAT;
  const totalBars = Math.max(
    1,
    totalBarsOverride || 0,
    arrangementLengthBars(project.arrangement),
  );
  const totalStepsCount = totalBars * stepsPerBarCount;
  if (totalStepsCount <= 0) return null;

  const step = ((globalStep % totalStepsCount) + totalStepsCount) % totalStepsCount;
  const globalBar = Math.floor(step / stepsPerBarCount);
  const stepInBar = step % stepsPerBarCount;

  const clip = [...project.arrangement]
    .sort((a, b) => a.startBar - b.startBar)
    .find((c) => globalBar >= c.startBar && globalBar < c.startBar + c.lengthBars);

  if (!clip) return null;
  const pattern = project.patterns.find((p) => p.id === clip.patternId);
  if (!pattern) return null;

  const localBar = (globalBar - clip.startBar) % Math.max(1, pattern.bars);
  const localStep = localBar * stepsPerBarCount + stepInBar;
  return { pattern, localStep, clip, globalBar, globalStep: step };
}

export function getActivePattern(project) {
  return project.patterns.find((p) => p.id === project.activePatternId) || project.patterns[0] || null;
}

export function setStepOn(channel, index, on, velocity = DEFAULT_VELOCITY) {
  if (!channel.steps[index] && index < channel.steps.length) {
    /* ok */
  }
  if (index < 0 || index >= channel.steps.length) return;
  channel.steps[index] = on ? createStep(velocity) : null;
}

function paintSteps(channel, indices, velocity = DEFAULT_VELOCITY) {
  for (const i of indices) {
    if (i >= 0 && i < channel.steps.length) channel.steps[i] = createStep(velocity);
  }
}

/** Built-in preset patterns for new projects. */
export function buildPresetPatterns(timeSignature = [4, 4]) {
  const beats = beatsFromTimeSignature(timeSignature);

  function drumPattern(name, { kick = [], snare = [], hat = [], openHat = [] }, bars = 1) {
    const len = totalSteps(bars, beats);
    const kickCh = createChannel({
      type: 'percussion', voiceId: 'kick', name: 'kick',
      steps: Array.from({ length: len }, () => null),
    });
    const snareCh = createChannel({
      type: 'percussion', voiceId: 'snare', name: 'snare',
      steps: Array.from({ length: len }, () => null),
    });
    const hatCh = createChannel({
      type: 'percussion', voiceId: 'closed-hat', name: 'hat',
      steps: Array.from({ length: len }, () => null),
    });
    const openCh = createChannel({
      type: 'percussion', voiceId: 'open-hat', name: 'open hat',
      steps: Array.from({ length: len }, () => null),
    });
    paintSteps(kickCh, kick);
    paintSteps(snareCh, snare);
    paintSteps(hatCh, hat);
    paintSteps(openCh, openHat);
    return createEmptyPattern({
      name,
      bars,
      channels: [kickCh, snareCh, hatCh, openCh],
    });
  }

  // 16th indices in one bar of 4/4
  const rock = drumPattern('Rock drums', {
    kick: [0, 8],
    snare: [4, 12],
    hat: [0, 2, 4, 6, 8, 10, 12, 14],
  });

  const funk = drumPattern('Funk drums', {
    kick: [0, 6, 10],
    snare: [4, 12],
    hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    openHat: [15],
  });

  const ballad = drumPattern('Ballad drums', {
    kick: [0, 8],
    snare: [8],
    hat: [0, 4, 8, 12],
  });

  // Bass + chord vamp (1 bar)
  const len = totalSteps(1, beats);
  const bass = createChannel({
    type: 'note',
    pitch: 'C',
    octave: 2,
    instrumentId: 'bass-sub',
    name: 'bass',
    steps: Array.from({ length: len }, () => null),
  });
  paintSteps(bass, [0, 8], 0.9);
  bass.steps[4] = createStep(0.7);
  // change pitch mid-bar via separate approach: keep single pitch; use degrees on chord

  const chords = createChannel({
    type: 'chord',
    chordMode: 'degree',
    degree: 0,
    scaleKey: 'Ionian',
    instrumentId: 'keys-pluck',
    name: 'I chord',
    steps: Array.from({ length: len }, () => null),
  });
  paintSteps(chords, [0, 8], 0.85);

  const hat = createChannel({
    type: 'percussion',
    voiceId: 'closed-hat',
    name: 'hat',
    steps: Array.from({ length: len }, () => null),
  });
  paintSteps(hat, [0, 4, 8, 12], 0.6);

  const vamp = createEmptyPattern({
    name: 'Bass + I vamp',
    bars: 1,
    channels: [hat, bass, chords],
  });

  return [rock, funk, ballad, vamp];
}

export function createDefaultProject() {
  const timeSignature = [4, 4];
  const patterns = buildPresetPatterns(timeSignature);
  // Also ensure a blank editable starter at front? Plan says seed presets — use rock as first active
  const active = patterns[0];
  return {
    version: 2,
    bpm: 120,
    timeSignature,
    swing: 0,
    patterns,
    activePatternId: active.id,
    arrangement: [
      createArrangementClip({ patternId: active.id, startBar: 0, lengthBars: active.bars }),
    ],
    arrangeLoop: true,
    playMode: 'pattern', // 'pattern' | 'song'
  };
}

export function serializeProject(project) {
  return {
    version: 2,
    bpm: project.bpm,
    timeSignature: project.timeSignature,
    swing: project.swing,
    patterns: project.patterns.map((p) => ({
      id: p.id,
      name: p.name,
      bars: p.bars,
      channels: p.channels.map(serializeChannel),
    })),
    activePatternId: project.activePatternId,
    arrangement: project.arrangement.map((c) => ({
      id: c.id,
      patternId: c.patternId,
      startBar: c.startBar,
      lengthBars: c.lengthBars,
    })),
    arrangeLoop: !!project.arrangeLoop,
    playMode: project.playMode === 'song' ? 'song' : 'pattern',
  };
}

export function migrateV1ToProject(raw) {
  const legacy = parsePattern(raw);
  if (!legacy) return createDefaultProject();
  const pattern = parsePatternChannels({
    id: nextPatternId(),
    name: 'Pattern 1',
    bars: legacy.bars,
    channels: legacy.channels,
  }, legacy.timeSignature);
  return {
    version: 2,
    bpm: legacy.bpm,
    timeSignature: legacy.timeSignature,
    swing: legacy.swing,
    patterns: [pattern],
    activePatternId: pattern.id,
    arrangement: [
      createArrangementClip({ patternId: pattern.id, startBar: 0, lengthBars: pattern.bars }),
    ],
    arrangeLoop: true,
    playMode: 'pattern',
  };
}

export function parseProject(raw) {
  if (!raw || typeof raw !== 'object') return createDefaultProject();

  if (raw.version !== 2 && Array.isArray(raw.channels) && !Array.isArray(raw.patterns)) {
    return migrateV1ToProject(raw);
  }

  const bpm = clampBpm(raw.bpm ?? 120);
  const swing = clamp01(raw.swing ?? 0);
  let timeSignature = [4, 4];
  if (Array.isArray(raw.timeSignature) && raw.timeSignature.length >= 2) {
    timeSignature = [
      Math.max(1, parseInt(raw.timeSignature[0], 10) || 4),
      Math.max(1, parseInt(raw.timeSignature[1], 10) || 4),
    ];
  }

  let patterns = Array.isArray(raw.patterns) && raw.patterns.length
    ? raw.patterns.map((p) => parsePatternChannels(p, timeSignature))
    : buildPresetPatterns(timeSignature);

  for (const p of patterns) {
    resizePatternSteps(p, timeSignature);
  }

  let activePatternId = raw.activePatternId;
  if (!patterns.some((p) => p.id === activePatternId)) {
    activePatternId = patterns[0].id;
  }

  let arrangement = Array.isArray(raw.arrangement) && raw.arrangement.length
    ? raw.arrangement
      .filter((c) => patterns.some((p) => p.id === c.patternId))
      .map((c) => createArrangementClip(c))
    : [createArrangementClip({
      patternId: activePatternId,
      startBar: 0,
      lengthBars: patterns.find((p) => p.id === activePatternId)?.bars || 1,
    })];

  if (!arrangement.length) {
    arrangement = [createArrangementClip({
      patternId: activePatternId,
      startBar: 0,
      lengthBars: 1,
    })];
  }

  return {
    version: 2,
    bpm,
    timeSignature,
    swing,
    patterns,
    activePatternId,
    arrangement,
    arrangeLoop: raw.arrangeLoop !== false,
    playMode: raw.playMode === 'song' ? 'song' : 'pattern',
  };
}

export function loadProject() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultProject();
    return parseProject(JSON.parse(raw));
  } catch {
    return createDefaultProject();
  }
}

export function saveProject(project) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeProject(project)));
  } catch {
    /* ignore */
  }
}

export function duplicatePattern(pattern, name) {
  const copy = parsePatternChannels({
    ...pattern,
    id: nextPatternId(),
    name: name || `${pattern.name} copy`,
    channels: pattern.channels.map((ch) => ({
      ...serializeChannel(ch),
      id: undefined,
    })),
  });
  return copy;
}

export function appendArrangementClip(project, patternId) {
  const pattern = project.patterns.find((p) => p.id === patternId);
  if (!pattern) return null;
  const start = project.arrangement.length
    ? arrangementLengthBars(project.arrangement)
    : 0;
  const clip = createArrangementClip({
    patternId,
    startBar: start,
    lengthBars: pattern.bars,
  });
  project.arrangement.push(clip);
  return clip;
}
