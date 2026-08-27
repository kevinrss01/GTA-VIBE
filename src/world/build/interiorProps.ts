/**
 * The interior fit-out kit.
 *
 * `InteriorBuilder` owns the shell of a room - floor, walls, ceiling, door
 * reveal. Everything that makes the room a *place* rather than a box lives
 * here: the coordinate frame furniture is authored in, the handful of geometry
 * primitives every fitting is made of, and one layout function per interior
 * kind.
 *
 * ## The room frame
 *
 * Every enterable building has its door in one of four axis-aligned
 * elevations, so a room-local frame can be axis-aligned too and furniture never
 * needs an arbitrary rotation. Local coordinates are:
 *
 * - `u` runs along the front elevation, 0 at one end of the room, `width` at
 *   the other;
 * - `v` runs into the room, 0 at the inside face of the front (door) wall,
 *   `depth` at the back wall;
 * - `y` is world height in metres, because floor and ceiling levels are
 *   absolute and mixing the two would be a constant source of mistakes.
 *
 * That means a layout written once reads the same in a room whose door faces
 * north as in one whose door faces east, and the world-space boxes it produces
 * stay axis-aligned, so a collider is an exact fit rather than a bound.
 *
 * ## Budget
 *
 * Geometry is accumulated per material key and merged once per interior, so a
 * whole café costs one draw call per material. Boxes are 12 triangles, planes
 * 2, and an 8-sided post 32; the layouts below are sized against a 4,000
 * triangle budget per interior.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Matrix4,
  PlaneGeometry,
  Vector3,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { clamp, type Rect } from '../../core/mathx';
import { createRng, type Rng } from '../../core/rng';
import type { MaterialKey } from '../../render/materials';
import type { Facing, InteriorKind, Parcel } from '../CityPlan';
import { doorwayFor, type Doorway } from './doorway';
import type { GeometrySink } from './types';

/** Distance the interior lining is held back from the parcel edge. */
export const WALL_INSET = 0.25;
/** Thickness of the interior lining itself. */
export const LINING = 0.07;
/** Half-width of the clear route the player needs from the door to the room. */
const ENTRY_CLEARANCE = 0.58;
/** Player chest height band a collider has to miss to leave the entry clear. */
const ENTRY_BAND: readonly [number, number] = [0.12, 1.75];

/** An axis-aligned box in room-local coordinates. */
export interface LocalBox {
  readonly u: readonly [number, number];
  readonly v: readonly [number, number];
  readonly y: readonly [number, number];
}

/** A point in room-local coordinates. */
export interface LocalPoint {
  readonly u: number;
  readonly v: number;
  readonly y: number;
}

/**
 * Which material plays which role in a given interior. Interiors are always
 * lighter than the exterior they sit behind: a room lit by two or three point
 * lights needs a high-albedo shell or it reads as a cave.
 */
export interface InteriorPalette {
  readonly floor: MaterialKey;
  readonly wall: MaterialKey;
  readonly ceiling: MaterialKey;
  /** Skirting, architraves, dado. */
  readonly trim: MaterialKey;
  /** Joists, trusses, coffer ribs. */
  readonly structure: MaterialKey;
  /** Counter and shelf carcasses. */
  readonly joinery: MaterialKey;
  /** Counter tops and table tops. */
  readonly surface: MaterialKey;
  readonly metal: MaterialKey;
  readonly fabric: MaterialKey;
  /** The visible part of a light fitting. */
  readonly glow: MaterialKey;
  readonly threshold: MaterialKey;
}

export interface Room {
  readonly parcel: Parcel;
  readonly kind: InteriorKind;
  readonly door: Doorway;
  readonly facing: Facing;
  /** Footprint of the lining, inset from the parcel edge on all four sides. */
  readonly rect: Rect;
  readonly floorY: number;
  readonly ceilY: number;
  /** Extent along the front elevation. */
  readonly width: number;
  /** Extent from the front wall to the back wall. */
  readonly depth: number;
  readonly doorU: number;
  readonly doorWidth: number;
  readonly doorHeight: number;
  readonly palette: InteriorPalette;
  readonly rng: Rng;
  /** Route the player walks in on; solid fittings keep clear of it. */
  readonly entryPath: readonly { readonly u: number; readonly v: number }[];
}

/** Everything a layout function needs: the room, the geometry batch, the sink. */
export interface Fitout {
  readonly room: Room;
  readonly batch: GeometryBatch;
  readonly sink: GeometrySink;
}

// ---------------------------------------------------------------------------
// Geometry batching
// ---------------------------------------------------------------------------

/**
 * Collects geometry per material key and merges it once, so an interior costs
 * one geometry per material rather than one per box.
 */
export class GeometryBatch {
  private readonly byKey = new Map<MaterialKey, BufferGeometry[]>();

  add(key: MaterialKey, geometry: BufferGeometry): void {
    const bucket = this.byKey.get(key);
    if (bucket) bucket.push(geometry);
    else this.byKey.set(key, [geometry]);
  }

  /** Merges each key's geometry and hands ownership to the sink. */
  flush(sink: GeometrySink): void {
    for (const [key, parts] of this.byKey) {
      const first = parts[0];
      if (!first) continue;
      if (parts.length === 1) {
        sink.add(key, first);
        continue;
      }
      const merged = mergeGeometries(parts);
      // The sources are transient scratch geometry; the merge copied them.
      for (const part of parts) part.dispose();
      sink.add(key, merged);
    }
    this.byKey.clear();
  }
}

// ---------------------------------------------------------------------------
// Room frame
// ---------------------------------------------------------------------------

const PALETTES: Readonly<Record<InteriorKind, InteriorPalette>> = {
  cafe: {
    floor: 'timber',
    wall: 'stuccoCream',
    ceiling: 'stuccoCream',
    trim: 'timberDark',
    structure: 'timberDark',
    joinery: 'timberDark',
    surface: 'timber',
    metal: 'metalDark',
    fabric: 'canvasAwning',
    glow: 'signEmissiveWarm',
    threshold: 'stoneAshlar',
  },
  /*
   * The Vibe: a converted harbour warehouse, so board-marked concrete rather
   * than plaster, dark metal everywhere the light has to come off something,
   * and the magenta sign material for the glow instead of the warm one every
   * other room in the city uses. That one swap is most of the read - a club is
   * a dark room with coloured light in it, and `signEmissive` is the only
   * material in the palette that is not a shade of daylight.
   */
  nightclub: {
    floor: 'metalDark',
    wall: 'concreteBoard',
    ceiling: 'concrete',
    trim: 'metalDark',
    structure: 'metalDark',
    joinery: 'timberDark',
    surface: 'metalDark',
    metal: 'metalDark',
    fabric: 'canvasAwning',
    glow: 'signEmissive',
    threshold: 'stoneAshlar',
  },
  store: {
    floor: 'tileFloor',
    wall: 'stuccoSand',
    ceiling: 'stuccoCream',
    trim: 'timberDark',
    structure: 'timber',
    joinery: 'timber',
    surface: 'timberDark',
    metal: 'metalLight',
    fabric: 'canvasAwning',
    glow: 'signEmissiveWarm',
    threshold: 'stoneAshlar',
  },
  /*
   * A licensed gun shop in the Old Quarter: warm timber cabinetry under a pale
   * stone counter top, with the dark stain kept for trim and the rack behind
   * the counter. Measured in the browser, not chosen from a swatch - a
   * `timberDark` carcass under four strip lights renders as a black slab, and
   * a room of black slabs is exactly the "slapdash" the fit-out is fixing.
   */
  gunStore: {
    floor: 'timber',
    wall: 'stuccoSand',
    ceiling: 'stuccoCream',
    trim: 'timberDark',
    structure: 'timberDark',
    joinery: 'timber',
    surface: 'stoneAshlar',
    metal: 'metalLight',
    fabric: 'canvasAwning',
    glow: 'signEmissiveWarm',
    threshold: 'stoneAshlar',
  },
  marketHall: {
    floor: 'plazaStone',
    wall: 'brickBuff',
    ceiling: 'concrete',
    trim: 'concrete',
    structure: 'metalDark',
    joinery: 'timber',
    surface: 'timberDark',
    metal: 'metalLight',
    fabric: 'canvasAwning',
    glow: 'signEmissiveWarm',
    threshold: 'stoneAshlar',
  },
  lobby: {
    floor: 'plazaStone',
    wall: 'stoneAshlar',
    ceiling: 'stuccoCream',
    trim: 'stoneAshlar',
    structure: 'stuccoCream',
    joinery: 'timberDark',
    surface: 'stoneAshlar',
    metal: 'metalLight',
    fabric: 'canvasAwning',
    glow: 'signEmissiveWarm',
    threshold: 'stoneAshlar',
  },
  workshop: {
    floor: 'concrete',
    wall: 'concrete',
    ceiling: 'concreteBoard',
    trim: 'metalDark',
    structure: 'metalDark',
    joinery: 'timber',
    surface: 'timberDark',
    metal: 'metalLight',
    fabric: 'shutter',
    glow: 'lampGlass',
    threshold: 'metalDark',
  },
  stairhall: {
    floor: 'tileFloor',
    wall: 'stuccoMint',
    ceiling: 'stuccoCream',
    trim: 'timberDark',
    structure: 'timberDark',
    joinery: 'timberDark',
    surface: 'timber',
    metal: 'metalDark',
    fabric: 'canvasAwning',
    glow: 'signEmissiveWarm',
    threshold: 'stoneAshlar',
  },
};

/** Ceiling height for each kind, held under whatever the shell can carry. */
function ceilingHeight(parcel: Parcel, kind: InteriorKind): number {
  const roof = parcel.groundStoreyHeight + (parcel.storeys - 1) * parcel.storeyHeight;
  // A single-storey room has to fit under the ground floor's structural slab.
  const single = parcel.groundStoreyHeight - 0.14;
  switch (kind) {
    case 'cafe':
      return clamp(3.2, 2.5, single);
    case 'store':
    case 'gunStore':
      return clamp(3.05, 2.5, single);
    // Taller than a shop and shorter than a market: a club wants headroom over
    // the floor for the rig, and it is still one storey of a harbour terrace.
    case 'nightclub':
      return clamp(3.9, 2.8, Math.max(single, parcel.groundStoreyHeight - 0.14));
    case 'lobby':
      return clamp(3.6, 2.7, single);
    case 'workshop':
      return clamp(5.0, 3.0, single);
    // A market hall takes the whole volume it can get; so does a stairwell,
    // which is double height so the stair has somewhere to go.
    case 'marketHall':
      return clamp(9.0, 4.0, Math.max(single, roof - 1.2));
    case 'stairhall':
      return clamp(parcel.groundStoreyHeight + parcel.storeyHeight - 0.25, 3.0, roof - 0.9);
  }
}

/** Builds the local frame for a parcel's interior. */
export function makeRoom(parcel: Parcel, kind: InteriorKind): Room {
  const door = doorwayFor(parcel);
  const rect: Rect = {
    minX: parcel.rect.minX + WALL_INSET,
    maxX: parcel.rect.maxX - WALL_INSET,
    minZ: parcel.rect.minZ + WALL_INSET,
    maxZ: parcel.rect.maxZ - WALL_INSET,
  };
  const alongX = parcel.facing === 'north' || parcel.facing === 'south';
  const width = alongX ? rect.maxX - rect.minX : rect.maxZ - rect.minZ;
  const depth = alongX ? rect.maxZ - rect.minZ : rect.maxX - rect.minX;
  const doorU = alongX ? door.x - rect.minX : door.z - rect.minZ;
  const floorY = parcel.groundY;

  return {
    parcel,
    kind,
    door,
    facing: parcel.facing,
    rect,
    floorY,
    ceilY: floorY + ceilingHeight(parcel, kind),
    width,
    depth,
    doorU,
    doorWidth: door.width,
    doorHeight: door.height,
    palette: PALETTES[kind],
    rng: createRng(parcel.seed ^ 0x1b7f4a11),
    // Door threshold, the landing just inside it, then the middle of the room.
    // `doorLanding` uses 1.8 m from the façade, which is 1.8 - WALL_INSET here.
    entryPath: [
      { u: doorU, v: -0.2 },
      { u: doorU, v: 1.8 - WALL_INSET },
      { u: width / 2, v: depth / 2 },
    ],
  };
}

/** Room-local to world. The four facings differ only by which axis is which. */
export function toWorld(room: Room, u: number, v: number): { x: number; z: number } {
  switch (room.facing) {
    case 'north':
      return { x: room.rect.minX + u, z: room.rect.minZ + v };
    case 'south':
      return { x: room.rect.minX + u, z: room.rect.maxZ - v };
    case 'west':
      return { x: room.rect.minX + v, z: room.rect.minZ + u };
    case 'east':
      return { x: room.rect.maxX - v, z: room.rect.minZ + u };
  }
}

/** World-space bounds of a local box. */
export function worldRect(room: Room, box: LocalBox): Rect {
  const a = toWorld(room, box.u[0], box.v[0]);
  const b = toWorld(room, box.u[1], box.v[1]);
  return {
    minX: Math.min(a.x, b.x),
    maxX: Math.max(a.x, b.x),
    minZ: Math.min(a.z, b.z),
    maxZ: Math.max(a.z, b.z),
  };
}

// ---------------------------------------------------------------------------
// Entry route
// ---------------------------------------------------------------------------

/** Slab test: does a segment touch an axis-aligned rectangle in the uv plane? */
function segmentHitsRect(
  au: number,
  av: number,
  bu: number,
  bv: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
): boolean {
  let tMin = 0;
  let tMax = 1;
  const du = bu - au;
  const dv = bv - av;

  const slab = (origin: number, delta: number, min: number, max: number): boolean => {
    if (Math.abs(delta) < 1e-9) return origin >= min && origin <= max;
    const t0 = (min - origin) / delta;
    const t1 = (max - origin) / delta;
    tMin = Math.max(tMin, Math.min(t0, t1));
    tMax = Math.min(tMax, Math.max(t0, t1));
    return tMax >= tMin;
  };

  if (!slab(au, du, u0, u1)) return false;
  if (!slab(av, dv, v0, v1)) return false;
  return tMax >= tMin;
}

/**
 * True if a solid fitting would stand in the way of somebody walking in.
 *
 * Only fittings that occupy the band a walker's body passes through count; a
 * hanging sign at 2.4 m or a skirting board at 0.1 m is not an obstruction.
 */
export function blocksEntry(room: Room, box: LocalBox): boolean {
  const low = room.floorY + ENTRY_BAND[0];
  const high = room.floorY + ENTRY_BAND[1];
  if (box.y[1] <= low || box.y[0] >= high) return false;

  const u0 = Math.min(box.u[0], box.u[1]) - ENTRY_CLEARANCE;
  const u1 = Math.max(box.u[0], box.u[1]) + ENTRY_CLEARANCE;
  const v0 = Math.min(box.v[0], box.v[1]) - ENTRY_CLEARANCE;
  const v1 = Math.max(box.v[0], box.v[1]) + ENTRY_CLEARANCE;

  for (let i = 1; i < room.entryPath.length; i += 1) {
    const a = room.entryPath[i - 1];
    const b = room.entryPath[i];
    if (!a || !b) continue;
    if (segmentHitsRect(a.u, a.v, b.u, b.v, u0, v0, u1, v1)) return true;
  }
  return false;
}

