function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

export const MUSICAL_ORDER = [
  'C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb',
  'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B',
];

export const CHROMATIC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const FLAT_TO_SHARP = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };
/** Enharmonic spellings that are not simple letter+b flats. */
const ENHARMONIC_TO_SHARP = {
  Cb: 'B',
  Fb: 'E',
  'E#': 'F',
  'B#': 'C',
  ...FLAT_TO_SHARP,
};

export function normalizePitch(note) {
  if (!note || note === 'N/A') return '';
  const trimmed = String(note).trim();
  if (ENHARMONIC_TO_SHARP[trimmed]) return ENHARMONIC_TO_SHARP[trimmed];
  const letter = trimmed.charAt(0).toUpperCase();
  const acc = trimmed.slice(1);
  const key = letter + acc;
  if (ENHARMONIC_TO_SHARP[key]) return ENHARMONIC_TO_SHARP[key];
  if (acc === 'b' && FLAT_TO_SHARP[letter + 'b']) return FLAT_TO_SHARP[letter + 'b'];
  if (acc === '#' && (letter === 'E' || letter === 'B')) return ENHARMONIC_TO_SHARP[letter + '#'];
  return letter + acc;
}

export function pitchToIndex(pitch) {
  return CHROMATIC.indexOf(normalizePitch(pitch));
}

export function getRoot(chord) {
  const match = chord.match(/^[A-G](#|b)?/);
  return match ? match[0] : chord;
}

export function musicalSort(a, b) {
  const indexA = MUSICAL_ORDER.indexOf(getRoot(a));
  const indexB = MUSICAL_ORDER.indexOf(getRoot(b));
  return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
}

export function sortNotesByMusicalOrder(notes) {
  return [...notes].sort((a, b) => {
    const indexA = MUSICAL_ORDER.indexOf(a);
    const indexB = MUSICAL_ORDER.indexOf(b);
    return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
  });
}

/**
 * Notes JSON is keyed 0–12; frets above 12 wrap the same pitch-class pattern.
 * Shared by fretboard display, theory lookup, and voiced playback.
 */
export function noteAtFret(stringData, fret) {
  if (!stringData) return '';
  const n = typeof fret === 'number' ? fret : parseInt(fret, 10);
  if (Number.isNaN(n) || n < 0) return '';
  if (n === 0) return stringData['0'] ?? '';
  const noteIndex = ((n - 1) % 12) + 1;
  return stringData[String(noteIndex)] ?? '';
}

const SHAPE_STRING_KEYS = [
  ['E1', 'E'],
  ['A', 'A'],
  ['D', 'D'],
  ['G', 'G'],
  ['B', 'B'],
  ['E2', 'e'],
];

export function getChordNotes(chordShape, notesJson) {
  if (!chordShape || !notesJson) return [];

  const notes = [];
  for (const [shapeKey, notesKey] of SHAPE_STRING_KEYS) {
    const fretValue = chordShape[shapeKey] ?? 'x';
    if (fretValue === 'x' || fretValue === '') continue;
    const note = noteAtFret(notesJson[notesKey] ?? notesJson[notesKey.toUpperCase()], fretValue);
    if (note) notes.push(normalizePitch(note));
  }
  return [...new Set(notes)];
}

export function getNoteName(rootNumber, interval) {
  return CHROMATIC[(rootNumber + interval) % 12];
}

export function getTheoryNotes(root, intervalsStr) {
  const rootIdx = pitchToIndex(root);
  if (rootIdx < 0) return [];
  return intervalsStr.split(/\s+/).map(Number).map((i) => CHROMATIC[(rootIdx + i) % 12]);
}

export function getScaleSemitones(steps) {
  if (!steps?.length) return [0];
  let cumulative = 0;
  const semitones = [0];
  for (const step of steps) {
    cumulative += step;
    semitones.push(cumulative);
  }
  return semitones;
}

/** Pitch classes for each scale degree (closing octave excluded). */
export function getScaleNotes(root, steps) {
  const rootIdx = pitchToIndex(root);
  if (rootIdx < 0 || !steps?.length) return [];
  const semis = getScaleSemitones(steps);
  const degreeSemis = semis[semis.length - 1] === 12 ? semis.slice(0, -1) : semis;
  return degreeSemis.map((s) => CHROMATIC[(rootIdx + s) % 12]);
}

/** Ascending scale degrees with octaves that rise when the pitch wraps (capped for guitar range). */
export function getScaleNotesWithOctaves(root, steps, startOctave = 3, maxOctave = 4) {
  const degrees = getScaleNotes(root, steps);
  if (!degrees.length) return [];
  // Include tonic at the top of the run for complete ascending playback.
  const pitches = [...degrees, degrees[0]];
  let octave = startOctave;
  let lastIdx = pitchToIndex(pitches[0]);
  return pitches.map((pitch, i) => {
    const idx = pitchToIndex(pitch);
    if (i > 0 && idx <= lastIdx) octave += 1;
    octave = Math.min(octave, maxOctave);
    lastIdx = idx;
    return { pitch, octave };
  });
}

function triadQuality(thirdInterval, fifthInterval) {
  if (thirdInterval === 3 && fifthInterval === 6) return 'dim';
  if (thirdInterval === 3 && fifthInterval === 7) return 'min';
  if (thirdInterval === 4 && fifthInterval === 7) return 'maj';
  if (thirdInterval === 4 && fifthInterval === 8) return 'aug';
  return 'maj';
}

function chordSymbol(root, quality) {
  if (quality === 'min') return `${root}m`;
  if (quality === 'dim') return `${root}dim`;
  if (quality === 'aug') return `${root}aug`;
  return root;
}

function romanNumeral(degree, quality) {
  const numerals = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
  let roman = numerals[degree] || String(degree + 1);
  if (quality === 'min') roman = roman.toLowerCase();
  if (quality === 'dim') roman = `${roman.toLowerCase()}°`;
  return roman;
}

/** Diatonic triad on each scale degree (7 degrees; octave not counted). */
export function getDiatonicTriads(root, steps) {
  const notes = getScaleNotes(root, steps);
  if (!notes.length) return [];
  const len = notes.length;

  return notes.map((rootNote, degree) => {
    const thirdNote = notes[(degree + 2) % len];
    const fifthNote = notes[(degree + 4) % len];
    const ri = pitchToIndex(rootNote);
    let ti = pitchToIndex(thirdNote);
    let fi = pitchToIndex(fifthNote);
    if (ti <= ri) ti += 12;
    if (fi <= ti) fi += 12;
    const quality = triadQuality(ti - ri, fi - ri);
    return {
      degree,
      root: rootNote,
      notes: [rootNote, thirdNote, fifthNote],
      quality,
      symbol: chordSymbol(rootNote, quality),
      roman: romanNumeral(degree, quality),
    };
  });
}

export function findTriadByRoman(triads, numeral) {
  return triads.find((t) => t.roman === numeral) || null;
}

/** Chromatic major triad on scale degree flattened by `flatSemitones` (bVII=10, bVI=8). */
function flatDegreeMajorTriad(scaleRoot, flatSemitones, roman) {
  const rootIdx = pitchToIndex(scaleRoot);
  if (rootIdx < 0) return null;
  const chordRoot = CHROMATIC[(rootIdx + flatSemitones) % 12];
  const third = CHROMATIC[(rootIdx + flatSemitones + 4) % 12];
  const fifth = CHROMATIC[(rootIdx + flatSemitones + 7) % 12];
  return {
    degree: -1,
    root: chordRoot,
    notes: [chordRoot, third, fifth],
    quality: 'maj',
    symbol: chordRoot,
    roman,
  };
}

export function resolveProgressionChords(root, steps, pattern, options = {}) {
  const triads = getDiatonicTriads(root, steps);
  const { quality } = options;
  return pattern
    .split(/\s+/)
    .filter(Boolean)
    .map((numeral) => {
      if (/^bVII$/i.test(numeral)) return flatDegreeMajorTriad(root, 10, 'bVII');
      if (/^bVI$/i.test(numeral)) return flatDegreeMajorTriad(root, 8, 'bVI');
      return findTriadByRoman(triads, numeral);
    })
    .filter(Boolean)
    .map((triad) => {
      if (!quality) return triad;
      let symbol = triad.symbol;
      if (quality === 'dom7') {
        symbol = symbol.endsWith('m') ? `${symbol}7` : `${symbol}7`;
      }
      return { ...triad, symbol };
    });
}

/** Parse human numerals (e.g. "I – IV – V") into a pattern string. */
export function numeralsToPattern(numerals) {
  if (!numerals) return '';
  return numerals
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\|/g, ' ')
    .split(/[\s–—\-]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      if (/^bVII/i.test(token)) return 'bVII';
      if (/^bVI(?!I)/i.test(token)) return 'bVI';
      return token.replace(/7.*$/i, '').replace(/ø.*/i, '°').replace(/alt.*/i, '');
    })
    .join(' ');
}

