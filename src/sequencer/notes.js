/**
 * Pitch-row helpers for magicbeatz live capture.
 *
 * The grid stores one channel per sounding pitch: a `note` channel already
 * carries a fixed `{instrumentId, pitch, octave}` and plays exactly that note.
 * So recording keys is not a schema problem — every note-on just has to be
 * routed to the row for that pitch (creating rows on demand) instead of being
 * dropped, or retriggered on one fixed-pitch row.
 *
 * Everything here is pure data (no audio, no DOM) so the capture maths and the
 * row bookkeeping can be unit-tested under `node --test`.
 */
import {
  STEPS_PER_BEAT,
  DEFAULT_VELOCITY,
  clamp01,
  createChannel,
  channelAudible,
} from './pattern.js';
import { PITCH_ORDER, pitchToMidi } from '../midi/notes.js';
import { chordEntriesFor } from '../theory/chords.js';

/** Row cap: capture may auto-create tracks, but never unbounded ones. */
export const MAX_CAPTURE_TRACKS = 32;

export function pitchLabel(pitch = 'C', octave = 4) {
  return `${pitch || 'C'}${octave}`;
}

/** MIDI number of a {pitch, octave} pair (null when unparseable). */
export function noteMidi(note) {
  if (!note) return null;
  const midi = pitchToMidi(note.pitch, note.octave ?? 4);
  return Number.isFinite(midi) ? midi : null;
}

/** MIDI number of a note channel's fixed pitch. */
export function channelMidi(channel) {
  return noteMidi({ pitch: channel?.pitch, octave: channel?.octave ?? 4 });
}

/** {pitch, octave} for a MIDI number. */
export function midiNote(midi) {
  const n = Math.round(Number(midi));
  if (!Number.isFinite(n)) return null;
  const index = ((n % 12) + 12) % 12;
  return { pitch: PITCH_ORDER[index], octave: Math.floor(n / 12) - 1 };
}

/** True when a channel is the row for exactly this instrument + pitch + octave. */
export function rowMatchesNote(channel, note) {
  if (!channel || !note || channel.type !== 'note') return false;
  if ((channel.instrumentId || '') !== (note.instrumentId || '')) return false;
  if ((channel.pitch || 'C') !== (note.pitch || 'C')) return false;
  return (channel.octave ?? 4) === (note.octave ?? 4);
}

export function findPitchRow(pattern, note) {
  if (!pattern?.channels || !note) return null;
  return pattern.channels.find((ch) => rowMatchesNote(ch, note)) || null;
}

/**
 * Insert a pitch row inside its instrument's own block, highest pitch first so
 * a recorded chord reads top-down like a piano roll and the drummer rows that
 * share the clip keep their order.
 */
export function insertPitchRow(pattern, channel) {
  const rows = pattern.channels;
  const midi = channelMidi(channel) ?? 0;
  const block = rows
    .map((ch, index) => ({ ch, index }))
    .filter(({ ch }) => ch.type === 'note' && ch.instrumentId === channel.instrumentId);
  if (!block.length) {
    rows.push(channel);
    return rows.length - 1;
  }
  const higher = block.find(({ ch }) => (channelMidi(ch) ?? 0) < midi);
  const index = higher ? higher.index : block[block.length - 1].index + 1;
  rows.splice(index, 0, channel);
  return index;
}

/**
 * Reuse the row for this pitch, or create it.
 * @returns {{channel: object|null, created: boolean, blocked: boolean}}
 */
export function ensurePitchRow(pattern, note, opts = {}) {
  const existing = findPitchRow(pattern, note);
  if (existing) return { channel: existing, created: false, blocked: false };
  if (!pattern?.channels || !note?.instrumentId) {
    return { channel: null, created: false, blocked: false };
  }
  const maxTracks = opts.maxTracks ?? MAX_CAPTURE_TRACKS;
  if (pattern.channels.length >= maxTracks) {
    return { channel: null, created: false, blocked: true };
  }
  const len = Math.max(1, Math.round(opts.len || 16));
  const channel = createChannel({
    type: 'note',
    instrumentId: note.instrumentId,
    pitch: note.pitch || 'C',
    octave: note.octave ?? 4,
    name: opts.name || pitchLabel(note.pitch, note.octave ?? 4),
    steps: Array.from({ length: len }, () => null),
  });
  insertPitchRow(pattern, channel);
  return { channel, created: true, blocked: false };
}

