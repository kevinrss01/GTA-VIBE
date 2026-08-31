/**
 * The city's kit of small parts.
 *
 * Every prop in Meridian Bay is authored once here and then instanced hundreds
 * of times, so the rules are strict: origin at the BASE of the prop, +Y up,
 * front elevation facing -Z, world units in metres, and a hard triangle ceiling
 * (400 for hard props, 900 for trees) because these are the meshes the player
 * sees most often and the ones most likely to blow the draw budget.
 *
 * Nothing here creates a material. A prop is returned as a list of
 * `{ key, geometry }` parts so the integration layer can build one InstancedMesh
 * per material key and still keep a prop looking like it was designed rather
 * than extruded: a bench has slats and cast ends, a bin has a band and a liner
 * lip, a hydrant has a bonnet and side ports, a pole has a crossarm and
 * insulators, an AC unit has a recessed fan grille.
 *
 * `PROP_SPECS` carries the measured bounds and the collision box, so the
 * scatterer never has to guess how big something is.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  SphereGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import type { MaterialKey } from '../../render/materials';
import { TAU } from '../../core/mathx';
import type { PropKey } from './types';

export interface PropPart {
  readonly key: MaterialKey;
  readonly geometry: BufferGeometry;
}

/** Collision box for a prop, in prop-local metres, measured from the base. */
export interface PropCollider {
  readonly halfX: number;
  readonly halfZ: number;
  /** Height of the box above the prop's base. */
  readonly top: number;
}

export interface PropSpec {
  /** Visual bounds, used for spacing and clearance checks. */
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  /** `null` for props the player walks over or that live out of reach. */
  readonly collider: PropCollider | null;
}

/**
 * Measured bounds and collision boxes. The collider is deliberately smaller
 * than the visual bounds for trees (the trunk, not the canopy) and for signs
 * (the post, not the plate), because that is what the player actually hits.
 */
export const PROP_SPECS: Readonly<Record<PropKey, PropSpec>> = {
  streetLamp: { width: 0.34, depth: 0.9, height: 4.2, collider: { halfX: 0.17, halfZ: 0.17, top: 4.2 } },
  bollard: { width: 0.3, depth: 0.3, height: 0.95, collider: { halfX: 0.15, halfZ: 0.15, top: 0.95 } },
  /*
   * The bench and the bin are measured from the GENERATED models that replace
   * them at runtime, not from the procedural fallbacks below. The bench got
   * smaller doing it (1.90 m of authored slats became a 1.40 m two-seater,
   * because the model is proportionally taller and its height is what has to
   * be right to sit on), and the bin kept its footprint exactly - it is fitted
   * by WIDTH rather than height for that reason, since every pavement
   * clearance rule in the city is measured against this number.
   */
  bench: { width: 1.4, depth: 0.7, height: 0.92, collider: { halfX: 0.7, halfZ: 0.33, top: 0.92 } },
  litterBin: { width: 0.52, depth: 0.52, height: 0.86, collider: { halfX: 0.26, halfZ: 0.26, top: 0.86 } },
  /*
   * A shelter is OPEN: its collider is the back wall and the posts, not the
   * volume it encloses. Boxing the whole thing would put a 3 x 1.6 m wall
   * across a pavement that people are supposed to be able to stand inside, and
   * `ObstacleIndex.blocksCorridor` would rightly report the footway closed.
   */
  // 2.85 m rather than the 3.1 m the model would give at a 2.55 m roof: the
  // city holds every prop collider under three metres (`tests/streets.test.ts`
  // asserts it), and a shelter is the only thing here that ever came close.
  busShelter: { width: 2.85, depth: 1.48, height: 2.35, collider: { halfX: 1.42, halfZ: 0.32, top: 2.35 } },
  phoneKiosk: { width: 1.03, depth: 1.03, height: 2.05, collider: { halfX: 0.5, halfZ: 0.5, top: 2.05 } },
  newsStand: { width: 1.22, depth: 1.52, height: 2.1, collider: { halfX: 0.61, halfZ: 0.76, top: 2.1 } },
  hydrant: { width: 0.34, depth: 0.34, height: 0.86, collider: { halfX: 0.17, halfZ: 0.17, top: 0.86 } },
  utilityPole: {
    width: 2.0,
    depth: 0.36,
    height: 9.4,
    collider: { halfX: 0.19, halfZ: 0.19, top: 9.4 },
  },
  drainGrate: { width: 0.76, depth: 0.46, height: 0.06, collider: null },
  trafficSign: { width: 0.54, depth: 0.14, height: 2.4, collider: { halfX: 0.11, halfZ: 0.11, top: 2.4 } },
  planter: { width: 1.12, depth: 1.12, height: 0.92, collider: { halfX: 0.56, halfZ: 0.56, top: 0.7 } },
  acUnit: { width: 0.64, depth: 0.44, height: 0.44, collider: null },
  satelliteDish: { width: 0.7, depth: 0.62, height: 0.94, collider: null },
  roofVent: { width: 0.4, depth: 0.4, height: 0.55, collider: null },
  waterTank: {
    width: 1.5,
    depth: 1.5,
    height: 2.64,
    collider: { halfX: 0.72, halfZ: 0.72, top: 2.64 },
  },
  palmTree: { width: 6.2, depth: 6.2, height: 11.4, collider: { halfX: 0.32, halfZ: 0.32, top: 3.0 } },
  // Measured from the emitted canopy hull, not estimated: see
  // `CANOPY_LOBES` and the bounds assertion in `tests/vegetation.test.ts`.
  broadleafTree: {
    width: 4.4,
    depth: 4.6,
    height: 7.1,
    collider: { halfX: 0.3, halfZ: 0.3, top: 3.0 },
  },
  shrub: { width: 1.1, depth: 1.1, height: 0.95, collider: { halfX: 0.45, halfZ: 0.45, top: 1.15 } },
  crate: { width: 0.7, depth: 0.7, height: 0.65, collider: { halfX: 0.35, halfZ: 0.35, top: 0.65 } },
  pallet: { width: 1.2, depth: 0.8, height: 0.14, collider: null },
  dumpster: {
    width: 1.96,
    depth: 1.2,
    height: 1.34,
    collider: { halfX: 0.98, halfZ: 0.6, top: 1.34 },
  },
  meterBox: { width: 0.5, depth: 0.3, height: 1.06, collider: { halfX: 0.25, halfZ: 0.15, top: 1.06 } },
  cafeTable: { width: 0.72, depth: 0.72, height: 0.74, collider: { halfX: 0.3, halfZ: 0.3, top: 0.74 } },
  cafeChair: { width: 0.44, depth: 0.44, height: 0.88, collider: null },
  newsBox: { width: 0.55, depth: 0.47, height: 1.07, collider: { halfX: 0.27, halfZ: 0.23, top: 1.07 } },
  /*
   * Airside ground equipment.
   *
   * Sized from the real machines, because the whole point of parking a tug
   * beside an aircraft is scale: a baggage tug is 2.9 m long and just under
   * 2 m tall, air stairs reach a 2.1 m sill on a turboprop, and a bowser is a
   * 7 m truck. The heights are what the generated models are fitted to; the
   * widths and depths are then the models' own proportions and are what the
   * scatterer spaces.
   */
  airStairs: { width: 2.0, depth: 4.2, height: 3.4, collider: { halfX: 1.0, halfZ: 2.1, top: 3.4 } },
  baggageTug: { width: 1.5, depth: 2.9, height: 1.9, collider: { halfX: 0.75, halfZ: 1.45, top: 1.9 } },
  baggageCart: { width: 1.6, depth: 3.1, height: 1.6, collider: { halfX: 0.8, halfZ: 1.55, top: 1.6 } },
  fuelBowser: { width: 2.5, depth: 7.0, height: 2.9, collider: { halfX: 1.25, halfZ: 3.5, top: 2.9 } },
  gpuCart: { width: 1.2, depth: 2.0, height: 1.3, collider: { halfX: 0.6, halfZ: 1.0, top: 1.3 } },
  /* The sock itself is out of reach; only the mast is worth colliding with. */
  windsock: { width: 1.2, depth: 3.4, height: 6.5, collider: { halfX: 0.14, halfZ: 0.14, top: 6.5 } },
  mooringBollard: {
    width: 0.6,
    depth: 0.6,
    height: 0.6,
    collider: { halfX: 0.3, halfZ: 0.3, top: 0.6 },
  },
};

