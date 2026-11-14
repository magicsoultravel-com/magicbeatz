/**
 * Computer-keyboard pad shortcuts (pure — no DOM, no audio).
 *
 * `KeyboardEvent.code` is the physical key, so these codes fire whether NumLock
 * is on (`key: "1"`) or off (`key: "End"` / arrow keys). Numpad 1–8 map to the
 * eight visible pads P1–P8 in the active bank; top-row digits keep their clip
 * shortcuts (`Digit1`–`Digit8`, handled separately).
 */
export const NUMPAD_PAD_CODES = [
  'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4',
  'Numpad5', 'Numpad6', 'Numpad7', 'Numpad8',
];

/** Physical numpad code -> pad number 1–8, or null for any other key. */
export function padFromNumpadCode(code) {
  const idx = NUMPAD_PAD_CODES.indexOf(code);
  return idx < 0 ? null : idx + 1;
}
