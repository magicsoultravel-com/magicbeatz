/**
 * magicbeatz console — standalone AKAI MPK mini console (src/app/console.js).
 * Composition root: transport + pads + keys + grid + MIDI wiring.
 */
import { getAudioContext, ensureAudio } from '../audio/context.js';
import {
  clampBpm, clamp01, beatsFromTimeSignature, totalSteps,
  stepsPerBar, createEmptyPattern,
  DEFAULT_VELOCITY, INSTRUMENT_OPTIONS,
} from '../sequencer/pattern.js';
import {
  getActivePattern, arrangementToSlots, slotsToArrangement,
  arrangementLengthBars, resolveArrangementStep, duplicatePattern,
  MAX_ARRANGE_BARS,
} from '../sequencer/project.js';
import { createStepTransport } from '../sequencer/transport.js';
import { playChannelHit } from '../audio/banks.js';
import { playPercussionVoice } from '../audio/percussion.js';
import {
  playPitchedInstrument, playPitchedChord, startPitchedSustain, stopPitchedSustain,
  SUSTAIN_INSTRUMENTS, setStickBendCents, setStickVibrato,
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
import { DEFAULT_KEYS_INSTRUMENT } from '../state/settings.js';
import { getMasterBus, peekMasterGain } from '../audio/context.js';
import { getFxChain } from '../audio/fx.js';
import { registerCoreParams, registerChannelGains, resolveBinding, syncDelayToBpm } from '../params/coreParams.js';
import { loadKnobMap, saveKnobMap, bindingFor, knobConflicts } from '../params/bindings.js';
import {
  loadStickMap, saveStickMap,
  STICK_X_OPTIONS, STICK_Y_OPTIONS, STICK_X_SOURCES, BEND_RANGE_CENTS,
} from '../params/stick.js';
import { dispatchCC, refreshKnobUIFromParams } from '../params/dispatch.js';
import { listParamsByGroup, getParam, PARAM_GROUPS } from '../params/registry.js';
import { paramToNorm, normToParam } from '../params/scale.js';
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
// Session — clip launcher + arrangement timeline (live looper / song mode).
let queuedPatternId = null; // clip waiting to start at the next bar boundary
let songPlayingPatternId = null; // pattern sounding under the current song bar
let launchPads = false; // pads P1–P8 queue clips instead of auditioning
let playbackUiActive = false; // playhead guard (transport may self-stop at song end)
let renamePatternId = null; // pattern with an open inline rename editor
const CLIP_COLORS = ['#ff5d5d', '#ffb84d', '#57e6a8', '#6aa8ff', '#c07bff', '#ff8ad8', '#4de1e8', '#9ae66e'];
const MAX_CLIP_PATTERNS = 16;
function clipColor(i) { return CLIP_COLORS[i % CLIP_COLORS.length]; }
// Approach B: knob slots + param bindings (persisted in magicbeatz-knobmap-v1).
let knobMap = loadKnobMap();
let stickMap = loadStickMap();
let joyX = 0, joyY = 0;
let knobPopoverKnob = null; // knobId with open assign popover
let knobUiNorm = {}; // knobId -> last norm for dial arcs

// ---------- dom ----------
const $ = (sel) => document.querySelector(sel);
const midiPill = $('[data-midi-status]');
const assetPill = $('[data-asset-status]');
const knobsEl = $('[data-knobs]');
const joyDot = $('[data-joystick-dot]');
const joyReadout = $('[data-joystick-readout]');
const joyBox = $('[data-joystick]');
const stickXSel = $('[data-stick-x]');
const stickYSel = $('[data-stick-y]');
const stickXSrcSel = $('[data-stick-xsrc]');
const stickYccInput = $('[data-stick-ycc]');
const stickLearnBtn = $('[data-stick-learn]');
const stickSpringX = $('[data-stick-springx]');
const stickSpringY = $('[data-stick-springy]');
const stickXSlider = $('[data-stick-xslider]');
const stickYSlider = $('[data-stick-yslider]');
const stickHint = $('[data-stick-hint]');
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
const fxFilter = $('[data-fx-filter]');
const fxFilterVal = $('[data-fx-filter-val]');
const fxDelay = $('[data-fx-delay]');
const fxDelayVal = $('[data-fx-delay-val]');
const fxVerb = $('[data-fx-verb]');
const fxVerbVal = $('[data-fx-verb-val]');
// Session block refs (added with the clip launcher + arrangement timeline).
const modeLiveBtn = $('[data-mode-live]');
const modeSongBtn = $('[data-mode-song]');
const launchBtn = $('[data-launch-mode]');
const launchHintEl = $('[data-launch-hint]');
const clipsEl = $('[data-clips]');
const arrangeEl = $('[data-arrange]');
const arrangeLenEl = $('[data-arrange-len]');
const arrangeLoopEl = $('[data-arrange-loop]');
const arrangeAddBtn = $('[data-arrange-add]');
const arrangeDelBtn = $('[data-arrange-del]');
const patternNewBtn = $('[data-pattern-new]');
const patternDupBtn = $('[data-pattern-dup]');
const patternRenBtn = $('[data-pattern-ren]');
const patternDelBtn = $('[data-pattern-del]');
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
  const mode = project.playMode === 'song' ? 'song' : 'live';
  const queued = queuedPatternId
    ? ` → ${project.patterns.find((p) => p.id === queuedPatternId)?.name || '?'}`
    : '';
  projectNote.textContent = `project: magicbeatz-v1 bpm ${project.bpm} · ${mode} · ${pat?.name || '?'}${queued}${imported ? ' imported from suite' : ''}`;
}

function getBpm() { return clampBpm(parseInt(bpmInput.value, 10) || 120); }
function getBeats() { return beatsFromTimeSignature(project.timeSignature); }
function getBars() { return Math.min(4, Math.max(1, activePattern()?.bars || 1)); }
function getTotalSteps() {
  if (project.playMode === 'song') {
    // Song mode: the whole arrangement timeline is one long loop.
    const bars = Math.max(1, Math.min(
      MAX_ARRANGE_BARS,
      arrangeSlots.length || arrangementLengthBars(project.arrangement) || 1,
    ));
    return totalSteps(bars, getBeats());
  }
  return totalSteps(getBars(), getBeats());
}