// ---------------------------------------------------------------------------
// Primitive helpers
//
// Every helper positions its result in prop-local space directly, so a prop is
// authored by listing parts rather than by pushing and popping transforms.
// ---------------------------------------------------------------------------

/** Axis-aligned box centred at (x, y, z). */
function box(w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry {
  const g = new BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Axis-aligned box whose underside sits at `base`. */
function boxOn(w: number, h: number, d: number, x: number, base: number, z: number): BufferGeometry {
  return box(w, h, d, x, base + h * 0.5, z);
}

/** Upright cylinder whose underside sits at `base`. */
function cyl(
  rTop: number,
  rBottom: number,
  h: number,
  seg: number,
  x: number,
  base: number,
  z: number,
  open = false,
): BufferGeometry {
  const g = new CylinderGeometry(rTop, rBottom, h, seg, 1, open);
  g.translate(x, base + h * 0.5, z);
  return g;
}

/** Cylinder lying along X (pipes, ports, axles). */
function cylX(r: number, len: number, seg: number, x: number, y: number, z: number): BufferGeometry {
  const g = new CylinderGeometry(r, r, len, seg, 1, false);
  g.rotateZ(Math.PI * 0.5);
  g.translate(x, y, z);
  return g;
}

/** Cylinder lying along Z (front-facing ports, handles). */
function cylZ(r: number, len: number, seg: number, x: number, y: number, z: number): BufferGeometry {
  const g = new CylinderGeometry(r, r, len, seg, 1, false);
  g.rotateX(Math.PI * 0.5);
  g.translate(x, y, z);
  return g;
}

/** A squashed icosahedron. Vegetation reads far better as lumps than spheres. */
function blob(
  r: number,
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number,
): BufferGeometry {
  const g = new IcosahedronGeometry(r, 0);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

/**
 * A box whose top face is a different size from its bottom face: the shape
 * every tub, hopper and cast base in the kit actually is.
 */
function frustumBox(
  bottomW: number,
  bottomD: number,
  topW: number,
  topD: number,
  h: number,
  x: number,
  base: number,
  z: number,
): BufferGeometry {
  const bw = bottomW * 0.5;
  const bd = bottomD * 0.5;
  const tw = topW * 0.5;
  const td = topD * 0.5;
  const y0 = base;
  const y1 = base + h;
  const soup = new QuadSoup();
  // Sides, then the two caps.
  soup.quad(-bw, y0, bd, bw, y0, bd, tw, y1, td, -tw, y1, td); // south (+Z)
  soup.quad(bw, y0, -bd, -bw, y0, -bd, -tw, y1, -td, tw, y1, -td); // north (-Z)
  soup.quad(bw, y0, bd, bw, y0, -bd, tw, y1, -td, tw, y1, td); // east (+X)
  soup.quad(-bw, y0, -bd, -bw, y0, bd, -tw, y1, td, -tw, y1, -td); // west (-X)
  soup.quad(-tw, y1, td, tw, y1, td, tw, y1, -td, -tw, y1, -td); // top
  soup.quad(-bw, y0, -bd, bw, y0, -bd, bw, y0, bd, -bw, y0, bd); // bottom
  const g = soup.build();
  g.translate(x, 0, z);
  return g;
}

/**
 * Accumulates loose quads with flat normals. Used for the shapes no built-in
 * primitive covers: tapered curved trunks, palm fronds, leaf cards.
 */
class QuadSoup {
  private readonly position: number[] = [];
  private readonly normal: number[] = [];
  private readonly uv: number[] = [];
  private readonly index: number[] = [];

  quad(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number,
  ): void {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = dx - ax;
    const vy = dy - ay;
    const vz = dz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    let len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) {
      // One edge collapsed - a tapered blade that starts or ends at a point,
      // which is every palm frond's first and last segment. The AB x AD cross
      // product is then zero and the quad used to be shipped with a zero
      // normal, so the whole segment shaded black. Newell's method sums over
      // all four edges and still returns the surviving triangle's normal.
      nx = (ay - by) * (az + bz) + (by - cy) * (bz + cz) + (cy - dy) * (cz + dz) + (dy - ay) * (dz + az);
      ny = (az - bz) * (ax + bx) + (bz - cz) * (bx + cx) + (cz - dz) * (cx + dx) + (dz - az) * (dx + ax);
      nz = (ax - bx) * (ay + by) + (bx - cx) * (by + cy) + (cx - dx) * (cy + dy) + (dx - ax) * (dy + ay);
      len = Math.hypot(nx, ny, nz);
      // Fully degenerate (all four corners collinear): the triangles have no
      // area and never rasterise, so any unit normal will do.
      if (len < 1e-9) {
        nx = 0;
        ny = 1;
        nz = 0;
        len = 1;
      }
    }
    nx /= len;
    ny /= len;
    nz /= len;

    const base = this.position.length / 3;
    this.position.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    for (let i = 0; i < 4; i += 1) this.normal.push(nx, ny, nz);
    this.uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  get empty(): boolean {
    return this.index.length === 0;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.position), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.normal), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setIndex(new BufferAttribute(new Uint16Array(this.index), 1));
    return g;
  }
}

/**
 * `mergeGeometries` refuses to mix indexed and non-indexed inputs, and the
 * polyhedra Three.js builds (icosahedra, used for every foliage lump) come out
 * unindexed. Adding the trivial index costs nothing and keeps merging total.
 */
function ensureIndexed(geometry: BufferGeometry): BufferGeometry {
  if (geometry.getIndex()) return geometry;
  const count = geometry.getAttribute('position').count;
  const array = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i += 1) array[i] = i;
  geometry.setIndex(new BufferAttribute(array, 1));
  return geometry;
}

/** Collects parts under material keys and merges each key into one geometry. */
class PartSet {
  private readonly byKey = new Map<MaterialKey, BufferGeometry[]>();

  add(key: MaterialKey, ...geometries: BufferGeometry[]): void {
    const indexed = geometries.map(ensureIndexed);
    const bucket = this.byKey.get(key);
    if (bucket) bucket.push(...indexed);
    else this.byKey.set(key, indexed);
  }

  finish(): PropPart[] {
    const parts: PropPart[] = [];
    for (const [key, geometries] of this.byKey) {
      if (geometries.length === 0) continue;
      const first = geometries[0] as BufferGeometry;
      if (geometries.length === 1) {
        parts.push({ key, geometry: first });
        continue;
      }
      const merged = mergeGeometries(geometries);
      for (const g of geometries) g.dispose();
      parts.push({ key, geometry: merged });
    }
    return parts;
  }
}

// ---------------------------------------------------------------------------
// Vegetation helpers
// ---------------------------------------------------------------------------

