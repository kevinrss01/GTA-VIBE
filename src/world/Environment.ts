/**
 * Everything outside the street grid: the bay, the beach, the open ground
 * beyond the loop road, the seawall, and the distant skyline.
 *
 * The distant skyline is the cheapest realism trick in the project. A compact
 * city stops dead at its edges and reads as a diorama; a hundred buildings on
 * the far shore give the eye somewhere to go and make the same playable area
 * feel like part of something bigger. They are never approachable.
 *
 * They are, however, not as far away as "distant" suggests. The fog is
 * FogExp2 at 0.0016, which takes about a third of the far band at 400 m and
 * three fifths at 600 m, so a plain extruded box out there is still legible as
 * a plain extruded box. The budget therefore goes into two things and nothing
 * else: silhouette, in geometry, and façade grain, in the `skyline` shader
 * (see `makeSkylineFacades`), which costs no geometry at all. Windows modelled
 * at this range would be tens of thousands of triangles landing under a pixel
 * each.
 */

import { BufferAttribute, BufferGeometry, Matrix4, PlaneGeometry, Vector3 } from 'three';

import { createRng, hash2 } from '../core/rng';
import { clamp, smoothstep } from '../core/mathx';
import {
  groundElevation,
  landElevation,
  SEA_LEVEL,
  SEAWALL_X,
  shorelineX,
  WORLD_BOUNDS,
} from './elevation';
import type { CityGround } from './CityGround';
import type { GeometrySink } from './build/types';

/** Spacing of the open-ground mesh. */
const TERRAIN_STEP = 5;

