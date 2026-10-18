import { PERCUSSION_PLAYERS } from './voices.js';

export const PERCUSSION_BANK = {
  id: 'percussion',
  label: 'percussion',
  voices: [
    { id: 'kick', label: 'kick' },
    { id: 'snare', label: 'snare' },
    { id: 'closed-hat', label: 'closed hat' },
    { id: 'open-hat', label: 'open hat' },
    { id: 'clap', label: 'clap' },
    { id: 'tom', label: 'tom' },
    { id: 'hi-tom', label: 'hi tom' },
    { id: 'mid-tom', label: 'mid tom' },
    { id: 'rim', label: 'rim' },
    { id: 'cowbell', label: 'cowbell' },
    { id: 'shaker', label: 'shaker' },
    { id: 'ride', label: 'ride' },
    { id: 'crash', label: 'crash' },
  ],
};

export function playPercussionVoice(voiceId, when, velocity) {
  const play = PERCUSSION_PLAYERS[voiceId];
  if (play) play(when, velocity);
}
