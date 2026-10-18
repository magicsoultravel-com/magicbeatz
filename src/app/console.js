/**
 * magicbeatz console — standalone AKAI MPK mini console (src/app/console.js).
 * Composition root: transport + pads + keys + grid + MIDI wiring.
 */
import { getAudioContext, ensureAudio } from '../audio/context.js';
import {
  clampBpm, clamp01, beatsFromTimeSignature, totalSteps,
  DEFAULT_VELOCITY, INSTRUMENT_OPTIONS,
} from '../sequencer/pattern.js';
import {
  getActivePattern, arrangementToSlots, slotsToArrangement,
  arrangementLengthBars,
} from '../sequencer/project.js';
import { createStepTransport } from '../sequencer/transport.js';
import { playChannelHit } from '../audio/banks.js';
import { playPercussionVoice } from '../audio/percussion.js';
import {
  playPitchedInstrument, playPitchedChord, startPitchedSustain, stopPitchedSustain,
  SUSTAIN_INSTRUMENTS,
} from '../audio/voices.js';
import { chordEntriesFor } from '../theory/chords.js';
import { loadMbzProject, saveMbzProject, resetMbzProject } from '../state/store.js';
import {
  loadPadMap, savePadMap, applyCurve, PAD_ORDER, getLearnSlot, setLearnSlot,
  findPadByNote, padCollisions, DEFAULT_PAD_CHANNEL, DEFAULT_KEYS_CHANNEL,
} from '../pads/model.js';
import { connectMbzMidi } from '../midi/connection.js';
import { queryFirmwareVersion } from '../midi/firmware.js';
import {
  PITCH_ORDER, pitchOctFromMidi, pitchToMidi, midiFromBase,
  PC_NOTE_OFFSETS, midiRangeForKeys,
} from '../midi/notes.js';
import { DEFAULT_KNOB_CC, DEFAULT_KNOB_VAL, DEFAULT_KEYS_INSTRUMENT } from '../state/settings.js';
import { INSTRUMENT_CATEGORIES, resolveInstrument } from '../audio/instruments.js';
import { ensureSample, isSampleReady, onSamplerStatus, preloadDefaults, flushPendingLoads, samplerStatus } from '../audio/sampler.js';