function schedulePlayhead(when, localStep) {
  const delay = Math.max(0, (when - getAudioContext().currentTime) * 1000 - 8);
  window.setTimeout(() => {
    if (!playbackUiActive) return;
    gridEl.querySelectorAll('.mbz-cell.is-playhead').forEach((c) => c.classList.remove('is-playhead'));
    gridEl.querySelectorAll(`.mbz-cell[data-step="${localStep}"]`).forEach((c) => c.classList.add('is-playhead'));
  }, delay);
}

/** Timeline playhead: highlight the sounding bar in song mode. */
function scheduleArrangePlayhead(when, bar) {
  const delay = Math.max(0, (when - getAudioContext().currentTime) * 1000 - 8);
  window.setTimeout(() => {
    if (!playbackUiActive || project.playMode !== 'song') return;
    arrangeEl?.querySelectorAll('.mbz-bar.is-playhead').forEach((c) => c.classList.remove('is-playhead'));
    arrangeEl?.querySelector(`.mbz-bar[data-bar="${bar}"]`)?.classList.add('is-playhead');
  }, delay);
}

function clearPlayheads() {
  gridEl.querySelectorAll('.mbz-cell.is-playhead').forEach((c) => c.classList.remove('is-playhead'));
  arrangeEl?.querySelectorAll('.mbz-bar.is-playhead').forEach((c) => c.classList.remove('is-playhead'));
}

/** Schedule a grid playhead clear (used when the sounding pattern ≠ edit view). */
function scheduleGridClear(when) {
  const delay = Math.max(0, (when - getAudioContext().currentTime) * 1000 - 8);
  window.setTimeout(() => {
    if (!playbackUiActive) return;
    gridEl.querySelectorAll('.mbz-cell.is-playhead').forEach((c) => c.classList.remove('is-playhead'));
  }, delay);
}

/** Song end with loop off: let the final step sound, then park the UI. */
function scheduleSongEnd(when) {
  const delay = Math.max(0, (when - getAudioContext().currentTime) * 1000 + 60);
  window.setTimeout(() => {
    if (project.playMode !== 'song' || project.arrangeLoop !== false) return;
    if (transport.isRunning()) return; // still looping (mode flipped mid-bar)
    onTransportStopped();
  }, delay);
}

function playPatternChannels(pat, idx, when) {
  for (const ch of pat.channels) {
    if (ch.mute) continue;
    const anySolo = pat.channels.some((c) => c.solo);
    if (anySolo && !ch.solo) continue;
    const step = ch.steps[idx];
    if (!step) continue;
    playChannelHit(ch, when, step.velocity, chordCtx());
  }
}

/** Song mode: the arrangement timeline owns the loop; clips pick the voice. */
function onSongStep(stepIndex, total, when) {
  const spb = Math.max(1, stepsPerBar(getBeats()));
  const bar = Math.floor(stepIndex / spb);
  scheduleArrangePlayhead(when, bar);
  const resolved = resolveArrangementStep(project, stepIndex, arrangeSlots.length);
  if (resolved) {
    if (resolved.pattern.id !== songPlayingPatternId) {
      songPlayingPatternId = resolved.pattern.id;
      renderSession();
    }
    if (resolved.pattern.id === project.activePatternId) {
      schedulePlayhead(when, resolved.localStep);
    } else {
      scheduleGridClear(when);
    }
    playPatternChannels(resolved.pattern, resolved.localStep, when);
  } else {
    // Empty bar = rest: keep the timeline moving, grid goes dark.
    scheduleGridClear(when);
  }
  if (!project.arrangeLoop && stepIndex >= total - 1) scheduleSongEnd(when);
}

const transport = createStepTransport({
  getBpm,
  getBeatsPerMeasure: getBeats,
  getBars,
  getTotalSteps,
  getLoop: () => project.playMode !== 'song' || project.arrangeLoop !== false,
  getSwing: () => clamp01(project.swing),
  onStep(stepIndex, _total, when) {
    if (stepIndex === 0) loopOriginTime = when;
    if (project.playMode === 'song') {
      onSongStep(stepIndex, _total, when);
      return;
    }
    // Live looper: consume a queued clip at the next bar boundary so the
    // new pattern restarts cleanly on its step 0.
    let idx = stepIndex;
    if (queuedPatternId && stepIndex % Math.max(1, stepsPerBar(getBeats())) === 0) {
      if (project.patterns.some((p) => p.id === queuedPatternId)
        && queuedPatternId !== project.activePatternId) {
        setActivePattern(queuedPatternId);
        if (idx !== 0) {
          transport.setStep(0);
          idx = 0;
        }
      }
      queuedPatternId = null;
      renderSession();
    }
    const pat = activePattern();
    if (!pat) return;
    schedulePlayhead(when, idx);
    playPatternChannels(pat, idx, when);
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
    btn.innerHTML = `<b>P${padNum}</b><small>${esc(launchPads ? padLaunchLabel(padNum) : padLabel(entry))}</small><small>ch ${ch} · note ${entry?.midiNote ?? '—'} · ${esc(entry?.curve || 'linear')}</small>`;
    // Pointer capture, same release path as keys (stuck-key fix covers pads too)
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (launchPads) {
        const pat = project.patterns[padNum - 1];
        if (pat) queuePattern(pat.id);
        flashPad(padNum);
        return;
      }
      auditionPad(bank, padNum, 0.9);
    });
    padsEl.appendChild(btn);
  }
}

