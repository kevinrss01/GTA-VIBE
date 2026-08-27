/**
 * What one person looks like and how they move.
 *
 * Every pedestrian is the same mesh. All of the variety a player actually
 * reads - height, build, clothing, hair, bag, gait, pace - is per-instance
 * data generated here and consumed by the vertex shader in `PedestrianRig`.
 * That is what keeps two hundred distinguishable people inside one draw call.
 *
 * Colours are authored in sRGB hex and packed into a single float per garment
 * (r * 65536 + g * 256 + b, exact in a 24-bit mantissa) so four garments ride
 * in one vec4 attribute. The shader converts to linear itself; doing it here
 * would make the palette unreadable.
 *
 * Nothing in this module touches Three.js or the DOM, and everything is drawn
 * from a seeded `Rng`, so a given seed always produces the same crowd.
 */

import type { Rng } from '../core/rng';

/** Bit flags packed into the shader's `shape` float. */
export const SHAPE_HAT = 1;
export const SHAPE_LONG_HAIR = 2;
export const SHAPE_SKIRT = 4;
export const SHAPE_BAG = 8;
export const SHAPE_SHORT_SLEEVE = 16;

export interface PedestrianLook {
  /** Total height in metres. The rig is authored 1 unit tall and scaled. */
  readonly height: number;
  /** Width/depth multiplier: build, from slight to heavy. */
  readonly girth: number;
  readonly topColor: number;
  readonly bottomColor: number;
  readonly skinColor: number;
  readonly hairColor: number;
  readonly accentColor: number;
  readonly shoeColor: number;
  /** Packed `SHAPE_*` bits. */
  readonly shape: number;
  /** Comfortable walking speed, m/s. */
  readonly preferredSpeed: number;
  /** Full gait cycles per second at the preferred speed. */
  readonly cadence: number;
  /** Arm swing as a fraction of the hip swing. */
  readonly armSwing: number;
  /**
   * Extra pelvic dip and lateral sway, in rig units (1 unit = full height).
   * Small on purpose: the main vertical motion is derived from the leg angle
   * so the feet stay planted, and this only adds personality on top.
   */
  readonly bob: number;
  /** Forward lean of the whole body, radians. */
  readonly lean: number;
  /** Shoulder counter-rotation, radians. */
  readonly shoulderRoll: number;
  /** Preferred side of the pavement: -1 hugs the right, +1 the left. */
  readonly laneBias: number;
  /** How readily this person stops to look at something, 0..1. */
  readonly dwell: number;
}

// Palettes are deliberately small and hand-picked. Random hues produce a crowd
// that reads as noise; a palette with a few loud items among many muted ones
// reads as a street.
const SKIN: readonly number[] = [
  0x8d5524, 0xa9683b, 0xc68642, 0xd9a066, 0xe6b98c, 0xf1c9a5, 0xffdbac, 0x6b4226, 0x4b2e1e,
  0x7a4a2b, 0xba7c4f, 0xefc9a3,
];

const HAIR: readonly number[] = [
  0x110c08, 0x1d1510, 0x2c1e12, 0x3d2a17, 0x54381d, 0x6b4a24, 0x8a6a35, 0xb08d4f, 0xd9c08a,
  0x7d7a76, 0xb4b1ab, 0x5a2f1c, 0x2a2a2e,
];

/** Loud tops: fewer of these, but they are what makes a crowd look alive. */
const TOP_BRIGHT: readonly number[] = [
  0xc4452f, 0xd97b2b, 0xe0b23c, 0x3f7d4e, 0x2f6fa8, 0x7a4a8c, 0xd06a8c, 0xe4e0d5, 0x2aa198,
];

const TOP_MUTED: readonly number[] = [
  0x5b6470, 0x7d7566, 0x3c4450, 0x8a8175, 0x4d564a, 0x6a5b52, 0x9a9287, 0x2f3338, 0xa8a094,
  0x6e7f8d, 0x8c6f5e,
];

const BOTTOM: readonly number[] = [
  0x2f3a4c, 0x3b4152, 0x25272c, 0x5a4f42, 0x6d6455, 0x37455e, 0x4a4a4a, 0x7b6e5b, 0x2b3b30,
  0x8f8778, 0x1f2226,
];

const SHOE: readonly number[] = [0x1a1a1c, 0x2b2118, 0x3a3a3d, 0xe2ded4, 0x5b3a26, 0x24303f];

const ACCENT: readonly number[] = [
  0x8c3b2e, 0x2f4858, 0x6b6f3a, 0x1f1f22, 0xb0672d, 0x3d5a80, 0x7a4a5c, 0xcfc6b4,
];

/** Packs an sRGB hex into one float the shader can unpack exactly. */
export function packColor(hex: number): number {
  return ((hex >> 16) & 255) * 65536 + ((hex >> 8) & 255) * 256 + (hex & 255);
}

/** Averages two hexes so a garment is rarely the exact palette entry. */
function tint(hex: number, rng: Rng): number {
  const shift = rng.range(-0.11, 0.11);
  const channel = (value: number): number => {
    const scaled = Math.round(value * (1 + shift) + (shift > 0 ? 8 * shift : 0));
    return scaled < 0 ? 0 : scaled > 255 ? 255 : scaled;
  };
  return (
    (channel((hex >> 16) & 255) << 16) | (channel((hex >> 8) & 255) << 8) | channel(hex & 255)
  );
}

/**
 * Triangular distribution. Human stature is not uniform, and a crowd generated
 * from a flat range has a conspicuous number of very short and very tall
 * people in it.
 */
function triangular(rng: Rng, min: number, max: number): number {
  return min + ((rng.next() + rng.next()) * 0.5) * (max - min);
}

export function makeLook(rng: Rng): PedestrianLook {
  const tall = triangular(rng, 0, 1);
  const height = 1.54 + tall * 0.38;
  const girth = 0.88 + triangular(rng, 0, 1) * 0.3;

  const bright = rng.chance(0.34);
  const top = tint(rng.pick(bright ? TOP_BRIGHT : TOP_MUTED), rng);
  const bottom = tint(rng.pick(BOTTOM), rng);
  const skin = rng.pick(SKIN);
  const hair = rng.pick(HAIR);
  const accent = tint(rng.pick(ACCENT), rng);
  const shoe = rng.pick(SHOE);

  let shape = 0;
  if (rng.chance(0.16)) shape |= SHAPE_HAT;
  if (rng.chance(0.34)) shape |= SHAPE_LONG_HAIR;
  if (rng.chance(0.22)) shape |= SHAPE_SKIRT;
  if (rng.chance(0.4)) shape |= SHAPE_BAG;
  if (rng.chance(0.45)) shape |= SHAPE_SHORT_SLEEVE;

  // Taller people take longer, slightly slower steps for the same speed.
  const legScale = 0.9 + tall * 0.2;
  const preferredSpeed = rng.range(0.95, 1.62) * (0.94 + tall * 0.12);
  const cadence = rng.range(0.83, 1.02) / legScale;

  return {
    height,
    girth,
    topColor: packColor(top),
    bottomColor: packColor(bottom),
    skinColor: packColor(skin),
    hairColor: packColor(hair),
    accentColor: packColor(accent),
    shoeColor: packColor(shoe),
    shape,
    preferredSpeed,
    cadence,
    armSwing: rng.range(0.42, 1.05),
    bob: rng.range(0.003, 0.009),
    lean: rng.range(0.01, 0.075),
    shoulderRoll: rng.range(0.03, 0.13),
    laneBias: rng.range(-1, 1),
    dwell: rng.next(),
  };
}
