# Module contracts

Every module below is owned by exactly one agent. **Do not edit any file you do
not own.** The spine (`src/main.js`, `src/state.js`, `src/character/character.js`,
`src/gfx/renderer.js`, `src/gfx/bakery.js`, `src/gfx/glsl/noise.js`,
`src/data/*.js`) is fixed — read it, build against it, never change it. If a
contract genuinely blocks you, implement the closest thing that satisfies the
signature and note the problem in your final report.

## Environment

- three.js r180, vendored at `vendor/three/`. Import as `'three'` and
  `'three/addons/...'` — an import map in `index.html` resolves both.
- **No build step. No external assets. No network at runtime.** Every texture
  must come from `Bakery` (`src/gfx/bakery.js`) or from a `<canvas>` you draw
  yourself. Do not fetch, do not embed base64 images, do not add dependencies.
- Y-up, metres, character's feet at `y = 0`, facing `+Z`.
- Validate syntax with `node --check <file>` before you finish.

## `Bakery` — the only texture source

```js
bakery.bake(key, fragBody, { width, height, uniforms, wrap, colorSpace, generateMipmaps })
// -> THREE.Texture
```

`fragBody` is GLSL statements assigning `gl_FragColor`. `vUv` is in scope, and
so is the whole noise library from `src/gfx/glsl/noise.js`: `gnoise(vec3)`,
`fbm(p, octaves, lacunarity, gain)`, `ridged(...)`, `worley(p, scale)` returning
`vec3(F1, F2, cellId)`, `fibre(p, dir, stretch, octaves)`, `luminance(vec3)`.
Uniform GLSL types are inferred from the JS values you pass (number → float,
THREE.Vector2/3/4, THREE.Color → vec3, THREE.Texture → sampler2D).

Cache keys must include every parameter that changes the output, e.g.
`` `skin-albedo-${race}-${tone}` ``. Bakes are expensive; never bake per frame.
Colour maps pass `colorSpace: THREE.SRGBColorSpace`; normal/roughness/AO/mask
maps must stay `THREE.NoColorSpace` (the default).

## Material modules — `src/materials/*.js`

```js
export function createSkinMaterial(ctx, params) -> THREE.Material
```

`ctx` is `{ bakery, renderer, envMap }`. Return a real material instance. Attach
these to `material.userData`:

- `update(params)` — cheap per-change path. Must not allocate or recompile.
  Push uniforms and swap cached textures only.
- `tick(t, dt)` — optional per-frame hook for animated uniforms. Keep it trivial.
- `setEnvMap(envMap)` — optional; called when the IBL is (re)generated.

Prefer `MeshPhysicalMaterial` + `onBeforeCompile` over a raw `ShaderMaterial` so
you inherit shadows, IBL, tone mapping and fog for free. Stash your injected
uniforms on an object you close over so `update()` can write them directly.

The four modules and the params they receive from `character.js`:

| Module | `update(params)` |
|---|---|
| `materials/skin.js` | `{ tone: '#rrggbb', race: string, features: {...} }` |
| `materials/hair.js` | `{ color: '#rrggbb', race: string }` |
| `materials/armor.js` | `{ klass, tier: 'plate'\|'mail'\|'leather'\|'cloth', tint: '#rrggbb' }` |
| `materials/eye.js` | `{ color: '#rrggbb' }` |

`materials/armor.js` should read `TIER_PROPS` from `src/data/classes.js` for
metalness / roughness / wear / scaleSize / clothMix.

## `src/character/body.js`

```js
export function buildBodyGeometry(build, features, opts) -> { geometry, joints }
```

`build` and `features` are documented at the top of `src/data/races.js` — read
that file first, it is the spec. `opts` is `{ faceIndex }` (0..5).

Return **one** merged, welded `THREE.BufferGeometry` for the whole body
including head, with correct normals and a sane UV unwrap (islands are fine;
seams must not cut across the face). Feet on `y = 0`, total height exactly
`build.height`.

`joints` is consumed by hair, armor and eyes and must contain:

```js
{
  head:      { position: Vector3, radius: number, up: Vector3, forward: Vector3 },
  neck:      { position, radius },
  shoulders: [{ position, radius, side: -1|1 }, ...],
  hands:     [{ position, radius, side }, ...],
  hips:      { position, radius },
  feet:      [{ position, side }, ...],
  eyes:      [{ position, radius, forward: Vector3, side }, ...],
  scalp:     { position, radius, up, forward },  // where hair attaches
  spine:     [Vector3, ...]                       // base -> neck, for capes
}
```

