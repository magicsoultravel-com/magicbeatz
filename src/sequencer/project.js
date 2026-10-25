/**
 * Project document v3: pattern bank + slot-resolution arrangement playlist.
 *
 * v2 stored arrangement clips in whole bars ({startBar, lengthBars}). v3 keeps
 * the same clip shape but positions them in *slots* ({startSlot, lengthSlot})
 * so several clips can share one bar. `arrangeDiv` = slots per bar (1/2/4);
 * migration from v2 multiplies old bar positions by `arrangeDiv`, so an old
 * project plays back at exactly the same time.
 */
import {
  STORAGE_KEY,
  clampBpm,
  clamp01,
  beatsFromTimeSignature,
  stepsPerBar,
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

export const MAX_ARRANGE_BARS = 16;
/** Slot resolutions per bar: 1 = bar clip, 2 = half bar, 4 = beat. */
export const ARRANGE_DIVS = [1, 2, 4];
export const DEFAULT_ARRANGE_DIV = 4;
export const MAX_ARRANGE_SLOTS = MAX_ARRANGE_BARS * DEFAULT_ARRANGE_DIV;

/** Coerce any stored value to a supported slots-per-bar resolution. */
export function normalizeArrangeDiv(value) {
  const n = parseInt(value, 10);
  return ARRANGE_DIVS.includes(n) ? n : DEFAULT_ARRANGE_DIV;
}

function slotInt(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

/** Start slot of a clip, accepting legacy bar positions. */
export function clipStartSlot(clip, div = DEFAULT_ARRANGE_DIV) {
  if (clip?.startSlot != null) return slotInt(clip.startSlot);
  return slotInt(clip?.startBar) * normalizeArrangeDiv(div);
}

/** Length in slots of a clip, accepting legacy bar lengths. */
export function clipLengthSlot(clip, div = DEFAULT_ARRANGE_DIV) {
  const max = MAX_ARRANGE_SLOTS;
  if (clip?.lengthSlot != null) return Math.min(max, Math.max(1, slotInt(clip.lengthSlot, 1)));
  return Math.min(max, Math.max(1, slotInt(clip?.lengthBars, 1))) * normalizeArrangeDiv(div);
}

/** Normalise a clip to slot fields (migrates bar-based clips on the way in). */
export function createArrangementClip(partial = {}, div = DEFAULT_ARRANGE_DIV) {
  return {
    id: partial.id || nextClipId(),
    patternId: partial.patternId,
    startSlot: clipStartSlot(partial, div),
    lengthSlot: clipLengthSlot(partial, div),
  };
}

/** Total arrangement length in slots. */
export function arrangementLengthSlots(arrangement, div = DEFAULT_ARRANGE_DIV) {
  if (!arrangement?.length) return 0;
  return arrangement.reduce(
    (max, clip) => Math.max(max, clipStartSlot(clip, div) + clipLengthSlot(clip, div)),
    0,
  );
}

/** Total arrangement length in bars (rounded up when clips end mid-bar). */
export function arrangementLengthBars(arrangement, div = DEFAULT_ARRANGE_DIV) {
  const d = normalizeArrangeDiv(div);
  return Math.ceil(arrangementLengthSlots(arrangement, d) / d);
}

/** Flatten clips → one patternId (or '') per arrangement slot. */
export function arrangementToSlots(arrangement, length, div = DEFAULT_ARRANGE_DIV) {
  const d = normalizeArrangeDiv(div);
  const len = Math.max(1, length || arrangementLengthSlots(arrangement, d) || 1);
  const slots = Array.from({ length: len }, () => '');
  for (const clip of arrangement || []) {
    if (!clip?.patternId) continue;
    const start = clipStartSlot(clip, d);
    const count = clipLengthSlot(clip, d);
    for (let k = 0; k < count; k += 1) {
      const i = start + k;
      if (i >= 0 && i < len) slots[i] = clip.patternId;
    }
  }
  return slots;
}

/** Merge contiguous identical pattern ids into arrangement clips. */
export function slotsToArrangement(slots, div = DEFAULT_ARRANGE_DIV) {
  const d = normalizeArrangeDiv(div);
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
      startSlot: i,
      lengthSlot: len,
    }, d));
    i += len;
  }
  return clips;
}

/**
 * Re-grid slots when the slots-per-bar resolution changes.
 * Finer grids duplicate the source slot; coarser grids keep the first
 * sub-slot of each group. Length is clamped to MAX_ARRANGE_BARS bars.
 */
export function resampleSlots(slots, fromDiv, toDiv, maxBars = MAX_ARRANGE_BARS) {
  const from = normalizeArrangeDiv(fromDiv);
  const to = normalizeArrangeDiv(toDiv);
  const src = Array.isArray(slots) ? slots : [];
  if (from === to) return src.slice();
  const factor = to / from;
  const targetLen = Math.max(
    to,
    Math.min(maxBars * to, Math.round((src.length || from) * factor)),
  );
  const out = [];
  for (let i = 0; i < targetLen; i += 1) {
    const idx = to >= from ? Math.floor(i / factor) : i * (from / to);
    out.push(src[idx] || '');
  }
  return out;
}

export function ensureArrangementSlots(project, minBars = 1) {
  const d = normalizeArrangeDiv(project.arrangeDiv);
  const currentLen = Math.max(
    minBars * d,
    arrangementLengthSlots(project.arrangement, d),
    1,
  );
  const slots = arrangementToSlots(project.arrangement, currentLen, d);
  project.arrangement = slotsToArrangement(slots, d);
  return slots;
}