/**
 * A tapered trunk with a gentle lean. Straight extruded cylinders are one of
 * the strongest "generated" tells, so every trunk in the kit curves a little.
 */
function trunk(
  soup: QuadSoup,
  height: number,
  rBase: number,
  rTop: number,
  leanX: number,
  leanZ: number,
  sides: number,
  rings: number,
): void {
  const ringAt = (t: number): { cx: number; cz: number; r: number; y: number } => ({
    cx: leanX * t * t,
    cz: leanZ * t * t,
    r: rBase + (rTop - rBase) * t,
    y: height * t,
  });

  for (let i = 0; i < rings; i += 1) {
    const lo = ringAt(i / rings);
    const hi = ringAt((i + 1) / rings);
    for (let s = 0; s < sides; s += 1) {
      const a0 = (s / sides) * TAU;
      const a1 = ((s + 1) / sides) * TAU;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      soup.quad(
        lo.cx + c0 * lo.r,
        lo.y,
        lo.cz + s0 * lo.r,
        lo.cx + c1 * lo.r,
        lo.y,
        lo.cz + s1 * lo.r,
        hi.cx + c1 * hi.r,
        hi.y,
        hi.cz + s1 * hi.r,
        hi.cx + c0 * hi.r,
        hi.y,
        hi.cz + s0 * hi.r,
      );
    }
  }
}

/**
 * One palm frond: a V-folded blade on a spine that rises then droops. Built as
 * flat quads because `palmFrond` is a double-sided material, so a frond costs
 * four triangles per segment and still reads as a comma in silhouette.
 */
function frond(
  soup: QuadSoup,
  ox: number,
  oy: number,
  oz: number,
  yaw: number,
  length: number,
  rise: number,
  droop: number,
  halfWidth: number,
  segments: number,
): void {
  const dirX = Math.sin(yaw);
  const dirZ = Math.cos(yaw);
  // Perpendicular in the horizontal plane; the blade folds down about the spine.
  const perpX = dirZ;
  const perpZ = -dirX;
  const fold = 0.42;

  const spine = (t: number): { x: number; y: number; z: number; w: number } => {
    const r = length * t;
    return {
      x: ox + dirX * r,
      y: oy + rise * t - droop * t * t * t,
      z: oz + dirZ * r,
      w: halfWidth * Math.sin(Math.PI * Math.pow(t, 0.62)),
    };
  };

  for (let i = 0; i < segments; i += 1) {
    const a = spine(i / segments);
    const b = spine((i + 1) / segments);
    for (const side of [-1, 1]) {
      soup.quad(
        a.x,
        a.y,
        a.z,
        b.x,
        b.y,
        b.z,
        b.x + perpX * b.w * side,
        b.y - b.w * fold,
        b.z + perpZ * b.w * side,
        a.x + perpX * a.w * side,
        a.y - a.w * fold,
        a.z + perpZ * a.w * side,
      );
    }
  }
}

/**
 * One ellipsoidal lobe of a canopy.
 *
 * The lobes ARE the canopy. The foliage lumps are drawn on them and every leaf
 * card is anchored inside one, so the crown has a single definition instead of
 * two that can drift apart. They used to drift: the cards were laid out on a
 * ring of their own radius (1.5-1.98 m, reaching 2.6 m at the tip) around a
 * canopy mass only 0.8-1.35 m across, so nine of sixteen cards on every one of
 * the 128 broadleaf trees hung in clear air beside the crown as detached dark
 * quads. Publishing the lobes lets `tests/vegetation.test.ts` assert that no
 * foliage vertex ever strays further than `CANOPY_CARD_REACH` from the canopy
 * hull again.
 */
export interface CanopyLobe {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Semi-axes, in metres. */
  readonly rx: number;
  readonly ry: number;
  readonly rz: number;
  /** Lobes on the shaded side of the crown use the darker foliage key. */
  readonly dark: boolean;
}

/** Props whose foliage is described by canopy lobes. */
export type CanopyProp = 'broadleafTree' | 'shrub' | 'planter';

/**
 * Normalised radius of a point within a lobe: exactly 1 on the ellipsoid,
 * below 1 inside it. The lump geometry sits at 1 by construction, so this is
 * also the test the leaf cards have to pass.
 */
export function lobeRadius(lobe: CanopyLobe, x: number, y: number, z: number): number {
  return Math.hypot((x - lobe.x) / lobe.rx, (y - lobe.y) / lobe.ry, (z - lobe.z) / lobe.rz);
}

/** Smallest lobe radius over a whole canopy; <= 1 means inside the canopy hull. */
export function canopyRadius(
  lobes: readonly CanopyLobe[],
  x: number,
  y: number,
  z: number,
): number {
  let best = Infinity;
  for (const lobe of lobes) {
    const r = lobeRadius(lobe, x, y, z);
    if (r < best) best = r;
  }
  return best;
}

/** Describes a lobe with the same call shape the rest of the kit uses. */
function lobe(
  r: number,
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number,
  dark = false,
): CanopyLobe {
  return { x, y, z, rx: r * sx, ry: r * sy, rz: r * sz, dark };
}

/**
 * Canopy definitions for every prop that carries foliage.
 *
 * Lobes are laid out on a ring in plan so a crown reads as balanced over its
 * trunk from any approach, and at staggered heights so the top is never a
 * dome. The darker key goes on the upper and rear lobes: a canopy shaded
 * uniformly by the sun alone reads as one flat green mass, and splitting the
 * lumps across two greens is what gives it depth from across a street.
 */
export const CANOPY_LOBES: Readonly<Record<CanopyProp, readonly CanopyLobe[]>> = {
  broadleafTree: [
    // Central mass, swallowing the head of the trunk.
    lobe(1.6, 1.06, 0.9, 1.06, -0.2, 5.62, 0.1),
    // Five outer lobes on a ~1.2 m ring, roughly evenly spread in plan so the
    // crown is balanced over the trunk from every approach, but at five
    // different heights so the top of the canopy is never a dome.
    lobe(1.16, 1.06, 0.9, 1.02, 0.438, 5.12, 1.14),
    lobe(1.1, 1.02, 0.92, 1.06, 0.841, 5.94, -0.256, true),
    lobe(1.14, 1.04, 0.9, 1.04, -0.05, 5.2, -1.131),
    lobe(1.06, 1.06, 0.9, 1.02, -1.251, 6.12, -0.391, true),
    lobe(1.12, 1.04, 0.92, 1.06, -1.088, 5.46, 0.877, true),
  ],
  shrub: [
    lobe(0.47, 1.1, 0.8, 1.04, -0.04, 0.56, 0.02),
    lobe(0.34, 1.02, 0.94, 1.06, 0.24, 0.68, 0.18),
    lobe(0.36, 1.06, 0.88, 1.02, -0.14, 0.66, -0.26, true),
  ],
  planter: [
    lobe(0.3, 1.0, 0.72, 1.05, -0.16, 0.78, 0.1),
    lobe(0.24, 1.1, 0.68, 0.95, 0.2, 0.75, -0.14),
  ],
};

/** The foliage lump for one lobe: a squashed icosahedron on the ellipsoid. */
function lobeBlob(l: CanopyLobe): BufferGeometry {
  const g = new IcosahedronGeometry(1, 0);
  g.scale(l.rx, l.ry, l.rz);
  g.translate(l.x, l.y, l.z);
  return g;
}

