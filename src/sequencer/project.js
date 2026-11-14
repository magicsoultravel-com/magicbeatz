/**
 * Project document v6: pattern bank + whole-Grid Arranger layers.
 *
 * A Grid (`patterns[]`) is a complete, independent multi-track pattern. The
 * Arranger is eight independent timeline lanes, each holding whole Grids. A
 * lane clip stores only a `patternId` — never a track or channel — so every
 * active lane plays its entire Grid, and all active layers mix together.
 *
 * v6 keeps one timeline only: the Arranger. A slot is always one bar, so clips
 * use {startSlot, lengthSlot} in whole bars. Older documents are migrated on
 * load: Looper clips move into Layer 1, and sub-bar positions (v3–v5
 * `arrangeDiv` 2/4) collapse to the first occupied sub-slot of each bar. v4
 * channel-filtered lanes cannot be translated into whole-Grid layers and are
 * dropped.
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

export const MAX_ARRANGE_BARS = 64;
/** Fresh projects open with the 16-bar arrangement canvas. */
export const DEFAULT_ARRANGE_BARS = 16;
/** Timeline lengths offered by the position dropdown. */
export const ARRANGE_LENGTH_OPTIONS = [16, 32, 64];
/** The Arranger always exposes exactly eight independent whole-Grid layers. */
export const ARRANGER_LANES = 8;
const ARRANGER_LANE_IDS = Array.from({ length: ARRANGER_LANES }, (_, i) => `lane-${i + 1}`);

/** Build the eight independent whole-Grid layer records. */
export function createArrangerLanes() {
  return ARRANGER_LANE_IDS.map((id) => ({
    id,
    arrangement: [],
  }));
}

/** Clamp any stored arrangement length (in bars) to the supported canvas range. */
export function normalizeArrangeBars(value, fallback = DEFAULT_ARRANGE_BARS) {
  const n = parseInt(value, 10);
  const bars = Number.isFinite(n) ? n : fallback;
  return Math.min(MAX_ARRANGE_BARS, Math.max(1, bars));
}

function slotInt(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

/** Start bar of a clip, accepting legacy bar positions. */
export function clipStartSlot(clip) {
  if (clip?.startSlot != null) return slotInt(clip.startSlot);
  return slotInt(clip?.startBar);
}

/** Length in bars of a clip, accepting legacy bar lengths. */
export function clipLengthSlot(clip) {
  if (clip?.lengthSlot != null) return Math.min(MAX_ARRANGE_BARS, Math.max(1, slotInt(clip.lengthSlot, 1)));
  return Math.min(MAX_ARRANGE_BARS, Math.max(1, slotInt(clip?.lengthBars, 1)));
}

/** Normalise a clip to whole-bar slot fields. */
export function createArrangementClip(partial = {}) {
  return {
    id: partial.id || nextClipId(),
    patternId: partial.patternId,
    startSlot: Math.min(MAX_ARRANGE_BARS - 1, clipStartSlot(partial)),
    lengthSlot: clipLengthSlot(partial),
  };
}

/** Total arrangement length in bars. */
export function arrangementLengthSlots(arrangement) {
  if (!arrangement?.length) return 0;
  return arrangement.reduce(
    (max, clip) => Math.max(max, clipStartSlot(clip) + clipLengthSlot(clip)),
    0,
  );
}

/** Longest end bar across all Arranger lanes. */
export function arrangerLengthSlots(arranger) {
  const lanes = Array.isArray(arranger?.lanes) ? arranger.lanes : [];
  return lanes.reduce(
    (max, lane) => Math.max(max, arrangementLengthSlots(lane?.arrangement)),
    0,
  );
}

/**
 * Arrangement canvas length in bars.
 *
 * `arrangeBars` is the explicit timeline length. Legacy projects without it
 * migrate to the 16-bar canvas, while clips that extend past the stored
 * length still expand it so no painted music is truncated.
 */
export function arrangementBars(project) {
  const clipBars = arrangerLengthSlots(project?.arranger) || 0;
  const stored = parseInt(project?.arrangeBars, 10);
  const fallback = Number.isFinite(stored) ? stored : DEFAULT_ARRANGE_BARS;
  return normalizeArrangeBars(Math.max(fallback, clipBars));
}

const LEGACY_ARRANGE_DIVS = [1, 2, 4];

function legacyArrangeDiv(value) {
  const n = parseInt(value, 10);
  return LEGACY_ARRANGE_DIVS.includes(n) ? n : 4;
}

/** Flatten clips → one patternId (or '') per sub-bar slot. */
function slotsFromArrangement(arrangement, length, div) {
  const d = Math.max(1, parseInt(div, 10) || 1);
  const clips = Array.isArray(arrangement) ? arrangement : [];
  const clipEnd = clips.reduce((max, clip) => {
    const start = clip?.startSlot != null ? slotInt(clip.startSlot) : slotInt(clip.startBar) * d;
    const count = clip?.lengthSlot != null
      ? Math.max(1, slotInt(clip.lengthSlot, 1))
      : Math.max(1, slotInt(clip.lengthBars, 1)) * d;
    return Math.max(max, start + count);
  }, 0);
  const len = Math.max(1, length || clipEnd || 1);
  const slots = Array.from({ length: len }, () => '');
  for (const clip of clips) {
    if (!clip?.patternId) continue;
    const start = clip?.startSlot != null ? slotInt(clip.startSlot) : slotInt(clip.startBar) * d;
    const count = clip?.lengthSlot != null
      ? Math.max(1, slotInt(clip.lengthSlot, 1))
      : Math.max(1, slotInt(clip.lengthBars, 1)) * d;
    for (let k = 0; k < count; k += 1) {
      const i = start + k;
      if (i >= 0 && i < len) slots[i] = clip.patternId;
    }
  }
  return slots;
}

/** Flatten clips → one patternId (or '') per bar. */
export function arrangementToSlots(arrangement, length) {
  return slotsFromArrangement(arrangement, length, 1);
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
      startSlot: i,
      lengthSlot: len,
    }));
    i += len;
  }
  return clips;
}

