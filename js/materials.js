// Looks for the 3D deck: plinth bodies, record pressings, metal finishes and rooms.

// Absolute URL so it also works when passed through CSS custom properties.
export const asset = (name, ext = 'webp') => new URL(`../assets/${name}.${ext}`, import.meta.url).href;

// body: wood/stone textures use `tex`; lacquers are a plain `color`.
// metal: finish of platter rim, tonearm, knobs and buttons. mat: what the record sits on.
export const MATERIALS = [
  { id: 'walnut', name: 'Dark walnut', note: 'oiled · warm', body: { tex: 'walnut', tint: '#b49c8a', pbr: 'dark_wood', pbrTint: '#8a7264', repeat: .55, roughness: 1, normal: .8, clearcoat: .6, clearcoatRoughness: .22, bump: 1.4 }, metal: 'silver', mat: 'rubber', led: '#ffb45c' },
  { id: 'wenge', name: 'Wenge', note: 'dark · straight grain', body: { tex: 'wenge', tint: '#ffffff', roughness: .62, clearcoat: .4, clearcoatRoughness: .26, bump: 1.2 }, metal: 'silver', mat: 'rubber', led: '#ffb45c' },
  { id: 'smoked-oak', name: 'Smoked oak', note: 'fumed · open pore', body: { tex: 'smoked-oak', tint: '#ffffff', roughness: .82, clearcoat: .18, clearcoatRoughness: .42, bump: 1.6 }, metal: 'gunmetal', mat: 'felt', led: '#ffcf86' },
  { id: 'rosewood', name: 'Rosewood', note: 'rich · figured', body: { tex: 'rosewood', tint: '#9a7a70', pbr: 'rosewood_veneer1', pbrTint: '#e2d2c8', repeat: .6, roughness: 1, normal: .7, clearcoat: .7, clearcoatRoughness: .14, bump: 1.2 }, metal: 'brass', mat: 'felt', led: '#ffa24a' },
  { id: 'oak', name: 'Natural oak', note: 'light · calm', body: { light: true, tex: 'oak', tint: '#ffffff', pbr: 'oak_veneer_01', repeat: .6, roughness: 1, normal: .9, clearcoat: .25, clearcoatRoughness: .4, bump: 1.6 }, metal: 'silver', mat: 'cork', led: '#ffd9a0' },
  { id: 'cream', name: 'Cream lacquer', note: 'satin · soft', body: { light: true, color: '#e6ddcd', roughness: .42, clearcoat: .7, clearcoatRoughness: .18 }, metal: 'brass', mat: 'felt', led: '#ffcf86' },
  { id: 'forest', name: 'Forest lacquer', note: 'deep · glossy', body: { color: '#26332b', roughness: .35, clearcoat: 1, clearcoatRoughness: .08 }, metal: 'brass', mat: 'rubber', led: '#ffcf86' },
  { id: 'black', name: 'Satin black', note: 'quiet · precise', body: { color: '#161616', roughness: .5, clearcoat: .5, clearcoatRoughness: .3 }, metal: 'silver', mat: 'rubber', led: '#ff9a5a' },
  { id: 'aluminum', name: 'Brushed aluminum', note: 'cool · machined', body: { light: true, tex: 'aluminum', tint: '#d9d9db', roughness: .38, metalness: 1, brushed: true }, metal: 'black', mat: 'rubber', led: '#9fd8ff' },
  { id: 'marble', name: 'Nero marble', note: 'stone · polished', body: { tex: 'marble', tint: '#ffffff', roughness: .18, clearcoat: .8, clearcoatRoughness: .06 }, metal: 'brass', mat: 'cork', led: '#ffcf86' },
];

// Record pressings. kind: solid | translucent | marble | splatter | picture | album
export const VINYLS = [
  { id: 'black', name: 'Black', swatch: '#141414', kind: 'solid', color: '#0b0b0c' },
  { id: 'smoke', name: 'Smoke', swatch: '#4a4a52', kind: 'translucent', color: '#2c2c33', opacity: .8 },
  { id: 'oxblood', name: 'Oxblood', swatch: '#6b111b', kind: 'translucent', color: '#4a0910', opacity: .88 },
  { id: 'amber', name: 'Amber', swatch: '#b8721c', kind: 'translucent', color: '#7e3f07', opacity: .74 },
  { id: 'cream', name: 'Cream', swatch: '#e8dfcc', kind: 'solid', color: '#ddd3bf' },
  { id: 'marble', name: 'Marble', swatch: '#5d7f86', kind: 'marble', colors: ['#1f3f48', '#6f9aa1', '#e9e2d3'] },
  { id: 'splatter', name: 'Splatter', swatch: '#d9cdb8', kind: 'splatter', color: '#d9cdb8', colors: ['#1c1c1c', '#b33a2a', '#2c5a78'] },
  { id: 'album', name: 'Album color', swatch: 'conic-gradient(#b8721c, #6b111b, #2c5a78, #b8721c)', kind: 'album', opacity: .86 },
  { id: 'picture', name: 'Picture disc', swatch: 'linear-gradient(135deg, #e0a35a, #6b3a5a)', kind: 'picture' },
];

// Hardware finish: tonearm, headshell, platter rim, knobs and buttons. Chosen apart from the body.
export const METALS = {
  silver: { name: 'Silver', color: '#e9e9ec', roughness: .2 },
  black: { name: 'Black', color: '#2a2a2c', roughness: .32 },
  brass: { name: 'Brass', color: '#d8b06a', roughness: .24 },
  gunmetal: { name: 'Gunmetal', color: '#6a6d72', roughness: .26 },
};

// Room backdrops. tone sets the interface text color over them.
export const ROOMS = [
  { id: 'cream', name: 'Plain', tone: 'light', img: null },
  { id: 'morning', name: 'Morning', tone: 'light', img: 'room-morning' },
  { id: 'japandi', name: 'Japandi', tone: 'light', img: 'room-japandi' },
  { id: 'sunroom', name: 'Sunroom', tone: 'light', img: 'room-sunroom' },
  { id: 'rain', name: 'Rain', tone: 'dark', img: 'room-rain' },
  { id: 'reading', name: 'Reading nook', tone: 'dark', img: 'room-reading' },
  { id: 'listening', name: 'Listening room', tone: 'dark', img: 'room-listening' },
  { id: 'fireplace', name: 'Fireplace', tone: 'dark', img: 'room-fireplace', light: { flicker: 1 } },
  { id: 'city', name: 'City night', tone: 'dark', img: 'room-city' },
];