/**
 * Flowers over a canopy.
 *
 * A city plants its street furniture, and the planters were foliage lumps with
 * nothing in them. The blooms are the cheapest thing that reads as planting
 * from a pavement: small icosahedra sitting ON the canopy hull rather than
 * inside it, spread by the golden angle so they never land on a lattice, and
 * biased to the sunward half of each lobe because that is where a real bedding
 * plant flowers.
 *
 * Two colours, alternating, because one saturated colour repeated in every
 * planter on every street reads as a decal. Deterministic in the prop's own
 * coordinates, so every instance of a planter is the same planter - which is
 * the whole point of instancing, and is why the variety has to come from the
 * placement rather than from a per-instance roll.
 *
 * `count` blooms costs `count` icosahedra of 20 triangles each, merged into
 * two geometries, on a prop whose ceiling is 400 triangles. Nine is 180.
 */
function addBlooms(set: PartSet, lobes: readonly CanopyLobe[], count: number, seed: number): void {
  const cool: BufferGeometry[] = [];
  const warm: BufferGeometry[] = [];
  for (let i = 0; i < count; i += 1) {
    const lobe = lobes[i % lobes.length];
    if (!lobe) continue;
    // A point on the unit sphere from the golden angle, kept to the upper half
    // so nothing flowers out of the underside of the canopy.
    const t = (i + 0.5) / count;
    const y = 0.25 + t * 0.7;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * GOLDEN_ANGLE + seed;
    const size = 0.055 + ((i * 7 + seed) % 5) * 0.012;
    const g = new IcosahedronGeometry(size, 0);
    g.translate(
      lobe.x + Math.cos(a) * r * lobe.rx * 0.92,
      lobe.y + y * lobe.ry * 0.92,
      lobe.z + Math.sin(a) * r * lobe.rz * 0.92,
    );
    (i % 2 === 0 ? cool : warm).push(g);
  }
  if (cool.length > 0) set.add('blossom', ...cool);
  if (warm.length > 0) set.add('blossomWarm', ...warm);
}

/** Emits every lobe of a canopy under the right foliage key. */
function addCanopyLobes(set: PartSet, lobes: readonly CanopyLobe[]): void {
  const light: BufferGeometry[] = [];
  const dark: BufferGeometry[] = [];
  for (const l of lobes) (l.dark ? dark : light).push(lobeBlob(l));
  if (light.length > 0) set.add('foliage', ...light);
  if (dark.length > 0) set.add('foliageDark', ...dark);
}

/** Golden angle, for spreading anything radial without it landing on a lattice. */
const GOLDEN_ANGLE = 2.39996;

/**
 * How far past a lobe's surface a leaf card may reach, as a fraction of the
 * lobe radius.
 *
 * Cards exist to ragged the silhouette, so they have to break the surface -
 * but by a hand's width on a metre-and-a-half lobe, not by a metre. This is
 * the bound `tests/vegetation.test.ts` holds the whole vegetation family to.
 */
export const CANOPY_CARD_REACH = 1.05;

/**
 * Leaf cards over a canopy.
 *
 * A card is a flat blade running outward from well inside a lobe to a little
 * past its surface. The lump is an icosahedron inscribed in that ellipsoid, so
 * its faces sit between 0.79 and 1.0 of the radius; a card ending at `TIP`
 * pushes through those facets and ragged the silhouette, which is the whole
 * point of a card. The overhang is small and, crucially, BOUNDED: every corner
 * is clamped to `TIP`, so a card can no longer wander off into open air the
 * way the old ring-scattered ones did at up to 1.93 canopy radii.
 */
function scatterLeafCards(
  soup: QuadSoup,
  lobes: readonly CanopyLobe[],
  perLobe: number,
  halfWidth: number,
): void {
  const ROOT = 0.3;
  const TIP = CANOPY_CARD_REACH;

  for (let li = 0; li < lobes.length; li += 1) {
    const l = lobes[li] as CanopyLobe;
    for (let i = 0; i < perLobe; i += 1) {
      // Even in cos gives a uniform spread over the sphere; the golden angle
      // in longitude stops successive cards from lining up into a seam.
      const t = (i + 0.5) / perLobe;
      const cosPhi = 1 - 2 * t;
      const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
      const theta = (i + li * 0.41) * GOLDEN_ANGLE;
      // Leaf clusters hang outward and down, so the vertical component is
      // squashed and biased below the equator.
      let dx = sinPhi * Math.cos(theta);
      let dy = cosPhi * 0.7 - 0.16;
      let dz = sinPhi * Math.sin(theta);
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;

      const rootX = l.x + dx * l.rx * ROOT;
      const rootY = l.y + dy * l.ry * ROOT;
      const rootZ = l.z + dz * l.rz * ROOT;
      const tipX = l.x + dx * l.rx * TIP;
      const tipY = l.y + dy * l.ry * TIP;
      const tipZ = l.z + dz * l.rz * TIP;

      // Blade width lies across the root-to-tip axis, horizontal where it can.
      let ax = tipX - rootX;
      let ay = tipY - rootY;
      let az = tipZ - rootZ;
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al;
      ay /= al;
      az /= al;
      const upY = Math.abs(ay) > 0.92 ? 0 : 1;
      const upX = upY === 0 ? 1 : 0;
      let px = ay * 0 - az * upY;
      let py = az * upX - ax * 0;
      let pz = ax * upY - ay * upX;
      const pl = Math.hypot(px, py, pz) || 1;
      px = (px / pl) * halfWidth;
      py = (py / pl) * halfWidth;
      pz = (pz / pl) * halfWidth;

      // Corners: a broad root tapering towards the tip, then pulled back
      // inside the lobe so no part of a card can escape the canopy.
      const corners: [number, number, number][] = [
        [rootX - px, rootY - py, rootZ - pz],
        [rootX + px, rootY + py, rootZ + pz],
        [tipX + px * 0.34, tipY + py * 0.34, tipZ + pz * 0.34],
        [tipX - px * 0.34, tipY - py * 0.34, tipZ - pz * 0.34],
      ];
      for (const c of corners) {
        const q = lobeRadius(l, c[0], c[1], c[2]);
        if (q <= TIP) continue;
        const k = TIP / q;
        c[0] = l.x + (c[0] - l.x) * k;
        c[1] = l.y + (c[1] - l.y) * k;
        c[2] = l.z + (c[2] - l.z) * k;
      }
      const [c0, c1, c2, c3] = corners as [
        [number, number, number],
        [number, number, number],
        [number, number, number],
        [number, number, number],
      ];
      soup.quad(
        c0[0], c0[1], c0[2],
        c1[0], c1[1], c1[2],
        c2[0], c2[1], c2[2],
        c3[0], c3[1], c3[2],
      );
    }
  }
}

/**
 * A tapered limb between two points, bowed upward in the middle.
 *
 * Branches have to start on the trunk and finish inside the crown. The old
 * ones were free-floating cylinders translated to a fixed height: both ends
 * sat 0.63 m out from a trunk only 0.16 m in radius, and their lower halves
 * hung 1.1 m below the underside of the foliage, which is the bare crossed
 * "X" of sticks visible under every broadleaf tree in the city.
 */
