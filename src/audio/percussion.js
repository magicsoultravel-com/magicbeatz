/**
 * Drum pads — logical voices routed through the selected sampled kit.
 */
import { soundsForTarget } from './catalog.js';
import { playDrumSample } from './sampler.js';

export const PERCUSSION_BANK = {
  id: 'percussion',
  label: 'percussion',
  voices: soundsForTarget('drum').map((s) => ({ id: s.id, label: s.label })),
};

/**
 * @param {string} kitId sampled drum kit (studio, 808, lo-fi, …)
 * @param {string} voiceId logical pad voice (kick, snare, closed-hat, …)
 */
export function playPercussionVoice(kitId, voiceId, when, velocity) {
  return playDrumSample(kitId, voiceId, when, velocity);
}
