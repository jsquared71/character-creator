# AAA Build Prompt — WoW Character Creator

Completed brief for upgrading this repo from primitive-shape placeholders to a
AAA-quality real-time character creator.

---

Build a **browser-based real-time 3D character creation screen** in the style of
**World of Warcraft's character creator (The War Within / Dragonflight-era
barbershop UI)**, at the quality level of **the most recent AAA MMORPG character
creators** (WoW: The War Within, FFXIV: Dawntrail, Black Desert). It should be
visually beautiful, stunning in detail, with every element done at AAA quality —
from **skin, hair, and eye shading** to **armor, pauldron, and cloth metalwork**
to the lighting rig, the environment backdrop, the UI frame, the transition
animations, and anything else you can think of — and convey a strong sense of
**heroic weight and presence**: the character should feel like it has mass,
occupy real space, and hold the camera the way a hero-select screen does.

**Tech stack:** three.js (r180, ES modules via CDN — no build step, matching the
existing `app.js`), WebGL2, custom GLSL via `ShaderMaterial` / `onBeforeCompile`,
`EffectComposer` for post-processing. Zero external binary assets — every
texture, envmap, and mesh is generated procedurally at runtime or authored in
code. No WoW art assets, models, or textures may be copied or downloaded; this
is a style-alike, built from scratch.

## Scope

- **In:** the character creation screen only — race/gender/class selection, the
  full customization slider set, the rotating hero preview, the "Enter World"
  confirmation flourish. **Out:** gameplay, world streaming, networking,
  persistence beyond `localStorage`, audio beyond optional UI ticks.
- **Core content:** all 14 races × 3 gender profiles × 13 classes already in
  `app.js`, each with a distinct silhouette (Tauren reads as 2.4m of bulk; Gnome
  reads as 0.9m and top-heavy — not one mesh uniformly scaled). Per race:
  ≥6 face shapes, ≥8 hairstyles, ≥6 skin tones drawn from the race's canonical
  range, race-specific features (tusks, horns, hooves, ears, tails, plate
  scales). Per class: a distinct armor set silhouette tinted to the canonical
  class color already in `wowClasses`.
- **UI, HUD, and interaction:** WoW-style faction-tinted frame — Alliance blue /
  Horde red / Neutral gold — with beveled gilt borders, parchment-grain panels,
  and glyph-etched dividers, all drawn procedurally (canvas2D → texture or SDF
  shader), never as flat CSS rectangles. Left rail: faction → race → class.
  Right rail: customization sliders, grouped and collapsible. Orbit + dolly on
  the preview with inertial damping and soft angle clamps. Hover states, focus
  rings, and keyboard navigation throughout. Full WCAG AA contrast on all text.
  Randomize must animate into its new state, not snap.
- **Control feel / responsiveness bar:** locked 60fps at 1440p on integrated
  graphics; every slider updates the mesh in the same frame as the input event
  (no debounce, no rebuild-on-change); race/class switches cross-fade in
  ≤200ms with no visible hitch; first meaningful paint under 1.5s on a cold
  cache.

## Technical approach for max quality at good performance

1. **Custom shaders.** Skin: pre-integrated subsurface scattering with a
   curvature-driven diffusion LUT, plus dual-lobe specular. Hair: Kajiya-Kay
   anisotropic strands with per-strand tint variation and depth-sorted alpha.
   Armor: PBR metal with tinted anisotropic highlights, edge wear driven by
   curvature, and a class-colored emissive rim. Eyes: parallax-corrected iris
   with a cornea specular lobe.
2. **Procedural / generative textures.** All albedo, normal, roughness, AO, and
   mask maps synthesized on the GPU at load into render targets — layered value
   and Worley noise for skin pores and scales, flow-aligned noise for hair,
   generated scratch/pit fields for metal. Backdrop, IBL environment, and the UI
   parchment and gilt frames come from the same generator. This keeps the repo
   asset-free and the payload tiny while beating any hand-made texture at this
   scope.
