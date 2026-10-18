/**
 * Parse a Universal Device Inquiry reply:
 * F0 7E <id> 06 02 <mfr 1|3 bytes> <family 2> <member 2> <revision 4> F7
 * Akai mfr = 0x47. Revision bytes e.g. 00 01 02 06 -> "01.26".
 * Returns { version, manufacturer, raw } or null if not an inquiry reply.
 */

export const FW_INQUIRY = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];
export const FW_TIMEOUT_MS = 1500;

export function isMidiSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
}
export function parseInquiryReply(data) {
  const bytes = Array.from(data || []);
  if (bytes.length < 10) return null;
  if (bytes[0] !== 0xf0 || bytes[1] !== 0x7e) return null;
  if (bytes[3] !== 0x06 || bytes[4] !== 0x02) return null;
  if (bytes[bytes.length - 1] !== 0xf7) return null;
  const mfr = bytes[5];
  // Manufacturer 0x47 = Akai (single byte); 0x00 prefix = 3-byte id
  const headerLen = mfr === 0x00 ? 3 : 1;
  const revStart = 5 + headerLen + 2 + 2;
  const rev = bytes.slice(revStart, revStart + 4);
  if (rev.length < 4) return null;
  // Akai revision bytes e.g. 00 01 02 06 -> "01.26" (major.minor concatenated).
  const version = `${String(rev[1]).padStart(2, '0')}.${String(rev[2])}${rev[3]}`;
  return { version, manufacturer: mfr, raw: bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ') };
}

/**
 * Query firmware via SysEx Device Inquiry. Requests sysex:true access lazily
 * (user-gestured), sends to MPK-named outputs first, resolves on first reply.
 * Rejects with Error('sysex-blocked' | 'no-outputs' | 'no-reply' | 'denied').
 */
export async function queryFirmwareVersion({ timeoutMs = FW_TIMEOUT_MS } = {}) {
  if (!isMidiSupported()) throw new Error('unsupported');
  let sysexAccess;
  try {
    sysexAccess = await navigator.requestMIDIAccess({ sysex: true });
  } catch {
    throw new Error('sysex-blocked');
  }
  const outputs = [...sysexAccess.outputs.values()];
  if (!outputs.length) throw new Error('no-outputs');
  const ordered = [
    ...outputs.filter((o) => /mpk/i.test(o.name || '')),
    ...outputs.filter((o) => !/mpk/i.test(o.name || '')),
  ];
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('no-reply'));
    }, timeoutMs);
    function cleanup() {
      window.clearTimeout(timer);
      for (const input of sysexAccess.inputs.values()) {
        input.removeEventListener('midimessage', onReply);
      }
    }
    function onReply(event) {
      const parsed = parseInquiryReply(event.data);
      if (!parsed) return;
      cleanup();
      resolve(parsed);
    }
    for (const input of sysexAccess.inputs.values()) {
      input.addEventListener('midimessage', onReply);
    }
    try {
      for (const out of ordered) out.send(FW_INQUIRY);
    } catch {
      cleanup();
      reject(new Error('send-failed'));
    }
  });
}