/** Seconds per 16th step at a tempo. */
export function secondsPerStep(bpm) {
  return 60 / Math.max(1, Number(bpm) || 120) / STEPS_PER_BEAT;
}

/**
 * Nearest step for a hit timestamp, phase-locked to `originTime` (the downbeat
 * of the loop pass the hit belongs to) and wrapped into the clip length.
 *
 * Wrapping is signed on purpose: a hit can legitimately land a few milliseconds
 * *before* the pass boundary (the perform clock schedules ~100 ms ahead), and
 * that hit belongs to the last step of the pass it was played in, not to step 0.
 */
export function quantizeStepIndex(t, originTime, stepSeconds, stepCount) {
  const count = Math.max(1, Math.round(stepCount || 1));
  const step = Number(stepSeconds) > 0 ? Number(stepSeconds) : 1;
  const dt = Number(t) - Number(originTime);
  if (!Number.isFinite(dt)) return 0;
  const raw = Math.round(dt / step);
  return ((raw % count) + count) % count;
}

/** Pair every buffered hit with the step it belongs to. */
export function planCapture(recordBuffer, opts = {}) {
  const { originTime = 0, stepSeconds = 0.125, stepCount = 16 } = opts;
  return (recordBuffer || [])
    .filter((hit) => hit && hit.t !== undefined)
    .map((hit) => ({ hit, stepIndex: quantizeStepIndex(hit.t, originTime, stepSeconds, stepCount) }));
}

/**
 * Split a take buffer at a loop-pass boundary.
 *
 * Recording over a looping clip commits every time the loop wraps, so the hits
 * played in the pass that just ended are written now while hits the perform
 * clock already scheduled for the next pass stay buffered (they are stamped in
 * the future, up to the 100 ms lookahead).
 */
export function splitCaptureBuffer(recordBuffer, until = Infinity) {
  const ready = [];
  const pending = [];
  for (const hit of recordBuffer || []) {
    if (!hit) continue;
    if (hit.t === undefined || hit.t < until) ready.push(hit);
    else pending.push(hit);
  }
  return { ready, pending };
}

/** Group a row belongs to for "replace what I replay" recording. */
export function recordGroupKey(channel) {
  if (!channel) return '';
  if (channel.type === 'percussion') return 'percussion';
  if (channel.type === 'note') return `note:${channel.instrumentId || ''}`;
  return '';
}

/**
 * Everything that sounds at one step, as [{pitch, octave, channelId,
 * instrumentId}] sorted low→high. Mute/solo is respected, and chord rows
 * contribute their resolved chord so the readout names what you hear.
 */
export function columnNotes(pattern, stepIndex, ctx = {}) {
  const out = [];
  if (!pattern?.channels) return out;
  for (const ch of pattern.channels) {
    if (!ch.steps?.[stepIndex]) continue;
    if (!channelAudible(ch, pattern.channels)) continue;
    if (ch.type === 'note') {
      out.push({
        pitch: ch.pitch || 'C',
        octave: ch.octave ?? 4,
        channelId: ch.id,
        instrumentId: ch.instrumentId || '',
      });
    } else if (ch.type === 'chord') {
      for (const entry of chordEntriesFor(ch, ctx) || []) {
        out.push({
          pitch: entry.pitch,
          octave: entry.octave ?? 4,
          channelId: ch.id,
          instrumentId: ch.instrumentId || '',
        });
      }
    }
  }
  return out.sort((a, b) => (noteMidi(a) ?? 0) - (noteMidi(b) ?? 0));
}

/** Move one hit; swaps when the destination is already occupied. */
export function moveStep(pattern, from, to) {
  if (!from || !to || from.channelId !== to.channelId) return false;
  if (from.stepIndex === to.stepIndex) return false;
  const ch = pattern?.channels?.find((c) => c.id === from.channelId);
  if (!ch || !ch.steps?.[from.stepIndex]) return false;
  const moved = ch.steps[from.stepIndex];
  ch.steps[from.stepIndex] = ch.steps[to.stepIndex] || null;
  ch.steps[to.stepIndex] = moved;
  return true;
}

/** Move a whole column (the chord) across every row; swaps on collision. */
export function moveColumn(pattern, fromIndex, toIndex) {
  if (!pattern?.channels || fromIndex === toIndex) return false;
  let moved = false;
  for (const ch of pattern.channels) {
    if (!ch.steps) continue;
    const a = ch.steps[fromIndex] || null;
    const b = ch.steps[toIndex] || null;
    ch.steps[fromIndex] = b;
    ch.steps[toIndex] = a;
    if (a || b) moved = true;
  }
  return moved;
}