/**
 * Convert a legacy clip list to whole-bar slots.
 *
 * Sub-bar positions collapse by taking the first occupied sub-slot of each bar,
 * so no bar that had music is lost when 2/4-slots-per-bar projects migrate to
 * the v6 one-slot-per-bar timeline.
 */
export function legacyClipsToBarSlots(clips, div = 4) {
  const d = legacyArrangeDiv(div);
  const source = Array.isArray(clips) ? clips : [];
  const sub = Array.from({ length: MAX_ARRANGE_BARS * d }, () => '');
  for (const clip of source) {
    if (!clip?.patternId) continue;
    const start = clip?.startSlot != null ? slotInt(clip.startSlot) : slotInt(clip.startBar) * d;
    const count = clip?.lengthSlot != null
      ? Math.max(1, slotInt(clip.lengthSlot, 1))
      : Math.max(1, slotInt(clip.lengthBars, 1)) * d;
    for (let k = 0; k < count; k += 1) {
      const i = start + k;
      if (i >= 0 && i < sub.length) sub[i] = clip.patternId;
    }
  }

  const bars = [];
  for (let bar = 0; bar < MAX_ARRANGE_BARS; bar += 1) {
    let id = '';
    for (let k = 0; k < d; k += 1) {
      const value = sub[bar * d + k];
      if (value) {
        id = value;
        break;
      }
    }
    bars.push(id);
  }
  while (bars.length && !bars[bars.length - 1]) bars.pop();
  return bars;
}

/**
 * Convert lane clip arrays to editable slot arrays.
 * Lane ids are preserved; clips stay whole-Grid references.
 */
export function arrangerLanesToSlots(arranger, length) {
  const lanes = Array.isArray(arranger?.lanes) ? arranger.lanes : [];
  return Array.from({ length: ARRANGER_LANES }, (_, index) => {
    const lane = lanes[index] || {};
    return {
      id: lane.id || ARRANGER_LANE_IDS[index],
      slots: arrangementToSlots(lane.arrangement, length),
    };
  });
}

/** Regenerate lane clip arrays from editable slot arrays. */
export function arrangerSlotsToLanes(lanes) {
  const source = Array.isArray(lanes) ? lanes : [];
  return {
    lanes: Array.from({ length: ARRANGER_LANES }, (_, index) => {
      const lane = source[index] || {};
      return {
        id: lane.id || ARRANGER_LANE_IDS[index],
        arrangement: slotsToArrangement(Array.isArray(lane.slots) ? lane.slots : []),
      };
    }),
  };
}

/** Parse stored layer records, preserving lane ids and dropping stale clips. */
export function normalizeArrangerLanes(raw, patterns = []) {
  const source = Array.isArray(raw?.lanes) ? raw.lanes : [];
  return {
    lanes: Array.from({ length: ARRANGER_LANES }, (_, index) => {
      const lane = source[index] || {};
      const arrangement = Array.isArray(lane.arrangement) ? lane.arrangement : [];
      return {
        id: lane.id || ARRANGER_LANE_IDS[index],
        arrangement: arrangement
          .filter((c) => patterns.some((p) => p.id === c.patternId))
          .filter((c) => clipStartSlot(c) < MAX_ARRANGE_BARS)
          .map((c) => createArrangementClip(c)),
      };
    }),
  };
}

