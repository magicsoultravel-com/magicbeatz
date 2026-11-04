/**
 * magicbeatz console — standalone AKAI MPK mini console (src/app/console.js).
 * Composition root: transport + pads + keys + grid + MIDI wiring.
 */
import { getAudioContext, ensureAudio } from '../audio/context.js';
import {
  clampBpm, clamp01, beatsFromTimeSignature, totalSteps,
  stepsPerBar, createEmptyPattern,
  DEFAULT_VELOCITY,
  createChannel, defaultInstrumentForType,
  resizePatternSteps, serializeChannel,
} from '../sequencer/pattern.js';
import {
  getActivePattern, arrangementToSlots, slotsToArrangement, resampleSlots,
  arrangementBars, resolveArrangementStep, resolveArrangerStep, duplicatePattern,
  MAX_ARRANGE_BARS, normalizeArrangeDiv, normalizeArrangeBars,
  ARRANGER_LANES, normalizeArrangeView,
  arrangerLanesToSlots, arrangerSlotsToLanes,
} from '../sequencer/project.js';
import { createStepTransport } from '../sequencer/transport.js';
import { playChannelHit } from '../audio/banks.js';
import { playPercussionVoice, PERCUSSION_BANK } from '../audio/percussion.js';
import {
  playPitchedInstrument, playPitchedChord, playPitchedStep,
  startPitchedSustain, stopPitchedSustain, releaseStepGates,
  setStickBendCents, setStickVibrato,
} from '../audio/voices.js';
import { chordEntriesFor, chordNameOptions } from '../theory/chords.js';
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
import {
  resolveInstrument, instrumentLabel, drumVoiceLabel, DEFAULT_DRUM_KIT_ID,
} from '../audio/instruments.js';
import { resolveKitOr, defaultKitForBank } from '../audio/catalog.js';
import {
  ensureSample, ensureDrumKit, onSamplerStatus, preloadDefaults, flushPendingLoads,
  sampleStatus, drumSampleId,
} from '../audio/sampler.js';
import { openSoundBrowser, openKitBrowser } from './sound-browser.js';
import { openTrackPopover, refreshTrackPopover, closeTrackPopover } from './track-popover.js';
import {
  ARP_GATE, REPEAT_GATE, buildArpSequence, createPerformClock,
  normalizePerformPrefs, performStatusLabel, rateSeconds,
} from '../keys/perform.js';

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
let keysInstrumentId = DEFAULT_KEYS_INSTRUMENT;

const KEYS_INST_STORAGE = 'magicbeatz-keys-inst-v1';
const KEYS_CURVE_STORAGE = 'magicbeatz-keys-curve-v1';
const KEYS_PERFORM_STORAGE = 'magicbeatz-keys-perform-v1';
let keysPerform = loadKeysPerformPref();
function loadKeysInstrumentPref() {
  try { return localStorage.getItem(KEYS_INST_STORAGE) || ''; } catch { return ''; }
}
function saveKeysInstrumentPref(id) {
  try { if (id) localStorage.setItem(KEYS_INST_STORAGE, id); } catch { /* ignore */ }
}
function loadKeysCurvePref() {
  try { return localStorage.getItem(KEYS_CURVE_STORAGE) || ''; } catch { return ''; }
}
function saveKeysCurvePref(curve) {
  try { if (curve) localStorage.setItem(KEYS_CURVE_STORAGE, curve); } catch { /* ignore */ }
}
function loadKeysPerformPref() {
  try {
    const raw = localStorage.getItem(KEYS_PERFORM_STORAGE);
    return normalizePerformPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizePerformPrefs(null);
  }
}
function saveKeysPerformPref(prefs) {
  try { localStorage.setItem(KEYS_PERFORM_STORAGE, JSON.stringify(prefs)); } catch { /* ignore */ }
}
// Session — clip launcher + arrangement timeline (live looper / song mode).
let queuedPatternId = null; // clip waiting to start at the next bar boundary
let songPlayingPatternIds = new Set(); // patterns sounding under the current song step
let launchPads = false; // pads P1–P8 queue clips instead of auditioning
let playbackUiActive = false; // playhead guard (transport may self-stop at song end)
let renamePatternId = null; // pattern with an open inline rename editor
let trackPopoverId = null; // channel id with an open track editor
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
const projectNote = $('[data-project-note]');
const padsEl = $('[data-pads]');
const gridEl = $('[data-grid]');
const velInput = $('[data-velocity]');
const velVal = $('[data-velocity-val]');
const keyboardEl = $('[data-keyboard]');
const keysInst = $('[data-keys-inst]');
const kitABtn = $('[data-kit-a]');
const kitBBtn = $('[data-kit-b]');
const keysCurveSel = $('[data-keys-curve]');
const keysRepeatBtn = $('[data-keys-repeat]');
const repeatRateSel = $('[data-repeat-rate]');
const keysArpBtn = $('[data-keys-arp]');
const arpModeSel = $('[data-arp-mode]');
const arpRateSel = $('[data-arp-rate]');
const arpOctavesSel = $('[data-arp-octaves]');
const arpLatchInput = $('[data-arp-latch]');
const perfDrawerEl = $('[data-perf-drawer]');
const perfStateEl = $('[data-perf-state]');
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
const arrangeClearBtn = $('[data-arrange-clear]');
const arrangeDivSel = $('[data-arrange-div]');
const arrangeRulerEl = $('[data-arrange-ruler]');
const arrangePosEl = $('[data-arrange-pos]');
const arrangePaintEl = $('[data-arrange-paint]');
const arrangeViewButtons = Array.from(document.querySelectorAll('[data-arrange-view]'));
const gridTitleEl = $('[data-grid-title]');
const gridPanelEl = $('.mbz-grid-panel');
const trackAddBtn = $('[data-track-add]');
const trackAddMenu = $('[data-track-add-menu]');
const patternNewBtn = $('[data-pattern-new]');
const patternDupBtn = $('[data-pattern-dup]');
const patternRenBtn = $('[data-pattern-ren]');
const patternDelBtn = $('[data-pattern-del]');
const heldKeys = new Map();
const heldPc = new Set();

// ---------- note repeat + arpeggiator ----------
const performHolds = new Map(); // holdId -> { pitch, octave, velocity, order }
let performOrder = 0;
let latchedArpNotes = [];
let performIndex = 0;
let arpCache = { key: '', seq: [] };
const performClock = createPerformClock({
  getBpm: () => getBpm(),
  getRateId: () => (keysPerform.arp.enabled ? keysPerform.arp.rate : keysPerform.repeat.rate),
  onStep: (when) => performStep(when),
});

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

// ---------- arrangement slots (resolution-aware) ----------
function arrDiv() { return normalizeArrangeDiv(project.arrangeDiv); }
function slotSteps() { return Math.max(1, Math.round(stepsPerBar(getBeats()) / arrDiv())); }
function patternStepCount(pat) { return totalSteps(pat?.bars || 1, getBeats()); }
function arrangeBarCount() {
  return arrangementBars(project);
}
function arrangeView() { return normalizeArrangeView(project.arrangeView); }
function slotsFromProject() {
  const d = arrDiv();
  return arrangementToSlots(project.arrangement, arrangeBarCount() * d, d);
}
function laneSlotsFromProject(length) {
  const d = arrDiv();
  return arrangerLanesToSlots(project.arranger, length || arrangeBarCount() * d, d);
}
let arrangeSlots = slotsFromProject();
let arrangerLanes = laneSlotsFromProject(arrangeSlots.length);
function reloadArrangeSlots() {
  arrangeSlots = slotsFromProject();
  arrangerLanes = laneSlotsFromProject(arrangeSlots.length);
}

function resizeSlotArray(slots, length) {
  return Array.from({ length }, (_, i) => slots?.[i] || '');
}

function persist() {
  const d = arrDiv();
  const longest = arrangerLanes.reduce(
    (max, lane) => Math.max(max, lane.slots?.length || 0),
    arrangeSlots.length || d,
  );
  const bars = normalizeArrangeBars(Math.ceil((longest || d) / d));
  const targetLen = bars * d;
  arrangeSlots = resizeSlotArray(arrangeSlots, targetLen);
  arrangerLanes = arrangerLanes.map((lane) => ({
    ...lane,
    slots: resizeSlotArray(lane.slots, targetLen),
  }));
  project.arrangeDiv = d;
  project.arrangeBars = bars;
  project.arrangement = slotsToArrangement(arrangeSlots, d);
  project.arranger = arrangerSlotsToLanes(arrangerLanes, d);
  project.arrangeView = arrangeView();
  saveMbzProject(project);
  updateProjectNote();
}
function updateProjectNote() {
  const pat = activePattern();
  const mode = project.playMode === 'song' ? 'song' : 'live';
  const queued = queuedPatternId
    ? ` → ${project.patterns.find((p) => p.id === queuedPatternId)?.name || '?'}`
    : '';
  projectNote.textContent = `project: magicbeatz-v5 bpm ${project.bpm} · ${mode} · ${pat?.name || '?'}${queued}${imported ? ' imported from suite' : ''}`;
}