/** Standalone asset fetch: ./assets next to index.html. */
function mbzAsset(path) {
  const clean = String(path).replace(/^\//, '').replace(/^assets\//, '');
  return new URL(`./assets/${clean}`, document.baseURI).href;
}

/** Loaded theory data (wired into every playChannelHit — fixes silent chords). */
const theory = { chordsJson: {}, notesJson: {}, scalesJson: {}, chordsTheory: {} };
function chordCtx() {
  return { ...theory, hub: { getRoot: () => 'C' } };
}

const PITCH_LABELS = PITCH_ORDER;
function pitchOct(midi) { return pitchOctFromMidi(midi); }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- state ----------
const { project: initialProject, imported } = loadMbzProject();
let project = initialProject;
let padMap = loadPadMap();
let bank = 'A';
let baseOct = 3;
let audition = true;
let capturing = false;
let recordBuffer = [];
let loopOriginTime = 0;
let selectedCell = null;
let keysCurve = 'linear';
let knobCC = [...DEFAULT_KNOB_CC];
let knobVal = [...DEFAULT_KNOB_VAL];
let joyX = 0, joyY = 0;

// ---------- dom ----------
const $ = (sel) => document.querySelector(sel);
const midiPill = $('[data-midi-status]');
const assetPill = $('[data-asset-status]');
const knobsEl = $('[data-knobs]');
const joyDot = $('[data-joystick-dot]');
const joyReadout = $('[data-joystick-readout]');
const octLabel = $('[data-oct-label]');
const bankLabel = $('[data-bank-label]');
const playBtn = $('[data-play]');
const stopBtn = $('[data-stop]');
const bpmInput = $('[data-bpm]');
const swingInput = $('[data-swing]');
const swingVal = $('[data-swing-val]');
const sigSelect = $('[data-sig]');
const barsSelect = $('[data-bars]');
const patternSelect = $('[data-pattern]');
const projectNote = $('[data-project-note]');
const padsEl = $('[data-pads]');
const gridEl = $('[data-grid]');
const velInput = $('[data-velocity]');
const velVal = $('[data-velocity-val]');
const keyboardEl = $('[data-keyboard]');
const keysInst = $('[data-keys-inst]');
const keysCurveSel = $('[data-keys-curve]');
const padEditorsEl = $('[data-pad-editors]');
const midiMonitorEl = $('[data-midi-monitor]');
const heldKeys = new Map();
const heldPc = new Set();

/** Last raw MIDI messages (newest first, max 5) for the monitor row. */
const midiLog = [];
function pushMidiLog(text) {
  midiLog.unshift(text);
  if (midiLog.length > 5) midiLog.pop();
  if (midiMonitorEl) midiMonitorEl.textContent = `midi: ${midiLog.join(' · ')}`;
}

async function proveAssets() {
  const targets = ['notes.json', 'chords.json', 'scales-theory.json', 'chords-theory.json'];
  let ok = 0;
  for (const t of targets) {
    try {
      const res = await fetch(mbzAsset(t));
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      if (t === 'notes.json') theory.notesJson = json;
      if (t === 'chords.json') theory.chordsJson = json;
      if (t === 'scales-theory.json') theory.scalesJson = json;
      if (t === 'chords-theory.json') theory.chordsTheory = json;
      ok += 1;
    } catch { /* keep going */ }
  }
  if (ok === targets.length) {
    assetPill.textContent = `assets ok (${ok}/${targets.length})`;
    assetPill.dataset.kind = 'ready';
    return theory;
  }
  if (ok > 0) {
    assetPill.textContent = `assets partial (${ok}/${targets.length})`;
    assetPill.dataset.kind = 'none';
    return theory;
  }
  assetPill.textContent = 'assets failed';
  assetPill.dataset.kind = 'denied';
  return null;
}

function activePattern() { return getActivePattern(project); }
let arrangeSlots = arrangementToSlots(
  project.arrangement,
  Math.max(1, arrangementLengthBars(project.arrangement) || 1),
);
function persist() {
  project.arrangement = slotsToArrangement(arrangeSlots);
  saveMbzProject(project);
  updateProjectNote();
}
function updateProjectNote() {
  const pat = activePattern();
  projectNote.textContent = `project: magicbeatz-v1 bpm ${project.bpm} ${pat?.name || '?'}${imported ? ' imported from suite' : ''}`;
}

function getBpm() { return clampBpm(parseInt(bpmInput.value, 10) || 120); }
function getBeats() { return beatsFromTimeSignature(project.timeSignature); }
function getBars() { return Math.min(4, Math.max(1, activePattern()?.bars || 1)); }
function getTotalSteps() { return totalSteps(getBars(), getBeats()); }

function schedulePlayhead(when, localStep) {
  const delay = Math.max(0, (when - getAudioContext().currentTime) * 1000 - 8);
  window.setTimeout(() => {
    if (!transport.isRunning()) return;
    gridEl.querySelectorAll('.mbz-cell.is-playhead').forEach((c) => c.classList.remove('is-playhead'));
    gridEl.querySelectorAll(`.mbz-cell[data-step="${localStep}"]`).forEach((c) => c.classList.add('is-playhead'));
  }, delay);
}

const transport = createStepTransport({
  getBpm,
  getBeatsPerMeasure: getBeats,
  getBars,
  getTotalSteps,
  getSwing: () => clamp01(project.swing),
  onStep(stepIndex, _total, when) {
    if (stepIndex === 0) loopOriginTime = when;
    const pat = activePattern();
    if (!pat) return;
    schedulePlayhead(when, stepIndex);
    for (const ch of pat.channels) {
      if (ch.mute) continue;
      const anySolo = pat.channels.some((c) => c.solo);
      if (anySolo && !ch.solo) continue;
      const step = ch.steps[stepIndex];
      if (!step) continue;
      playChannelHit(ch, when, step.velocity, chordCtx());
    }
  },
});

function setPlaying(playing) {
  playBtn.disabled = playing;
  stopBtn.disabled = !playing;
  updateProjectNote();
}

function padLabel(entry) {
  if (!entry) return '—';
  if (entry.target === 'drum') return entry.voiceId || 'drum';
  if (entry.target === 'note') return `${entry.pitch || 'C'}${entry.octave ?? 4} ${entry.instrumentId || ''}`;
  return `${entry.chordName || 'C'} chord`;
}

function renderPads() {
  bankLabel.textContent = bank;
  padsEl.innerHTML = '';
  for (const padNum of PAD_ORDER) {
    const entry = padMap[bank]?.[padNum];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mbz-pad';
    btn.dataset.pad = String(padNum);
    const ch = (entry?.midiChannel ?? DEFAULT_PAD_CHANNEL) + 1;
    btn.innerHTML = `<b>P${padNum}</b><small>${esc(padLabel(entry))}</small><small>ch ${ch} · note ${entry?.midiNote ?? '—'} · ${esc(entry?.curve || 'linear')}</small>`;
    // Pointer capture, same release path as keys (stuck-key fix covers pads too)
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      auditionPad(bank, padNum, 0.9);
    });
    padsEl.appendChild(btn);
  }
}