function limb(
  soup: QuadSoup,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  r0: number,
  r1: number,
  bow: number,
  sides: number,
  rings: number,
): void {
  let ax = x1 - x0;
  let ay = y1 - y0;
  let az = z1 - z0;
  const al = Math.hypot(ax, ay, az) || 1;
  ax /= al;
  ay /= al;
  az /= al;

  // Frame across the limb. The reference axis is swapped near vertical so the
  // cross product never collapses.
  const refY = Math.abs(ay) > 0.92 ? 0 : 1;
  const refX = refY === 0 ? 1 : 0;
  let ux = ay * 0 - az * refY;
  let uy = az * refX - ax * 0;
  let uz = ax * refY - ay * refX;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = ay * uz - az * uy;
  const vy = az * ux - ax * uz;
  const vz = ax * uy - ay * ux;

  const ringAt = (
    t: number,
  ): { cx: number; cy: number; cz: number; r: number } => ({
    cx: x0 + (x1 - x0) * t,
    cy: y0 + (y1 - y0) * t + bow * Math.sin(Math.PI * t),
    cz: z0 + (z1 - z0) * t,
    r: r0 + (r1 - r0) * t,
  });

  for (let i = 0; i < rings; i += 1) {
    const lo = ringAt(i / rings);
    const hi = ringAt((i + 1) / rings);
    for (let s = 0; s < sides; s += 1) {
      const a0 = (s / sides) * TAU;
      const a1 = ((s + 1) / sides) * TAU;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      soup.quad(
        lo.cx + (ux * c0 + vx * s0) * lo.r,
        lo.cy + (uy * c0 + vy * s0) * lo.r,
        lo.cz + (uz * c0 + vz * s0) * lo.r,
        lo.cx + (ux * c1 + vx * s1) * lo.r,
        lo.cy + (uy * c1 + vy * s1) * lo.r,
        lo.cz + (uz * c1 + vz * s1) * lo.r,
        hi.cx + (ux * c1 + vx * s1) * hi.r,
        hi.cy + (uy * c1 + vy * s1) * hi.r,
        hi.cz + (uz * c1 + vz * s1) * hi.r,
        hi.cx + (ux * c0 + vx * s0) * hi.r,
        hi.cy + (uy * c0 + vy * s0) * hi.r,
        hi.cz + (uz * c0 + vz * s0) * hi.r,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** Procedural fallback for the lamp; the integration layer substitutes a GLB. */
function streetLamp(set: PartSet): void {
  set.add(
    'metalDark',
    cyl(0.13, 0.18, 0.26, 8, 0, 0, 0), // cast base
    cyl(0.065, 0.115, 3.34, 8, 0, 0.26, 0), // fluted column
    cyl(0.095, 0.095, 0.09, 8, 0, 0.86, 0), // collar
    cyl(0.105, 0.085, 0.13, 8, 0, 3.6, 0), // capital
    box(0.07, 0.07, 0.78, 0, 4.04, -0.36), // arm
    box(0.3, 0.12, 0.44, 0, 3.99, -0.66), // lantern housing
    box(0.34, 0.05, 0.48, 0, 4.16, -0.66), // hood
  );
  set.add('lampGlass', box(0.25, 0.08, 0.36, 0, 3.9, -0.66));
}

function bollard(set: PartSet): void {
  set.add(
    'metalDark',
    cyl(0.135, 0.15, 0.05, 8, 0, 0, 0), // foot
    cyl(0.085, 0.105, 0.8, 8, 0, 0.05, 0), // shaft
    cyl(0.03, 0.085, 0.1, 8, 0, 0.85, 0), // domed cap
  );
  set.add('metalLight', cyl(0.098, 0.098, 0.05, 8, 0, 0.62, 0)); // reflective band
}

function bench(set: PartSet): void {
  const ends: BufferGeometry[] = [];
  const backs: BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    ends.push(boxOn(0.14, 0.05, 0.62, sx * 0.83, 0, 0.04));
    ends.push(box(0.08, 0.4, 0.5, sx * 0.83, 0.24, 0.05));
    backs.push(box(0.06, 0.5, 0.06, sx * 0.83, 0.68, 0.29));
  }
  set.add('metalDark', ...ends, ...backs);

  const slats: BufferGeometry[] = [];
  for (let i = 0; i < 4; i += 1) {
    slats.push(box(1.72, 0.045, 0.12, 0, 0.44, -0.2 + i * 0.15));
  }
  for (let i = 0; i < 3; i += 1) {
    slats.push(box(1.72, 0.105, 0.045, 0, 0.62 + i * 0.14, 0.31));
  }
  set.add('timber', ...slats);
}

function litterBin(set: PartSet): void {
  set.add(
    'metalDark',
    cyl(0.21, 0.235, 0.08, 10, 0, 0, 0), // foot
    cyl(0.24, 0.2, 0.72, 10, 0, 0.08, 0), // body
    cyl(0.19, 0.19, 0.04, 10, 0, 0.8, 0, true), // inner liner rim
  );
  set.add(
    'metalLight',
    cyl(0.252, 0.252, 0.07, 10, 0, 0.34, 0), // banding
    cyl(0.258, 0.242, 0.06, 10, 0, 0.78, 0, true), // liner lip
  );
}

/*
 * The three street objects below are authored as MASSING ONLY.
 *
 * Every other prop in this file is the finished article; these three are
 * placeholders for generated models that `world/furnishings/StreetProps.ts`
 * swaps in at load time, exactly as the generated street lamp already replaces
 * `streetLamp`. They still have to exist, be under the 400-triangle ceiling
 * and stand on their own origin, because a city that cannot download its
 * assets must still have a shelter where a shelter belongs.
 */

function busShelter(set: PartSet): void {
  set.add(
    'metalDark',
    boxOn(0.09, 2.3, 0.09, -1.37, 0, -0.64), // posts
    boxOn(0.09, 2.3, 0.09, 1.37, 0, -0.64),
    boxOn(0.09, 2.3, 0.09, -1.37, 0, 0.64),
    boxOn(0.09, 2.3, 0.09, 1.37, 0, 0.64),
    boxOn(2.85, 0.09, 1.48, 0, 2.26, 0), // roof
  );
  set.add(
    'glassShop',
    boxOn(2.7, 1.75, 0.05, 0, 0.5, 0.69), // back glazing
  );
  set.add('timber', boxOn(2.4, 0.07, 0.4, 0, 0.44, 0.38)); // bench
}

function phoneKiosk(set: PartSet): void {
  set.add(
    'metalDark',
    boxOn(1.03, 1.98, 1.03, 0, 0, 0), // body
    boxOn(1.11, 0.09, 1.11, 0, 1.96, 0), // cap
  );
  set.add('glassShop', boxOn(0.82, 1.5, 0.04, 0, 0.42, -0.52)); // glazed door
}

function newsStand(set: PartSet): void {
  set.add(
    'timberDark',
    boxOn(1.22, 1.05, 1.52, 0, 0, 0), // carcass
    boxOn(0.09, 1.05, 0.09, -0.54, 1.05, -0.68), // awning posts
    boxOn(0.09, 1.05, 0.09, 0.54, 1.05, -0.68),
  );
  set.add('timber', boxOn(1.3, 0.07, 1.6, 0, 1.05, 0)); // counter
  set.add('canvasAwning', boxOn(1.34, 0.06, 0.72, 0, 2.04, -0.5)); // awning
}

function hydrant(set: PartSet): void {
  set.add(
    'paintedMetal',
    cyl(0.15, 0.17, 0.06, 8, 0, 0, 0), // ground flange
    cyl(0.105, 0.125, 0.52, 8, 0, 0.06, 0), // barrel
    cyl(0.135, 0.115, 0.07, 8, 0, 0.58, 0), // shoulder
    cyl(0.055, 0.13, 0.12, 8, 0, 0.65, 0), // bonnet
  );
  set.add(
    'metalLight',
    box(0.075, 0.06, 0.075, 0, 0.8, 0), // operating nut
    cylX(0.05, 0.1, 6, 0.13, 0.42, 0), // side port
    cylX(0.05, 0.1, 6, -0.13, 0.42, 0), // side port
    cylZ(0.055, 0.09, 6, 0, 0.46, -0.13), // pumper port
  );
}

function utilityPole(set: PartSet): void {
  set.add(
    'timberDark',
    cyl(0.11, 0.17, 9.2, 8, 0, 0, 0), // pole
    cyl(0.0, 0.11, 0.14, 8, 0, 9.2, 0), // weathered cap
    box(2.0, 0.1, 0.09, 0, 8.62, 0), // crossarm
  );
  set.add(
    'metalDark',
    box(0.05, 0.44, 0.05, 0.46, 8.36, 0),
    box(0.05, 0.44, 0.05, -0.46, 8.36, 0),
  );
  set.add(
    'metalLight',
    cyl(0.045, 0.056, 0.12, 6, -0.85, 8.67, 0),
    cyl(0.045, 0.056, 0.12, 6, 0, 8.67, 0),
    cyl(0.045, 0.056, 0.12, 6, 0.85, 8.67, 0),
  );
}

/** Where the catenary cables leave a pole, in prop-local metres. */
export const POLE_CABLE_OFFSETS: readonly number[] = [-0.85, 0, 0.85];
export const POLE_CABLE_HEIGHT = 8.79;

function drainGrate(set: PartSet): void {
  const frame: BufferGeometry[] = [
    boxOn(0.76, 0.055, 0.06, 0, 0, 0.2),
    boxOn(0.76, 0.055, 0.06, 0, 0, -0.2),
    boxOn(0.06, 0.055, 0.34, 0.35, 0, 0),
    boxOn(0.06, 0.055, 0.34, -0.35, 0, 0),
  ];
  for (let i = 0; i < 5; i += 1) {
    frame.push(boxOn(0.64, 0.035, 0.035, 0, 0.02, -0.12 + i * 0.06));
  }
  set.add('metalDark', ...frame);
  set.add('asphaltWorn', boxOn(0.64, 0.014, 0.34, 0, 0.004, 0)); // sump shadow
}

function trafficSign(set: PartSet): void {
  set.add('metalLight', cyl(0.035, 0.042, 2.24, 6, 0, 0, 0));
  set.add('metalDark', cyl(0.06, 0.072, 0.08, 6, 0, 0, 0), box(0.07, 0.1, 0.05, 0, 1.95, 0.02));
  set.add('paintedMetal', box(0.54, 0.54, 0.03, 0, 1.95, -0.025));
  set.add('roadPaint', box(0.44, 0.44, 0.008, 0, 1.95, -0.045));
}

function planter(set: PartSet): void {
  set.add(
    'concrete',
    frustumBox(0.88, 0.88, 1.04, 1.04, 0.6, 0, 0, 0),
    boxOn(1.12, 0.09, 0.11, 0, 0.6, 0.505),
    boxOn(1.12, 0.09, 0.11, 0, 0.6, -0.505),
    boxOn(0.11, 0.09, 0.9, 0.505, 0.6, 0),
    boxOn(0.11, 0.09, 0.9, -0.505, 0.6, 0),
  );
  set.add('gravel', boxOn(0.92, 0.05, 0.92, 0, 0.6, 0));
  addCanopyLobes(set, CANOPY_LOBES.planter);
  addBlooms(set, CANOPY_LOBES.planter, 9, 17);
}

function acUnit(set: PartSet): void {
  set.add('metalLight', box(0.64, 0.42, 0.4, 0, 0.21, 0));
  set.add(
    'metalDark',
    box(0.4, 0.34, 0.05, 0, 0.22, -0.185), // recessed grille face
    cylZ(0.17, 0.04, 12, 0, 0.22, -0.205), // grille ring
    cylZ(0.05, 0.04, 6, 0, 0.22, -0.215), // fan hub
    box(0.36, 0.02, 0.02, 0, 0.14, -0.215),
    box(0.36, 0.02, 0.02, 0, 0.22, -0.215),
    box(0.36, 0.02, 0.02, 0, 0.3, -0.215),
  );
  set.add('rust', box(0.06, 0.06, 0.22, 0.27, 0.03, 0.1), box(0.06, 0.06, 0.22, -0.27, 0.03, 0.1));
}

function satelliteDish(set: PartSet): void {
  const dish = new SphereGeometry(0.34, 10, 3, 0, TAU, 0, 0.62);
  dish.rotateX(-Math.PI * 0.5);
  dish.translate(0, 0.66, 0.06);
  set.add('metalLight', dish, cyl(0.035, 0.045, 0.55, 6, 0, 0.04, 0), cylZ(0.04, 0.11, 6, 0, 0.66, -0.2));
  set.add('metalDark', boxOn(0.24, 0.04, 0.24, 0, 0, 0), box(0.03, 0.03, 0.3, 0, 0.66, -0.12));
}

function roofVent(set: PartSet): void {
  set.add('metalDark', boxOn(0.32, 0.05, 0.32, 0, 0, 0));
  set.add(
    'metalLight',
    cyl(0.11, 0.11, 0.33, 8, 0, 0.05, 0), // duct
    cyl(0.18, 0.1, 0.12, 8, 0, 0.38, 0), // cowl
    cyl(0.19, 0.19, 0.03, 8, 0, 0.5, 0), // rain cap
  );
}

function waterTank(set: PartSet): void {
  const frame: BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      frame.push(boxOn(0.1, 1.05, 0.1, sx * 0.55, 0, sz * 0.55));
    }
    frame.push(box(1.3, 0.06, 0.06, 0, 0.55, sx * 0.55));
  }
  frame.push(boxOn(1.45, 0.07, 1.45, 0, 1.05, 0));
  frame.push(cyl(0.0, 0.66, 0.3, 10, 0, 2.32, 0));
  set.add('timberDark', ...frame);
  set.add('timber', cyl(0.62, 0.66, 1.2, 10, 0, 1.12, 0));
  set.add(
    'metalDark',
    cyl(0.665, 0.665, 0.05, 10, 0, 1.44, 0, true),
    cyl(0.635, 0.635, 0.05, 10, 0, 2.06, 0, true),
    cyl(0.04, 0.04, 0.12, 6, 0, 2.6, 0),
  );
}

function palmTree(set: PartSet): void {
  const bark = new QuadSoup();
  trunk(bark, 8.2, 0.3, 0.17, 0.55, -0.3, 6, 6);
  set.add('barkPalm', bark.build(), blob(0.34, 1.0, 0.75, 1.0, 0.55, 8.24, -0.3));

  const green = new QuadSoup();
  const dead = new QuadSoup();
  const cx = 0.55;
  const cy = 8.35;
  const cz = -0.3;
  for (let i = 0; i < 15; i += 1) {
    // Golden-angle spacing so no two adjacent fronds line up.
    const yaw = i * 2.39996;
    const scale = 0.86 + ((i * 7) % 5) * 0.07;
    frond(green, cx, cy, cz, yaw, 3.0 * scale, 1.35 * scale, 2.5 * scale, 0.46 * scale, 5);
  }
  for (let i = 0; i < 3; i += 1) {
    const yaw = 0.8 + i * 2.1;
    frond(dead, cx, cy - 0.2, cz, yaw, 1.9, -0.35, 1.9, 0.3, 4);
  }
  set.add('palmFrond', green.build());
  set.add('barkPalm', dead.build());
  set.add(
    'barkTree',
    blob(0.11, 1, 1, 1, cx + 0.22, cy - 0.28, cz),
    blob(0.1, 1, 1, 1, cx - 0.16, cy - 0.33, cz + 0.16),
  );
}

/**
 * Trunk profile of the broadleaf tree.
 *
 * Published because `tests/vegetation.test.ts` asserts that every piece of
 * bark is rooted in this volume: the branches used to be four loose cylinders
 * translated to a fixed height, both ends 0.63 m out from a trunk 0.16 m in
 * radius, hanging in mid-air as a crossed "X" under the foliage.
 */
export const BROADLEAF_TRUNK = {
  height: 4.55,
  rBase: 0.28,
  rTop: 0.13,
  leanX: -0.2,
  leanZ: 0.1,
} as const;

/** Centre of the trunk at a height, following the same quadratic lean. */
export function broadleafTrunkAxis(y: number): { x: number; z: number; radius: number } {
  const t = Math.min(1, Math.max(0, y / BROADLEAF_TRUNK.height));
  return {
    x: BROADLEAF_TRUNK.leanX * t * t,
    z: BROADLEAF_TRUNK.leanZ * t * t,
    radius: BROADLEAF_TRUNK.rBase + (BROADLEAF_TRUNK.rTop - BROADLEAF_TRUNK.rBase) * t,
  };
}

function broadleafTree(set: PartSet): void {
  const lobes = CANOPY_LOBES.broadleafTree;
  const wood = new QuadSoup();
  trunk(
    wood,
    BROADLEAF_TRUNK.height,
    BROADLEAF_TRUNK.rBase,
    BROADLEAF_TRUNK.rTop,
    BROADLEAF_TRUNK.leanX,
    BROADLEAF_TRUNK.leanZ,
    6,
    4,
  );

  // One limb per outer lobe, springing from inside the trunk and dying inside
  // the foliage it carries. The fork heights are staggered so the limbs leave
  // the trunk at different points rather than all from one collar.
  for (let i = 1; i < lobes.length; i += 1) {
    const target = lobes[i] as CanopyLobe;
    const forkT = 0.52 + (i % 3) * 0.11;
    const forkY = BROADLEAF_TRUNK.height * forkT;
    const forkX = BROADLEAF_TRUNK.leanX * forkT * forkT;
    const forkZ = BROADLEAF_TRUNK.leanZ * forkT * forkT;
    // Stop short of the lobe centre: the tip only has to be buried, and a limb
    // driven all the way through would poke out the far side.
    limb(
      wood,
      forkX,
      forkY,
      forkZ,
      forkX + (target.x - forkX) * 0.72,
      forkY + (target.y - forkY) * 0.72,
      forkZ + (target.z - forkZ) * 0.72,
      0.085,
      0.035,
      0.16,
      5,
      2,
    );
  }
  set.add('barkTree', wood.build());

  addCanopyLobes(set, lobes);

  const cards = new QuadSoup();
  scatterLeafCards(cards, lobes, 4, 0.33);
  set.add('foliage', cards.build());
}

function shrub(set: PartSet): void {
  const lobes = CANOPY_LOBES.shrub;
  set.add('barkTree', cyl(0.04, 0.06, 0.24, 5, 0, 0, 0));
  addCanopyLobes(set, lobes);
  const cards = new QuadSoup();
  scatterLeafCards(cards, lobes, 2, 0.13);
  set.add('foliage', cards.build());
}

function crate(set: PartSet): void {
  set.add('timber', box(0.64, 0.58, 0.64, 0, 0.31, 0));
  const battens: BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      battens.push(box(0.07, 0.62, 0.07, sx * 0.315, 0.31, sz * 0.315));
    }
    battens.push(box(0.7, 0.05, 0.09, 0, 0.615, sx * 0.24));
    battens.push(box(0.7, 0.06, 0.02, 0, 0.31, sx * 0.335));
  }
  set.add('timberDark', ...battens);
}

