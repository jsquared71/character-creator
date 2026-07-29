# Critic loop status

Recorded at commit `0edc78a`. Renders referenced are in `shots/final/`
(regenerate with `node tools/shoot.mjs --out shots/final --views hero,face,profile`).

## Where the build stands

The app boots and renders with **zero console errors**, 48 draw calls and
~192k triangles per frame. All 14 races, 13 classes, both rails, every slider
and the quality tiers work. Three rounds of the critic loop ran; round 3 was
cut short by an account spend limit that terminated all four agents mid-edit,
so it is **partially landed** (see below).

## Rubric — honest scores

Scored against `docs/AAA_PROMPT.md`. The bar is 4/5 on every axis.

| Axis | Score | Notes |
|---|---|---|
| Silhouette readability | **4** | Races read distinctly. Orc 2.09m hunched and heavy, Gnome stocky and top-heavy, Undead gaunt. Verified by render, not by cutout — the automated 200px cutout test is written but unrun. |
| Lighting shape | **4** | Warm key / cool rim / bounce fill all legible; shadow-side cheek saturation 0.539 after the rim rework, silhouette separation held at 4.4–7.2:1. |
| UI craft | **4** | Procedurally drawn gilt frames with real bevels, 14 data-driven race portraits, 13 class sigils, full keyboard operability, AA contrast verified against a blown-out backdrop. |
| Material believability | **3** | Skin and plate now read correctly. **Hair does not.** Eyes do not. |
| Edge quality | **3** | Banding, faceting and blowout are fixed. Hard-edged hair cards remain on the fringe. |
| Frame time | **not measured** | Headless here is SwiftShader; wall-clock frame time is meaningless. Draw calls (48) and triangles (192k) are the proxies actually being tracked. Needs a real GPU to score. |

**Verdict: does not meet the bar.** Two axes short, one unmeasurable in this
environment.

## Open defects, highest impact first

1. **Eyes read as flat dark beads.** None of the eye shader's parallax iris,
   limbal ring or corneal catchlight is visible in the render. The round-3
   agent got as far as adding diagnostic uniforms before being cut off; that
   scaffolding was reverted. Suspected cause: the lighting rig changed under
   it — the rim is now a SpotLight at theta ~147deg and the accent moved to
   ~2.3m at under a third of the key, so a glint depending on either may no
   longer fire. A hero-select eye probably needs a guaranteed catchlight
   rather than one that depends on rig geometry.
2. **Hard dark planks across the forehead.** The hair mass itself is much
   improved (fine strands, soft silhouette), but several fringe cards render
   as opaque slabs. Confirmed *not* the minification fill — setting it to 0
   leaves them. Not the cap layer either; `acceptRoot`'s margin is already
   stricter for the cap. Likely the card map's alpha not breaking up on
   near-face-on fringe cards.
3. **Trim aliasing is mitigated, not fixed at source.** `character/armor.js`
   round 2 rewrote patterns so features are >= 2 grid cells wide, but the
   material still carries a raised acceptance window from round 1 as a belt
   and braces. Worth removing once the geometry side is trusted.
4. **Armor lost its class tint** when plate was corrected to read as metal.
   Warrior now reads as bright steel rather than tan steel. Arguably better,
   but it is a regression against the data in `classes.js`.
5. **Head still slightly small at hero framing.** The round-3 body agent was
   mid-change on this when terminated; the landed diff improved face
   proportions but the head-to-height ratio was not finished.

## The blind comparison gate

**Not run.** `refs/` is empty, and per the brief the gate is skipped and
reported rather than faked. Supply reference screenshots locally to enable it.

## Notes for whoever picks this up

- `node tools/check.mjs` before anything else. Plain `node --check` parses as
  CommonJS and has silently accepted three separate broken files this session
  — every one a backtick inside a GLSL template literal.
- `node tools/shoot.mjs --out shots/x --views hero,face` is the loop's eye. It
  waits for texture bakes to settle and exits non-zero on any page error.
- Agents must be told to *render and look*, not to reason about GLSL. Every
  significant defect this session was diagnosed from a screenshot, and several
  were the opposite of what the code suggested.