/** Pad button label while launch mode maps P1–P8 onto the clip bank. */
function padLaunchLabel(padNum) {
  const pat = project.patterns[padNum - 1];
  return pat ? `▶ ${pat.name}` : '—';
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

// ---------- session: clip launcher + arrangement timeline ----------

/** Pattern the launcher highlights as sounding (song: per-bar, else edit view). */
function playingClipId() {
  if (project.playMode === 'song' && playbackUiActive && songPlayingPatternId) {
    return songPlayingPatternId;
  }
  return project.activePatternId;
}

function syncSessionButtons() {
  if (modeLiveBtn) {
    const live = project.playMode !== 'song';
    modeLiveBtn.classList.toggle('is-active', live);
    modeSongBtn.classList.toggle('is-active', !live);
    modeLiveBtn.setAttribute('aria-pressed', String(live));
    modeSongBtn.setAttribute('aria-pressed', String(!live));
  }
  if (launchBtn) {
    launchBtn.classList.toggle('is-active', launchPads);
    launchBtn.setAttribute('aria-pressed', String(launchPads));
    launchBtn.title = launchPads
      ? 'Launch mode ON — pads P1–P8 queue clips (click to restore audition)'
      : 'Launch mode — pads P1–P8 queue clips instead of auditioning';
  }
  if (launchHintEl) launchHintEl.textContent = launchPads ? ' · clips ▶' : '';
  if (arrangeLoopEl) arrangeLoopEl.checked = project.arrangeLoop !== false;
}

/** Unified pattern switch (dropdown, clips, keys, pads). */
function setActivePattern(patternId, opts = {}) {
  if (!project.patterns.some((p) => p.id === patternId)) return;
  if (!opts.keepQueue) queuedPatternId = null;
  if (project.activePatternId !== patternId) {
    project.activePatternId = patternId;
    selectedCell = null;
  }
  arrangeSlots = arrangementToSlots(project.arrangement, Math.max(1, arrangementLengthBars(project.arrangement) || 1));
  persist();
  syncControlsFromProject();
  renderPatterns();
  renderGrid();
  renderSession();
  updateVelocityUi();
  syncParamRegistry();
  renderKnobs();
}

/**
 * Launcher entry point: click / key 1–8 / pad.
 * Live + running → quantized queue (next bar). Otherwise picks the edit
 * pattern immediately (song mode has no queue — clips act like the dropdown).
 */
function queuePattern(patternId) {
  if (!project.patterns.some((p) => p.id === patternId)) return;
  ensureAudio();
  flushPendingLoads();
  if (project.playMode !== 'pattern' || !transport.isRunning()) {
    setActivePattern(patternId);
    return;
  }
  if (patternId === project.activePatternId) {
    if (queuedPatternId && queuedPatternId !== patternId) {
      queuedPatternId = null;
      renderSession();
    }
    return;
  }
  queuedPatternId = queuedPatternId === patternId ? null : patternId; // toggle
  renderSession();
}

function startRename(patternId) {
  if (!project.patterns.some((p) => p.id === patternId)) return;
  renamePatternId = patternId;
  renderClips();
}

function commitRename(patternId, value) {
  const wasOpen = renamePatternId !== null;
  renamePatternId = null;
  const p = project.patterns.find((pp) => pp.id === patternId);
  const name = String(value ?? '').trim().slice(0, 24);
  if (wasOpen && p && name) {
    p.name = name;
    persist();
  }
  renderPatterns();
  renderClips();
}

function renderClips() {
  if (!clipsEl) return;
  clipsEl.innerHTML = '';
  const playingId = playingClipId();
  project.patterns.forEach((p, i) => {
    const live = project.playMode !== 'song';
    if (p.id === renamePatternId) {
      const wrap = document.createElement('span');
      wrap.className = 'mbz-clip is-editing';
      wrap.style.setProperty('--clip', clipColor(i));
      const input = document.createElement('input');
      input.value = p.name;
      input.maxLength = 24;
      input.setAttribute('aria-label', `Rename ${p.name}`);
      let committed = false;
      const done = (save) => {
        if (committed) return;
        committed = true;
        if (save) commitRename(p.id, input.value);
        else { renamePatternId = null; renderClips(); }
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(true);
        else if (e.key === 'Escape') done(false);
      });
      input.addEventListener('pointerdown', (e) => e.stopPropagation());
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('blur', () => done(true));
      wrap.appendChild(input);
      clipsEl.appendChild(wrap);
      window.setTimeout(() => { input.focus(); input.select(); }, 0);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mbz-clip';
    btn.dataset.patternId = p.id;
    btn.style.setProperty('--clip', clipColor(i));
    if (p.id === playingId) btn.classList.add('is-playing');
    if (p.id === queuedPatternId) btn.classList.add('is-queued');
    if (p.id === project.activePatternId) btn.classList.add('is-edit');
    const key = i < 8 ? `<kbd>${i + 1}</kbd>` : '';
    const pad = i < 8 && launchPads && live ? `<span class="mbz-clip-pad">P${i + 1}</span>` : '';
    const nm = document.createElement('span');
    nm.className = 'mbz-clip-name';
    nm.textContent = p.name;
    btn.appendChild(nm);
    const meta = document.createElement('small');
    meta.innerHTML = `${esc(p.bars)}b ${key}${pad}`;
    btn.appendChild(meta);
    btn.title = live
      ? `${p.name} · click queues at the next bar · key ${i + 1} · double-click renames`
      : `${p.name} · song mode: click selects the edit pattern`;
    btn.addEventListener('click', () => queuePattern(p.id));
    btn.addEventListener('dblclick', () => startRename(p.id));
    clipsEl.appendChild(btn);
  });
}

function shortPatternLabel(name) {
  const s = String(name || '').trim();
  return s.length > 7 ? `${s.slice(0, 7)}…` : s;
}

function paintArrangeBar(b) {
  if (b < 0 || b >= arrangeSlots.length) return;
  const target = project.activePatternId;
  arrangeSlots[b] = arrangeSlots[b] === target ? '' : target;
  persist();
  renderArrange();
}

function renderArrange() {
  if (!arrangeEl) return;
  arrangeEl.innerHTML = '';
  const len = Math.max(1, Math.min(MAX_ARRANGE_BARS, arrangeSlots.length || 1));
  const byId = new Map(project.patterns.map((p, i) => [p.id, { p, i }]));
  for (let b = 0; b < len; b += 1) {
    const id = arrangeSlots[b] || '';
    const info = id ? byId.get(id) : null;
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = `mbz-bar${info ? ' is-filled' : ''}${id && id === project.activePatternId ? ' is-edit' : ''}`;
    cell.dataset.bar = String(b);
    if (info) {
      cell.style.setProperty('--clip', clipColor(info.i));
      cell.title = `bar ${b + 1}: ${info.p.name} · click = clear`;
    } else {
      cell.title = `bar ${b + 1}: rest · click = paint ${activePattern()?.name || '?'}`;
    }
    const num = document.createElement('span');
    num.textContent = String(b + 1);
    const lbl = document.createElement('b');
    lbl.textContent = info ? shortPatternLabel(info.p.name) : '·';
    cell.appendChild(num);
    cell.appendChild(lbl);
    cell.addEventListener('click', () => paintArrangeBar(b));
    arrangeEl.appendChild(cell);
  }
  if (arrangeLenEl) arrangeLenEl.textContent = `${len} bar${len === 1 ? '' : 's'}`;
  if (arrangeAddBtn) arrangeAddBtn.disabled = len >= MAX_ARRANGE_BARS;
  if (arrangeDelBtn) arrangeDelBtn.disabled = len <= 1;
}

function renderSession() {
  syncSessionButtons();
  renderClips();
  renderArrange();
  updateProjectNote();
}

/** Shared stop path: stop button + song end with loop off. */
function onTransportStopped() {
  transport.stop();
  playbackUiActive = false;
  queuedPatternId = null;
  songPlayingPatternId = null;
  clearPlayheads();
  setPlaying(false);
  renderSession();
}

function setPlayMode(mode) {
  const next = mode === 'song' ? 'song' : 'pattern';
  if (project.playMode === next) return;
  project.playMode = next;
  queuedPatternId = null;
  songPlayingPatternId = null;
  arrangeSlots = arrangementToSlots(project.arrangement, Math.max(1, arrangementLengthBars(project.arrangement) || 1));
  persist();
  renderSession();
  if (transport.isRunning()) {
    // Restart so the new loop (pattern or full timeline) begins at step 0.
    transport.stop();
    transport.start();
  }
}

function refreshPatternViews() {
  persist();
  syncControlsFromProject();
  renderPatterns();
  renderGrid();
  renderSession();
  updateVelocityUi();
  syncParamRegistry();
  renderKnobs();
}

function addPattern() {
  if (project.patterns.length >= MAX_CLIP_PATTERNS) return;
  const pat = createEmptyPattern({
    name: `Pattern ${project.patterns.length + 1}`,
    bars: 1,
    timeSignature: project.timeSignature,
  });
  project.patterns.push(pat);
  project.activePatternId = pat.id;
  selectedCell = null;
  refreshPatternViews();
  startRename(pat.id);
}

function duplicateActivePattern() {
  const src = activePattern();
  if (!src || project.patterns.length >= MAX_CLIP_PATTERNS) return;
  const copy = duplicatePattern(src, `${src.name} copy`);
  const idx = project.patterns.findIndex((p) => p.id === src.id);
  project.patterns.splice(idx + 1, 0, copy);
  project.activePatternId = copy.id;
  selectedCell = null;
  refreshPatternViews();
  startRename(copy.id);
}

function deleteActivePattern() {
  if (project.patterns.length <= 1) return;
  const id = project.activePatternId;
  project.patterns = project.patterns.filter((p) => p.id !== id);
  project.activePatternId = project.patterns[0].id;
  if (queuedPatternId === id) queuedPatternId = null;
  arrangeSlots = arrangeSlots.map((s) => (s === id ? '' : s));
  selectedCell = null;
  refreshPatternViews();
}

function renderKnobs() {
  knobsEl.innerHTML = '';
  const conflicts = knobConflicts(knobMap);
  knobMap.knobs.forEach((knob) => {
    const binding = bindingFor(knobMap, knob.id);
    const resolved = binding?.paramId
      ? resolveBinding(binding, activePattern())
      : { desc: null, stale: false };
    const desc = resolved.desc;
    const stale = resolved.stale;
    const group = desc ? PARAM_GROUPS[desc.group] : PARAM_GROUPS.unmapped;
    const label = desc ? (desc.short || desc.label) : '—';
    let live = null;
    try { live = desc?.get(); } catch { live = null; }
    const valText = desc && live != null ? desc.format(live) : '—';
    let norm = 0;
    try { norm = desc && live != null ? paramToNorm(live, binding, desc) : 0; } catch { norm = 0; }
    knobUiNorm[knob.id] = norm;
    const warn = conflicts.get(knob.id);
    const wrap = document.createElement('div');
    wrap.className = `mbz-knob${stale ? ' is-stale' : ''}${!desc ? ' is-unmapped' : ''}`;
    wrap.style.setProperty('--knob-group', group?.color || '#8a8496');
    wrap.dataset.knob = knob.id;
    const dial = document.createElement('div');
    dial.className = 'mbz-knob-dial';
    dial.style.setProperty('--v', norm.toFixed(3));
    dial.title = `${knob.id} · CC ${knob.cc} · ${desc ? desc.label : 'unmapped'} · ${valText}`;
    dial.addEventListener('click', () => openKnobPopover(knob.id));
    wrap.appendChild(dial);
    const title = document.createElement('b');
    title.innerHTML = `<span class="mbz-knob-dot"></span>${esc(knob.id)}`;
    wrap.appendChild(title);
    const tgt = document.createElement('small');
    tgt.className = 'mbz-knob-target';
    tgt.textContent = label;
    wrap.appendChild(tgt);
    const valEl = document.createElement('small');
    valEl.className = 'mbz-knob-val';
    valEl.textContent = valText;
    wrap.appendChild(valEl);
    const ccEl = document.createElement('small');
    ccEl.className = 'mbz-knob-cc';
    ccEl.textContent = `CC ${knob.cc}`;
    wrap.appendChild(ccEl);
    if (warn) {
      const w = document.createElement('small');
      w.className = 'mbz-knob-warn';
      w.textContent = '⚠';
      w.title = warn.join('; ');
      wrap.appendChild(w);
    }
    if (stale) {
      const s = document.createElement('small');
      s.className = 'mbz-knob-warn';
      s.textContent = 'stale';
      wrap.appendChild(s);
    }
    const assignBtn = document.createElement('button');
    assignBtn.type = 'button';
    assignBtn.className = 'mbz-knob-assign';
    assignBtn.textContent = knobPopoverKnob === knob.id ? 'close' : 'assign';
    assignBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (knobPopoverKnob === knob.id) closeKnobPopover();
      else openKnobPopover(knob.id);
    });
    wrap.appendChild(assignBtn);
    const slot = getLearnSlot();
    const armed = (slot?.kind === 'knob' || slot?.kind === 'knob-cc')
      && (slot.knobId === knob.id || slot.index === knobMap.knobs.indexOf(knob));
    const learnBtn = document.createElement('button');
    learnBtn.type = 'button';
    if (armed) learnBtn.classList.add('is-learning');
    learnBtn.textContent = armed ? '…wiggle' : 'learn';
    learnBtn.title = `MIDI learn: next CC binds to ${knob.id}`;
    learnBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (armed) { setLearnSlot(null); renderKnobs(); return; }
      setLearnSlot({ kind: 'knob-cc', knobId: knob.id });
      renderKnobs();
    });
    wrap.appendChild(learnBtn);
    knobsEl.appendChild(wrap);
  });
  if (knobPopoverKnob) renderKnobPopover();
}