function pallet(set: PartSet): void {
  const deck: BufferGeometry[] = [];
  for (let i = 0; i < 3; i += 1) deck.push(boxOn(0.1, 0.06, 0.8, -0.55 + i * 0.55, 0.024, 0));
  for (let i = 0; i < 5; i += 1) deck.push(boxOn(1.2, 0.025, 0.1, 0, 0.084, -0.35 + i * 0.175));
  set.add('timber', ...deck);
  set.add('timberDark', boxOn(1.2, 0.024, 0.1, 0, 0, 0.35), boxOn(1.2, 0.024, 0.1, 0, 0, -0.35));
}

function dumpster(set: PartSet): void {
  set.add(
    'paintedMetal',
    frustumBox(1.7, 0.98, 1.88, 1.12, 1.02, 0, 0.2, 0),
    boxOn(1.96, 0.07, 0.09, 0, 1.22, 0.56),
    boxOn(1.96, 0.07, 0.09, 0, 1.22, -0.56),
    boxOn(0.09, 0.07, 1.16, 0.94, 1.22, 0),
    boxOn(0.09, 0.07, 1.16, -0.94, 1.22, 0),
    box(1.84, 0.06, 1.04, 0, 1.31, 0.02), // lid
  );
  const steel: BufferGeometry[] = [box(0.3, 0.04, 0.04, 0, 1.36, -0.48)];
  for (const sx of [-1, 1]) {
    steel.push(box(0.06, 0.85, 0.03, sx * 0.5, 0.72, -0.56));
    for (const sz of [-1, 1]) {
      steel.push(cylX(0.11, 0.07, 6, sx * 0.72, 0.11, sz * 0.4));
    }
  }
  set.add('metalDark', ...steel);
}