function flashPad(padNum) {
  const btn = padsEl.querySelector(`.mbz-pad[data-pad="${padNum}"]`);
  if (!btn) return;
  btn.classList.add('is-hit');
  window.setTimeout(() => btn.classList.remove('is-hit'), 120);
}

function auditionPad(bankId, padNum, velocity = 0.85) {
  if (!audition) return;
  ensureAudio();
  flushPendingLoads();
  const entry = padMap[bankId]?.[padNum];
  if (!entry) return;
  const vel = applyCurve(velocity, entry.curve) * clamp01(entry.gain ?? 0.9);
  if (capturing) recordBuffer.push({ kind: 'pad', bank: bankId, pad: padNum, entry: { ...entry }, t: getAudioContext().currentTime, velocity: vel });
  if (entry.target === 'drum') {
    playPercussionVoice(entry.voiceId || 'kick', undefined, vel);
  } else if (entry.target === 'chord') {
    const entries = chordEntriesFor(entry, chordCtx());
    if (entries.length) playPitchedChord(entry.instrumentId || 'keys-pluck', entries, undefined, vel);
    else playPitchedInstrument(entry.instrumentId || 'piano', entry.pitch || 'C', entry.octave ?? 4, undefined, vel);
  } else {
    playPitchedInstrument(entry.instrumentId || 'piano', entry.pitch || 'C', entry.octave ?? 4, undefined, vel);
  }
  flashPad(padNum);
}

function auditionKey(pitch, octave, holdId, velocity) {
  if (!audition) return;
  if (heldKeys.has(holdId)) return;
  ensureAudio();
  flushPendingLoads();
  const inst = keysInst.value || 'piano';
  const vel = applyCurve(velocity ?? 0.85, keysCurve);
  if (capturing) recordBuffer.push({ kind: 'key', pitch, octave, instrumentId: inst, t: getAudioContext().currentTime, velocity: vel });
  const btn = keyboardEl.querySelector(`.mbz-key[data-pitch="${pitch}"][data-octave="${octave}"]`);
  btn?.classList.add('is-down');
  if (SUSTAIN_INSTRUMENTS.has(inst)) {
    heldKeys.set(holdId, startPitchedSustain(inst, pitch, octave, vel) || null);
  } else {
    playPitchedInstrument(inst, pitch, octave, undefined, vel);
    // One-shot: track briefly so pointerup can clear highlight, then drop
    // (prevents heldKeys.has() blocking rapid re-taps = stuck-key fix).
    heldKeys.set(holdId, null);
    window.setTimeout(() => {
      if (heldKeys.get(holdId) === null) {
        heldKeys.delete(holdId);
        btn?.classList.remove('is-down');
      }
    }, 160);
  }
}

function clearKeyHighlight(holdId) {
  if (typeof holdId !== 'string') return;
  let pitch = null;
  let oct = null;
  if (holdId.startsWith('pc:') || holdId.startsWith('ptr:')) {
    const rest = holdId.slice(holdId.startsWith('pc:') ? 3 : 4);
    const pipe = rest.lastIndexOf('|');
    pitch = rest.slice(0, pipe);
    oct = rest.slice(pipe + 1);
  } else if (holdId.startsWith('midi:')) {
    const midi = parseInt(holdId.slice(5), 10);
    if (!Number.isNaN(midi)) {
      const po = pitchOct(midi);
      pitch = po.pitch;
      oct = String(po.octave);
    }
  }
  if (pitch != null) {
    keyboardEl.querySelector(`.mbz-key[data-pitch="${pitch}"][data-octave="${oct}"]`)?.classList.remove('is-down');
  }
}

function releaseKey(holdId) {
  const sk = heldKeys.get(holdId);
  if (sk) {
    try { stopPitchedSustain(sk); } catch { /* ignore */ }
  }
  heldKeys.delete(holdId);
  clearKeyHighlight(holdId);
}

/** Shared pointer press/release with capture — same path for keys + pads. */
function wirePressRelease(btn, holdId, onPress) {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { btn.setPointerCapture(e.pointerId); } catch { /* no-capture fallback below */ }
    onPress();
  });
  const release = () => releaseKey(holdId);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('lostpointercapture', release);
  // Fallback only: if capture failed, leaving the element releases.
  btn.addEventListener('pointerleave', (e) => {
    if (!btn.hasPointerCapture?.(e.pointerId)) release();
  });
}

