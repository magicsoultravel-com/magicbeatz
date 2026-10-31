/**
 * Searchable Sound Browser — one modal for instruments, drum voices and kits.
 *
 * Sound choices are buttons throughout the console; this module supplies the
 * picker and paints live sample status (queued/loading/ready/error).
 */
import {
  soundsForTarget,
  kitOptions,
  resolveKitOr,
  kitSampleForVoice,
} from '../audio/catalog.js';
import {
  sampleStatus,
  ensureSample,
  ensureDrumKit,
  drumSampleId,
  onSamplerStatus,
} from '../audio/sampler.js';
import { instrumentLabel, drumVoiceLabel } from '../audio/instruments.js';
import { ensureAudio } from '../audio/context.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));

let active = null;
let statusUnsub = null;

const SOURCE_LABELS = {
  splendid: 'Splendid grand',
  soundfont: 'Soundfont',
  electricPiano: 'Electric piano',
  smolken: 'Smolken',
  mellotron: 'Mellotron',
};

function sourceLabel(sound) {
  const src = sound?.source;
  if (!src) return 'Sampled';
  const base = SOURCE_LABELS[src.type] || 'Sampled';
  return src.instrument ? `${base} · ${src.instrument.replace(/_/g, ' ')}` : base;
}

function statusText(id) {
  const st = sampleStatus(id);
  if (st.state === 'loading') {
    if (st.total) {
      const pct = Math.min(100, Math.round((st.loaded / st.total) * 100));
      return `loading ${pct}%`;
    }
    return 'loading…';
  }
  if (st.state === 'pending-gesture') return 'queued';
  if (st.state === 'ready') return 'ready';
  if (st.state === 'error') return 'error';
  return 'idle';
}

function statusClass(id) {
  return `is-${sampleStatus(id).state || 'idle'}`;
}

function closeBrowser() {
  if (!active) return;
  const { overlay, previousFocus } = active;
  overlay.remove();
  document.body.classList.remove('mbz-browser-open');
  if (statusUnsub) statusUnsub();
  statusUnsub = null;
  active = null;
  try { previousFocus?.focus?.(); } catch { /* ignore */ }
}

function paintStatuses() {
  if (!active) return;
  const { overlay, rows } = active;
  const ids = [...new Set(rows.map((row) => row.statusId))];
  for (const id of ids) {
    const nodes = overlay.querySelectorAll(`[data-status-id="${CSS.escape(id)}"]`);
    if (!nodes.length) continue;
    const state = sampleStatus(id).state;
    for (const node of nodes) {
      node.className = `mbz-browser-status is-${state || 'idle'}`;
      node.textContent = statusText(id);
    }
  }
}

/** Build the modal shell; rows are data objects created by each mode. */
function openDialog({
  title, subtitle, placeholder, categories, rows, selectedId, footer, onPick,
}) {
  closeBrowser();
  const previousFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'mbz-browser';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);
  overlay.innerHTML = `
    <div class="mbz-browser-panel" role="document">
      <header class="mbz-browser-head">
        <div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
        <button type="button" class="mbz-browser-close" data-browser-close aria-label="Close">×</button>
      </header>
      <label class="mbz-browser-search">
        <span aria-hidden="true">⌕</span>
        <input type="search" data-browser-search placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
      </label>
      ${categories?.length ? '<div class="mbz-browser-cats" data-browser-cats></div>' : ''}
      <div class="mbz-browser-list" data-browser-list role="listbox" aria-label="Sounds"></div>
      <footer class="mbz-browser-foot">
        <span>${esc(footer || 'type to filter · click to select · esc closes')}</span>
        <span data-browser-count></span>
      </footer>
    </div>`;
  document.body.appendChild(overlay);
  document.body.classList.add('mbz-browser-open');

  const search = overlay.querySelector('[data-browser-search]');
  const list = overlay.querySelector('[data-browser-list]');
  const cats = overlay.querySelector('[data-browser-cats]');
  const count = overlay.querySelector('[data-browser-count]');
  const state = {
    overlay, previousFocus, rows, selectedId, onPick, search, list, cats, count,
    query: '', category: 'All',
  };
  active = state;

  const matches = () => {
    const q = state.query.trim().toLowerCase();
    return rows.filter((row) => {
      if (state.category !== 'All' && row.category !== state.category) return false;
      if (!q) return true;
      const hay = `${row.label} ${row.category} ${row.meta} ${row.detail || ''} ${row.keywords || ''}`.toLowerCase();
      return q.split(/\s+/).every((part) => hay.includes(part));
    });
  };

  const paintRows = () => {
    const listRows = matches();
    count.textContent = `${listRows.length} / ${rows.length}`;
    if (!listRows.length) {
      list.innerHTML = '<p class="mbz-browser-empty">No matches — try a shorter search or another category.</p>';
      return;
    }
    list.innerHTML = listRows.map((row) => `
      <button type="button" class="mbz-browser-row${row.id === state.selectedId ? ' is-selected' : ''}"
        role="option" aria-selected="${row.id === state.selectedId}" data-row="${esc(row.id)}">
        <span class="mbz-browser-main">
          <span class="mbz-browser-name">${esc(row.label)}</span>
          <span class="mbz-browser-meta">${esc(row.meta)}</span>
          ${row.detail ? `<span class="mbz-browser-detail">${esc(row.detail)}</span>` : ''}
        </span>
        <span class="mbz-browser-status ${statusClass(row.statusId)}" data-status-id="${esc(row.statusId)}">${esc(statusText(row.statusId))}</span>
      </button>`).join('');
  };

  const paintCats = () => {
    if (!cats) return;
    cats.innerHTML = categories.map((cat) => `
      <button type="button" class="mbz-browser-chip${cat === state.category ? ' is-active' : ''}" data-cat="${esc(cat)}">${esc(cat)}</button>`).join('');
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { closeBrowser(); return; }
    if (e.target.closest('[data-browser-close]')) { closeBrowser(); return; }
    const chip = e.target.closest('[data-cat]');
    if (chip) {
      state.category = chip.dataset.cat;
      paintCats();
      paintRows();
      return;
    }
    const rowEl = e.target.closest('[data-row]');
    if (!rowEl) return;
    const row = rows.find((r) => r.id === rowEl.dataset.row);
    if (!row) return;
    try { state.onPick(row); } catch (err) { console.warn('[sound-browser]', err); }
    closeBrowser();
  });

  search.addEventListener('input', () => {
    state.query = search.value;
    paintRows();
  });

  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeBrowser();
    }
  });

  paintCats();
  paintRows();
  paintStatuses();
  statusUnsub = onSamplerStatus(() => paintStatuses());
  window.setTimeout(() => search.focus(), 0);
}