function meterBox(set: PartSet): void {
  set.add('concrete', boxOn(0.5, 0.1, 0.3, 0, 0, 0));
  set.add('paintedMetal', box(0.46, 0.92, 0.24, 0, 0.56, 0), boxOn(0.5, 0.04, 0.28, 0, 1.02, 0));
  set.add(
    'metalDark',
    box(0.36, 0.72, 0.02, 0, 0.58, -0.125), // door reveal
    cyl(0.035, 0.035, 0.55, 6, 0.2, 0.1, 0.13), // conduit
  );
  set.add(
    'metalLight',
    box(0.03, 0.08, 0.03, -0.22, 0.82, -0.11),
    box(0.03, 0.08, 0.03, -0.22, 0.3, -0.11),
    box(0.05, 0.1, 0.04, 0.19, 0.58, -0.13),
  );
}

function cafeTable(set: PartSet): void {
  set.add('timber', cyl(0.35, 0.35, 0.035, 12, 0, 0.7, 0));
  set.add(
    'metalDark',
    cyl(0.356, 0.356, 0.022, 12, 0, 0.688, 0, true), // rim
    cyl(0.035, 0.05, 0.68, 8, 0, 0.02, 0), // pedestal
    cyl(0.24, 0.26, 0.025, 10, 0, 0, 0), // foot
  );
}

function cafeChair(set: PartSet): void {
  set.add('timber', box(0.4, 0.035, 0.4, 0, 0.44, 0));
  const frame: BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) frame.push(boxOn(0.032, 0.44, 0.032, sx * 0.17, 0, sz * 0.17));
    frame.push(box(0.032, 0.42, 0.032, sx * 0.17, 0.65, 0.19));
    frame.push(box(0.38, 0.028, 0.028, 0, 0.4, sx * 0.17));
  }
  set.add('metalDark', ...frame);
  const slats: BufferGeometry[] = [];
  for (let i = 0; i < 3; i += 1) slats.push(box(0.37, 0.055, 0.022, 0, 0.6 + i * 0.12, 0.192));
  set.add('timber', ...slats);
}