function renderKeyboard() {
  keyboardEl.innerHTML = '';
  const { start, end } = midiRangeForKeys(baseOct);
  octLabel.textContent = `C${baseOct}–C${baseOct + 2}`;
  for (let midi = start; midi <= end; midi += 1) {
    const { pitch, octave } = pitchOct(midi);
    const isBlack = pitch.includes('#');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `mbz-key ${isBlack ? 'black' : 'white'}`;
    btn.dataset.pitch = pitch;
    btn.dataset.octave = String(octave);
    btn.textContent = isBlack ? '#' : `${pitch}${octave}`;
    btn.title = `${pitch}${octave} · MIDI ${midi}`;
    const holdId = `ptr:${pitch}|${octave}`;
    wirePressRelease(btn, holdId, () => auditionKey(pitch, octave, holdId, 0.85));
    keyboardEl.appendChild(btn);
  }
}

function findChannel(id) {
  return activePattern()?.channels.find((c) => c.id === id) || null;
}

function renderGrid() {
  const pat = activePattern();
  gridEl.innerHTML = '';
  if (!pat) return;
  const n = getTotalSteps();
  gridEl.style.setProperty('--steps', String(n));
  for (const ch of pat.channels) {
    const row = document.createElement('div');
    row.className = 'mbz-ch-row';
    row.style.setProperty('--steps', String(n));
    const name = document.createElement('span');
    name.className = 'mbz-ch-name';
    name.textContent = ch.name || ch.voiceId || ch.type;
    row.appendChild(name);
    ch.steps.forEach((step, i) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `mbz-cell${step ? ' is-on' : ''}${selectedCell?.channelId === ch.id && selectedCell?.stepIndex === i ? ' is-playhead' : ''}`;
      cell.dataset.step = String(i);
      cell.title = `${ch.name || ch.voiceId} step ${i + 1}`;
      cell.addEventListener('click', () => {
        const idx = i;
        if (ch.steps[idx]) {
          if (selectedCell?.channelId === ch.id && selectedCell?.stepIndex === idx) {
            ch.steps[idx] = null;
            selectedCell = null;
          } else {
            selectedCell = { channelId: ch.id, stepIndex: idx };
          }
        } else {
          ch.steps[idx] = { velocity: DEFAULT_VELOCITY };
          selectedCell = { channelId: ch.id, stepIndex: idx };
        }
        persist();
        renderGrid();
        updateVelocityUi();
      });
      row.appendChild(cell);
    });
    gridEl.appendChild(row);
  }
}

function updateVelocityUi() {
  if (!selectedCell) {
    velInput.disabled = true;
    velVal.textContent = '—';
    return;
  }
  const ch = findChannel(selectedCell.channelId);
  const step = ch?.steps[selectedCell.stepIndex];
  if (!step) {
    velInput.disabled = true;
    velVal.textContent = '—';
    return;
  }
  velInput.disabled = false;
  velInput.value = String(Math.round(step.velocity * 100));
  velVal.textContent = `${Math.round(step.velocity * 100)}%`;
}

function renderPatterns() {
  patternSelect.innerHTML = '';
  for (const p of project.patterns) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === project.activePatternId) opt.selected = true;
    patternSelect.appendChild(opt);
  }
}

