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
from a fixed set of camera angles and inspects the images. That critic sub-agent
should be a harsh critic: it scores against an explicit rubric (silhouette
readability, material believability, lighting shape, edge quality, UI craft,
frame time) and if any axis is below the bar it sends the work back with
specific defects named, and the loop continues. The critic never approves on
"it's improved" — only on "it meets the bar."

**Acceptance test:** the critic compares the output side by side, blind, against
reference screenshots of **World of Warcraft's character creation screen** — the
two images presented unlabeled, in randomized order, to a critic agent that
hasn't seen the build history — and states which looks better. Don't stop until
the critic picks ours, or genuinely can't tell.

---

## Notes on the brief

Three things worth deciding before this runs, flagged rather than silently
resolved:

- **The acceptance test needs a source of reference images.** A blind comparison
  requires WoW screenshots on disk to compare against. Either supply them
  locally for critic-only use, or relax the test to a rubric score from a critic
  that has been *described* the reference rather than shown it.
- **"Blind" is doing real work here.** For it to mean anything, the comparing
  agent must be a fresh context with no knowledge of which image is the build —
  otherwise it will flatter the work. Randomize image order per trial and
  require a best-of-N verdict.
- **Style-alike, not asset-alike.** Race names and class colors are functional
  references; the art must be original. Anything that would require WoW's actual
  models or textures is out of scope by construction, which is also why the
  technical approach is fully procedural.