export function buildChordTable(uniqueChords, chordsJson, getCellValue, options = {}) {
  const { tableClass = '', interactive = false, chordHeaders = false } = options;
  const allData = {};
  let maxRows = 0;

  for (const chord of uniqueChords) {
    const variant = chordsJson[chord]?.variant1;
    if (variant && typeof variant === 'object') {
      allData[chord] = getCellValue(chord, variant, Array.isArray(variant) ? variant : Object.values(variant));
      maxRows = Math.max(maxRows, allData[chord].length);
    } else {
      allData[chord] = ['N/A'];
      maxRows = Math.max(maxRows, 1);
    }
  }

  const chordNames = Object.keys(allData);
  const classes = [tableClass, interactive ? 'fb-chord-table' : ''].filter(Boolean).join(' ');
  let html = classes ? `<table class="${classes}">` : '<table>';
  html += '<thead><tr>';
  for (const name of chordNames) {
    const safe = name.replace(/"/g, '&quot;');
    if (chordHeaders) {
      html += `<th class="chord-table-header" data-chord="${safe}"></th>`;
      continue;
    }
    const notesAttr = interactive
      ? ` class="fb-selectable fb-chord-col" data-chord="${safe}" data-label="${safe}"`
      : '';
    html += `<th${notesAttr}>${escapeHtml(name)}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (let i = 0; i < maxRows; i++) {
    html += '<tr>';
    for (const name of chordNames) {
      const cell = allData[name][i] ?? '&nbsp;';
      html += `<td>${cell}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}