function renderKnobPopover() {
  document.querySelector('.mbz-knob-pop')?.remove();
  const knobId = knobPopoverKnob;
  if (!knobId) return;
  const knob = knobMap.knobs.find((k) => k.id === knobId);
  const binding = bindingFor(knobMap, knobId);
  const card = knobsEl.querySelector(`[data-knob="${knobId}"]`);
  if (!knob || !binding || !card) return;
  const pop = document.createElement('div');
  pop.className = 'mbz-knob-pop';
  const curveOpts = ['linear', 'exp', 'step']
    .map((c) => `<option value="${c}"${binding.curve === c ? ' selected' : ''}>${c}</option>`).join('');
  const modeOpts = ['absolute', 'pickup', 'relative']
    .map((m) => `<option value="${m}"${knob.mode === m ? ' selected' : ''}>${m}</option>`).join('');
  pop.innerHTML = `<h4>${esc(knobId)} <span>CC ${knob.cc}</span></h4>`
    + `<label>controls<select data-p="param">${knobTargetOptions(binding.paramId)}</select></label>`
    + `<div class="mbz-knob-pop-grid">`
    + `<label>min<input data-p="min" type="number" min="0" max="1" step="0.01"></label>`
    + `<label>max<input data-p="max" type="number" min="0" max="1" step="0.01"></label>`
    + `<label>curve<select data-p="curve">${curveOpts}</select></label>`
    + `<label>mode<select data-p="mode">${modeOpts}</select></label>`
    + `</div><p class="mbz-knob-pop-val" data-p="liveval"></p>`
    + `<div class="mbz-knob-pop-row">`
    + `<button type="button" class="mbz-btn" data-p="midi">midi learn</button>`
    + `<button type="button" class="mbz-btn" data-p="clear">clear</button>`
    + `<button type="button" class="mbz-btn" data-p="done">done</button></div>`
    + `<p class="mbz-note">absolute = direct · pickup = no jumps · relative = endless</p>`;
  pop.querySelector('[data-p="min"]').value = String(binding.min ?? 0);
  pop.querySelector('[data-p="max"]').value = String(binding.max ?? 1);
  pop.querySelector('[data-p="param"]').addEventListener('change', (e) => {
    binding.paramId = e.target.value || null;
    saveKnobMap(knobMap);
    renderKnobs();
  });
  const bindNum = (key) => pop.querySelector(`[data-p="${key}"]`).addEventListener('change', (e) => {
    binding[key] = Math.min(1, Math.max(0, Number(e.target.value) || 0));
    saveKnobMap(knobMap);
    syncParamRegistry();
    renderKnobs();
  });
  bindNum('min');
  bindNum('max');
  pop.querySelector('[data-p="curve"]').addEventListener('change', (e) => {
    binding.curve = e.target.value;
    saveKnobMap(knobMap);
    renderKnobs();
  });
  pop.querySelector('[data-p="mode"]').addEventListener('change', (e) => {
    knob.mode = e.target.value;
    saveKnobMap(knobMap);
    renderKnobs();
  });
  pop.querySelector('[data-p="midi"]').addEventListener('click', () => {
    setLearnSlot({ kind: 'knob-cc', knobId });
    renderKnobs();
  });
  pop.querySelector('[data-p="clear"]').addEventListener('click', () => {
    binding.paramId = null;
    saveKnobMap(knobMap);
    renderKnobs();
  });
  pop.querySelector('[data-p="done"]').addEventListener('click', closeKnobPopover);
  card.appendChild(pop);
  renderKnobPopoverValues();
}

