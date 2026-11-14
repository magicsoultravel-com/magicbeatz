import test from 'node:test';
import assert from 'node:assert/strict';
import { NUMPAD_PAD_CODES, padFromNumpadCode } from '../src/pads/keymap.js';

test('numpad 1–8 map to pads P1–P8', () => {
  NUMPAD_PAD_CODES.forEach((code, i) => {
    assert.equal(padFromNumpadCode(code), i + 1);
  });
});

test('the shortcut covers exactly the eight numpad digits', () => {
  assert.equal(NUMPAD_PAD_CODES.length, 8);
  assert.deepEqual(NUMPAD_PAD_CODES, [
    'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4',
    'Numpad5', 'Numpad6', 'Numpad7', 'Numpad8',
  ]);
});

test('other keys never trigger a pad', () => {
  const others = [
    'Numpad0', 'Numpad9', 'NumpadEnter', 'NumpadAdd', 'NumpadSubtract',
    'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'Digit1', 'Digit8',
    'KeyA', 'ArrowDown', 'End', 'Home', '', null, undefined,
  ];
  for (const code of others) {
    assert.equal(padFromNumpadCode(code), null, String(code));
  }
});
