/** Pattern / channel model helpers for magicBeatz. */

export const STORAGE_KEY = 'guitarsuite-magicbeatz';
export const STEPS_PER_BEAT = 4;
export const MAX_BARS = 4;
export const DEFAULT_VELOCITY = 0.8;
export const DEFAULT_GAIN = 0.8;

export const CHANNEL_TYPES = ['percussion', 'note', 'chord'];

export const INSTRUMENT_OPTIONS = [
  { id: 'piano', label: 'piano', banks: ['note', 'chord'] },
  { id: 'steel-drum', label: 'steel drum', banks: ['note'] },
  { id: 'guitar', label: 'guitar', banks: ['note', 'chord'] },
  { id: 'bass-sub', label: 'bass sub', banks: ['note'] },
  { id: 'bass-growl', label: 'bass growl', banks: ['note'] },
  { id: 'bass-pluck', label: 'bass pluck', banks: ['note'] },
  { id: 'bass-finger', label: 'bass finger', banks: ['note'] },
  { id: 'strings', label: 'strings', banks: ['note', 'chord'] },
  { id: 'violin', label: 'violin', banks: ['note'] },
  { id: 'keys-pluck', label: 'keys', banks: ['note', 'chord'] },
  { id: 'keys-pad', label: 'pad', banks: ['note', 'chord'] },
  { id: 'keys-bell', label: 'bell', banks: ['note', 'chord'] },
  { id: 'lead-square', label: 'lead sq', banks: ['note'] },
  { id: 'lead-saw', label: 'lead saw', banks: ['note'] },
];

let idCounter = 0;

