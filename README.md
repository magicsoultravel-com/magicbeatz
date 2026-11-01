# magicbeatz

Standalone step-sequencer console for the **AKAI MPK mini** (MK3 layout:
bottom row P1–4, top row P5–8, K1–K8 knobs, joystick = pitchbend + CC1).

Spun off from guitarsuite — zero suite imports, own `magicbeatz-v1`
storage, own `./assets/*.json` theory data.

## Run

```bash
npm install
npm run dev      # local console
npm run build    # -> dist/ (relative base, host anywhere static)
npm run preview  # serve dist/
npm test         # arrangement engine tests (node:test)
```

No build needed for hacking: `index.html` loads `./src/main.js` as ES
modules, so any static server works too.

## Map

- `src/main.js` → thin boot
- `src/app/console.js` → composition root (transport + pads + keys + grid + MIDI)
- `src/app/sound-browser.js` → searchable instrument / drum voice / kit modal
- `src/app/track-popover.js` → anchored track inspector (sound · voice · mix · actions)
- `src/sequencer/` → pattern/project/transport (vendored engine)
- `src/audio/` → context / sampler / catalog / routing (no guitar shapes)
- `src/data/instruments.js` → sampled catalog: 130 pitched sounds + 5 drum kits
- `src/theory/` → music + chords (theory triads for named/degree chords)
- `src/pads/model.js` → 8 pads × banks A/B, kit per bank, (channel, note) routing
- `src/midi/` → connection / firmware SysEx inquiry / note helpers
- `src/state/` → store (isolated keys) + settings (knob CCs, octaves)
- `tests/arrangement.test.mjs` → 16-bar timeline, migration and song-resolution tests
- `assets/` → notes/chords/scales/chords-theory JSON

## Sounds

- Keys, tracks and pads use the **Sound Browser** (search by name, category,
  source or tag). No native sound dropdowns.
- Pitched sounds are real smplr samples: Splendid grand, MusyngKite MIDI.js
  soundfonts, electric pianos (Wurlitzer / CP-80 / Pianet / TX81Z), Smolken
  upright bass, and Mellotron tape instruments.
- Drum kits are real sampled machines: Studio RZ-1 (Casio-RZ1), TR-808,
  LM-2 Lo-Fi, Roland CR-8000, MFB-512.
- Bank A defaults to Studio RZ-1; Bank B defaults to TR-808. Each bank and each
  percussion track remembers its kit.
- Samples load lazily on first use. The UI shows queued / loading / ready /
  error; while loading an instrument is silent (never a fake synth fallback).
- Legacy instrument and drum ids migrate automatically, both in pad maps and
  saved projects (`piano` → `grand`, `bass-sub` → `synth-bass-1`,
  `hi-tom` → `tom-high`).


## Tracks

- Fresh projects and every new clip start with an **8-track template**:
  kick, snare, hats, open hat, bass, keys, lead and pad. Existing saved
  projects keep their own track layout.
- Click a track name to open the anchored inspector. It covers the sound/kit,
  voice type, pitch/octave or chord settings, gain, mute/solo, reorder,
  duplicate, clear steps and a two-click delete.
- The inspector follows its row while the grid scrolls, flips above the row
  when there is no space below, and becomes a bottom sheet below 720px.
  Escape and the close button return focus to the row name; clicking away
  closes it without moving focus.


## Arrangement timeline

- The arrangement canvas is **16 bars** long. Fresh and reset projects open
  with the starter clip in bar 1 and the remaining bars empty (rests).
- Use **slots** to choose the painting resolution: `1 / bar` paints whole bars,
  `2 / bar` half bars, and `4 / bar` beats. Changing resolution keeps the same
  clip positions and always preserves the 16-bar canvas.
- **Click or drag** timeline slots to paint the selected clip. Clicking a slot
  that already contains that clip clears it to a rest. Keyboard activation
  still toggles the focused slot.
- **Live** loops the selected edit clip and queues clicked clips at the next
  bar boundary. **Song** follows the full 16-bar arrangement, including empty
  bars. The timeline playhead advances on every 16th-note step (four steps
  per slot at `4 / bar`) and the grid playhead follows the clip that is
  sounding.
- With **loop** off in Song mode, playback stops after the last arrangement
  bar (bar 16 by default). With loop on, the whole arrangement repeats.
- The playhead auto-scrolls the timeline to follow the active bar. Drag-painting
  near the left or right edge also scrolls the timeline.
- Arrangement length (`arrangeBars`), resolution, loop setting, play mode and
  clips are stored in the project under `magicbeatz-v1`. Projects saved before
  this field existed migrate to 16 bars; their clips keep their original
  positions.


## MIDI notes

- Chrome + HTTPS (or localhost) required for Web MIDI.
- Normal playing never asks for SysEx — only the `fw?` button does
  (Device Inquiry, read-only). Denied/blocked states show in the pill.
- CC-learn: hit `learn` on a knob, then twist the hardware knob. Next
  incoming CC binds and is *not* applied (no parameter jumps).
- Pad learn taps the raw MIDI stream before routing, so routing never
  eats the note you're trying to teach.

## Storage

- `magicbeatz-v1` (project) + `magicbeatz-padmap-v1` (pads, schema 3 with
  per-bank kits) — both schema-tagged and migrated in place.
- One-shot read-only import from legacy `guitarsuite-magicbeatz`, never
  writes back.
