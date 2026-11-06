/**
 * Live key performance — note repeat + arpeggiator (src/keys/perform.js).
 *
 * Pure helpers (rates, sequences, prefs) stay import-safe for node tests.
 * createPerformClock owns the audio lookahead loop and is only used in the
 * browser: unlike the step transport it runs while the sequencer is stopped
 * and supports rates finer than a 16th note.
 */
import { getAudioContext } from '../audio/context.js';

/** Tempo-synced rates, expressed as quarter notes per step. */
export const PERFORM_RATES = [
  { id: '1/4', quarters: 1 },
  { id: '1/8', quarters: 0.5 },
  { id: '1/8T', quarters: 1 / 3 },
  { id: '1/16', quarters: 0.25 },
  { id: '1/16T', quarters: 1 / 6 },
  { id: '1/32', quarters: 0.125 },
];

export const DEFAULT_PERFORM_RATE = '1/16';
const RATE_IDS = new Set(PERFORM_RATES.map((rate) => rate.id));

export function normalizeRateId(id) {
  return RATE_IDS.has(id) ? id : DEFAULT_PERFORM_RATE;
}

export function rateQuarters(rateId) {
  const rate = PERFORM_RATES.find((r) => r.id === rateId)
    || PERFORM_RATES.find((r) => r.id === DEFAULT_PERFORM_RATE);
  return rate.quarters;
}

/** Seconds per step for a rate id at the given tempo (invalid input → 120 bpm). */
export function rateSeconds(rateId, bpm) {
  const tempo = Number(bpm);
  const safe = Number.isFinite(tempo) && tempo > 0 ? tempo : 120;
  return (60 / safe) * rateQuarters(rateId);
}

export const ARP_MODES = ['up', 'down', 'updown', 'random'];
export const DEFAULT_ARP_MODE = 'up';

/** Readable labels for the UI (the stored ids stay compact). */
const ARP_MODE_LABELS = { up: 'up', down: 'down', updown: 'up/down', random: 'random' };

export function normalizeArpMode(mode) {
  return ARP_MODES.includes(mode) ? mode : DEFAULT_ARP_MODE;
}

/** Fraction of one step that a repeated note sounds for. */
export const REPEAT_GATE = 0.6;
/** Fraction of one step that an arp note sounds for. */
export const ARP_GATE = 0.8;

function normalizeNote(note) {
  if (!note || typeof note.pitch !== 'string') return null;
  const octave = Number(note.octave);
  if (!Number.isFinite(octave)) return null;
  const velocity = Number(note.velocity);
  const out = {
    pitch: note.pitch,
    octave,
    velocity: Number.isFinite(velocity) ? Math.min(1, Math.max(0, velocity)) : 0.85,
  };
  // A note can carry its own instrument (chord pads feed the arp), so keep it.
  if (typeof note.instrumentId === 'string' && note.instrumentId) out.instrumentId = note.instrumentId;
  return out;
}

/**
 * Order the held notes into one arp cycle.
 * `random` shuffles once per chord (inject `rng` for deterministic tests).
 * @param {Array<{ pitch: string, octave: number, velocity?: number }>} notes
 * @param {{ mode?: string, octaves?: number, rng?: () => number }} [opts]
 */
export function buildArpSequence(notes, { mode = DEFAULT_ARP_MODE, octaves = 1, rng = Math.random } = {}) {
  const base = (Array.isArray(notes) ? notes : []).map(normalizeNote).filter(Boolean);
  if (!base.length) return [];

  const octaveCount = Math.min(3, Math.max(1, Math.round(Number(octaves) || 1)));
  const expanded = [];
  for (let o = 0; o < octaveCount; o += 1) {
    for (const note of base) {
      expanded.push({ ...note, octave: note.octave + o });
    }
  }

  switch (normalizeArpMode(mode)) {
    case 'down':
      return [...expanded].reverse();
    case 'updown':
      if (expanded.length < 2) return expanded;
      // Do not repeat the turnaround endpoints: C E G E (then loop).
      return [...expanded, ...expanded.slice(1, -1).reverse()];
    case 'random': {
      const out = [...expanded];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    }
    case 'up':
    default:
      return expanded;
  }
}

export const DEFAULT_PERFORM_PREFS = {
  repeat: { enabled: false, rate: DEFAULT_PERFORM_RATE },
  arp: {
    enabled: false,
    mode: DEFAULT_ARP_MODE,
    rate: DEFAULT_PERFORM_RATE,
    octaves: 1,
    latch: false,
  },
};

function normalizeOctaves(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.min(3, Math.max(1, n));
}

/** Validate persisted prefs; repeat and arp are mutually exclusive (arp wins). */
export function normalizePerformPrefs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const repeat = src.repeat && typeof src.repeat === 'object' ? src.repeat : {};
  const arp = src.arp && typeof src.arp === 'object' ? src.arp : {};

  const prefs = {
    repeat: {
      enabled: !!repeat.enabled,
      rate: normalizeRateId(repeat.rate),
    },
    arp: {
      enabled: !!arp.enabled,
      mode: normalizeArpMode(arp.mode),
      rate: normalizeRateId(arp.rate),
      octaves: normalizeOctaves(arp.octaves),
      latch: !!arp.latch,
    },
  };

  if (prefs.repeat.enabled && prefs.arp.enabled) prefs.repeat.enabled = false;
  return prefs;
}

/** One-line summary for the collapsed repeat/arp drawer. */
export function performStatusLabel(prefs) {
  const p = normalizePerformPrefs(prefs);
  if (p.arp.enabled) {
    const bits = ['arp', ARP_MODE_LABELS[p.arp.mode] || p.arp.mode, p.arp.rate];
    if (p.arp.octaves > 1) bits.push(`${p.arp.octaves} oct`);
    if (p.arp.latch) bits.push('latch');
    return bits.join(' · ');
  }
  if (p.repeat.enabled) return ['repeat', p.repeat.rate].join(' · ');
  return 'off';
}

const TICK_MS = 25;
const LOOKAHEAD_SEC = 0.1;
const MIN_INTERVAL_SEC = 0.02;

/**
 * Lookahead clock for live performance notes.
 * Re-reads tempo and rate every pass so BPM/rate changes apply immediately,
 * and resyncs after background-tab timer throttling instead of bursting.
 *
 * @param {{
 *   getBpm: () => number,
 *   getRateId: () => string,
 *   onStep: (when: number) => void,
 * }} opts
 */
export function createPerformClock({ getBpm, getRateId, onStep }) {
  let timerId = null;
  let running = false;
  let nextTime = 0;

  function intervalSec() {
    return Math.max(MIN_INTERVAL_SEC, rateSeconds(getRateId(), getBpm()));
  }

  function tick() {
    if (!running) return;
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    if (nextTime < now - 0.25) nextTime = now + 0.01;
    while (nextTime < now + LOOKAHEAD_SEC) {
      try {
        onStep(nextTime);
      } catch (err) {
        console.error(err);
      }
      nextTime += intervalSec();
    }
    if (!running) return;
    timerId = window.setTimeout(tick, TICK_MS);
  }

  return {
    isRunning() {
      return running;
    },

    start() {
      if (running) return;
      const ctx = getAudioContext();
      running = true;
      const first = ctx.currentTime + 0.005;
      nextTime = first;
      try {
        onStep(first);
      } catch (err) {
        console.error(err);
      }
      if (!running) return;
      nextTime = first + intervalSec();
      timerId = window.setTimeout(tick, TICK_MS);
    },

    stop() {
      running = false;
      if (timerId != null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    },
  };
}
