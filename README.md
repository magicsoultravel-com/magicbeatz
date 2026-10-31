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
```

No build needed for hacking: `index.html` loads `./src/main.js` as ES
modules, so any static server works too.

## Map

- `src/main.js` → thin boot
- `src/app/console.js` → composition root (transport + pads + keys + grid + MIDI)
- `src/app/sound-browser.js` → searchable instrument / drum voice / kit modal
- `src/sequencer/` → pattern/project/transport (vendored engine)
- `src/audio/` → context / sampler / catalog / routing (no guitar shapes)
- `src/data/instruments.js` → sampled catalog: 130 pitched sounds + 5 drum kits
- `src/theory/` → music + chords (theory triads for named/degree chords)
- `src/pads/model.js` → 8 pads × banks A/B, kit per bank, (channel, note) routing
- `src/midi/` → connection / firmware SysEx inquiry / note helpers
- `src/state/` → store (isolated keys) + settings (knob CCs, octaves)
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