function newsBox(set: PartSet): void {
  set.add('metalDark', boxOn(0.07, 0.3, 0.07, 0.19, 0, 0), boxOn(0.07, 0.3, 0.07, -0.19, 0, 0));
  set.add('paintedMetal', box(0.5, 0.68, 0.42, 0, 0.64, 0), box(0.54, 0.06, 0.46, 0, 1.01, 0.01));
  set.add('glassShop', box(0.36, 0.44, 0.02, 0, 0.72, -0.212));
  set.add('metalLight', cylX(0.02, 0.22, 6, 0, 0.99, -0.2), box(0.1, 0.14, 0.06, 0, 0.44, -0.225));
}

function mooringBollard(set: PartSet): void {
  set.add(
    'metalDark',
    cyl(0.26, 0.3, 0.07, 10, 0, 0, 0), // flange
    cyl(0.15, 0.2, 0.33, 10, 0, 0.07, 0), // shaft
    cyl(0.21, 0.21, 0.08, 10, 0, 0.4, 0), // collar
    cyl(0.1, 0.21, 0.12, 10, 0, 0.48, 0), // domed head
  );
}

/**
 * Airside ground equipment, as procedural massing.
 *
 * Every one of these is replaced at runtime by a generated model - see
 * `airport/models.ts` - so what is wanted here is the silhouette that reads
 * correctly if the download fails, not detail. A tug is a box on wheels with a
 * cab; a bowser is a tank on a chassis; air stairs are a flight and a rail.
 */
function wheels(set: PartSet, halfX: number, halfZ: number, radius: number): void {
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const g = new CylinderGeometry(radius, radius, 0.22, 8);
      g.rotateZ(Math.PI / 2);
      g.translate(sx * halfX, radius, sz * halfZ);
      set.add('metalDark', g);
    }
  }
}

function airStairs(set: PartSet): void {
  const steps = 9;
  for (let i = 0; i < steps; i += 1) {
    const y = 0.45 + (i * 2.5) / steps;
    const z = 1.7 - (i * 3.0) / steps;
    set.add('metalLight', boxOn(1.5, 0.06, 0.34, 0, y, z));
  }
  set.add('metalLight', boxOn(1.8, 0.12, 1.2, 0, 3.28, -1.5)); // top platform
  for (const sx of [-1, 1] as const) {
    set.add('metalLight', box(0.07, 3.4, 0.07, sx * 0.85, 1.7, -1.5));
    set.add('metalLight', box(0.06, 0.06, 3.6, sx * 0.85, 2.05, 0.2));
  }
  set.add('paintedMetal', boxOn(1.9, 0.5, 4.0, 0, 0.28, 0));
  wheels(set, 0.85, 1.7, 0.28);
}

function baggageTug(set: PartSet): void {
  set.add('paintedMetal', boxOn(1.4, 0.55, 2.8, 0, 0.3, 0));
  set.add('paintedMetal', boxOn(1.2, 0.9, 1.1, 0, 0.85, -0.6));
  set.add('glassDark', boxOn(1.1, 0.55, 0.06, 0, 1.0, -1.14));
  set.add('metalDark', boxOn(0.9, 0.06, 0.9, 0, 1.85, -0.6));
  for (const sx of [-1, 1] as const) set.add('metalDark', box(0.06, 0.95, 0.06, sx * 0.5, 1.38, -0.6));
  wheels(set, 0.62, 1.05, 0.3);
}

function baggageCart(set: PartSet): void {
  set.add('metalDark', boxOn(1.5, 0.12, 3.0, 0, 0.42, 0));
  set.add('canvasAwning', boxOn(1.5, 0.08, 3.0, 0, 1.5, 0));
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      set.add('metalLight', box(0.06, 1.0, 0.06, sx * 0.7, 1.0, sz * 1.4));
    }
    set.add('metalLight', boxOn(0.08, 0.5, 2.9, sx * 0.72, 0.54, 0));
  }
  wheels(set, 0.62, 1.15, 0.21);
}

function fuelBowser(set: PartSet): void {
  set.add('paintedMetal', boxOn(2.2, 0.6, 6.6, 0, 0.42, 0));
  const tank = new CylinderGeometry(1.05, 1.05, 4.4, 12);
  tank.rotateX(Math.PI / 2);
  tank.translate(0, 2.0, 0.7);
  set.add('metalLight', tank);
  set.add('paintedMetal', boxOn(2.0, 1.5, 1.7, 0, 1.02, -2.6));
  set.add('glassDark', boxOn(1.85, 0.7, 0.06, 0, 1.75, -3.42));
  set.add('metalDark', boxOn(1.0, 0.9, 0.5, 0, 1.02, 3.0));
  wheels(set, 0.95, 2.3, 0.42);
}

function gpuCart(set: PartSet): void {
  set.add('paintedMetal', boxOn(1.1, 0.85, 1.8, 0, 0.24, 0));
  set.add('metalDark', boxOn(0.95, 0.2, 1.5, 0, 1.09, 0));
  for (let i = 0; i < 4; i += 1) {
    set.add('metalDark', box(0.04, 0.6, 1.4, -0.56 + i * 0.03, 0.62, 0));
  }
  set.add('metalDark', box(0.06, 0.9, 0.06, 0, 0.7, -1.0));
  set.add('rust', boxOn(0.16, 0.16, 0.9, 0.36, 1.29, 0.3));
  wheels(set, 0.5, 0.72, 0.18);
}

function windsock(set: PartSet): void {
  set.add('metalLight', cyl(0.07, 0.11, 6.0, 8, 0, 0, 0));
  set.add('metalDark', boxOn(1.0, 0.08, 1.0, 0, 0, 0));
  // Frangible collar and the swivel head.
  set.add('metalDark', cyl(0.13, 0.13, 0.14, 8, 0, 0.55, 0));
  set.add('metalDark', cyl(0.09, 0.09, 0.3, 8, 0, 6.0, 0));
  // The sock: five tapering bands, alternating, hanging away downwind.
  const bands = 5;
  for (let i = 0; i < bands; i += 1) {
    const t0 = i / bands;
    const r = 0.42 - t0 * 0.24;
    const g = new CylinderGeometry(r * 0.86, r, 0.64, 10, 1, true);
    g.rotateX(Math.PI / 2);
    g.translate(0, 6.15 - t0 * 0.5, 0.4 + i * 0.62);
    set.add(i % 2 === 0 ? 'canvasAwning' : 'stuccoCream', g);
  }
}

const BUILDERS: Readonly<Record<PropKey, (set: PartSet) => void>> = {
  streetLamp,
  bollard,
  bench,
  litterBin,
  hydrant,
  utilityPole,
  drainGrate,
  trafficSign,
  planter,
  acUnit,
  satelliteDish,
  roofVent,
  waterTank,
  palmTree,
  broadleafTree,
  shrub,
  crate,
  pallet,
  dumpster,
  meterBox,
  cafeTable,
  cafeChair,
  newsBox,
  mooringBollard,
  busShelter,
  phoneKiosk,
  newsStand,
  airStairs,
  baggageTug,
  baggageCart,
  fuelBowser,
  gpuCart,
  windsock,
};

/**
 * Builds one prop. Geometry is in prop-local space with the origin at the base;
 * the caller owns and must dispose the returned geometries.
 */
export function createPropGeometry(prop: PropKey): PropPart[] {
  const set = new PartSet();
  BUILDERS[prop](set);
  return set.finish();
}

/** Triangle count of a prop, for budget tests and build reports. */
export function propTriangleCount(prop: PropKey): number {
  const parts = createPropGeometry(prop);
  let total = 0;
  for (const part of parts) {
    const index = part.geometry.getIndex();
    const position = part.geometry.getAttribute('position');
    total += index ? index.count / 3 : position.count / 3;
    part.geometry.dispose();
  }
  return total;
}