function categoriesFor(rows) {
  return ['All', ...rows.reduce((out, row) => {
    if (row.category && !out.includes(row.category)) out.push(row.category);
    return out;
  }, [])];
}

/** Open the instrument / drum-voice picker. */
export function openSoundBrowser({
  target = 'note', selectedId = '', title = '', kitId = '', onSelect = () => {},
} = {}) {
  const kit = resolveKitOr(kitId);
  const sounds = soundsForTarget(target);
  const selected = sounds.find((s) => s.id === selectedId || (s.aliases || []).includes(selectedId))?.id || selectedId;
  const isDrum = target === 'drum';
  const rows = sounds.map((sound) => {
    const isSelected = sound.id === selected;
    if (isDrum) {
      return {
        id: sound.id,
        label: drumVoiceLabel(sound.id),
        category: 'Drums',
        meta: `${kit.label} · ${kit.machine}`,
        detail: `sample: ${kitSampleForVoice(kit.id, sound.id)}`,
        keywords: `${sound.aliases?.join(' ') || ''} ${kit.label} ${kit.machine}`,
        statusId: drumSampleId(kit.id),
        isSelected,
      };
    }
    return {
      id: sound.id,
      label: instrumentLabel(sound.id),
      category: sound.category,
      meta: `${sound.category} · ${sourceLabel(sound)}`,
      detail: sound.tags?.length ? sound.tags.join(' · ') : '',
      keywords: `${sound.aliases?.join(' ') || ''} ${sound.tags?.join(' ') || ''}`,
      statusId: sound.id,
      isSelected,
    };
  });
  // Show the current selection first, then catalog order.
  rows.sort((a, b) => Number(b.isSelected) - Number(a.isSelected)
    || a.category.localeCompare(b.category)
    || a.label.localeCompare(b.label));
  openDialog({
    title: title || (isDrum ? 'drum voice' : 'sound browser'),
    subtitle: isDrum ? `${kit.label} · ${kit.machine}` : `${rows.length} sampled instruments`,
    placeholder: isDrum ? 'search voices or sample names…' : 'search piano, bass, warm pad, wurlitzer…',
    categories: categoriesFor(rows),
    rows,
    selectedId: selected,
    onPick(row) {
      ensureAudio();
      if (isDrum) ensureDrumKit(kit.id);
      else ensureSample(row.id);
      onSelect(row.id);
    },
  });
}

/** Open the drum-kit picker. */
export function openKitBrowser({ selectedId = '', title = 'drum kit', onSelect = () => {} } = {}) {
  const rows = kitOptions().map((kit) => ({
    id: kit.id,
    label: kit.label,
    category: kit.category,
    meta: `${kit.machine} · ${kit.category}`,
    detail: kit.description,
    keywords: `${kit.machine} ${kit.category} ${kit.description}`,
    statusId: drumSampleId(kit.id),
    isSelected: kit.id === selectedId,
  }));
  rows.sort((a, b) => Number(b.isSelected) - Number(a.isSelected)
    || a.label.localeCompare(b.label));
  openDialog({
    title,
    subtitle: 'real sampled drum machines — click to load and assign',
    placeholder: 'search 808, linn, roland, analog…',
    categories: categoriesFor(rows),
    rows,
    selectedId,
    onPick(row) {
      ensureAudio();
      ensureDrumKit(row.id);
      onSelect(row.id);
    },
  });
}

export function closeSoundBrowser() {
  closeBrowser();
}