function openKnobPopover(knobId) {
  knobPopoverKnob = knobId;
  renderKnobs();
}
function closeKnobPopover() {
  knobPopoverKnob = null;
  renderKnobs();
}

function knobTargetOptions(selectedId) {
  const byGroup = listParamsByGroup();
  const order = ['transport', 'mix', 'synth'];
  let html = `<option value="">— unmapped —</option>`;
  for (const g of order) {
    const items = byGroup[g] || [];
    if (!items.length) continue;
    const label = PARAM_GROUPS[g]?.label || g;
    html += `<optgroup label="${esc(label)}">`;
    for (const d of items) {
      const sel = d.id === selectedId ? ' selected' : '';
      const dis = d.disabled ? ' disabled' : '';
      const soon = d.disabled ? ' (soon)' : '';
      html += `<option value="${esc(d.id)}"${sel}${dis}>${esc(d.label)}${soon}</option>`;
    }
    html += `</optgroup>`;
  }
  return html;
}

function renderKnobPopoverValues() {
  const pop = document.querySelector('.mbz-knob-pop');
  if (!pop || !knobPopoverKnob) return;
  const binding = bindingFor(knobMap, knobPopoverKnob);
  const el = pop.querySelector('[data-p="liveval"]');
  if (!el) return;
  const resolved = binding?.paramId
    ? resolveBinding(binding, activePattern())
    : { desc: null, stale: false };
  if (!resolved.desc) { el.textContent = 'unmapped — pick a target'; return; }
  let live = null;
  try { live = resolved.desc.get(); } catch { live = null; }
  const txt = live == null ? '—' : resolved.desc.format(live);
  el.textContent = `${resolved.desc.label}: ${txt}${resolved.stale ? ' · stale (pattern changed)' : ''}`;
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

/**
 * Register core + dynamic params, then paint knob arcs from live values.
 * Called on boot and whenever patterns/channels change.
 */
function syncParamRegistry() {
  registerChannelGains(activePattern(), { persist, renderGrid });
  refreshKnobUIFromParams(knobMap, activePattern, paintKnobArc);
}

/** Callback from dispatch: update dial arc + readout without re-render. */
function paintKnobArc(knobId, { norm, stale, waiting, unmapped } = {}) {
  if (typeof norm === 'number') knobUiNorm[knobId] = norm;
  const idx = knobMap.knobs.findIndex((k) => k.id === knobId);
  const card = knobsEl.children[idx];
  if (!card) return;
  const dial = card.querySelector('.mbz-knob-dial');
  const valEl = card.querySelector('[data-knob-val]');
  const binding = bindingFor(knobMap, knobId);
  const { desc } = binding?.paramId
    ? resolveBinding(binding, activePattern())
    : { desc: null };
  const n = typeof norm === 'number' ? norm : (knobUiNorm[knobId] ?? 0);
  if (dial) {
    dial.style.setProperty('--v', n.toFixed(3));
    dial.classList.toggle('is-waiting', !!waiting);
    dial.classList.toggle('is-stale', !!stale);
    dial.classList.toggle('is-unmapped', !!unmapped || !desc);
  }
  if (valEl) {
    if (!desc || unmapped) valEl.textContent = '—';
    else {
      const live = (() => { try { return desc.get(); } catch { return null; } })();
      valEl.textContent = live == null ? '—' : desc.format(live);
    }
  }
}

/** UI knob drag fallback: write through the same param path as MIDI. */
function applyKnobDrag(knobId, value01) {
  const binding = bindingFor(knobMap, knobId);
  if (!binding?.paramId) return;
  const { desc } = resolveBinding(binding, activePattern());
  if (!desc || desc.disabled) return;
  try { desc.set(normToParam(value01, binding, desc)); } catch { /* ignore */ }
  paintKnobArc(knobId, { norm: value01 });
  syncControlsFromProject();
  if (knobPopoverKnob) renderKnobPopoverValues();
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
    // Launch mode: hardware pads P1–P8 trigger the clip bank, never audition.
    if (launchPads) {
      const pat = project.patterns[hit.padNum - 1];
      if (pat) queuePattern(pat.id);
      flashPad(hit.padNum);
      return;
    }
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

function onMidiCC(cc, value, channel) {
  pushMidiLog(`cc ${cc} val ${value}`);
  const slot = getLearnSlot();
  // Split Learn: knob-cc (which physical knob am I?) vs knob-param (not used here).
  if (slot?.kind === 'knob' || slot?.kind === 'knob-cc') {
    const knobId = slot.knobId ?? knobMap.knobs[slot.index]?.id;
    const knob = knobMap.knobs.find((k) => k.id === knobId);
    if (knob) {
      knob.cc = cc & 0x7f;
      if (channel != null) knob.channel = null; // Any channel by default; strict in popover
      saveKnobMap(knobMap);
    }
    setLearnSlot(null);
    renderKnobs();
    syncStickUI();
    return;
  }
  // Stick Y learn: next CC binds stick Y (swallowed, not applied).
  if (slot?.kind === 'stick-y') {
    stickMap.yCC = cc & 0x7f;
    if (stickMap.xCC === stickMap.yCC && stickMap.xSource === 'cc') {
      stickMap.xCC = (stickMap.yCC + 16) & 0x7f; // keep X/Y apart
    }
    saveStickMap(stickMap);
    setLearnSlot(null);
    syncStickUI();
    pushMidiLog(`stick Y ← cc ${stickMap.yCC}`);
    return;
  }
  // Stick X-CC learn (for Editor-remapped sticks sending X as CC).
  if (slot?.kind === 'stick-x') {
    stickMap.xCC = cc & 0x7f;
    stickMap.xSource = 'cc';
    saveStickMap(stickMap);
    setLearnSlot(null);
    syncStickUI();
    pushMidiLog(`stick X ← cc ${stickMap.xCC}`);
    return;
  }
  const ccNum = cc & 0x7f;
  // Stick Y (mod): handled here even with no knob bound to that CC.
  if (ccNum === (stickMap.yCC & 0x7f)) {
    setStickY(value / 127, 'midi');
  }
  // Stick X via CC (Editor-remapped sticks): bipolar around 64.
  if ((stickMap.xSource === 'cc' || stickMap.xSource === 'auto') && ccNum === (stickMap.xCC & 0x7f)) {
    const v = Math.min(1, Math.max(-1, (value - 64) / 63));
    if (stickMap.xSource === 'cc' || Math.abs(value - 64) > 2) setStickX(v, 'midi');
  }
  // Channel-aware: knob with channel:null accepts any; strict knobs filter.
  const hits = knobMap.knobs.filter((k) => k.cc === (cc & 0x7f)
    && (k.channel == null || channel == null || k.channel === channel));
  if (!hits.length) {
    // Fallback: legacy index lookup during migration window
    syncControlsFromProject();
    syncFxStrip();
    return;
  }
  dispatchCC({
    cc: cc & 0x7f, value, map: knobMap,
    getPattern: activePattern,
    onKnobUI: paintKnobArc,
  });
  // Keep transport inputs + FX strip in sync (they are views on the same params)
  syncControlsFromProject();
  syncFxStrip();
  if (knobPopoverKnob) renderKnobPopoverValues();
}

function onMidiBend(value) {
  pushMidiLog(`bend ${Math.round(value * 8192)}`);
  if (stickMap.xSource === 'cc') { paintStick(); return; } // X comes from CC, ignore bend
  setStickX(Math.min(1, Math.max(-1, value)), 'midi');
}

function updateMidiStatus(status) {
  const labels = {
    unsupported: 'MIDI n/a', denied: 'MIDI denied', none: 'MIDI: none',
    ready: status.deviceName ? `MIDI: ${status.deviceName}` : 'MIDI: ready',
  };
  midiPill.textContent = labels[status.kind] || 'MIDI…';
  midiPill.dataset.kind = status.kind;
}

// ---------- stick engine: assignable X/Y with on-screen fallback ----------
function applyStickXTarget(x) {
  const t = stickMap.xTarget || 'bend';
  if (t === 'off') return;
  if (t === 'bend') {
    try { setStickBendCents(x * BEND_RANGE_CENTS); } catch { /* pre-gesture */ }
    return;
  }
  const desc = getParam(t);
  if (!desc || desc.disabled) return;
  try {
    const n = t === 'filter' ? (x * 0.5 + 0.5) : Math.abs(x);
    desc.set(desc.fromNorm ? desc.fromNorm(Math.min(1, Math.max(0, n))) : n);
  } catch { /* ignore */ }
}

function applyStickYTarget(y) {
  const t = stickMap.yTarget || 'vibrato';
  if (t === 'off') return;
  if (t === 'vibrato') {
    try { setStickVibrato(y); } catch { /* pre-gesture */ }
    return;
  }
  const desc = getParam(t);
  if (!desc || desc.disabled) return;
  try {
    desc.set(desc.fromNorm ? desc.fromNorm(Math.min(1, Math.max(0, y))) : y);
  } catch { /* ignore */ }
}

function paintStick() {
  if (joyDot) {
    joyDot.style.left = `${(joyX * 0.5 + 0.5) * 100}%`;
    joyDot.style.top = `${(1 - joyY) * 100}%`;
  }
  if (joyReadout) joyReadout.textContent = `X ${joyX.toFixed(2)} Y ${joyY.toFixed(2)}`;
  if (stickXSlider && document.activeElement !== stickXSlider) {
    stickXSlider.value = String(Math.round(joyX * 100));
  }
  if (stickYSlider && document.activeElement !== stickYSlider) {
    stickYSlider.value = String(Math.round(joyY * 127));
  }
}

function setStickX(v, origin) {
  joyX = Math.min(1, Math.max(-1, Number(v) || 0));
  try { ensureAudio(); } catch { /* fallback still paints */ }
  applyStickXTarget(joyX);
  paintStick();
  syncControlsFromProject();
  syncFxStrip();
  refreshKnobUIFromParams(knobMap, activePattern(), paintKnobArc);
  if (origin === 'midi' && stickHint) stickHint.textContent = 'hw stick heard — targets applied.';
}

function setStickY(v, origin) {
  joyY = Math.min(1, Math.max(0, Number(v) || 0));
  try { ensureAudio(); } catch { /* fallback still paints */ }
  applyStickYTarget(joyY);
  paintStick();
  syncControlsFromProject();
  syncFxStrip();
  refreshKnobUIFromParams(knobMap, activePattern(), paintKnobArc);
  if (origin === 'midi' && stickHint) stickHint.textContent = 'hw stick heard — targets applied.';
}

function syncStickUI() {
  if (stickXSel) {
    stickXSel.innerHTML = STICK_X_OPTIONS
      .map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('');
    stickXSel.value = stickMap.xTarget;
  }
  if (stickYSel) {
    stickYSel.innerHTML = STICK_Y_OPTIONS
      .map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('');
    stickYSel.value = stickMap.yTarget;
  }
  if (stickXSrcSel) {
    stickXSrcSel.innerHTML = STICK_X_SOURCES
      .map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('');
    stickXSrcSel.value = stickMap.xSource;
  }
  if (stickYccInput && document.activeElement !== stickYccInput) {
    stickYccInput.value = String(stickMap.yCC & 0x7f);
  }
  if (stickSpringX) stickSpringX.checked = stickMap.springX !== false;
  if (stickSpringY) stickSpringY.checked = stickMap.springY !== false;
  const slot = getLearnSlot();
  if (stickLearnBtn) {
    stickLearnBtn.classList.toggle('is-learning', slot?.kind === 'stick-y');
    stickLearnBtn.textContent = slot?.kind === 'stick-y' ? '…wiggle' : 'learn';
  }
  paintStick();
}

if (stickXSel) stickXSel.addEventListener('change', () => {
  stickMap.xTarget = stickXSel.value;
  saveStickMap(stickMap);
  applyStickXTarget(joyX);
  syncFxStrip();
});
if (stickYSel) stickYSel.addEventListener('change', () => {
  stickMap.yTarget = stickYSel.value;
  saveStickMap(stickMap);
  applyStickYTarget(joyY);
  syncFxStrip();
});
if (stickXSrcSel) stickXSrcSel.addEventListener('change', () => {
  stickMap.xSource = stickXSrcSel.value;
  saveStickMap(stickMap);
  syncStickUI();
});
if (stickYccInput) stickYccInput.addEventListener('change', () => {
  stickMap.yCC = Math.min(127, Math.max(0, parseInt(stickYccInput.value, 10) || 0));
  saveStickMap(stickMap);
  syncStickUI();
});
if (stickLearnBtn) stickLearnBtn.addEventListener('click', () => {
  const slot = getLearnSlot();
  setLearnSlot(slot?.kind === 'stick-y' ? null : { kind: 'stick-y' });
  syncStickUI();
  renderKnobs();
});
if (stickSpringX) stickSpringX.addEventListener('change', () => {
  stickMap.springX = !!stickSpringX.checked;
  saveStickMap(stickMap);
});
if (stickSpringY) stickSpringY.addEventListener('change', () => {
  stickMap.springY = !!stickSpringY.checked;
  saveStickMap(stickMap);
});
if (stickXSlider) stickXSlider.addEventListener('input', () => {
  setStickX((parseInt(stickXSlider.value, 10) || 0) / 100, 'screen');
});
if (stickYSlider) stickYSlider.addEventListener('input', () => {
  setStickY((parseInt(stickYSlider.value, 10) || 0) / 127, 'screen');
});
if (stickXSlider) stickXSlider.addEventListener('change', () => {
  if (stickMap.springX !== false) setStickX(0, 'screen');
});
if (stickYSlider) stickYSlider.addEventListener('change', () => {
  if (stickMap.springY !== false) setStickY(0, 'screen');
});
if (joyBox) {
  let dragging = false;
  const stickFromEvent = (e) => {
    const r = joyBox.getBoundingClientRect();
    const nx = Math.min(1, Math.max(-1, ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1));
    const ny = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / Math.max(1, r.height)));
    setStickX(nx, 'screen');
    setStickY(ny, 'screen');
  };
  joyBox.addEventListener('pointerdown', (e) => {
    dragging = true;
    try { joyBox.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    stickFromEvent(e);
  });
  joyBox.addEventListener('pointermove', (e) => { if (dragging) stickFromEvent(e); });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    if (stickMap.springX !== false) setStickX(0, 'screen');
    if (stickMap.springY !== false) setStickY(0, 'screen');
    paintStick();
  };
  joyBox.addEventListener('pointerup', endDrag);
  joyBox.addEventListener('pointercancel', endDrag);
}

