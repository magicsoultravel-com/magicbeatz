/**
 * magicbeatz channel routing — standalone slim of the suite banks/index.js.
 *
 * Dropped suite baggage: isSoundEnabled()/GUITAR_OCTAVE from playback.js and
 * guitar-shape getVoicedChord from chordResolve.js. Sound is always on here
 * (the console has its own per-channel gain/mute/solo); chords resolve via
 * src/theory/chords.js theory triads.
 */
import { clamp01 } from '../sequencer/pattern.js';
import { PERCUSSION_BANK, playPercussionVoice } from './percussion.js';
import { playPitchedChord, playPitchedInstrument } from './voices.js';
import { chordEntriesFor } from '../theory/chords.js';

export { PERCUSSION_BANK };

let soundOn = true;
export function setSoundEnabled(on) { soundOn = !!on; }
export function isSoundEnabled() { return soundOn; }

/** Play a channel hit with gain x velocity and instrument routing. */
export function playChannelHit(channel, when, velocity, ctx = {}) {
  if (!soundOn) return;
  const gain = clamp01(channel.gain ?? 0.8);
  const vel = clamp01((velocity ?? 0.8) * gain);
  const type = channel.type || 'percussion';
  const instrumentId = channel.instrumentId || (type === 'percussion' ? '' : 'guitar');

  if (type === 'percussion') {
    playPercussionVoice(channel.voiceId || 'kick', when, vel);
    return;
  }

  if (type === 'note') {
    const pitch = channel.pitch || channel.voiceId || 'C';
    const octave = channel.octave ?? 4;
    playPitchedInstrument(instrumentId || 'guitar', pitch, octave, when, vel);
    return;
  }

  if (type === 'chord') {
    const entries = chordEntriesFor(channel, ctx);
    if (entries.length) {
      playPitchedChord(instrumentId || 'keys-pluck', entries, when, vel);
    }
  }
}
