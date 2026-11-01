/**
 * Anchored track inspector for the sequencer grid.
 *
 * The console owns project state; this module owns the popover DOM, anchoring,
 * focus/Escape behaviour and live sampler-status display. Mutating a field calls
 * the console's `onChange` callback, which persists the project and keeps the
 * grid row label/flags in sync without forcing a full grid rerender.
 */
import {
  sampleStatus,
  drumSampleId,
  onSamplerStatus,
} from '../audio/sampler.js';
import { resolveKitOr, resolveSound } from '../audio/catalog.js';
import {
  instrumentLabel,
  drumVoiceLabel,
  resolveInstrument,
  DEFAULT_DRUM_KIT_ID,
} from '../audio/instruments.js';
import { PITCH_ORDER } from '../midi/notes.js';
import { switchChannelType } from '../sequencer/pattern.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));

const TYPE_LABELS = { percussion: 'drum', note: 'instrument', chord: 'chord' };
const SOURCE_LABELS = {
  splendid: 'Splendid grand',
  soundfont: 'Soundfont',
  electricPiano: 'Electric piano',
  smolken: 'Smolken',
  mellotron: 'Mellotron',
};

let active = null;
let statusUnsub = null;

function trackName(ch) {
  return ch?.name || ch?.voiceId || ch?.instrumentId || ch?.type || 'track';
}

function gainValue(ch) {
  const n = Number(ch?.gain ?? 0.8);
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0.8));
}

function soundStatusId(ch) {
  if (ch.type === 'percussion') return drumSampleId(ch.kitId || DEFAULT_DRUM_KIT_ID);
  return resolveInstrument(ch.instrumentId).id;
}

function statusText(id) {
  const st = sampleStatus(id);
  if (st.state === 'loading') {
    return st.total ? `loading ${Math.min(100, Math.round((st.loaded / st.total) * 100))}%` : 'loading…';
  }
  if (st.state === 'pending-gesture') return 'queued';
  if (st.state === 'ready') return 'ready';
  if (st.state === 'error') return 'error';
  return 'idle';
}

function statusClass(id) {
  return `is-${sampleStatus(id).state || 'idle'}`;
}

function sourceLabel(sound) {
  const src = sound?.source;
  if (!src) return 'Sampled';
  const base = SOURCE_LABELS[src.type] || 'Sampled';
  return src.instrument ? `${base} · ${src.instrument.replace(/_/g, ' ')}` : base;
}

