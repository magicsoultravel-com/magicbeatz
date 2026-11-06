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
- `src/keys/perform.js` → note repeat + arpeggiator (rates, arp sequences, perform clock)
- `src/sequencer/metronome.js` → beat/lamp mapping + count-in math (pure)
- `src/audio/metronome.js` → the click voice (osc blip on the master bus)
- `src/state/` → store (isolated keys) + settings (knob CCs, octaves)
- `tests/arrangement.test.mjs` → 16-bar Looper timeline, migration and song-resolution tests
- `tests/arranger.test.mjs` → whole-Grid Arranger layers, layering, migration and serialization tests
- `tests/perform.test.mjs` → repeat/arp rates, arp ordering, pref normalization, step-gate fit tests
- `tests/sampler-step.test.mjs` → gated sample step events (duration/release/unique stopId)
- `tests/metronome.test.mjs` → beat/lamp mapping, count-in plan and pref normalization
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


## Keys — note repeat & arpeggiator

Below the keyboard is a collapsible **repeat / arp** drawer (the collapsed bar
shows the live setting, e.g. `repeat · 1/16` or `arp · up/down · 1/16 · 2 oct`).
Both are hold-to-play performance modes on the same pointer / computer-keyboard
/ MIDI input path as normal playing:

- **repeat** — MPC-style note repeat: hold any key (or chord) and it retriggers
  at the selected rate. Releasing the last key stops it.
- **arp** — arpeggiator: hold a chord and its notes cycle in **up**, **down**,
  **up/down** (no repeated turnaround) or **random** (reshuffled per chord)
  order, with 1–3 **oct** layers. **latch** keeps the last chord cycling after
  release; the next press starts a new chord.

Details:

- Rates are tempo-synced (1/4, 1/8, 1/8T, 1/16, 1/16T, 1/32) and follow the
  transport BPM live, including mid-hold changes.
- Every step is its own short note: sounds stop on the audio clock inside the
  sampler (`duration`) with a ~30 ms fade instead of the 300 ms preset release,
  so repeats read as `du-du-du-du` rather than one blurred tone, and a step can
  never cut a later, already-scheduled step of the same pitch (each step has its
  own smplr `stopId`). Synth patches that support sustain are opened and released
  per step the same way.
- **repeat** and **arp** are mutually exclusive; turning one on turns the other
  off. Turning both off while keys are held keeps them sounding as normal
  sustains.
- Both respect the **audition** toggle and capture into the active clip while
  ⏺ record is armed, so repeated/arped notes land on the grid.
- Note and chord pads feed repeat and arp exactly like held keys, so a pad chord
  can seed the arp; drum pads never do (they only ever fire their voice).
- Releases are gated per step (repeat 60%, arp 80%), so nothing sticks: mode
  off, last key up, audition off, octave change or tab blur all stop the run.

## Metronome & count-in

- The transport bar has a **click** button (on by default) and one light per
  beat of the current signature — 4/4 shows 4 lights, 3/4 shows 3, 6/8 shows 6.
  The first light of each bar is the accent. Lights rebuild when `sig` changes.
- Clicks and lights are derived from the 16th-note step counter, so swing never
  moves a beat: the metronome stays exactly on the grid while the hats bounce.
- Pressing **▶** or **⏺** plays a **one-bar count-in** (accent on beat 1) and
  the first played step lands exactly on the count-in's last beat — sample
  accurate, because the transport starts at an absolute AudioContext time.
- **⏺** from a standstill also counts in, and captured hits quantize from that
  downbeat instead of from the press, so a live take lines up with bar 1.
- **■** cancels a count-in in progress. Stopping (or song end) also commits
  whatever was captured, so a take is never lost by hitting stop instead of ⏺.
- Muting silences the click but keeps the lights, and kills clicks already
  scheduled in the lookahead window. The pref persists.

## Recording a take

- **⏺** records pads and keys into the active clip. Arming from a standstill
  counts in and quantizes from that downbeat; arming mid-play keeps the origin
  the running loop handed over, so hits land on the grid you hear.
- Recording over a looping clip **commits every pass**: when the loop wraps, the
  hits of the pass that just ended are written, so the grid fills in while the
  loop keeps running. Hits the perform clock already scheduled for the next pass
  stay buffered — nothing is lost and nothing is written twice.
- **rec** in the transport bar picks what a pass does:
  - `overdub` (default) layers — only the steps a pass touches are rewritten.
  - `replace` clears the rows of the instrument a pass played, at the steps it
    played, so replaying a bar fixes the notes you re-play. It is scoped per
    instrument and all drums count as one instrument, so a keys-only pass never
    erases a drum hit.
