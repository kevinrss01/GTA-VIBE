/**
 * What a shot looks like: muzzle flash, tracer, impact spark, scorch mark.
 *
 * NO LIGHTS OF ANY KIND. Profiling this project put point lights at 61 per cent
 * of the frame, so a muzzle flash here is emissive geometry - an additively
 * blended, unlit quad that glows but illuminates nothing - exactly as the
 * headlamps, brake lamps and shop signs already are. A gunshot in a dark alley
 * therefore does not light the alley. That is the deliberate trade, and it is
 * the same one every other light source in Meridian Bay makes.
 *
 * BUDGET. Three `InstancedMesh`es for the whole combat layer, and all three are
 * hidden when nothing is alive, so a player who never fires pays nothing:
 *
 *   glow    one additive unit quad, reused as flash, tracer, spark and fire
 *   marks   one unlit quad laid ON the surface that was hit, textured from a
 *           four-tile decal atlas so a hole, a chip, a star and a scorch are
 *           four different pictures out of one draw call
 *   smoke   one soft dark quad that rises, spreads and fades. Additive
 *           blending cannot draw anything DARKER than what is behind it, so
 *           smoke cannot come out of the glow pool however convenient that
 *           would be, and an explosion without it is all flash and no weight.
 *
 * Everything is pooled with a fixed capacity and the oldest entry is recycled,
 * so sustained automatic fire cannot grow the pool or allocate per frame.
 *
 * PER-INSTANCE DECAL DATA. `InstancedMesh` gives every instance a matrix and a
 * colour and nothing else, and a decal needs two more things: WHICH tile of
 * the atlas it is, and how faded it is. Both ride in one instanced vec3 and a
 * four-line `onBeforeCompile` injection, exactly as the pedestrian rig already
 * carries its animation cursor - see `PedestrianRig`. Fading in the alpha
 * rather than by shrinking the quad matters: a bullet hole that gets smaller
 * as it ages reads as the wall healing.
 */

import {
  AdditiveBlending,
  Color,
  DataTexture,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Group,
  LinearFilter,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  RGBAFormat,
  Vector3,
  type Object3D as Object3DType,
} from 'three';

import type { MaterialKey } from '../render/materials';

/**
 * Bright bits alive at once: flashes, tracers, sparks and blast debris.
 *
 * Sized by the worst case rather than the common one. A rocket detonation
 * spends about 50 of these in a single frame, and a burst of automatic fire
 * into a wall another 40; the pool has to hold both at once or a blast in a
 * firefight silently deletes the firefight's sparks.
 */
const GLOW_CAPACITY = 208;
/** Bullet holes, chips, blood and blast scorches kept on the world. */
const MARK_CAPACITY = 96;
/**
 * Smoke puffs alive at once.
 *
 * One detonation spends twelve, so this holds four overlapping explosions
 * before the oldest puff of the oldest one is recycled - which is the point at
 * which nobody can tell anyway, because the screen is already full of smoke.
 */
const SMOKE_CAPACITY = 56;

const FLASH_LIFE = 0.055;
const TRACER_LIFE = 0.05;
const SPARK_LIFE = 0.32;
/**
 * How long a bullet's mark lasts. Blood and blast scorches set their own.
 *
 * Long enough to walk back and find the wall you shot, which is the whole
 * reason a mark exists; short enough that `MARK_CAPACITY` is a ceiling on
 * memory rather than a queue that recycles while the player is still looking
 * at the first hole.
 */
const MARK_LIFE = 18;
/** Fraction of a mark's life spent fading out. */
const MARK_FADE = 0.22;

const SPARK_GRAVITY = -14;

/**
 * A radial falloff, generated rather than downloaded.
 *
 * Without it every effect is a flat card with four corners, and a muzzle flash
 * half a metre from the eye reads as a white rectangle stuck to the screen
 * rather than as light. 64x64 of generated alpha costs 16 KB, no request and
 * no decode, and one texture serves the flash, the tracer, the sparks and the
 * scorch marks.
 */
function createFalloffTexture(): DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = ((x + 0.5) / size) * 2 - 1;
      const dy = ((y + 0.5) / size) * 2 - 1;
      const r = Math.min(1, Math.hypot(dx, dy));
      // Smoothstep on the remaining radius: a soft core with no visible edge.
      const t = 1 - r;
      const alpha = t * t * (3 - 2 * t);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(255 * alpha);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The four pictures a surface mark can be.
 *
 * Not one per material: four is what a player can actually tell apart at the
 * range they see a wall from, and every extra tile is another 16 KB of atlas
 * for a difference nobody reads. The MATERIAL still shows through, in the
 * tint and the size - a pale chip in ashlar and a dark hole in a door are the
 * same two tiles a shot into a hangar door and a shot into a kerb use.
 */
export type DecalKind = 'hole' | 'chip' | 'star' | 'scorch';

/** Tiles across and down the atlas. Two by two; four tiles. */
const ATLAS_TILES = 2;
/** Pixels per tile. 64 x 64 each, so the whole atlas is 128 x 128 x RGBA. */
const ATLAS_TILE_PX = 64;
/** UV scale one tile occupies. Baked into the injected shader, not a uniform. */
const ATLAS_SCALE = 1 / ATLAS_TILES;

/** Bottom-left UV of each tile. Order fixes the atlas layout for ever. */
const DECAL_UV: Readonly<Record<DecalKind, readonly [number, number]>> = {
  hole: [0, 0],
  chip: [ATLAS_SCALE, 0],
  star: [0, ATLAS_SCALE],
  scorch: [ATLAS_SCALE, ATLAS_SCALE],
};

/**
 * Deterministic value noise in [0, 1).
 *
 * Not `Math.random`: the atlas is generated once at construction and has to be
 * byte-identical between runs, or a test that asserts what a decal looks like
 * is asserting the weather.
 */