/** Whether a solid fitting may be placed here at all. */
export function canPlace(room: Room, box: LocalBox): boolean {
  return !blocksEntry(room, box);
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const MIN_SIZE = 0.004;

function pushBox(ctx: Fitout, key: MaterialKey, box: LocalBox): Rect | null {
  const rect = worldRect(ctx.room, box);
  const w = rect.maxX - rect.minX;
  const d = rect.maxZ - rect.minZ;
  const h = box.y[1] - box.y[0];
  if (w < MIN_SIZE || d < MIN_SIZE || h < MIN_SIZE) return null;
  const geometry = new BoxGeometry(w, h, d);
  geometry.translate((rect.minX + rect.maxX) / 2, (box.y[0] + box.y[1]) / 2, (rect.minZ + rect.maxZ) / 2);
  ctx.batch.add(key, geometry);
  return rect;
}

/** Geometry only: trim, anything above head height, anything too small to hit. */
export function addBox(ctx: Fitout, key: MaterialKey, box: LocalBox): void {
  pushBox(ctx, key, box);
}

/**
 * Geometry plus a solid collider. Returns false and adds nothing when the
 * fitting would stand in the doorway route, so a layout can fall back.
 */
export function addSolid(ctx: Fitout, key: MaterialKey, box: LocalBox): boolean {
  if (blocksEntry(ctx.room, box)) return false;
  const rect = pushBox(ctx, key, box);
  if (!rect) return false;
  ctx.sink.collider({
    minX: rect.minX,
    minZ: rect.minZ,
    maxX: rect.maxX,
    maxZ: rect.maxZ,
    bottom: box.y[0],
    top: box.y[1],
    solid: true,
  });
  return true;
}

/** Geometry plus a walkable platform: floors, steps, landings, decks. */
export function addPlatform(ctx: Fitout, key: MaterialKey, box: LocalBox): void {
  const rect = pushBox(ctx, key, box);
  if (!rect) return;
  ctx.sink.collider({
    minX: rect.minX,
    minZ: rect.minZ,
    maxX: rect.maxX,
    maxZ: rect.maxZ,
    bottom: box.y[0],
    top: box.y[1],
    solid: false,
  });
}

/**
 * Registers a collider with no geometry of its own (walls, barriers, the
 * bounds of something built from struts). Walls pass `force` because they are
 * the room and are laid out around the doorway rather than checked against it.
 */
export function addCollider(ctx: Fitout, box: LocalBox, solid = true, force = false): boolean {
  if (solid && !force && blocksEntry(ctx.room, box)) return false;
  const rect = worldRect(ctx.room, box);
  ctx.sink.collider({
    minX: rect.minX,
    minZ: rect.minZ,
    maxX: rect.maxX,
    maxZ: rect.maxZ,
    bottom: box.y[0],
    top: box.y[1],
    solid,
  });
  return true;
}

/** A horizontal quad. Two triangles, used for floors, ceilings and floor decals. */
export function addQuad(
  ctx: Fitout,
  key: MaterialKey,
  u: readonly [number, number],
  v: readonly [number, number],
  y: number,
  faceUp: boolean,
): void {
  const rect = worldRect(ctx.room, { u, v, y: [y, y] });
  const w = rect.maxX - rect.minX;
  const d = rect.maxZ - rect.minZ;
  if (w < MIN_SIZE || d < MIN_SIZE) return;
  const geometry = new PlaneGeometry(w, d);
  geometry.rotateX(faceUp ? -Math.PI / 2 : Math.PI / 2);
  geometry.translate((rect.minX + rect.maxX) / 2, y, (rect.minZ + rect.maxZ) / 2);
  ctx.batch.add(key, geometry);
}

/**
 * A box turned about its own vertical axis. Chairs and tables at a slight
 * angle are most of what stops a room reading as a spreadsheet; the collider
 * is the rotated box's bounding square, which is close enough to bump into.
 */
export function addYawBox(
  ctx: Fitout,
  key: MaterialKey,
  centre: { readonly u: number; readonly v: number },
  size: { readonly du: number; readonly dv: number },
  y: readonly [number, number],
  yaw: number,
  solid = false,
): void {
  const { room } = ctx;
  const alongX = room.facing === 'north' || room.facing === 'south';
  const dx = alongX ? size.du : size.dv;
  const dz = alongX ? size.dv : size.du;
  const h = y[1] - y[0];
  if (dx < MIN_SIZE || dz < MIN_SIZE || h < MIN_SIZE) return;

  const cos = Math.abs(Math.cos(yaw));
  const sin = Math.abs(Math.sin(yaw));
  const hx = (dx / 2) * cos + (dz / 2) * sin;
  const hz = (dx / 2) * sin + (dz / 2) * cos;
  const hu = alongX ? hx : hz;
  const hv = alongX ? hz : hx;
  const bounds: LocalBox = {
    u: [centre.u - hu, centre.u + hu],
    v: [centre.v - hv, centre.v + hv],
    y,
  };
  if (solid && blocksEntry(room, bounds)) return;

  const world = toWorld(room, centre.u, centre.v);
  const geometry = new BoxGeometry(dx, h, dz);
  geometry.rotateY(yaw);
  geometry.translate(world.x, (y[0] + y[1]) / 2, world.z);
  ctx.batch.add(key, geometry);
  if (solid) addCollider(ctx, bounds, true);
}

/**
 * A member running between two arbitrary points: a truss diagonal, a stair
 * string, a light drop. `width` widens the cross-section across the run, which
 * is what turns a strut into the raking soffit under a flight.
 */
export function addStrut(
  ctx: Fitout,
  key: MaterialKey,
  a: LocalPoint,
  b: LocalPoint,
  thickness: number,
  width = thickness,
): void {
  const { room } = ctx;
  const wa = toWorld(room, a.u, a.v);
  const wb = toWorld(room, b.u, b.v);
  const dir = new Vector3(wb.x - wa.x, b.y - a.y, wb.z - wa.z);
  const length = dir.length();
  if (length < MIN_SIZE || thickness < MIN_SIZE || width < MIN_SIZE) return;
  dir.divideScalar(length);

  // An explicit basis rather than the shortest rotation from +Z: the shortest
  // rotation rolls the section about the run, which twists anything that is
  // not square (a stair soffit would end up on its side).
  const right = new Vector3(0, 1, 0).cross(dir);
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  right.normalize();
  const up = new Vector3().copy(dir).cross(right).normalize();

  const geometry = new BoxGeometry(width, thickness, length);
  const position = new Vector3((wa.x + wb.x) / 2, (a.y + b.y) / 2, (wa.z + wb.z) / 2);
  const basis = new Matrix4().makeBasis(right, up, dir);
  basis.setPosition(position);
  geometry.applyMatrix4(basis);
  ctx.batch.add(key, geometry);
}

/** A round post, stool leg, pipe or drum. */
export function addPost(
  ctx: Fitout,
  key: MaterialKey,
  u: number,
  v: number,
  y: readonly [number, number],
  radius: number,
  segments = 8,
): void {
  const h = y[1] - y[0];
  if (h < MIN_SIZE || radius < MIN_SIZE) return;
  const world = toWorld(ctx.room, u, v);
  const geometry = new CylinderGeometry(radius, radius, h, segments, 1);
  geometry.translate(world.x, (y[0] + y[1]) / 2, world.z);
  ctx.batch.add(key, geometry);
}

/** A tapered shade, lamp cone or planter. */
export function addCone(
  ctx: Fitout,
  key: MaterialKey,
  u: number,
  v: number,
  y: readonly [number, number],
  radiusTop: number,
  radiusBottom: number,
  segments = 8,
): void {
  const h = y[1] - y[0];
  if (h < MIN_SIZE) return;
  const world = toWorld(ctx.room, u, v);
  const geometry = new CylinderGeometry(radiusTop, radiusBottom, h, segments, 1, true);
  geometry.translate(world.x, (y[0] + y[1]) / 2, world.z);
  ctx.batch.add(key, geometry);
}

// ---------------------------------------------------------------------------
// Light fittings
// ---------------------------------------------------------------------------

/** Interior light colour: a warm domestic lamp, not the sun. */
const WARM = 0xffd2a1;
const COOL_WORK = 0xffe9c9;

export interface LampOptions {
  readonly intensity?: number;
  readonly distance?: number;
  readonly color?: number;
}

/**
 * A pendant on a drop, with the light request at the bulb. The fitting is
 * always modelled: an unexplained pool of light is one of the strongest tells
 * that a scene was assembled rather than built.
 */
export function addPendant(ctx: Fitout, u: number, v: number, bulbY: number, options: LampOptions = {}): void {
  const { room } = ctx;
  const shadeTop = bulbY + 0.2;
  addStrut(ctx, room.palette.metal, { u, v, y: room.ceilY }, { u, v, y: shadeTop }, 0.035);
  addBox(ctx, room.palette.metal, {
    u: [u - 0.06, u + 0.06],
    v: [v - 0.06, v + 0.06],
    y: [room.ceilY - 0.06, room.ceilY],
  });
  addCone(ctx, room.palette.metal, u, v, [bulbY, shadeTop], 0.07, 0.21);
  addBox(ctx, room.palette.glow, {
    u: [u - 0.09, u + 0.09],
    v: [v - 0.09, v + 0.09],
    y: [bulbY - 0.05, bulbY + 0.03],
  });
  addLight(ctx, u, v, bulbY - 0.08, options);
}

/** A batten or strip fitting fixed close to the ceiling. */
export function addStripLight(
  ctx: Fitout,
  u: readonly [number, number],
  v: number,
  y: number,
  options: LampOptions = {},
): void {
  const { room } = ctx;
  addBox(ctx, room.palette.metal, {
    u,
    v: [v - 0.13, v + 0.13],
    y: [y + 0.06, y + 0.14],
  });
  addBox(ctx, room.palette.glow, {
    u: [u[0] + 0.06, u[1] - 0.06],
    v: [v - 0.1, v + 0.1],
    y: [y, y + 0.06],
  });
  addStrut(ctx, room.palette.metal, { u: u[0] + 0.3, v, y: room.ceilY }, { u: u[0] + 0.3, v, y: y + 0.14 }, 0.03);
  addStrut(ctx, room.palette.metal, { u: u[1] - 0.3, v, y: room.ceilY }, { u: u[1] - 0.3, v, y: y + 0.14 }, 0.03);
  addLight(ctx, (u[0] + u[1]) / 2, v, y - 0.05, options);
}

/**
 * A wall-mounted bracket lamp. `inward` is +1 on the front wall and -1 on the
 * back wall, so the bracket always reaches into the room.
 */
export function addSconce(
  ctx: Fitout,
  u: number,
  v: number,
  y: number,
  inward: 1 | -1 = 1,
  options: LampOptions = {},
): void {
  const { room } = ctx;
  const arm = v + inward * 0.16;
  const head = v + inward * 0.3;
  addBox(ctx, room.palette.metal, {
    u: [u - 0.05, u + 0.05],
    v: [Math.min(v, arm), Math.max(v, arm)],
    y: [y - 0.04, y + 0.04],
  });
  addBox(ctx, room.palette.glow, {
    u: [u - 0.11, u + 0.11],
    v: [Math.min(arm, head), Math.max(arm, head)],
    y: [y - 0.11, y + 0.11],
  });
  addLight(ctx, u, head, y, { intensity: 1.5, distance: 8, ...options });
}

/**
 * Requests a point light in room-local coordinates.
 *
 * ## Why every request is lifted
 *
 * An interior gets between two and five point lights and no sun: the building
 * shadows it out. What is left is the hemisphere term, whose sky colour is a
 * pale blue, and on an up-facing surface that is most of the light a floor
 * receives. Measured from screenshots, a warm timber floor two metres from the
 * nearest fitting rendered as navy. The fix inside this module's control is to
 * spend the whole of the band the interior budget allows rather than the
 * middle of it, so every request is scaled towards the top and clamped there.
 *
 * The band itself is the budget, and it is not moved: `tests/interiors.test.ts`
 * holds intensity to 1.4-2.4 and distance to 8-14 m, and the COUNT of lights
 * per room and across the city is untouched.
 */
const LIGHT_LIFT = 1.15;

export function addLight(ctx: Fitout, u: number, v: number, y: number, options: LampOptions = {}): void {
  const world = toWorld(ctx.room, u, v);
  ctx.sink.light({
    x: world.x,
    y,
    z: world.z,
    color: options.color ?? WARM,
    intensity: clamp((options.intensity ?? 1.9) * LIGHT_LIFT, 1.4, 2.4),
    distance: clamp((options.distance ?? 11) * LIGHT_LIFT, 8, 14),
    // Interiors are small and fully artificially lit, so their lights matter
    // more than a street lamp the player only ever sees from a distance.
    priority: 5,
  });
}

// ---------------------------------------------------------------------------
// Shared fittings
// ---------------------------------------------------------------------------

/** A counter run with a recessed kick, a proud top and an optional till. */
export function addCounter(
  ctx: Fitout,
  u: readonly [number, number],
  v: readonly [number, number],
  height = 0.95,
): boolean {
  const { room } = ctx;
  const y = room.floorY;
  const body: LocalBox = { u: [u[0], u[1]], v: [v[0], v[1]], y: [y, y + height] };
  if (!canPlace(room, body)) return false;

  // Plinth is held back so the counter front reads as joinery, not a wall.
  addBox(ctx, room.palette.trim, {
    u: [u[0] + 0.07, u[1] - 0.07],
    v: [v[0] + 0.07, v[1] - 0.07],
    y: [y, y + 0.13],
  });
  addSolid(ctx, room.palette.joinery, {
    u: [u[0], u[1]],
    v: [v[0], v[1]],
    y: [y + 0.13, y + height - 0.05],
  });
  addBox(ctx, room.palette.surface, {
    u: [u[0] - 0.04, u[1] + 0.04],
    v: [v[0] - 0.05, v[1] + 0.03],
    y: [y + height - 0.05, y + height],
  });
  return true;
}

/**
 * A run of wall shelving: boards, brackets and a scatter of stock.
 *
 * `axis` is the direction the run travels in; `depth` is the shallow range
 * across it, so the same call works on a back wall and on a flank wall.
 */
export function addShelfRun(
  ctx: Fitout,
  axis: 'u' | 'v',
  long: readonly [number, number],
  depth: readonly [number, number],
  heights: readonly number[],
  goodsPerShelf: number,
  goodsKeys: readonly MaterialKey[],
): void {
  const { room, room: { rng } } = ctx;
  if (long[1] - long[0] < 0.5) return;
  const shelf = (
    a: readonly [number, number],
    b: readonly [number, number],
    y: readonly [number, number],
  ): LocalBox => (axis === 'u' ? { u: a, v: b, y } : { u: b, v: a, y });

  for (const h of heights) {
    const y = room.floorY + h;
    addBox(ctx, room.palette.joinery, shelf(long, depth, [y, y + 0.045]));
    for (const end of [
      [long[0] + 0.02, long[0] + 0.08],
      [long[1] - 0.08, long[1] - 0.02],
    ] as const) {
      addBox(ctx, room.palette.trim, shelf(end, depth, [y - 0.16, y]));
    }
    const length = long[1] - long[0];
    for (let i = 0; i < goodsPerShelf; i += 1) {
      const key = goodsKeys[i % goodsKeys.length] ?? room.palette.joinery;
      const centre = long[0] + 0.22 + ((length - 0.44) * (i + 0.5)) / goodsPerShelf + rng.range(-0.05, 0.05);
      const w = rng.range(0.07, 0.16);
      const tall = rng.range(0.14, 0.3);
      addBox(
        ctx,
        key,
        shelf(
          [centre - w / 2, centre + w / 2],
          [depth[0] + 0.05, depth[1] - rng.range(0.04, 0.1)],
          [y + 0.045, y + 0.045 + tall],
        ),
      );
    }
  }
}

/** A stack of crates, jittered so it reads as stacked rather than assembled. */
export function addCrateStack(ctx: Fitout, u: number, v: number, count: number, seedYaw = 0): void {
  const { room, room: { rng } } = ctx;
  let y = room.floorY;
  for (let i = 0; i < count; i += 1) {
    const w = rng.range(0.52, 0.72);
    const d = rng.range(0.46, 0.62);
    const h = rng.range(0.3, 0.42);
    addYawBox(
      ctx,
      i % 3 === 2 ? room.palette.trim : room.palette.joinery,
      { u: u + rng.range(-0.09, 0.09), v: v + rng.range(-0.09, 0.09) },
      { du: w, dv: d },
      [y, y + h],
      seedYaw + rng.range(-0.22, 0.22),
      i === 0,
    );
    y += h;
  }
}

/** A chair: seat, back and a leg block. Two boxes short of furniture, but reads. */
export function addChair(
  ctx: Fitout,
  u: number,
  v: number,
  yaw: number,
  backOffset: { readonly du: number; readonly dv: number },
): void {
  const { room } = ctx;
  const y = room.floorY;
  if (!canPlace(room, { u: [u - 0.34, u + 0.34], v: [v - 0.34, v + 0.34], y: [y, y + 0.92] })) return;
  addYawBox(ctx, room.palette.surface, { u, v }, { du: 0.44, dv: 0.42 }, [y + 0.42, y + 0.48], yaw, true);
  addYawBox(
    ctx,
    room.palette.joinery,
    { u: u + backOffset.du, v: v + backOffset.dv },
    { du: 0.44 - Math.abs(backOffset.du) * 0.8, dv: 0.42 - Math.abs(backOffset.dv) * 0.8 },
    [y + 0.48, y + 0.92],
    yaw,
  );
  addYawBox(ctx, room.palette.joinery, { u, v }, { du: 0.34, dv: 0.32 }, [y, y + 0.42], yaw);
}

/** A pedestal table. */
export function addTable(ctx: Fitout, u: number, v: number, radius: number, yaw: number): boolean {
  const { room } = ctx;
  const y = room.floorY;
  const bounds: LocalBox = {
    u: [u - radius, u + radius],
    v: [v - radius, v + radius],
    y: [y, y + 0.76],
  };
  if (!canPlace(room, bounds)) return false;
  addYawBox(ctx, room.palette.surface, { u, v }, { du: radius * 2, dv: radius * 2 }, [y + 0.7, y + 0.76], yaw, true);
  addBox(ctx, room.palette.metal, { u: [u - 0.05, u + 0.05], v: [v - 0.05, v + 0.05], y: [y + 0.06, y + 0.7] });
  addYawBox(ctx, room.palette.metal, { u, v }, { du: radius * 1.1, dv: radius * 1.1 }, [y, y + 0.06], yaw);
  return true;
}

/**
 * A flight of steps. Every tread is emitted as a walkable platform so the
 * player controller can climb it; the rise is held under the step height a
 * walker can manage.
 */
export interface Flight {
  /** Local u of the bottom of the flight. */
  readonly u0: number;
  /** Local u of the top of the flight. */
  readonly u1: number;
  readonly v: readonly [number, number];
  readonly yBottom: number;
  readonly yTop: number;
  readonly steps: number;
}

export const MAX_RISE = 0.185;

/**
 * Builds a straight flight running along +u (or -u when `u1 < u0`), as treads
 * that each close the riser below them, two strings and a raking soffit.
 *
 * Every tread rests on the one below it and nothing else, so a controller that
 * steps the player up from platform to platform sees a single rise at a time.
 */
export function addFlight(ctx: Fitout, flight: Flight, key: MaterialKey): void {
  const { steps } = flight;
  if (steps < 1) return;
  const rise = (flight.yTop - flight.yBottom) / steps;
  const going = (flight.u1 - flight.u0) / steps;
  for (let i = 0; i < steps; i += 1) {
    const uA = flight.u0 + going * i;
    const uB = uA + going;
    const top = flight.yBottom + rise * (i + 1);
    addPlatform(ctx, key, {
      u: [Math.min(uA, uB), Math.max(uA, uB)],
      v: flight.v,
      y: [top - rise - 0.03, top],
    });
  }

  // Strings either side and a soffit, so the flight has an underside.
  const structure = ctx.room.palette.structure;
  for (const v of [flight.v[0] + 0.04, flight.v[1] - 0.04]) {
    addStrut(
      ctx,
      structure,
      { u: flight.u0, v, y: flight.yBottom - 0.08 },
      { u: flight.u1, v, y: flight.yTop - 0.08 },
      0.34,
      0.08,
    );
  }
  addStrut(
    ctx,
    structure,
    { u: flight.u0, v: (flight.v[0] + flight.v[1]) / 2, y: flight.yBottom - 0.14 },
    { u: flight.u1, v: (flight.v[0] + flight.v[1]) / 2, y: flight.yTop - 0.14 },
    0.1,
    flight.v[1] - flight.v[0] - 0.02,
  );
}

/** A handrail with newel posts and a few balusters. */
export function addRail(
  ctx: Fitout,
  a: LocalPoint,
  b: LocalPoint,
  key: MaterialKey,
  balusters = 4,
): void {
  const railA: LocalPoint = { u: a.u, v: a.v, y: a.y + 0.95 };
  const railB: LocalPoint = { u: b.u, v: b.v, y: b.y + 0.95 };
  addStrut(ctx, key, railA, railB, 0.055);
  addStrut(ctx, key, { ...railA, y: a.y + 0.5 }, { ...railB, y: b.y + 0.5 }, 0.035);
  for (let i = 0; i <= balusters; i += 1) {
    const t = balusters === 0 ? 0 : i / balusters;
    const u = a.u + (b.u - a.u) * t;
    const v = a.v + (b.v - a.v) * t;
    const y = a.y + (b.y - a.y) * t;
    addStrut(ctx, key, { u, v, y }, { u, v, y: y + 0.95 }, i === 0 || i === balusters ? 0.07 : 0.035);
  }
}


// ---------------------------------------------------------------------------
// Shared wall and floor dressing
// ---------------------------------------------------------------------------

/**
 * The layer that separates a modelled room from a furnished one.
 *
 * None of what follows is furniture. It is the things that hang on walls, lie
 * on floors and stand in corners - pictures, notices, runners, bins, low
 * tables, radiators - and they are what a room reads as missing long before it
 * reads as short of a sofa. Everything here is a handful of boxes, shared by
 * every interior kind, and none of it takes a collider: it is all either flat
 * against a surface or smaller than the player's own body radius, and a
 * collider in a circulation route is how a player gets stuck.
 */

/** Which wall a run of dressing hangs on, in room-local terms. */
export type WallSide = 'left' | 'right' | 'back';

/** Turns a position along a wall into the box that sits flat on it. */
function wallBox(
  room: Room,
  side: WallSide,
  along: readonly [number, number],
  out: readonly [number, number],
  y: readonly [number, number],
): LocalBox {
  switch (side) {
    case 'left':
      return { u: [LINING + out[0], LINING + out[1]], v: along, y };
    case 'right':
      return { u: [room.width - LINING - out[1], room.width - LINING - out[0]], v: along, y };
    case 'back':
      return { u: along, v: [room.depth - LINING - out[1], room.depth - LINING - out[0]], y };
  }
}

/**
 * A row of framed pictures, notices or certificates.
 *
 * `centreY` is the middle of the row; real hanging heights cluster there and
 * the small alternating rise is what stops four frames reading as a decal
 * strip.
 */
export function addWallArt(
  ctx: Fitout,
  side: WallSide,
  from: number,
  to: number,
  centreY: number,
  count: number,
  matKey: MaterialKey,
): void {
  const { room } = ctx;
  const span = to - from;
  if (span < 0.6 || count < 1) return;
  for (let i = 0; i < count; i += 1) {
    const centre = from + (span * (i + 0.5)) / count;
    const w = i % 3 === 1 ? 0.34 : 0.26;
    const h = i % 3 === 1 ? 0.42 : 0.34;
    const y = centreY + (i % 2 === 0 ? 0.03 : -0.03);
    addBox(
      ctx,
      room.palette.trim,
      wallBox(room, side, [centre - w / 2, centre + w / 2], [0, 0.035], [y - h / 2, y + h / 2]),
    );
    addBox(
      ctx,
      matKey,
      wallBox(
        room,
        side,
        [centre - w / 2 + 0.04, centre + w / 2 - 0.04],
        [0.035, 0.05],
        [y - h / 2 + 0.04, y + h / 2 - 0.04],
      ),
    );
  }
}

/** A panel radiator on a wall, on brackets, with its fins showing. */
export function addRadiator(ctx: Fitout, side: WallSide, centre: number, width: number): void {
  const { room, room: { floorY: F } } = ctx;
  const half = width / 2;
  addBox(ctx, room.palette.metal, wallBox(room, side, [centre - half, centre + half], [0.02, 0.12], [F + 0.16, F + 0.62]));
  const fins = clamp(Math.round(width / 0.09), 3, 14);
  for (let i = 0; i < fins; i += 1) {
    const at = centre - half + 0.04 + ((width - 0.08) * i) / Math.max(1, fins - 1);
    addBox(ctx, room.palette.trim, wallBox(room, side, [at - 0.012, at + 0.012], [0.12, 0.15], [F + 0.2, F + 0.58]));
  }
}

/** A woven runner or rug. Two triangles, and the floor stops being a plane. */
export function addRug(
  ctx: Fitout,
  u: readonly [number, number],
  v: readonly [number, number],
  key: MaterialKey,
): void {
  addQuad(ctx, key, u, v, ctx.room.floorY + 0.014, true);
  // A darker border, held in, so it reads as a laid rug rather than a stain.
  addQuad(
    ctx,
    ctx.room.palette.trim,
    [u[0] + 0.12, u[1] - 0.12],
    [v[0] + 0.12, v[1] - 0.12],
    ctx.room.floorY + 0.02,
    true,
  );
}

/** A low table: top, apron and four legs. */
export function addLowTable(ctx: Fitout, u: number, v: number, du: number, dv: number, yaw: number): void {
  const { room, room: { floorY: F } } = ctx;
  const top = F + 0.42;
  addYawBox(ctx, room.palette.surface, { u, v }, { du, dv }, [top - 0.05, top], yaw, true);
  addYawBox(ctx, room.palette.joinery, { u, v }, { du: du - 0.14, dv: dv - 0.14 }, [top - 0.12, top - 0.05], yaw);
  for (const [su, sv] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    addBox(ctx, room.palette.joinery, {
      u: [u + su * (du / 2 - 0.1) - 0.025, u + su * (du / 2 - 0.1) + 0.025],
      v: [v + sv * (dv / 2 - 0.1) - 0.025, v + sv * (dv / 2 - 0.1) + 0.025],
      y: [F, top - 0.12],
    });
  }
  // Something left on it: a magazine and a cup.
  addBox(ctx, 'stuccoCream', {
    u: [u - 0.11, u + 0.07],
    v: [v - 0.08, v + 0.06],
    y: [top, top + 0.012],
  });
}

/** A tall waste bin with a swing lid. */
export function addBin(ctx: Fitout, u: number, v: number): void {
  const { room, room: { floorY: F } } = ctx;
  addPost(ctx, room.palette.metal, u, v, [F, F + 0.62], 0.17, 8);
  addPost(ctx, 'metalDark', u, v, [F + 0.62, F + 0.67], 0.18, 8);
}

/**
 * A coat or umbrella stand: a post, a foot and a few hooks. Two of these in a
 * hallway do more than any amount of wall texture.
 */
export function addStand(ctx: Fitout, u: number, v: number): void {
  const { room, room: { floorY: F } } = ctx;
  addPost(ctx, room.palette.metal, u, v, [F, F + 0.035], 0.2, 8);
  addPost(ctx, room.palette.trim, u, v, [F + 0.035, F + 1.72], 0.035, 6);
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    addBox(ctx, room.palette.metal, {
      u: [u + Math.cos(a) * 0.06 - 0.02, u + Math.cos(a) * 0.06 + 0.02],
      v: [v + Math.sin(a) * 0.06 - 0.02, v + Math.sin(a) * 0.06 + 0.02],
      y: [F + 1.6, F + 1.72],
    });
  }
}

/**
 * A run of pigeonholes or letterboxes fixed to a wall - the single most
 * recognisable object in a shared entrance hall.
 */