playBtn.addEventListener('click', () => {
  ensureAudio();
  // First guaranteed gesture: build the FX chain now so the first knob
  // sweep has no mid-play master-bus rewire hiccup.
  try { getFxChain(); } catch { /* offline */ }
  flushPendingLoads();
  if (!transport.start()) return;
  playbackUiActive = true;
  songPlayingPatternId = null;
  if (project.playMode === 'song') clearPlayheads();
  setPlaying(true);
  renderSession();
});
stopBtn.addEventListener('click', () => {
  onTransportStopped();
});
bpmInput.addEventListener('change', () => {
  try { getParam('bpm')?.set(getBpm()); } catch { project.bpm = getBpm(); persist(); }
  syncControlsFromProject();
  syncParamRegistry();
  syncFxStrip();
  syncDelayToBpm(project.bpm);
});
swingInput.addEventListener('input', () => {
  try { getParam('swing')?.set(clamp01(parseInt(swingInput.value, 10) / 100)); }
  catch { project.swing = clamp01(parseInt(swingInput.value, 10) / 100); persist(); }
  syncControlsFromProject();
  if (!knobPopoverKnob) refreshKnobUIFromParams(knobMap, activePattern, paintKnobArc);
  else renderKnobPopoverValues();
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
  setActivePattern(patternSelect.value);
});