function noise(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smoothstep between two edges, clamped. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * The decal atlas: four marks in one 128 x 128 texture, generated rather than
 * downloaded.
 *
 * ALPHA IS THE SHAPE AND RGB IS THE RELIEF. The mark material multiplies this
 * texture by the per-instance tint, so a tile whose rim is dark and whose
 * floor is bright renders, under a pale grey tint, as a chip with a shadowed
 * edge and a fresh face - two tones out of one instance colour. Painting the
 * tones into the tint instead would need two decals per hit.
 *
 * Each tile keeps a transparent margin so bilinear filtering at the tile
 * boundary cannot bleed one mark into the next.
 */
function createDecalAtlas(): DataTexture {
  const size = ATLAS_TILE_PX * ATLAS_TILES;
  const data = new Uint8Array(size * size * 4);
  const write = (
    tile: DecalKind,
    shade: (u: number, v: number) => readonly [number, number],
  ): void => {
    const uv = DECAL_UV[tile];
    const ox = Math.round(uv[0] * size);
    const oy = Math.round(uv[1] * size);
    for (let ty = 0; ty < ATLAS_TILE_PX; ty += 1) {
      for (let tx = 0; tx < ATLAS_TILE_PX; tx += 1) {
        const u = ((tx + 0.5) / ATLAS_TILE_PX) * 2 - 1;
        const v = ((ty + 0.5) / ATLAS_TILE_PX) * 2 - 1;
        const [luma, alpha] = shade(u, v);
        // Two-pixel transparent margin: bilinear sampling at the seam reaches
        // one texel into the neighbour, and a hole bleeding into a scorch is
        // the classic atlas artefact.
        const edge = Math.min(tx, ty, ATLAS_TILE_PX - 1 - tx, ATLAS_TILE_PX - 1 - ty);
        const keep = edge < 2 ? 0 : 1;
        const i = ((oy + ty) * size + (ox + tx)) * 4;
        const level = Math.round(255 * Math.min(1, Math.max(0, luma)));
        data[i] = level;
        data[i + 1] = level;
        data[i + 2] = level;
        data[i + 3] = Math.round(255 * Math.min(1, Math.max(0, alpha)) * keep);
      }
    }
  };

  // A bullet pit: a black core, a ring of fresh material thrown out around it,
  // and a wide dust halo that is most of what is visible from ten metres.
  write('hole', (u, v) => {
    const r = Math.hypot(u, v);
    const angle = Math.atan2(v, u);
    const wobble = 0.86 + 0.28 * noise(Math.cos(angle) * 4, Math.sin(angle) * 4);
    const core = 0.2 * wobble;
    const rim = 0.42 * wobble;
    if (r <= core) return [0.05, 1];
    if (r <= rim) return [0.62, 1 - smoothstep(core, rim, r) * 0.35];
    const halo = 1 - smoothstep(rim, 1, r);
    return [0.9, halo * 0.42];
  });

  // Spalled stone or render: an irregular lobed crater with a shadowed edge
  // and a bright floor, plus grit around it.
  write('chip', (u, v) => {
    const r = Math.hypot(u, v);
    const angle = Math.atan2(v, u);
    const lobes =
      0.5 +
      0.2 * noise(Math.cos(angle) * 3, Math.sin(angle) * 3) +
      0.08 * noise(Math.cos(angle) * 11, Math.sin(angle) * 11);
    const mottle = 0.82 + 0.24 * noise(u * 9, v * 9);
    if (r <= lobes * 0.72) return [0.95 * mottle, 0.94];
    if (r <= lobes) return [0.22, 0.96 - smoothstep(lobes * 0.72, lobes, r) * 0.2];
    const dust = 1 - smoothstep(lobes, 1, r);
    return [0.85, dust * dust * 0.4];
  });

  // A dent in steel or a star crack in glazing: a struck centre with cracks
  // running out of it. Seven arms, because six reads as a snowflake.
  write('star', (u, v) => {
    const r = Math.hypot(u, v);
    if (r >= 1) return [0, 0];
    const angle = Math.atan2(v, u);
    const arms = Math.abs(Math.cos(angle * 3.5 + noise(1, 2) * 6.28));
    const spoke = Math.pow(arms, 26) * (1 - smoothstep(0.1, 0.92, r));
    const core = 1 - smoothstep(0, 0.16, r);
    const halo = (1 - smoothstep(0.1, 1, r)) * 0.16;
    const alpha = Math.min(1, core + spoke * 0.95 + halo);
    // The cracks are bright - light catches a fresh fracture - and the struck
    // centre is dark, which is the whole read of a dent.
    return [core > 0.5 ? 0.18 : 0.92, alpha];
  });

  // Soot, and the same tile for a blood pool: a soft lobed blot with no edge.
  write('scorch', (u, v) => {
    const r = Math.hypot(u, v);
    const angle = Math.atan2(v, u);
    const edge = 0.72 + 0.26 * noise(Math.cos(angle) * 2.5 + 7, Math.sin(angle) * 2.5 + 7);
    const mottle = 0.7 + 0.5 * noise(u * 4.5 + 3, v * 4.5 + 3);
    const body = 1 - smoothstep(edge * 0.35, edge, r);
    return [0.4 * mottle, body * 0.92];
  });

  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  // Mipmaps would average the four tiles into each other at distance, which is
  // exactly the bleeding the margin exists to prevent.
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Injects per-instance atlas tile and alpha into an unlit material.
 *
 * `iDecal` is `(tileU, tileV, alpha)`. The vertex half slides the mapped UV
 * into the instance's tile; the fragment half multiplies the alpha in after
 * the map has been sampled, so a mark fades out instead of shrinking away.
 *
 * `tileScale` is baked in as a literal rather than passed as a uniform: it is
 * a property of the texture the material was built with and can never change
 * at runtime, and a uniform would be one more thing to keep in step.
 */
function patchInstanceDecal(
  material: MeshBasicMaterial,
  tileScale: number,
  cacheKey: string,
): void {
  const scale = tileScale.toFixed(6);
  material.onBeforeCompile = (shader): void => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec3 iDecal;\nvarying vec3 vDecal;',
      )
      // AFTER `uv_vertex`, which is where `vMapUv` is written.
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>\nvDecal = iDecal;\nvMapUv = vMapUv * ${scale} + iDecal.xy;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDecal;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vDecal.z;');
  };
  material.customProgramCacheKey = (): string => cacheKey;
}

/**
 * How far off the surface a mark of a given size floats, in metres.
 *
 * NON-ZERO ALWAYS, and that is the whole job: a decal exactly on the plane it
 * describes z-fights with it, and the fight is worse the further away the
 * camera is because the depth buffer is less precise there. Scaled a little
 * with the mark so a nine-metre blast scorch on a road clears the road's own
 * geometry, and capped so nothing visibly hovers.
 *
 * `polygonOffset` on the material does the same job in depth space and is what
 * covers a mark seen from a grazing angle, where a fixed lift along the normal
 * barely separates anything. Both, because neither alone is enough.
 */
export function markLift(size: number): number {
  return Math.min(0.05, 0.006 + Math.max(0, size) * 0.012);
}

/**
 * Where a detonation's scorch belongs: the surface it went off against.
 *
 * Comes out of the SAME hit result that decided the blast's damage, which is
 * the point - the mark, the sparks, the sound and the impulse all describe one
 * event and must not each guess separately at where it happened.
 */