function renderKnobs() {
  knobsEl.innerHTML = '';
  knobCC.forEach((cc, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'mbz-knob';
    wrap.innerHTML = `<div class="mbz-knob-dial" style="--v:${knobVal[i].toFixed(3)}"></div><b>K${i + 1}</b><small>CC ${cc}</small>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = getLearnSlot()?.kind === 'knob' && getLearnSlot()?.index === i ? '…waiting' : 'learn';
    if (getLearnSlot()?.kind === 'knob' && getLearnSlot()?.index === i) btn.classList.add('is-learning');
    btn.addEventListener('click', () => {
      setLearnSlot({ kind: 'knob', index: i });
      renderKnobs();
    });
    wrap.appendChild(btn);
    knobsEl.appendChild(wrap);
  });
}

function renderPadEditors() {
  padEditorsEl.innerHTML = '';
  for (const padNum of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const b of ['A', 'B']) {
      const entry = padMap[b]?.[padNum];
      if (!entry) continue;
      const card = document.createElement('div');
      card.className = 'mbz-pad-editor';
      const ch1 = (entry.midiChannel ?? DEFAULT_PAD_CHANNEL) + 1;
      const clashes = padCollisions(padMap, b, padNum, entry.midiNote, entry.midiChannel ?? DEFAULT_PAD_CHANNEL);
      const pianoNote = (() => {
        try {
          const po = pitchOct(entry.midiNote);
          return `${po.pitch}${po.octave}`;
        } catch { return ''; }
      })();
      card.innerHTML = `<h3>${b}${padNum} · ${esc(padLabel(entry))}</h3>
        ${clashes.length ? `<p class="mbz-warn">⚠ conflict: same ch ${ch1} note ${entry.midiNote} as ${clashes.join(', ')} — last write wins</p>` : ''}
        ${pianoNote ? `<p class="mbz-note">also piano ${pianoNote} on miss — pad wins on match</p>` : ''}
        <div class="grid">
          <label>target<select data-f="target">
            <option value="drum"${entry.target === 'drum' ? ' selected' : ''}>drum</option>
            <option value="note"${entry.target === 'note' ? ' selected' : ''}>note</option>
            <option value="chord"${entry.target === 'chord' ? ' selected' : ''}>chord</option>
          </select></label>
          <label>voice / pitch<input data-f="voice" value="${esc(entry.voiceId || entry.pitch || '')}"></label>
          <label>midi note<input data-f="midi" type="number" min="0" max="127" value="${entry.midiNote ?? ''}"></label>
          <label>channel (1–16)<input data-f="ch" type="number" min="1" max="16" value="${ch1}"></label>
          <label>curve<select data-f="curve">
            ${['linear', 'soft', 'hard', 'fixed'].map((c) => `<option value="${c}"${entry.curve === c ? ' selected' : ''}>${c}</option>`).join('')}
          </select></label>
        </div>`;
      card.querySelector('[data-f="target"]').addEventListener('change', (e) => {
        entry.target = e.target.value;
        if (entry.target === 'drum' && !entry.voiceId) entry.voiceId = 'kick';
        savePadMap(padMap);
        renderPads();
        renderPadEditors();
      });
      card.querySelector('[data-f="voice"]').addEventListener('change', (e) => {
        const v = e.target.value.trim();
        if (entry.target === 'drum') entry.voiceId = v || 'kick';
        else entry.pitch = v || 'C';
        savePadMap(padMap);
        renderPads();
      });
      card.querySelector('[data-f="midi"]').addEventListener('change', (e) => {
        const n = parseInt(e.target.value, 10);
        if (!Number.isNaN(n)) entry.midiNote = Math.min(127, Math.max(0, n));
        savePadMap(padMap);
        renderPads();
        renderPadEditors();
      });
      card.querySelector('[data-f="ch"]').addEventListener('change', (e) => {
        const c = parseInt(e.target.value, 10);
        if (!Number.isNaN(c)) entry.midiChannel = Math.min(15, Math.max(0, c - 1));
        savePadMap(padMap);
        renderPads();
        renderPadEditors();
      });
      card.querySelector('[data-f="curve"]').addEventListener('change', (e) => {
        entry.curve = e.target.value;
        savePadMap(padMap);
        renderPads();
      });
      const learnBtn = document.createElement('button');
      learnBtn.type = 'button';
      learnBtn.className = 'mbz-btn';
      learnBtn.textContent = 'learn midi note';
      learnBtn.addEventListener('click', () => setLearnSlot({ kind: 'pad', bank: b, pad: padNum }));
      card.appendChild(learnBtn);
      // Bulk-learn: tap 8 hardware pads in P1..P8 order, adopts each ch+note.
      if (padNum === 1) {
        const bulkBtn = document.createElement('button');
        bulkBtn.type = 'button';
        bulkBtn.className = 'mbz-btn';
        bulkBtn.textContent = `learn bank ${b} (tap P1–P8)`;
        bulkBtn.title = 'Tap 8 hardware pads in order P1..P8 — each adopts its channel + note';
        bulkBtn.addEventListener('click', () => setLearnSlot({ kind: 'pad-bulk', bank: b, pad: 1 }));
        card.appendChild(bulkBtn);
      }
      padEditorsEl.appendChild(card);
    }
  }
}

function applyKnob(index, value01) {
  knobVal[index] = value01;
  if (index === 0) {
    project.swing = clamp01(value01);
    swingInput.value = String(Math.round(value01 * 100));
    swingVal.textContent = `${Math.round(value01 * 100)}%`;
    persist();
  } else if (index === 1) {
    const bpm = Math.round(60 + value01 * 140);
    bpmInput.value = String(bpm);
    project.bpm = clampBpm(bpm);
    persist();
  } else {
    const pat = activePattern();
    const ch = pat?.channels[index - 2];
    if (ch) { ch.gain = clamp01(value01); persist(); }
  }
  const dial = knobsEl.children[index]?.querySelector('.mbz-knob-dial');
  if (dial) dial.style.setProperty('--v', value01.toFixed(3));
}

function onMidiNoteOn(note, velocity, channel) {
  pushMidiLog(`ch ${(channel ?? 0) + 1} note ${note} vel ${Math.round(velocity * 127)}`);
  // Learn taps RAW midi first (DeepSeek: never learn from the routed stream).
  const slot = getLearnSlot();
  if (slot?.kind === 'pad-bulk') {
    const entry = padMap[slot.bank]?.[slot.pad];
    if (entry) {
      entry.midiNote = note;
      if (channel != null) entry.midiChannel = channel;
      savePadMap(padMap);
    }
    if (slot.pad >= 8) {
      setLearnSlot(null);
    } else {
      setLearnSlot({ kind: 'pad-bulk', bank: slot.bank, pad: slot.pad + 1 });
    }
    renderPads();
    renderPadEditors();
    return;
  }
  if (slot?.kind === 'pad') {
    const entry = padMap[slot.bank]?.[slot.pad];
    if (entry) {
      entry.midiNote = note;
      if (channel != null) entry.midiChannel = channel;
      savePadMap(padMap);
    }
    setLearnSlot(null);
    renderPads();
    renderPadEditors();
    return;
  }
  // Route by (channel, note) membership in the ACTIVE bank — not channel role.
  const hit = findPadByNote(padMap, bank, note, channel);
  if (hit) {
    auditionPad(bank, hit.padNum, velocity);
    return;
  }
  // Miss: chromatic piano (any non-pad note plays keys — pads never steal).
  const { pitch, octave } = pitchOct(note);
  auditionKey(pitch, octave, `midi:${note}`, velocity);
  // Drift hint: pad expects a different channel than what arrived.
  if (channel != null) {
    for (const b of ['A', 'B']) {
      for (const [padNum, entry] of Object.entries(padMap[b] || {})) {
        if (entry?.midiNote === note && (entry?.midiChannel ?? DEFAULT_PAD_CHANNEL) !== channel) {
          midiPill.textContent = `MIDI: pad ${b}${padNum} expects Ch ${(entry.midiChannel ?? 9) + 1}, got Ch ${channel + 1} — relearn?`;
          midiPill.dataset.kind = 'none';
          return;
        }
      }
    }
  }
}

function onMidiNoteOff(note) { releaseKey(`midi:${note}`); }

function onMidiCC(cc, value) {
  pushMidiLog(`ch ? cc ${cc} val ${value}`);
  const slot = getLearnSlot();
  if (slot?.kind === 'knob') {
    knobCC[slot.index] = cc;
    setLearnSlot(null);
    renderKnobs();
    return;
  }
  const idx = knobCC.indexOf(cc);
  if (idx >= 0) applyKnob(idx, value / 127);
  if (cc === 1) {
    joyY = value / 127;
    joyDot.style.top = `${(1 - joyY) * 100}%`;
    joyReadout.textContent = `X ${joyX.toFixed(2)} Y ${joyY.toFixed(2)}`;
  }
}

function onMidiBend(value) {
  joyX = Math.min(1, Math.max(-1, value));
  joyDot.style.left = `${(joyX * 0.5 + 0.5) * 100}%`;
  joyReadout.textContent = `X ${joyX.toFixed(2)} Y ${joyY.toFixed(2)}`;
}

function updateMidiStatus(status) {
  const labels = {
    unsupported: 'MIDI n/a', denied: 'MIDI denied', none: 'MIDI: none',
    ready: status.deviceName ? `MIDI: ${status.deviceName}` : 'MIDI: ready',
  };
  midiPill.textContent = labels[status.kind] || 'MIDI…';
  midiPill.dataset.kind = status.kind;
}

playBtn.addEventListener('click', () => {
  ensureAudio();
  flushPendingLoads();
  transport.start();
  setPlaying(true);
});
stopBtn.addEventListener('click', () => {
  transport.stop();
  gridEl.querySelectorAll('.mbz-cell.is-playhead').forEach((c) => c.classList.remove('is-playhead'));
  setPlaying(false);
});
bpmInput.addEventListener('change', () => {
  project.bpm = getBpm();
  bpmInput.value = String(project.bpm);
  persist();
});
swingInput.addEventListener('input', () => {
  project.swing = clamp01(parseInt(swingInput.value, 10) / 100);
  swingVal.textContent = `${swingInput.value}%`;
  persist();
});
sigSelect.addEventListener('change', () => {
  const [a, b] = sigSelect.value.split('/').map(Number);
  project.timeSignature = [a || 4, b || 4];
  persist();
  renderGrid();
});
barsSelect.addEventListener('change', () => {
  const pat = activePattern();
  if (pat) {
    pat.bars = Math.min(4, Math.max(1, parseInt(barsSelect.value, 10) || 1));
    const len = getTotalSteps();
    for (const ch of pat.channels) ch.steps = Array.from({ length: len }, (_, i) => ch.steps[i] || null);
  }
  persist();
  renderGrid();
});
patternSelect.addEventListener('change', () => {
  project.activePatternId = patternSelect.value;
  arrangeSlots = arrangementToSlots(project.arrangement, Math.max(1, arrangementLengthBars(project.arrangement) || 1));
  persist();
  renderGrid();
  renderPatterns();
});
velInput.addEventListener('input', () => {
  if (!selectedCell) return;
  const ch = findChannel(selectedCell.channelId);
  const step = ch?.steps[selectedCell.stepIndex];
  if (!step) return;
  step.velocity = clamp01(parseInt(velInput.value, 10) / 100);
  velVal.textContent = `${velInput.value}%`;
  persist();
});

document.querySelector('[data-oct-down]').addEventListener('click', () => {
  baseOct = Math.max(1, baseOct - 1);
  renderKeyboard();
});
document.querySelector('[data-oct-up]').addEventListener('click', () => {
  baseOct = Math.min(5, baseOct + 1);
  renderKeyboard();
});
document.querySelector('[data-bank-a]').addEventListener('click', () => {
  bank = 'A';
  document.querySelector('[data-bank-a]').classList.add('is-active');
  document.querySelector('[data-bank-b]').classList.remove('is-active');
  renderPads();
});
document.querySelector('[data-bank-b]').addEventListener('click', () => {
  bank = 'B';
  document.querySelector('[data-bank-b]').classList.add('is-active');
  document.querySelector('[data-bank-a]').classList.remove('is-active');
  renderPads();
});
document.querySelector('[data-audition]').addEventListener('click', (e) => {
  audition = !audition;
  e.currentTarget.classList.toggle('is-on', audition);
});
document.querySelector('[data-capture]').addEventListener('click', (e) => {
  capturing = !capturing;
  e.currentTarget.classList.toggle('is-on', capturing);
  if (capturing) {
    recordBuffer = [];
    loopOriginTime = ensureAudio().currentTime;
  } else if (recordBuffer.length) {
    const pat = activePattern();
    if (pat) {
      const sps = 60 / getBpm() / 4;
      for (const hit of recordBuffer) {
        const dt = Math.max(0, hit.t - loopOriginTime);
        const stepIdx = Math.round(dt / sps) % Math.max(1, getTotalSteps());
        let ch = null;
        if (hit.kind === 'pad' && hit.entry?.target === 'drum') {
          ch = pat.channels.find((c) => c.type === 'percussion' && c.voiceId === hit.entry.voiceId)
            || pat.channels.find((c) => c.type === 'percussion');
        } else if (hit.kind === 'key') {
          ch = pat.channels.find((c) => c.type === 'note' && c.instrumentId === hit.instrumentId) || null;
        }
        if (ch && ch.steps[stepIdx] === null) ch.steps[stepIdx] = { velocity: clamp01(hit.velocity) };
      }
      persist();
      renderGrid();
    }
    recordBuffer = [];
  }
});
document.querySelector('[data-grid-clear]').addEventListener('click', () => {
  const pat = activePattern();
  if (!pat) return;
  for (const ch of pat.channels) ch.steps = ch.steps.map(() => null);
  selectedCell = null;
  persist();
  renderGrid();
  updateVelocityUi();
});
document.querySelector('[data-grid-reset]').addEventListener('click', () => {
  project = resetMbzProject();
  arrangeSlots = arrangementToSlots(project.arrangement, 1);
  persist();
  syncControlsFromProject();
  renderPatterns();
  renderGrid();
});
keysCurveSel.addEventListener('change', () => { keysCurve = keysCurveSel.value; });

// Computer keyboard: A = C at visible base (ported from suite dock map).
function isTypingTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!target.isContentEditable;
}
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (isTypingTarget(e.target)) return;
  const offset = PC_NOTE_OFFSETS[e.code];
  if (offset == null) return;
  e.preventDefault();
  if (heldPc.has(e.code)) return;
  heldPc.add(e.code);
  const { pitch, octave } = pitchOct(midiFromBase(baseOct, offset));
  auditionKey(pitch, octave, `pc:${pitch}|${octave}`, 0.85);
});
window.addEventListener('keyup', (e) => {
  if (!heldPc.has(e.code)) return;
  heldPc.delete(e.code);
  const offset = PC_NOTE_OFFSETS[e.code];
  if (offset == null) return;
  const { pitch, octave } = pitchOct(midiFromBase(baseOct, offset));
  releaseKey(`pc:${pitch}|${octave}`);
});

function syncControlsFromProject() {
  bpmInput.value = String(project.bpm);
  swingInput.value = String(Math.round(clamp01(project.swing) * 100));
  swingVal.textContent = `${Math.round(clamp01(project.swing) * 100)}%`;
  sigSelect.value = `${project.timeSignature[0]}/${project.timeSignature[1]}`;
  barsSelect.value = String(getBars());
  renderKeysInstrumentOptions();
  updateProjectNote();
}

/** Grouped keys dropdown: optgroup per category, sample dot while loading. */
function renderKeysInstrumentOptions() {
  const current = keysInst.value || DEFAULT_KEYS_INSTRUMENT;
  const statuses = samplerStatus();
  const groups = INSTRUMENT_CATEGORIES.map((cat) => {
    const opts = INSTRUMENT_OPTIONS
      .filter((o) => o.category === cat)
      .map((o) => {
        const dot = o.engine === 'sample' ? (statuses[o.id] === 'ready' ? ' ●' : ' ○') : '';
        return `<option value="${esc(o.id)}"${o.id === current ? ' selected' : ''}>${esc(o.label)}${dot}</option>`;
      }).join('');
    return opts ? `<optgroup label="${esc(cat)}">${opts}</optgroup>` : '';
  }).join('');
  keysInst.innerHTML = groups;
  if (![...keysInst.options].some((o) => o.value === current)) {
    keysInst.value = DEFAULT_KEYS_INSTRUMENT;
  }
}

connectMbzMidi({
  onNoteOn: onMidiNoteOn,
  onNoteOff: onMidiNoteOff,
  onCC: onMidiCC,
  onPitchBend: onMidiBend,
  onStatus: updateMidiStatus,
});

// Firmware check (top-right): lazy SysEx inquiry, read-only query.
const fwBtn = document.querySelector('[data-fw-check]');
const fwPill = document.querySelector('[data-fw-status]');
const FW_ERROR_LABELS = {
  'sysex-blocked': 'fw: sysex blocked (Chrome + HTTPS)',
  'no-outputs': 'fw: no MIDI outputs',
  'no-reply': 'fw: no reply — MPK selected?',
  'send-failed': 'fw: send failed',
  denied: 'fw: MIDI denied',
  unsupported: 'fw: MIDI n/a',
};
if (fwBtn) {
  fwBtn.addEventListener('click', async () => {
    if (!fwPill) return;
    fwBtn.disabled = true;
    fwPill.textContent = 'fw: asking…';
    fwPill.dataset.kind = 'none';
    try {
      const info = await queryFirmwareVersion();
      fwPill.textContent = `fw ${info.version}`;
      fwPill.title = `firmware ${info.version} · raw ${info.raw}`;
      fwPill.dataset.kind = 'ready';
    } catch (err) {
      const label = FW_ERROR_LABELS[err?.message] || 'fw: failed';
      fwPill.textContent = label;
      fwPill.title = label;
      fwPill.dataset.kind = 'denied';
    } finally {
      fwBtn.disabled = false;
    }
  });
}

syncControlsFromProject();
renderPatterns();
renderGrid();
renderKeyboard();
renderPads();
renderKnobs();
renderPadEditors();
updateVelocityUi();
proveAssets();
// Grand preload is gesture-gated (autoplay policy) — preloadDefaults marks
// pending until first Play/pad/key tap, then flushPendingLoads() fires it.
preloadDefaults();
onSamplerStatus(() => renderKeysInstrumentOptions());
keysInst.addEventListener('change', () => {
  const resolved = resolveInstrument(keysInst.value);
  if (resolved.engine === 'sample' && !isSampleReady(resolved.id)) {
    ensureSample(resolved.id).then(() => renderKeysInstrumentOptions());
  }
});
if (imported) projectNote.textContent += ' · imported suite beats';