export function addPigeonholes(
  ctx: Fitout,
  side: WallSide,
  from: number,
  to: number,
  baseY: number,
  rows: number,
  columns: number,
): void {
  const { room } = ctx;
  const span = to - from;
  if (span < 0.5 || rows < 1 || columns < 1) return;
  const height = rows * 0.19;
  addBox(ctx, room.palette.joinery, wallBox(room, side, [from, to], [0, 0.18], [baseY, baseY + height]));
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const w = span / columns;
      const at = from + w * c;
      addBox(
        ctx,
        r % 2 === c % 2 ? room.palette.metal : 'metalDark',
        wallBox(
          room,
          side,
          [at + 0.02, at + w - 0.02],
          [0.18, 0.2],
          [baseY + r * 0.19 + 0.02, baseY + (r + 1) * 0.19 - 0.02],
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

/** Dispatches to the layout for this interior's kind, then dresses it. */
export function addFittings(ctx: Fitout): void {
  switch (ctx.room.kind) {
    case 'cafe':
      addCafeFittings(ctx);
      break;
    case 'store':
      addStoreFittings(ctx);
      break;
    case 'gunStore':
      addGunStoreFittings(ctx);
      break;
    case 'nightclub':
      addNightclubFittings(ctx);
      break;
    case 'marketHall':
      addMarketFittings(ctx);
      break;
    case 'lobby':
      addLobbyFittings(ctx);
      break;
    case 'workshop':
      addWorkshopFittings(ctx);
      break;
    case 'stairhall':
      addStairhallFittings(ctx);
      break;
  }
  addDressing(ctx);
}

/**
 * The dressing pass, run after every layout.
 *
 * It is separate from the layouts because it is the same problem in every
 * room: the furniture is right, the walls are bare, and the eye reads bare
 * walls as an unfinished model long before it reads a missing chair. Each run
 * is placed in the band that kind's own layout is known to leave clear -
 * mostly the front third of the room and the wall above shelf height.
 */
function addDressing(ctx: Fitout): void {
  const { room } = ctx;
  const { floorY: F, width: W, depth: D } = room;
  // The flank the layout does NOT use for its own wall run, per kind.
  const doorLow = room.doorU < W / 2;

  switch (room.kind) {
    case 'cafe': {
      // The coat hooks take the flank nearest the door; the pictures take the
      // other one, hung above the tables rather than behind them.
      addWallArt(ctx, doorLow ? 'right' : 'left', 1.3, Math.min(4.1, D - 1.2), F + 2.0, 3, 'stuccoBlue');
      const standU = doorLow ? LINING + 0.45 : W - LINING - 0.45;
      addStand(ctx, standU, clamp(0.78, 0.5, D - 0.5));
      return;
    }
    case 'store': {
      // In front of the flank shelving, which starts at 2.5 m in.
      addWallArt(ctx, doorLow ? 'right' : 'left', 1.0, 2.35, F + 1.9, 2, 'stuccoRose');
      return;
    }
    case 'lobby': {
      // Completes the waiting group the generated armchairs make: a rug under
      // it and a low table in the middle of it.
      const seatU = clamp(W * 0.18 + 0.6, 2.0, W - 2.0);
      const seatV = clamp(D * 0.72, 2.4, D - 1.1);
      addRug(
        ctx,
        [clamp(seatU - 1.9, 0.7, W - 0.7), clamp(seatU + 1.9, 0.7, W - 0.7)],
        [clamp(seatV - 1.5, 0.7, D - 0.7), clamp(seatV + 1.5, 0.7, D - 0.7)],
        'canvasAwning',
      );
      addLowTable(ctx, seatU, seatV, 0.9, 0.62, 0.12);
      addBin(ctx, clamp(seatU + 2.15, 0.5, W - 0.5), seatV);
      return;
    }
    case 'stairhall': {
      // A shared entrance hall: letterboxes, notices, somewhere to hang a coat
      // and a bin for the junk mail. The stair takes the far half of the room,
      // so all of it goes in the first two metres.
      addPigeonholes(ctx, doorLow ? 'right' : 'left', 0.95, Math.min(2.15, D - 1.0), F + 1.02, 3, 4);
      addWallArt(ctx, doorLow ? 'left' : 'right', 0.95, Math.min(2.6, D - 0.9), F + 1.66, 3, 'stuccoCream');
      addStand(ctx, doorLow ? W - LINING - 0.5 : LINING + 0.5, clamp(0.8, 0.5, D - 0.5));
      addBin(ctx, doorLow ? W - LINING - 0.45 : LINING + 0.45, clamp(1.65, 0.6, D - 0.6));
      addRadiator(ctx, doorLow ? 'right' : 'left', clamp(2.9, 1.0, D - 1.0), Math.min(1.1, D - 2.0));
      return;
    }
    case 'workshop': {
      // Method statements and a fire notice, at reading height by the door.
      addWallArt(ctx, doorLow ? 'right' : 'left', 1.0, 2.4, F + 1.72, 2, 'stuccoCream');
      return;
    }
    case 'marketHall': {
      addWallArt(ctx, doorLow ? 'right' : 'left', 1.1, 2.6, F + 2.1, 2, 'stuccoCream');
      return;
    }
    case 'gunStore':
      // Already the densest room in the city; its own layout carries the
      // licence, the notices and the target.
      return;
  }
}

const CAFE_STOCK: readonly MaterialKey[] = ['timber', 'metalLight', 'stuccoRose', 'glassShop', 'timberDark'];
const SHOP_STOCK: readonly MaterialKey[] = ['brickBuff', 'stuccoMint', 'canvasAwning', 'timber', 'stuccoRose'];

/**
 * Café: a counter across the back with a working back bar, loose tables in the
 * window, and three pendants low enough to make pools of light on the tables.
 */
/** Height of the cafe's counter top above the finished floor. */
export const CAFE_COUNTER_HEIGHT = 0.98;

/**
 * The cafe's counter, and where its seats go.
 *
 * Extracted and made free of `rng` for the same reason `gunStorePlan` is: the
 * generated espresso machine stands ON this counter and the generated tables
 * and chairs replace the boxes that used to be the seating, and all of that is
 * placed by a runtime module that cannot share the room's random stream. A
 * counter whose position was drawn from `rng` would put the machine beside it
 * about half the time.
 */
export interface CafePlan {
  readonly cu0: number;
  readonly cu1: number;
  readonly cv0: number;
  readonly cv1: number;
  readonly backFace: number;
}

export function cafePlan(room: Room): CafePlan {
  const { width: W, depth: D } = room;
  const counterLength = clamp(W * 0.56, 2.8, W - 2.4);
  const cu0 = clamp(0.85, 0.4, Math.max(0.4, W - counterLength - 0.5));
  const backFace = D - LINING;
  const cv1 = backFace - 1.3;
  return { cu0, cu1: cu0 + counterLength, cv0: cv1 - 0.68, cv1, backFace };
}

/** Loose tables down both flanks, and one off the entrance axis. */
export function cafeSeats(room: Room): readonly { u: number; v: number; skew: number }[] {
  const { width: W, depth: D } = room;
  const plan = cafePlan(room);
  const candidates = [
    { u: 0.95, v: 1.75, skew: 0.18 },
    { u: W - 1.05, v: 1.85, skew: -0.22 },
    { u: clamp(W / 2 + 1.6, 1.2, W - 1.2), v: clamp(D * 0.42, 1.8, D - 2.6), skew: 0.1 },
  ];
  return candidates.filter(
    (seat) =>
      seat.u > 0.85 &&
      seat.u < W - 0.85 &&
      seat.v > 0.85 &&
      // Clear of the counter run, so a chair back never pushes through it.
      seat.v < plan.cv0 - 1.0,
  );
}

function addCafeFittings(ctx: Fitout): void {
  const { room } = ctx;
  const { rng, floorY: F, width: W, depth: D } = room;

  const plan = cafePlan(room);
  const { cu0, cu1, cv0, cv1, backFace } = plan;
  const counterLength = cu1 - cu0;
  const placed = addCounter(ctx, [cu0, cu1], [cv0, cv1], CAFE_COUNTER_HEIGHT);

  if (placed) {
    // Grinder, till and a row of cups. The espresso machine itself is the
    // generated model placed on this top by `interiorFurnishings`.
    addBox(ctx, 'metalDark', {
      u: [cu0 + 1.52, cu0 + 1.7],
      v: [cv0 + 0.16, cv0 + 0.36],
      y: [F + 0.98, F + 1.46],
    });
    addBox(ctx, room.palette.metal, {
      u: [cu1 - 0.62, cu1 - 0.22],
      v: [cv0 + 0.12, cv1 - 0.18],
      y: [F + 0.98, F + 1.16],
    });
    for (let i = 0; i < 4; i += 1) {
      const u = cu0 + 1.94 + i * 0.17;
      if (u + 0.11 > cu1 - 0.7) break;
      addBox(ctx, 'stuccoCream', {
        u: [u, u + 0.11],
        v: [cv0 + 0.2, cv0 + 0.31],
        y: [F + 0.98, F + 1.06],
      });
    }
  }

  // Back bar: three boards of bottles and cups against the rear wall.
  addShelfRun(ctx, 'u', [cu0 + 0.15, cu1 - 0.15], [backFace - 0.3, backFace], [1.25, 1.68, 2.1], 6, CAFE_STOCK);

  // Menu board over the back bar, lit by its own strip.
  const menuU: readonly [number, number] = [cu0 + 0.35, Math.min(cu0 + 2.35, cu1 - 0.15)];
  if (menuU[1] - menuU[0] > 0.8) {
    const menuTop = Math.min(F + 2.95, room.ceilY - 0.25);
    addBox(ctx, room.palette.trim, {
      u: menuU,
      v: [backFace - 0.09, backFace],
      y: [menuTop - 0.62, menuTop],
    });
    addBox(ctx, 'metalDark', {
      u: [menuU[0] + 0.05, menuU[1] - 0.05],
      v: [backFace - 0.11, backFace - 0.09],
      y: [menuTop - 0.56, menuTop - 0.06],
    });
    addBox(ctx, room.palette.glow, {
      u: [menuU[0] + 0.2, menuU[1] - 0.2],
      v: [backFace - 0.24, backFace - 0.14],
      y: [menuTop + 0.02, menuTop + 0.09],
    });
  }

  // Service hatch through to the back of house, with its flap propped open.
  const hatchU = clamp(cu1 + 0.9, 0.6, W - 1.5);
  if (hatchU + 0.9 < W - 0.3) {
    addBox(ctx, 'glassShop', {
      u: [hatchU, hatchU + 0.9],
      v: [backFace - 0.02, backFace + 0.01],
      y: [F + 1.0, F + 1.62],
    });
    addBox(ctx, room.palette.trim, {
      u: [hatchU - 0.08, hatchU + 0.98],
      v: [backFace - 0.1, backFace],
      y: [F + 0.92, F + 1.02],
    });
    addStrut(
      ctx,
      room.palette.trim,
      { u: hatchU, v: backFace - 0.06, y: F + 1.62 },
      { u: hatchU + 0.9, v: backFace - 0.42, y: F + 2.02 },
      0.07,
    );
  }

  // Stools along the counter front.
  if (placed) {
    const stools = clamp(Math.floor(counterLength / 1.1), 2, 4);
    for (let i = 0; i < stools; i += 1) {
      const u = cu0 + 0.55 + ((counterLength - 1.1) * i) / Math.max(1, stools - 1);
      const v = cv0 - rng.range(0.5, 0.62);
      if (!canPlace(room, { u: [u - 0.2, u + 0.2], v: [v - 0.2, v + 0.2], y: [F, F + 0.78] })) continue;
      addPost(ctx, room.palette.surface, u, v, [F + 0.72, F + 0.78], 0.19, 8);
      addPost(ctx, room.palette.metal, u, v, [F, F + 0.72], 0.045, 6);
      addPost(ctx, room.palette.metal, u, v, [F + 0.2, F + 0.24], 0.15, 6);
    }
  }

  /*
   * The loose seating is NOT built here any more. It used to be a pedestal of
   * boxes with two more boxes for chairs; it is now a generated bentwood chair
   * and a cast-iron cafe table, placed by `interiorFurnishings` from
   * `cafeSeats(room)` and carrying their own colliders. A cafe chair is the
   * one object in a room like this that nobody accepts as a cuboid.
   *
   * The cup left on each table goes with them, so a table with no downloaded
   * model does not leave a cup floating at 780 mm.
   */

  // Ceiling: pendants over the counter and the tables, plus a sconce by the door.
  const bulb = Math.min(room.ceilY - 0.85, F + 2.3);
  addPendant(ctx, cu0 + counterLength * 0.35, cv0 - 0.15, bulb, { intensity: 2.1, distance: 12 });
  addPendant(ctx, 0.95, 2.0, bulb, { intensity: 1.7, distance: 10 });
  addPendant(ctx, W - 1.05, 2.1, bulb, { intensity: 1.7, distance: 10 });
  addSconce(ctx, clamp(room.doorU + 1.9, 0.6, W - 0.6), LINING, F + 2.1, 1, {
    intensity: 1.4,
    distance: 8,
  });

  // -- the layer that makes it somebody's café ------------------------------

  if (placed) {
    // Cake case on the counter, and a plant on the quiet end of it.
    const caseU: readonly [number, number] = [cu1 - 1.5, cu1 - 0.55];
    if (caseU[1] - caseU[0] > 0.5) {
      addBox(ctx, room.palette.metal, {
        u: caseU,
        v: [cv0 + 0.06, cv1 - 0.06],
        y: [F + 0.98, F + 1.06],
      });
      addBox(ctx, 'glassShop', {
        u: [caseU[0] + 0.03, caseU[1] - 0.03],
        v: [cv0 + 0.09, cv1 - 0.09],
        y: [F + 1.06, F + 1.46],
      });
      for (let i = 0; i < 3; i += 1) {
        const u = caseU[0] + 0.16 + ((caseU[1] - caseU[0] - 0.32) * i) / 2;
        addBox(ctx, i === 1 ? 'stuccoRose' : 'timber', {
          u: [u - 0.09, u + 0.09],
          v: [cv0 + 0.16, cv1 - 0.16],
          y: [F + 1.07, F + 1.19],
        });
      }
    }
    addPost(ctx, room.palette.trim, cu0 + 0.16, cv0 + 0.34, [F + 0.98, F + 1.16], 0.11, 6);
    for (let i = 0; i < 2; i += 1) {
      addYawBox(
        ctx,
        i === 0 ? 'foliage' : 'foliageDark',
        { u: cu0 + 0.16, v: cv0 + 0.34 },
        { du: 0.34 - i * 0.1, dv: 0.34 - i * 0.1 },
        [F + 1.16 + i * 0.16, F + 1.36 + i * 0.16],
        0.5 + i * 0.7,
      );
    }
    // Mugs hung under the lowest back-bar shelf.
    for (let i = 0; i < 4; i += 1) {
      const u = cu0 + 0.45 + i * 0.26;
      if (u > cu1 - 0.3) break;
      addBox(ctx, 'stuccoCream', {
        u: [u - 0.05, u + 0.05],
        v: [backFace - 0.24, backFace - 0.13],
        y: [F + 1.12, F + 1.24],
      });
    }
  }

  // A-frame chalkboard, stood against a flank wall clear of the way in.
  const boardU = room.doorU < W / 2 ? W - 1.15 : 1.15;
  const boardBox: LocalBox = {
    u: [boardU - 0.34, boardU + 0.34],
    v: [0.8, 1.35],
    y: [F, F + 1.02],
  };
  if (canPlace(room, boardBox)) {
    addStrut(
      ctx,
      room.palette.joinery,
      { u: boardU - 0.3, v: 0.95, y: F },
      { u: boardU - 0.06, v: 1.12, y: F + 1.0 },
      0.05,
      0.62,
    );
    addStrut(
      ctx,
      room.palette.joinery,
      { u: boardU + 0.3, v: 0.95, y: F },
      { u: boardU + 0.06, v: 1.12, y: F + 1.0 },
      0.05,
      0.62,
    );
    addBox(ctx, 'metalDark', {
      u: [boardU - 0.28, boardU + 0.28],
      v: [1.06, 1.1],
      y: [F + 0.3, F + 0.95],
    });
    addCollider(ctx, boardBox, true);
  }

  // Coat hooks on the flank the tables do not use.
  const hookU = room.doorU < W / 2 ? LINING : W - LINING;
  const inward = room.doorU < W / 2 ? 1 : -1;
  addBox(ctx, room.palette.trim, {
    u: [hookU, hookU + inward * 0.04],
    v: [D * 0.42, D * 0.42 + 1.1],
    y: [F + 1.62, F + 1.72],
  });
  for (let i = 0; i < 3; i += 1) {
    const v = D * 0.42 + 0.18 + i * 0.37;
    addBox(ctx, room.palette.metal, {
      u: [hookU + inward * 0.04, hookU + inward * 0.11],
      v: [v, v + 0.035],
      y: [F + 1.6, F + 1.68],
    });
  }
}

/**
 * Store: two gondola aisles either side of the way in, a till by the door,
 * wall shelving, and a stockroom partition across the back.
 */
function addStoreFittings(ctx: Fitout): void {
  const { room } = ctx;
  const { rng, floorY: F, width: W, depth: D } = room;

  // Stockroom across the back, entered through a gap in a stud partition.
  const partV = D - clamp(D * 0.22, 1.9, 2.9);
  const gapU = room.doorU > W / 2 ? clamp(W * 0.2, 1.1, W - 2.4) : clamp(W * 0.8, 1.3, W - 1.3);
  const gapHalf = 0.55;
  const partTop = Math.min(room.ceilY, F + 2.6);
  const partLeft: LocalBox = { u: [LINING, gapU - gapHalf], v: [partV, partV + 0.11], y: [F, partTop] };
  const partRight: LocalBox = { u: [gapU + gapHalf, W - LINING], v: [partV, partV + 0.11], y: [F, partTop] };
  // The partition is only worth building if both leaves fit; half a wall is worse
  // than none.
  if (partV > 2.4 && canPlace(room, partLeft) && canPlace(room, partRight)) {
    addSolid(ctx, room.palette.wall, partLeft);
    addSolid(ctx, room.palette.wall, partRight);
    addBox(ctx, room.palette.trim, {
      u: [gapU - gapHalf - 0.06, gapU + gapHalf + 0.06],
      v: [partV - 0.02, partV + 0.13],
      y: [F + 2.05, F + 2.16],
    });
    // Stockroom fittings, glimpsed through the gap.
    addShelfRun(
      ctx,
      'u',
      [gapU + 0.2, Math.min(gapU + 2.4, W - 0.3)],
      [D - LINING - 0.42, D - LINING],
      [0.5, 1.05, 1.6],
      4,
      SHOP_STOCK,
    );
    addCrateStack(ctx, clamp(gapU - 1.4, 0.7, W - 0.7), D - 1.0, 3, 0.2);
    addStripLight(ctx, [gapU - 0.6, gapU + 0.6], D - 1.1, Math.min(room.ceilY - 0.18, F + 2.7), {
      intensity: 1.4,
      distance: 8,
    });
  }

  // Till counter, tight to one side of the entrance.
  const tillNearLeft = room.doorU > W / 2;
  const tillU: readonly [number, number] = tillNearLeft
    ? [LINING + 0.15, LINING + 2.15]
    : [W - LINING - 2.15, W - LINING - 0.15];
  const tillV: readonly [number, number] = [1.45, 2.15];
  if (addCounter(ctx, tillU, tillV, 1.02)) {
    addBox(ctx, room.palette.metal, {
      u: [tillU[0] + 0.35, tillU[0] + 0.75],
      v: [tillV[0] + 0.14, tillV[1] - 0.18],
      y: [F + 1.02, F + 1.24],
    });
    addBox(ctx, 'metalDark', {
      u: [tillU[0] + 0.4, tillU[0] + 0.7],
      v: [tillV[0] + 0.18, tillV[0] + 0.3],
      y: [F + 1.24, F + 1.3],
    });
    addBox(ctx, room.palette.glow, {
      u: [tillU[0] + 1.1, tillU[1] - 0.1],
      v: [tillV[0] + 0.02, tillV[0] + 0.06],
      y: [F + 1.05, F + 1.36],
    });
  }

  // Two gondolas, held well clear of the way in.
  const aisleV: readonly [number, number] = [2.5, Math.max(3.4, partV - 0.7)];
  for (const side of [0.2, 0.8]) {
    const centre = W * side;
    const half = 0.46;
    const bounds: LocalBox = {
      u: [centre - half, centre + half],
      v: [aisleV[0], aisleV[1]],
      y: [F, F + 1.75],
    };
    if (aisleV[1] - aisleV[0] < 1.2) continue;
    if (!canPlace(room, bounds)) continue;
    addSolid(ctx, room.palette.joinery, {
      u: [centre - half, centre + half],
      v: aisleV,
      y: [F + 0.12, F + 0.3],
    });
    addBox(ctx, room.palette.trim, {
      u: [centre - half + 0.06, centre + half - 0.06],
      v: [aisleV[0] + 0.05, aisleV[1] - 0.05],
      y: [F, F + 0.12],
    });
    addSolid(ctx, room.palette.metal, {
      u: [centre - 0.04, centre + 0.04],
      v: aisleV,
      y: [F + 0.3, F + 1.75],
    });
    for (const shelf of [0.62, 1.02, 1.42]) {
      for (const face of [-1, 1]) {
        addBox(ctx, room.palette.joinery, {
          u: [centre + (face < 0 ? -half : 0.02), centre + (face < 0 ? -0.02 : half)],
          v: aisleV,
          y: [F + shelf, F + shelf + 0.04],
        });
        // Stock is faced in blocks rather than modelled packet by packet: at
        // arm's length a run of three blocks reads the same and costs a tenth.
        const count = clamp(Math.round((aisleV[1] - aisleV[0]) / 1.6), 2, 3);
        for (let i = 0; i < count; i += 1) {
          const key = SHOP_STOCK[(i + Math.round(shelf * 10)) % SHOP_STOCK.length] ?? 'timber';
          const cell = (aisleV[1] - aisleV[0] - 0.3) / count;
          const v = aisleV[0] + 0.15 + cell * (i + 0.5);
          const w = rng.range(0.13, 0.2);
          addBox(ctx, key, {
            u: [centre + face * 0.08, centre + face * (0.08 + w)],
            v: [v - cell * 0.42, v + cell * 0.42],
            y: [F + shelf + 0.04, F + shelf + rng.range(0.2, 0.32)],
          });
        }
      }
    }
    // Aisle sign hanging over the gondola.
    addBox(ctx, room.palette.glow, {
      u: [centre - 0.42, centre + 0.42],
      v: [aisleV[0] + 0.1, aisleV[0] + 0.14],
      y: [F + 2.05, F + 2.32],
    });
    addStrut(
      ctx,
      room.palette.metal,
      { u: centre, v: aisleV[0] + 0.12, y: F + 2.32 },
      { u: centre, v: aisleV[0] + 0.12, y: room.ceilY },
      0.03,
    );
  }

  // Wall shelving down both flanks and a crate stack in the corner.
  addShelfRun(
    ctx,
    'v',
    [Math.min(2.6, D - 1.4), Math.min(partV, D - 0.6)],
    [LINING, LINING + 0.4],
    [0.85, 1.35, 1.85],
    4,
    SHOP_STOCK,
  );
  addShelfRun(
    ctx,
    'v',
    [Math.min(2.6, D - 1.4), Math.min(partV, D - 0.6)],
    [W - LINING - 0.4, W - LINING],
    [0.9, 1.42, 1.94],
    3,
    SHOP_STOCK,
  );
  addCrateStack(ctx, clamp(W - 1.0, 0.8, W - 0.8), clamp(partV - 0.9, 1.2, D - 1.0), 3, -0.15);

  const lampY = Math.min(room.ceilY - 0.16, F + 2.85);
  addStripLight(ctx, [W * 0.2 - 0.7, W * 0.2 + 0.7], 2.9, lampY, { intensity: 1.8, distance: 11 });
  addStripLight(ctx, [W * 0.8 - 0.7, W * 0.8 + 0.7], 2.9, lampY, { intensity: 1.8, distance: 11 });
  addStripLight(ctx, [W / 2 - 0.8, W / 2 + 0.8], 1.4, lampY, { intensity: 1.6, distance: 10 });

  // -- the layer that makes it somebody's shop ------------------------------

  // Baskets stacked inside the door, on the opposite side to the till.
  const basketU = clamp(tillNearLeft ? W - LINING - 0.6 : LINING + 0.6, 0.6, W - 0.6);
  const basketBox: LocalBox = {
    u: [basketU - 0.28, basketU + 0.28],
    v: [1.0, 1.44],
    y: [F, F + 0.72],
  };
  if (canPlace(room, basketBox)) {
    for (let i = 0; i < 4; i += 1) {
      addYawBox(
        ctx,
        i % 2 === 0 ? 'stuccoMint' : 'stuccoBlue',
        { u: basketU, v: 1.22 },
        { du: 0.5, dv: 0.38 },
        [F + i * 0.17, F + 0.16 + i * 0.17],
        0.05 * i,
      );
    }
    addCollider(ctx, basketBox, true);
  }

  // A promotional bin in the middle of the front of the shop, where a real one
  // stands: in the way enough to be noticed, never in the way of the door.
  const binU = clamp(W * 0.5 + (tillNearLeft ? 1.4 : -1.4), 1.1, W - 1.1);
  const binBox: LocalBox = { u: [binU - 0.55, binU + 0.55], v: [1.5, 2.4], y: [F, F + 0.86] };
  if (canPlace(room, binBox)) {
    addSolid(ctx, room.palette.joinery, {
      u: [binU - 0.55, binU + 0.55],
      v: [1.5, 2.4],
      y: [F + 0.1, F + 0.78],
    });
    addBox(ctx, room.palette.trim, {
      u: [binU - 0.58, binU + 0.58],
      v: [1.47, 2.43],
      y: [F + 0.78, F + 0.84],
    });
    for (let i = 0; i < 3; i += 1) {
      const key = SHOP_STOCK[(i * 3) % SHOP_STOCK.length] ?? 'timber';
      addYawBox(
        ctx,
        key,
        { u: binU - 0.3 + i * 0.3, v: 1.72 + (i % 2) * 0.42 },
        { du: 0.24, dv: 0.24 },
        [F + 0.78, F + 0.78 + rng.range(0.1, 0.2)],
        rng.range(-0.4, 0.4),
      );
    }
    addBox(ctx, room.palette.glow, {
      u: [binU - 0.4, binU + 0.4],
      v: [1.93, 1.97],
      y: [F + 1.16, F + 1.44],
    });
    addStrut(
      ctx,
      room.palette.metal,
      { u: binU, v: 1.95, y: F + 0.84 },
      { u: binU, v: 1.95, y: F + 1.16 },
      0.03,
    );
  }

  // Convex mirror in the back corner and a clock over the till: the two things
  // every shop like this has, and neither costs more than three boxes.
  const mirrorU = tillNearLeft ? W - LINING - 0.5 : LINING + 0.5;
  addBox(ctx, room.palette.metal, {
    u: [mirrorU - 0.3, mirrorU + 0.3],
    v: [partV - 0.42, partV - 0.36],
    y: [F + 2.15, F + 2.75],
  });
  addBox(ctx, 'metalLight', {
    u: [mirrorU - 0.25, mirrorU + 0.25],
    v: [partV - 0.5, partV - 0.42],
    y: [F + 2.2, F + 2.7],
  });
  const clockU = (tillU[0] + tillU[1]) / 2;
  addBox(ctx, room.palette.trim, {
    u: [clockU - 0.19, clockU + 0.19],
    v: [LINING, LINING + 0.05],
    y: [F + 2.32, F + 2.7],
  });
  addBox(ctx, 'stuccoCream', {
    u: [clockU - 0.15, clockU + 0.15],
    v: [LINING + 0.05, LINING + 0.07],
    y: [F + 2.36, F + 2.66],
  });
}

// ---------------------------------------------------------------------------
// Gun store
// ---------------------------------------------------------------------------

/** Boxed ammunition: painted card in the colours the trade actually uses. */
const AMMO_STOCK: readonly MaterialKey[] = [
  'stuccoMint',
  'canvasAwning',
  'stuccoBlue',
  'timberDark',
  'metalDark',
];

/**
 * The measurements the gun shop's fit-out and its runtime objects both need.
 *
 * The clerk, the rifles in the rack and the pistols under the glass are not
 * geometry - a builder may not make a mesh - so they are placed at runtime by
 * `src/shop`. Both sides derive their positions from THIS function so the
 * counter the player walks up to and the person standing behind it can never
 * drift apart. It is deliberately free of `rng`: two callers must get the same
 * answer without sharing a random stream.
 */
export interface GunStorePlan {
  /** Service counter run, room-local. `v[0]` is the customer face. */
  readonly counterU: readonly [number, number];
  readonly counterV: readonly [number, number];
  /** Height of the counter top above the finished floor. */
  readonly counterHeight: number;
  /** Inside face of the back wall. */
  readonly backFace: number;
  /** Where the clerk stands, room-local. */
  readonly clerkU: number;
  readonly clerkV: number;
  /** Where a customer stands to be served. */
  readonly serviceU: number;
  readonly serviceV: number;
  /** Long-gun rack on the back wall. */
  readonly rackU: readonly [number, number];
  /** Front face of the rack panel. */
  readonly rackV: number;
  /** Height the butt plates rest at. */
  readonly rackButtY: number;
  readonly rackSlots: number;
  /** Glazed case on the counter top: the run it occupies and its inside height. */
  readonly caseU: readonly [number, number];
  readonly caseSlots: number;
}

export function gunStorePlan(room: Room): GunStorePlan {
  const { width: W, depth: D, floorY: F } = room;
  const backFace = D - LINING;

  /*
   * The counter is deliberately BEYOND the middle of the room. `blocksEntry`
   * treats the centre of the floor as the end of the walk-in route, so a
   * counter laid across it would be refused outright and the shop would have
   * no counter at all. Set behind the centre it also does what a real one
   * does: leave a browsing aisle between the door and the service point.
   */
  const counterV0 = clamp(D * 0.58, D / 2 + 0.95, Math.max(D / 2 + 0.95, D - 3.2));
  const counterV1 = counterV0 + 0.78;

  // The staff gate goes at the end furthest from the door, so a customer walks
  // in facing the counter rather than facing the gap behind it.
  const gateLow = room.doorU > W / 2;
  const length = clamp(W * 0.66, 3.0, W - 2.9);
  const counterU0 = gateLow ? W - LINING - 0.55 - length : LINING + 0.55;
  const counterU1 = counterU0 + length;
  const centre = (counterU0 + counterU1) / 2;

  /*
   * The rack is a dense block, not the full width of the counter. Long guns
   * stand about a quarter of a metre apart in a real one; spreading nine of
   * them over a seven-metre back wall would read as a display of nine lonely
   * rifles rather than as stock.
   */
  const rackRun = clamp(2.3, 1.4, Math.max(1.4, length - 0.8));
  const rackCentre = clamp(centre, LINING + rackRun / 2 + 0.3, W - LINING - rackRun / 2 - 0.3);
  const rackU: readonly [number, number] = [rackCentre - rackRun / 2, rackCentre + rackRun / 2];
  const rackSlots = clamp(Math.round(rackRun / 0.26), 6, 9);

  // The till end of the counter is the end nearest the gate; the clerk stands
  // there, which is also the end the service prompt points at.
  const tillSide = gateLow ? -1 : 1;

  return {
    counterU: [counterU0, counterU1],
    counterV: [counterV0, counterV1],
    counterHeight: 1.04,
    backFace,
    clerkU: clamp(centre + tillSide * 0.75, counterU0 + 0.5, counterU1 - 0.5),
    clerkV: counterV1 + 0.62,
    serviceU: clamp(centre + tillSide * 0.75, counterU0 + 0.5, counterU1 - 0.5),
    serviceV: counterV0 - 0.95,
    rackU,
    rackV: backFace - 0.34,
    rackButtY: F + 1.0,
    rackSlots,
    caseU: [counterU0 + 0.25, Math.min(counterU0 + 2.35, counterU1 - 0.25)],
    caseSlots: 6,
  };
}

/** A point on the shop floor, in world metres. */
export interface ShopPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * The gun shop's fit-out, in WORLD space, for the runtime objects that a
 * geometry builder is not allowed to make: the clerk, and the generated
 * weapons standing in the rack and lying under the glass.
 *
 * Everything here is derived from `gunStorePlan`, which is also what the
 * fit-out above is built from, so the counter and the person behind it cannot
 * drift apart. Returns null for any parcel that is not the gun shop.
 */
export interface GunStoreAnchors {
  readonly parcelId: string;
  readonly floorY: number;
  /** Unit world direction of increasing room-local u (along the shopfront). */
  readonly uDir: { readonly x: number; readonly z: number };
  /** Unit world direction of increasing room-local v (deeper into the shop). */
  readonly vDir: { readonly x: number; readonly z: number };
  /** Camera-convention heading: forward is `(-sin h, 0, -cos h)`. */
  readonly clerkHeading: number;
  /** Where the clerk stands, feet on the floor. */
  readonly clerk: ShopPoint;
  /** Butt-plate position of each long gun standing in the back rack. */
  readonly rack: readonly ShopPoint[];
  /** Centre of one long gun laid across the counter top. */
  readonly counterGun: ShopPoint;
  /** Centre of each handgun on the felt riser inside the glazed case. */
  readonly caseGuns: readonly ShopPoint[];
  /**
   * The projecting shopfront sign, OUTSIDE the building on the façade.
   *
   * `y` is the bottom of the bracket, and the position is already pushed half
   * the sign's own projection clear of the wall, because the model's origin is
   * the middle of that projection and its wall plate is at its own local +Z.
   * `heading` turns that plate back into the wall.
   */
  readonly sign: { readonly x: number; readonly y: number; readonly z: number; readonly heading: number };
  /** The interaction point that opens the shop. */
  readonly interactionId: string;
}

/**
 * The hanging sign's finished size, in metres.
 *
 * Held high enough to clear the ground-floor awning and anybody walking under
 * it, and low enough to stay inside the ground storey's own elevation rather
 * than crossing a first-floor window.
 */
export const GUN_SHOP_SIGN = { height: 0.95, projection: 0.93, bottom: 2.95 } as const;

export function gunStoreAnchors(parcel: Parcel): GunStoreAnchors | null {
  if (parcel.interiorKind !== 'gunStore') return null;
  const room = makeRoom(parcel, 'gunStore');
  const plan = gunStorePlan(room);
  const F = room.floorY;
  const top = F + plan.counterHeight;

  // Derived from `toWorld` rather than restated, so a change to the room frame
  // cannot leave the runtime objects pointing the wrong way.
  const origin = toWorld(room, 0, 0);
  const alongU = toWorld(room, 1, 0);
  const alongV = toWorld(room, 0, 1);
  const uDir = { x: alongU.x - origin.x, z: alongU.z - origin.z };
  const vDir = { x: alongV.x - origin.x, z: alongV.z - origin.z };

  const at = (u: number, v: number, y: number): ShopPoint => {
    const w = toWorld(room, u, v);
    return { x: w.x, y, z: w.z };
  };

  const [ru0, ru1] = plan.rackU;
  const rack: ShopPoint[] = [];
  for (let i = 0; i < plan.rackSlots; i += 1) {
    const u = ru0 + ((ru1 - ru0) * (i + 0.5)) / plan.rackSlots;
    rack.push(at(u, plan.rackV - 0.13, plan.rackButtY));
  }

  const [ku0, ku1] = plan.caseU;
  const caseGuns: ShopPoint[] = [];
  const caseV = (plan.counterV[0] + plan.counterV[1]) / 2 + 0.03;
  for (let i = 0; i < plan.caseSlots; i += 1) {
    const u = ku0 + 0.3 + ((ku1 - ku0 - 0.6) * i) / Math.max(1, plan.caseSlots - 1);
    caseGuns.push(at(u, caseV, top + 0.09));
  }

  // Laid out on the top between the case and the till, where a clerk hands one
  // over. Falls back onto the far end of the counter in a narrow shop.
  const layU = clamp((ku1 + plan.clerkU) / 2, plan.counterU[0] + 0.6, plan.counterU[1] - 0.6);

  // Straight out of the façade, so the model's wall plate ends up against it.
  const signHeading = Math.atan2(-room.door.normalX, -room.door.normalZ);
  const signOut = GUN_SHOP_SIGN.projection / 2;

  return {
    parcelId: parcel.id,
    floorY: F,
    uDir,
    vDir,
    sign: {
      x: room.door.x + room.door.normalX * signOut,
      y: parcel.groundY + GUN_SHOP_SIGN.bottom,
      z: room.door.z + room.door.normalZ * signOut,
      heading: signHeading,
    },
    // The clerk looks at the customer, i.e. along the façade's outward normal,
    // which is the same heading the exit door hands back.
    clerkHeading: Math.atan2(-room.door.normalX, -room.door.normalZ),
    clerk: at(plan.clerkU, plan.clerkV, F),
    rack,
    counterGun: at(layU, (plan.counterV[0] + plan.counterV[1]) / 2, top + 0.05),
    caseGuns,
    interactionId: `gun-store-counter-${parcel.id}`,
  };
}

/**
 * Gun shop: a service counter with a glazed case, a rack of long guns on the
 * back wall behind it, ammunition and accessories down the flanks, and a
 * gunsmith's bench in the staff strip.
 */
function addGunStoreFittings(ctx: Fitout): void {
  const { room } = ctx;
  const plan = gunStorePlan(room);

  addGunCounter(ctx, plan);
  addGunBackWall(ctx, plan);
  addGunFlanks(ctx, plan);
  addGunFloorStock(ctx, plan);
  addGunSignage(ctx, plan);
  addGunLighting(ctx, plan);

  // The service point. `kind: 'sign'` because the shop is not a door and the
  // application's door handler must ignore it; `src/shop` claims it by id.
  const service = toWorld(room, plan.serviceU, plan.serviceV);
  ctx.sink.interaction({
    id: `gun-store-counter-${room.parcel.id}`,
    x: service.x,
    y: room.floorY + 1.2,
    z: service.z,
    radius: 2.9,
    prompt: 'Press E to buy weapons',
    kind: 'sign',
    parcelId: room.parcel.id,
  });
}

/** The counter: joinery below, stone top, a glazed case and a till on it. */
function addGunCounter(ctx: Fitout, plan: GunStorePlan): void {
  const { room } = ctx;
  const { floorY: F, palette } = room;
  const [cu0, cu1] = plan.counterU;
  const [cv0, cv1] = plan.counterV;
  const top = F + plan.counterHeight;

  if (!addCounter(ctx, [cu0, cu1], [cv0, cv1], plan.counterHeight)) return;

  // Drawer lines on the customer face. Two boxes turn a slab into cabinetry.
  const drawers = clamp(Math.round((cu1 - cu0) / 0.9), 2, 7);
  for (let i = 0; i < drawers; i += 1) {
    const cell = (cu1 - cu0) / drawers;
    const u = cu0 + cell * i;
    addBox(ctx, palette.trim, {
      u: [u + 0.05, u + cell - 0.05],
      v: [cv0 - 0.02, cv0 + 0.01],
      y: [F + 0.2, F + plan.counterHeight - 0.12],
    });
  }

  // Glazed display case standing on the top: a metal kerb, four panes and a
  // felt riser. The pistols on the riser are placed at runtime.
  const [ku0, ku1] = plan.caseU;
  if (ku1 - ku0 > 0.6) {
    const caseTop = top + 0.34;
    const cvIn: readonly [number, number] = [cv0 + 0.06, cv1 - 0.06];
    addBox(ctx, palette.metal, { u: [ku0, ku1], v: cvIn, y: [top, top + 0.03] });
    // `glass`, not `glassShop`: the shopfront key is opaque on purpose (the
    // city glazes hundreds of windows with it and never pays for sorting), and
    // a display case you cannot see into is a box.
    for (const face of [cvIn[0], cvIn[1]] as const) {
      addBox(ctx, 'glass', {
        u: [ku0, ku1],
        v: [face - 0.008, face + 0.008],
        y: [top + 0.03, caseTop - 0.03],
      });
    }
    for (const end of [ku0, ku1] as const) {
      addBox(ctx, palette.metal, {
        u: [end - 0.02, end + 0.02],
        v: cvIn,
        y: [top + 0.03, caseTop],
      });
    }
    addBox(ctx, 'glass', { u: [ku0, ku1], v: cvIn, y: [caseTop - 0.03, caseTop] });
    // Felt riser the stock is laid on, and a row of price cards in front of it.
    addBox(ctx, 'roofTar', {
      u: [ku0 + 0.05, ku1 - 0.05],
      v: [cvIn[0] + 0.08, cvIn[1] - 0.05],
      y: [top + 0.03, top + 0.09],
    });
    for (let i = 0; i < plan.caseSlots; i += 1) {
      const u = ku0 + 0.18 + ((ku1 - ku0 - 0.36) * i) / Math.max(1, plan.caseSlots - 1);
      addBox(ctx, 'stuccoCream', {
        u: [u - 0.05, u + 0.05],
        v: [cvIn[0] + 0.02, cvIn[0] + 0.06],
        y: [top + 0.03, top + 0.08],
      });
    }
  }

  // Till, card terminal and a spike of paperwork at the clerk's end.
  const tillU = clamp(plan.clerkU, cu0 + 0.4, cu1 - 0.4);
  addBox(ctx, palette.metal, {
    u: [tillU - 0.24, tillU + 0.24],
    v: [cv0 + 0.14, cv1 - 0.14],
    y: [top, top + 0.19],
  });
  addBox(ctx, 'metalDark', {
    u: [tillU - 0.19, tillU + 0.19],
    v: [cv0 + 0.2, cv0 + 0.32],
    y: [top + 0.19, top + 0.36],
  });
  addBox(ctx, 'metalDark', {
    u: [tillU + 0.34, tillU + 0.46],
    v: [cv0 + 0.22, cv0 + 0.4],
    y: [top, top + 0.13],
  });
  addBox(ctx, 'stuccoCream', {
    u: [tillU - 0.62, tillU - 0.36],
    v: [cv0 + 0.16, cv0 + 0.44],
    y: [top, top + 0.05],
  });

  // Rubber duckboard the clerk stands on. Every shop counter has one and no
  // modelled one ever does.
  addBox(ctx, 'roofTar', {
    u: [cu0 + 0.3, cu1 - 0.3],
    v: [cv1 + 0.16, Math.min(cv1 + 0.86, plan.backFace - 0.9)],
    y: [F + 0.012, F + 0.03],
  });
}

/** The back wall: a cabinet run, the long-gun rack over it, and a bench. */
function addGunBackWall(ctx: Fitout, plan: GunStorePlan): void {
  const { room } = ctx;
  const { floorY: F, width: W, palette } = room;
  const back = plan.backFace;

  // Low cabinet run the whole width, under the rack.
  const runU: readonly [number, number] = [LINING + 0.1, W - LINING - 0.1];
  addBox(ctx, palette.trim, {
    u: [runU[0] + 0.06, runU[1] - 0.06],
    v: [back - 0.52, back],
    y: [F, F + 0.12],
  });
  addSolid(ctx, palette.joinery, { u: runU, v: [back - 0.56, back], y: [F + 0.12, F + 0.88] });
  addBox(ctx, palette.surface, {
    u: [runU[0] - 0.03, runU[1] + 0.03],
    v: [back - 0.62, back],
    y: [F + 0.88, F + 0.94],
  });
  const doors = clamp(Math.round((runU[1] - runU[0]) / 0.8), 3, 12);
  for (let i = 0; i < doors; i += 1) {
    const cell = (runU[1] - runU[0]) / doors;
    const u = runU[0] + cell * i;
    addBox(ctx, palette.trim, {
      u: [u + 0.04, u + cell - 0.04],
      v: [back - 0.6, back - 0.57],
      y: [F + 0.18, F + 0.84],
    });
  }

  // The rack: a boarded panel, a butt tray, muzzle dividers and a top rail.
  const [ru0, ru1] = plan.rackU;
  const rackTop = Math.min(F + 2.42, room.ceilY - 0.5);
  // Pinned dark rather than taking the palette's joinery: the rifles standing
  // against this board are the only thing in the room the eye should find
  // first, and they are pale walnut.
  addBox(ctx, 'timberDark', {
    u: [ru0 - 0.14, ru1 + 0.14],
    v: [back - 0.06, back],
    y: [plan.rackButtY - 0.16, rackTop + 0.16],
  });
  addBox(ctx, palette.trim, {
    u: [ru0 - 0.14, ru1 + 0.14],
    v: [plan.rackV - 0.06, back - 0.02],
    y: [plan.rackButtY - 0.06, plan.rackButtY],
  });
  addBox(ctx, palette.metal, {
    u: [ru0 - 0.14, ru1 + 0.14],
    v: [plan.rackV - 0.04, plan.rackV],
    y: [rackTop, rackTop + 0.05],
  });
  for (let i = 0; i <= plan.rackSlots; i += 1) {
    const u = ru0 + ((ru1 - ru0) * i) / plan.rackSlots;
    addBox(ctx, palette.trim, {
      u: [u - 0.018, u + 0.018],
      v: [plan.rackV - 0.05, back - 0.05],
      y: [plan.rackButtY, rackTop],
    });
  }
  // Price tickets along the butt tray.
  for (let i = 0; i < plan.rackSlots; i += 1) {
    const u = ru0 + ((ru1 - ru0) * (i + 0.5)) / plan.rackSlots;
    addBox(ctx, 'stuccoCream', {
      u: [u - 0.05, u + 0.05],
      v: [plan.rackV - 0.07, plan.rackV - 0.05],
      y: [plan.rackButtY - 0.14, plan.rackButtY - 0.02],
    });
  }

  // The rest of the back wall is a pegboard of hanging accessories: slings,
  // holsters, cleaning rods. Small dark shapes at eye level are what stop a
  // wall behind a counter reading as a painted plane.
  for (const side of [
    [runU[0] + 0.1, ru0 - 0.34],
    [ru1 + 0.34, runU[1] - 0.1],
  ] as const) {
    const span = side[1] - side[0];
    if (span < 0.7) continue;
    // Light hardboard, not the dark joinery: under four strip lights a
    // `timberDark` panel reads as a black rectangle, and the accessories hung
    // on it disappear into it.
    addBox(ctx, 'timber', {
      u: [side[0], side[1]],
      v: [back - 0.05, back],
      y: [F + 1.06, Math.min(F + 2.3, room.ceilY - 0.55)],
    });
    const pegs = clamp(Math.round(span / 0.34), 2, 9);
    for (let i = 0; i < pegs; i += 1) {
      const u = side[0] + 0.18 + ((span - 0.36) * i) / Math.max(1, pegs - 1);
      const row = i % 3;
      const y = F + 1.28 + row * 0.36;
      addBox(ctx, row === 1 ? 'metalDark' : palette.trim, {
        u: [u - 0.06, u + 0.06],
        v: [back - 0.13, back - 0.05],
        y: [y, y + 0.26],
      });
      addBox(ctx, palette.metal, {
        u: [u - 0.012, u + 0.012],
        v: [back - 0.11, back - 0.05],
        y: [y + 0.26, y + 0.3],
      });
    }
  }

  // Gunsmith's bench in the staff strip, on the flank the gate is not on.
  const benchLow = room.doorU <= W / 2;
  const bu: readonly [number, number] = benchLow
    ? [LINING, LINING + 1.7]
    : [W - LINING - 1.7, W - LINING];
  const bv: readonly [number, number] = [
    Math.max(plan.counterV[1] + 0.5, back - 2.3),
    Math.max(plan.counterV[1] + 1.16, back - 1.64),
  ];
  if (bv[1] > bv[0] + 0.4 && bv[1] < back - 0.7) {
    addSolid(ctx, palette.joinery, { u: bu, v: bv, y: [F + 0.72, F + 0.86] });
    for (const u of [bu[0] + 0.12, bu[1] - 0.12]) {
      addBox(ctx, palette.metal, {
        u: [u - 0.04, u + 0.04],
        v: [bv[0] + 0.06, bv[0] + 0.14],
        y: [F, F + 0.72],
      });
      addBox(ctx, palette.metal, {
        u: [u - 0.04, u + 0.04],
        v: [bv[1] - 0.14, bv[1] - 0.06],
        y: [F, F + 0.72],
      });
    }
    // A vice on the corner, a parts tray, and a boxed action beside it.
    addBox(ctx, 'metalDark', {
      u: [bu[0] + 0.16, bu[0] + 0.4],
      v: [bv[0] + 0.1, bv[0] + 0.34],
      y: [F + 0.86, F + 1.04],
    });
    addBox(ctx, palette.metal, {
      u: [bu[0] + 0.2, bu[0] + 0.36],
      v: [bv[0] + 0.06, bv[0] + 0.14],
      y: [F + 0.94, F + 1.1],
    });
    addBox(ctx, palette.metal, {
      u: [bu[0] + 0.62, bu[0] + 1.02],
      v: [bv[0] + 0.14, bv[1] - 0.12],
      y: [F + 0.86, F + 0.92],
    });
    addBox(ctx, 'canvasAwning', {
      u: [bu[0] + 1.14, bu[0] + 1.5],
      v: [bv[0] + 0.16, bv[1] - 0.14],
      y: [F + 0.86, F + 1.0],
    });
    // Tool board over the bench.
    addBox(ctx, palette.trim, {
      u: [bu[0] + 0.1, bu[1] - 0.1],
      v: benchLow ? [LINING, LINING + 0.04] : [W - LINING - 0.04, W - LINING],
      y: [F + 1.28, F + 1.98],
    });
  }
}

/** Ammunition, accessories, a glass case and a safe down the flanks. */
function addGunFlanks(ctx: Fitout, plan: GunStorePlan): void {
  const { room } = ctx;
  const { rng, floorY: F, width: W, palette } = room;
  const shelfTo = plan.counterV[0] - 0.5;
  const shelfFrom = Math.min(2.5, shelfTo - 1.2);

  if (shelfTo - shelfFrom > 1.2) {
    // Ammunition, boxed, on both flanks: the wall of small colourful cartons
    // that says "gun shop" faster than anything else in the room.
    addShelfRun(ctx, 'v', [shelfFrom, shelfTo], [LINING, LINING + 0.34], [0.78, 1.2, 1.62, 2.04], 5, AMMO_STOCK);
    addShelfRun(
      ctx,
      'v',
      [shelfFrom, shelfTo],
      [W - LINING - 0.34, W - LINING],
      [0.84, 1.26, 1.68, 2.1],
      5,
      AMMO_STOCK,
    );
    // Header boards over each run.
    for (const [v0, v1] of [
      [LINING, LINING + 0.04],
      [W - LINING - 0.04, W - LINING],
    ] as const) {
      addBox(ctx, palette.glow, {
        u: [v0, v1],
        v: [shelfFrom + 0.1, shelfTo - 0.1],
        y: [F + 2.32, F + 2.5],
      });
    }
  }

  // A tall glazed cabinet of accessories, standing against the flank the door
  // is not on so it never crowds the way in.
  const caseLow = room.doorU > W / 2;
  const gu: readonly [number, number] = caseLow
    ? [LINING, LINING + 0.48]
    : [W - LINING - 0.48, W - LINING];
  const gv: readonly [number, number] = [
    clamp(plan.counterV[0] - 1.6, 1.9, plan.counterV[0] - 0.7),
    clamp(plan.counterV[0] - 0.2, 2.9, plan.counterV[0] - 0.1),
  ];
  if (gv[1] - gv[0] > 0.9) {
    const cabTop = F + 1.96;
    if (addSolid(ctx, palette.joinery, { u: gu, v: gv, y: [F, F + 0.34] })) {
      addBox(ctx, palette.joinery, {
        u: gu,
        v: [gv[0], gv[0] + 0.05],
        y: [F + 0.34, cabTop],
      });
      addBox(ctx, palette.joinery, {
        u: gu,
        v: [gv[1] - 0.05, gv[1]],
        y: [F + 0.34, cabTop],
      });
      addBox(ctx, palette.trim, { u: gu, v: gv, y: [cabTop, cabTop + 0.07] });
      const face = caseLow ? gu[1] : gu[0];
      addBox(ctx, 'glass', {
        u: [face - 0.01, face + 0.01],
        v: [gv[0] + 0.05, gv[1] - 0.05],
        y: [F + 0.4, cabTop - 0.04],
      });
      for (const h of [0.62, 1.0, 1.38, 1.72]) {
        addBox(ctx, palette.surface, {
          u: gu,
          v: [gv[0] + 0.05, gv[1] - 0.05],
          y: [F + h, F + h + 0.035],
        });
        for (let i = 0; i < 3; i += 1) {
          const key = AMMO_STOCK[(i + Math.round(h * 10)) % AMMO_STOCK.length] ?? 'timber';
          const cell = (gv[1] - gv[0] - 0.2) / 3;
          const v = gv[0] + 0.1 + cell * (i + 0.5);
          const w = rng.range(0.07, 0.13);
          addBox(ctx, key, {
            u: [gu[0] + 0.08, gu[0] + 0.08 + w],
            v: [v - cell * 0.35, v + cell * 0.35],
            y: [F + h + 0.035, F + h + rng.range(0.14, 0.24)],
          });
        }
      }
    }
  }

  // A gun safe in the corner behind the counter: the one object in the room
  // that is obviously heavy.
  const safeLow = !caseLow;
  const su: readonly [number, number] = safeLow
    ? [LINING, LINING + 0.72]
    : [W - LINING - 0.72, W - LINING];
  const sv: readonly [number, number] = [
    clamp(plan.counterV[1] + 0.4, 1.0, plan.backFace - 1.4),
    clamp(plan.counterV[1] + 1.28, 1.9, plan.backFace - 0.5),
  ];
  if (sv[1] - sv[0] > 0.6 && addSolid(ctx, 'metalDark', { u: su, v: sv, y: [F + 0.06, F + 1.86] })) {
    addBox(ctx, palette.metal, { u: su, v: sv, y: [F, F + 0.06] });
    const face = safeLow ? su[1] : su[0];
    const dir = safeLow ? 1 : -1;
    addBox(ctx, palette.metal, {
      u: [face, face + dir * 0.03],
      v: [sv[0] + 0.06, sv[1] - 0.06],
      y: [F + 0.14, F + 1.78],
    });
    addPost(ctx, palette.metal, face + dir * 0.06, (sv[0] + sv[1]) / 2 - 0.16, [F + 0.94, F + 1.0], 0.09, 8);
    addBox(ctx, palette.metal, {
      u: [face, face + dir * 0.1],
      v: [(sv[0] + sv[1]) / 2 + 0.08, (sv[0] + sv[1]) / 2 + 0.14],
      y: [F + 0.86, F + 1.08],
    });
  }
}

/** Free-standing stock in the customer area. */
function addGunFloorStock(ctx: Fitout, plan: GunStorePlan): void {
  const { room } = ctx;
  const { rng, floorY: F, width: W, palette } = room;

  // An island table of cases and cleaning kits, offset from the entrance axis.
  const islandU = clamp(room.doorU < W / 2 ? W * 0.68 : W * 0.32, 1.3, W - 1.3);
  const islandV = clamp(plan.counterV[0] - 2.4, 2.2, plan.counterV[0] - 1.3);
  const island: LocalBox = {
    u: [islandU - 0.62, islandU + 0.62],
    v: [islandV - 0.44, islandV + 0.44],
    y: [F, F + 0.92],
  };
  if (canPlace(room, island)) {
    addSolid(ctx, palette.joinery, {
      u: [islandU - 0.62, islandU + 0.62],
      v: [islandV - 0.44, islandV + 0.44],
      y: [F + 0.12, F + 0.86],
    });
    addBox(ctx, palette.trim, {
      u: [islandU - 0.56, islandU + 0.56],
      v: [islandV - 0.38, islandV + 0.38],
      y: [F, F + 0.12],
    });
    addBox(ctx, palette.surface, {
      u: [islandU - 0.66, islandU + 0.66],
      v: [islandV - 0.48, islandV + 0.48],
      y: [F + 0.86, F + 0.92],
    });
    // Hard cases stacked on it, and a wire basket of slings.
    for (let i = 0; i < 3; i += 1) {
      addYawBox(
        ctx,
        i === 1 ? 'metalDark' : palette.trim,
        { u: islandU - 0.3 + i * 0.02, v: islandV - 0.05 },
        { du: 0.92, dv: 0.34 },
        [F + 0.92 + i * 0.11, F + 1.02 + i * 0.11],
        rng.range(-0.05, 0.05),
      );
    }
    addYawBox(
      ctx,
      'metalLight',
      { u: islandU + 0.4, v: islandV + 0.1 },
      { du: 0.36, dv: 0.36 },
      [F + 0.92, F + 1.14],
      0.3,
    );
  }

  // A pallet of ammunition cases against the wall by the door, and a bin of
  // cleaning rods beside it.
  const stackU = clamp(room.doorU < W / 2 ? W - 1.05 : 1.05, 0.9, W - 0.9);
  addCrateStack(ctx, stackU, clamp(plan.counterV[0] - 1.1, 1.6, plan.counterV[0] - 0.8), 3, 0.12);
  const binU = clamp(stackU + (room.doorU < W / 2 ? -0.95 : 0.95), 0.6, W - 0.6);
  const binV = clamp(plan.counterV[0] - 1.15, 1.6, plan.counterV[0] - 0.8);
  if (canPlace(room, { u: [binU - 0.24, binU + 0.24], v: [binV - 0.24, binV + 0.24], y: [F, F + 0.9] })) {
    addPost(ctx, palette.metal, binU, binV, [F, F + 0.62], 0.22, 8);
    for (let i = 0; i < 5; i += 1) {
      const a = (i / 5) * Math.PI * 2;
      addBox(ctx, i % 2 === 0 ? 'metalLight' : palette.trim, {
        u: [binU + Math.cos(a) * 0.1 - 0.012, binU + Math.cos(a) * 0.1 + 0.012],
        v: [binV + Math.sin(a) * 0.1 - 0.012, binV + Math.sin(a) * 0.1 + 0.012],
        y: [F + 0.5, F + 1.34],
      });
    }
  }
}

/** Boards, notices and the one lit sign the room is allowed. */
function addGunSignage(ctx: Fitout, plan: GunStorePlan): void {
  const { room } = ctx;
  const { floorY: F, width: W, palette } = room;
  const back = plan.backFace;

  // Lit shop board over the rack.
  const boardTop = Math.min(F + 2.86, room.ceilY - 0.16);
  const [ru0, ru1] = plan.rackU;
  if (boardTop - F > 2.5 && ru1 - ru0 > 1.2) {
    addBox(ctx, palette.trim, {
      u: [ru0 + 0.2, ru1 - 0.2],
      v: [back - 0.11, back],
      y: [boardTop - 0.42, boardTop],
    });
    addBox(ctx, palette.glow, {
      u: [ru0 + 0.3, ru1 - 0.3],
      v: [back - 0.14, back - 0.11],
      y: [boardTop - 0.36, boardTop - 0.06],
    });
  }

  // Framed licence, safety notice and price list, at reading height on the
  // flank the door is not on.
  const wallLow = room.doorU > W / 2;
  const nu: readonly [number, number] = wallLow
    ? [LINING, LINING + 0.03]
    : [W - LINING - 0.03, W - LINING];
  for (let i = 0; i < 3; i += 1) {
    const v = clamp(plan.counterV[0] - 0.35 - i * 0.52, 0.9, plan.counterV[0] - 0.2);
    addBox(ctx, palette.trim, { u: nu, v: [v - 0.16, v + 0.16], y: [F + 1.5, F + 1.94] });
    addBox(ctx, 'stuccoCream', {
      u: wallLow ? [nu[1], nu[1] + 0.012] : [nu[0] - 0.012, nu[0]],
      v: [v - 0.13, v + 0.13],
      y: [F + 1.54, F + 1.9],
    });
  }

  // A paper target pinned over the bench end of the back wall.
  const targetU = clamp(room.doorU < W / 2 ? W - 0.95 : 0.95, 0.7, W - 0.7);
  addBox(ctx, 'stuccoCream', {
    u: [targetU - 0.24, targetU + 0.24],
    v: [back - 0.03, back],
    y: [F + 1.34, F + 1.94],
  });
  for (let i = 0; i < 3; i += 1) {
    const r = 0.19 - i * 0.06;
    addBox(ctx, i % 2 === 0 ? 'metalDark' : 'stuccoCream', {
      u: [targetU - r, targetU + r],
      v: [back - 0.04, back - 0.032],
      y: [F + 1.64 - r, F + 1.64 + r],
    });
  }
}

/** Four fittings, no more: the interior light budget is already at its cap. */
function addGunLighting(ctx: Fitout, plan: GunStorePlan): void {
  const { room } = ctx;
  const { floorY: F, width: W } = room;
  const y = Math.min(room.ceilY - 0.16, F + 2.86);
  const [cu0, cu1] = plan.counterU;

  addStripLight(ctx, [cu0 + 0.3, cu1 - 0.3], plan.counterV[0] - 0.55, y, {
    intensity: 2.0,
    distance: 12,
  });
  addStripLight(ctx, [W * 0.2 - 0.75, W * 0.2 + 0.75], plan.counterV[0] * 0.55, y, {
    intensity: 1.8,
    distance: 11,
  });
  addStripLight(ctx, [W * 0.8 - 0.75, W * 0.8 + 0.75], plan.counterV[0] * 0.55, y, {
    intensity: 1.8,
    distance: 11,
  });
  addStripLight(ctx, [cu0 + 0.4, cu1 - 0.4], Math.min(plan.backFace - 0.7, plan.counterV[1] + 1.5), y, {
    intensity: 1.7,
    distance: 10,
  });
}

// ---------------------------------------------------------------------------
// The Vibe
// ---------------------------------------------------------------------------

/** Height of the DJ platform above the floor, in metres. */
const CLUB_STAGE_HEIGHT = 0.34;
/** Height the neon band runs at, and how deep it stands off the wall. */
const CLUB_NEON_Y = 2.15;
const CLUB_NEON_PROUD = 0.06;

/**
 * Where everything in the club goes, in room-local coordinates.
 *
 * Computed once and shared by the built geometry, the generated furniture and
 * the interaction point, so the bar the player is offered a conversation at is
 * the bar that is actually standing there. `u` runs across the frontage and
 * `v` runs from the front wall to the back.
 */
export interface NightclubPlan {
  /** The bar run, along one flank. */
  readonly barU: number;
  readonly barV: readonly [number, number];
  /** Which flank it is on: true when the bar is on the low-u side. */
  readonly barLow: boolean;
  /** The raised platform at the back. */
  readonly stageU: readonly [number, number];
  readonly stageV: readonly [number, number];
  /** Where the player is offered the conversation, and where Sable stands. */
  readonly serviceU: number;
  readonly serviceV: number;
  /** Centre of the open floor. */
  readonly floorU: number;
  readonly floorV: number;
}

export function nightclubPlan(room: Room): NightclubPlan {
  const { width: W, depth: D } = room;
  // The bar takes the flank the door is NOT on, so a customer walks in past
  // the dance floor and reaches it from the side, as they do in a real room.
  const barLow = room.doorU >= W / 2;
  const barU = barLow ? clamp(1.15, 0.9, W * 0.4) : clamp(W - 1.15, W * 0.6, W - 0.9);
  const barV: [number, number] = [clamp(D * 0.34, 1.6, D - 2.2), clamp(D * 0.78, 2.6, D - 0.9)];

  const stageHalf = clamp(W * 0.26, 0.9, 2.4);
  const stageU: [number, number] = [W / 2 - stageHalf, W / 2 + stageHalf];
  const stageV: [number, number] = [clamp(D - 2.15, 1.8, D - 0.7), clamp(D - 0.55, 2.2, D - 0.35)];

  return {
    barU,
    barV,
    barLow,
    stageU,
    stageV,
    // The near end of the bar, one step in from the room, on the open side of
    // it - the player should meet Sable by walking up to the bar, not by
    // walking through it.
    serviceU: barLow ? barU + 0.95 : barU - 0.95,
    serviceV: barV[0] + 0.7,
    floorU: W / 2,
    floorV: clamp(D * 0.46, 1.6, D - 2.6),
  };
}

/**
 * The Vibe: a converted harbour warehouse with a bar down one side, a lit
 * dance floor in the middle and a low stage at the back.
 *
 * The furniture - bar, booths, DJ console, speaker stacks - is generated and
 * placed by `Furnishings`; what is built here is the room around it: the
 * platform, the floor inlay, the neon, and the light.
 */
function addNightclubFittings(ctx: Fitout): void {
  const { room } = ctx;
  const plan = nightclubPlan(room);

  addClubStage(ctx, plan);
  addClubFloor(ctx, plan);
  addClubNeon(ctx, plan);
  addClubBackBar(ctx, plan);
  addClubLighting(ctx, plan);

  // Sable stands at the bar. `kind: 'sign'` for the same reason the gun shop's
  // counter is: the application's door handler must not try to walk through it.
  const service = toWorld(room, plan.serviceU, plan.serviceV);
  ctx.sink.interaction({
    id: `nightclub-bar-${room.parcel.id}`,
    x: service.x,
    y: room.floorY + 1.2,
    z: service.z,
    radius: 2.9,
    prompt: 'Press E to speak to Sable',
    kind: 'sign',
    parcelId: room.parcel.id,
  });
}

/** The DJ platform: a low deck at the back with a lit riser under its lip. */
function addClubStage(ctx: Fitout, plan: NightclubPlan): void {
  const { room } = ctx;
  const { floorY: F, palette } = room;
  const [su0, su1] = plan.stageU;
  const [sv0, sv1] = plan.stageV;

  addSolid(ctx, palette.structure, {
    u: [su0, su1],
    v: [sv0, sv1],
    y: [F, F + CLUB_STAGE_HEIGHT],
  });
  // A band of light along the front lip, which is what stops the platform
  // reading as a step somebody forgot to finish.
  addBox(ctx, palette.glow, {
    u: [su0 + 0.08, su1 - 0.08],
    v: [sv0 - 0.02, sv0 + 0.04],
    y: [F + 0.06, F + CLUB_STAGE_HEIGHT - 0.06],
  });
}

/**
 * The dance floor: a lit inlay set into the deck.
 *
 * Drawn a centimetre proud rather than flush. Coplanar with the floor it would
 * z-fight across the whole panel, and a floor that flickers is the single most
 * obvious way to give away that a room is two surfaces pretending to be one.
 */
function addClubFloor(ctx: Fitout, plan: NightclubPlan): void {
  const { room } = ctx;
  const { floorY: F, width: W, depth: D, palette } = room;
  const halfU = clamp(W * 0.22, 0.8, 2.6);
  const halfV = clamp(D * 0.16, 0.8, 2.2);
  const u: [number, number] = [
    clamp(plan.floorU - halfU, 0.5, W - 0.5),
    clamp(plan.floorU + halfU, 0.5, W - 0.5),
  ];
  const v: [number, number] = [
    clamp(plan.floorV - halfV, 0.5, D - 0.5),
    clamp(plan.floorV + halfV, 0.5, D - 0.5),
  ];
  if (u[1] - u[0] < 0.6 || v[1] - v[0] < 0.6) return;

  // A grid rather than one slab: four lit panels with dark joints between them
  // reads as a floor and a single lit rectangle reads as a hole.
  const cells = 4;
  for (let i = 0; i < cells; i += 1) {
    for (let j = 0; j < cells; j += 1) {
      if ((i + j) % 2 === 1) continue;
      const cu = u[0] + ((u[1] - u[0]) * i) / cells;
      const cv = v[0] + ((v[1] - v[0]) * j) / cells;
      addBox(ctx, palette.glow, {
        u: [cu + 0.05, cu + (u[1] - u[0]) / cells - 0.05],
        v: [cv + 0.05, cv + (v[1] - v[0]) / cells - 0.05],
        y: [F + 0.005, F + 0.015],
      });
    }
  }
}

/** A neon band round three walls, at the height a lit sign would be hung. */
function addClubNeon(ctx: Fitout, plan: NightclubPlan): void {
  const { room } = ctx;
  const { floorY: F, width: W, depth: D, palette } = room;
  const y = Math.min(room.ceilY - 0.35, F + CLUB_NEON_Y);
  const t = CLUB_NEON_PROUD;

  // Both flanks, from just inside the front wall to the back.
  for (const flank of [true, false]) {
    const u: [number, number] = flank ? [LINING, LINING + t] : [W - LINING - t, W - LINING];
    addBox(ctx, palette.glow, { u, v: [0.6, D - LINING], y: [y, y + 0.07] });
  }
  // And across the back, above the stage.
  addBox(ctx, palette.glow, {
    u: [LINING, W - LINING],
    v: [D - LINING - t, D - LINING],
    y: [y + 0.5, y + 0.57],
  });
  void plan;
}

/**
 * The back bar: a shelf run on the wall behind where the generated bar stands,
 * lit from under each shelf.
 */
function addClubBackBar(ctx: Fitout, plan: NightclubPlan): void {
  const { room } = ctx;
  const { floorY: F, width: W, palette } = room;
  const wallU: [number, number] = plan.barLow
    ? [LINING, LINING + 0.28]
    : [W - LINING - 0.28, W - LINING];
  const [bv0, bv1] = plan.barV;
  if (bv1 - bv0 < 1.0) return;

  for (const [i, height] of [1.15, 1.55, 1.95].entries()) {
    addBox(ctx, palette.joinery, {
      u: wallU,
      v: [bv0 + 0.15, bv1 - 0.15],
      y: [F + height, F + height + 0.05],
    });
    // The light is under the shelf, not on it: bottles are lit from below in
    // every bar there has ever been, and it is the only reason a shelf of
    // small objects reads at all at this distance.
    if (i < 2) {
      addBox(ctx, palette.glow, {
        u: [wallU[0], wallU[0] + 0.06],
        v: [bv0 + 0.2, bv1 - 0.2],
        y: [F + height - 0.04, F + height],
      });
    }
  }
}

/**
 * Club light: deliberately less of it than a shop gets.
 *
 * Two dim strips over the bar and one over the stage. The room's read comes
 * from the emissive material, which costs no light at all - this project
 * measured point lights at 61 per cent of the frame, so a nightclub is exactly
 * the room where that budget has to be spent carefully rather than generously.
 */
function addClubLighting(ctx: Fitout, plan: NightclubPlan): void {
  const { room } = ctx;
  const { floorY: F, palette } = room;
  const y = Math.min(room.ceilY - 0.2, F + 3.2);
  const [bv0, bv1] = plan.barV;
  const barSpan: [number, number] = plan.barLow
    ? [plan.barU - 0.5, plan.barU + 0.5]
    : [plan.barU - 0.5, plan.barU + 0.5];

  addStripLight(ctx, barSpan, (bv0 + bv1) / 2, y, { intensity: 1.5, distance: 9 });
  addStripLight(ctx, [plan.stageU[0] + 0.4, plan.stageU[1] - 0.4], plan.stageV[0] - 0.4, y, {
    intensity: 1.3,
    distance: 9,
  });
  void palette;
}

/**
 * Market hall: the shell the generated stalls trade in - exposed steel
 * trusses, a line of high bay lamps, a paved aisle, the hall sign, and the
 * barrow and trays nobody has put away.
 */
function addMarketFittings(ctx: Fitout): void {
  const { room } = ctx;
  const { floorY: F, width: W, depth: D, ceilY: C } = room;

  const stallDepth = clamp(D * 0.18, 1.6, 2.4);
  /*
   * The stalls themselves are NOT built here any more. Three generated trades
   * - fish, butcher, flowers, plus the produce stall - now stand on the same
   * three rows, placed by `interiorFurnishings` and carrying their own
   * colliders. What stays here is everything a stall does not own: the aisle
   * paving, the trusses, the high bay lamps, the hall sign and the barrow.
   */

  // A runner of harder-wearing paving down the main aisle.
  addQuad(ctx, 'concrete', [0.6, W - 0.6], [D / 2 - stallDepth / 2 - 1.5, D / 2 - stallDepth / 2 - 0.2], F + 0.012, true);

  // Exposed trusses across the hall.
  const trussCount = clamp(Math.round(W / 11), 2, 4);
  const chordTop = C - 0.18;
  const chordBottom = chordTop - clamp(D * 0.08, 0.55, 1.0);
  for (let i = 0; i < trussCount; i += 1) {
    const u = ((i + 0.5) * W) / trussCount;
    addBox(ctx, room.palette.structure, {
      u: [u - 0.07, u + 0.07],
      v: [LINING, D - LINING],
      y: [chordTop - 0.1, chordTop],
    });
    addBox(ctx, room.palette.structure, {
      u: [u - 0.06, u + 0.06],
      v: [LINING + 0.4, D - LINING - 0.4],
      y: [chordBottom, chordBottom + 0.09],
    });
    const panels = 3;
    for (let p = 0; p <= panels; p += 1) {
      const v = LINING + 0.4 + ((D - LINING * 2 - 0.8) * p) / panels;
      addStrut(ctx, room.palette.structure, { u, v, y: chordBottom }, { u, v, y: chordTop }, 0.055);
      if (p < panels) {
        const vNext = LINING + 0.4 + ((D - LINING * 2 - 0.8) * (p + 1)) / panels;
        addStrut(ctx, room.palette.structure, { u, v, y: chordBottom }, { u, v: vNext, y: chordTop }, 0.045);
      }
    }
  }
  // Purlins tying the trusses together.
  for (const v of [D * 0.25, D * 0.5, D * 0.75]) {
    addBox(ctx, room.palette.structure, {
      u: [LINING, W - LINING],
      v: [v - 0.05, v + 0.05],
      y: [chordTop - 0.22, chordTop - 0.1],
    });
  }

  // High bay lamps on long drops over the aisle.
  const lamps = clamp(Math.round(W / 8), 2, 4);
  const bulbY = clamp(C - 3.2, F + 3.0, F + 5.4);
  for (let i = 0; i < lamps; i += 1) {
    const u = ((i + 0.5) * W) / lamps;
    addPendant(ctx, u, D / 2 - stallDepth / 2 - 0.9, bulbY, { intensity: 2.3, distance: 14 });
  }
  // A lit hall sign facing the entrance.
  const signU = clamp(room.doorU, 1.4, W - 1.4);
  addBox(ctx, room.palette.trim, {
    u: [signU - 1.25, signU + 1.25],
    v: [LINING, LINING + 0.1],
    y: [F + 3.1, F + 3.75],
  });
  addBox(ctx, room.palette.glow, {
    u: [signU - 1.1, signU + 1.1],
    v: [LINING + 0.1, LINING + 0.14],
    y: [F + 3.2, F + 3.65],
  });
  addLight(ctx, signU, LINING + 0.9, F + 3.4, { intensity: 1.5, distance: 9 });

  // A sack barrow and a stack of empty trays left in the aisle, because a
  // trading hall is never tidy.
  const barrowU = clamp(W * 0.34, 1.2, W - 1.2);
  const barrowV = clamp(D / 2 - stallDepth / 2 - 0.9, 1.2, D - 1.2);
  const barrowBox: LocalBox = {
    u: [barrowU - 0.34, barrowU + 0.34],
    v: [barrowV - 0.3, barrowV + 0.3],
    y: [F, F + 1.15],
  };
  if (canPlace(room, barrowBox)) {
    addBox(ctx, room.palette.metal, {
      u: [barrowU - 0.26, barrowU + 0.26],
      v: [barrowV - 0.06, barrowV + 0.02],
      y: [F + 0.08, F + 1.12],
    });
    addBox(ctx, room.palette.metal, {
      u: [barrowU - 0.26, barrowU + 0.26],
      v: [barrowV - 0.06, barrowV + 0.28],
      y: [F + 0.06, F + 0.14],
    });
    for (let i = 0; i < 2; i += 1) {
      addBox(ctx, 'metalDark', {
        u: [barrowU - 0.3 + i * 0.54, barrowU - 0.24 + i * 0.54],
        v: [barrowV - 0.14, barrowV + 0.02],
        y: [F, F + 0.16],
      });
    }
    addCollider(ctx, barrowBox, true);
  }
}

/**
 * Lobby: reception desk, a lift core with two sets of doors, a seating group
 * and a planter, under a coffered ceiling.
 */
function addLobbyFittings(ctx: Fitout): void {
  const { room } = ctx;
  const { floorY: F, width: W, depth: D, ceilY: C } = room;
  const backFace = D - LINING;

  // Lift core: a solid mass on the back wall, offset from centre.
  const coreCentre = clamp(W * 0.62, 3.0, W - 3.0);
  const coreHalf = clamp(W * 0.12, 1.5, 2.4);
  addSolid(ctx, 'concreteBoard', {
    u: [coreCentre - coreHalf, coreCentre + coreHalf],
    v: [backFace - 0.34, backFace],
    y: [F, C],
  });
  for (const side of [-1, 1]) {
    const doorCentre = coreCentre + side * coreHalf * 0.5;
    addBox(ctx, room.palette.metal, {
      u: [doorCentre - 0.58, doorCentre - 0.02],
      v: [backFace - 0.4, backFace - 0.34],
      y: [F, F + 2.3],
    });
    addBox(ctx, room.palette.metal, {
      u: [doorCentre + 0.02, doorCentre + 0.58],
      v: [backFace - 0.4, backFace - 0.34],
      y: [F, F + 2.3],
    });
    addBox(ctx, 'metalDark', {
      u: [doorCentre - 0.64, doorCentre + 0.64],
      v: [backFace - 0.42, backFace - 0.34],
      y: [F + 2.3, F + 2.44],
    });
    addBox(ctx, room.palette.glow, {
      u: [doorCentre - 0.16, doorCentre + 0.16],
      v: [backFace - 0.44, backFace - 0.4],
      y: [F + 2.5, F + 2.62],
    });
    addBox(ctx, 'metalDark', {
      u: [doorCentre + 0.72, doorCentre + 0.84],
      v: [backFace - 0.4, backFace - 0.35],
      y: [F + 1.0, F + 1.24],
    });
  }

  // Reception desk with a return, on the opposite side to the lifts.
  const deskU = clamp(W * 0.22, 1.6, W - 4.0);
  const deskV = clamp(D * 0.62, 2.4, D - 1.6);
  addCounter(ctx, [deskU - 1.5, deskU + 1.5], [deskV, deskV + 0.72], 1.08);
  addCounter(ctx, [deskU + 1.5, deskU + 2.1], [deskV - 1.1, deskV + 0.72], 1.08);
  addBox(ctx, room.palette.metal, {
    u: [deskU - 0.55, deskU + 0.1],
    v: [deskV + 0.12, deskV + 0.5],
    y: [F + 1.08, F + 1.14],
  });
  addBox(ctx, 'metalDark', {
    u: [deskU - 0.42, deskU - 0.02],
    v: [deskV + 0.2, deskV + 0.24],
    y: [F + 1.14, F + 1.46],
  });
  addBox(ctx, room.palette.glow, {
    u: [deskU - 1.4, deskU + 1.4],
    v: [deskV - 0.03, deskV],
    y: [F + 0.24, F + 0.34],
  });

  // Seating group in the window, on the far side of the entrance from the desk.
  const seatU = clamp(room.doorU < W / 2 ? W * 0.74 : W * 0.26, 2.2, W - 2.2);
  for (const [offset, yaw] of [
    [-1.35, 0.06],
    [1.35, -0.05],
  ] as const) {
    const u = clamp(seatU + offset, 0.9, W - 0.9);
    if (!canPlace(room, { u: [u - 0.9, u + 0.9], v: [1.3, 2.1], y: [F, F + 0.94] })) continue;
    addYawBox(ctx, room.palette.fabric, { u, v: 1.7 }, { du: 1.7, dv: 0.72 }, [F + 0.34, F + 0.46], yaw, true);
    addYawBox(ctx, room.palette.joinery, { u, v: 1.7 }, { du: 1.7, dv: 0.72 }, [F + 0.06, F + 0.34], yaw);
    addYawBox(ctx, room.palette.fabric, { u, v: 1.98 }, { du: 1.7, dv: 0.16 }, [F + 0.46, F + 0.94], yaw);
  }
  if (canPlace(room, { u: [seatU - 0.6, seatU + 0.6], v: [1.4, 2.0], y: [F, F + 0.42] })) {
    addYawBox(ctx, room.palette.surface, { u: seatU, v: 1.7 }, { du: 0.95, dv: 0.55 }, [F + 0.36, F + 0.42], 0.04, true);
    addBox(ctx, room.palette.metal, {
      u: [seatU - 0.36, seatU + 0.36],
      v: [1.55, 1.85],
      y: [F, F + 0.36],
    });
  }

  // Planters flanking the way in.
  for (const u of [clamp(room.doorU - 2.4, 0.8, W - 0.8), clamp(room.doorU + 2.4, 0.8, W - 0.8)]) {
    const box: LocalBox = { u: [u - 0.45, u + 0.45], v: [0.65, 1.55], y: [F, F + 0.55] };
    if (!canPlace(room, box)) continue;
    if (!addSolid(ctx, room.palette.trim, box)) continue;
    addBox(ctx, 'barkTree', { u: [u - 0.38, u + 0.38], v: [0.72, 1.48], y: [F + 0.55, F + 0.6] });
    for (let i = 0; i < 3; i += 1) {
      const spread = 0.3 - i * 0.07;
      addYawBox(
        ctx,
        i === 1 ? 'foliageDark' : 'foliage',
        { u: u + (i - 1) * 0.14, v: 1.1 + (i - 1) * 0.1 },
        { du: spread * 2, dv: spread * 2 },
        [F + 0.6 + i * 0.28, F + 0.95 + i * 0.32],
        0.6 * i,
      );
    }
  }

  // Panelled dado and pilasters. A stone lobby with flat walls has nothing for
  // the light to catch; this is the cheapest modelling that fixes that.
  const dadoTop = F + 1.05;
  addBox(ctx, room.palette.trim, {
    u: [LINING, W - LINING],
    v: [D - LINING - 0.06, D - LINING],
    y: [F + 0.14, dadoTop],
  });
  addBox(ctx, room.palette.trim, { u: [LINING, LINING + 0.06], v: [LINING, D - LINING], y: [F + 0.14, dadoTop] });
  addBox(ctx, room.palette.trim, {
    u: [W - LINING - 0.06, W - LINING],
    v: [LINING, D - LINING],
    y: [F + 0.14, dadoTop],
  });
  const bays = clamp(Math.round(W / 4.2), 3, 8);
  for (let i = 1; i < bays; i += 1) {
    const u = (W * i) / bays;
    // Skip the bays the lift core already occupies.
    if (u > coreCentre - coreHalf - 0.3 && u < coreCentre + coreHalf + 0.3) continue;
    addBox(ctx, room.palette.wall, {
      u: [u - 0.17, u + 0.17],
      v: [D - LINING - 0.11, D - LINING],
      y: [F, C - 0.26],
    });
    addBox(ctx, room.palette.trim, {
      u: [u - 0.21, u + 0.21],
      v: [D - LINING - 0.15, D - LINING],
      y: [C - 0.38, C - 0.26],
    });
  }

  // A row of columns down the middle. A 12 m clear span would be a lie, and
  // the columns are what give a long lobby any depth at all.
  const columnCount = clamp(Math.round(W / 7.5), 2, 5);
  for (let i = 0; i < columnCount; i += 1) {
    const u = (W * (i + 0.5)) / columnCount;
    const v = clamp(D * 0.36, 1.6, D - 1.6);
    const shaft: LocalBox = { u: [u - 0.24, u + 0.24], v: [v - 0.24, v + 0.24], y: [F, C] };
    if (!canPlace(room, shaft)) continue;
    addSolid(ctx, 'concreteBoard', shaft);
    addBox(ctx, room.palette.trim, {
      u: [u - 0.32, u + 0.32],
      v: [v - 0.32, v + 0.32],
      y: [F + 0.02, F + 0.22],
    });
    addBox(ctx, room.palette.trim, {
      u: [u - 0.34, u + 0.34],
      v: [v - 0.34, v + 0.34],
      y: [C - 0.34, C - 0.24],
    });
  }

  // Framed panels between the pilasters on the flank wall.
  for (let i = 0; i < 3; i += 1) {
    const v = clamp(D * (0.25 + i * 0.22), 0.9, D - 0.9);
    addBox(ctx, room.palette.joinery, {
      u: [LINING, LINING + 0.05],
      v: [v - 0.55, v + 0.55],
      y: [F + 1.25, F + 2.35],
    });
    addBox(ctx, i === 1 ? 'stuccoPeach' : 'stuccoBlue', {
      u: [LINING + 0.05, LINING + 0.07],
      v: [v - 0.46, v + 0.46],
      y: [F + 1.34, F + 2.26],
    });
  }

  // A backdrop behind the desk, with the building's name lit on it.
  addBox(ctx, 'concreteBoard', {
    u: [deskU - 1.7, deskU + 1.7],
    v: [deskV + 0.72, deskV + 0.82],
    y: [F, F + 2.6],
  });
  addBox(ctx, room.palette.glow, {
    u: [deskU - 1.1, deskU + 1.1],
    v: [deskV + 0.68, deskV + 0.72],
    y: [F + 1.75, F + 2.1],
  });
  addLight(ctx, deskU, deskV + 0.2, F + 2.2, { intensity: 1.4, distance: 8 });

  // A pair of armchairs and a stone bench by the lifts.
  for (const offset of [-1.0, 1.0]) {
    const u = clamp(coreCentre + offset * (coreHalf + 1.4), 1.0, W - 1.0);
    const seat: LocalBox = { u: [u - 0.45, u + 0.45], v: [D - 2.6, D - 1.7], y: [F, F + 0.86] };
    if (!canPlace(room, seat)) continue;
    addYawBox(ctx, room.palette.fabric, { u, v: D - 2.15 }, { du: 0.86, dv: 0.86 }, [F + 0.32, F + 0.46], 0.1, true);
    addYawBox(ctx, room.palette.joinery, { u, v: D - 2.15 }, { du: 0.78, dv: 0.78 }, [F + 0.06, F + 0.32], 0.1);
    addYawBox(ctx, room.palette.fabric, { u, v: D - 1.82 }, { du: 0.86, dv: 0.2 }, [F + 0.46, F + 0.86], 0.1);
  }

  // An umbrella stand and a clock: the details that date a lobby.
  const standU = clamp(room.doorU + 3.4, 0.8, W - 0.8);
  addPost(ctx, room.palette.metal, standU, 0.62, [F, F + 0.55], 0.19, 8);
  addBox(ctx, 'metalDark', {
    u: [coreCentre - 0.28, coreCentre + 0.28],
    v: [D - LINING - 0.42, D - LINING - 0.36],
    y: [F + 2.75, F + 3.31],
  });
  addBox(ctx, 'stuccoCream', {
    u: [coreCentre - 0.23, coreCentre + 0.23],
    v: [D - LINING - 0.46, D - LINING - 0.42],
    y: [F + 2.8, F + 3.26],
  });

  // Directory board on a flank wall.
  const dirV = clamp(D * 0.55, 1.8, D - 1.0);
  addBox(ctx, room.palette.joinery, {
    u: [W - LINING - 0.08, W - LINING],
    v: [dirV - 0.8, dirV + 0.8],
    y: [F + 1.05, F + 2.2],
  });
  addBox(ctx, room.palette.glow, {
    u: [W - LINING - 0.11, W - LINING - 0.08],
    v: [dirV - 0.7, dirV + 0.7],
    y: [F + 1.15, F + 2.1],
  });

  // Coffered ceiling: ribs both ways, with a downlight in four of the coffers.
  const ribsU = clamp(Math.round(W / 3.2), 2, 8);
  for (let i = 1; i < ribsU; i += 1) {
    const u = (W * i) / ribsU;
    addBox(ctx, room.palette.structure, {
      u: [u - 0.1, u + 0.1],
      v: [LINING, D - LINING],
      y: [C - 0.24, C],
    });
  }
  const ribsV = clamp(Math.round(D / 3.0), 2, 5);
  for (let i = 1; i < ribsV; i += 1) {
    const v = (D * i) / ribsV;
    addBox(ctx, room.palette.structure, {
      u: [LINING, W - LINING],
      v: [v - 0.1, v + 0.1],
      y: [C - 0.24, C],
    });
  }
  const lampV = D * 0.5;
  const downlights = 3;
  for (let i = 0; i < downlights; i += 1) {
    const u = (W * (i + 0.5)) / downlights;
    addBox(ctx, room.palette.metal, {
      u: [u - 0.24, u + 0.24],
      v: [lampV - 0.24, lampV + 0.24],
      y: [C - 0.3, C - 0.24],
    });
    addBox(ctx, room.palette.glow, {
      u: [u - 0.19, u + 0.19],
      v: [lampV - 0.19, lampV + 0.19],
      y: [C - 0.34, C - 0.3],
    });
    addLight(ctx, u, lampV, C - 0.42, { intensity: 1.7, distance: 12 });
  }

  // -- the layer that makes it a building somebody works in ------------------

  // A darker stone ribbon inside the border band. Two triangles each, and it is
  // what stops 300 square metres of floor reading as one flat slab.
  const inlay = 1.15;
  for (const strip of [
    { u: [inlay, W - inlay], v: [inlay, inlay + 0.22] },
    { u: [inlay, W - inlay], v: [D - inlay - 0.22, D - inlay] },
    { u: [inlay, inlay + 0.22], v: [inlay + 0.22, D - inlay - 0.22] },
    { u: [W - inlay - 0.22, W - inlay], v: [inlay + 0.22, D - inlay - 0.22] },
  ] as const) {
    if (strip.u[1] <= strip.u[0] || strip.v[1] <= strip.v[0]) continue;
    addQuad(ctx, 'pavementDark', strip.u, strip.v, F + 0.016, true);
  }

  // Posted rope line steering visitors past the desk.
  const ropeV = clamp(deskV - 1.5, 1.2, D - 1.2);
  for (let i = 0; i < 2; i += 1) {
    const u = clamp(deskU - 1.9 + i * 1.9, 0.8, W - 0.8);
    addPost(ctx, room.palette.metal, u, ropeV, [F, F + 0.06], 0.17, 8);
    addPost(ctx, room.palette.metal, u, ropeV, [F + 0.06, F + 0.94], 0.035, 6);
    addPost(ctx, 'metalLight', u, ropeV, [F + 0.94, F + 1.0], 0.05, 6);
  }
  addStrut(
    ctx,
    room.palette.fabric,
    { u: clamp(deskU - 1.9, 0.8, W - 0.8), v: ropeV, y: F + 0.9 },
    { u: clamp(deskU, 0.8, W - 0.8), v: ropeV, y: F + 0.9 },
    0.035,
  );

  // Water cooler beside the lift core.
  const coolerU = clamp(coreCentre - coreHalf - 0.7, 0.8, W - 0.8);
  const coolerBox: LocalBox = {
    u: [coolerU - 0.22, coolerU + 0.22],
    v: [backFace - 0.6, backFace - 0.16],
    y: [F, F + 1.32],
  };
  if (canPlace(room, coolerBox)) {
    addSolid(ctx, 'stuccoCream', {
      u: [coolerU - 0.2, coolerU + 0.2],
      v: [backFace - 0.56, backFace - 0.2],
      y: [F, F + 0.98],
    });
    addBox(ctx, 'glass', {
      u: [coolerU - 0.15, coolerU + 0.15],
      v: [backFace - 0.52, backFace - 0.24],
      y: [F + 0.98, F + 1.32],
    });
    addBox(ctx, room.palette.metal, {
      u: [coolerU - 0.09, coolerU + 0.09],
      v: [backFace - 0.6, backFace - 0.53],
      y: [F + 0.62, F + 0.72],
    });
  }

  // Framed work on the flank the directory does not use.
  for (let i = 0; i < 3; i += 1) {
    const v = clamp(D * (0.2 + i * 0.24), 0.9, D - 0.9);
    if (Math.abs(v - dirV) < 1.0) continue;
    addBox(ctx, room.palette.joinery, {
      u: [W - LINING - 0.06, W - LINING],
      v: [v - 0.42, v + 0.42],
      y: [F + 1.35, F + 2.15],
    });
    addBox(ctx, i === 1 ? 'stuccoSand' : 'stuccoMint', {
      u: [W - LINING - 0.08, W - LINING - 0.06],
      v: [v - 0.35, v + 0.35],
      y: [F + 1.43, F + 2.07],
    });
  }

  // Magazines on the low table, and a tall plant in the corner behind it.
  addBox(ctx, 'stuccoCream', {
    u: [seatU - 0.18, seatU + 0.1],
    v: [1.6, 1.82],
    y: [F + 0.42, F + 0.46],
  });
  const palmU = clamp(seatU + (seatU < W / 2 ? -2.0 : 2.0), 0.9, W - 0.9);
  const palmBox: LocalBox = { u: [palmU - 0.4, palmU + 0.4], v: [0.75, 1.55], y: [F, F + 2.1] };
  if (canPlace(room, palmBox)) {
    addCone(ctx, room.palette.trim, palmU, 1.15, [F, F + 0.62], 0.34, 0.26, 8);
    addPost(ctx, 'barkTree', palmU, 1.15, [F + 0.62, F + 1.5], 0.07, 6);
    for (let i = 0; i < 3; i += 1) {
      addYawBox(
        ctx,
        i === 1 ? 'foliageDark' : 'foliage',
        { u: palmU, v: 1.15 },
        { du: 1.15 - i * 0.2, dv: 1.15 - i * 0.2 },
        [F + 1.5 + i * 0.24, F + 1.66 + i * 0.24],
        0.6 * i,
      );
    }
    addCollider(ctx, { u: [palmU - 0.34, palmU + 0.34], v: [0.81, 1.49], y: [F, F + 0.62] }, true);
  }

  // Hanging sign over the lift lobby.
  const signV = clamp(backFace - 2.4, 1.4, D - 1.0);
  addBox(ctx, 'metalDark', {
    u: [coreCentre - 0.95, coreCentre + 0.95],
    v: [signV - 0.03, signV + 0.03],
    y: [C - 1.02, C - 0.7],
  });
  addBox(ctx, room.palette.glow, {
    u: [coreCentre - 0.82, coreCentre + 0.82],
    v: [signV - 0.05, signV - 0.03],
    y: [C - 0.97, C - 0.75],
  });
  for (const u of [coreCentre - 0.85, coreCentre + 0.85]) {
    addStrut(ctx, room.palette.metal, { u, v: signV, y: C }, { u, v: signV, y: C - 0.7 }, 0.025);
  }
}

/**
 * Workshop: benches down the flanks, a tool wall, a hoist gantry, pallets, and
 * a steel mezzanine office reached by a straight flight.
 */
/**
 * Where the mission's crate sits, in world space, or null for any other room.
 *
 * Derived from the SAME layout entry that places the model, so the prompt the
 * player walks up to and the box they can see are the same object. Exported
 * because both the world build (which emits the interaction point) and the
 * mission (which decides what pressing E does) need it.
 */
/**
 * Where a named person stands in a room, and which way they face.
 *
 * Two of these exist: Sable behind the bar in the club, and Teo beside the
 * crate in the lock-up. Both are derived from the layout that put the bar and
 * the crate there, so a person is never standing inside their own furniture.
 */
export interface StandingAnchor {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Camera-convention heading: forward is `(-sin h, 0, -cos h)`. */
  readonly heading: number;
}

/** Sable, behind her own bar, facing the room. */
export function nightclubAnchor(parcel: Parcel): StandingAnchor | null {
  if (parcel.interiorKind !== 'nightclub') return null;
  const room = makeRoom(parcel, 'nightclub');
  const plan = nightclubPlan(room);
  // A step behind the bar run, on the wall side, and a little further in than
  // the service point so she is across the counter from the player.
  const behind = plan.barLow ? plan.barU - 0.62 : plan.barU + 0.62;
  const at = toWorld(room, clamp(behind, 0.45, room.width - 0.45), plan.serviceV + 0.35);
  const service = toWorld(room, plan.serviceU, plan.serviceV);
  return {
    x: at.x,
    y: room.floorY,
    z: at.z,
    // Facing whoever is standing at the service point.
    heading: Math.atan2(-(service.x - at.x), -(service.z - at.z)),
  };
}

/** Teo, beside the bench the crate is on, facing the door. */
export function lockupAnchor(parcel: Parcel): StandingAnchor | null {
  const crate = lockupCrateAt(parcel);
  if (!crate) return null;
  const room = makeRoom(parcel, 'workshop');
  const door = toWorld(room, room.doorU, 0);
  // A pace to the door side of the crate, so he is beside it rather than
  // standing in the bench.
  const dx = door.x - crate.x;
  const dz = door.z - crate.z;
  const length = Math.hypot(dx, dz) || 1;
  return {
    x: crate.x + (dx / length) * 1.05,
    y: room.floorY,
    z: crate.z + (dz / length) * 1.05,
    heading: Math.atan2(-dx / length, -dz / length),
  };
}

export function lockupCrateAt(parcel: Parcel): { x: number; y: number; z: number } | null {
  if (parcel.interiorKind !== 'workshop') return null;
  const crate = interiorFurnishings(parcel).find((piece) => piece.model === 'cashBox');
  return crate ? { x: crate.x, y: crate.y, z: crate.z } : null;
}

function addWorkshopFittings(ctx: Fitout): void {
  const { room } = ctx;
  const { rng, floorY: F, width: W, depth: D, ceilY: C } = room;
  const backFace = D - LINING;

  /*
   * The crate on the bench, as something the player can press E on.
   *
   * `kind: 'sign'`, like the shop counter, so the door handler ignores it. It
   * exists whether or not a mission is running - the world does not know about
   * missions - and what it SAYS is decided at runtime by whoever is listening;
   * see `MissionDirector.promptFor`.
   */
  const crate = lockupCrateAt(room.parcel);
  if (crate) {
    ctx.sink.interaction({
      id: `lockup-crate-${room.parcel.id}`,
      x: crate.x,
      y: crate.y,
      z: crate.z,
      radius: 2.4,
      prompt: 'Press E to check the crate',
      kind: 'sign',
      parcelId: room.parcel.id,
    });
  }

  // Bay markings on the slab.
  addQuad(ctx, 'roadPaintYellow', [W * 0.34, W * 0.34 + 0.1], [1.2, D - 1.2], F + 0.012, true);
  addQuad(ctx, 'roadPaintYellow', [W * 0.34, W * 0.72], [1.2, 1.3], F + 0.012, true);
  addQuad(ctx, 'roadPaintYellow', [W * 0.72 - 0.1, W * 0.72], [1.2, D - 1.2], F + 0.012, true);

  // Roller shutter to the loading bay, closed, with its drum and guides.
  const shutterU = clamp(room.doorU > W / 2 ? W * 0.22 : W * 0.78, 2.2, W - 2.2);
  const shutterHalf = 1.7;
  const shutterTop = Math.min(F + 3.6, C - 0.5);
  const shutterOk = addSolid(ctx, 'shutter', {
    u: [shutterU - shutterHalf, shutterU + shutterHalf],
    v: [LINING, LINING + 0.07],
    y: [F + 0.05, shutterTop],
  });
  for (let i = 0; shutterOk && i < 7; i += 1) {
    const y = F + 0.2 + ((shutterTop - F - 0.4) * i) / 6;
    addBox(ctx, 'metalDark', {
      u: [shutterU - shutterHalf, shutterU + shutterHalf],
      v: [LINING + 0.07, LINING + 0.09],
      y: [y, y + 0.04],
    });
  }
  if (shutterOk) {
    addBox(ctx, room.palette.metal, {
      u: [shutterU - shutterHalf - 0.12, shutterU + shutterHalf + 0.12],
      v: [LINING, LINING + 0.28],
      y: [shutterTop, shutterTop + 0.34],
    });
    for (const side of [-1, 1]) {
      addBox(ctx, room.palette.metal, {
        u: [shutterU + side * shutterHalf, shutterU + side * (shutterHalf + 0.12)],
        v: [LINING, LINING + 0.14],
        y: [F, shutterTop],
      });
    }
  }

  // Benches along the back wall.
  const benchCount = clamp(Math.floor(W / 6), 2, 4);
  for (let i = 0; i < benchCount; i += 1) {
    const u0 = 0.6 + (W - 1.2) * (i / benchCount) + 0.3;
    const u1 = Math.min(u0 + clamp((W - 1.2) / benchCount - 0.9, 1.4, 3.2), W - 0.6);
    if (u1 - u0 < 1.2) continue;
    const v0 = backFace - 0.78;
    if (!addSolid(ctx, room.palette.metal, { u: [u0, u1], v: [v0, backFace], y: [F + 0.72, F + 0.82] })) continue;
    addBox(ctx, room.palette.surface, { u: [u0 - 0.03, u1 + 0.03], v: [v0 - 0.04, backFace], y: [F + 0.82, F + 0.9] });
    for (const u of [u0 + 0.14, u1 - 0.14]) {
      addBox(ctx, room.palette.metal, { u: [u - 0.05, u + 0.05], v: [v0 + 0.08, v0 + 0.2], y: [F, F + 0.72] });
      addBox(ctx, room.palette.metal, { u: [u - 0.05, u + 0.05], v: [backFace - 0.2, backFace - 0.08], y: [F, F + 0.72] });
    }
    // Backboard with hanging tools.
    addBox(ctx, room.palette.joinery, { u: [u0, u1], v: [backFace - 0.06, backFace], y: [F + 0.9, F + 1.9] });
    const tools = 6;
    for (let t = 0; t < tools; t += 1) {
      const u = u0 + 0.2 + ((u1 - u0 - 0.4) * (t + 0.5)) / tools;
      const len = rng.range(0.16, 0.34);
      addBox(ctx, t % 2 === 0 ? 'metalDark' : room.palette.metal, {
        u: [u - 0.03, u + 0.03],
        v: [backFace - 0.1, backFace - 0.06],
        y: [F + 1.6 - len, F + 1.6],
      });
    }
    // A vice at one end.
    addBox(ctx, 'metalDark', { u: [u0 + 0.12, u0 + 0.42], v: [v0 + 0.05, v0 + 0.35], y: [F + 0.9, F + 1.14] });
  }

  // Parts racking down a flank wall.
  addShelfRun(
    ctx,
    'v',
    [1.2, Math.min(6.0, D - 1.2)],
    [LINING, LINING + 0.5],
    [0.9, 1.5, 2.1],
    5,
    ['metalLight', 'timber', 'rust', 'metalDark'],
  );

  // Pallets and drums.
  const stackU = clamp(W * 0.5, 1.2, W - 1.2);
  for (let i = 0; i < 3; i += 1) {
    const y = F + i * 0.16;
    addBox(ctx, room.palette.joinery, {
      u: [stackU - 0.6, stackU + 0.6],
      v: [D * 0.42 - 0.4, D * 0.42 + 0.4],
      y: [y + 0.1, y + 0.16],
    });
    addBox(ctx, room.palette.joinery, {
      u: [stackU - 0.6, stackU - 0.48],
      v: [D * 0.42 - 0.4, D * 0.42 + 0.4],
      y: [y, y + 0.1],
    });
    addBox(ctx, room.palette.joinery, {
      u: [stackU + 0.48, stackU + 0.6],
      v: [D * 0.42 - 0.4, D * 0.42 + 0.4],
      y: [y, y + 0.1],
    });
  }
  addCrateStack(ctx, stackU, D * 0.42, 2, 0.1);
  for (let i = 0; i < 2; i += 1) {
    const u = clamp(W * 0.86 + i * 0.68, 0.7, W - 0.7);
    addPost(ctx, i === 0 ? 'rust' : 'metalDark', u, clamp(D * 0.3, 0.8, D - 0.8), [F, F + 0.88], 0.29, 10);
  }

  // A machine line down the middle of the shop: pillar drill, saw bench,
  // compressor, parts washer. Four boxes each, and they fill the floor the way
  // a working shop actually is filled.
  const machineV = clamp(D * 0.62, 2.6, D - 2.4);
  const machineCount = clamp(Math.floor(W / 7), 2, 5);
  for (let i = 0; i < machineCount; i += 1) {
    const u = 1.4 + ((W - 4.0) * (i + 0.5)) / machineCount;
    const body: LocalBox = {
      u: [u - 0.55, u + 0.55],
      v: [machineV - 0.45, machineV + 0.45],
      y: [F, F + 0.95],
    };
    if (!addSolid(ctx, room.palette.metal, body)) continue;
    addBox(ctx, 'metalDark', {
      u: [u - 0.62, u + 0.62],
      v: [machineV - 0.52, machineV + 0.52],
      y: [F + 0.95, F + 1.02],
    });
    if (i % 3 === 0) {
      // Pillar drill: a column with a head over the table.
      addPost(ctx, room.palette.metal, u, machineV, [F + 1.02, F + 2.05], 0.07, 8);
      addBox(ctx, 'metalDark', {
        u: [u - 0.18, u + 0.18],
        v: [machineV - 0.3, machineV + 0.18],
        y: [F + 1.85, F + 2.15],
      });
    } else if (i % 3 === 1) {
      // Saw bench with a blade guard and a stock of offcuts.
      addBox(ctx, 'metalDark', {
        u: [u - 0.06, u + 0.06],
        v: [machineV - 0.22, machineV + 0.22],
        y: [F + 1.02, F + 1.3],
      });
      addBox(ctx, room.palette.joinery, {
        u: [u - 0.5, u - 0.1],
        v: [machineV - 0.4, machineV + 0.4],
        y: [F + 1.02, F + 1.16],
      });
    } else {
      // Compressor: a receiver on its side with a motor on top.
      addPost(ctx, 'rust', u, machineV, [F + 1.02, F + 1.5], 0.24, 8);
      addBox(ctx, 'metalDark', {
        u: [u - 0.22, u + 0.22],
        v: [machineV - 0.2, machineV + 0.2],
        y: [F + 1.5, F + 1.78],
      });
    }
  }

  // Pallet racking on the end wall: uprights, beams and loaded pallets.
  const rackU = clamp(1.2, 0.4, W - 4.0);
  const rackLength = clamp(W * 0.16, 2.4, 5.0);
  const rackTop = Math.min(F + 3.4, C - 0.6);
  if (canPlace(room, { u: [rackU, rackU + rackLength], v: [LINING, LINING + 1.1], y: [F, rackTop] })) {
    for (let i = 0; i <= 2; i += 1) {
      const u = rackU + (rackLength * i) / 2;
      addSolid(ctx, room.palette.structure, {
        u: [u - 0.06, u + 0.06],
        v: [LINING + 0.05, LINING + 1.05],
        y: [F, rackTop],
      });
    }
    for (const level of [1.15, 2.25]) {
      for (const v of [LINING + 0.12, LINING + 0.92]) {
        addBox(ctx, room.palette.metal, {
          u: [rackU, rackU + rackLength],
          v: [v - 0.05, v + 0.05],
          y: [F + level, F + level + 0.1],
        });
      }
      for (let i = 0; i < 2; i += 1) {
        const u = rackU + 0.3 + ((rackLength - 0.6) * (i + 0.5)) / 2;
        addBox(ctx, room.palette.joinery, {
          u: [u - 0.5, u + 0.5],
          v: [LINING + 0.14, LINING + 0.94],
          y: [F + level + 0.1, F + level + 0.18],
        });
        addBox(ctx, i === 0 ? 'canvasAwning' : 'metalLight', {
          u: [u - 0.42, u + 0.42],
          v: [LINING + 0.2, LINING + 0.88],
          y: [F + level + 0.18, F + level + rng.range(0.5, 0.72)],
        });
      }
    }
  }

  // Hoist gantry: two portal frames, a runway beam and a chain block. It goes
  // on the far side of the shop from the door so it never straddles the way in.
  const hoistU = clamp(room.doorU > W / 2 ? W * 0.3 : W * 0.7, 2.2, W - 2.2);
  const hoistV: readonly [number, number] = [clamp(D * 0.2, 1.0, D - 3.0), clamp(D * 0.2 + 2.4, 2.4, D - 0.8)];
  const beamY = Math.min(F + 3.1, C - 0.6);
  for (const v of hoistV) {
    for (const side of [-1, 1]) {
      const u = hoistU + side * 1.3;
      const leg: LocalBox = { u: [u - 0.12, u + 0.12], v: [v - 0.12, v + 0.12], y: [F, beamY] };
      if (!canPlace(room, leg)) continue;
      addBox(ctx, room.palette.structure, { u: [u - 0.08, u + 0.08], v: [v - 0.08, v + 0.08], y: [F, beamY] });
      addStrut(
        ctx,
        room.palette.structure,
        { u, v, y: beamY - 0.7 },
        { u: hoistU + side * 0.35, v, y: beamY },
        0.07,
      );
      addCollider(ctx, leg);
    }
  }
  addBox(ctx, room.palette.structure, {
    u: [hoistU - 1.42, hoistU + 1.42],
    v: [hoistV[0] - 0.08, hoistV[0] + 0.08],
    y: [beamY, beamY + 0.24],
  });
  addBox(ctx, room.palette.structure, {
    u: [hoistU - 1.42, hoistU + 1.42],
    v: [hoistV[1] - 0.08, hoistV[1] + 0.08],
    y: [beamY, beamY + 0.24],
  });
  const runwayV = (hoistV[0] + hoistV[1]) / 2;
  addBox(ctx, room.palette.structure, {
    u: [hoistU - 0.1, hoistU + 0.1],
    v: [hoistV[0], hoistV[1]],
    y: [beamY + 0.02, beamY + 0.22],
  });
  addBox(ctx, 'metalDark', {
    u: [hoistU - 0.16, hoistU + 0.16],
    v: [runwayV - 0.18, runwayV + 0.18],
    y: [beamY - 0.36, beamY + 0.02],
  });
  addBox(ctx, room.palette.metal, {
    u: [hoistU - 0.03, hoistU + 0.03],
    v: [runwayV - 0.03, runwayV + 0.03],
    y: [F + 1.1, beamY - 0.36],
  });
  addBox(ctx, 'metalDark', {
    u: [hoistU - 0.09, hoistU + 0.09],
    v: [runwayV - 0.06, runwayV + 0.06],
    y: [F + 0.92, F + 1.1],
  });

  // Mezzanine office over the back corner, with a straight steel flight up.
  const deckY = clamp(F + 2.65, F + 2.4, C - 2.05);
  if (C - deckY > 1.95 && W > 12 && D > 6) {
    const deckU: readonly [number, number] = [W - clamp(W * 0.24, 4.5, 8.0), W - LINING];
    const deckV: readonly [number, number] = [D - clamp(D * 0.32, 2.6, 4.4), backFace];
    addPlatform(ctx, room.palette.structure, { u: deckU, v: deckV, y: [deckY - 0.16, deckY] });
    for (const u of [deckU[0] + 0.15, (deckU[0] + deckU[1]) / 2]) {
      addSolid(ctx, room.palette.structure, {
        u: [u - 0.08, u + 0.08],
        v: [deckV[0] + 0.1, deckV[0] + 0.26],
        y: [F, deckY - 0.16],
      });
    }
    addRail(
      ctx,
      { u: deckU[0], v: deckV[0], y: deckY },
      { u: deckU[1] - 0.1, v: deckV[0], y: deckY },
      room.palette.metal,
      5,
    );
    addCollider(ctx, {
      u: [deckU[0], deckU[1]],
      v: [deckV[0] - 0.06, deckV[0] + 0.06],
      y: [deckY, deckY + 0.98],
    });
    // Office cabin on the deck.
    addBox(ctx, room.palette.joinery, {
      u: [deckU[1] - 2.6, deckU[1] - 0.2],
      v: [deckV[0] + 0.5, deckV[1] - 0.2],
      y: [deckY, Math.min(deckY + 1.9, C - 0.15)],
    });
    addBox(ctx, 'glassShop', {
      u: [deckU[1] - 2.4, deckU[1] - 0.4],
      v: [deckV[0] + 0.46, deckV[0] + 0.5],
      y: [deckY + 0.9, Math.min(deckY + 1.6, C - 0.3)],
    });

    const rise = deckY - F;
    const steps = Math.max(2, Math.ceil(rise / MAX_RISE));
    const run = steps * 0.27;
    const stairU0 = clamp(deckU[0] - 0.35, 0.6, W - 0.6);
    const stairU1 = clamp(stairU0 - run, 0.4, W - 0.4);
    if (Math.abs(stairU1 - stairU0) > 1.0) {
      addFlight(
        ctx,
        {
          u0: stairU1,
          u1: stairU0,
          v: [deckV[0] + 0.2, deckV[0] + 1.35],
          yBottom: F,
          yTop: deckY,
          steps,
        },
        room.palette.structure,
      );
      addRail(
        ctx,
        { u: stairU1, v: deckV[0] + 0.16, y: F },
        { u: stairU0, v: deckV[0] + 0.16, y: deckY },
        room.palette.metal,
        4,
      );
    }
  }

  // Trusses and high bay strips.
  const trusses = clamp(Math.round(W / 9), 2, 5);
  const chordTop = C - 0.16;
  const chordBottom = chordTop - 0.6;
  for (let i = 0; i < trusses; i += 1) {
    const u = ((i + 0.5) * W) / trusses;
    addBox(ctx, room.palette.structure, {
      u: [u - 0.07, u + 0.07],
      v: [LINING, D - LINING],
      y: [chordTop - 0.09, chordTop],
    });
    addBox(ctx, room.palette.structure, {
      u: [u - 0.06, u + 0.06],
      v: [LINING + 0.5, D - LINING - 0.5],
      y: [chordBottom, chordBottom + 0.08],
    });
    const panels = 4;
    for (let p = 0; p < panels; p += 1) {
      const v = LINING + 0.5 + ((D - LINING * 2 - 1.0) * p) / panels;
      const vNext = LINING + 0.5 + ((D - LINING * 2 - 1.0) * (p + 1)) / panels;
      addStrut(ctx, room.palette.structure, { u, v, y: chordBottom }, { u, v: vNext, y: chordTop }, 0.05);
    }
  }
  const lampY = C - 0.7;
  const lamps = clamp(Math.round(W / 10), 2, 4);
  for (let i = 0; i < lamps; i += 1) {
    const u = ((i + 0.5) * W) / lamps;
    addStripLight(ctx, [u - 0.8, u + 0.8], D * 0.45, lampY, {
      intensity: 2.0,
      distance: 14,
      color: COOL_WORK,
    });
  }

  // A drum of waste oil in a corner and a wall fan over the benches: the two
  // things a shop like this always has that a modelled one never does.
  const drumU = clamp(1.1, 0.8, W - 0.8);
  const drumBox: LocalBox = { u: [drumU - 0.32, drumU + 0.32], v: [D - 1.5, D - 0.86], y: [F, F + 0.92] };
  if (canPlace(room, drumBox)) {
    addPost(ctx, 'rust', drumU, D - 1.18, [F, F + 0.88], 0.3, 8);
    addBox(ctx, 'metalDark', {
      u: [drumU - 0.31, drumU + 0.31],
      v: [D - 1.49, D - 0.87],
      y: [F + 0.88, F + 0.93],
    });
    addCollider(ctx, drumBox, true);
  }
  const fanV = clamp(D * 0.5, 1.2, D - 1.2);
  const fanY = Math.min(F + 3.4, C - 0.9);
  addBox(ctx, room.palette.metal, {
    u: [LINING, LINING + 0.08],
    v: [fanV - 0.42, fanV + 0.42],
    y: [fanY - 0.42, fanY + 0.42],
  });
  addBox(ctx, 'metalDark', {
    u: [LINING + 0.08, LINING + 0.12],
    v: [fanV - 0.36, fanV + 0.36],
    y: [fanY - 0.36, fanY + 0.36],
  });
  addBox(ctx, room.palette.metal, {
    u: [LINING + 0.12, LINING + 0.16],
    v: [fanV - 0.04, fanV + 0.04],
    y: [fanY - 0.3, fanY + 0.3],
  });
}

/**
 * Stairhall: a double-height entrance hall with a dog-leg stair up to a first
 * floor gallery, letterboxes by the door and a bike parked against the wall.
 */
function addStairhallFittings(ctx: Fitout): void {
  const { room } = ctx;
  const { floorY: F, width: W, depth: D, ceilY: C } = room;
  const backFace = D - LINING;

  // Where the stair goes: the far end of the hall from the door.
  const nearLeft = room.doorU < W / 2;
  const flightWidth = clamp((D - LINING * 2 - 0.5) / 2, 0.95, 1.35);
  const vOuter = backFace - 0.1;
  const vInner = vOuter - flightWidth * 2 - 0.12;
  const mezzY = clamp(F + room.parcel.groundStoreyHeight, F + 2.6, C - 2.2);
  const rise = mezzY - F;
  const steps = Math.max(4, Math.ceil(rise / MAX_RISE));
  const perFlight = Math.ceil(steps / 2);
  const going = clamp((W * 0.42 - 1.4) / perFlight, 0.24, 0.3);
  const run = perFlight * going;
  const landingDepth = 1.25;

  // Flight 1 runs away from the door, flight 2 comes back above it.
  const dir = nearLeft ? 1 : -1;
  const start = nearLeft ? W - LINING - 0.35 - run - landingDepth : LINING + 0.35 + run + landingDepth;
  const flight1Start = start;
  const flight1End = start + run * dir;
  const landingEnd = flight1End + landingDepth * dir;
  const halfway = F + (rise * perFlight) / steps;

  addFlight(
    ctx,
    {
      u0: flight1Start,
      u1: flight1End,
      v: [vInner + flightWidth + 0.12, vOuter],
      yBottom: F,
      yTop: halfway,
      steps: perFlight,
    },
    room.palette.floor,
  );
  addPlatform(ctx, room.palette.floor, {
    u: [Math.min(flight1End, landingEnd), Math.max(flight1End, landingEnd)],
    v: [vInner, vOuter],
    y: [halfway - 0.3, halfway],
  });
  // The second flight turns back from the near edge of the landing, in the
  // other half of the well, so it never sits on top of the landing itself.
  const flight2End = flight1End - run * dir;
  addFlight(
    ctx,
    {
      u0: flight1End,
      u1: flight2End,
      v: [vInner, vInner + flightWidth],
      yBottom: halfway,
      yTop: mezzY,
      steps: steps - perFlight,
    },
    room.palette.floor,
  );

  // Gallery landing along the back wall, and the flat doors off it. It carries
  // on past the top of the second flight, over the floor rather than the well.
  const galleryEnd = clamp(flight2End - 3.4 * dir, LINING, W - LINING);
  const galleryU: readonly [number, number] = [
    Math.min(flight2End, galleryEnd),
    Math.max(flight2End, galleryEnd),
  ];
  addPlatform(ctx, room.palette.floor, {
    u: galleryU,
    v: [vInner, backFace],
    y: [mezzY - 0.28, mezzY],
  });
  addRail(
    ctx,
    { u: galleryU[0], v: vInner, y: mezzY },
    { u: galleryU[1], v: vInner, y: mezzY },
    room.palette.metal,
    5,
  );
  // A barrier along the open edge of the gallery so the player cannot step off.
  addCollider(ctx, {
    u: galleryU,
    v: [vInner - 0.09, vInner + 0.03],
    y: [mezzY, mezzY + 0.98],
  });

  // Only the stairwell is open to the floor above; over the rest of the hall
  // the first floor slab closes it in, which is both what the building would
  // do and what stops the entrance reading as an aircraft hangar. The wall at
  // the end of the gallery keeps the player off that slab.
  const soffitEnd = nearLeft ? galleryU[0] : galleryU[1];
  const slabU: readonly [number, number] = nearLeft ? [LINING, soffitEnd] : [soffitEnd, W - LINING];
  if (slabU[1] - slabU[0] > 1.5) {
    addBox(ctx, room.palette.ceiling, {
      u: slabU,
      v: [LINING, backFace],
      y: [mezzY - 0.28, mezzY],
    });
    addBox(ctx, 'stuccoSand', {
      u: [soffitEnd - 0.06, soffitEnd + 0.06],
      v: [LINING, backFace],
      y: [mezzY, C],
    });
    addCollider(ctx, {
      u: [soffitEnd - 0.1, soffitEnd + 0.1],
      v: [LINING, backFace],
      y: [mezzY, C],
    });
    // The door off the gallery into the first floor corridor.
    const upperDoorU = soffitEnd + (nearLeft ? 0.06 : -0.06);
    addBox(ctx, room.palette.trim, {
      u: [Math.min(upperDoorU, upperDoorU + (nearLeft ? -0.05 : 0.05)), Math.max(upperDoorU, upperDoorU + (nearLeft ? -0.05 : 0.05))],
      v: [backFace - 1.6, backFace - 0.4],
      y: [mezzY + 0.02, mezzY + 2.2],
    });
    addBox(ctx, 'doorPainted', {
      u: [Math.min(upperDoorU, upperDoorU + (nearLeft ? 0.04 : -0.04)), Math.max(upperDoorU, upperDoorU + (nearLeft ? 0.04 : -0.04))],
      v: [backFace - 1.5, backFace - 0.5],
      y: [mezzY + 0.02, mezzY + 2.1],
    });
  }
  addRail(
    ctx,
    { u: flight1Start, v: vInner + flightWidth + 0.06, y: F },
    { u: flight1End, v: vInner + flightWidth + 0.06, y: halfway },
    room.palette.metal,
    4,
  );
  for (const [u, level] of [
    [galleryU[0] + 1.0, mezzY],
    [clamp(nearLeft ? W * 0.42 : W * 0.58, 1.2, W - 1.2), F],
  ] as const) {
    addBox(ctx, room.palette.trim, {
      u: [u - 0.58, u + 0.58],
      v: [backFace - 0.1, backFace],
      y: [level + 0.02, level + 2.14],
    });
    addBox(ctx, 'doorPainted', {
      u: [u - 0.5, u + 0.5],
      v: [backFace - 0.14, backFace - 0.1],
      y: [level + 0.02, level + 2.05],
    });
    addBox(ctx, room.palette.metal, {
      u: [u + 0.3, u + 0.38],
      v: [backFace - 0.19, backFace - 0.14],
      y: [level + 1.02, level + 1.12],
    });
  }
  // Support to the gallery so it does not read as floating.
  addSolid(ctx, room.palette.trim, {
    u: [galleryU[0] + 0.1, galleryU[0] + 0.28],
    v: [vInner + 0.05, vInner + 0.23],
    y: [F, mezzY - 0.28],
  });

  // Letterboxes on the entrance wall, on a board, over a radiator.
  const boxesU = clamp(room.doorU + (nearLeft ? 2.4 : -2.4), 1.2, W - 1.2);
  addBox(ctx, room.palette.joinery, {
    u: [boxesU - 1.05, boxesU + 1.05],
    v: [LINING, LINING + 0.06],
    y: [F + 0.95, F + 1.95],
  });
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const u = boxesU - 0.9 + col * 0.48;
      const y = F + 1.05 + row * 0.3;
      addBox(ctx, room.palette.metal, {
        u: [u, u + 0.42],
        v: [LINING + 0.06, LINING + 0.14],
        y: [y, y + 0.24],
      });
      addBox(ctx, 'metalDark', {
        u: [u + 0.06, u + 0.36],
        v: [LINING + 0.14, LINING + 0.16],
        y: [y + 0.16, y + 0.19],
      });
    }
  }
  addSolid(ctx, room.palette.metal, {
    u: [boxesU - 0.75, boxesU + 0.75],
    v: [LINING, LINING + 0.14],
    y: [F + 0.22, F + 0.78],
  });
  for (let i = 0; i < 7; i += 1) {
    const u = boxesU - 0.68 + i * 0.22;
    addBox(ctx, 'metalLight', {
      u: [u, u + 0.06],
      v: [LINING + 0.14, LINING + 0.2],
      y: [F + 0.24, F + 0.76],
    });
  }

  // Bikes parked against the walls: two wheels, a frame in three members, a
  // saddle and a bar. Cheap, and their absence is what makes a hall read empty.
  const addBike = (u: number, v: number, axis: 'u' | 'v'): void => {
    const wheelR = 0.34;
    const at = (along: number, across: number): { u: number; v: number } =>
      axis === 'v' ? { u: u + across, v: v + along } : { u: u + along, v: v + across };
    const frame = (a: number, aY: number, b: number, bY: number): void => {
      const p = at(a, 0);
      const q = at(b, 0);
      addStrut(ctx, 'paintedMetal', { u: p.u, v: p.v, y: aY }, { u: q.u, v: q.v, y: bY }, 0.05);
    };
    for (const along of [-0.52, 0.52]) {
      const centre = at(along, 0);
      addPost(ctx, 'metalDark', centre.u, centre.v, [F + wheelR - 0.03, F + wheelR + 0.03], wheelR, 10);
    }
    frame(-0.52, F + wheelR, 0.18, F + 0.92);
    frame(0.52, F + wheelR, 0.18, F + 0.92);
    frame(0.52, F + wheelR, -0.16, F + 0.6);
    const saddle = at(0.16, 0);
    addBox(ctx, 'metalDark', {
      u: [saddle.u - (axis === 'u' ? 0.14 : 0.05), saddle.u + (axis === 'u' ? 0.14 : 0.05)],
      v: [saddle.v - (axis === 'v' ? 0.14 : 0.05), saddle.v + (axis === 'v' ? 0.14 : 0.05)],
      y: [F + 0.92, F + 0.98],
    });
    const bars = at(-0.55, 0);
    addBox(ctx, 'metalDark', {
      u: [bars.u - (axis === 'u' ? 0.03 : 0.24), bars.u + (axis === 'u' ? 0.03 : 0.24)],
      v: [bars.v - (axis === 'v' ? 0.03 : 0.24), bars.v + (axis === 'v' ? 0.03 : 0.24)],
      y: [F + 0.94, F + 1.0],
    });
    const half = at(0.9, 0.3);
    addCollider(ctx, {
      u: [Math.min(u - (half.u - u), half.u), Math.max(u - (half.u - u), half.u)],
      v: [Math.min(v - (half.v - v), half.v), Math.max(v - (half.v - v), half.v)],
      y: [F, F + 1.0],
    });
  };

  addBike(clamp(nearLeft ? W - 1.1 : 1.1, 0.8, W - 0.8), clamp(D * 0.35, 1.0, D - 1.0), 'v');
  addBike(clamp(boxesU + (nearLeft ? 3.6 : -3.6), 1.2, W - 1.2), LINING + 0.55, 'u');
  addBike(clamp(boxesU + (nearLeft ? 5.7 : -5.7), 1.2, W - 1.2), LINING + 0.5, 'u');

  // Doors to the ground floor flats, spread down the hall.
  const doorBays = clamp(Math.floor(W / 7), 1, 4);
  for (let i = 0; i < doorBays; i += 1) {
    const u = 1.6 + ((W - 3.2) * (i + 0.5)) / doorBays;
    if (u > Math.min(flight1Start, landingEnd) - 1.0 && u < Math.max(flight1Start, landingEnd) + 1.0) continue;
    if (Math.abs(u - clamp(nearLeft ? W * 0.42 : W * 0.58, 1.2, W - 1.2)) < 1.4) continue;
    addBox(ctx, room.palette.trim, {
      u: [u - 0.56, u + 0.56],
      v: [backFace - 0.1, backFace],
      y: [F + 0.02, F + 2.14],
    });
    addBox(ctx, 'doorPainted', {
      u: [u - 0.48, u + 0.48],
      v: [backFace - 0.14, backFace - 0.1],
      y: [F + 0.02, F + 2.05],
    });
    addBox(ctx, room.palette.metal, {
      u: [u + 0.28, u + 0.36],
      v: [backFace - 0.19, backFace - 0.14],
      y: [F + 1.02, F + 1.12],
    });
  }

  // Meter cupboard and the rising main, boxed in beside it.
  const meterU = clamp(nearLeft ? W * 0.62 : W * 0.38, 1.0, W - 1.0);
  addBox(ctx, room.palette.trim, {
    u: [meterU - 0.4, meterU + 0.4],
    v: [backFace - 0.16, backFace],
    y: [F + 0.85, F + 2.05],
  });
  addPost(ctx, 'metalLight', meterU + 0.62, backFace - 0.14, [F, room.ceilY], 0.07, 6);

  // Painted dado with a rail, the way every communal stair in the district is
  // decorated, and a hall table by the letterboxes.
  const dadoTop = F + 1.15;
  for (const band of [
    { u: [LINING, W - LINING] as const, v: [D - LINING - 0.05, D - LINING] as const },
    { u: [LINING, LINING + 0.05] as const, v: [LINING, D - LINING] as const },
    { u: [W - LINING - 0.05, W - LINING] as const, v: [LINING, D - LINING] as const },
  ]) {
    addBox(ctx, 'stuccoSand', { u: band.u, v: band.v, y: [F + 0.14, dadoTop] });
    addBox(ctx, room.palette.trim, {
      u: [band.u[0] - 0.02, band.u[1] + 0.02],
      v: [band.v[0] - 0.02, band.v[1] + 0.02],
      y: [dadoTop, dadoTop + 0.06],
    });
  }

  // Pilasters down the hall, which is what a walk-up entrance actually has.
  const bays = clamp(Math.round(W / 3.6), 3, 9);
  for (let i = 1; i < bays; i += 1) {
    const u = (W * i) / bays;
    if (u > Math.min(flight1Start, landingEnd) - 0.6 && u < Math.max(flight1Start, landingEnd) + 0.6) continue;
    addBox(ctx, 'stuccoSand', {
      u: [u - 0.15, u + 0.15],
      v: [backFace - 0.09, backFace],
      y: [F, F + 2.55],
    });
    addBox(ctx, room.palette.trim, {
      u: [u - 0.19, u + 0.19],
      v: [backFace - 0.13, backFace],
      y: [F + 2.55, F + 2.66],
    });
  }

  const tableU = clamp(boxesU + 1.9, 0.9, W - 0.9);
  if (canPlace(room, { u: [tableU - 0.55, tableU + 0.55], v: [LINING, LINING + 0.5], y: [F, F + 0.82] })) {
    addSolid(ctx, room.palette.joinery, {
      u: [tableU - 0.55, tableU + 0.55],
      v: [LINING, LINING + 0.44],
      y: [F + 0.72, F + 0.79],
    });
    for (const u of [tableU - 0.48, tableU + 0.42]) {
      addBox(ctx, room.palette.joinery, { u: [u, u + 0.06], v: [LINING + 0.32, LINING + 0.38], y: [F, F + 0.72] });
    }
    for (let i = 0; i < 3; i += 1) {
      addBox(ctx, i === 1 ? 'stuccoCream' : 'canvasAwning', {
        u: [tableU - 0.34 + i * 0.24, tableU - 0.16 + i * 0.24],
        v: [LINING + 0.1, LINING + 0.34],
        y: [F + 0.79, F + 0.79 + 0.02 + i * 0.015],
      });
    }
  }

  // A cupboard door tucked under the lower flight.
  const cupboardU = clamp(nearLeft ? W * 0.72 : W * 0.28, 1.0, W - 1.0);
  addBox(ctx, room.palette.trim, {
    u: [cupboardU - 0.44, cupboardU + 0.44],
    v: [backFace - 0.09, backFace],
    y: [F + 0.02, F + 1.9],
  });
  addBox(ctx, 'doorPainted', {
    u: [cupboardU - 0.37, cupboardU + 0.37],
    v: [backFace - 0.12, backFace - 0.09],
    y: [F + 0.02, F + 1.82],
  });

  // A wheelie bin parked where it always ends up.
  const binU = clamp(nearLeft ? W - 2.6 : 2.6, 0.9, W - 0.9);
  addSolid(ctx, 'shutter', {
    u: [binU - 0.32, binU + 0.32],
    v: [LINING + 0.1, LINING + 0.68],
    y: [F, F + 1.0],
  });
  addBox(ctx, 'metalDark', {
    u: [binU - 0.34, binU + 0.34],
    v: [LINING + 0.08, LINING + 0.7],
    y: [F + 1.0, F + 1.07],
  });

  // Notice board, and the lighting: a stairwell pendant plus two sconces.
  const noticeV = clamp(D * 0.6, 1.2, D - 0.8);
  addBox(ctx, room.palette.trim, {
    u: [LINING, LINING + 0.07],
    v: [noticeV - 0.6, noticeV + 0.6],
    y: [F + 1.15, F + 2.05],
  });
  addBox(ctx, 'stuccoCream', {
    u: [LINING + 0.07, LINING + 0.09],
    v: [noticeV - 0.52, noticeV + 0.52],
    y: [F + 1.24, F + 1.96],
  });

  addPendant(ctx, clamp((flight1Start + landingEnd) / 2, 1.0, W - 1.0), (vInner + vOuter) / 2, C - 1.6, {
    intensity: 2.2,
    distance: 13,
  });
  addSconce(ctx, clamp(room.doorU - 1.6, 0.6, W - 0.6), LINING, F + 2.25, 1, {
    intensity: 1.5,
    distance: 9,
  });
  addSconce(ctx, clamp(nearLeft ? W * 0.55 : W * 0.45, 0.6, W - 0.6), backFace, F + 2.35, -1, {
    intensity: 1.5,
    distance: 9,
  });

  // A runner down the hall, and a plant at the foot of the stair. A communal
  // stairwell without either reads as a set rather than an address.
  const runnerU = clamp(room.doorU, 1.2, W - 1.2);
  addBox(ctx, 'canvasAwning', {
    u: [runnerU - 0.85, runnerU + 0.85],
    v: [1.9, Math.max(2.4, D - 1.1)],
    y: [F + 0.014, F + 0.028],
  });
  const plantU = clamp(flight1Start - 1.1 * dir, 0.9, W - 0.9);
  const plantBox: LocalBox = { u: [plantU - 0.36, plantU + 0.36], v: [vOuter - 0.9, vOuter - 0.2], y: [F, F + 1.3] };
  if (canPlace(room, plantBox)) {
    addCone(ctx, room.palette.trim, plantU, vOuter - 0.55, [F, F + 0.5], 0.28, 0.21, 8);
    for (let i = 0; i < 3; i += 1) {
      addYawBox(
        ctx,
        i === 1 ? 'foliageDark' : 'foliage',
        { u: plantU, v: vOuter - 0.55 },
        { du: 0.78 - i * 0.16, dv: 0.78 - i * 0.16 },
        [F + 0.5 + i * 0.2, F + 0.68 + i * 0.2],
        0.7 * i,
      );
    }
    addCollider(ctx, { u: [plantU - 0.26, plantU + 0.26], v: [vOuter - 0.81, vOuter - 0.29], y: [F, F + 0.5] }, true);
  }
}

// ---------------------------------------------------------------------------
// Generated furnishings
// ---------------------------------------------------------------------------

/**
 * The generated furniture the interiors are dressed with.
 *
 * These are Tripo models, not geometry: a builder may not create a mesh or a
 * material, and a generated GLB arrives carrying both. `world/furnishings`
 * places the meshes; this module decides WHERE each piece stands and emits the
 * matching collider, so the thing the player bumps into and the thing they can
 * see are the same object.
 */
export type FurnishingModel =
  | 'plant'
  | 'armchair'
  | 'drinksCabinet'
  | 'bistroChair'
  | 'bistroTable'
  | 'espressoMachine'
  | 'produceStall'
  | 'workbench'
  | 'receptionSofa'
  | 'stockShelving'
  | 'counterTill'
  | 'stallFish'
  | 'stallButcher'
  | 'stallFlowers'
  | 'cafeCounter'
  | 'vendingMachine'
  | 'clubBar'
  | 'clubBooth'
  | 'djBooth'
  | 'clubSpeaker'
  | 'cashBox';

/**
 * How each model is fitted and how big it ends up.
 *
 * ## The dominant axis is not the same for every model
 *
 * Every one of these arrives normalised into a unit box, so exactly one of its
 * dimensions is 0.998 and the others are smaller. Fitting a sofa by its HEIGHT
 * when its 0.998 is its LENGTH produces a sofa two and a half metres tall.
 * `fit` therefore names the axis whose real size is known, and `metres` is that
 * size; the runtime divides.
 *
 * The chosen dimension is the one whose real value is least ambiguous, which
 * is not always the longest. A cafe table's model is proportionally wider than
 * a real one, so it is fitted by height (a table the wrong height reads as
 * broken next to a chair; a table 15 cm too wide does not).
 *
 * `front` is the model's own local axis that points forward, INCLUDING ITS
 * SIGN, measured from the mesh rather than guessed. Two different measurements
 * decide it, because one rule does not fit both kinds of object:
 *
 * - For seating and stalls the BACK is the half of the bounding box with the
 *   higher mean vertex height - a backrest, a header board, a hanging rail -
 *   so the front is the other half.
 * - For cabinets and appliances that stand flat against a wall the back is a
 *   blank panel and the front carries all the detail, so the front is the half
 *   with far MORE vertices. A vending machine has 2,835 vertices on its face
 *   and 175 on its back; judging that one by height would turn it around.
 *
 * `halfWidth` and `halfDepth` are the finished footprint, across and along
 * `front`, and are what the collider is built from. `solid: false` marks the
 * pieces that stand on a counter, where a collider would be a phantom wall.
 */
export interface FurnishingSpec {
  readonly fit: 'x' | 'y' | 'z';
  readonly metres: number;
  readonly front: 'x' | '-x' | 'z' | '-z';
  readonly height: number;
  readonly halfWidth: number;
  readonly halfDepth: number;
  readonly solid: boolean;
}

export const FURNISHING_SPECS: Readonly<Record<FurnishingModel, FurnishingSpec>> = {
  plant: { fit: 'y', metres: 1.34, front: 'z', height: 1.34, halfWidth: 0.3, halfDepth: 0.3, solid: true },
  armchair: { fit: 'y', metres: 0.84, front: 'x', height: 0.84, halfWidth: 0.38, halfDepth: 0.41, solid: true },
  drinksCabinet: { fit: 'y', metres: 1.85, front: 'x', height: 1.85, halfWidth: 0.43, halfDepth: 0.4, solid: true },
  bistroChair: { fit: 'y', metres: 0.9, front: 'z', height: 0.9, halfWidth: 0.24, halfDepth: 0.29, solid: true },
  bistroTable: { fit: 'y', metres: 0.74, front: 'z', height: 0.74, halfWidth: 0.44, halfDepth: 0.44, solid: true },
  espressoMachine: { fit: 'x', metres: 0.62, front: 'x', height: 0.58, halfWidth: 0.25, halfDepth: 0.31, solid: false },
  produceStall: { fit: 'z', metres: 2.1, front: 'x', height: 1.62, halfWidth: 1.05, halfDepth: 0.55, solid: true },
  workbench: { fit: 'z', metres: 1.55, front: 'x', height: 0.94, halfWidth: 0.78, halfDepth: 0.42, solid: true },
  receptionSofa: { fit: 'z', metres: 2.05, front: 'x', height: 0.79, halfWidth: 1.03, halfDepth: 0.44, solid: true },
  stockShelving: { fit: 'y', metres: 1.75, front: 'x', height: 1.75, halfWidth: 0.52, halfDepth: 0.25, solid: true },
  counterTill: { fit: 'y', metres: 1.15, front: 'x', height: 1.15, halfWidth: 0.61, halfDepth: 0.48, solid: true },
  // The market's three trades. Each is fitted by the dimension its real
  // counterpart is actually specified in - a stall is bought by its frontage -
  // except the fish stall and the flower stall, whose sign board and canopy
  // make height the honest measurement.
  stallFish: { fit: 'y', metres: 2.05, front: '-x', height: 2.05, halfWidth: 0.87, halfDepth: 0.56, solid: true },
  stallButcher: { fit: 'z', metres: 2.1, front: '-x', height: 1.66, halfWidth: 1.05, halfDepth: 0.59, solid: true },
  stallFlowers: { fit: 'y', metres: 2.15, front: 'x', height: 2.15, halfWidth: 1.06, halfDepth: 1.05, solid: true },
  cafeCounter: { fit: 'z', metres: 2.2, front: '-x', height: 1.32, halfWidth: 1.1, halfDepth: 0.46, solid: true },
  vendingMachine: { fit: 'y', metres: 1.85, front: 'x', height: 1.85, halfWidth: 0.45, halfDepth: 0.45, solid: true },
  /*
   * The Vibe. Each is fitted by the dimension its real counterpart is bought
   * by - a bar and a banquette by their frontage, a speaker stack and a
   * console by their height - and every `front` was read off the model's own
   * measured bounds rather than assumed. Measured: the bar, the booth, the
   * console and the cash box all normalise along Z; the speaker stack is the
   * one whose long axis is its height.
   */
  clubBar: { fit: 'z', metres: 4.2, front: '-x', height: 1.73, halfWidth: 2.1, halfDepth: 0.76, solid: true },
  clubBooth: { fit: 'z', metres: 2.4, front: '-z', height: 0.95, halfWidth: 0.99, halfDepth: 1.2, solid: true },
  /*
   * Not solid, and it is a platform rather than a counter that makes it so:
   * the DJ console stands ON the stage, and the stage is already a solid the
   * player walks into. A second collider for the console would have to sit at
   * floor level to satisfy the "solid pieces stand on the floor" invariant,
   * which would put an invisible wall a third of a metre in front of a
   * platform that is right there to be seen. Same reasoning as the espresso
   * machine on the cafe counter.
   */
  djBooth: { fit: 'z', metres: 1.7, front: '-z', height: 1.05, halfWidth: 0.35, halfDepth: 0.85, solid: false },
  clubSpeaker: { fit: 'y', metres: 1.9, front: '-z', height: 1.9, halfWidth: 0.48, halfDepth: 0.86, solid: true },
  /*
   * Sable's takings. Not solid: it stands ON a workbench, the player is meant
   * to walk up to it, and a collider round a 40 cm box on a bench is a knee
   * you can bark yourself on for no reason.
   */
  cashBox: { fit: 'z', metres: 0.42, front: '-z', height: 0.21, halfWidth: 0.14, halfDepth: 0.21, solid: false },
};

export interface Furnishing {
  readonly model: FurnishingModel;
  /** World position of the point the model stands ON. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Camera-convention heading the piece FACES: forward is `(-sin h, -cos h)`. */
  readonly yaw: number;
  /** World-space footprint, for the collider and for clearance tests. */
  readonly halfX: number;
  readonly halfZ: number;
  readonly height: number;
  readonly solid: boolean;
}

/**
 * A room-local placement.
 *
 * `turns` is a QUARTER turn count from "facing back towards the door", not a
 * free angle, and that is deliberate: at a quarter turn the piece's footprint
 * stays axis-aligned in the room frame, so the collider can be the exact
 * rectangle the object occupies instead of a square big enough to contain it.
 * A 2 m sofa in a 2 m square collider blocks a metre of floor that is not
 * there. `skew` tilts the MESH only, for the pieces that should not look
 * ruled.
 */
interface LocalFurnishing {
  readonly model: FurnishingModel;
  readonly u: number;
  readonly v: number;
  readonly turns: 0 | 1 | 2 | 3;
  readonly skew?: number;
  /** Height above the finished floor the piece stands at. Counter tops. */
  readonly lift?: number;
}

const place = (
  model: FurnishingModel,
  u: number,
  v: number,
  turns: 0 | 1 | 2 | 3,
  extra: { readonly skew?: number; readonly lift?: number } = {},
): LocalFurnishing => ({ model, u, v, turns, ...extra });

/**
 * Where each interior kind is dressed.
 *
 * Anchors sit against walls, in corners and in the dead areas a layout leaves
 * over - never in the middle of a route. The cafe is the exception: its tables
 * ARE the room, and its counter position is taken from `cafePlan` so the
 * espresso machine lands on the counter top rather than beside it.
 */
function furnishingLayout(room: Room): LocalFurnishing[] {
  const { width: W, depth: D } = room;
  const near = clamp(D * 0.24, 1.1, 3.0);
  const far = clamp(D * 0.72, 2.4, D - 1.1);
  const edgeL = clamp(0.95, 0.8, W / 2);
  const edgeR = clamp(W - 0.95, W / 2, W - 0.8);
  const doorLow = room.doorU < W / 2;

  switch (room.kind) {
    case 'cafe': {
      const cafe = cafePlan(room);
      const out: LocalFurnishing[] = [
        // The hero prop, on the counter top where the barista stands.
        place('espressoMachine', cafe.cu0 + 0.72, (cafe.cv0 + cafe.cv1) / 2, 2, { lift: CAFE_COUNTER_HEIGHT }),
        place('plant', edgeL, far, 0, { skew: 0.4 }),
        place('plant', edgeR, far, 0, { skew: -0.7 }),
      ];
      // Three tables down the room, each with a chair either side. These
      // replace the boxes-on-a-post the layout used to build: a bentwood chair
      // is the one thing in a cafe nobody accepts as a cuboid.
      for (const seat of cafeSeats(room)) {
        out.push(place('bistroTable', seat.u, seat.v, 0, { skew: seat.skew }));
        out.push(place('bistroChair', seat.u, seat.v - 0.74, 2, { skew: seat.skew + 0.12 }));
        out.push(place('bistroChair', seat.u, seat.v + 0.74, 0, { skew: seat.skew - 0.16 }));
      }
      return out;
    }
    case 'store': {
      // Both racks go on the flank the door is NOT on. Straddling the middle
      // of the shop put one of them squarely on the diagonal a customer walks
      // from the door to the back, and `canPlace` rightly threw it away.
      const away = doorLow ? W * 0.78 : W * 0.22;
      return [
        place('drinksCabinet', doorLow ? edgeR : edgeL, clamp(D * 0.42, 1.8, D - 1.4), doorLow ? 3 : 1),
        place('stockShelving', clamp(away - 0.75, 0.8, W - 0.8), near, 2),
        place('stockShelving', clamp(away + 0.75, 0.8, W - 0.8), near, 2),
        place('plant', doorLow ? edgeL : edgeR, near, 0, { skew: 0.3 }),
      ];
    }
    case 'gunStore':
      return [place('plant', edgeR, near, 0, { skew: 0.3 })];
    case 'nightclub': {
      const plan = nightclubPlan(room);
      // The bar runs along its flank, so it is turned a quarter from "facing
      // back out of the room" - a quarter one way on the low flank and the
      // other way on the high one, so it always serves INTO the room.
      const barTurns = plan.barLow ? 1 : 3;
      const boothU = plan.barLow ? edgeR : edgeL;
      const out: LocalFurnishing[] = [
        place('clubBar', plan.barU, (plan.barV[0] + plan.barV[1]) / 2, barTurns),
        place('djBooth', W / 2, plan.stageV[0] + 0.75, 0, { lift: CLUB_STAGE_HEIGHT }),
        place('clubSpeaker', clamp(plan.stageU[0] - 0.7, 0.7, W - 0.7), plan.stageV[0] + 0.3, 0),
        place('clubSpeaker', clamp(plan.stageU[1] + 0.7, 0.7, W - 0.7), plan.stageV[0] + 0.3, 0),
        place('clubBooth', boothU, clamp(D * 0.4, 1.6, D - 1.6), plan.barLow ? 3 : 1, { skew: 0.1 }),
        place('clubBooth', boothU, clamp(D * 0.68, 2.4, D - 1.3), plan.barLow ? 3 : 1, { skew: -0.12 }),
      ];
      return out;
    }
    case 'lobby': {
      // A waiting group off the axis of the doors: sofa against the back, two
      // chairs facing it, a plant on each side, and the drinks cabinet where
      // people queue.
      const seatU = clamp(W * 0.2, 2.2, W - 2.2);
      return [
        place('receptionSofa', seatU, far, 0),
        place('armchair', seatU - 1.5, far - 1.5, 1, { skew: 0.2 }),
        place('armchair', seatU + 1.5, far - 1.5, 3, { skew: -0.2 }),
        place('plant', clamp(seatU - 1.75, 0.8, W - 0.8), far, 0),
        place('plant', clamp(W * 0.86, 0.8, W - 0.8), near, 0, { skew: 0.9 }),
        place('drinksCabinet', clamp(W * 0.92, 0.8, W - 0.8), clamp(D * 0.5, 1.6, D - 1.6), 3),
      ];
    }
    case 'stairhall':
      return [
        place('armchair', edgeL + 0.35, far, 1, { skew: 0.25 }),
        place('plant', edgeL, near, 0),
        place('plant', edgeR, far, 0, { skew: -0.5 }),
        // The vending machine every shared entrance hall of this vintage has.
        place('vendingMachine', edgeR, near, 3),
      ];
    case 'marketHall': {
      /*
       * The WHOLE trading floor is generated now. The hall used to build its
       * stalls out of a counter, a back board and a canopy of boxes, and one
       * generated produce stall standing among fourteen of those read as the
       * only finished object in the room. Three trades - fish, butcher,
       * flowers - alternate down three rows on the same lines the procedural
       * run used, so the aisle, the trusses and the high bay lamps still line
       * up with them.
       */
      const stallDepth = clamp(D * 0.18, 1.6, 2.4);
      const trades: readonly FurnishingModel[] = [
        'stallFish',
        'stallButcher',
        'produceStall',
        'stallFlowers',
      ];
      const rows: readonly { readonly v: number; readonly turns: 0 | 2 }[] = [
        // Back row serves the aisle in front of it; the window row serves
        // inwards; the island, where the hall is deep enough, serves the aisle.
        { v: D - LINING - stallDepth / 2, turns: 0 },
        { v: LINING + 0.58 + stallDepth / 2, turns: 2 },
        ...(D > 9.5 ? ([{ v: D / 2, turns: 0 }] as const) : []),
      ];

      const out: LocalFurnishing[] = [];
      let trade = 0;
      for (const row of rows) {
        const usable = W - 1.0;
        // Tighter than the procedural run it replaces: a generated stall is
        // about two metres of frontage where an authored one was nearly four,
        // so the same hall needs more of them to read as a market rather than
        // as a row of exhibits.
        const count = clamp(Math.floor(usable / 4.8), 1, 7);
        const cell = usable / count;
        for (let i = 0; i < count; i += 1) {
          out.push(place(trades[trade % trades.length] ?? 'produceStall', 0.5 + cell * (i + 0.5), row.v, row.turns));
          trade += 1;
        }
      }
      // The refreshment counter every market hall has, at the door end.
      out.push(place('cafeCounter', clamp(room.doorU + 4.6, 1.3, W - 1.3), clamp(D * 0.5, 1.4, D - 1.4), 0));
      out.push(place('plant', edgeL, clamp(D * 0.5, 1.2, D - 1.2), 0, { skew: 0.2 }));
      out.push(place('plant', edgeR, clamp(D * 0.5, 1.2, D - 1.2), 0, { skew: -0.8 }));
      return out;
    }
    case 'workshop':
      // A joinery shop keeps no houseplants. It keeps benches, a rack of
      // stock, a trade counter by the door and one chair nobody threw out.
      return [
        place('workbench', clamp(W * 0.36, 1.2, W - 1.2), clamp(D * 0.55, 1.6, D - 1.6), 2),
        place('workbench', clamp(W * 0.36, 1.2, W - 1.2), clamp(D * 0.55 + 2.2, 1.6, D - 1.6), 0),
        /*
         * Sable's takings, sitting on the first bench where Teo has been
         * minding them for two nights.
         *
         * Placed in the LAYOUT rather than by the mission, so the model, its
         * anchor and the collider all come from the one table every other
         * piece of furniture in the city comes from; the mission only decides
         * whether the player may pick it up. It stands on the bench, so the
         * lift is that bench's own height.
         */
        place(
          'cashBox',
          // Shoved to one end of the bench rather than sitting in the middle
          // of it, which is both where somebody actually puts a box down and
          // what keeps its footprint off the bench's own collider centre.
          clamp(W * 0.36 + FURNISHING_SPECS.workbench.halfWidth * 0.55, 1.2, W - 1.2),
          clamp(D * 0.55, 1.6, D - 1.6),
          2,
          { lift: FURNISHING_SPECS.workbench.height },
        ),
        place('stockShelving', edgeR, clamp(D * 0.4, 1.2, D - 1.2), 3),
        // The trade counter goes against the flank beside the door, not out in
        // the floor: in the middle of the bay it sat on the diagonal a walker
        // takes to the middle of the shop and was refused.
        place('counterTill', edgeR - 0.4, clamp(near + 1.9, 1.2, D - 1.2), 3),
        place('armchair', edgeR - 0.4, near, 2, { skew: 0.4 }),
        place('vendingMachine', edgeL, clamp(near + 1.2, 1.2, D - 1.2), 1),
      ];
  }
}

/**
 * The generated furnishings for one interior, in world space.
 *
 * Deterministic and free of `rng`, because the builder and the runtime both
 * call it and must agree. Anything that would stand in the way in is dropped.
 */
export function interiorFurnishings(parcel: Parcel): readonly Furnishing[] {
  const kind = parcel.interiorKind;
  if (kind === null) return [];
  const room = makeRoom(parcel, kind);
  const alongX = room.facing === 'north' || room.facing === 'south';
  // Heading that looks back out of the room, which is what `turns: 0` means.
  const outward = Math.atan2(-room.door.normalX, -room.door.normalZ);

  const out: Furnishing[] = [];
  for (const spot of furnishingLayout(room)) {
    const spec = FURNISHING_SPECS[spot.model];
    // At a quarter turn the footprint is still axis-aligned in the room frame,
    // so `width` and `depth` simply swap over.
    const acrossU = spot.turns % 2 === 0;
    const halfU = acrossU ? spec.halfWidth : spec.halfDepth;
    const halfV = acrossU ? spec.halfDepth : spec.halfWidth;
    const lift = spot.lift ?? 0;

    const box: LocalBox = {
      u: [spot.u - halfU, spot.u + halfU],
      v: [spot.v - halfV, spot.v + halfV],
      y: [room.floorY + lift, room.floorY + lift + spec.height],
    };
    // A piece on a counter is above head height for the entry test and cannot
    // block anything; only the ones on the floor are checked.
    if (spec.solid && !canPlace(room, box)) continue;
    if (spot.u < halfU || spot.u > room.width - halfU) continue;
    if (spot.v < halfV || spot.v > room.depth - halfV) continue;

    const world = toWorld(room, spot.u, spot.v);
    out.push({
      model: spot.model,
      x: world.x,
      y: room.floorY + lift,
      z: world.z,
      yaw: outward + spot.turns * (Math.PI / 2) + (spot.skew ?? 0),
      halfX: alongX === acrossU ? halfU : halfV,
      halfZ: alongX === acrossU ? halfV : halfU,
      height: spec.height,
      solid: spec.solid,
    });
  }
  return out;
}

/**
 * Colliders for the generated furnishings.
 *
 * The geometry is placed at runtime, so the world build cannot see it; without
 * this an armchair would be scenery the player walks through, which is exactly
 * the "slapdash" this fit-out is fixing. The tradeoff is that a furnishing
 * whose model fails to download leaves its collider behind - the same tradeoff
 * the generated fountain landmark already makes.
 *
 * Held to a metre even for the tall pieces: a collider only has to stop a
 * walking body, and a full-height box on a shelving unit starts catching the
 * camera as well.
 */
export function addFurnishingColliders(ctx: Fitout): void {
  for (const item of interiorFurnishings(ctx.room.parcel)) {
    if (!item.solid) continue;
    ctx.sink.collider({
      minX: item.x - item.halfX,
      maxX: item.x + item.halfX,
      minZ: item.z - item.halfZ,
      maxZ: item.z + item.halfZ,
      bottom: ctx.room.floorY,
      top: ctx.room.floorY + Math.min(item.height, 1.0),
      solid: true,
    });
  }
}