function getBpm() { return clampBpm(parseInt(bpmInput.value, 10) || 120); }
function getBeats() { return beatsFromTimeSignature(project.timeSignature); }
function getBars() { return Math.min(4, Math.max(1, activePattern()?.bars || 1)); }
function getTotalSteps() {
  if (project.playMode === 'song') {
    // Song mode: the explicit 16-bar canvas is one long loop, including rests.
    return arrangeBarCount() * slotSteps();
  }
  return patternStepCount(activePattern());
}

function schedulePlayhead(when, localStep) {
  const delay = Math.max(0, (when - getAudioContext().currentTime) * 1000 - 8);
  window.setTimeout(() => {
    if (!playbackUiActive) return;
    gridEl.querySelectorAll('.mbz-cell.is-playhead').forEach((c) => c.classList.remove('is-playhead'));
    gridEl.querySelectorAll(`.mbz-cell[data-step="${localStep}"]`).forEach((c) => c.classList.add('is-playhead'));
  }, delay);
}

function updateArrangePosition(text) {
  if (arrangePosEl) arrangePosEl.textContent = text;
}

/** Keep the active slot visible while the playhead travels across 16 bars. */
function ensureArrangeSlotVisible(cell) {
  const scroller = arrangeEl?.closest('.mbz-arrange-scroll');
  if (!scroller || !cell) return;
  const cellRect = cell.getBoundingClientRect();
  const viewRect = scroller.getBoundingClientRect();
  const pad = 24;
  if (cellRect.left < viewRect.left + pad) {
    scroller.scrollLeft -= viewRect.left + pad - cellRect.left;
  } else if (cellRect.right > viewRect.right - pad) {
    scroller.scrollLeft += cellRect.right - viewRect.right + pad;
  }
}

/** Timeline playhead: highlight the sounding slot and advance within it every step. */
function scheduleArrangePlayhead(when, slotIndex, stepInSlot = 0) {
  const delay = Math.max(0, (when - getAudioContext().currentTime) * 1000 - 8);
  window.setTimeout(() => {
    if (!playbackUiActive || project.playMode !== 'song') return;
    arrangeEl?.querySelectorAll('.mbz-slot.is-playhead').forEach((c) => c.classList.remove('is-playhead'));
    const cells = arrangeEl
      ? [...arrangeEl.querySelectorAll(`.mbz-slot[data-slot="${slotIndex}"]`)]
      : [];
    if (!cells.length) {
      arrangeEl?.classList.remove('has-playhead');
      return;
    }
    cells.forEach((cell) => cell.classList.add('is-playhead'));
    const cell = cells[0];
    arrangeEl.classList.add('has-playhead');
    // Move through the slot on each transport step (16ths at 4/bar).
    const steps = slotSteps();
    const fraction = steps > 1 ? Math.min(1, (stepInSlot + 1) / steps) : 1;
    const lane = arrangeView() === 'arranger' ? cell.closest('.mbz-arranger-lane') : null;
    const labelWidth = lane
      ? (parseFloat(getComputedStyle(arrangeEl).getPropertyValue('--lane-label-w')) || 132) + 6
      : 0;
    arrangeEl.style.setProperty(
      '--playhead-x',
      `${labelWidth + cell.offsetLeft + cell.offsetWidth * fraction}px`,
    );
    const d = arrDiv();
    const bar = Math.floor(slotIndex / d) + 1;
    const slot = (slotIndex % d) + 1;
    updateArrangePosition(`bar ${bar} / ${arrangeBarCount()} · slot ${slot} / ${d}`);
    ensureArrangeSlotVisible(cell);
  }, delay);
}