export function getActivePattern(project) {
  return project.patterns.find((p) => p.id === project.activePatternId) || project.patterns[0] || null;
}

/**
 * Resolve the eight Arranger layers for one global step.
 *
 * Every layer owns its own clip sequence and local step, and resolves a whole
 * Grid (`pattern`) rather than a single channel. Layers are independent: the
 * same Grid may sound on several layers at once, and nothing is deduplicated.
 * A timeline slot is always one bar.
 *
 * @param {object} project
 * @param {number} globalStep
 * @param {number} [totalBarsOverride] prefer canvas length when trailing rests exist
 */
export function resolveArrangerStep(project, globalStep, totalBarsOverride) {
  const beats = beatsFromTimeSignature(project.timeSignature);
  const barSteps = stepsPerBar(beats);
  const totalBars = Math.max(
    1,
    totalBarsOverride || 0,
    arrangerLengthSlots(project?.arranger),
  );
  const totalStepsCount = totalBars * barSteps;
  if (totalStepsCount <= 0) return Array(ARRANGER_LANES).fill(null);

  const step = ((globalStep % totalStepsCount) + totalStepsCount) % totalStepsCount;
  const slotIndex = Math.floor(step / barSteps);
  const stepInSlot = step % barSteps;
  const globalBar = slotIndex;
  const lanes = Array.isArray(project?.arranger?.lanes) ? project.arranger.lanes : [];

  return Array.from({ length: ARRANGER_LANES }, (_, laneIndex) => {
    const lane = lanes[laneIndex];
    if (!lane) return null;
    const clip = [...(lane.arrangement || [])]
      .sort((a, b) => clipStartSlot(a) - clipStartSlot(b))
      .find((c) => {
        const start = clipStartSlot(c);
        return slotIndex >= start && slotIndex < start + clipLengthSlot(c);
      });
    if (!clip) return null;

    const pattern = project.patterns.find((p) => p.id === clip.patternId);
    if (!pattern) return null;

    const clipStartStep = clipStartSlot(clip) * barSteps;
    const patternSteps = Math.max(1, (pattern.bars || 1) * barSteps);
    const localStep = ((step - clipStartStep) % patternSteps + patternSteps) % patternSteps;

    return {
      pattern,
      localStep,
      clip,
      globalBar,
      slotIndex,
      stepInSlot,
      globalStep: step,
      laneId: lane.id,
      laneIndex,
    };
  });
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

  // Fresh projects open on an eight-track starting point; presets remain
  // available as additional clips. Add/remove tracks freely from here.
  const starter = createEmptyPattern({
    name: '8-track template',
    bars: 1,
    timeSignature,
  });

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

  return [starter, rock, funk, ballad, vamp];
}

export function createDefaultProject() {
  const timeSignature = [4, 4];
  const patterns = buildPresetPatterns(timeSignature);
  // The first preset is the eight-track starter so a fresh project opens editable.
  const active = patterns[0];
  const lanes = createArrangerLanes();
  // Layer 1 starts with the active Grid in bar 1; layers 2–8 stay empty.
  lanes[0].arrangement = [
    createArrangementClip({
      patternId: active.id,
      startSlot: 0,
      lengthSlot: active.bars,
    }),
  ];
  return {
    version: 6,
    bpm: 120,
    timeSignature,
    swing: 0,
    patterns,
    activePatternId: active.id,
    arranger: { lanes },
    arrangeBars: DEFAULT_ARRANGE_BARS,
    arrangeLoop: true,
    playMode: 'pattern', // 'pattern' | 'song'
  };
}

