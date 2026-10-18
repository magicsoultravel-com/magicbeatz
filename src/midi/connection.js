/**
 * magicbeatz MIDI wrapper (DeepSeek #5: wrap, don't extend src/magicBeatz/midiInput.js).
 * Own requestMIDIAccess handle; parses notes + CC + pitchbend + program.
 * CC-learn rule: when a learn slot is armed, the next incoming CC binds
 * and is NOT applied to any parameter (avoids live-debug jumps).
 *
 * Firmware query: lazy sysex:true upgrade ONLY on button click, so normal
 * playing never triggers the Chrome SysEx permission prompt.
 */

const FW_INQUIRY = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];
const FW_TIMEOUT_MS = 1500;

export function isMidiSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
}

/**
 * @param {{
 *   onNoteOn?: (note:number, vel:number, channel:number)=>void,
 *   onNoteOff?: (note:number, channel:number)=>void,
 *   onCC?: (cc:number, value:number, channel:number)=>void,
 *   onPitchBend?: (value:number, channel:number)=>void,
 *   onStatus?: (s:{kind:string, deviceName?:string})=>void,
 * }} handlers
 */
export function connectMbzMidi(handlers = {}) {
  const { onNoteOn, onNoteOff, onCC, onPitchBend, onStatus } = handlers;
  let access = null;
  const wired = new Set();
  let closed = false;

  function emit(status) { onStatus?.(status); }

  function report() {
    if (!access) return;
    const inputs = [...access.inputs.values()].filter((i) => i.state === 'connected');
    if (!inputs.length) { emit({ kind: 'none' }); return; }
    emit({ kind: 'ready', deviceName: inputs.map((i) => i.name || i.id).filter(Boolean).join(', ') || 'MIDI' });
  }

  function onMessage(event) {
    const data = event.data;
    if (!data || data.length < 2) return;
    const status = data[0] & 0xf0;
    const channel = data[0] & 0x0f;

    if (status === 0x90 || status === 0x80) {
      const note = data[1] & 0x7f;
      const vel = data.length > 2 ? data[2] & 0x7f : 0;
      if (status === 0x90 && vel > 0) onNoteOn?.(note, vel / 127, channel);
      else onNoteOff?.(note, channel);
      return;
    }
    if (status === 0xb0) {
      const cc = data[1] & 0x7f;
      const value = data.length > 2 ? data[2] & 0x7f : 0;
      onCC?.(cc, value, channel);
      return;
    }
    if (status === 0xe0) {
      const lsb = data[1] & 0x7f;
      const msb = (data.length > 2 ? data[2] : 0) & 0x7f;
      const raw = (msb << 7) | lsb; // 0..16383, center 8192
      onPitchBend?.((raw - 8192) / 8192, channel);
    }
    // program change (0xc0) + channel pressure (0xd0): ignored for v1, noted for later
  }

  function unwire() {
    for (const input of wired) input.removeEventListener('midimessage', onMessage);
    wired.clear();
  }
  function wireAll() {
    if (!access) return;
    unwire();
    for (const input of access.inputs.values()) {
      input.addEventListener('midimessage', onMessage);
      wired.add(input);
    }
    report();
  }

  if (!isMidiSupported()) {
    emit({ kind: 'unsupported' });
    return { disconnect() {} };
  }

  navigator.requestMIDIAccess({ sysex: false }).then((midiAccess) => {
    if (closed) return;
    access = midiAccess;
    access.addEventListener('statechange', () => { if (!closed) wireAll(); });
    wireAll();
  }, () => { if (!closed) emit({ kind: 'denied' }); });

  return {
    disconnect() {
      closed = true;
      unwire();
      access = null;
    },
    getAccess() { return access; },
  };
}