function optionsFor(values, current) {
  const list = [...new Set([current, ...(values || [])].filter(Boolean))];
  if (!list.length) return '<option value="">—</option>';
  return list.map((value) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(value)}</option>`).join('');
}

function soundCard({ action, label, name, meta }) {
  return `<button type="button" class="mbz-tp-sound" data-tp="${action}" title="Change ${esc(label)}">
    <span class="mbz-tp-sound-main">
      <span class="mbz-tp-sound-label">${esc(label)}</span>
      <span class="mbz-tp-sound-name">${esc(name)}</span>
      <span class="mbz-tp-sound-meta">${esc(meta)}</span>
    </span>
    <span class="mbz-tp-sound-change" aria-hidden="true">change</span>
  </button>`;
}

function soundMarkup(ch) {
  if (ch.type === 'percussion') {
    const kit = resolveKitOr(ch.kitId || DEFAULT_DRUM_KIT_ID);
    const voice = ch.voiceId || 'kick';
    return `<div class="mbz-tp-sound-grid is-two">
      ${soundCard({ action: 'kit-open', label: 'kit', name: kit.label, meta: kit.machine })}
      ${soundCard({ action: 'voice-open', label: 'voice', name: drumVoiceLabel(voice), meta: 'logical drum voice' })}
    </div>`;
  }
  const id = resolveInstrument(ch.instrumentId).id;
  const sound = resolveSound(id);
  const meta = [sound?.category, sourceLabel(sound)].filter(Boolean).join(' · ');
  return `<div class="mbz-tp-sound-grid">
    ${soundCard({
      action: 'inst-open',
      label: ch.type === 'chord' ? 'chord instrument' : 'instrument',
      name: instrumentLabel(id),
      meta: meta || 'sampled instrument',
    })}
  </div>`;
}

function voiceMarkup(ch) {
  const typeButtons = ['percussion', 'note', 'chord'].map((type) => `
    <button type="button" class="${ch.type === type ? 'is-on' : ''}" data-tp="type" data-type="${type}"
      aria-pressed="${ch.type === type}">${TYPE_LABELS[type]}</button>`).join('');
  const noteFields = ch.type === 'note' ? `<div class="mbz-tp-fields">
    <label class="mbz-tp-field">pitch<select data-tp-field="pitch">${PITCH_ORDER
    .map((p) => `<option value="${esc(p)}"${p === ch.pitch ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
    <label class="mbz-tp-field">octave<input data-tp-field="oct" type="number" min="0" max="8" value="${esc(ch.octave ?? 4)}"></label>
  </div>` : '';
  const chordFields = ch.type === 'chord' ? `<div class="mbz-tp-fields">
    <label class="mbz-tp-field">mode<select data-tp-field="chordMode">
      <option value="named"${ch.chordMode !== 'degree' ? ' selected' : ''}>named</option>
      <option value="degree"${ch.chordMode === 'degree' ? ' selected' : ''}>degree</option>
    </select></label>
    ${ch.chordMode === 'degree'
      ? `<label class="mbz-tp-field">degree<input data-tp-field="degree" type="number" min="0" max="6" value="${esc(ch.degree ?? 0)}"></label>`
      : `<label class="mbz-tp-field">chord<select data-tp-field="chordName">${optionsFor(active?.chordNames, ch.chordName || 'C')}</select></label>`}
  </div>
  ${ch.chordMode === 'degree'
    ? `<label class="mbz-tp-field is-wide">scale<select data-tp-field="scaleKey">${optionsFor(active?.scaleKeys, ch.scaleKey || 'Ionian')}</select></label>`
    : ''}` : '';
  return `<section class="mbz-tp-section">
    <div class="mbz-tp-section-head"><h3>voice</h3></div>
    <div class="mbz-tp-seg" role="group" aria-label="Track type">${typeButtons}</div>
    ${noteFields}${chordFields}
  </section>`;
}

function mixMarkup(ch) {
  const pct = Math.round(gainValue(ch) * 100);
  return `<section class="mbz-tp-section">
    <div class="mbz-tp-section-head"><h3>mix</h3></div>
    <div class="mbz-tp-gain">
      <label for="mbz-tp-gain-${esc(ch.id)}">gain</label>
      <output data-tp-gain-val>${pct}%</output>
      <input id="mbz-tp-gain-${esc(ch.id)}" data-tp-field="gain" type="range" min="0" max="100" value="${pct}" aria-label="Track gain">
    </div>
    <div class="mbz-tp-toggle-row">
      <button type="button" class="mbz-tp-toggle is-mute${ch.mute ? ' is-on' : ''}" data-tp="mute"
        aria-pressed="${!!ch.mute}">mute <small>${ch.mute ? 'on' : 'off'}</small></button>
      <button type="button" class="mbz-tp-toggle is-solo${ch.solo ? ' is-on' : ''}" data-tp="solo"
        aria-pressed="${!!ch.solo}">solo <small>${ch.solo ? 'on' : 'off'}</small></button>
    </div>
  </section>`;
}

function actionsMarkup(ch, index, total) {
  const hasSteps = Array.isArray(ch.steps) && ch.steps.some(Boolean);
  const confirming = !!active?.confirmDelete;
  return `<footer class="mbz-tp-foot">
    <div class="mbz-tp-actions">
      <button type="button" class="mbz-btn" data-tp="up"${index <= 0 ? ' disabled' : ''} title="Move track up">↑ up</button>
      <button type="button" class="mbz-btn" data-tp="down"${index >= total - 1 ? ' disabled' : ''} title="Move track down">↓ down</button>
      <button type="button" class="mbz-btn" data-tp="dup" title="Duplicate track">duplicate</button>
    </div>
    <div class="mbz-tp-danger">
      <button type="button" class="mbz-btn" data-tp="clear"${hasSteps ? '' : ' disabled'} title="Clear every step on this track">clear steps</button>
      <button type="button" class="mbz-btn is-danger${confirming ? ' is-confirm' : ''}" data-tp="del"${total <= 1 ? ' disabled' : ''}
        title="${confirming ? 'Click again to delete this track' : 'Delete this track'}">${confirming ? 'confirm delete' : 'delete track'}</button>
    </div>
  </footer>`;
}

function render({ focusSelector = '' } = {}) {
  if (!active) return;
  const { pop, channel: ch, index, total, patternName } = active;
  const body = pop.querySelector('.mbz-tp-body');
  const scrollTop = body?.scrollTop || 0;
  const statusId = soundStatusId(ch);
  pop.setAttribute('aria-label', `Edit ${trackName(ch)}`);
  pop.innerHTML = `<header class="mbz-tp-head">
    <div class="mbz-tp-kicker">
      <span class="mbz-tp-badge is-${esc(ch.type)}">${esc(TYPE_LABELS[ch.type] || 'track')}</span>
      <span>row ${index + 1} / ${total}${patternName ? ` · ${esc(patternName)}` : ''}</span>
    </div>
    <button type="button" class="mbz-tp-close" data-tp="close" aria-label="Close track editor">×</button>
    <label class="mbz-tp-name"><span class="mbz-tp-rename">name</span>
      <input data-tp-field="name" type="text" maxlength="24" value="${esc(ch.name || '')}"
        placeholder="${esc(trackName(ch))}" autocomplete="off" spellcheck="false" aria-label="Track name">
    </label>
  </header>
  <div class="mbz-tp-body">
    <section class="mbz-tp-section">
      <div class="mbz-tp-section-head">
        <h3>sound</h3>
        <span class="mbz-tp-status ${statusClass(statusId)}" data-tp-status aria-live="polite">${esc(statusText(statusId))}</span>
        <button type="button" class="mbz-tp-audition" data-tp="audition" title="Preview this track's sound">▶ audition</button>
      </div>
      ${soundMarkup(ch)}
      <p class="mbz-tp-note">${ch.type === 'percussion'
        ? 'the kit supplies every drum voice · samples load on demand'
        : 'sampled instrument · samples load on demand'}</p>
    </section>
    ${voiceMarkup(ch)}
    ${mixMarkup(ch)}
    <p class="mbz-tp-note">changes save automatically · click outside or press esc to close</p>
  </div>
  ${actionsMarkup(ch, index, total)}`;
  const nextBody = pop.querySelector('.mbz-tp-body');
  if (nextBody) nextBody.scrollTop = scrollTop;
  if (focusSelector) {
    pop.querySelector(focusSelector)?.focus({ preventScroll: true });
  }
  paintStatus();
  position();
}

function paintStatus() {
  if (!active) return;
  const node = active.pop.querySelector('[data-tp-status]');
  if (!node) return;
  const id = soundStatusId(active.channel);
  node.className = `mbz-tp-status ${statusClass(id)}`;
  node.textContent = statusText(id);
}

function notifyChange(opts = {}) {
  if (!active) return;
  try {
    active.onChange?.(active.channel, opts);
  } catch (err) {
    console.warn('[track-popover]', err);
  }
}

/**
 * Commit text/number inputs that have not blurred yet.
 *
 * Click-away can remove the popover before `change` fires. Selects and the
 * gain range commit immediately, but name / octave / degree are typed fields,
 * so flush a pending edit before teardown to avoid silently dropping it.
 */
function commitPendingFields(session) {
  const ch = session?.channel;
  if (!ch) return;
  const opts = {};
  const nameField = session.pop.querySelector('[data-tp-field="name"]');
  if (nameField) {
    const name = String(nameField.value || '').trim().slice(0, 24);
    if (name !== String(ch.name || '')) {
      ch.name = name;
      opts.name = true;
    }
  }
  const octField = session.pop.querySelector('[data-tp-field="oct"]');
  if (octField) {
    const octave = Math.min(8, Math.max(0, parseInt(octField.value, 10) || 0));
    if (octave !== ch.octave) {
      ch.octave = octave;
      opts.pitch = true;
    }
  }
  const degreeField = session.pop.querySelector('[data-tp-field="degree"]');
  if (degreeField) {
    const degree = Math.min(6, Math.max(0, parseInt(degreeField.value, 10) || 0));
    if (degree !== ch.degree) {
      ch.degree = degree;
      opts.chord = true;
    }
  }
  if (!opts.name && !opts.pitch && !opts.chord) return;
  try {
    session.onChange?.(ch, opts);
  } catch (err) {
    console.warn('[track-popover]', err);
  }
}

function cancelDeleteConfirm() {
  if (!active?.confirmDelete) return;
  active.confirmDelete = false;
  if (active.confirmTimer) {
    window.clearTimeout(active.confirmTimer);
    active.confirmTimer = null;
  }
  const btn = active.pop.querySelector('[data-tp="del"]');
  if (!btn) return;
  btn.classList.remove('is-confirm');
  btn.textContent = 'delete track';
  btn.title = 'Delete this track';
}

function resetConfirmTimer() {
  if (!active) return;
  if (active.confirmTimer) window.clearTimeout(active.confirmTimer);
  active.confirmTimer = window.setTimeout(() => {
    if (!active) return;
    active.confirmTimer = null;
    active.confirmDelete = false;
    render({ focusSelector: '[data-tp="del"]' });
  }, 3500);
}

function onClick(e) {
  const btn = e.target?.closest?.('[data-tp]');
  if (!btn || !active) return;
  const action = btn.dataset.tp;
  const ch = active.channel;
  if (action !== 'del') cancelDeleteConfirm();

  if (action === 'close') {
    closeTrackPopover({ restoreFocus: true });
    return;
  }
  if (action === 'type') {
    const next = btn.dataset.type;
    if (!next || next === ch.type) return;
    Object.assign(ch, switchChannelType(ch, next));
    notifyChange({ type: true });
    if (active) render({ focusSelector: `[data-tp="type"][data-type="${next}"]` });
    return;
  }
  if (action === 'inst-open') {
    active.onBrowseSound?.({ channel: ch, target: ch.type === 'chord' ? 'chord' : 'note' });
    return;
  }
  if (action === 'voice-open') {
    active.onBrowseSound?.({ channel: ch, target: 'drum' });
    return;
  }
  if (action === 'kit-open') {
    active.onBrowseKit?.(ch);
    return;
  }
  if (action === 'audition') {
    active.onAudition?.(ch);
    return;
  }
  if (action === 'mute' || action === 'solo') {
    ch[action] = !ch[action];
    btn.classList.toggle('is-on', !!ch[action]);
    btn.setAttribute('aria-pressed', String(!!ch[action]));
    const small = btn.querySelector('small');
    if (small) small.textContent = ch[action] ? 'on' : 'off';
    notifyChange({ flags: true });
    return;
  }
  if (action === 'up') { active.onMove?.(-1); return; }
  if (action === 'down') { active.onMove?.(1); return; }
  if (action === 'dup') { active.onDuplicate?.(); return; }
  if (action === 'clear') { active.onClearSteps?.(); return; }
  if (action === 'del') {
    if (active.total <= 1) return;
    if (!active.confirmDelete) {
      active.confirmDelete = true;
      render({ focusSelector: '[data-tp="del"]' });
      resetConfirmTimer();
      return;
    }
    if (active.confirmTimer) {
      window.clearTimeout(active.confirmTimer);
      active.confirmTimer = null;
    }
    active.confirmDelete = false;
    const session = active;
    session.onDelete?.();
    // Deleting normally closes this popover; if the console refused (for
    // example the track list changed underneath us), reset the footer state.
    if (active === session) render({ focusSelector: '[data-tp="del"]' });
  }
}

function onChange(e) {
  if (!active) return;
  cancelDeleteConfirm();
  const field = e.target?.closest?.('[data-tp-field]');
  if (!field) return;
  const ch = active.channel;
  const key = field.dataset.tpField;
  if (key === 'name') {
    ch.name = String(field.value || '').trim().slice(0, 24);
    field.value = ch.name;
    field.placeholder = trackName(ch);
    active.pop.setAttribute('aria-label', `Edit ${trackName(ch)}`);
    notifyChange({ name: true });
    return;
  }
  if (key === 'pitch') { ch.pitch = field.value; notifyChange({ pitch: true }); return; }
  if (key === 'oct') {
    ch.octave = Math.min(8, Math.max(0, parseInt(field.value, 10) || 0));
    field.value = String(ch.octave);
    notifyChange({ pitch: true });
    return;
  }
  if (key === 'chordMode') {
    ch.chordMode = field.value === 'degree' ? 'degree' : 'named';
    if (ch.chordMode === 'named' && !ch.chordName) ch.chordName = 'C';
    notifyChange({ chord: true });
    if (active) render({ focusSelector: '[data-tp-field="chordMode"]' });
    return;
  }
  if (key === 'chordName') { ch.chordName = field.value; notifyChange({ chord: true }); return; }
  if (key === 'scaleKey') { ch.scaleKey = field.value; notifyChange({ chord: true }); return; }
  if (key === 'degree') {
    ch.degree = Math.min(6, Math.max(0, parseInt(field.value, 10) || 0));
    field.value = String(ch.degree);
    notifyChange({ chord: true });
  }
}

function onInput(e) {
  if (!active) return;
  cancelDeleteConfirm();
  const field = e.target?.closest?.('[data-tp-field="gain"]');
  if (!field) return;
  const raw = Math.min(100, Math.max(0, parseInt(field.value, 10) || 0));
  active.channel.gain = raw / 100;
  const out = active.pop.querySelector('[data-tp-gain-val]');
  if (out) out.textContent = `${raw}%`;
  notifyChange({ gain: true });
}

function onFocusIn(e) {
  if (!active?.confirmDelete) return;
  if (e.target?.closest?.('[data-tp="del"]')) return;
  cancelDeleteConfirm();
}

function onPopKeyDown(e) {
  if (!active) return;
  const field = e.target;
  if (e.key === 'Enter' && field?.matches?.('[data-tp-field="name"]')) {
    e.preventDefault();
    field.blur();
  } else if (e.key === 'Escape' && field?.matches?.('[data-tp-field="name"]')) {
    e.preventDefault();
    e.stopPropagation();
    field.value = active.channel.name || '';
    field.blur();
  }
}

function onDocKeyDown(e) {
  if (!active || e.key !== 'Escape') return;
  if (document.body.classList.contains('mbz-browser-open')) return;
  if (e.target?.closest?.('.mbz-browser')) return;
  if (e.target?.matches?.('[data-tp-field="name"]')) return;
  if (active.confirmDelete) {
    active.confirmDelete = false;
    if (active.confirmTimer) {
      window.clearTimeout(active.confirmTimer);
      active.confirmTimer = null;
    }
    render({ focusSelector: '[data-tp="del"]' });
    e.preventDefault();
    return;
  }
  e.preventDefault();
  closeTrackPopover({ restoreFocus: true });
}

function onScroll(e) {
  if (!active) return;
  if (e.target instanceof Node && active.pop.contains(e.target)) return;
  position();
}

function position() {
  if (!active) return;
  const { pop, anchor, host } = active;
  if (!anchor?.isConnected) {
    closeTrackPopover({ notify: false });
    return;
  }
  const sheet = window.matchMedia('(max-width: 720px)').matches;
  pop.classList.toggle('is-sheet', sheet);
  if (sheet) {
    pop.style.removeProperty('position');
    pop.style.removeProperty('left');
    pop.style.removeProperty('top');
    pop.style.removeProperty('right');
    pop.style.removeProperty('bottom');
    return;
  }

  const width = pop.offsetWidth || 340;
  const height = pop.offsetHeight || 420;
  const margin = 8;
  const rect = anchor.getBoundingClientRect();
  const bodyHost = !host || host === document.body || host === document.documentElement;
  pop.style.position = bodyHost ? 'fixed' : 'absolute';

  if (bodyHost) {
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - height - 6);
    }
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    return;
  }

  const hostRect = host.getBoundingClientRect();
  const left = Math.max(margin, Math.min(rect.left - hostRect.left, hostRect.width - width - margin));
  let top = rect.bottom - hostRect.top + 6;
  if (hostRect.top + top + height > window.innerHeight - margin) {
    const above = rect.top - hostRect.top - height - 6;
    top = above >= margin ? above : Math.max(margin, window.innerHeight - height - margin - hostRect.top);
  }
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

/** Open (or replace) the inspector for one channel. */
export function openTrackPopover(opts = {}) {
  closeTrackPopover({ notify: false });
  if (!opts.channel || !opts.anchor) return;
  const pop = document.createElement('div');
  pop.className = 'mbz-track-pop';
  pop.id = `mbz-track-pop-${opts.channel.id}`;
  pop.tabIndex = -1;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', `Edit ${trackName(opts.channel)}`);
  pop.dataset.channelId = opts.channel.id;
  const host = opts.host || document.body;
  host.appendChild(pop);

  active = {
    ...opts,
    host,
    pop,
    total: Math.max(1, opts.total || 1),
    confirmDelete: false,
    confirmTimer: null,
    focusOnOpen: opts.focus !== false,
  };

  pop.addEventListener('click', onClick);
  pop.addEventListener('change', onChange);
  pop.addEventListener('input', onInput);
  pop.addEventListener('focusin', onFocusIn);
  pop.addEventListener('keydown', onPopKeyDown);
  document.addEventListener('keydown', onDocKeyDown, true);
  window.addEventListener('resize', position);
  window.addEventListener('scroll', onScroll, true);
  statusUnsub = onSamplerStatus(paintStatus);

  render();
  window.requestAnimationFrame(() => {
    if (!active) return;
    position();
    if (active.focusOnOpen) {
      active.focusOnOpen = false;
      active.pop.focus({ preventScroll: true });
    }
  });
}

/** Rebuild the popover after the console changed the channel object. */
export function refreshTrackPopover({ focusSelector = '' } = {}) {
  if (!active) return;
  render({ focusSelector });
  position();
}

/** Close the inspector, optionally returning focus to its row name. */
export function closeTrackPopover({ restoreFocus = false, notify = true } = {}) {
  if (!active) return;
  const session = active;
  active = null;
  if (session.confirmTimer) window.clearTimeout(session.confirmTimer);
  session.pop.removeEventListener('click', onClick);
  session.pop.removeEventListener('change', onChange);
  session.pop.removeEventListener('input', onInput);
  session.pop.removeEventListener('focusin', onFocusIn);
  session.pop.removeEventListener('keydown', onPopKeyDown);
  document.removeEventListener('keydown', onDocKeyDown, true);
  window.removeEventListener('resize', position);
  window.removeEventListener('scroll', onScroll, true);
  if (statusUnsub) statusUnsub();
  statusUnsub = null;
  session.pop.remove();
  commitPendingFields(session);
  if (notify) {
    try { session.onClose?.(); } catch (err) { console.warn('[track-popover]', err); }
  }
  if (restoreFocus) {
    window.requestAnimationFrame(() => {
      if (session.anchor?.isConnected) session.anchor.focus({ preventScroll: true });
    });
  }
}

export function isTrackPopoverOpen() {
  return !!active;
}
