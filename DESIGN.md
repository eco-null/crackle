# Crackle design

Warm and quiet: cream paper and warm ink (or the same roles inverted for dark rooms), frosted-glass controls over a softly blurred room. The 3D turntable is the only rich object on screen. User decision 2026-11-27: cream/warm palette and glass replace the default zinc for this project.

## Scene
- Layout follows a two-column player: info, transport, search and lyrics on the left; the deck fills the right ~two thirds (`#deck-zone`), framed by `placeCamera()` in `js/deck3d.js`.
- The deck is built at real scale in cm (45×35 cm plinth, 30.5 cm record, 10 cm label, 23 cm tonearm). Keep new parts in those units.
- Light: a real photo-studio HDRI (Poly Haven `brown_photostudio_02`, CC0) for reflections and ambient light, an overhead rect-area softbox for long soft gradients, and one warm key light with soft shadows. A built-in dark reflection room is the fallback until the HDRI loads. Ground-truth AO (GTAOPass) darkens contacts and corners. Shadows land on an invisible catcher plane plus a soft contact shadow.
- Wood bodies use scanned PBR sets (colour, normal, roughness) from Poly Haven under a clear coat; the Codex photo textures are the fallback and the swatches.
- Camera sits slightly right of the deck so the deck turns toward the panel on the left.
- If frames run slower than ~30 fps for 4 s, the deck lowers its resolution, then drops the AO pass.
- Record surface is generated: roughness, normal and tangential anisotropy maps give track gaps, a rolled edge and the radial highlight wedges. The label is a separate disc, and the vinyl ring stops at its edge (no shared plane, no z-fighting).
- Glass controls: translucent warm fill, a top sheen, a 1px light edge, backdrop blur. One primary control (play) in solid ink.

## Details
- Hardware finish (tonearm, headshell, platter rim, knobs, buttons) is chosen apart from the body (`prefs.metal`).
- Headshell is an extruded, bevelled plate with mounting slots and screws; the cartridge has coloured leads, a cantilever and diamond; the counterweight carries a printed scale; a cue platform rises under the tube.
- Buttons are brushed aluminium with engraved labels; LEDs are domed lenses; body silkscreen (SPEED, POWER, PITCH) switches ink for light and dark bodies.
- Clear-coated bodies carry faint swirl marks in the clear coat; shadows are soft variance shadow maps.
- Dust cover: one rounded smoked-acrylic hood with a 5 mm wall and hinges, rendered inside then outside for correct layering.

## Motion
- Platter: torque-limited spin-up (~0.9 s) and electronic brake (~1.6 s), acceleration itself ramps so there is no jolt. 33⅓, 45 or 78 rpm, ±8% pitch.
- Tonearm: cue up, travel on a minimum-jerk curve (0.7–3.2 s), settle 0.25 s, then a slow hydraulic descent. It never moves sideways while lowered except for groove tracking; any jump over 0.15° lifts first. While playing it sways very slightly once per turn, like a real pressing.
- Opening shot: a 2.4 s dolly in. Focus mode moves the framing on a 0.9 s ease. Knob, fader and lid run on critically damped springs; LEDs and the lamp fade in.
- Album change: arm returns to rest, platter stops, record lifts 9 cm and the new one drops, then the platter starts and the arm cues in.
- Dragging the arm lifts it and follows the pointer; dropping it on the record seeks.
- UI motion 150–200 ms, `cubic-bezier(0.16, 1, 0.3, 1)`; all of it honors `prefers-reduced-motion`.

## Chrome
- Dock and brand hide after 3.5 s idle; focus mode hides the info column and centers the deck, with one lyric line under it.
- Primary button is inverted neutral. Status color only on the source dot and badges.
- Type: Inter for reading, JetBrains Mono for times, labels and engravings.