export interface ScorchPlacement {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Outward unit normal of the surface. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/**
 * What a round arrived on, as far as anything visible is concerned.
 *
 * `world` is the UNKNOWN bucket and stays the default. Most builders do not set
 * `ColliderBox.surface` yet, and a box with no surface has to keep looking
 * exactly as it did before this existed - see `surfaceImpact`.
 */
export type ImpactKind =
  | 'world'
  | 'stone'
  | 'concrete'
  | 'metal'
  | 'glass'
  | 'timber'
  | 'foliage'
  | 'body';

/**
 * The vocabulary the audio layer already speaks, which is NOT this one.
 *
 * `src/audio/manifest.ts` ships seven impact samples and belongs to another
 * workstream; adding four visual materials must not oblige it to record four
 * more. `impactSound` collapses the visual set onto the recorded set, and it
 * gains rather than loses: `ground` and `debris` were both in the manifest and
 * neither was ever emitted, because everything that was not metal, glass or a
 * body arrived as one flat `world`.
 */
export type ImpactSound = 'world' | 'ground' | 'metal' | 'glass' | 'body' | 'debris';

/** Which recorded sample a visual impact asks for. */
export function impactSound(kind: ImpactKind, onGround = false): ImpactSound {
  if (kind === 'body') return 'body';
  if (kind === 'metal') return 'metal';
  if (kind === 'glass') return 'glass';
  // Splintered timber and torn leaves are a scatter of small pieces, which is
  // what the debris sample is; stone and concrete are the dull hard slap the
  // `world` sample already carries.
  if (kind === 'timber' || kind === 'foliage') return 'debris';
  return onGround ? 'ground' : 'world';
}

/**
 * What a building material is, as far as a bullet is concerned.
 *
 * Deliberately exhaustive over `MaterialKey` rather than a lookup with a
 * default: a new material added to the render library should make this fail to
 * compile and be classified deliberately, not silently become pale stone dust.
 * An ABSENT surface is a different thing entirely and stays `world`, because
 * most builders do not set one and their impacts must not change.
 */
const SURFACE_IMPACT: Readonly<Record<MaterialKey, ImpactKind>> = {
  // Ground and paving: hard, dusty, pale.
  asphalt: 'stone',
  asphaltWorn: 'stone',
  roadPaint: 'stone',
  roadPaintYellow: 'stone',
  kerb: 'stone',
  pavement: 'stone',
  pavementDark: 'stone',
  plazaStone: 'stone',
  gravel: 'stone',
  stoneAshlar: 'stone',
  sand: 'stone',
  sandWet: 'stone',
  grass: 'foliage',
  water: 'stone',
  boardwalk: 'timber',
  // Walls: rendered, cast or fired, all of which throw grey grit.
  stuccoCream: 'concrete',
  stuccoPeach: 'concrete',
  stuccoMint: 'concrete',
  stuccoRose: 'concrete',
  stuccoSand: 'concrete',
  stuccoBlue: 'concrete',
  concrete: 'concrete',
  concreteBoard: 'concrete',
  brickRed: 'concrete',
  brickBuff: 'concrete',
  skyline: 'concrete',
  tileFloor: 'concrete',
  roofTile: 'concrete',
  roofTar: 'concrete',
  // Openings.
  glass: 'glass',
  glassDark: 'glass',
  glassShop: 'glass',
  lampGlass: 'glass',
  signalLens: 'glass',
  signEmissive: 'glass',
  signEmissiveWarm: 'glass',
  windowFrame: 'metal',
  shutter: 'metal',
  doorPainted: 'timber',
  // Metalwork.
  paintedMetal: 'metal',
  corrugated: 'metal',
  metalDark: 'metal',
  metalLight: 'metal',
  rust: 'metal',
  signalHousing: 'metal',
  // Timber and the one fabric in the library, which behaves like it: no spark,
  // no ring, a few dull fragments.
  timber: 'timber',
  timberDark: 'timber',
  canvasAwning: 'timber',
  // Planting.
  foliage: 'foliage',
  foliageDark: 'foliage',
  palmFrond: 'foliage',
  barkPalm: 'timber',
  barkTree: 'timber',
};

/** The impact a collider's declared surface produces, or the old default. */
export function surfaceImpact(surface: MaterialKey | undefined): ImpactKind {
  return surface === undefined ? 'world' : SURFACE_IMPACT[surface];
}

interface Glow {
  alive: boolean;
  life: number;
  maxLife: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Half-extents of the quad before the life curve is applied. */
  width: number;
  height: number;
  /** Set for a tracer, which must lie along the shot rather than face us. */
  aimed: boolean;
  ax: number;
  ay: number;
  az: number;
  r: number;
  g: number;
  b: number;
  /**
   * Extra half-extent added per second of life.
   *
   * Zero for a spark, which is a fixed-size ember thrown through the air, and
   * several metres a second for a fireball or a shockwave, which are volumes
   * of expanding gas and have to grow or they read as a sticker.
   */
  growth: number;
  /** Metres per second squared of fall. Embers fall; hot gas rises. */
  gravity: number;
  /** Per-second velocity decay, so blast debris slows in the air. */
  drag: number;
}

interface Mark {
  alive: boolean;
  life: number;
  /** Seconds this mark lasts. A bullet scuff and a blast scorch differ. */
  maxLife: number;
  x: number;
  y: number;
  z: number;
  /**
   * Unit surface normal. The mark's plane is built from it, so a decal on a
   * wall stands up and a decal on a road lies down without either being a
   * special case.
   */
  nx: number;
  ny: number;
  nz: number;
  /**
   * Spin about that normal, in radians.
   *
   * A decal atlas has four pictures in it and a street can take fifty rounds.
   * Without a random roll the fiftieth hole is the forty-ninth hole rotated by
   * nothing, and a wall of identical marks reads as wallpaper.
   */
  roll: number;
  /** Half-extent in metres. The quad is drawn at twice this across. */
  size: number;
  /** Opacity at full life, before the fade-out. */
  alpha: number;
  /** Bottom-left UV of this mark's atlas tile. */
  tileU: number;
  tileV: number;
  r: number;
  g: number;
  b: number;
}

/**
 * A puff of smoke.
 *
 * Normal-blended and dark, which is why it cannot share the additive glow
 * pool. It rises, spreads, slows in the air and fades to nothing, and it is
 * the only thing an explosion leaves behind that a player can still see two
 * seconds later.
 */
interface Smoke {
  alive: boolean;
  life: number;
  maxLife: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
  /** Metres of half-extent added per second, as the cloud expands. */
  growth: number;
  /** Per-second velocity decay. */
  drag: number;
  /** Rise, in m/s². Positive: hot smoke goes up. */
  lift: number;
  roll: number;
  spin: number;
  alpha: number;
  r: number;
  g: number;
  b: number;
}

/**
 * Everything one material does when a round arrives on it.
 *
 * One table rather than three parallel ones, because the interesting part is
 * the CONTRAST between materials and that is only readable when a material's
 * numbers sit on one line. Struck steel throws few, fast, hot sparks that fall;
 * struck concrete throws a lot of slow grey grit; glazing throws pale chips
 * that catch the light; a leaf canopy throws slow green fragments that barely
 * fall at all.
 *
 * `debris` is the ember count, `speed` its launch speed in m/s, `size` its half
 * extent in metres, `gravity` its fall in m/s² (an ember falls, a dust cloud
 * hangs), `drag` its per-second velocity decay, and `mark` the scorch left
 * behind. Nothing here adds a pool, a mesh or a capacity: every one of these is
 * the same instanced quad the muzzle flash already uses.
 */
interface ImpactStyle {
  readonly spark: readonly [number, number, number];
  readonly mark: readonly [number, number, number];
  readonly debris: number;
  readonly speed: number;
  readonly size: number;
  readonly gravity: number;
  readonly drag: number;
  readonly markSize: number;
  /** Which atlas tile the mark is drawn from. */
  readonly decal: DecalKind;
  /**
   * Opacity of the mark at full life, on top of the material's own.
   *
   * A hole in a wall is opaque and a torn leaf leaves almost nothing; without
   * this every material would mark the world equally hard and the difference
   * between shooting a shopfront and shooting a hedge would be a hue.
   */
  readonly markAlpha: number;
}

const IMPACT_STYLE: Readonly<Record<ImpactKind, ImpactStyle>> = {
  // The unknown bucket, and the numbers every surface used to get.
  world: {
    spark: [0.72, 0.68, 0.6], mark: [0.13, 0.13, 0.14],
    debris: 4, speed: 1.8, size: 0.045, gravity: SPARK_GRAVITY, drag: 0,
    markSize: 0.07, decal: 'hole', markAlpha: 0.85,
  },
  // Paving and ashlar: a hard crack and a puff of pale dust that hangs. The
  // TINT is pale because the tile's floor is the bright half of the picture -
  // a chip in stone exposes fresh stone, ringed by its own shadow.
  stone: {
    spark: [0.78, 0.74, 0.66], mark: [0.6, 0.58, 0.53],
    debris: 6, speed: 1.5, size: 0.06, gravity: -6, drag: 3.2,
    markSize: 0.075, decal: 'chip', markAlpha: 0.8,
  },
  // Render, brick and cast concrete: greyer, more of it, and slower still.
  concrete: {
    spark: [0.66, 0.64, 0.6], mark: [0.53, 0.52, 0.51],
    debris: 7, speed: 1.3, size: 0.07, gravity: -5, drag: 3.6,
    markSize: 0.08, decal: 'chip', markAlpha: 0.82,
  },
  // Steel takes a dent with a bright fresh scar through it, not a hole.
  metal: {
    spark: [1, 0.62, 0.22], mark: [0.44, 0.42, 0.4],
    debris: 5, speed: 2.6, size: 0.04, gravity: SPARK_GRAVITY, drag: 0,
    markSize: 0.06, decal: 'star', markAlpha: 0.72,
  },
  // Glazing stars around the hole rather than chipping.
  glass: {
    spark: [0.78, 0.86, 0.9], mark: [0.74, 0.8, 0.84],
    debris: 8, speed: 2.4, size: 0.035, gravity: SPARK_GRAVITY, drag: 0.4,
    markSize: 0.065, decal: 'star', markAlpha: 0.62,
  },
  // Splinters: light, thrown well, and stopped quickly by the air.
  timber: {
    spark: [0.46, 0.33, 0.19], mark: [0.17, 0.11, 0.06],
    debris: 5, speed: 2, size: 0.05, gravity: -10, drag: 2.2,
    markSize: 0.07, decal: 'hole', markAlpha: 0.86,
  },
  // Torn leaves. Almost no fall, a lot of drag, and barely a mark at all -
  // a round through a canopy leaves the canopy looking much the same.
  foliage: {
    spark: [0.3, 0.44, 0.18], mark: [0.19, 0.25, 0.1],
    debris: 7, speed: 1.6, size: 0.055, gravity: -3, drag: 3.4,
    markSize: 0.05, decal: 'chip', markAlpha: 0.3,
  },
  /*
   * A HIT ON A PERSON IS THE SMALLEST EFFECT IN THIS TABLE, NOT THE BIGGEST.
   *
   * It used to be the biggest: nine fast dark-red embers with no drag, thrown
   * at up to 5 m/s and pulled down at 14 m/s², plus a blood pool up to 0.6 m
   * across - PER PELLET. One shotgun shell put seventy-two of those and eight
   * overlapping pools on one civilian in a single frame, which is not a bullet
   * wound, it is a detonation, and that is exactly what it was reported as.
   *
   * Three fine, slow, dark specks that the air stops almost at once is what a
   * round arriving on a body actually looks like from ten metres away, and the
   * READ - "that hit, and it hit a person" - is carried by the colour and by
   * the mark on the pavement rather than by the count. `CombatSystem` also
   * spends this ONCE per victim per trigger pull, so a shotgun is one wound
   * cluster rather than eight.
   */
  body: {
    spark: [0.26, 0.05, 0.05], mark: [0.34, 0.055, 0.05],
    debris: 3, speed: 1.1, size: 0.03, gravity: SPARK_GRAVITY, drag: 2.4,
    markSize: 0.1, decal: 'scorch', markAlpha: 0.9,
  },
};

/** Which atlas tile a material's mark is drawn from. Exported for tests. */
export function decalFor(kind: ImpactKind): DecalKind {
  return IMPACT_STYLE[kind].decal;
}

/** Half-extent, in metres, of the mark a material leaves. Exported for tests. */
export function markSizeFor(kind: ImpactKind): number {
  return IMPACT_STYLE[kind].markSize;
}

/**
 * Glow slots one impact of a given kind spends.
 *
 * Exported so the budget can be ASSERTED rather than described: a test can
 * pin "a round on a person costs three glows" without reaching into the table.
 */
export function impactBudget(kind: ImpactKind): number {
  return IMPACT_STYLE[kind].debris;
}

/** Pool ceilings, exported for the same reason. */
export const FX_CAPACITY = {
  glows: GLOW_CAPACITY,
  marks: MARK_CAPACITY,
  smoke: SMOKE_CAPACITY,
} as const;

/** Seconds a blood pool stays on the ground. Far longer than a bullet scuff. */
const BLOOD_LIFE = 26;
/** Seconds a blast scorch stays. Longer still: it is the size of a car. */
const CRATER_LIFE = 40;
/** Smoke puffs one detonation spends, and how they are split. */
const SMOKE_COLUMN = 8;
const SMOKE_GROUND = 4;

export class CombatFx {
  /** Add this to the scene. It owns two meshes and nothing else. */
  readonly group: Object3DType;