/**
 * Resolve global step → active pattern + local step (Song mode).
 * @param {object} project
 * @param {number} globalStep
 * @param {number} [totalSlotsOverride] prefer slot count when trailing rests exist
 * @returns {{ pattern: object, localStep: number, clip: object, globalBar: number,
 *   slotIndex: number, stepInSlot: number, globalStep: number } | null}
 */
export function resolveArrangementStep(project, globalStep, totalSlotsOverride) {
  const beats = beatsFromTimeSignature(project.timeSignature);
  const div = normalizeArrangeDiv(project.arrangeDiv);
  const barSteps = stepsPerBar(beats);
  const slotSteps = Math.max(1, Math.round(barSteps / div));
  const totalSlots = Math.max(
    1,
    totalSlotsOverride || 0,
    arrangementLengthSlots(project.arrangement, div),
  );
  const totalStepsCount = totalSlots * slotSteps;
  if (totalStepsCount <= 0) return null;

  const step = ((globalStep % totalStepsCount) + totalStepsCount) % totalStepsCount;
  const slotIndex = Math.floor(step / slotSteps);
  const stepInSlot = step % slotSteps;
  const globalBar = Math.floor(step / barSteps);

  const clip = [...project.arrangement]
    .sort((a, b) => clipStartSlot(a, div) - clipStartSlot(b, div))
    .find((c) => {
      const start = clipStartSlot(c, div);
      return slotIndex >= start && slotIndex < start + clipLengthSlot(c, div);
    });

  if (!clip) return null;
  const pattern = project.patterns.find((p) => p.id === clip.patternId);
  if (!pattern) return null;

  // Local step is relative to the clip start, then wrapped by the pattern
  // length so a 1-bar clip can repeat inside a longer arrangement clip.
  const clipStartStep = clipStartSlot(clip, div) * slotSteps;
  const patternSteps = Math.max(1, (pattern.bars || 1) * barSteps);
  const localStep = ((step - clipStartStep) % patternSteps + patternSteps) % patternSteps;

  return { pattern, localStep, clip, globalBar, slotIndex, stepInSlot, globalStep: step };
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
  const arrangeDiv = DEFAULT_ARRANGE_DIV;
  return {
    version: 3,
    bpm: 120,
    timeSignature,
    swing: 0,
    patterns,
    activePatternId: active.id,
    arrangement: [
      createArrangementClip({
        patternId: active.id,
        startSlot: 0,
        lengthSlot: active.bars * arrangeDiv,
      }, arrangeDiv),
    ],
    arrangeDiv,
    arrangeLoop: true,
    playMode: 'pattern', // 'pattern' | 'song'
  };
}

export function serializeProject(project) {
  return {
    version: 3,
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
      startSlot: c.startSlot,
      lengthSlot: c.lengthSlot,
    })),
    arrangeDiv: normalizeArrangeDiv(project.arrangeDiv),
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
  const arrangeDiv = DEFAULT_ARRANGE_DIV;
  return {
    version: 3,
    bpm: legacy.bpm,
    timeSignature: legacy.timeSignature,
    swing: legacy.swing,
    patterns: [pattern],
    activePatternId: pattern.id,
    arrangement: [
      createArrangementClip({
        patternId: pattern.id,
        startSlot: 0,
        lengthSlot: pattern.bars * arrangeDiv,
      }, arrangeDiv),
    ],
    arrangeDiv,
    arrangeLoop: true,
    playMode: 'pattern',
  };
}

export function parseProject(raw) {
  if (!raw || typeof raw !== 'object') return createDefaultProject();

  if (raw.version !== 2 && raw.version !== 3
    && Array.isArray(raw.channels) && !Array.isArray(raw.patterns)) {
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

  // Slots-per-bar resolution. v2 projects have no field → 4, and their
  // bar-based clips are multiplied by 4 on the way in (same wall-clock time).
  const arrangeDiv = normalizeArrangeDiv(raw.arrangeDiv);

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

  const rawArrangement = Array.isArray(raw.arrangement) ? raw.arrangement : null;
  let arrangement = rawArrangement
    ? rawArrangement
      .filter((c) => patterns.some((p) => p.id === c.patternId))
      .filter((c) => clipStartSlot(c, arrangeDiv) < MAX_ARRANGE_SLOTS)
      .map((c) => createArrangementClip(c, arrangeDiv))
    : [createArrangementClip({
      patternId: activePatternId,
      startSlot: 0,
      lengthSlot: (patterns.find((p) => p.id === activePatternId)?.bars || 1) * arrangeDiv,
    }, arrangeDiv)];

  // v3 keeps an explicitly cleared timeline empty; older documents without an
  // arrangement field always get a starter clip.
  if (!arrangement.length && !rawArrangement) {
    arrangement = [createArrangementClip({
      patternId: activePatternId,
      startSlot: 0,
      lengthSlot: arrangeDiv,
    }, arrangeDiv)];
  }

  return {
    version: 3,
    bpm,
    timeSignature,
    swing,
    patterns,
    activePatternId,
    arrangement,
    arrangeDiv,
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
  const div = normalizeArrangeDiv(project.arrangeDiv);
  const start = Math.min(
    MAX_ARRANGE_SLOTS - 1,
    arrangementLengthSlots(project.arrangement, div),
  );
  const clip = createArrangementClip({
    patternId,
    startSlot: start,
    lengthSlot: Math.min(MAX_ARRANGE_SLOTS - start, pattern.bars * div),
  }, div);
  project.arrangement.push(clip);
  return clip;
}