export function serializeProject(project) {
  const arranger = normalizeArrangerLanes(project.arranger, project.patterns);
  return {
    version: 6,
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
    arranger: {
      lanes: arranger.lanes.map((lane) => ({
        id: lane.id,
        arrangement: lane.arrangement.map((c) => ({
          id: c.id,
          patternId: c.patternId,
          startSlot: c.startSlot,
          lengthSlot: c.lengthSlot,
        })),
      })),
    },
    arrangeBars: arrangementBars(project),
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
  const lanes = createArrangerLanes();
  lanes[0].arrangement = [
    createArrangementClip({
      patternId: pattern.id,
      startSlot: 0,
      lengthSlot: pattern.bars,
    }),
  ];
  return {
    version: 6,
    bpm: legacy.bpm,
    timeSignature: legacy.timeSignature,
    swing: legacy.swing,
    patterns: [pattern],
    activePatternId: pattern.id,
    arranger: { lanes },
    arrangeBars: DEFAULT_ARRANGE_BARS,
    arrangeLoop: true,
    playMode: 'pattern',
  };
}

export function parseProject(raw) {
  if (!raw || typeof raw !== 'object') return createDefaultProject();

  if (![2, 3, 4, 5, 6].includes(parseInt(raw.version, 10))
    && Array.isArray(raw.channels) && !Array.isArray(raw.patterns)) {
    return migrateV1ToProject(raw);
  }

  const version = parseInt(raw.version, 10) || 0;
  const bpm = clampBpm(raw.bpm ?? 120);
  const swing = clamp01(raw.swing ?? 0);
  let timeSignature = [4, 4];
  if (Array.isArray(raw.timeSignature) && raw.timeSignature.length >= 2) {
    timeSignature = [
      Math.max(1, parseInt(raw.timeSignature[0], 10) || 4),
      Math.max(1, parseInt(raw.timeSignature[1], 10) || 4),
    ];
  }

  // v6 stores whole bars. Older documents store sub-bar slots, so their clips
  // are converted to bars on the way in (v2 bar clips and v3–v5 `arrangeDiv`).
  const sourceDiv = version >= 6 ? 1 : legacyArrangeDiv(raw.arrangeDiv);

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

  const hasPattern = (clip) => patterns.some((p) => p.id === clip?.patternId);
  const rawArrangement = Array.isArray(raw.arrangement) ? raw.arrangement : null;
  const sourceArranger = raw.arranger && typeof raw.arranger === 'object' ? raw.arranger : null;
  const sourceLanes = Array.isArray(sourceArranger?.lanes) ? sourceArranger.lanes : [];

  // Start from the stored Arranger layers (v5+). v4 channel-filtered lanes are
  // dropped because they cannot be translated into whole-Grid layers.
  const laneSlots = Array.from({ length: ARRANGER_LANES }, () => []);
  if (version >= 5) {
    for (let i = 0; i < ARRANGER_LANES; i += 1) {
      const clips = Array.isArray(sourceLanes[i]?.arrangement)
        ? sourceLanes[i].arrangement.filter(hasPattern)
        : [];
      laneSlots[i] = legacyClipsToBarSlots(clips, sourceDiv);
    }
  }

  // The old single Looper timeline becomes Layer 1. Existing layer clips win
  // where they overlap so no Arranger content is overwritten.
  if (rawArrangement) {
    const looperSlots = legacyClipsToBarSlots(rawArrangement.filter(hasPattern), sourceDiv);
    for (let i = 0; i < looperSlots.length; i += 1) {
      if (!laneSlots[0][i]) laneSlots[0][i] = looperSlots[i];
    }
  }

  // Documents without any timeline field always get a starter clip. Explicitly
  // cleared timelines (present but empty) stay empty.
  if (!rawArrangement && !sourceArranger) {
    const activeBars = patterns.find((p) => p.id === activePatternId)?.bars || 1;
    for (let i = 0; i < activeBars; i += 1) laneSlots[0][i] = activePatternId;
  }

  const lanes = createArrangerLanes();
  lanes.forEach((lane, index) => {
    lane.arrangement = slotsToArrangement(laneSlots[index]);
    if (sourceLanes[index]?.id) lane.id = sourceLanes[index].id;
  });
  const arranger = { lanes };

  // Migration: legacy documents open on the 16-bar canvas. Explicit lengths are
  // preserved, and clips beyond the stored end expand it.
  const arrangeBars = arrangementBars({
    arrangeBars: raw.arrangeBars,
    arranger,
  });

  return {
    version: 6,
    bpm,
    timeSignature,
    swing,
    patterns,
    activePatternId,
    arranger,
    arrangeBars,
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
  // Grids are independent: a copy gets fresh channel ids. Arranger layers point
  // at whole Grids, so nothing outside the new Grid needs to keep these ids.
  const copy = parsePatternChannels({
    ...pattern,
    id: nextPatternId(),
    name: name || `${pattern.name} copy`,
    channels: pattern.channels.map((ch) => {
      const { id, ...rest } = serializeChannel(ch);
      return rest;
    }),
  });
  return copy;
}