function clearPlayheads() {
  gridEl.querySelectorAll('.mbz-cell.is-playhead').forEach((c) => c.classList.remove('is-playhead'));
  arrangeEl?.querySelectorAll('.mbz-slot.is-playhead').forEach((c) => c.classList.remove('is-playhead'));
  arrangeEl?.classList.remove('has-playhead');
  arrangeEl?.style.removeProperty('--playhead-x');
  updateArrangePosition(`bar — / ${arrangeBarCount()}`);
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

function setSoundingPatterns(ids) {
  const next = new Set(ids);
  const same = next.size === songPlayingPatternIds.size
    && [...next].every((id) => songPlayingPatternIds.has(id));
  if (same) return;
  songPlayingPatternIds = next;
  renderSession();
}

/** Song mode: the arrangement timeline owns the loop; clips pick the voices. */
function onSongStep(stepIndex, total, when) {
  const totalSlots = arrangeBarCount() * arrDiv();
  const stepSize = slotSteps();
  const fallbackSlot = Math.floor(stepIndex / stepSize);
  const fallbackStepInSlot = stepIndex % stepSize;

  if (arrangeView() === 'arranger') {
    const resolvedLanes = resolveArrangerStep(project, stepIndex, totalSlots);
    scheduleArrangePlayhead(when, fallbackSlot, fallbackStepInSlot);

    // Every active layer plays its entire Grid; layers mix and nothing is
    // deduplicated. Mute/solo stay scoped inside each Grid.
    const sounding = [];
    let activeLane = null;
    for (const resolved of resolvedLanes) {
      if (!resolved) continue;
      if (!activeLane && resolved.pattern.id === project.activePatternId) activeLane = resolved;
      sounding.push(resolved.pattern.id);
      playPatternChannels(resolved.pattern, resolved.localStep, when);
    }
    setSoundingPatterns(sounding);
    if (activeLane) schedulePlayhead(when, activeLane.localStep);
    else scheduleGridClear(when);
  } else {
    const resolved = resolveArrangementStep(project, stepIndex, totalSlots);
    const slotIndex = resolved ? resolved.slotIndex : fallbackSlot;
    const stepInSlot = resolved ? resolved.stepInSlot : fallbackStepInSlot;
    scheduleArrangePlayhead(when, slotIndex, stepInSlot);
    if (resolved) {
      setSoundingPatterns([resolved.pattern.id]);
      if (resolved.pattern.id === project.activePatternId) {
        schedulePlayhead(when, resolved.localStep);
      } else {
        scheduleGridClear(when);
      }
      playPatternChannels(resolved.pattern, resolved.localStep, when);
    } else {
      // Empty bar = rest: keep the timeline moving, grid goes dark.
      setSoundingPatterns([]);
      scheduleGridClear(when);
    }
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
  if (entry.target === 'drum') return drumVoiceLabel(entry.voiceId || 'kick');
  if (entry.target === 'note') return `${entry.pitch || 'C'}${entry.octave ?? 4} · ${instrumentLabel(entry.instrumentId)}`;
  return `${entry.chordName || 'C'} · ${instrumentLabel(entry.instrumentId)}`;
}

/** Paint the two bank-kit buttons and their live sample status. */
function renderPadKits() {
  for (const [bankId, btn] of [['A', kitABtn], ['B', kitBBtn]]) {
    if (!btn) continue;
    const kit = resolveKitOr(padMap.kits?.[bankId] || defaultKitForBank(bankId));
    const state = sampleStatus(drumSampleId(kit.id)).state;
    btn.innerHTML = `<span>${bankId} · ${esc(kit.label)}</span><i class="mbz-sound-dot" data-state="${esc(state)}"></i>`;
    btn.title = `Bank ${bankId} kit: ${kit.label} (${kit.machine}) — click to change`;
  }
}

function applyBankKit(bankId, kitId) {
  const previous = padMap.kits?.[bankId];
  padMap.kits = { ...(padMap.kits || {}), [bankId]: kitId };
  // Move tracks that were using the bank's previous kit; custom track kits stay.
  for (const ch of activePattern()?.channels || []) {
    if (ch.type === 'percussion' && (!ch.kitId || ch.kitId === previous)) ch.kitId = kitId;
  }
  savePadMap(padMap);
  persist();
  renderPadKits();
  renderPads();
  renderPadEditors();
  renderGrid();
}

function chooseBankKit(bankId) {
  const current = padMap.kits?.[bankId] || defaultKitForBank(bankId);
  openKitBrowser({
    selectedId: current,
    title: `bank ${bankId} drum kit`,
    onSelect(kitId) {
      applyBankKit(bankId, kitId);
    },
  });
}

kitABtn?.addEventListener('click', () => chooseBankKit('A'));
kitBBtn?.addEventListener('click', () => chooseBankKit('B'));

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
    const kitId = padMap.kits?.[bankId] || defaultKitForBank(bankId);
    playPercussionVoice(kitId, entry.voiceId || 'kick', undefined, vel);
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
  if (heldKeys.has(holdId) || performHolds.has(holdId)) return;
  ensureAudio();
  flushPendingLoads();
  const inst = keysInstrumentId;
  const vel = applyCurve(velocity ?? 0.85, keysCurve);
  const btn = keyboardEl.querySelector(`.mbz-key[data-pitch="${pitch}"][data-octave="${octave}"]`);
  btn?.classList.add('is-down');
  if (keysPerform.repeat.enabled || keysPerform.arp.enabled) {
    // Latch accumulates the chord as it is pressed; the first press after all
    // keys were released starts a new chord.
    if (keysPerform.arp.enabled && keysPerform.arp.latch) {
      if (performHolds.size === 0) latchedArpNotes = [];
      if (!latchedArpNotes.some((n) => n.pitch === pitch && n.octave === octave)) {
        latchedArpNotes.push({ pitch, octave, velocity: vel });
      }
    }
    performHolds.set(holdId, { pitch, octave, velocity: vel, order: performOrder });
    performOrder += 1;
    refreshPerformClock();
    return;
  }
  if (capturing) recordBuffer.push({ kind: 'key', pitch, octave, instrumentId: inst, t: getAudioContext().currentTime, velocity: vel });
  const sustain = startPitchedSustain(inst, pitch, octave, vel);
  heldKeys.set(holdId, sustain || null);
  if (!sustain) {
    // Still loading (or a one-shot): track briefly so pointerup can clear the
    // highlight, then drop so rapid re-taps are never blocked.
    window.setTimeout(() => {
      if (heldKeys.get(holdId) === null) {
        heldKeys.delete(holdId);
        btn?.classList.remove('is-down');
      }
    }, 160);
  }
}

// ---------- note repeat + arpeggiator helpers ----------
function performHeldNotes() {
  return [...performHolds.values()].sort((a, b) => a.order - b.order);
}

/** Arp chord: physically held keys win, latch keeps the last chord alive. */
function activeArpNotes() {
  const held = performHeldNotes();
  return held.length ? held : latchedArpNotes;
}

function arpSequence(notes) {
  const key = [
    keysPerform.arp.mode,
    keysPerform.arp.octaves,
    notes.map((n) => `${n.pitch}${n.octave}`).join(','),
  ].join('|');
  if (arpCache.key !== key) {
    arpCache = {
      key,
      seq: buildArpSequence(notes, { mode: keysPerform.arp.mode, octaves: keysPerform.arp.octaves }),
    };
    performIndex = 0;
  }
  return arpCache.seq;
}

function flashPerformKey(note, gateSec) {
  const btn = keyboardEl.querySelector(`.mbz-key[data-pitch="${note.pitch}"][data-octave="${note.octave}"]`);
  if (!btn) return;
  btn.classList.add('is-arp');
  window.setTimeout(() => btn.classList.remove('is-arp'), Math.max(70, Math.round(gateSec * 1000)));
}

function firePerformNote(note, when, gateSec) {
  const velocity = note.velocity ?? 0.85;
  if (capturing) {
    recordBuffer.push({
      kind: 'key', pitch: note.pitch, octave: note.octave,
      instrumentId: keysInstrumentId, t: when, velocity,
    });
  }
  playPitchedStep(keysInstrumentId, note.pitch, note.octave, when, velocity, gateSec);
  flashPerformKey(note, gateSec);
}

function performStep(when) {
  if (!audition) return;
  const arpOn = keysPerform.arp.enabled;
  if (!arpOn && !keysPerform.repeat.enabled) {
    stopPerform({ clearLatch: false });
    return;
  }
  const notes = arpOn ? activeArpNotes() : performHeldNotes();
  if (!notes.length) {
    stopPerform({ clearLatch: false });
    return;
  }
  const stepSec = rateSeconds(arpOn ? keysPerform.arp.rate : keysPerform.repeat.rate, getBpm());
  if (arpOn) {
    const seq = arpSequence(notes);
    if (!seq.length) return;
    const note = seq[performIndex % seq.length];
    performIndex = (performIndex + 1) % seq.length;
    firePerformNote(note, when, stepSec * ARP_GATE);
    return;
  }
  const gateSec = stepSec * REPEAT_GATE;
  for (const note of notes) firePerformNote(note, when, gateSec);
}
function stopPerform({ clearLatch = true } = {}) {
  performClock.stop();
  performIndex = 0;
  arpCache = { key: '', seq: [] };
  if (clearLatch) latchedArpNotes = [];
}

function refreshPerformClock() {
  if (!audition || (!keysPerform.repeat.enabled && !keysPerform.arp.enabled)) {
    stopPerform({ clearLatch: false });
    return;
  }
  const notes = keysPerform.arp.enabled ? activeArpNotes() : performHeldNotes();
  if (!notes.length) {
    stopPerform({ clearLatch: false });
    return;
  }
  if (!performClock.isRunning()) performClock.start();
}

/** Turning both toggles off keeps held keys sounding as normal sustains. */
function flushPerformHoldsToSustain() {
  if (!performHolds.size) return;
  const holds = [...performHolds];
  performHolds.clear();
  // A pending step gate must not release the held note we are about to start.
  releaseStepGates();
  if (!audition) return;
  ensureAudio();
  for (const [holdId, note] of holds) {
    const sustain = startPitchedSustain(keysInstrumentId, note.pitch, note.octave, note.velocity);
    heldKeys.set(holdId, sustain || null);
  }
}

/**
 * Reflect prefs in the drawer. `revealActive` opens the drawer at boot so a
 * restored repeat/arp setting is visible instead of hidden behind a summary.
 */
function syncPerformControls({ revealActive = false } = {}) {
  const active = keysPerform.repeat.enabled || keysPerform.arp.enabled;
  if (keysRepeatBtn) {
    keysRepeatBtn.classList.toggle('is-on', keysPerform.repeat.enabled);
    keysRepeatBtn.setAttribute('aria-pressed', String(keysPerform.repeat.enabled));
  }
  if (keysArpBtn) {
    keysArpBtn.classList.toggle('is-on', keysPerform.arp.enabled);
    keysArpBtn.setAttribute('aria-pressed', String(keysPerform.arp.enabled));
  }
  if (repeatRateSel) repeatRateSel.value = keysPerform.repeat.rate;
  if (arpModeSel) arpModeSel.value = keysPerform.arp.mode;
  if (arpRateSel) arpRateSel.value = keysPerform.arp.rate;
  if (arpOctavesSel) arpOctavesSel.value = String(keysPerform.arp.octaves);
  if (arpLatchInput) arpLatchInput.checked = keysPerform.arp.latch;
  if (perfStateEl) perfStateEl.textContent = performStatusLabel(keysPerform);
  if (perfDrawerEl) {
    perfDrawerEl.classList.toggle('is-active', active);
    if (revealActive && active) perfDrawerEl.open = true;
  }
}

/** Repeat and arp are mutually exclusive: enabling one disables the other. */
function setPerformMode({ repeat, arp }) {
  if (repeat != null) {
    keysPerform.repeat.enabled = !!repeat;
    if (repeat) keysPerform.arp.enabled = false;
  }
  if (arp != null) {
    keysPerform.arp.enabled = !!arp;
    if (arp) keysPerform.repeat.enabled = false;
  }
  saveKeysPerformPref(keysPerform);
  syncPerformControls();
  if (!keysPerform.arp.enabled) latchedArpNotes = [];
  performIndex = 0;
  arpCache = { key: '', seq: [] };
  if (!keysPerform.repeat.enabled && !keysPerform.arp.enabled) {
    flushPerformHoldsToSustain();
    stopPerform({ clearLatch: false });
    return;
  }
  refreshPerformClock();
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
  if (performHolds.has(holdId)) {
    // Latch already holds the full chord, so the run keeps going on its own.
    performHolds.delete(holdId);
    clearKeyHighlight(holdId);
    refreshPerformClock();
    return;
  }
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
  // Re-apply held performance keys after a re-render (octave shift while holding).
  for (const note of performHolds.values()) {
    keyboardEl
      .querySelector(`.mbz-key[data-pitch="${note.pitch}"][data-octave="${note.octave}"]`)
      ?.classList.add('is-down');
  }
}

function findChannel(id) {
  return activePattern()?.channels.find((c) => c.id === id) || null;
}

function trackName(ch) {
  return ch.name || ch.voiceId || ch.instrumentId || ch.type || 'track';
}

/** Keep a row's name / mute / solo controls in sync without rerendering. */
function syncTrackRow(ch) {
  if (!ch) return;
  const row = gridEl.querySelector(`.mbz-ch-row[data-channel-id="${CSS.escape(ch.id)}"]`);
  if (!row) return;
  const name = row.querySelector('.mbz-ch-name');
  if (name) {
    name.textContent = trackName(ch);
    name.title = `${trackName(ch)} · click to edit this track`;
    name.classList.toggle('is-open', trackPopoverId === ch.id);
    name.setAttribute('aria-expanded', String(trackPopoverId === ch.id));
  }
  const mute = row.querySelector('[data-flag="mute"]');
  if (mute) {
    mute.classList.toggle('is-on', !!ch.mute);
    mute.setAttribute('aria-pressed', String(!!ch.mute));
    mute.title = ch.mute ? 'muted — click to unmute' : 'mute this track';
  }
  const solo = row.querySelector('[data-flag="solo"]');
  if (solo) {
    solo.classList.toggle('is-on', !!ch.solo);
    solo.setAttribute('aria-pressed', String(!!ch.solo));
    solo.title = ch.solo ? 'soloed — click to unsolo' : 'solo this track';
  }
}

function renderGrid() {
  const pat = activePattern();
  closeTrackPopover({ notify: false });
  gridEl.innerHTML = '';
  if (!pat) return;
  const n = patternStepCount(pat);
  gridEl.style.setProperty('--steps', String(n));
  if (gridTitleEl) {
    gridTitleEl.textContent = `${pat.name} · ${pat.bars}b · ${pat.channels.length} track${pat.channels.length === 1 ? '' : 's'}`;
  }
  let popoverAnchor = null;
  let popoverIndex = -1;
  pat.channels.forEach((ch, chIndex) => {
    if (ch.steps.length !== n) {
      ch.steps = Array.from({ length: n }, (_, k) => ch.steps[k] || null);
    }
    const row = document.createElement('div');
    row.className = 'mbz-ch-row';
    row.dataset.channelId = ch.id;
    row.style.setProperty('--steps', String(n));

    const head = document.createElement('div');
    head.className = 'mbz-ch-head';

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'mbz-ch-name';
    name.textContent = trackName(ch);
    name.title = `${trackName(ch)} · click to edit this track`;
    name.classList.toggle('is-open', trackPopoverId === ch.id);
    name.setAttribute('aria-haspopup', 'dialog');
    name.setAttribute('aria-controls', `mbz-track-pop-${ch.id}`);
    name.setAttribute('aria-expanded', String(trackPopoverId === ch.id));
    name.addEventListener('click', () => {
      trackPopoverId = trackPopoverId === ch.id ? null : ch.id;
      renderGrid();
    });
    head.appendChild(name);

    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = `mbz-ch-flag${ch.mute ? ' is-on' : ''}`;
    mute.dataset.flag = 'mute';
    mute.textContent = 'M';
    mute.title = ch.mute ? 'muted — click to unmute' : 'mute this track';
    mute.setAttribute('aria-pressed', String(!!ch.mute));
    mute.addEventListener('click', (e) => {
      e.stopPropagation();
      ch.mute = !ch.mute;
      mute.classList.toggle('is-on', !!ch.mute);
      mute.setAttribute('aria-pressed', String(!!ch.mute));
      mute.title = ch.mute ? 'muted — click to unmute' : 'mute this track';
      persist();
      if (trackPopoverId === ch.id) refreshTrackPopover();
    });
    head.appendChild(mute);

    const solo = document.createElement('button');
    solo.type = 'button';
    solo.className = `mbz-ch-flag is-solo${ch.solo ? ' is-on' : ''}`;
    solo.dataset.flag = 'solo';
    solo.textContent = 'S';
    solo.title = ch.solo ? 'soloed — click to unsolo' : 'solo this track';
    solo.setAttribute('aria-pressed', String(!!ch.solo));
    solo.addEventListener('click', (e) => {
      e.stopPropagation();
      ch.solo = !ch.solo;
      solo.classList.toggle('is-on', !!ch.solo);
      solo.setAttribute('aria-pressed', String(!!ch.solo));
      solo.title = ch.solo ? 'soloed — click to unsolo' : 'solo this track';
      persist();
      if (trackPopoverId === ch.id) refreshTrackPopover();
    });
    head.appendChild(solo);

    if (trackPopoverId === ch.id) {
      popoverAnchor = name;
      popoverIndex = chIndex;
    }

    row.appendChild(head);
    for (let i = 0; i < n; i += 1) {
      const step = ch.steps[i];
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `mbz-cell${step ? ' is-on' : ''}${selectedCell?.channelId === ch.id && selectedCell?.stepIndex === i ? ' is-playhead' : ''}`;
      cell.dataset.step = String(i);
      cell.title = `${trackName(ch)} step ${i + 1}`;
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
    }
    gridEl.appendChild(row);
  });
  if (popoverAnchor && popoverIndex >= 0) {
    openTrackEditor(pat.channels[popoverIndex], popoverIndex, popoverAnchor, pat.channels.length);
  } else if (trackPopoverId) {
    trackPopoverId = null;
  }
}

/** Open the full anchored track inspector for one channel row. */
function openTrackEditor(ch, index, anchor, total) {
  const pat = activePattern();
  if (!pat || !ch || !anchor) return;
  openTrackPopover({
    channel: ch,
    index,
    total: total ?? pat.channels.length,
    patternName: pat.name,
    anchor,
    host: gridPanelEl || document.body,
    chordNames: chordNameOptions(theory.chordsJson, theory.chordsTheory),
    scaleKeys: Object.keys(theory.scalesJson || {}),
    onChange: handleTrackChange,
    onBrowseSound: browseTrackSound,
    onBrowseKit: browseTrackKit,
    onAudition: auditionTrack,
    onMove: (delta) => moveTrack(ch.id, delta),
    onDuplicate: () => duplicateTrack(ch.id),
    onClearSteps: () => clearTrackSteps(ch.id),
    onDelete: () => deleteTrack(ch.id),
    onClose: () => {
      if (trackPopoverId !== ch.id) return;
      trackPopoverId = null;
      syncTrackRow(ch);
    },
  });
}

/** Persist inspector edits and keep the matching row in sync. */
function handleTrackChange(ch, opts = {}) {
  persist();
  syncTrackRow(ch);
  if (opts.gain) refreshKnobUIFromParams(knobMap, activePattern, paintKnobArc);
  if (opts.name || opts.type) {
    syncParamRegistry();
    renderKnobs();
  }
}

/** Focus a control in the (possibly rebuilt) inspector after a sound pick. */
function focusTrackPopoverControl(selector) {
  const el = document.querySelector(`.mbz-track-pop ${selector}`);
  if (!el) return false;
  el.focus({ preventScroll: true });
  return document.activeElement === el;
}

function browseTrackSound({ channel: ch, target }) {
  if (!ch) return;
  if (target === 'drum') {
    openSoundBrowser({
      target: 'drum',
      kitId: ch.kitId || DEFAULT_DRUM_KIT_ID,
      selectedId: ch.voiceId || 'kick',
      title: 'track drum voice',
      onSelect(id) {
        ch.voiceId = id;
        persist();
        syncTrackRow(ch);
        if (!ch.name) {
          syncParamRegistry();
          renderKnobs();
        }
        refreshTrackPopover({ focusSelector: '[data-tp="voice-open"]' });
      },
      returnFocus: () => focusTrackPopoverControl('[data-tp="voice-open"]'),
    });
    return;
  }
  openSoundBrowser({
    target,
    selectedId: ch.instrumentId,
    title: target === 'chord' ? 'track chord instrument' : 'track instrument',
    onSelect(id) {
      ch.instrumentId = resolveInstrument(id).id;
      persist();
      syncTrackRow(ch);
      refreshTrackPopover({ focusSelector: '[data-tp="inst-open"]' });
    },
    returnFocus: () => focusTrackPopoverControl('[data-tp="inst-open"]'),
  });
}

function browseTrackKit(ch) {
  if (!ch) return;
  openKitBrowser({
    selectedId: ch.kitId || DEFAULT_DRUM_KIT_ID,
    title: 'track drum kit',
    onSelect(kitId) {
      ch.kitId = kitId;
      persist();
      syncTrackRow(ch);
      refreshTrackPopover({ focusSelector: '[data-tp="kit-open"]' });
    },
    returnFocus: () => focusTrackPopoverControl('[data-tp="kit-open"]'),
  });
}

/** Preview the exact sound this track will play. */
function auditionTrack(ch) {
  if (!ch) return;
  ensureAudio();
  flushPendingLoads();
  const when = () => getAudioContext().currentTime + 0.03;
  if (ch.type === 'percussion') {
    const kitId = ch.kitId || DEFAULT_DRUM_KIT_ID;
    ensureDrumKit(kitId)
      .then((inst) => {
        if (inst) playPercussionVoice(kitId, ch.voiceId || 'kick', when(), 0.9);
      })
      .catch(() => {});
    return;
  }
  const instrument = resolveInstrument(ch.instrumentId);
  const instrumentId = instrument.id;
  const play = () => {
    if (ch.type === 'chord') {
      const entries = chordEntriesFor(ch, chordCtx());
      if (entries.length) playPitchedChord(instrumentId, entries, when(), 0.85);
      else playPitchedInstrument(instrumentId, ch.pitch || 'C', ch.octave ?? 4, when(), 0.85);
    } else {
      playPitchedInstrument(instrumentId, ch.pitch || 'C', ch.octave ?? 4, when(), 0.85);
    }
  };
  if (instrument.engine !== 'sample') {
    play();
    return;
  }
  ensureSample(instrumentId)
    .then((inst) => {
      if (inst) play();
    })
    .catch(() => {});
}

function clearTrackSteps(channelId) {
  const ch = findChannel(channelId);
  if (!ch) return;
  ch.steps = ch.steps.map(() => null);
  if (selectedCell?.channelId === channelId) selectedCell = null;
  persist();
  renderGrid();
  updateVelocityUi();
}

/** Append a track to the active clip and open its editor. */
function addTrack(kind = 'note') {
  const pat = activePattern();
  if (!pat) return;
  const type = kind === 'percussion' || kind === 'chord' ? kind : 'note';
  const ch = createChannel({
    type,
    name: uniqueTrackName(pat, type),
    instrumentId: type === 'percussion' ? '' : defaultInstrumentForType(type),
    voiceId: type === 'percussion' ? PERCUSSION_BANK?.voices?.[0]?.id || 'kick' : '',
    kitId: type === 'percussion' ? (padMap.kits?.[bank] || defaultKitForBank(bank)) : '',
    chordName: type === 'chord' ? 'C' : '',
    steps: Array.from({ length: patternStepCount(pat) }, () => null),
  });
  pat.channels.push(ch);
  selectedCell = null;
  trackPopoverId = ch.id;
  refreshPatternViews();
}

function uniqueTrackName(pat, type) {
  const base = type === 'percussion' ? 'drum' : type === 'chord' ? 'chords' : 'instrument';
  const taken = new Set(pat.channels.map((c) => c.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

function moveTrack(channelId, delta) {
  const pat = activePattern();
  if (!pat) return;
  const idx = pat.channels.findIndex((c) => c.id === channelId);
  const next = idx + delta;
  if (idx < 0 || next < 0 || next >= pat.channels.length) return;
  const [ch] = pat.channels.splice(idx, 1);
  pat.channels.splice(next, 0, ch);
  persist();
  syncParamRegistry();
  renderKnobs();
  renderGrid();
}

function duplicateTrack(channelId) {
  const pat = activePattern();
  if (!pat) return;
  const idx = pat.channels.findIndex((c) => c.id === channelId);
  if (idx < 0) return;
  const src = pat.channels[idx];
  const copy = createChannel({
    ...serializeChannel(src),
    id: undefined,
    name: `${trackName(src)} copy`.slice(0, 24),
  });
  pat.channels.splice(idx + 1, 0, copy);
  trackPopoverId = copy.id;
  refreshPatternViews();
}

function deleteTrack(channelId) {
  const pat = activePattern();
  if (!pat || pat.channels.length <= 1) return;
  const idx = pat.channels.findIndex((c) => c.id === channelId);
  if (idx < 0) return;
  pat.channels.splice(idx, 1);
  if (selectedCell?.channelId === channelId) selectedCell = null;
  trackPopoverId = null;
  refreshPatternViews();
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

// ---------- session: clip launcher + arrangement timeline ----------

/** Whether a clip is sounding in the current transport context. */
function patternIsSounding(patternId) {
  if (project.playMode === 'song' && playbackUiActive) {
    return songPlayingPatternIds.has(patternId);
  }
  return project.activePatternId === patternId;
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
  if (arrangeDivSel) arrangeDivSel.value = String(arrDiv());
  const view = arrangeView();
  arrangeViewButtons.forEach((btn) => {
    const active = btn.dataset.arrangeView === view;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

/** Unified pattern switch (dropdown, clips, keys, pads). */
function setActivePattern(patternId, opts = {}) {
  if (!project.patterns.some((p) => p.id === patternId)) return;
  if (!opts.keepQueue) queuedPatternId = null;
  if (project.activePatternId !== patternId) {
    project.activePatternId = patternId;
    selectedCell = null;
    trackPopoverId = null;
  }
  arrangeSlots = slotsFromProject();
  persist();
  syncControlsFromProject();
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
  renderClips();
}

function renderClips() {
  if (!clipsEl) return;
  clipsEl.innerHTML = '';
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
    if (patternIsSounding(p.id)) btn.classList.add('is-playing');
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
    const badge = p.id === queuedPatternId
      ? '⏳'
      : (playbackUiActive && transport.isRunning() && patternIsSounding(p.id) ? '▶' : '');
    if (badge) {
      const badgeEl = document.createElement('span');
      badgeEl.className = 'mbz-clip-badge';
      badgeEl.textContent = badge;
      btn.appendChild(badgeEl);
    }
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

function slotCellClasses(index, id) {
  return [
    'mbz-slot',
    index % arrDiv() === 0 ? 'is-bar' : '',
    id ? 'is-filled' : '',
    id && id === project.activePatternId ? 'is-edit' : '',
  ].filter(Boolean).join(' ');
}

/** Paint one slot cell from arrangeSlots (no re-render during drags). */
function paintSlotCell(cell, index) {
  const d = arrDiv();
  const id = arrangeSlots[index] || '';
  const p = id ? project.patterns.find((x) => x.id === id) : null;
  const bar = Math.floor(index / d) + 1;
  const sub = (index % d) + 1;
  cell.className = slotCellClasses(index, id);
  cell.dataset.slot = String(index);
  if (p) {
    const isTarget = id === project.activePatternId;
    const activeName = activePattern()?.name || '?';
    cell.style.setProperty('--clip', clipColor(project.patterns.indexOf(p)));
    cell.textContent = shortPatternLabel(p.name);
    cell.title = isTarget
      ? `bar ${bar}.${sub} · ${p.name} · click = rest`
      : `bar ${bar}.${sub} · ${p.name} · click = paint ${activeName}`;
    cell.setAttribute(
      'aria-label',
      isTarget
        ? `bar ${bar} slot ${sub}, ${p.name}, click to clear`
        : `bar ${bar} slot ${sub}, ${p.name}, click to replace with ${activeName}`,
    );
  } else {
    const activeName = activePattern()?.name || '?';
    cell.style.removeProperty('--clip');
    cell.textContent = '';
    cell.title = `bar ${bar}.${sub} · rest · click = paint ${activeName}`;
    cell.setAttribute('aria-label', `bar ${bar} slot ${sub}, rest, click to paint ${activeName}`);
  }
}

/** Generic layer label: layers are whole-Grid slots, never tracks. */
function layerLabelText(laneIndex) {
  return `Layer ${laneIndex + 1}`;
}

/** Paint one Arranger layer cell without re-rendering the whole matrix. */
function paintLaneSlotCell(cell, laneIndex, index) {
  const d = arrDiv();
  const lane = arrangerLanes[laneIndex];
  const id = lane?.slots[index] || '';
  const p = id ? project.patterns.find((x) => x.id === id) : null;
  const bar = Math.floor(index / d) + 1;
  const sub = (index % d) + 1;
  const layerName = layerLabelText(laneIndex);
  cell.className = slotCellClasses(index, id);
  cell.dataset.slot = String(index);
  cell.dataset.lane = String(laneIndex);
  if (p) {
    const isTarget = id === project.activePatternId;
    const activeName = activePattern()?.name || '?';
    cell.style.setProperty('--clip', clipColor(project.patterns.indexOf(p)));
    cell.textContent = shortPatternLabel(p.name);
    cell.title = isTarget
      ? `${layerName} · bar ${bar}.${sub} · ${p.name} · click = rest`
      : `${layerName} · bar ${bar}.${sub} · ${p.name} · click = paint ${activeName}`;
    cell.setAttribute(
      'aria-label',
      isTarget
        ? `${layerName}, bar ${bar} slot ${sub}, ${p.name}, click to clear`
        : `${layerName}, bar ${bar} slot ${sub}, ${p.name}, click to replace with ${activeName}`,
    );
  } else {
    const activeName = activePattern()?.name || '?';
    cell.style.removeProperty('--clip');
    cell.textContent = '';
    cell.title = `${layerName} · bar ${bar}.${sub} · rest · click = paint ${activeName}`;
    cell.setAttribute(
      'aria-label',
      `${layerName}, bar ${bar} slot ${sub}, rest, click to paint ${activeName}`,
    );
  }
}
function renderArrangeRuler(len) {
  if (!arrangeRulerEl) return;
  const d = arrDiv();
  arrangeRulerEl.style.setProperty('--slots', String(len));
  arrangeRulerEl.innerHTML = '';
  for (let bar = 0; bar * d < len; bar += 1) {
    const label = document.createElement('span');
    label.textContent = String(bar + 1);
    label.style.gridColumn = `span ${d}`;
    arrangeRulerEl.appendChild(label);
  }
}

/** Eight-row Arranger matrix. Each row is an independent whole-Grid layer. */
function renderArrangerLanes(len) {
  for (let laneIndex = 0; laneIndex < ARRANGER_LANES; laneIndex += 1) {
    const row = document.createElement('div');
    row.className = 'mbz-arranger-lane';
    row.dataset.lane = String(laneIndex);

    const label = document.createElement('div');
    label.className = 'mbz-lane-label';
    const name = document.createElement('span');
    name.className = 'mbz-lane-name';
    name.textContent = layerLabelText(laneIndex);
    label.appendChild(name);
    label.title = `${layerLabelText(laneIndex)} · plays whole Grids`;
    row.appendChild(label);

    const slotsEl = document.createElement('div');
    slotsEl.className = 'mbz-lane-slots';
    slotsEl.style.setProperty('--slots', String(len));
    slotsEl.setAttribute('role', 'grid');
    slotsEl.setAttribute('aria-label', layerLabelText(laneIndex));
    for (let i = 0; i < len; i += 1) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'mbz-slot';
      cell.dataset.slot = String(i);
      cell.dataset.lane = String(laneIndex);
      paintLaneSlotCell(cell, laneIndex, i);
      cell.addEventListener('click', (e) => {
        if (e.detail !== 0) return;
        paintLaneSlot(laneIndex, i, { toggle: true });
      });
      cell.addEventListener('pointerdown', (e) => startArrangePaint(e, i, laneIndex));
      cell.addEventListener('pointerenter', () => extendArrangePaint(i, laneIndex));
      slotsEl.appendChild(cell);
    }
    row.appendChild(slotsEl);
    arrangeEl.appendChild(row);
  }
}

function renderArrange() {
  if (!arrangeEl) return;
  const d = arrDiv();
  const laneLength = arrangerLanes.reduce((max, lane) => Math.max(max, lane.slots?.length || 0), 0);
  const len = Math.max(
    d,
    Math.min(MAX_ARRANGE_BARS * d, Math.max(arrangeSlots.length || 0, laneLength) || arrangeBarCount() * d),
  );
  const view = arrangeView();
  arrangeEl.style.setProperty('--slots', String(len));
  arrangeEl.classList.toggle('is-arranger', view === 'arranger');
  arrangeEl.closest('.mbz-arrange-scroll')?.classList.toggle('is-arranger', view === 'arranger');
  arrangeEl.innerHTML = '';

  if (view === 'arranger') {
    renderArrangerLanes(len);
  } else {
    for (let i = 0; i < len; i += 1) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'mbz-slot';
      cell.dataset.slot = String(i);
      paintSlotCell(cell, i);
      // Pointer presses paint on pointerdown (drag support); clicks only matter
      // for keyboard activation (Enter/Space report detail 0).
      cell.addEventListener('click', (e) => {
        if (e.detail !== 0) return;
        paintSlot(i, { toggle: true });
      });
      cell.addEventListener('pointerdown', (e) => startArrangePaint(e, i));
      cell.addEventListener('pointerenter', () => extendArrangePaint(i));
      arrangeEl.appendChild(cell);
    }
  }

  renderArrangeRuler(len);
  const bars = Math.max(1, Math.round(len / d));
  if (arrangeLenEl) arrangeLenEl.textContent = `${bars} bar${bars === 1 ? '' : 's'} · ${len} slot${len === 1 ? '' : 's'}`;
  if (arrangePaintEl) {
    arrangePaintEl.textContent = view === 'arranger'
      ? `paint: ${activePattern()?.name || '?'} into any layer`
      : `paint: ${activePattern()?.name || '?'}`;
  }
  if (arrangePosEl && !arrangeEl.classList.contains('has-playhead')) {
    updateArrangePosition(`bar — / ${bars}`);
  }
  if (arrangeAddBtn) arrangeAddBtn.disabled = len >= MAX_ARRANGE_BARS * d;
  if (arrangeDelBtn) arrangeDelBtn.disabled = len <= d;
  const hasClips = view === 'arranger'
    ? arrangerLanes.some((lane) => lane.slots.some(Boolean))
    : arrangeSlots.some(Boolean);
  if (arrangeClearBtn) arrangeClearBtn.disabled = !hasClips;
  if (arrangeDivSel) arrangeDivSel.value = String(d);
}

function paintSlotValue(index, value) {
  if (index < 0 || index >= arrangeSlots.length) return;
  if ((arrangeSlots[index] || '') === value) return;
  arrangeSlots[index] = value;
  const cell = arrangeEl?.querySelector(`.mbz-slot[data-slot="${index}"]:not([data-lane])`);
  if (cell) paintSlotCell(cell, index);
}

function paintLaneSlotValue(laneIndex, index, value) {
  const lane = arrangerLanes[laneIndex];
  if (!lane || index < 0 || index >= lane.slots.length) return;
  if ((lane.slots[index] || '') === value) return;
  lane.slots[index] = value;
  const cell = arrangeEl?.querySelector(`.mbz-slot[data-lane="${laneIndex}"][data-slot="${index}"]`);
  if (cell) paintLaneSlotCell(cell, laneIndex, index);
}

function paintSlot(index, { toggle = false } = {}) {
  if (index < 0 || index >= arrangeSlots.length) return;
  const target = project.activePatternId;
  const current = arrangeSlots[index] || '';
  paintSlotValue(index, toggle && current === target ? '' : target);
  persist();
  renderArrange();
}

function paintLaneSlot(laneIndex, index, { toggle = false } = {}) {
  const lane = arrangerLanes[laneIndex];
  if (!lane || index < 0 || index >= lane.slots.length) return;
  const target = project.activePatternId;
  const current = lane.slots[index] || '';
  paintLaneSlotValue(laneIndex, index, toggle && current === target ? '' : target);
  persist();
  renderArrange();
}

let arrangePaint = null; // { value, laneIndex, visited:Set } while dragging across slots

function startArrangePaint(e, index, laneIndex = null) {
  if (e.button !== 0) return;
  const lane = laneIndex == null ? null : arrangerLanes[laneIndex];
  const slots = lane ? lane.slots : arrangeSlots;
  if (index < 0 || index >= slots.length) return;
  e.preventDefault();
  const target = project.activePatternId;
  const value = (slots[index] || '') === target ? '' : target;
  const key = `${laneIndex ?? 'looper'}:${index}`;
  arrangePaint = { value, laneIndex, visited: new Set([key]) };
  if (lane) paintLaneSlotValue(laneIndex, index, value);
  else paintSlotValue(index, value);
  arrangeEl?.classList.add('is-painting');

  const scroller = arrangeEl?.closest('.mbz-arrange-scroll');
  // Dragging against an edge scrolls the timeline while continuing the paint.
  const trackPaint = (ev) => {
    if (!arrangePaint) return;
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      const pad = 24;
      if (ev.clientX < rect.left + pad) scroller.scrollLeft -= 18;
      else if (ev.clientX > rect.right - pad) scroller.scrollLeft += 18;
    }
    const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.mbz-slot');
    if (hit && arrangeEl?.contains(hit)) {
      const hitLane = hit.dataset.lane == null ? null : Number(hit.dataset.lane);
      if (hitLane !== arrangePaint.laneIndex) return;
      const index = Number(hit.dataset.slot);
      if (Number.isFinite(index)) extendArrangePaint(index, hitLane);
    }
  };

  const end = () => {
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    window.removeEventListener('pointermove', trackPaint);
    arrangeEl?.classList.remove('is-painting');
    if (!arrangePaint) return;
    arrangePaint = null;
    persist();
    renderArrange();
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  window.addEventListener('pointermove', trackPaint);
}

function extendArrangePaint(index, laneIndex = null) {
  if (!arrangePaint) return;
  if (laneIndex !== arrangePaint.laneIndex) return;
  const key = `${laneIndex ?? 'looper'}:${index}`;
  if (arrangePaint.visited.has(key)) return;
  const lane = laneIndex == null ? null : arrangerLanes[laneIndex];
  const slots = lane ? lane.slots : arrangeSlots;
  if (index < 0 || index >= slots.length) return;
  arrangePaint.visited.add(key);
  if (lane) paintLaneSlotValue(laneIndex, index, arrangePaint.value);
  else paintSlotValue(index, arrangePaint.value);
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
  songPlayingPatternIds = new Set();
  clearPlayheads();
  setPlaying(false);
  renderSession();
}

function setPlayMode(mode) {
  const next = mode === 'song' ? 'song' : 'pattern';
  if (project.playMode === next) return;
  project.playMode = next;
  queuedPatternId = null;
  songPlayingPatternIds = new Set();
  clearPlayheads();
  arrangeSlots = slotsFromProject();
  persist();
  renderSession();
  if (transport.isRunning()) {
    // Restart so the new loop (pattern or full timeline) begins at step 0.
    transport.stop();
    transport.start();
  }
}

function setArrangeView(view) {
  const next = normalizeArrangeView(view);
  if (arrangeView() === next) return;
  project.arrangeView = next;
  songPlayingPatternIds = new Set();
  clearPlayheads();
  persist();
  renderSession();
  if (project.playMode === 'song' && transport.isRunning()) {
    // The two timelines are independent; restart the Song loop at step 0.
    transport.stop();
    transport.start();
  }
}

function refreshPatternViews() {
  persist();
  syncControlsFromProject();
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
  trackPopoverId = null;
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
  trackPopoverId = null;
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
  arrangerLanes = arrangerLanes.map((lane) => ({
    ...lane,
    slots: lane.slots.map((s) => (s === id ? '' : s)),
  }));
  selectedCell = null;
  trackPopoverId = null;
  refreshPatternViews();
}

/** Last rendered 0..1 value for a knob (drag origin). */
function knobNorm(knobId) {
  return Math.min(1, Math.max(0, knobUiNorm[knobId] ?? 0));
}

/**
 * Mouse / touch / wheel / keyboard "turning" for one knob dial.
 *
 * Writes through applyKnobDrag() — the exact path MIDI CC uses (curve ->
 * binding window -> desc.set), so hardware and UI never drift. A click is
 * not an assign shortcut: assignment lives on the card's `assign` button.
 * Shift = fine, wheel = 3% per notch, arrows = 5%, Home/End = ends.
 */
function wireKnobDial(dial, knobId) {
  const FULL_TRAVEL_PX = 170; // vertical drag for a full 0..1 sweep
  let dragPointer = null;
  let dragStartY = 0;
  let dragStartNorm = 0;

  const apply = (norm) => applyKnobDrag(knobId, Math.min(1, Math.max(0, norm)));

  const endDrag = (e) => {
    if (dragPointer == null) return;
    if (e && e.pointerId != null && e.pointerId !== dragPointer) return;
    dragPointer = null;
    dial.classList.remove('is-dragging');
  };

  dial.addEventListener('pointerdown', (e) => {
    if (e.button) return; // left button / touch / pen only
    e.preventDefault();
    dragPointer = e.pointerId;
    dragStartY = e.clientY;
    dragStartNorm = knobNorm(knobId);
    dial.classList.add('is-dragging');
    // preventDefault() above suppresses focus, so claim it explicitly:
    // click a dial then use the arrow keys, same as a hardware knob.
    try { dial.focus({ preventScroll: true }); } catch { /* ignore */ }
    try { dial.setPointerCapture(e.pointerId); } catch { /* drag still works */ }
  });
  dial.addEventListener('pointermove', (e) => {
    if (dragPointer == null || e.pointerId !== dragPointer) return;
    e.preventDefault();
    const span = FULL_TRAVEL_PX * (e.shiftKey ? 4 : 1);
    apply(dragStartNorm + (dragStartY - e.clientY) / span);
  });
  dial.addEventListener('pointerup', endDrag);
  dial.addEventListener('pointercancel', endDrag);
  dial.addEventListener('lostpointercapture', endDrag);
  dial.addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = e.shiftKey ? 0.01 : 0.03;
    apply(knobNorm(knobId) - Math.sign(e.deltaY) * step);
  }, { passive: false });
  dial.addEventListener('keydown', (e) => {
    const cur = knobNorm(knobId);
    const step = e.shiftKey ? 0.01 : 0.05;
    const next = {
      ArrowUp: cur + step, ArrowRight: cur + step,
      ArrowDown: cur - step, ArrowLeft: cur - step,
      PageUp: cur + 0.2, PageDown: cur - 0.2,
      Home: 0, End: 1,
    }[e.key];
    if (next == null) return;
    e.preventDefault();
    apply(next);
  });
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
    dial.title = `${knob.id} · CC ${knob.cc} · ${desc ? desc.label : 'unmapped'} · ${valText} — drag to turn`;
    dial.tabIndex = 0;
    dial.setAttribute('role', 'slider');
    dial.setAttribute('aria-label', `${knob.id} — ${desc ? desc.label : 'unmapped'}`);
    dial.setAttribute('aria-valuemin', '0');
    dial.setAttribute('aria-valuemax', '100');
    dial.setAttribute('aria-valuenow', String(Math.round(norm * 100)));
    dial.setAttribute('aria-valuetext', valText);
    wireKnobDial(dial, knob.id);
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
    valEl.dataset.knobVal = '';
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

function padVoiceField(entry, bankId) {
  const chordOpts = chordNameOptions(theory.chordsJson, theory.chordsTheory);
  if (entry.target === 'drum') {
    const kit = resolveKitOr(padMap.kits?.[bankId] || defaultKitForBank(bankId));
    return `<label>drum voice<button type="button" class="mbz-sound-btn" data-f="voice" title="Choose a drum voice"><span>${esc(drumVoiceLabel(entry.voiceId || 'kick'))}</span></button></label>
            <label>kit<button type="button" class="mbz-sound-btn" data-f="kit" title="Choose this bank's drum kit"><span>${esc(kit.label)}</span></button></label>`;
  }
  if (entry.target === 'chord') {
    return `<label>instrument<button type="button" class="mbz-sound-btn" data-f="inst" title="Open the sound browser"><span>${esc(instrumentLabel(entry.instrumentId))}</span></button></label>
            <label>chord<select data-f="chord">${chordOpts.map((c) => `<option value="${esc(c)}"${c === (entry.chordName || 'C') ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>`;
  }
  return `<label>instrument<button type="button" class="mbz-sound-btn" data-f="inst" title="Open the sound browser"><span>${esc(instrumentLabel(entry.instrumentId))}</span></button></label>
          <label>pitch<select data-f="pitch">${PITCH_LABELS.map((p) => `<option value="${esc(p)}"${p === (entry.pitch || 'C') ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
          <label>octave<select data-f="oct">${[1,2,3,4,5].map((o) => `<option value="${o}"${o === (entry.octave ?? 4) ? ' selected' : ''}>${o}</option>`).join('')}</select></label>`;
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
          ${padVoiceField(entry, b)}
          <label>midi note<input data-f="midi" type="number" min="0" max="127" value="${entry.midiNote ?? ''}"></label>
          <label>channel (1–16)<input data-f="ch" type="number" min="1" max="16" value="${ch1}"></label>
          <label>curve<select data-f="curve">
            ${['linear', 'soft', 'hard', 'fixed'].map((c) => `<option value="${c}"${entry.curve === c ? ' selected' : ''}>${c}</option>`).join('')}
          </select></label>
        </div>`;
      card.querySelector('[data-f="target"]').addEventListener('change', (e) => {
        entry.target = e.target.value;
        if (entry.target === 'drum' && !entry.voiceId) entry.voiceId = 'kick';
        if (entry.target === 'note' && !entry.instrumentId) entry.instrumentId = 'grand';
        if (entry.target === 'chord' && !entry.instrumentId) entry.instrumentId = 'grand';
        if (entry.target === 'chord' && !entry.chordName) entry.chordName = 'C';
        savePadMap(padMap);
        renderPads();
        renderPadEditors();
      });
      card.querySelector('[data-f="voice"]')?.addEventListener('click', () => {
        openSoundBrowser({
          target: 'drum',
          kitId: padMap.kits?.[b] || defaultKitForBank(b),
          selectedId: entry.voiceId || 'kick',
          title: `${b}${padNum} drum voice`,
          onSelect(id) {
            entry.voiceId = id;
            savePadMap(padMap);
            renderPads();
            renderPadEditors();
          },
        });
      });
      card.querySelector('[data-f="kit"]')?.addEventListener('click', () => {
        openKitBrowser({
          selectedId: padMap.kits?.[b] || defaultKitForBank(b),
          title: `bank ${b} drum kit`,
          onSelect(kitId) {
            applyBankKit(b, kitId);
          },
        });
      });
      card.querySelector('[data-f="inst"]')?.addEventListener('click', () => {
        openSoundBrowser({
          target: entry.target === 'chord' ? 'chord' : 'note',
          selectedId: entry.instrumentId,
          title: `${b}${padNum} instrument`,
          onSelect(id) {
            entry.instrumentId = resolveInstrument(id).id;
            ensureSample(entry.instrumentId);
            savePadMap(padMap);
            renderPads();
            renderPadEditors();
          },
        });
      });
      const pitchSel = card.querySelector('[data-f="pitch"]');
      if (pitchSel) {
        pitchSel.addEventListener('change', (e) => {
          entry.pitch = e.target.value || 'C';
          savePadMap(padMap);
          renderPads();
        });
      }
      const octSel = card.querySelector('[data-f="oct"]');
      if (octSel) {
        octSel.addEventListener('change', (e) => {
          const n = parseInt(e.target.value, 10);
          if (!Number.isNaN(n)) entry.octave = n;
          savePadMap(padMap);
          renderPads();
        });
      }
      const chordSel = card.querySelector('[data-f="chord"]');
      if (chordSel) {
        chordSel.addEventListener('change', (e) => {
          entry.chordName = e.target.value || 'C';
          savePadMap(padMap);
          renderPads();
        });
      }
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
    dial.setAttribute('aria-valuenow', String(Math.round(n * 100)));
  }
  if (valEl) {
    if (!desc || unmapped) valEl.textContent = '—';
    else {
      const live = (() => { try { return desc.get(); } catch { return null; } })();
      valEl.textContent = live == null ? '—' : desc.format(live);
    }
    dial?.setAttribute('aria-valuetext', valEl.textContent);
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
  songPlayingPatternIds = new Set();
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
  // Steps-per-bar changed: every clip's grid has to follow the new signature.
  for (const p of project.patterns) {
    p.timeSignature = project.timeSignature;
    resizePatternSteps(p, project.timeSignature);
  }
  persist();
  renderGrid();
  renderSession();
  updateVelocityUi();
});
barsSelect.addEventListener('change', () => {
  const pat = activePattern();
  if (pat) {
    pat.bars = Math.min(4, Math.max(1, parseInt(barsSelect.value, 10) || 1));
    // Resize to the CLIP length, not the song timeline (song mode used to
    // stretch step arrays to the whole arrangement).
    const len = patternStepCount(pat);
    for (const ch of pat.channels) ch.steps = Array.from({ length: len }, (_, i) => ch.steps[i] || null);
  }
  persist();
  renderGrid();
  renderSession();
  updateVelocityUi();
});

/** Session controls: mode, launch pads, timeline length, pattern bank. */
modeLiveBtn?.addEventListener('click', () => setPlayMode('pattern'));
modeSongBtn?.addEventListener('click', () => setPlayMode('song'));
arrangeViewButtons.forEach((btn) => {
  btn.addEventListener('click', () => setArrangeView(btn.dataset.arrangeView));
});
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
  const d = arrDiv();
  if (arrangeSlots.length + d > MAX_ARRANGE_BARS * d) return;
  for (let k = 0; k < d; k += 1) arrangeSlots.push('');
  arrangerLanes = arrangerLanes.map((lane) => ({
    ...lane,
    slots: [...lane.slots, ...Array.from({ length: d }, () => '')],
  }));
  persist();
  renderArrange();
});
arrangeDelBtn?.addEventListener('click', () => {
  const d = arrDiv();
  if (arrangeSlots.length <= d) return;
  arrangeSlots.splice(arrangeSlots.length - d, d);
  arrangerLanes = arrangerLanes.map((lane) => ({
    ...lane,
    slots: lane.slots.slice(0, Math.max(d, lane.slots.length - d)),
  }));
  persist();
  renderArrange();
});
arrangeClearBtn?.addEventListener('click', () => {
  if (arrangeView() === 'arranger') {
    if (!arrangerLanes.some((lane) => lane.slots.some(Boolean))) return;
    arrangerLanes = arrangerLanes.map((lane) => ({
      ...lane,
      slots: lane.slots.map(() => ''),
    }));
  } else {
    if (!arrangeSlots.some(Boolean)) return;
    arrangeSlots = arrangeSlots.map(() => '');
  }
  persist();
  renderArrange();
});
arrangeDivSel?.addEventListener('change', () => {
  const prev = arrDiv();
  const next = normalizeArrangeDiv(arrangeDivSel.value);
  if (next === prev) return;
  project.arrangeDiv = next;
  arrangeSlots = resampleSlots(arrangeSlots, prev, next);
  arrangerLanes = arrangerLanes.map((lane) => ({
    ...lane,
    slots: resampleSlots(lane.slots, prev, next),
  }));
  persist();
  renderArrange();
  renderSession();
});
patternNewBtn?.addEventListener('click', addPattern);
patternDupBtn?.addEventListener('click', duplicateActivePattern);
patternRenBtn?.addEventListener('click', () => startRename(project.activePatternId));
patternDelBtn?.addEventListener('click', deleteActivePattern);

/** "+ track" menu (drum / instrument / chord). */
trackAddBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!trackAddMenu) return;
  trackAddMenu.hidden = !trackAddMenu.hidden;
});
trackAddMenu?.querySelectorAll('[data-track-kind]').forEach((btn) => {
  btn.addEventListener('click', () => {
    addTrack(btn.dataset.trackKind);
    if (trackAddMenu) trackAddMenu.hidden = true;
  });
});

/** Click-away for the + track menu and the per-row track editor. */
document.addEventListener('pointerdown', (e) => {
  if (trackAddMenu && !trackAddMenu.hidden && !e.target.closest?.('.mbz-track-add')) {
    trackAddMenu.hidden = true;
  }
  if (!trackPopoverId) return;
  if (e.target.closest?.('.mbz-track-pop')) return;
  if (e.target.closest?.('.mbz-ch-name')) return; // the name button toggles itself
  if (e.target.closest?.('.mbz-browser') || document.body.classList.contains('mbz-browser-open')) return;
  closeTrackPopover();
}, true);

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
  if (audition) refreshPerformClock();
  else stopPerform();
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
        const stepIdx = Math.round(dt / sps) % Math.max(1, patternStepCount(activePattern()));
        let ch = null;
        if (hit.kind === 'pad' && hit.entry?.target === 'drum') {
          ch = pat.channels.find((c) => c.type === 'percussion' && c.voiceId === hit.entry.voiceId)
            || pat.channels.find((c) => c.type === 'percussion');
          if (ch) ch.kitId = padMap.kits?.[hit.bank] || ch.kitId || DEFAULT_DRUM_KIT_ID;
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
  songPlayingPatternIds = new Set();
  renamePatternId = null;
  trackPopoverId = null;
  arrangePaint = null;
  launchPads = false;
  reloadArrangeSlots();
  persist();
  syncControlsFromProject();
  renderGrid();
  renderSession();
  renderPads();
  updateVelocityUi();
});
keysCurveSel.addEventListener('change', () => {
  keysCurve = keysCurveSel.value;
  saveKeysCurvePref(keysCurve);
});

// Note repeat + arpeggiator controls (prefs persist across reloads).
keysRepeatBtn?.addEventListener('click', () => setPerformMode({ repeat: !keysPerform.repeat.enabled }));
keysArpBtn?.addEventListener('click', () => setPerformMode({ arp: !keysPerform.arp.enabled }));
repeatRateSel?.addEventListener('change', () => {
  keysPerform.repeat.rate = repeatRateSel.value;
  saveKeysPerformPref(keysPerform);
});
arpRateSel?.addEventListener('change', () => {
  keysPerform.arp.rate = arpRateSel.value;
  saveKeysPerformPref(keysPerform);
});
arpModeSel?.addEventListener('change', () => {
  keysPerform.arp.mode = arpModeSel.value;
  arpCache = { key: '', seq: [] };
  performIndex = 0;
  saveKeysPerformPref(keysPerform);
});
arpOctavesSel?.addEventListener('change', () => {
  keysPerform.arp.octaves = Math.min(3, Math.max(1, parseInt(arpOctavesSel.value, 10) || 1));
  arpCache = { key: '', seq: [] };
  performIndex = 0;
  saveKeysPerformPref(keysPerform);
});
arpLatchInput?.addEventListener('change', () => {
  keysPerform.arp.latch = arpLatchInput.checked;
  if (!keysPerform.arp.latch) latchedArpNotes = [];
  saveKeysPerformPref(keysPerform);
  refreshPerformClock();
});

// Never leave performance notes running when the tab loses focus.
window.addEventListener('blur', () => {
  if (!performHolds.size && !latchedArpNotes.length) return;
  for (const holdId of [...performHolds.keys()]) clearKeyHighlight(holdId);
  performHolds.clear();
  heldPc.clear();
  stopPerform();
});

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
  renderKeysInstrumentButton();
  updateProjectNote();
}

/** Paint the keys sound button + live sample state. */
function renderKeysInstrumentButton() {
  const resolved = resolveInstrument(keysInstrumentId || DEFAULT_KEYS_INSTRUMENT);
  keysInstrumentId = resolved.id;
  const span = keysInst?.querySelector('span');
  const dot = keysInst?.querySelector('.mbz-sound-dot');
  const state = sampleStatus(resolved.id).state;
  if (span) span.textContent = resolved.label;
  if (dot) dot.dataset.state = state;
  if (keysInst) {
    keysInst.dataset.state = state;
    keysInst.title = `${resolved.label} · ${resolved.category} — click for the sound browser`;
  }
}

function setKeysInstrument(id) {
  const resolved = resolveInstrument(id);
  keysInstrumentId = resolved.id;
  saveKeysInstrumentPref(keysInstrumentId);
  renderKeysInstrumentButton();
  ensureSample(keysInstrumentId).then(renderKeysInstrumentButton);
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

// Restore persisted keys instrument/curve prefs before first render.
const prefInst = loadKeysInstrumentPref();
if (prefInst) keysInstrumentId = resolveInstrument(prefInst).id;
const prefCurve = loadKeysCurvePref();
if (prefCurve) { keysCurve = prefCurve; keysCurveSel.value = prefCurve; }
syncPerformControls({ revealActive: true });

syncControlsFromProject();
renderGrid();
renderSession();
renderKeyboard();
renderPads();
renderPadKits();
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
// Keys preload is gesture-gated (autoplay policy) — preloadDefaults marks
// the selected instrument pending until first Play/pad/key tap, then
// flushPendingLoads() fires it.
onSamplerStatus(() => {
  renderKeysInstrumentButton();
  renderPadKits();
});
preloadDefaults(keysInstrumentId);
keysInst?.addEventListener('click', () => {
  openSoundBrowser({
    target: 'note',
    selectedId: keysInstrumentId,
    title: 'keys instrument',
    onSelect: setKeysInstrument,
  });
});
if (imported) projectNote.textContent += ' · imported suite beats';