- **undo take** in the grid bar rolls the whole take back to how the clip looked
  when you armed it: rows the take created are dropped, the rest get their steps
  back. One level, one clip.
- Repeat/arp runs are captured one pitch row per trigger, each with its own
  instrument. Song mode keeps a single frozen origin for a take, because its
  slots have mixed lengths.

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


## Grid editing

- **One row per pitch.** A `note` row stores a fixed `{instrument, pitch,
  octave}`, so captured keys open their own row (labelled `C4 · rhodes`) inside
  that instrument's block, highest pitch on top — a played chord shows up as a
  column of lit rows. Replaying a bar rewrites the steps it touches, so a take
  overdubs instead of leaving the first wrong note behind.
- Drum pads map to their voice row (the kick always lands on the kick row), and
  pads mapped to a single note record like a key. Chord pads record as a chord
  column — one hit per sounding pitch.
- Rows are capped at 32 tracks; anything extra is dropped with a notice in the
  grid header. **tidy** removes note rows that hold no steps.
- The **ruler** above the rows numbers each beat and names the chord every
  column spells (`C`, `Am7`, `Fsus4`, …) from theory data, with a plain interval
  fallback, so a stack is readable even without chord tracks.
- **Drag** a lit cell to move that hit inside its row; drag the ruler to move the
  whole column (every row at that step). A drop on an occupied slot swaps the
  two. Dragging never fires the click, so a drag is not also a toggle.
- Clicking a step opens the **step editor** under the grid: a two-octave keyboard
  that toggles pitches in that column (writing the same rows capture writes),
  plus `−8ve` / `+8ve`, copy / paste / clear for the whole column and step
  stepping `◀ ▶`.

## Arrangement timeline

- The arrangement canvas is **16 bars** long. Fresh and reset projects open
  with the starter clip in bar 1 and the remaining bars empty (rests).
- A **Looper / Arranger** toggle switches between two independent timelines on
  the same canvas. The active view, both timelines, the eight Arranger layers
  and the arrangement length are stored in the project under `magicbeatz-v1`.
- A **Grid** is a complete multi-track pattern. **Looper** is one timeline lane
  of whole Grids. **Arranger** is eight independent timeline lanes, where every
  lane is a whole-Grid layer: a lane clip stores only a `patternId` and never a
  track or channel.
- Any Grid can go into any layer, and the same Grid can occupy several layers.
  Every active layer plays its entire Grid, so grids run side-by-side and
  nothing is deduplicated — two layers that both contain a kick play both kicks.
- Editing, renaming, reordering, adding or deleting tracks inside a Grid changes
  that whole Grid everywhere it is used, and never a lane. There is no
  "missing track" state: lanes only ever reference Grids.
- Use **slots** to choose the painting resolution: `1 / bar` paints whole bars,
  `2 / bar` half bars, and `4 / bar` beats. Changing resolution keeps the same
  clip positions and always preserves the 16-bar canvas.
- **Click or drag** timeline slots to paint the selected Grid. Clicking a slot
  that already contains that Grid clears it to a rest. In Arranger, drag
  painting stays inside the layer where the drag started, while any layer slot
  can be clicked or painted into.
- **Live** loops the selected edit clip and queues clicked clips at the next
  bar boundary. **Song** follows the full 16-bar timeline, including empty
  bars. The timeline playhead advances on every 16th-note step (four steps
  per slot at `4 / bar`) and follows the shared canvas.
- In Arranger Song mode, all eight layers resolve independently and mix: one
  layer can play a Grid while another layer plays a different Grid. Mute and
  solo stay scoped inside each Grid, so soloing a track in one Grid does not
  silence the other layers. The clip launcher highlights every Grid that is
  currently sounding, and the grid playhead follows the first active layer
  containing the Grid being edited.
- With **loop** off in Song mode, playback stops after the last arrangement
  bar (bar 16 by default). With loop on, the whole arrangement repeats.
- The playhead auto-scrolls the timeline to follow the active bar. Drag-painting
  near the left or right edge also scrolls the timeline.
- **Project version 5.** Saved Layers and the active view round-trip exactly.
  Version 4 bound lanes to channel ids (a per-track filter); those clips cannot
  be translated into whole-Grid layers, so a v4 project loads with the Arranger
  cleared once, its Looper timeline untouched, and opens on Looper. Older
  projects start with eight empty layers. Stale lane clips whose Grid was
  deleted are dropped on load.


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
- `magicbeatz-keys-perform-v1` holds the repeat/arp prefs (toggles, rates, arp
  mode, octaves, latch); invalid or hand-edited values fall back to defaults.
- `magicbeatz-metronome-v1` holds just the click toggle ({ enabled }).
- One-shot read-only import from legacy `guitarsuite-magicbeatz`, never
  writes back.
