import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARP_GATE,
  DEFAULT_PERFORM_PREFS,
  REPEAT_GATE,
  buildArpSequence,
  normalizeArpMode,
  normalizePerformPrefs,
  normalizeRateId,
  performStatusLabel,
  rateSeconds,
} from '../src/keys/perform.js';

const chord = [
  { pitch: 'C', octave: 4 },
  { pitch: 'E', octave: 4 },
  { pitch: 'G', octave: 4 },
];

function labels(sequence) {
  return sequence.map((n) => `${n.pitch}${n.octave}`);
}

test('rateSeconds maps straight and triplet rates to tempo', () => {
  assert.equal(rateSeconds('1/4', 120), 0.5);
  assert.equal(rateSeconds('1/8', 120), 0.25);
  assert.equal(rateSeconds('1/16', 120), 0.125);
  assert.equal(rateSeconds('1/32', 120), 0.0625);
  assert.ok(Math.abs(rateSeconds('1/8T', 120) - 1 / 6) < 1e-9);
  assert.ok(Math.abs(rateSeconds('1/16T', 120) - 1 / 12) < 1e-9);
});

test('rateSeconds falls back to 1/16 at 120 bpm on bad input', () => {
  assert.equal(normalizeRateId('nope'), '1/16');
  assert.equal(rateSeconds('nope', 120), 0.125);
  assert.equal(rateSeconds('1/16', 0), 0.125);
  assert.equal(rateSeconds('1/16', Number.NaN), 0.125);
});

test('buildArpSequence orders up, down and up/down without repeating endpoints', () => {
  assert.deepEqual(labels(buildArpSequence(chord, { mode: 'up' })), ['C4', 'E4', 'G4']);
  assert.deepEqual(labels(buildArpSequence(chord, { mode: 'down' })), ['G4', 'E4', 'C4']);
  assert.deepEqual(labels(buildArpSequence(chord, { mode: 'updown' })), ['C4', 'E4', 'G4', 'E4']);
  assert.deepEqual(labels(buildArpSequence([{ pitch: 'C', octave: 4 }], { mode: 'updown' })), ['C4']);
  assert.equal(normalizeArpMode('sideways'), 'up');
});

test('buildArpSequence stacks octaves above the held chord', () => {
  assert.deepEqual(
    labels(buildArpSequence(chord, { mode: 'up', octaves: 2 })),
    ['C4', 'E4', 'G4', 'C5', 'E5', 'G5'],
  );
  assert.deepEqual(
    labels(buildArpSequence(chord, { mode: 'up', octaves: 9 })),
    ['C4', 'E4', 'G4', 'C5', 'E5', 'G5', 'C6', 'E6', 'G6'],
  );
  // Octaves below 1 clamp to a single octave.
  assert.equal(buildArpSequence(chord, { mode: 'up', octaves: 0 }).length, 3);
});

test('buildArpSequence random mode shuffles the same note set', () => {
  const sequence = buildArpSequence(chord, { mode: 'random', rng: () => 0 });
  assert.equal(sequence.length, 3);
  assert.deepEqual(labels(sequence).sort(), ['C4', 'E4', 'G4']);
  // Deterministic shuffle for rng() === 0.
  assert.deepEqual(labels(sequence), ['E4', 'G4', 'C4']);
});

test('buildArpSequence ignores empty and malformed notes', () => {
  assert.deepEqual(buildArpSequence([]), []);
  assert.deepEqual(buildArpSequence(null), []);
  assert.deepEqual(labels(buildArpSequence([{ pitch: 'C' }, { octave: 4 }, chord[1]])), ['E4']);
});

test('normalizePerformPrefs returns defaults for missing or invalid state', () => {
  assert.deepEqual(normalizePerformPrefs(null), DEFAULT_PERFORM_PREFS);
  assert.deepEqual(normalizePerformPrefs('nope'), DEFAULT_PERFORM_PREFS);

  const repaired = normalizePerformPrefs({
    repeat: { enabled: true, rate: '1/64' },
    arp: { enabled: true, mode: 'sideways', rate: 'fast', octaves: 9, latch: 'yes' },
  });
  // Both toggles on is invalid: arp wins.
  assert.equal(repaired.repeat.enabled, false);
  assert.equal(repaired.repeat.rate, '1/16');
  assert.equal(repaired.arp.enabled, true);
  assert.equal(repaired.arp.mode, 'up');
  assert.equal(repaired.arp.rate, '1/16');
  assert.equal(repaired.arp.octaves, 3);
  assert.equal(repaired.arp.latch, true);
});

test('normalizePerformPrefs keeps valid values and clamps octaves', () => {
  const prefs = normalizePerformPrefs({
    repeat: { enabled: true, rate: '1/8T' },
    arp: { enabled: false, mode: 'updown', rate: '1/32', octaves: 2, latch: true },
  });
  assert.deepEqual(prefs.repeat, { enabled: true, rate: '1/8T' });
  assert.deepEqual(prefs.arp, {
    enabled: false, mode: 'updown', rate: '1/32', octaves: 2, latch: true,
  });
  assert.equal(normalizePerformPrefs({ arp: { octaves: 0 } }).arp.octaves, 1);
});

test('gate constants keep bass notes short within their step', () => {
  assert.ok(REPEAT_GATE > 0 && REPEAT_GATE < 1);
  assert.ok(ARP_GATE > 0 && ARP_GATE < 1);
  assert.ok(ARP_GATE > REPEAT_GATE);
});

test('every step tail finishes before the next step lands', () => {
  // Mirrors the audio path: sample gate + short fade must fit inside one step,
  // otherwise retriggers smear into one long tone instead of "du-du-du".
  const rates = ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'];
  for (const rate of rates) {
    for (const bpm of [30, 120, 250]) {
      const step = rateSeconds(rate, bpm);
      for (const gateRatio of [REPEAT_GATE, ARP_GATE]) {
        const gate = step * gateRatio;
        const fade = Math.min(0.04, gate * 0.25);
        assert.ok(gate + fade <= step + 1e-9, `${rate} @ ${bpm} bpm overruns its step`);
      }
    }
  }
});

test('performStatusLabel summarizes the collapsed drawer', () => {
  assert.equal(performStatusLabel(DEFAULT_PERFORM_PREFS), 'off');
  assert.equal(
    performStatusLabel({ repeat: { enabled: true, rate: '1/8' }, arp: { enabled: false } }),
    'repeat · 1/8',
  );
  assert.equal(
    performStatusLabel({ arp: { enabled: true, mode: 'updown', rate: '1/16', octaves: 1 } }),
    'arp · up/down · 1/16',
  );
  assert.equal(
    performStatusLabel({ arp: { enabled: true, mode: 'down', rate: '1/32', octaves: 3, latch: true } }),
    'arp · down · 1/32 · 3 oct · latch',
  );
  // Arp wins when both are on, so the label never claims a repeat that is off.
  assert.equal(
    performStatusLabel({ repeat: { enabled: true, rate: '1/4' }, arp: { enabled: true, mode: 'random' } }),
    'arp · random · 1/16',
  );
});