3. **GPU instancing, LOD, and batching.** Hair strands, fur, cloth trim, and
   backdrop debris as `InstancedMesh` with per-instance transforms in attribute
   buffers. Two or three LOD tiers swapped by camera distance. Materials merged
   so the whole character draws in a handful of calls. Procedural texture bake
   runs once per race/class change, not per frame.
4. **Lighting and post.** A three-point cinematic rig — warm key, cool rim,
   bounce fill — with soft shadows, plus a procedurally generated HDR
   environment for image-based lighting. Post chain: SSAO, threshold bloom,
   subtle chromatic aberration and vignette, ACES tonemapping, and a filmic
   grain. Deterministic and cheap enough to hold 60fps.

## Process

Fan out sub-agents and have each tackle one item individually — one agent per
work item, no agent owning two:

1. Skin shader 2. Hair shader and instanced strands 3. Armor/metal shader and
per-class sets 4. Eye shader 5. Race silhouette and body-morph system
6. Lighting rig and IBL 7. Procedural texture generator 8. Post-processing
chain 9. UI frame and panel art 10. Interaction, animation, and transitions
11. Performance pass (instancing, LOD, batching, draw-call budget)

`/loop` on each item, and assign a separate sub-agent to visually check the
result — it screenshots the running app (Playwright + the preinstalled Chromium)
from a fixed camera set: front 3/4 hero, profile, top-down face crop, extreme
close-up on the current item's surface, and full-screen with UI. That critic
sub-agent is a harsh critic: it scores the rubric below and, if any axis is
under its threshold, sends the work back naming the specific defect and the
image it appears in, and the loop continues. The critic never approves on "it's
improved" — only on "it meets the bar." An item is done when it clears every
axis twice in a row, so a lucky screenshot can't end a loop.

### Rubric (0–5 per axis; every axis must reach 4)

| Axis | 4 means |
|---|---|
| Silhouette readability | Race is identifiable from a pure black cutout at 200px |
| Material believability | Skin, hair, and metal each read as their own material under all three lights, not tinted plastic |
| Lighting shape | Form is described by light — visible key/rim/fill separation, no flat frontal wash |
| Edge quality | No aliasing crawl on rotation, no z-fighting, no visible geometry seams or hard normal breaks |
| UI craft | Frame art, spacing, and type look authored, not default; AA contrast holds |
| Frame time | ≤16.6ms at 1440p on integrated graphics, measured over a 10s orbit |

## Acceptance test

**Primary gate — the rubric.** The build is done when every one of the 11 items
holds 4+ on all six axes simultaneously, verified in a single final pass over
the whole app rather than per-item. This is the stop condition that actually
converges, and it is binding on its own.

**Secondary gate — blind comparison.** Reference screenshots of World of
Warcraft's character creation screen go in `refs/` (gitignored, critic-use only,
never redistributed and never used as source art). The comparison runs under a
fixed protocol:

- The comparing agent is a **fresh sub-agent with no build history** — it is
  handed two images and nothing else, and is never told which is which.
- Left/right order is **randomized per trial**.
- **5 trials**, each on a different camera angle from the fixed set.
- Verdict: **ours is picked or called indistinguishable in ≥3 of 5 trials.**

If `refs/` is empty, this gate is skipped rather than faked — the rubric gate
still governs, and the run reports that the comparison did not execute. Do not
substitute a critic that has merely been *described* the reference and let it
render a side-by-side verdict; that produces a number with nothing behind it.

**Calibration note for whoever runs this:** an asset-free procedural build going
up against a decade of authored art is a genuinely high bar, and the blind gate
may never clear on the close-up and face-crop angles even when the work is
excellent. That is expected and is not a reason to keep looping indefinitely.
The rubric is the bar; the side-by-side is the aspiration. If the rubric holds
at 4+ across the board and the blind gate is still failing after three full
rounds, ship it and report the per-angle results rather than grinding.

## Ground rules

**Style-alike, not asset-alike.** Race names and class colors are functional
references; all art must be original. Nothing requiring WoW's actual models or
textures is in scope — which is also why the technical approach is fully
procedural. Reference screenshots are for critic comparison only and never enter
the build.