/** Drop instrument rows that hold no notes (escape valve for auto-created rows). */
export function pruneEmptyNoteRows(pattern) {
  if (!pattern?.channels) return 0;
  let removed = 0;
  for (let i = pattern.channels.length - 1; i >= 0; i -= 1) {
    const ch = pattern.channels[i];
    if (ch.type !== 'note') continue;
    if ((ch.steps || []).some(Boolean)) continue;
    pattern.channels.splice(i, 1);
    removed += 1;
  }
  return removed;
}

/** Copyable snapshot of one column, used by the step editor's copy/paste. */
export function captureColumnSnapshot(pattern, stepIndex) {
  const out = [];
  if (!pattern?.channels) return out;
  for (const ch of pattern.channels) {
    const step = ch.steps?.[stepIndex];
    if (!step || ch.type !== 'note') continue;
    out.push({
      instrumentId: ch.instrumentId || '',
      pitch: ch.pitch || 'C',
      octave: ch.octave ?? 4,
      velocity: clamp01(step.velocity ?? DEFAULT_VELOCITY),
    });
  }
  return out;
}

/** Write a snapshot into another column (creating rows as needed). */
export function pasteColumnSnapshot(pattern, stepIndex, snapshot, opts = {}) {
  if (!pattern?.channels || !Array.isArray(snapshot)) return 0;
  let written = 0;
  for (const note of snapshot) {
    const res = ensurePitchRow(pattern, note, opts);
    if (!res.channel) continue;
    res.channel.steps[stepIndex] = { velocity: clamp01(note.velocity ?? DEFAULT_VELOCITY) };
    written += 1;
  }
  return written;
}

/** Pad/key hit → the note targets it writes ({kind:'drum'} or {kind:'note', note}). */
function captureTargets(hit, expandPad) {
  if (!hit) return [];
  if (hit.kind === 'pad') {
    const entry = hit.entry || {};
    if (entry.target === 'drum') return [{ kind: 'drum' }];
    if (entry.target === 'chord') {
      const notes = typeof expandPad === 'function' ? expandPad(hit) : [];
      return (notes || []).filter((n) => n && n.pitch).map((n) => ({ kind: 'note', note: n }));
    }
    if (entry.pitch) {
      return [{
        kind: 'note',
        note: {
          instrumentId: entry.instrumentId || '',
          pitch: entry.pitch,
          octave: entry.octave ?? 4,
          velocity: hit.velocity,
        },
      }];
    }
    return [];
  }
  if (hit.kind === 'key' && hit.pitch && hit.instrumentId) {
    return [{
      kind: 'note',
      note: {
        instrumentId: hit.instrumentId,
        pitch: hit.pitch,
        octave: hit.octave ?? 4,
        velocity: hit.velocity,
      },
    }];
  }
  return [];
}

/** Blank every row of a group at the given steps ("replace what I replay"). */
function clearGroupSteps(pattern, group, steps) {
  if (!group || !steps?.size) return 0;
  let cleared = 0;
  for (const ch of pattern.channels) {
    if (recordGroupKey(ch) !== group) continue;
    for (const stepIndex of steps) {
      if (!ch.steps?.[stepIndex]) continue;
      ch.steps[stepIndex] = null;
      cleared += 1;
    }
  }
  return cleared;
}

/**
 * Write capture hits into a clip.
 *
 * `overdub` (default) merges: only the steps a take touches are rewritten, so a
 * second pass layers onto the first. `replace` first clears the rows of the
 * instrument this pass touched at the steps it played, so replaying a bar fixes
 * the notes you re-play and leaves everything you did not touch alone.
 *
 * @param {object} pattern clip
 * @param {Array} hits raw record-buffer entries
 * @param {{
 *   originTime?: number, stepSeconds?: number, stepCount?: number,
 *   mode?: 'overdub'|'replace',
 *   ensureDrum?: (hit: object, len: number) => {channel: object|null, created: boolean, blocked: boolean},
 *   ensureKey?: (note: object, len: number) => {channel: object|null, created: boolean, blocked: boolean},
 *   expandPad?: (hit: object) => Array<{instrumentId: string, pitch: string, octave: number}>,
 * }} opts
 */
