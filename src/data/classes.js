// Class definitions. `armor` drives the per-class set silhouette built in
// character/armor.js; `color` is the canonical class colour and tints the
// metal, the emissive rim, and the faction-neutral UI accents.

export const CLASSES = [
  { name: 'Warrior',      color: '#c79c6e', role: 'Tank / Damage',
    armor: { tier: 'plate',   pauldron: 'spiked',   pauldronScale: 1.35, skirt: 'tasset',  cape: false, trim: 'riveted',  emissive: 0.15 } },
  { name: 'Paladin',      color: '#f58cba', role: 'Tank / Healer / Damage',
    armor: { tier: 'plate',   pauldron: 'winged',   pauldronScale: 1.55, skirt: 'tabard',  cape: true,  trim: 'gilt',      emissive: 0.45 } },
  { name: 'Hunter',       color: '#abd473', role: 'Damage',
    armor: { tier: 'mail',    pauldron: 'fur',      pauldronScale: 1.15, skirt: 'belted',  cape: false, trim: 'leather',   emissive: 0.10 } },
  { name: 'Rogue',        color: '#fff569', role: 'Damage',
    armor: { tier: 'leather', pauldron: 'low',      pauldronScale: 0.85, skirt: 'none',    cape: true,  trim: 'stitched',  emissive: 0.08 } },
  { name: 'Priest',       color: '#ffffff', role: 'Healer / Damage',
    armor: { tier: 'cloth',   pauldron: 'draped',   pauldronScale: 1.05, skirt: 'robe',    cape: false, trim: 'embroidered', emissive: 0.35 } },
  { name: 'Shaman',       color: '#0070de', role: 'Healer / Damage',
    armor: { tier: 'mail',    pauldron: 'totemic',  pauldronScale: 1.40, skirt: 'belted',  cape: false, trim: 'bone',      emissive: 0.40 } },
  { name: 'Mage',         color: '#69ccf0', role: 'Damage',
    armor: { tier: 'cloth',   pauldron: 'floating', pauldronScale: 1.10, skirt: 'robe',    cape: false, trim: 'runic',     emissive: 0.55 } },
  { name: 'Warlock',      color: '#9482c9', role: 'Damage',
    armor: { tier: 'cloth',   pauldron: 'horned',   pauldronScale: 1.25, skirt: 'robe',    cape: true,  trim: 'runic',     emissive: 0.60 } },
  { name: 'Monk',         color: '#00ff96', role: 'Tank / Healer / Damage',
    armor: { tier: 'leather', pauldron: 'wrapped',  pauldronScale: 0.95, skirt: 'sash',    cape: false, trim: 'stitched',  emissive: 0.30 } },
  { name: 'Druid',        color: '#ff7d0a', role: 'Tank / Healer / Damage',
    armor: { tier: 'leather', pauldron: 'antlered', pauldronScale: 1.45, skirt: 'belted',  cape: false, trim: 'bone',      emissive: 0.25 } },
  { name: 'Demon Hunter', color: '#a330c9', role: 'Tank / Damage',
    armor: { tier: 'leather', pauldron: 'bladed',   pauldronScale: 1.30, skirt: 'none',    cape: false, trim: 'stitched',  emissive: 0.70 } },
  { name: 'Death Knight', color: '#c41e3a', role: 'Tank / Damage',
    armor: { tier: 'plate',   pauldron: 'skulled',  pauldronScale: 1.60, skirt: 'tasset',  cape: true,  trim: 'riveted',   emissive: 0.65 } },
  { name: 'Evoker',       color: '#33937f', role: 'Healer / Damage',
    armor: { tier: 'mail',    pauldron: 'scaled',   pauldronScale: 1.20, skirt: 'tabard',  cape: false, trim: 'gilt',      emissive: 0.50 } }
];

// Material response per armor tier, consumed by materials/armor.js.
export const TIER_PROPS = {
  plate:   { metalness: 0.95, roughness: 0.28, wear: 0.55, scaleSize: 0.0,  clothMix: 0.0 },
  mail:    { metalness: 0.85, roughness: 0.40, wear: 0.45, scaleSize: 42.0, clothMix: 0.15 },
  leather: { metalness: 0.15, roughness: 0.66, wear: 0.40, scaleSize: 0.0,  clothMix: 0.55 },
  cloth:   { metalness: 0.05, roughness: 0.82, wear: 0.20, scaleSize: 0.0,  clothMix: 1.0 }
};

export const getClass = (name) => CLASSES.find((c) => c.name === name) ?? CLASSES[0];