export function nextId(prefix = 'id') {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

export function nextChannelId() {
  return nextId('ch');
}

export function nextPatternId() {
  return nextId('pat');
}

export function nextClipId() {
  return nextId('clip');
}

export function stepsPerBar(beatsPerMeasure = 4) {
  return Math.max(1, beatsPerMeasure) * STEPS_PER_BEAT;
}

export function totalSteps(bars = 1, beatsPerMeasure = 4) {
  return Math.max(1, bars) * stepsPerBar(beatsPerMeasure);
}

export function createStep(velocity = DEFAULT_VELOCITY) {
  return { velocity: clamp01(velocity) };
}

export function defaultInstrumentForType(type) {
  if (type === 'note') return 'bass-sub';
  if (type === 'chord') return 'keys-pluck';
  return '';
}

export function createChannel(partial = {}) {
  const type = CHANNEL_TYPES.includes(partial.type) ? partial.type : 'percussion';
  const instrumentId = partial.instrumentId
    || (type === 'percussion' ? '' : defaultInstrumentForType(type));
  return {
    id: partial.id || nextChannelId(),
    name: partial.name || '',
    type,
    bankId: partial.bankId || (type === 'percussion' ? 'percussion' : type),
    voiceId: partial.voiceId || '',
    instrumentId,
    gain: clamp01(partial.gain ?? DEFAULT_GAIN),
    mute: !!partial.mute,
    solo: !!partial.solo,
    steps: Array.isArray(partial.steps) ? partial.steps.map(normalizeStep) : [],
    pitch: partial.pitch || 'C',
    octave: partial.octave ?? (type === 'note' && String(instrumentId).startsWith('bass') ? 2 : 4),
    chordMode: partial.chordMode === 'degree' ? 'degree' : 'named',
    chordName: partial.chordName || '',
    scaleKey: partial.scaleKey || 'Ionian',
    degree: partial.degree ?? 0,
  };
}

function normalizeStep(step) {
  if (!step) return null;
  if (typeof step === 'object' && step.velocity != null) {
    return createStep(step.velocity);
  }
  if (step === true || step === 1) return createStep(DEFAULT_VELOCITY);
  return null;
}

export function serializeChannel(ch) {
  return {
    id: ch.id,
    name: ch.name,
    type: ch.type,
    bankId: ch.bankId,
    voiceId: ch.voiceId,
    instrumentId: ch.instrumentId,
    gain: ch.gain,
    mute: ch.mute,
    solo: ch.solo,
    steps: ch.steps.map((s) => (s ? { velocity: s.velocity } : null)),
    pitch: ch.pitch,
    octave: ch.octave,
    chordMode: ch.chordMode,
    chordName: ch.chordName,
    scaleKey: ch.scaleKey,
    degree: ch.degree,
  };
}

/** Empty drum-oriented pattern shell (no preset hits). */
export function createEmptyPattern(partial = {}) {
  const beatsPerMeasure = Array.isArray(partial.timeSignature)
    ? partial.timeSignature[0]
    : 4;
  const bars = Math.min(MAX_BARS, Math.max(1, partial.bars ?? 1));
  const len = totalSteps(bars, beatsPerMeasure);
  const channels = Array.isArray(partial.channels) && partial.channels.length
    ? partial.channels.map((ch) => {
      const c = createChannel(ch);
      if (!c.steps.length) c.steps = Array.from({ length: len }, () => null);
      return c;
    })
    : [
      createChannel({ type: 'percussion', voiceId: 'kick', name: 'kick', steps: Array.from({ length: len }, () => null) }),
      createChannel({ type: 'percussion', voiceId: 'snare', name: 'snare', steps: Array.from({ length: len }, () => null) }),
      createChannel({ type: 'percussion', voiceId: 'closed-hat', name: 'closed hat', steps: Array.from({ length: len }, () => null) }),
      createChannel({
        type: 'note',
        pitch: 'C',
        octave: 2,
        instrumentId: 'bass-sub',
        name: 'bass',
        steps: Array.from({ length: len }, () => null),
      }),
      createChannel({
        type: 'chord',
        chordMode: 'degree',
        degree: 0,
        instrumentId: 'keys-pluck',
        name: 'chords',
        steps: Array.from({ length: len }, () => null),
      }),
    ];

  return {
    id: partial.id || nextPatternId(),
    name: partial.name || 'Pattern 1',
    bars,
    channels,
  };
}

/** @deprecated use createEmptyPattern / project presets */
export function createDefaultPattern() {
  const p = createEmptyPattern({ name: 'Pattern 1' });
  return {
    bpm: 120,
    timeSignature: [4, 4],
    bars: p.bars,
    swing: 0,
    channels: p.channels,
  };
}

export function clampBpm(val) {
  return Math.min(250, Math.max(30, Number(val) || 120));
}

export function clamp01(val) {
  const n = Number(val);
  if (Number.isNaN(n)) return DEFAULT_VELOCITY;
  return Math.min(1, Math.max(0, n));
}

export function beatsFromTimeSignature(sig) {
  if (Array.isArray(sig) && sig[0]) return Math.max(1, parseInt(sig[0], 10) || 4);
  if (typeof sig === 'string') {
    return Math.max(1, parseInt(sig.split('/')[0], 10) || 4);
  }
  return 4;
}

/** Resize every channel's steps array to match bars × beats. */
export function resizePatternSteps(pattern, timeSignature = [4, 4]) {
  const beats = beatsFromTimeSignature(pattern.timeSignature || timeSignature);
  const bars = Math.min(MAX_BARS, Math.max(1, pattern.bars || 1));
  pattern.bars = bars;
  const len = totalSteps(bars, beats);
  for (const ch of pattern.channels) {
    ch.steps = Array.from({ length: len }, (_, i) => normalizeStep(ch.steps[i]) || null);
  }
  return pattern;
}

export function channelAudible(channel, channels) {
  if (channel.mute) return false;
  const anySolo = channels.some((c) => c.solo);
  if (anySolo && !channel.solo) return false;
  return true;
}

export function instrumentOptionsForType(type) {
  if (type === 'percussion') return [];
  return INSTRUMENT_OPTIONS.filter((o) => o.banks.includes(type === 'chord' ? 'chord' : 'note')
    || (type === 'note' && o.banks.includes('note')));
}

export function parsePatternChannels(raw, timeSignature = [4, 4]) {
  const bars = Math.min(MAX_BARS, Math.max(1, parseInt(raw?.bars, 10) || 1));
  const channels = Array.isArray(raw?.channels) && raw.channels.length
    ? raw.channels.map((ch) => createChannel(ch))
    : createEmptyPattern({ bars }).channels;
  const pattern = {
    id: raw?.id || nextPatternId(),
    name: raw?.name || 'Pattern 1',
    bars,
    channels,
    timeSignature: raw?.timeSignature || timeSignature,
  };
  return resizePatternSteps(pattern, timeSignature);
}

/** Legacy v1 loaders kept for migration via project.js */
export function parsePattern(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bpm = clampBpm(raw.bpm ?? 120);
  const swing = clamp01(raw.swing ?? 0);
  let timeSignature = [4, 4];
  if (Array.isArray(raw.timeSignature) && raw.timeSignature.length >= 2) {
    timeSignature = [
      Math.max(1, parseInt(raw.timeSignature[0], 10) || 4),
      Math.max(1, parseInt(raw.timeSignature[1], 10) || 4),
    ];
  }
  const inner = parsePatternChannels(raw, timeSignature);
  return {
    bpm,
    timeSignature,
    bars: inner.bars,
    swing,
    channels: inner.channels,
    id: inner.id,
    name: inner.name,
  };
}

export function loadPattern() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultPattern();
    const parsed = parsePattern(JSON.parse(raw));
    return parsed || createDefaultPattern();
  } catch {
    return createDefaultPattern();
  }
}

export function savePattern(pattern) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      bpm: pattern.bpm,
      timeSignature: pattern.timeSignature,
      bars: pattern.bars,
      swing: pattern.swing,
      channels: pattern.channels.map(serializeChannel),
    }));
  } catch {
    /* ignore */
  }
}