export function applyCaptureHits(pattern, hits, opts = {}) {
  const {
    originTime = 0,
    stepSeconds = 0.125,
    stepCount = 16,
    mode = 'overdub',
    ensureDrum = null,
    ensureKey = null,
    expandPad = null,
  } = opts;
  const result = { written: 0, created: 0, blocked: false, cleared: 0, touchedByGroup: new Map() };
  if (!pattern?.channels) return result;
  const len = Math.max(1, Math.round(stepCount || 16));

  const planned = [];
  for (const { hit, stepIndex } of planCapture(hits, { originTime, stepSeconds, stepCount: len })) {
    for (const target of captureTargets(hit, expandPad)) {
      const group = target.kind === 'drum' ? 'percussion' : `note:${target.note.instrumentId || ''}`;
      planned.push({ hit, stepIndex, target, group });
    }
  }
  if (!planned.length) return result;

  for (const item of planned) {
    if (!result.touchedByGroup.has(item.group)) result.touchedByGroup.set(item.group, new Set());
    result.touchedByGroup.get(item.group).add(item.stepIndex);
  }
  if (mode === 'replace') {
    for (const [group, steps] of result.touchedByGroup) {
      result.cleared += clearGroupSteps(pattern, group, steps);
    }
  }

  for (const { hit, stepIndex, target } of planned) {
    const res = target.kind === 'drum'
      ? (typeof ensureDrum === 'function' ? ensureDrum(hit, len) : null)
      : (typeof ensureKey === 'function' ? ensureKey(target.note, len) : null);
    if (!res) continue;
    if (res.blocked) {
      result.blocked = true;
      continue;
    }
    if (res.created) result.created += 1;
    const velocity = target.kind === 'drum' ? hit.velocity : (target.note.velocity ?? hit.velocity);
    res.channel.steps[stepIndex] = { velocity: clamp01(velocity ?? DEFAULT_VELOCITY) };
    result.written += 1;
  }
  return result;
}

/**
 * One chord-pad hit → one hit per sounding pitch, so a chord pad lands as a
 * chord column of pitch rows instead of being skipped.
 * `entries` are the already-resolved chord notes ({pitch, octave}).
 */
export function expandChordPadHit(hit, entries) {
  const instrumentId = hit?.entry?.instrumentId || 'keys-pluck';
  const out = [];
  for (const entry of entries || []) {
    if (!entry?.pitch) continue;
    out.push({
      instrumentId,
      pitch: entry.pitch,
      octave: entry.octave ?? 4,
      velocity: hit?.velocity,
    });
  }
  return out;
}

/**
 * Notes a pad contributes when it feeds note repeat / the arpeggiator.
 * Drum pads never feed it; a chord pad contributes its whole resolved chord.
 */
export function padPerformNotes(entry, entries) {
  if (!entry) return [];
  if (entry.target === 'drum') return [];
  if (entry.target === 'chord') {
    return (entries || [])
      .filter((e) => e?.pitch)
      .map((e) => ({
        instrumentId: entry.instrumentId || 'keys-pluck',
        pitch: e.pitch,
        octave: e.octave ?? 4,
      }));
  }
  if (!entry.pitch) return [];
  return [{
    instrumentId: entry.instrumentId || 'piano',
    pitch: entry.pitch,
    octave: entry.octave ?? 4,
  }];
}

/** One-level undo for a take: clone the clip's rows + steps before recording. */
export function snapshotTake(pattern) {
  if (!pattern?.channels) return null;
  return {
    patternId: pattern.id || '',
    channels: pattern.channels.map((ch) => ({
      id: ch.id,
      steps: (ch.steps || []).map((step) => (step ? { ...step } : null)),
    })),
  };
}

/**
 * Roll a clip back to `snapshot`: rows the take created are dropped, the rows
 * that were already there get their steps back. Rows deleted during the take
 * (only the step editor does that) are not resurrected.
 */
export function restoreTake(pattern, snapshot) {
  if (!pattern?.channels || !snapshot?.channels) return { restored: false, removed: 0 };
  if (snapshot.patternId && pattern.id && snapshot.patternId !== pattern.id) {
    return { restored: false, removed: 0 };
  }
  const before = new Map(snapshot.channels.map((ch) => [ch.id, ch.steps || []]));
  let removed = 0;
  for (let i = pattern.channels.length - 1; i >= 0; i -= 1) {
    if (before.has(pattern.channels[i].id)) continue;
    pattern.channels.splice(i, 1);
    removed += 1;
  }
  for (const ch of pattern.channels) {
    const steps = before.get(ch.id);
    if (!steps) continue;
    ch.steps = steps.map((step) => (step ? { ...step } : null));
  }
  return { restored: true, removed };
}