This is the single highest-impact module: **the rubric's silhouette axis is
tested by rendering a pure black cutout at 200px and asking whether the race is
identifiable.** A Tauren must read as 2.45m of hunched bovine mass; a Gnome as
0.95m and top-heavy; an Undead as gaunt and stooped. Honour `digitigrade`
(reverse-jointed legs), `posture` (upper-spine hunch), `neck`, `snout`, `brow`,
`jaw`, `tusks`, `horns`, `tail`, `ears`, `scales`. Do not build a capsule stack.

Suggested approach: loft rings of vertices along spine/limb curves with
per-race radius profiles, weld into one mesh, then run a light Laplacian smooth
on joint regions. Budget ≤ 40k triangles.

## `src/character/hair.js`

```js
export function buildHairGeometry(race, features, joints, opts) -> THREE.Object3D|null
```

`opts` is `{ styleIndex: 0..7, material }`. Use `THREE.InstancedMesh` of strand
cards (tapered quads/ribbons) laid over the scalp, not a sphere. Eight visibly
distinct styles per race; respect `race.name` for character (Troll mohawk,
Tauren mane, Undead lank). Attach at `joints.scalp`. Use the material passed in.
Budget ≤ 900 instances.

## `src/character/armor.js`

```js
export function buildArmorSet(klass, race, joints, build, opts) -> THREE.Object3D|null
```

`opts` is `{ material, pauldrons: bool, cape: bool }`. Read `klass.armor`
(`tier`, `pauldron`, `pauldronScale`, `skirt`, `cape`, `trim`, `emissive`) from
`src/data/classes.js`. Thirteen sets with genuinely different silhouettes —
Death Knight's skulled pauldrons must not be Rogue's low ones at a different
scale. Fit to `joints`, scale with `build`. Use the material passed in. Budget
≤ 25k triangles.

## `src/gfx/lighting.js`

```js
export function createLighting({ scene, renderer, bakery })
// -> { group, envMap, setMood(faction, klass), setQuality(q), tick(t, dt) }
```

Warm key + cool rim + bounce fill, soft shadows on the key only. `envMap` is a
procedurally generated IBL — bake an equirectangular HDR-ish sky/interior with
the Bakery, then run it through `THREE.PMREMGenerator`. `setMood` retints for
Alliance / Horde / Neutral and pushes a subtle class-coloured accent.

## `src/gfx/post.js`

```js
export function createPostChain({ renderer, scene, camera, bakery })
// -> { composer, render(dt), resize(w, h), setQuality(q) }
```

`EffectComposer` from `three/addons/postprocessing/`. Chain: render → SSAO (or
a cheaper GTAO-ish custom pass) → threshold bloom → a custom pass doing
vignette + subtle chromatic aberration + filmic grain → SMAA → OutputPass.
`render(dt)` must actually draw. `setQuality('performance')` should drop SSAO
and halve bloom resolution. Tone mapping is already set on the renderer — do not
double-apply it.

## `src/gfx/backdrop.js`

```js
export function createBackdrop({ scene, bakery }) -> { setFaction(f), tick(t, dt) }
```

The environment behind the character: a ground plane the character sits on with
a soft contact falloff, plus a distant backdrop. Faction-tinted. Add a little
instanced drifting particulate for depth. Must not out-shout the character —
this is a hero-select backdrop, low contrast, dark, atmospheric.

## `src/ui/panels.js` + `styles.css`

```js
export function buildUI({ store }) -> void
```

Owns `styles.css` and mounts into `#titlebar`, `#rail-left`, `#rail-right`,
`#actionbar` (see `index.html`). Read and write state **only** through
`store.state`, `store.set(patch)`, `store.subscribe(fn)`, `store.resolve()`,
`store.allRaces`, `store.allClasses`.

Controls required: faction filter, race grid, class grid, gender, sliders for
`height` / `bulk` / `headSize` / `shoulders`, face and hairstyle steppers,
skin / hair / eye colour swatches sourced from the race's own palettes
(`race.skinTones`, `race.hairColors`, `race.eyeColors`), toggles for horns /
pauldrons / cape, a quality selector, Randomize, and an "Enter World" button.

Frame art must be procedurally drawn (canvas2D → data URL is fine here) —
beveled gilt borders, parchment grain, glyph dividers, faction-tinted per
`FACTIONS` in `src/data/races.js`. No flat CSS rectangles. Hover and focus
states throughout, full keyboard operability, WCAG AA contrast on all text.
Sliders must update state on `input`, not `change`.