interface QuadWriter {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

function newWriter(): QuadWriter {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

function pushQuad(
  w: QuadWriter,
  a: Vector3,
  b: Vector3,
  c: Vector3,
  d: Vector3,
  uvScale: number,
): void {
  const base = w.positions.length / 3;
  for (const p of [a, b, c, d]) {
    w.positions.push(p.x, p.y, p.z);
    w.normals.push(0, 1, 0);
    w.uvs.push(p.x / uvScale, p.z / uvScale);
  }
  w.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
}

function finish(w: QuadWriter): BufferGeometry | null {
  if (w.indices.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(w.positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(w.normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(w.uvs), 2));
  geometry.setIndex(w.indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The open ground. It is drawn a few centimetres below the street and block
 * surfaces so that it acts as a base layer everywhere and can never z-fight
 * with them; inside the city it is simply never seen.
 */
function buildTerrain(sink: GeometrySink, ground: CityGround): void {
  const grass = newWriter();
  const sand = newWriter();
  const sandWet = newWriter();

  /**
   * How far to sink a terrain quad below the true ground height.
   *
   * Only quads underneath a hard city surface are sunk, and only far enough to
   * stay out of its way. Sinking the open ground as well was what left props
   * on the beach hovering six centimetres in the air: they are placed on the
   * height `CityGround` reports, while the mesh under them had been pushed
   * down. Outside the city the two now agree exactly.
   */
  const sinkAt = (x: number, z: number): number => {
    const surface = ground.sample(x, z).surface;
    const covered =
      surface === 'asphalt' ||
      surface === 'pavement' ||
      surface === 'boardwalk' ||
      surface === 'plaza' ||
      ground.blockAt(x, z) !== null;
    return covered ? 0.06 : 0;
  };

  const { minX, maxX, minZ, maxZ } = WORLD_BOUNDS;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const d = new Vector3();

  for (let x = minX; x < maxX; x += TERRAIN_STEP) {
    for (let z = minZ; z < maxZ; z += TERRAIN_STEP) {
      const x1 = Math.min(x + TERRAIN_STEP, maxX);
      const z1 = Math.min(z + TERRAIN_STEP, maxZ);
      const cx = (x + x1) * 0.5;
      const cz = (z + z1) * 0.5;

      const height = groundElevation(cx, cz);
      // Skip anything well below the waterline: the sea plane covers it and the
      // seabed is never visible through the water at this depth.
      if (height < SEA_LEVEL - 2.6) continue;

      const sink = sinkAt(cx, cz);
      a.set(x, groundElevation(x, z) - sink, z);
      b.set(x1, groundElevation(x1, z) - sink, z);
      c.set(x1, groundElevation(x1, z1) - sink, z1);
      d.set(x, groundElevation(x, z1) - sink, z1);

      const shore = shorelineX(cz);
      const fromShore = cx - shore;
      // Damp sand in the tidal band, dry sand above it, scrub inland.
      const writer = fromShore < 5 ? sandWet : fromShore < 18 ? sand : grass;
      pushQuad(writer, a, b, c, d, 8);
    }
  }

  const grassGeometry = finish(grass);
  if (grassGeometry) sink.add('grass', grassGeometry);
  const sandGeometry = finish(sand);
  if (sandGeometry) sink.add('sand', sandGeometry);
  const wetGeometry = finish(sandWet);
  if (wetGeometry) sink.add('sandWet', wetGeometry);
}

/** A single plane at sea level. Movement comes from the shader, not geometry. */
function buildWater(sink: GeometrySink): void {
  const width = WORLD_BOUNDS.maxX - WORLD_BOUNDS.minX + 900;
  const depth = WORLD_BOUNDS.maxZ - WORLD_BOUNDS.minZ + 900;
  const geometry = new PlaneGeometry(width, depth, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(
    (WORLD_BOUNDS.minX + WORLD_BOUNDS.maxX) / 2 - 240,
    SEA_LEVEL,
    (WORLD_BOUNDS.minZ + WORLD_BOUNDS.maxZ) / 2,
  );
  sink.add('water', geometry);
}

/**
 * The seawall along the promenade: a stone face from the beach up to the
 * walkway, with a coping course on top. Without it the promenade appears to
 * float above the water.
 */
function buildSeawall(sink: GeometrySink): void {
  const wall = newWriter();
  const coping = newWriter();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const d = new Vector3();

  for (let z = WORLD_BOUNDS.minZ + 10; z < WORLD_BOUNDS.maxZ - 10; z += 4) {
    const z1 = z + 4;
    // A straight retaining line at the promenade edge, not one that follows the
    // waterline. The wall is what holds the promenade up; letting it wander
    // with the tide line is what let the road end up unsupported.
    const x0 = SEAWALL_X;
    const x1 = SEAWALL_X;
    const top0 = landElevation(x0, z);
    const top1 = landElevation(x1, z1);
    const foot = SEA_LEVEL - 1.2;

    // Vertical face.
    a.set(x0, foot, z);
    b.set(x1, foot, z1);
    c.set(x1, top1, z1);
    d.set(x0, top0, z);
    pushQuad(wall, a, b, c, d, 6);

    // Coping: a 0.9 m wide capping stone standing 0.12 m proud.
    a.set(x0, top0 + 0.12, z);
    b.set(x1, top1 + 0.12, z1);
    c.set(x1 + 0.9, top1 + 0.12, z1);
    d.set(x0 + 0.9, top0 + 0.12, z);
    pushQuad(coping, a, b, c, d, 4);

    sink.collider({
      minX: Math.min(x0, x1) - 0.5,
      maxX: Math.max(x0, x1) + 0.9,
      minZ: z,
      maxZ: z1,
      bottom: foot,
      top: Math.max(top0, top1) + 0.12,
      solid: true,
    });
  }

  const wallGeometry = finish(wall);
  if (wallGeometry) sink.add('stoneAshlar', wallGeometry);
  const copingGeometry = finish(coping);
  if (copingGeometry) sink.add('plazaStone', copingGeometry);
}

/**
 * How far a distant building must stay from the playable world, in metres.
 *
 * This is not decoration. The old near band was generated on an arc that could
 * reach x = -175, which is the promenade: a 30 m block of "distant" skyline
 * was standing on the beach, filling half the frame at the exact vantage the
 * player walks to. Nothing in this function may come within this distance of
 * the world the player can reach.
 */
export const SKYLINE_STANDOFF = 150;

/** Skyline colour families and window rhythms are chosen from this, per building. */
type SkylineShape = 'slab' | 'stepped' | 'tower' | 'block' | 'gabled' | 'stack';

interface SkylineArc {
  /** Centre of the arc the buildings are laid out on. */
  readonly cx: number;
  readonly cz: number;
  readonly radius: number;
  /** Angles, in radians, of the first and last building on the arc. */
  readonly from: number;
  readonly to: number;
  /** Radial scatter either side of the arc. */
  readonly jitter: number;
  readonly count: number;
  readonly heights: readonly [number, number];
  readonly footprint: readonly [number, number];
  /** 0 for the band nearest the city, 1 for the deepest one. Drives the haze. */
  readonly haze: number;
  readonly shapes: readonly SkylineShape[];
}

/**
 * The far shore, the headland, the south bank and the ridge behind the city.
 *
 * Layout note: the bay is west, so the western arcs are the ones the player
 * actually studies - they sit above open water from the whole promenade with
 * nothing in front of them. They get a proper two-layer downtown; the other
 * three sides get lower, industrial, hillside profiles that are mostly
 * occluded by the city itself.
 *
 * Cost note: the whole skyline is emitted as ONE geometry under ONE material
 * key. That is deliberate. `WorldSink` buckets a geometry into a chunk by its
 * bounding-box centre, so one geometry spanning the horizon lands in a chunk
 * near the city and is drawn whenever that part of the city is - splitting it
 * per arc would put each arc in a chunk 400-600 m away, past the distance at
 * which `updateChunks` stops submitting them, and the horizon would blink out
 * a band at a time. Even so the horizon is only as durable as that chunk:
 * measured, it is culled from the far south-east corner of the world on the
 * low and medium presets, where the chunk centre is 399 m away against
 * visibility ranges of 260 and 340 m. Making that exact is a chunk-culling
 * question, not a skyline one.
 *
 * Every difference between one distant building and the next is carried in the
 * UVs and resolved by the `skyline` shader instead of by another material.
 */
export function buildDistantSkyline(sink: GeometrySink): void {
  const rng = createRng('meridian-skyline');
  const writer = newWriter();
  // The eight corners of the prism being written. Reused rather than
  // allocated per stage, in keeping with the rest of this module.
  const scratch: Vector3[] = [];
  for (let i = 0; i < 8; i += 1) scratch.push(new Vector3());

  /**
   * One face of a distant building. `id` identifies the building to the
   * shader and `haze` says how deep in the horizon it is; both ride in the UVs
   * because that is the only channel `WorldSink.normalise` keeps.
   */
  const face = (
    p1: Vector3,
    q: Vector3,
    r: Vector3,
    s: Vector3,
    id: number,
    haze: number,
  ): void => {
    const base = writer.positions.length / 3;
    for (const p of [p1, q, r, s]) {
      writer.positions.push(p.x, p.y, p.z);
      writer.normals.push(0, 1, 0);
      writer.uvs.push(id, haze);
    }
    writer.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };

  /**
   * A box whose top face may be smaller than its bottom, rotated about Y.
   *
   * Everything on the horizon is this shape: a plain stage (top = bottom), a
   * battered crown, a hipped roof (top tiny), a pyramidal cap, a mast. The
   * yaw is what stops a hundred buildings from all facing the world axes,
   * which is the single strongest tell that a skyline was generated.
   */
  const prism = (
    cx: number,
    cz: number,
    yaw: number,
    bottomW: number,
    bottomD: number,
    topW: number,
    topD: number,
    bottom: number,
    top: number,
    id: number,
    haze: number,
  ): void => {
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const corner = (
      out: Vector3,
      w: number,
      dp: number,
      sx: number,
      sz: number,
      y: number,
    ): Vector3 =>
      out.set(
        cx + sx * w * 0.5 * cos - sz * dp * 0.5 * sin,
        y,
        cz + sx * w * 0.5 * sin + sz * dp * 0.5 * cos,
      );

    const b0 = corner(scratch[0] as Vector3, bottomW, bottomD, -1, -1, bottom);
    const b1 = corner(scratch[1] as Vector3, bottomW, bottomD, 1, -1, bottom);
    const b2 = corner(scratch[2] as Vector3, bottomW, bottomD, 1, 1, bottom);
    const b3 = corner(scratch[3] as Vector3, bottomW, bottomD, -1, 1, bottom);
    const t0 = corner(scratch[4] as Vector3, topW, topD, -1, -1, top);
    const t1 = corner(scratch[5] as Vector3, topW, topD, 1, -1, top);
    const t2 = corner(scratch[6] as Vector3, topW, topD, 1, 1, top);
    const t3 = corner(scratch[7] as Vector3, topW, topD, -1, 1, top);

    face(b0, b1, t1, t0, id, haze);
    face(b1, b2, t2, t1, id, haze);
    face(b2, b3, t3, t2, id, haze);
    face(b3, b0, t0, t3, id, haze);
    // No underside: the lowest stage is always sunk below the ground it stands
    // on, so the only cap that can ever be seen is the roof.
    face(t0, t1, t2, t3, id, haze);
  };

  /**
   * One distant building.
   *
   * The rule at this range is that only the silhouette and the grain of the
   * façade survive, so the budget goes into profile: setbacks with a ledge at
   * each step, a parapet that puts a crisp line on every roof, and a crown -
   * plant room, mast, hipped roof or chimney - chosen by archetype so no two
   * neighbours resolve the same way.
   */
  const building = (
    shape: SkylineShape,
    x: number,
    z: number,
    yaw: number,
    footprint: number,
    height: number,
    base: number,
    id: number,
    haze: number,
  ): void => {
    // The lowest stage is sunk so a building always meets its ground, whether
    // that is the seabed, the beach or the ridge - and always past the
    // waterline, because there is no terrain mesh out here: the sea plane and
    // the fog are the only things covering a base, and a building standing on
    // the analytic hillside 400 m north of the world would otherwise show a
    // six-metre gap of sky underneath it.
    const foot = Math.min(base - 6, SEA_LEVEL - 3);
    const top = base + height;

    if (shape === 'gabled') {
      // Low sheds and terraces along the waterfront: a wall and a hipped roof.
      // Both are capped in absolute metres rather than scaled with the arc's
      // height range. A gable given a tower's height reads as a giant barn
      // standing among the office blocks, which is what the first pass looked
      // like from the beach.
      const wall = Math.min(height, 24) * 0.8;
      const roof = Math.min(wall * 0.42, 5.5);
      const eaves = base + wall;
      const w = footprint * 1.6;
      const dp = footprint * 0.78;
      prism(x, z, yaw, w, dp, w, dp, foot, eaves, id, haze);
      prism(x, z, yaw, w * 1.05, dp * 1.05, w * 0.14, dp * 0.68, eaves, eaves + roof, id, haze);
      return;
    }

    if (shape === 'stack') {
      // A works: a long low shed with one or two chimneys off centre.
      const shedTop = base + height * 0.3;
      prism(x, z, yaw, footprint * 1.9, footprint * 0.85, footprint * 1.9, footprint * 0.85, foot, shedTop, id, haze);
      const flues = rng.int(1, 2);
      for (let i = 0; i < flues; i += 1) {
        const off = (i === 0 ? -1 : 1) * footprint * rng.range(0.3, 0.6);
        const r = rng.range(2.2, 3.6);
        prism(
          x + off * Math.cos(yaw),
          z + off * Math.sin(yaw),
          yaw,
          r * 2,
          r * 2,
          r * 1.5,
          r * 1.5,
          foot,
          base + height * rng.range(0.86, 1.0),
          id,
          haze,
        );
      }
      return;
    }

    const steps = shape === 'stepped' ? rng.int(3, 4) : shape === 'block' ? 1 : rng.int(1, 2);
    // A tower is slender and a slab is broad; both read from a long way off.
    const aspect = shape === 'tower' ? 0.7 : shape === 'slab' ? 1.45 : 1.0;
    let level = base;
    let w = footprint * aspect;
    let dp = footprint / aspect;

    for (let i = 0; i < steps; i += 1) {
      const remaining = top - level;
      const stage = i === steps - 1 ? remaining : remaining * rng.range(0.38, 0.68);
      prism(x, z, yaw, w, dp, w, dp, i === 0 ? foot : level, level + stage, id, haze);
      level += stage;
      if (i < steps - 1) {
        // A ledge at the setback. Two metres of overhang is what turns a step
        // from a change of width into a cornice you can read at 500 m.
        prism(x, z, yaw, w + 2.2, dp + 2.2, w + 2.2, dp + 2.2, level - 1.1, level + 0.5, id, haze);
        const inset = rng.range(0.6, 0.84);
        w *= inset;
        dp *= inset;
      }
    }

    // Parapet: a shallow band standing proud of the shaft. Without it every
    // flat roof ends on a bare edge and the whole skyline reads as extrusion.
    prism(x, z, yaw, w + 1.4, dp + 1.4, w + 1.4, dp + 1.4, level - 0.6, level + 1.3, id, haze);
    level += 1.3;

    if (shape === 'tower' && height > 55) {
      // Tapered crown and a mast: the one or two buildings that give the
      // horizon a peak to sit under.
      const crown = rng.range(0.06, 0.14) * height;
      prism(x, z, yaw, w, dp, w * 0.52, dp * 0.52, level, level + crown, id, haze);
      level += crown;
      const mast = rng.range(10, 24);
      prism(x, z, yaw, 2.6, 2.6, 0.7, 0.7, level, level + mast, id, haze);
      prism(x, z, yaw, 1.8, 1.8, 1.8, 1.8, level + mast * 0.42, level + mast * 0.52, id, haze);
      return;
    }

    if (rng.chance(0.62)) {
      // Roof plant: a lift overrun and a tank or cooling box beside it.
      const plantW = w * rng.range(0.22, 0.4);
      const plantD = dp * rng.range(0.22, 0.4);
      const offX = w * rng.range(-0.2, 0.2);
      const offZ = dp * rng.range(-0.2, 0.2);
      prism(
        x + offX * Math.cos(yaw) - offZ * Math.sin(yaw),
        z + offX * Math.sin(yaw) + offZ * Math.cos(yaw),
        yaw,
        plantW,
        plantD,
        plantW,
        plantD,
        level - 0.6,
        level + rng.range(3, 8),
        id,
        haze,
      );
    }
    if (height > 40 && rng.chance(0.45)) {
      const mast = rng.range(6, 16);
      prism(x, z, yaw, 1.6, 1.6, 0.5, 0.5, level, level + mast, id, haze);
    }
  };

  /**
   * Pushes a point clear of the playable world.
   *
   * Scaled outward from the world centre on the larger of the two axes, so a
   * building that landed inside the ring ends up on it rather than being
   * dropped: deleting them thinned the horizon exactly where the bay is
   * widest. `hash2` gives each pushed building its own distance so they do not
   * line up along the ring.
   */
  const clearOfCity = (x: number, z: number, halfSize: number): { x: number; z: number } => {
    const midX = (WORLD_BOUNDS.minX + WORLD_BOUNDS.maxX) * 0.5;
    const midZ = (WORLD_BOUNDS.minZ + WORLD_BOUNDS.maxZ) * 0.5;
    const halfX = (WORLD_BOUNDS.maxX - WORLD_BOUNDS.minX) * 0.5 + SKYLINE_STANDOFF + halfSize;
    const halfZ = (WORLD_BOUNDS.maxZ - WORLD_BOUNDS.minZ) * 0.5 + SKYLINE_STANDOFF + halfSize;
    const dx = x - midX;
    const dz = z - midZ;
    const reach = Math.max(Math.abs(dx) / halfX, Math.abs(dz) / halfZ);
    if (reach >= 1) return { x, z };
    const scale = (1 + hash2(x, z, 11) * 0.35) / Math.max(reach, 1e-3);
    return { x: midX + dx * scale, z: midZ + dz * scale };
  };

  const arcs: readonly SkylineArc[] = [
    // Across the bay: the deep downtown band, then a lower waterfront in front
    // of it. Two layers at different distances is what gives the horizon depth
    // rather than a single cut-out line.
    {
      cx: -820,
      cz: -40,
      radius: 330,
      from: -1.32,
      to: 1.32,
      jitter: 55,
      count: 30,
      heights: [38, 124],
      footprint: [16, 30],
      haze: 1,
      shapes: ['tower', 'tower', 'stepped', 'stepped', 'slab', 'slab', 'block'],
    },
    {
      cx: -620,
      cz: -20,
      radius: 200,
      from: -1.34,
      to: 1.34,
      jitter: 30,
      count: 24,
      heights: [11, 36],
      footprint: [12, 22],
      haze: 0.18,
      shapes: ['block', 'block', 'gabled', 'gabled', 'stack', 'slab'],
    },
    // The headland to the north: hillside blocks stepping up the slope.
    {
      cx: -60,
      cz: -570,
      radius: 205,
      from: 0.42,
      to: 2.72,
      jitter: 46,
      count: 22,
      heights: [14, 62],
      footprint: [13, 26],
      haze: 0.72,
      shapes: ['block', 'slab', 'stepped', 'gabled', 'tower'],
    },
    // The south bank, seen down the long streets.
    {
      cx: 20,
      cz: 575,
      radius: 200,
      from: 3.58,
      to: 5.86,
      jitter: 44,
      count: 20,
      heights: [13, 74],
      footprint: [13, 26],
      haze: 0.86,
      shapes: ['slab', 'stepped', 'tower', 'block', 'stack'],
    },
    // Beyond the ridge to the east: low, and mostly hidden by the hill.
    {
      cx: 585,
      cz: -20,
      radius: 195,
      from: 2.05,
      to: 4.23,
      jitter: 40,
      count: 16,
      heights: [10, 44],
      footprint: [12, 24],
      haze: 0.5,
      shapes: ['block', 'gabled', 'stack', 'slab', 'stepped'],
    },
  ];

  for (const arc of arcs) {
    for (let i = 0; i < arc.count; i += 1) {
      const t = arc.count === 1 ? 0.5 : i / (arc.count - 1);
      const angle = arc.from + (arc.to - arc.from) * t + rng.range(-0.045, 0.045);
      const radius = arc.radius + rng.range(-arc.jitter, arc.jitter);
      const raw = {
        x: arc.cx + Math.cos(angle) * radius,
        z: arc.cz + Math.sin(angle) * radius,
      };
      const footprint = rng.range(arc.footprint[0], arc.footprint[1]);
      const shape = rng.pick(arc.shapes);
      const spot = clearOfCity(raw.x, raw.z, footprint * 1.5);
      // `hash2` on the final position rather than another `rng` draw, so a
      // building's height depends on where it ended up and not on how many
      // draws happened to come before it.
      const height =
        rng.range(arc.heights[0], arc.heights[1]) * (0.78 + hash2(spot.x, spot.z, 3) * 0.5);
      const base = clamp(groundElevation(spot.x, spot.z), SEA_LEVEL, 46);
      const yaw = hash2(spot.x, spot.z, 7) * Math.PI;
      const id = hash2(spot.x, spot.z, 23);
      building(shape, spot.x, spot.z, yaw, footprint, height, base, id, arc.haze);
    }
  }

  const geometry = finish(writer);
  if (geometry) sink.add('skyline', geometry);
}

/** Scrub and trees on the open ground beyond the loop road. */
function scatterOutskirtVegetation(sink: GeometrySink, ground: CityGround): void {
  const rng = createRng('meridian-outskirts');
  const matrix = new Matrix4();
  const scale = new Vector3();

  for (let i = 0; i < 620; i += 1) {
    const x = rng.range(WORLD_BOUNDS.minX + 12, WORLD_BOUNDS.maxX - 12);
    const z = rng.range(WORLD_BOUNDS.minZ + 12, WORLD_BOUNDS.maxZ - 12);

    // Only outside the loop road, and only on dry land above the beach.
    const insideCity = x > -168 && x < 172 && z > -160 && z < 140;
    if (insideCity) continue;
    if (x < shorelineX(z) + 18) continue;

    // Sample through CityGround, not the raw terrain: a point that looks like
    // open ground can still fall inside a street corridor, where the surface
    // sits one kerb higher. Using the raw height there buries the plant.
    const sample = ground.sample(x, z);
    if (sample.surface !== 'grass' && sample.surface !== 'gravel' && sample.surface !== 'sand') {
      continue;
    }
    if (ground.isBuilt(x, z, 0.8)) continue;
    const y = sample.y;
    if (y < SEA_LEVEL + 1.2) continue;

    // Thin the planting out towards the very edge so it fades rather than ends.
    const edgeFade = smoothstep(0, 26, Math.min(x - WORLD_BOUNDS.minX, WORLD_BOUNDS.maxX - x));
    if (rng.next() > edgeFade) continue;

    const treeChance = 0.34 + 0.3 * smoothstep(0, 16, y);
    const prop = rng.next() < treeChance ? 'broadleafTree' : 'shrub';
    const s = prop === 'shrub' ? rng.range(0.7, 1.35) : rng.range(0.8, 1.5);
    scale.set(s * rng.range(0.9, 1.1), s, s * rng.range(0.9, 1.1));
    matrix.makeRotationY(rng.range(0, Math.PI * 2));
    matrix.scale(scale);
    matrix.setPosition(x, y, z);
    sink.instance(prop, matrix);
  }
}

/** Builds everything outside the street grid into the sink. */
export function buildEnvironment(sink: GeometrySink, ground: CityGround): void {
  buildTerrain(sink, ground);
  buildWater(sink);
  buildSeawall(sink);
  buildDistantSkyline(sink);
  scatterOutskirtVegetation(sink, ground);
}