/** Session controls: mode, launch pads, timeline length, pattern bank. */
modeLiveBtn?.addEventListener('click', () => setPlayMode('pattern'));
modeSongBtn?.addEventListener('click', () => setPlayMode('song'));
launchBtn?.addEventListener('click', () => {
  launchPads = !launchPads;
  renderSession();
  renderPads();
});
arrangeLoopEl?.addEventListener('change', () => {
  project.arrangeLoop = arrangeLoopEl.checked !== false;
  persist();
  renderSession();
});
arrangeAddBtn?.addEventListener('click', () => {
  if (arrangeSlots.length >= MAX_ARRANGE_BARS) return;
  arrangeSlots.push('');
  persist();
  renderArrange();
});
arrangeDelBtn?.addEventListener('click', () => {
  if (arrangeSlots.length <= 1) return;
  arrangeSlots.pop();
  persist();
  renderArrange();
});
patternNewBtn?.addEventListener('click', addPattern);
patternDupBtn?.addEventListener('click', duplicateActivePattern);
patternRenBtn?.addEventListener('click', () => startRename(project.activePatternId));
patternDelBtn?.addEventListener('click', deleteActivePattern);

/** FX strip: sliders are views on the same params knobs write to. */
function syncFxStrip() {
  try {
    const f = getParam('filter');
    const d = getParam('delayMix');
    const r = getParam('reverbMix');
    if (f && fxFilter) {
      const n = paramToNorm(f.get(), { min: 0, max: 1, curve: 'linear' }, f);
      fxFilter.value = String(Math.round(n * 100));
      if (fxFilterVal) fxFilterVal.textContent = f.format(f.get());
    }
    if (d && fxDelay) {
      fxDelay.value = String(Math.round(clamp01(d.get()) * 100));
      if (fxDelayVal) fxDelayVal.textContent = d.format(d.get());
    }
    if (r && fxVerb) {
      fxVerb.value = String(Math.round(clamp01(r.get()) * 100));
      if (fxVerbVal) fxVerbVal.textContent = r.format(r.get());
    }
  } catch { /* pre-gesture */ }
}
if (fxFilter) fxFilter.addEventListener('input', () => {
  try {
    const f = getParam('filter');
    if (f) f.set(f.fromNorm(clamp01(parseInt(fxFilter.value, 10) / 100)));
  } catch { /* ignore */ }
  syncFxStrip();
  refreshKnobUIFromParams(knobMap, activePattern, paintKnobArc);
  if (knobPopoverKnob) renderKnobPopoverValues();
});
if (fxDelay) fxDelay.addEventListener('input', () => {
  try { getParam('delayMix')?.set(clamp01(parseInt(fxDelay.value, 10) / 100)); } catch { /* ignore */ }
  syncFxStrip();
  refreshKnobUIFromParams(knobMap, activePattern, paintKnobArc);
  if (knobPopoverKnob) renderKnobPopoverValues();
});
if (fxVerb) fxVerb.addEventListener('input', () => {
  try { getParam('reverbMix')?.set(clamp01(parseInt(fxVerb.value, 10) / 100)); } catch { /* ignore */ }
  syncFxStrip();
  refreshKnobUIFromParams(knobMap, activePattern, paintKnobArc);
  if (knobPopoverKnob) renderKnobPopoverValues();
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
  queuedPatternId = null;
  songPlayingPatternId = null;
  renamePatternId = null;
  launchPads = false;
  arrangeSlots = arrangementToSlots(project.arrangement, 1);
  persist();
  syncControlsFromProject();
  renderPatterns();
  renderGrid();
  renderSession();
  renderPads();
});
keysCurveSel.addEventListener('change', () => { keysCurve = keysCurveSel.value; });

// Computer keyboard: A = C at visible base (ported from suite dock map).
// Digits 1–8 queue clips from the pattern bank (no clash with A–\ note keys).
function isTypingTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!target.isContentEditable;
}
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (isTypingTarget(e.target)) return;
  const digit = /^Digit([1-8])$/.exec(e.code);
  if (digit) {
    e.preventDefault();
    const pat = project.patterns[Number(digit[1]) - 1];
    if (pat) queuePattern(pat.id);
    return;
  }
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
renderSession();
renderKeyboard();
renderPads();
// Approach B boot: static params first, then dynamics, then knobs.
registerCoreParams({
  getProject: () => project,
  syncTransportUI: syncControlsFromProject,
  persist,
  getMasterGain: getMasterBus,
  peekMasterGain: () => peekMasterGain() ?? 1,
});
syncParamRegistry();
syncFxStrip();
syncDelayToBpm(project.bpm);
renderKnobs();
renderPadEditors();
syncStickUI();
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