  private readonly glowMesh: InstancedMesh;
  private readonly markMesh: InstancedMesh;
  private readonly smokeMesh: InstancedMesh;
  private readonly markDecal: InstancedBufferAttribute;
  private readonly smokeDecal: InstancedBufferAttribute;
  private readonly glows: Glow[] = [];
  private readonly marks: Mark[] = [];
  private readonly puffs: Smoke[] = [];
  private glowCursor = 0;
  private markCursor = 0;
  private smokeCursor = 0;

  private readonly dummy = new Object3D();
  private readonly colour = new Color();
  private readonly scratch = new Vector3();
  private readonly axisX = new Vector3();
  private readonly axisY = new Vector3();
  private readonly axisZ = new Vector3();
  private readonly basis = new Matrix4();
  private disposed = false;

  private readonly falloff = createFalloffTexture();
  private readonly atlas = createDecalAtlas();

  constructor() {
    const glowGeometry = new PlaneGeometry(1, 1);
    const glowMaterial = new MeshBasicMaterial({
      color: 0xffffff,
      map: this.falloff,
      transparent: true,
      opacity: 0.95,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    glowMaterial.name = 'combat-glow';
    this.glowMesh = new InstancedMesh(glowGeometry, glowMaterial, GLOW_CAPACITY);
    this.glowMesh.name = 'combat-glow';
    this.glowMesh.frustumCulled = false;
    this.glowMesh.renderOrder = 6;
    this.glowMesh.count = 0;
    this.glowMesh.visible = false;

    const markGeometry = new PlaneGeometry(1, 1);
    this.markDecal = new InstancedBufferAttribute(new Float32Array(MARK_CAPACITY * 3), 3);
    this.markDecal.setUsage(DynamicDrawUsage);
    markGeometry.setAttribute('iDecal', this.markDecal);
    const markMaterial = new MeshBasicMaterial({
      color: 0xffffff,
      map: this.atlas,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      toneMapped: false,
      // The lift along the normal separates a mark from its surface in space;
      // this separates it in DEPTH, which is what saves a decal seen almost
      // edge-on, where the lift projects to nearly nothing.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    markMaterial.name = 'combat-mark';
    patchInstanceDecal(markMaterial, ATLAS_SCALE, 'meridian-combat-decal-v1');
    this.markMesh = new InstancedMesh(markGeometry, markMaterial, MARK_CAPACITY);
    this.markMesh.name = 'combat-marks';
    this.markMesh.frustumCulled = false;
    // Marks are on surfaces and smoke is in the air, so marks are drawn first.
    this.markMesh.renderOrder = 5;
    this.markMesh.count = 0;
    this.markMesh.visible = false;

    const smokeGeometry = new PlaneGeometry(1, 1);
    this.smokeDecal = new InstancedBufferAttribute(new Float32Array(SMOKE_CAPACITY * 3), 3);
    this.smokeDecal.setUsage(DynamicDrawUsage);
    smokeGeometry.setAttribute('iDecal', this.smokeDecal);
    const smokeMaterial = new MeshBasicMaterial({
      color: 0xffffff,
      map: this.falloff,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      toneMapped: false,
    });
    smokeMaterial.name = 'combat-smoke';
    // One tile, so the UV slide is the identity and only the alpha is used.
    patchInstanceDecal(smokeMaterial, 1, 'meridian-combat-smoke-v1');
    this.smokeMesh = new InstancedMesh(smokeGeometry, smokeMaterial, SMOKE_CAPACITY);
    this.smokeMesh.name = 'combat-smoke';
    this.smokeMesh.frustumCulled = false;
    // Under the fire, which is additive and has to read as being inside it.
    this.smokeMesh.renderOrder = 5;
    this.smokeMesh.count = 0;
    this.smokeMesh.visible = false;

    for (let i = 0; i < GLOW_CAPACITY; i += 1) {
      this.glows.push({
        alive: false, life: 0, maxLife: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        width: 0, height: 0, aimed: false, ax: 0, ay: 0, az: 1, r: 1, g: 1, b: 1,
        growth: 0, gravity: SPARK_GRAVITY, drag: 0,
      });
    }
    for (let i = 0; i < MARK_CAPACITY; i += 1) {
      this.marks.push({
        alive: false, life: 0, maxLife: MARK_LIFE, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0,
        roll: 0, size: 0.2, alpha: 1, tileU: 0, tileV: 0, r: 0, g: 0, b: 0,
      });
    }
    for (let i = 0; i < SMOKE_CAPACITY; i += 1) {
      this.puffs.push({
        alive: false, life: 0, maxLife: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        size: 1, growth: 0, drag: 0, lift: 0, roll: 0, spin: 0, alpha: 0.5,
        r: 0.16, g: 0.15, b: 0.14,
      });
    }

    const group = new Group();
    group.name = 'combat-fx';
    group.add(this.glowMesh, this.markMesh, this.smokeMesh);
    this.group = group;
  }

  /** A flash at the muzzle. `scale` follows the weapon's violence. */
  muzzle(x: number, y: number, z: number, scale: number): void {
    const glow = this.takeGlow();
    glow.alive = true;
    glow.life = 0;
    glow.maxLife = FLASH_LIFE;
    glow.x = x;
    glow.y = y;
    glow.z = z;
    glow.vx = 0;
    glow.vy = 0;
    glow.vz = 0;
    // Small: the muzzle is half a metre from the eye, where a 62-degree
    // frustum is only sixty centimetres tall. A flash the size of a hand
    // covers a tenth of the screen, which is already a lot of light.
    glow.width = 0.06 * scale;
    glow.height = 0.06 * scale;
    glow.aimed = false;
    glow.r = 1;
    glow.g = 0.86;
    glow.b = 0.52;
  }

  /** The bullet's path, drawn as a short bright streak along the shot. */
  tracer(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const length = Math.hypot(dx, dy, dz);
    if (length < 0.4) return;
    const glow = this.takeGlow();
    glow.alive = true;
    glow.life = 0;
    glow.maxLife = TRACER_LIFE;
    glow.x = (x0 + x1) * 0.5;
    glow.y = (y0 + y1) * 0.5;
    glow.z = (z0 + z1) * 0.5;
    glow.vx = 0;
    glow.vy = 0;
    glow.vz = 0;
    glow.width = 0.035;
    glow.height = length;
    glow.aimed = true;
    glow.ax = dx / length;
    glow.ay = dy / length;
    glow.az = dz / length;
    glow.r = 1;
    glow.g = 0.82;
    glow.b = 0.46;
  }

  /**
   * Sparks and a scorch mark where a shot landed.
   *
   * `n*` is the surface normal; a body hit passes the shot direction reversed,
   * which is close enough for debris that lives a third of a second.
   *
   * `groundY` is the height of the floor UNDER the impact and only matters for
   * a body hit. It defaults to the old guess of 0.9 m below the wound; the
   * caller knows the victim's foot height exactly and should pass it, because
   * the guess put a head shot's blood pool in mid air.
   */
  impact(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    kind: ImpactKind,
    rand: () => number,
    groundY = y - 0.9,
  ): void {
    this.debris(x, y, z, nx, ny, nz, kind, rand);

    const style = IMPACT_STYLE[kind];
    const mark = this.takeMark();
    const tint = style.mark;
    mark.alive = true;
    mark.life = 0;
    mark.alpha = style.markAlpha;
    const tile = DECAL_UV[style.decal];
    mark.tileU = tile[0];
    mark.tileV = tile[1];
    mark.roll = rand() * Math.PI * 2;
    if (kind === 'body') {
      // A hit on a person does not mark the person - they move, and a decal
      // welded to a walking body slides. It marks the GROUND under them, which
      // is what a player actually sees afterwards, and it lasts long enough to
      // still be there when they walk back past it.
      mark.maxLife = BLOOD_LIFE;
      // Scattered under the victim rather than around them: the contact point
      // is now the round's real arrival point, so the pool only has to fall
      // from it rather than stand in for not knowing where it was.
      mark.x = x + (rand() - 0.5) * 0.24;
      mark.z = z + (rand() - 0.5) * 0.24;
      mark.nx = 0;
      mark.ny = 1;
      mark.nz = 0;
      mark.size = style.markSize + rand() * 0.05;
      // Proud of the FLOOR, not a guessed drop below the wound: a head shot is
      // 1.7 m up a body and the guess left the pool floating.
      mark.y = groundY + markLift(mark.size);
    } else {
      mark.nx = nx;
      mark.ny = ny;
      mark.nz = nz;
      mark.size = style.markSize + rand() * 0.03;
      // ON the plane the round arrived on, lifted along its own normal by
      // enough to clear it. See `markLift`.
      const lift = markLift(mark.size);
      mark.x = x + nx * lift;
      mark.y = y + ny * lift;
      mark.z = z + nz * lift;
    }
    mark.r = tint[0];
    mark.g = tint[1];
    mark.b = tint[2];
  }

  /**
   * The material's own debris, with no mark.
   *
   * Split out of `impact` because a detonation on a wall wants the concrete
   * grit and the metal sparks of whatever it landed on WITHOUT a second decal
   * underneath its own scorch - two marks in the same square metre is one
   * wasted pool slot and one invisible decal.
   */
  debris(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    kind: ImpactKind,
    rand: () => number,
  ): void {
    const style = IMPACT_STYLE[kind];
    const spark = style.spark;
    for (let i = 0; i < style.debris; i += 1) {
      const glow = this.takeGlow();
      glow.alive = true;
      glow.life = 0;
      glow.maxLife = SPARK_LIFE * (0.6 + rand() * 0.7);
      glow.x = x + nx * 0.02;
      glow.y = y + ny * 0.02;
      glow.z = z + nz * 0.02;
      // Scatter around the normal: mostly back the way the shot came from.
      const speed = style.speed + rand() * style.speed * 1.9;
      glow.vx = (nx + (rand() - 0.5) * 1.4) * speed;
      glow.vy = (ny + (rand() - 0.5) * 1.4) * speed + 1.2;
      glow.vz = (nz + (rand() - 0.5) * 1.4) * speed;
      glow.width = style.size;
      glow.height = style.size;
      glow.aimed = false;
      glow.gravity = style.gravity;
      glow.drag = style.drag;
      glow.r = spark[0];
      glow.g = spark[1];
      glow.b = spark[2];
    }
  }

  /**
   * One puff of rocket exhaust, left behind along a flight path.
   *
   * Deliberately slow-dying and slow-growing: a trail that fades as fast as a
   * spark is invisible from the side, which is exactly the angle a player
   * watches their own rocket from.
   */
  exhaust(x: number, y: number, z: number, rand: () => number): void {
    const puff = this.takeGlow();
    puff.alive = true;
    puff.life = 0;
    puff.maxLife = 0.5 + rand() * 0.35;
    puff.x = x + (rand() - 0.5) * 0.12;
    puff.y = y + (rand() - 0.5) * 0.12;
    puff.z = z + (rand() - 0.5) * 0.12;
    puff.vy = 0.35;
    puff.gravity = 0.4;
    puff.drag = 1.4;
    puff.width = 0.09;
    puff.height = 0.09;
    puff.growth = 0.9;
    puff.r = 0.62;
    puff.g = 0.55;
    puff.b = 0.5;
  }

  /**
   * A detonation.
   *
   * Four layers, all out of the same two instanced meshes the rest of the
   * combat layer already uses: a white core that is gone in a twentieth of a
   * second, a fireball that expands and cools from white through orange to
   * dull red, a ground-hugging shockwave ring, and forty embers thrown out
   * with drag so they slow in the air instead of flying off like sparks.
   *
   * It leaves a scorch on the ground that outlasts the blast by half a minute,
   * because a crater that vanishes as soon as the smoke clears is the tell
   * that nothing really happened there.
   *
   * `radius` is the blast's damage radius, and everything drawn is scaled from
   * it, so a bigger warhead is a bigger explosion without a second set of
   * numbers to keep in step.
   */
  explosion(
    x: number,
    y: number,
    z: number,
    radius: number,
    rand: () => number,
    scorch?: ScorchPlacement,
  ): void {
    // The core: a hard white flash at the seat of the blast.
    const core = this.takeGlow();
    core.alive = true;
    core.life = 0;
    core.maxLife = 0.11;
    core.x = x;
    core.y = y;
    core.z = z;
    core.width = radius * 0.55;
    core.height = radius * 0.55;
    core.growth = radius * 3.4;
    core.r = 4.2;
    core.g = 3.8;
    core.b = 3.1;

    // The fireball: several overlapping puffs so it has a shape rather than
    // being one perfectly round card, each rising as hot gas does.
    for (let i = 0; i < 9; i += 1) {
      const puff = this.takeGlow();
      puff.alive = true;
      puff.life = 0;
      puff.maxLife = 0.5 + rand() * 0.55;
      puff.x = x + (rand() - 0.5) * radius * 0.5;
      puff.y = y + rand() * radius * 0.3;
      puff.z = z + (rand() - 0.5) * radius * 0.5;
      puff.vx = (rand() - 0.5) * 4;
      puff.vy = 1.4 + rand() * 2.6;
      puff.vz = (rand() - 0.5) * 4;
      // Hot gas rises; it must not be pulled down by the ember gravity.
      puff.gravity = 1.5;
      puff.drag = 1.6;
      puff.width = radius * 0.24;
      puff.height = radius * 0.24;
      puff.growth = radius * (0.7 + rand() * 0.5);
      puff.r = 2.6;
      puff.g = 1.05 + rand() * 0.35;
      puff.b = 0.24;
    }

    // The shockwave: one flat ring at ground level, growing past the damage
    // radius so the player can see exactly how far the blast reached.
    const wave = this.takeGlow();
    wave.alive = true;
    wave.life = 0;
    wave.maxLife = 0.42;
    wave.x = x;
    wave.y = y - 0.6;
    wave.z = z;
    wave.width = radius * 0.3;
    wave.height = radius * 0.3;
    wave.growth = radius * 3.6;
    wave.r = 1.1;
    wave.g = 0.85;
    wave.b = 0.6;

    // Embers and burning debris.
    for (let i = 0; i < 32; i += 1) {
      const ember = this.takeGlow();
      ember.alive = true;
      ember.life = 0;
      ember.maxLife = 0.7 + rand() * 1.5;
      ember.x = x;
      ember.y = y;
      ember.z = z;
      const theta = rand() * Math.PI * 2;
      const lift = 0.15 + rand() * 0.95;
      const speed = radius * (0.9 + rand() * 1.6);
      ember.vx = Math.cos(theta) * speed;
      ember.vy = lift * speed;
      ember.vz = Math.sin(theta) * speed;
      ember.drag = 1.1;
      ember.width = 0.05 + rand() * 0.09;
      ember.height = ember.width;
      ember.r = 2.2;
      ember.g = 0.75 + rand() * 0.4;
      ember.b = 0.12;
    }

    this.explosionSmoke(x, y, z, radius, rand);

    /*
     * The scorch.
     *
     * WHERE THE WARHEAD ACTUALLY LANDED, and on the plane it landed on. This
     * used to be a flat disc pinned 0.55 m below the detonation whatever the
     * detonation hit, which is a guess that is right only for a rocket that
     * went off a little above level ground: fired into a wall it left a
     * horizontal disc hanging in the air in front of the wall, and fired at a
     * lamp post it left one under the post. The caller now knows the surface -
     * it comes out of the same hit result that decided the damage - so the
     * scorch stands up on a wall and lies down on a road with no special case
     * on this side. Absent, it falls back to the old behaviour.
     */
    const px = scorch ? scorch.x : x;
    const py = scorch ? scorch.y : y - 0.55;
    const pz = scorch ? scorch.z : z;
    const nx = scorch ? scorch.nx : 0;
    const ny = scorch ? scorch.ny : 1;
    const nz = scorch ? scorch.nz : 0;
    const mark = this.takeMark();
    const tile = DECAL_UV.scorch;
    mark.alive = true;
    mark.life = 0;
    mark.maxLife = CRATER_LIFE;
    mark.size = radius * 0.62;
    mark.roll = rand() * Math.PI * 2;
    mark.alpha = 0.95;
    mark.tileU = tile[0];
    mark.tileV = tile[1];
    const lift = markLift(mark.size);
    mark.x = px + nx * lift;
    mark.y = py + ny * lift;
    mark.z = pz + nz * lift;
    mark.nx = nx;
    mark.ny = ny;
    mark.nz = nz;
    mark.r = 0.1;
    mark.g = 0.085;
    mark.b = 0.075;
  }

  /**
   * The column of smoke a detonation leaves, and the low cloud around its foot.
   *
   * Deliberately much longer lived than the fire: the flash is over in a tenth
   * of a second and the fireball in half a second, and without something that
   * hangs for three seconds afterwards a rocket reads as a bright flicker
   * rather than as a detonation. Bounded by `SMOKE_CAPACITY` like everything
   * else here, so a magazine of rockets cannot fill the screen for ever.
   */
  private explosionSmoke(
    x: number,
    y: number,
    z: number,
    radius: number,
    rand: () => number,
  ): void {
    for (let i = 0; i < SMOKE_COLUMN; i += 1) {
      const puff = this.takeSmoke();
      puff.alive = true;
      puff.life = 0;
      puff.maxLife = 2.4 + rand() * 1.8;
      puff.x = x + (rand() - 0.5) * radius * 0.55;
      puff.y = y + rand() * radius * 0.4;
      puff.z = z + (rand() - 0.5) * radius * 0.55;
      puff.vx = (rand() - 0.5) * 2.4;
      puff.vy = 1.1 + rand() * 2;
      puff.vz = (rand() - 0.5) * 2.4;
      puff.drag = 0.9;
      puff.lift = 0.5;
      puff.size = radius * (0.22 + rand() * 0.12);
      puff.growth = radius * (0.3 + rand() * 0.28);
      puff.roll = rand() * Math.PI * 2;
      puff.spin = (rand() - 0.5) * 0.8;
      puff.alpha = 0.42 + rand() * 0.2;
      // Warm grey near the fire, cooling to soot as it climbs. One tint per
      // puff rather than per frame; the fade does the rest.
      const warm = 0.1 + rand() * 0.08;
      puff.r = warm * 1.25;
      puff.g = warm * 1.05;
      puff.b = warm;
    }

    // The ground cloud: wide, slow, barely rising, and what actually hides the
    // wreck for a second or two.
    for (let i = 0; i < SMOKE_GROUND; i += 1) {
      const puff = this.takeSmoke();
      const theta = rand() * Math.PI * 2;
      const reach = radius * (0.2 + rand() * 0.5);
      puff.alive = true;
      puff.life = 0;
      puff.maxLife = 1.8 + rand() * 1.4;
      puff.x = x + Math.cos(theta) * reach;
      puff.y = y - radius * 0.06;
      puff.z = z + Math.sin(theta) * reach;
      puff.vx = Math.cos(theta) * radius * 0.5;
      puff.vy = 0.2 + rand() * 0.4;
      puff.vz = Math.sin(theta) * radius * 0.5;
      puff.drag = 1.6;
      puff.lift = 0.15;
      puff.size = radius * (0.18 + rand() * 0.1);
      puff.growth = radius * (0.24 + rand() * 0.2);
      puff.roll = rand() * Math.PI * 2;
      puff.spin = (rand() - 0.5) * 0.5;
      puff.alpha = 0.3 + rand() * 0.16;
      const dust = 0.14 + rand() * 0.06;
      puff.r = dust;
      puff.g = dust * 0.96;
      puff.b = dust * 0.9;
    }
  }

  /**
   * Advances every live effect and repacks the instance buffers.
   *
   * `cameraX/Y/Z` orients the unaimed quads at the viewer; a flash or a spark
   * seen edge-on would otherwise vanish.
   */
  update(dt: number, cameraX: number, cameraY: number, cameraZ: number): void {
    if (this.disposed) return;

    let live = 0;
    for (const glow of this.glows) {
      if (!glow.alive) continue;
      glow.life += dt;
      if (glow.life >= glow.maxLife) {
        glow.alive = false;
        continue;
      }
      if (glow.vy !== 0 || glow.vx !== 0 || glow.vz !== 0) {
        glow.vy += glow.gravity * dt;
        if (glow.drag > 0) {
          const keep = Math.max(0, 1 - glow.drag * dt);
          glow.vx *= keep;
          glow.vy *= keep;
          glow.vz *= keep;
        }
        glow.x += glow.vx * dt;
        glow.y += glow.vy * dt;
        glow.z += glow.vz * dt;
      }

      const t = glow.life / glow.maxLife;
      // Bright immediately, gone quickly: additive blending means the fade has
      // to happen in the colour, because there is no per-instance alpha.
      const fade = 1 - t * t;
      const grown = glow.growth * glow.life;
      const swell = glow.aimed ? 1 : 1 + t * 0.7;

      if (glow.aimed) {
        // A tracer is a ribbon: its local +Y must lie along the shot and its
        // face must turn toward the viewer. Building the basis directly is
        // exact and avoids composing two rotations that fight each other.
        this.axisY.set(glow.ax, glow.ay, glow.az);
        this.scratch.set(cameraX - glow.x, cameraY - glow.y, cameraZ - glow.z).normalize();
        this.axisX.crossVectors(this.axisY, this.scratch);
        if (this.axisX.lengthSq() < 1e-8) {
          // Looking straight down the barrel: any perpendicular will do.
          this.axisX.set(this.axisY.y, -this.axisY.x, 0);
          if (this.axisX.lengthSq() < 1e-8) this.axisX.set(1, 0, 0);
        }
        this.axisX.normalize().multiplyScalar(glow.width);
        this.axisZ.crossVectors(this.axisX, this.axisY).normalize();
        this.axisY.multiplyScalar(glow.height);
        this.basis.makeBasis(this.axisX, this.axisY, this.axisZ);
        this.basis.setPosition(glow.x, glow.y, glow.z);
        this.glowMesh.setMatrixAt(live, this.basis);
      } else {
        this.dummy.position.set(glow.x, glow.y, glow.z);
        this.dummy.lookAt(cameraX, cameraY, cameraZ);
        this.dummy.scale.set(glow.width * swell + grown, glow.height * swell + grown, 1);
        this.dummy.updateMatrix();
        this.glowMesh.setMatrixAt(live, this.dummy.matrix);
      }
      this.colour.setRGB(glow.r * fade, glow.g * fade, glow.b * fade);
      this.glowMesh.setColorAt(live, this.colour);
      live += 1;
      if (live >= GLOW_CAPACITY) break;
    }
    this.glowMesh.count = live;
    this.glowMesh.visible = live > 0;
    if (live > 0) {
      this.glowMesh.instanceMatrix.needsUpdate = true;
      if (this.glowMesh.instanceColor) this.glowMesh.instanceColor.needsUpdate = true;
    }

    let marks = 0;
    const markData = this.markDecal.array as Float32Array;
    for (const mark of this.marks) {
      if (!mark.alive) continue;
      mark.life += dt;
      if (mark.life >= mark.maxLife) {
        mark.alive = false;
        continue;
      }
      const remaining = 1 - mark.life / mark.maxLife;
      // Faded in the ALPHA, not the scale. A hole that shrinks as it ages
      // reads as the wall growing back over it.
      const fade = remaining < MARK_FADE ? remaining / MARK_FADE : 1;
      this.orientMark(mark);
      this.markMesh.setMatrixAt(marks, this.basis);
      this.colour.setRGB(mark.r, mark.g, mark.b);
      this.markMesh.setColorAt(marks, this.colour);
      const slot = marks * 3;
      markData[slot] = mark.tileU;
      markData[slot + 1] = mark.tileV;
      markData[slot + 2] = mark.alpha * fade;
      marks += 1;
      if (marks >= MARK_CAPACITY) break;
    }
    this.markMesh.count = marks;
    this.markMesh.visible = marks > 0;
    if (marks > 0) {
      this.markMesh.instanceMatrix.needsUpdate = true;
      this.markDecal.needsUpdate = true;
      if (this.markMesh.instanceColor) this.markMesh.instanceColor.needsUpdate = true;
    }

    let puffs = 0;
    const smokeData = this.smokeDecal.array as Float32Array;
    for (const puff of this.puffs) {
      if (!puff.alive) continue;
      puff.life += dt;
      if (puff.life >= puff.maxLife) {
        puff.alive = false;
        continue;
      }
      puff.vy += puff.lift * dt;
      if (puff.drag > 0) {
        const keep = Math.max(0, 1 - puff.drag * dt);
        puff.vx *= keep;
        puff.vy *= keep;
        puff.vz *= keep;
      }
      puff.x += puff.vx * dt;
      puff.y += puff.vy * dt;
      puff.z += puff.vz * dt;
      puff.roll += puff.spin * dt;

      const t = puff.life / puff.maxLife;
      // Up fast, out slow: smoke is at full opacity almost immediately and
      // then thins for the rest of its life. A linear fade reads as a dimmer.
      const rise = Math.min(1, t / 0.09);
      const alpha = puff.alpha * rise * (1 - t) * (1 - t);
      const size = puff.size + puff.growth * puff.life;
      this.dummy.position.set(puff.x, puff.y, puff.z);
      this.dummy.lookAt(cameraX, cameraY, cameraZ);
      this.dummy.rotateZ(puff.roll);
      this.dummy.scale.set(size * 2, size * 2, 1);
      this.dummy.updateMatrix();
      this.smokeMesh.setMatrixAt(puffs, this.dummy.matrix);
      this.colour.setRGB(puff.r, puff.g, puff.b);
      this.smokeMesh.setColorAt(puffs, this.colour);
      const slot = puffs * 3;
      smokeData[slot] = 0;
      smokeData[slot + 1] = 0;
      smokeData[slot + 2] = alpha;
      puffs += 1;
      if (puffs >= SMOKE_CAPACITY) break;
    }
    this.smokeMesh.count = puffs;
    this.smokeMesh.visible = puffs > 0;
    if (puffs > 0) {
      this.smokeMesh.instanceMatrix.needsUpdate = true;
      this.smokeDecal.needsUpdate = true;
      if (this.smokeMesh.instanceColor) this.smokeMesh.instanceColor.needsUpdate = true;
    }
  }

  /** Live effects, for diagnostics. */
  get stats(): { glows: number; marks: number; smoke: number } {
    return {
      glows: this.glowMesh.count,
      marks: this.markMesh.count,
      smoke: this.smokeMesh.count,
    };
  }

  /**
   * Every live mark, as plain numbers.
   *
   * ALLOCATES, and is for verification only - a browser QA pass asserting that
   * a decal is where the round landed and facing the way the wall does has no
   * other way to see one, because the instance buffer is repacked every frame
   * and says nothing about which mark is which.
   */
  markReport(): {
    x: number;
    y: number;
    z: number;
    nx: number;
    ny: number;
    nz: number;
    size: number;
    age: number;
    life: number;
  }[] {
    const out = [];
    for (const mark of this.marks) {
      if (!mark.alive) continue;
      out.push({
        x: mark.x, y: mark.y, z: mark.z,
        nx: mark.nx, ny: mark.ny, nz: mark.nz,
        size: mark.size, age: mark.life, life: mark.maxLife,
      });
    }
    return out;
  }

  /** Drops every live effect without tearing the pools down. */
  clear(): void {
    for (const glow of this.glows) glow.alive = false;
    for (const mark of this.marks) mark.alive = false;
    for (const puff of this.puffs) puff.alive = false;
    this.glowMesh.count = 0;
    this.markMesh.count = 0;
    this.smokeMesh.count = 0;
    this.glowMesh.visible = false;
    this.markMesh.visible = false;
    this.smokeMesh.visible = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.falloff.dispose();
    this.atlas.dispose();
    this.glowMesh.geometry.dispose();
    (this.glowMesh.material as MeshBasicMaterial).dispose();
    this.markMesh.geometry.dispose();
    (this.markMesh.material as MeshBasicMaterial).dispose();
    this.smokeMesh.geometry.dispose();
    (this.smokeMesh.material as MeshBasicMaterial).dispose();
    this.glowMesh.dispose();
    this.markMesh.dispose();
    this.smokeMesh.dispose();
    this.group.clear();
  }

  /**
   * Builds a mark's world matrix into `this.basis`.
   *
   * A decal is a quad ON a plane, so its own +Z has to BE the surface normal
   * and its other two axes have to span the surface. Composing that from a
   * `setFromUnitVectors` rotation and then a spin about the result is two
   * rotations that have to agree; building the basis directly is one, is
   * exact, and is where the per-mark roll goes in for free.
   */
  private orientMark(mark: Mark): void {
    this.axisZ.set(mark.nx, mark.ny, mark.nz);
    if (this.axisZ.lengthSq() < 1e-8) this.axisZ.set(0, 1, 0);
    this.axisZ.normalize();
    // Any world axis not parallel to the normal seeds the tangent frame. Up
    // works for every wall; a floor or a ceiling falls back to +X.
    this.scratch.set(0, 1, 0);
    if (Math.abs(this.axisZ.y) > 0.99) this.scratch.set(1, 0, 0);
    this.axisX.crossVectors(this.scratch, this.axisZ).normalize();
    this.axisY.crossVectors(this.axisZ, this.axisX).normalize();

    // Roll about the normal, applied to the two in-plane axes.
    const cos = Math.cos(mark.roll);
    const sin = Math.sin(mark.roll);
    const rx = this.axisX.x * cos + this.axisY.x * sin;
    const ry = this.axisX.y * cos + this.axisY.y * sin;
    const rz = this.axisX.z * cos + this.axisY.z * sin;
    const ux = this.axisY.x * cos - this.axisX.x * sin;
    const uy = this.axisY.y * cos - this.axisX.y * sin;
    const uz = this.axisY.z * cos - this.axisX.z * sin;

    const span = mark.size * 2;
    this.axisX.set(rx, ry, rz).multiplyScalar(span);
    this.axisY.set(ux, uy, uz).multiplyScalar(span);
    this.basis.makeBasis(this.axisX, this.axisY, this.axisZ);
    this.basis.setPosition(mark.x, mark.y, mark.z);
  }

  /**
   * A free glow slot, with every field a caller might not set already back at
   * its default.
   *
   * The reset matters: slots are recycled, so a fireball that set `growth` and
   * then died would hand a spark three metres a second of expansion if the
   * next caller only wrote the fields it cared about.
   */
  private takeGlow(): Glow {
    let glow: Glow | null = null;
    for (let i = 0; i < GLOW_CAPACITY; i += 1) {
      const index = (this.glowCursor + i) % GLOW_CAPACITY;
      const candidate = this.glows[index];
      if (candidate && !candidate.alive) {
        this.glowCursor = (index + 1) % GLOW_CAPACITY;
        glow = candidate;
        break;
      }
    }
    if (!glow) {
      // Everything is busy: reuse the oldest slot rather than dropping the shot.
      glow = this.glows[this.glowCursor] as Glow;
      this.glowCursor = (this.glowCursor + 1) % GLOW_CAPACITY;
    }
    glow.vx = 0;
    glow.vy = 0;
    glow.vz = 0;
    glow.aimed = false;
    glow.growth = 0;
    glow.gravity = SPARK_GRAVITY;
    glow.drag = 0;
    return glow;
  }

  private takeMark(): Mark {
    let mark: Mark | null = null;
    for (let i = 0; i < MARK_CAPACITY; i += 1) {
      const index = (this.markCursor + i) % MARK_CAPACITY;
      const candidate = this.marks[index];
      if (candidate && !candidate.alive) {
        this.markCursor = (index + 1) % MARK_CAPACITY;
        mark = candidate;
        break;
      }
    }
    if (!mark) {
      mark = this.marks[this.markCursor] as Mark;
      this.markCursor = (this.markCursor + 1) % MARK_CAPACITY;
    }
    // Reset the fields a caller may not write, for the same reason `takeGlow`
    // does: a recycled blast scorch would otherwise hand a bullet hole forty
    // seconds of life and the wrong tile.
    mark.maxLife = MARK_LIFE;
    mark.roll = 0;
    mark.alpha = 1;
    mark.tileU = 0;
    mark.tileV = 0;
    return mark;
  }

  private takeSmoke(): Smoke {
    let puff: Smoke | null = null;
    for (let i = 0; i < SMOKE_CAPACITY; i += 1) {
      const index = (this.smokeCursor + i) % SMOKE_CAPACITY;
      const candidate = this.puffs[index];
      if (candidate && !candidate.alive) {
        this.smokeCursor = (index + 1) % SMOKE_CAPACITY;
        puff = candidate;
        break;
      }
    }
    if (!puff) {
      puff = this.puffs[this.smokeCursor] as Smoke;
      this.smokeCursor = (this.smokeCursor + 1) % SMOKE_CAPACITY;
    }
    puff.vx = 0;
    puff.vy = 0;
    puff.vz = 0;
    puff.growth = 0;
    puff.drag = 0;
    puff.lift = 0;
    puff.spin = 0;
    return puff;
  }
}
