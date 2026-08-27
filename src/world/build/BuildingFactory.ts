/**
 * Building exteriors for Meridian Bay.
 *
 * One call to `buildBuilding` emits the complete outside of one building: its
 * plinth, its walls with real punched openings, its ground floor, its cornice
 * or parapet, its roof and roof clutter, its colliders, and - where it earns
 * one - a light and a door the player can use.
 *
 * DESIGN RULES, in the order they matter:
 *
 * 1. Relief, not decals. Every window is a hole with a reveal, a frame and
 *    glazing set behind the wall face. Every building has a base course, a top
 *    treatment and at least one break in its mass. The art brief calls a flat
 *    extruded box with sharp corners the single loudest "generated" tell, so
 *    nothing here is allowed to be one.
 * 2. One geometry per material key per building. Windows are written into
 *    shared staging arrays by `MeshWriter` and flushed as merged indexed
 *    geometry, never as one `BoxGeometry` per opening.
 * 3. A triangle budget the whole city can afford: roughly 700-2500 triangles
 *    per building, hard-capped well under 6000. The levers are the window
 *    budget (see `WINDOW_BUDGET`), blank party walls on terraced types, and
 *    continuous curtain-wall mullions instead of per-storey ones.
 * 4. Determinism. All variation comes from `createRng(parcel.seed)` and from
 *    `hash2` of world position, so the city is identical on every machine.
 *
 * COORDINATES: metres; +X east, +Z south, +Y up. `parcel.groundY` is finished
 * floor level, `parcel.baseY` is below the lowest ground under the footprint.
 */

import { Matrix4 } from 'three';

import { clamp, insetRect, type Rect } from '../../core/mathx';
import { createRng, hash2, type Rng } from '../../core/rng';
import type { MaterialKey } from '../../render/materials';
import { KERB_HEIGHT, type ArchetypeId, type Facing, type Parcel } from '../CityPlan';
import { landElevation } from '../elevation';
import { doorApproach, doorLanding, doorwayFor, type Doorway } from './doorway';
import {
  ALL_FACINGS,
  awning,
  balustrade,
  blind,
  downpipe,
  FACE,
  MeshWriter,
  openingAt,
  opposite,
  punchedPanel,
  revealFor,
  rhythm,
  SF,
  shiftSide,
  shutters,
  sideAlongAxis,
  sideBox,
  sideOf,
  sidePoint,
  sideQuad,
  sideSpan,
  stoneSill,
  windowInsert,
  type Opening,
  type Side,
  type WindowStyle,
} from './facade';
import {
  corniceStack,
  flatDeck,
  gableRoof,
  parapetRing,
  plantEnclosure,
  roofClutter,
  roofLantern,
  sawtoothRoof,
  sawtoothTeeth,
  stringCourse,
} from './roofscape';
import type { ColliderBox, GeometrySink, PropKey } from './types';

/**
 * Ceiling on how many punched openings one building may carry. Past this the
 * window module is widened until the count fits, which keeps a nine-storey slab
 * from costing four times what a walk-up does.
 */
const WINDOW_BUDGET = 130;

/** Nothing this file emits may oversail the parcel by more than this. */
const MAX_OVERSAIL = 0.82;

/** Nothing this file emits may stand more than this above the roof line. */
const MAX_ABOVE_ROOF = 2.75;

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

const STUCCOS: readonly MaterialKey[] = [
  'stuccoCream',
  'stuccoPeach',
  'stuccoMint',
  'stuccoRose',
  'stuccoSand',
  'stuccoBlue',
];

interface Palette {
  readonly wall: MaterialKey;
  /** Sills, cornices, string courses, copings. */
  readonly trim: MaterialKey;
  readonly base: MaterialKey;
  readonly roof: MaterialKey;
  readonly shutter: MaterialKey;
  readonly metal: MaterialKey;
}

function paletteFor(archetype: ArchetypeId, rng: Rng): Palette {
  const stucco = rng.pick(STUCCOS);
  switch (archetype) {
    case 'harbourRow':
      return { wall: stucco, trim: 'timber', base: 'concrete', roof: 'roofTar', shutter: 'shutter', metal: 'metalDark' };
    case 'oldTenement':
      return {
        wall: rng.chance(0.68) ? stucco : 'brickBuff',
        trim: 'stoneAshlar',
        base: 'stoneAshlar',
        roof: 'roofTar',
        shutter: 'shutter',
        metal: 'metalDark',
      };
    case 'brickWalkup':
      return {
        wall: rng.chance(0.6) ? 'brickRed' : 'brickBuff',
        trim: 'stoneAshlar',
        base: 'concrete',
        roof: 'roofTar',
        shutter: 'timberDark',
        metal: 'metalDark',
      };
    case 'terraceHouse':
      return { wall: stucco, trim: 'timber', base: 'stoneAshlar', roof: 'roofTile', shutter: 'timberDark', metal: 'metalDark' };
    case 'civicStone':
      // Ashlar walling with a greyer stone for the order, the cornice and the
      // base. One stone throughout is what a real building does and what makes
      // a rendered one read as an untextured block; two courses give the relief
      // something to be read against.
      return { wall: 'stoneAshlar', trim: 'concrete', base: 'concreteBoard', roof: 'roofTar', shutter: 'timberDark', metal: 'metalDark' };
    case 'apartmentSlab':
      return { wall: 'concrete', trim: 'concreteBoard', base: 'concreteBoard', roof: 'roofTar', shutter: 'shutter', metal: 'metalLight' };
    case 'midriseOffice':
      return {
        wall: rng.chance(0.5) ? 'concrete' : 'concreteBoard',
        trim: 'concreteBoard',
        base: 'stoneAshlar',
        roof: 'roofTar',
        shutter: 'shutter',
        metal: 'metalLight',
      };
    case 'glassTower':
      return { wall: 'concrete', trim: 'metalLight', base: 'stoneAshlar', roof: 'roofTar', shutter: 'shutter', metal: 'metalLight' };
    case 'warehouse':
      return { wall: 'corrugated', trim: 'metalDark', base: 'brickRed', roof: 'metalLight', shutter: 'metalDark', metal: 'metalDark' };
    case 'marketHall':
      return { wall: 'brickBuff', trim: 'stoneAshlar', base: 'stoneAshlar', roof: 'metalLight', shutter: 'metalDark', metal: 'metalDark' };
  }
}

// ---------------------------------------------------------------------------
// Per-archetype façade rhythm
// ---------------------------------------------------------------------------

interface FacadeSpec {
  /** Preferred centre-to-centre spacing of openings. */
  readonly module: number;
  readonly windowWidth: number;
  /** Sill height above the floor it belongs to. */
  readonly sill: number;
  /** Gap between the window head and the ceiling. */
  readonly headGap: number;
  readonly reveal: number;
  readonly bar: number;
  readonly stoneSills: boolean;
  /** A projecting head or lintel over each opening. */
  readonly lintels: boolean;
  readonly shutterChance: number;
  readonly boardedChance: number;
  readonly acChance: number;
  readonly blindChance: number;
  /** Ground floor is a shopfront rather than more of the same windows. */
  readonly shopfront: boolean;
}

const FACADES: Readonly<Record<ArchetypeId, FacadeSpec>> = {
  harbourRow: {
    module: 3.15, windowWidth: 1.2, sill: 0.95, headGap: 0.68, reveal: 0.16, bar: 0.08,
    stoneSills: false, lintels: true, shutterChance: 0.3, boardedChance: 0.03, acChance: 0.18, blindChance: 0.22, shopfront: true,
  },
  oldTenement: {
    module: 2.72, windowWidth: 0.98, sill: 0.82, headGap: 0.55, reveal: 0.18, bar: 0.07,
    stoneSills: true, lintels: true, shutterChance: 0.16, boardedChance: 0.05, acChance: 0.22, blindChance: 0.26, shopfront: true,
  },
  brickWalkup: {
    module: 3.05, windowWidth: 1.22, sill: 0.95, headGap: 0.72, reveal: 0.15, bar: 0.08,
    stoneSills: true, lintels: true, shutterChance: 0.06, boardedChance: 0.05, acChance: 0.24, blindChance: 0.2, shopfront: false,
  },
  terraceHouse: {
    module: 3.0, windowWidth: 1.15, sill: 0.92, headGap: 0.55, reveal: 0.13, bar: 0.08,
    stoneSills: true, lintels: true, shutterChance: 0.34, boardedChance: 0.02, acChance: 0.1, blindChance: 0.2, shopfront: false,
  },
  civicStone: {
    module: 4.3, windowWidth: 1.62, sill: 1.0, headGap: 0.95, reveal: 0.34, bar: 0.1,
    stoneSills: true, lintels: true, shutterChance: 0, boardedChance: 0, acChance: 0.04, blindChance: 0.12, shopfront: false,
  },
  apartmentSlab: {
    module: 3.4, windowWidth: 1.5, sill: 0.85, headGap: 0.6, reveal: 0.2, bar: 0.08,
    stoneSills: false, lintels: false, shutterChance: 0, boardedChance: 0.02, acChance: 0.3, blindChance: 0.3, shopfront: false,
  },
  midriseOffice: {
    module: 3.0, windowWidth: 1.6, sill: 1.05, headGap: 0.38, reveal: 0.22, bar: 0.09,
    stoneSills: false, lintels: false, shutterChance: 0, boardedChance: 0, acChance: 0.02, blindChance: 0.16, shopfront: false,
  },
  glassTower: {
    module: 2.7, windowWidth: 2.2, sill: 0.95, headGap: 0.2, reveal: 0.16, bar: 0.09,
    stoneSills: false, lintels: false, shutterChance: 0, boardedChance: 0, acChance: 0, blindChance: 0.1, shopfront: false,
  },
  warehouse: {
    module: 4.4, windowWidth: 1.8, sill: 1.1, headGap: 0.6, reveal: 0.16, bar: 0.09,
    stoneSills: false, lintels: true, shutterChance: 0, boardedChance: 0.12, acChance: 0.06, blindChance: 0.05, shopfront: false,
  },
  marketHall: {
    module: 5.2, windowWidth: 2.6, sill: 1.0, headGap: 1.2, reveal: 0.3, bar: 0.11,
    stoneSills: true, lintels: false, shutterChance: 0, boardedChance: 0, acChance: 0.02, blindChance: 0.06, shopfront: true,
  },
};

/** Archetypes built shoulder to shoulder, so their flanks are party walls. */
const TERRACED: ReadonlySet<ArchetypeId> = new Set<ArchetypeId>([
  'harbourRow',
  'oldTenement',
  'brickWalkup',
  'terraceHouse',
]);

/** Archetypes whose ground floor is trade, and therefore may be lit at night. */
const COMMERCIAL: ReadonlySet<ArchetypeId> = new Set<ArchetypeId>([
  'harbourRow',
  'oldTenement',
  'marketHall',
  'midriseOffice',
  'glassTower',
]);

/** Archetypes that hang a sign off the front. A tower does not. */
const SIGNED: ReadonlySet<ArchetypeId> = new Set<ArchetypeId>([
  'harbourRow',
  'oldTenement',
  'brickWalkup',
  'marketHall',
  'warehouse',
]);

// ---------------------------------------------------------------------------
// Building context
// ---------------------------------------------------------------------------

type SideRole = 'front' | 'return' | 'rear' | 'party';

interface Variant {
  readonly bay: boolean;
  readonly bayFrom: number;
  readonly bayTo: number;
  readonly balconies: boolean;
  readonly recessedBalconies: boolean;
  readonly fireEscape: boolean;
  readonly eyebrows: boolean;
  readonly pilasters: boolean;
  readonly quoins: boolean;
  readonly partyStep: boolean;
  readonly portico: boolean;
  /** A vertical fin breaking the parapet, the strip's other silhouette move. */
  readonly fin: boolean;
  readonly setback: number;
  readonly awning: boolean;
  readonly bladeSign: boolean;
  readonly signKey: MaterialKey;
}

interface Building {
  readonly parcel: Parcel;
  readonly rng: Rng;
  readonly w: MeshWriter;
  readonly sink: GeometrySink;
  readonly rect: Rect;
  readonly width: number;
  readonly depth: number;
  readonly groundY: number;
  readonly baseY: number;
  readonly roofY: number;
  readonly storeys: number;
  readonly storeyHeight: number;
  readonly groundStoreyHeight: number;
  readonly palette: Palette;
  readonly spec: FacadeSpec;
  readonly variant: Variant;
  readonly glazing: WindowStyle;
  readonly door: Doorway;
  readonly doorAlong: number;
  /** Walkable ground immediately outside the front door. */
  readonly outsideY: number;
  readonly plinthProud: number;
  readonly roles: ReadonlyMap<Facing, SideRole>;
  readonly sides: ReadonlyMap<Facing, Side>;
}

function floorLevel(b: Building, storey: number): number {
  return storey === 0 ? b.groundY : b.groundY + b.groundStoreyHeight + (storey - 1) * b.storeyHeight;
}

function storeyHeightOf(b: Building, storey: number): number {
  return storey === 0 ? b.groundStoreyHeight : b.storeyHeight;
}

function sideYaw(side: Side): number {
  // Yaw convention matches the player camera: forward is (-sin y, 0, -cos y).
  if (side.runAxis === 'x') return side.outward > 0 ? Math.PI : 0;
  return side.outward > 0 ? -Math.PI * 0.5 : Math.PI * 0.5;
}

function place(sink: GeometrySink, prop: PropKey, x: number, y: number, z: number, yaw: number): void {
  const matrix = new Matrix4().makeRotationY(yaw);
  matrix.setPosition(x, y, z);
  sink.instance(prop, matrix);
}

/**
 * Decides which elevation gets what.
 *
 * A terrace shares its flanks with its neighbours, so those become blank party
 * walls: correct, and it is also where most of the triangle savings come from.
 * Freestanding types are treated all round, and one flank of a terraced
 * building is occasionally opened up because in a real street some of them are
 * on corners.
 */
function assignRoles(parcel: Parcel, rng: Rng): Map<Facing, SideRole> {
  const roles = new Map<Facing, SideRole>();
  const terraced = TERRACED.has(parcel.archetype);
  const openFlank: Facing | null = terraced && rng.chance(0.34)
    ? (parcel.facing === 'north' || parcel.facing === 'south' ? (rng.chance(0.5) ? 'west' : 'east') : (rng.chance(0.5) ? 'north' : 'south'))
    : null;

  for (const facing of ALL_FACINGS) {
    if (facing === parcel.facing) roles.set(facing, 'front');
    else if (facing === opposite(parcel.facing)) roles.set(facing, 'rear');
    else if (!terraced || facing === openFlank) roles.set(facing, 'return');
    else roles.set(facing, 'party');
  }
  return roles;
}

function makeVariant(parcel: Parcel, rng: Rng, width: number): Variant {
  const a = parcel.archetype;
  const bay = (a === 'terraceHouse' && width > 7.5) || (a === 'harbourRow' && rng.chance(0.4) && width > 9.5);
  const bayWidth = Math.min(2.9, width * 0.36);
  const bayCentre = width * (rng.chance(0.5) ? 0.32 : 0.68);
  return {
    bay,
    bayFrom: bayCentre - bayWidth * 0.5,
    bayTo: bayCentre + bayWidth * 0.5,
    balconies: (a === 'oldTenement' && rng.chance(0.78)) || (a === 'harbourRow' && rng.chance(0.3)),
    recessedBalconies: a === 'apartmentSlab',
    fireEscape: a === 'brickWalkup' && parcel.storeys >= 3 && rng.chance(0.45),
    eyebrows: a === 'harbourRow' && rng.chance(0.82),
    pilasters: a === 'civicStone',
    quoins: a === 'civicStone' || (a === 'brickWalkup' && rng.chance(0.3)),
    partyStep: rng.chance(0.55),
    portico: a === 'civicStone' && width > 15,
    fin: a === 'harbourRow' && rng.chance(0.38),
    setback: a === 'midriseOffice' ? 1.25 : a === 'apartmentSlab' && rng.chance(0.4) ? 0.9 : 0,
    awning: rng.chance(0.5),
    bladeSign: rng.chance(0.32),
    signKey: rng.chance(0.55) ? 'signEmissiveWarm' : 'signEmissive',
  };
}

function makeBuilding(parcel: Parcel, rng: Rng, w: MeshWriter, sink: GeometrySink): Building {
  const rect = parcel.rect;
  const width = rect.maxX - rect.minX;
  const depth = rect.maxZ - rect.minZ;
  const total = parcel.groundStoreyHeight + (parcel.storeys - 1) * parcel.storeyHeight;
  const palette = paletteFor(parcel.archetype, rng);
  const spec = FACADES[parcel.archetype];
  const door = doorwayFor(parcel);
  const approach = doorApproach(door, 1.1);

  const sides = new Map<Facing, Side>();
  for (const facing of ALL_FACINGS) sides.set(facing, sideOf(rect, facing));

  const glazing: WindowStyle = {
    glass: 'glassDark',
    frame: 'windowFrame',
    reveal: spec.reveal,
    bar: spec.bar,
    lining: palette.wall,
  };

  return {
    parcel,
    rng,
    w,
    sink,
    rect,
    width,
    depth,
    groundY: parcel.groundY,
    baseY: parcel.baseY,
    roofY: parcel.groundY + total,
    storeys: parcel.storeys,
    storeyHeight: parcel.storeyHeight,
    groundStoreyHeight: parcel.groundStoreyHeight,
    palette,
    spec,
    variant: makeVariant(parcel, rng, parcel.facing === 'north' || parcel.facing === 'south' ? width : depth),
    glazing,
    door,
    doorAlong: parcel.facing === 'north' || parcel.facing === 'south' ? door.x : door.z,
    // The surface just outside the door is the pavement or the block interior,
    // both of which sit exactly one kerb above the continuous terrain. It is
    // clamped into the plinth so the entrance steps can never dig below the
    // base course or climb above the threshold.
    outsideY: clamp(
      landElevation(approach.x, approach.z) + KERB_HEIGHT,
      parcel.baseY + 0.42,
      parcel.groundY - 0.02,
    ),
    plinthProud: rng.range(0.06, 0.12),
    roles: assignRoles(parcel, rng),
    sides,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildBuilding(parcel: Parcel, sink: GeometrySink): void {
  const rng = createRng(parcel.seed);
  const w = new MeshWriter();
  const b = makeBuilding(parcel, rng, w, sink);

  emitPlinth(b);

  switch (parcel.archetype) {
    case 'glassTower':
      buildCurtainWall(b);
      break;
    case 'midriseOffice':
      buildRibbonFrame(b);
      break;
    case 'warehouse':
      buildWarehouse(b);
      break;
    case 'marketHall':
      buildMarketHall(b);
      break;
    default:
      buildPunched(b);
      break;
  }

  emitApproach(b);
  w.flush(sink);
  emitMainCollider(b);
}

// ---------------------------------------------------------------------------
// Plinth
// ---------------------------------------------------------------------------

/**
 * The base course. It runs from below the lowest ground under the footprint up
 * to finished floor level and stands proud of the wall, so on a slope the
 * downhill face reads as a retaining wall - which is exactly what it is.
 */
function emitPlinth(b: Building): void {
  const p = b.plinthProud;
  b.w.box(
    b.palette.base,
    b.rect.minX - p,
    b.baseY,
    b.rect.minZ - p,
    b.rect.maxX + p,
    b.groundY,
    b.rect.maxZ + p,
    FACE.NO_BOTTOM,
  );
  // A shadow reveal where the wall lands on the base course.
  b.w.box(
    b.palette.base,
    b.rect.minX - p * 0.35,
    b.groundY,
    b.rect.minZ - p * 0.35,
    b.rect.maxX + p * 0.35,
    b.groundY + 0.06,
    b.rect.maxZ + p * 0.35,
    FACE.NO_BOTTOM,
  );
}

// ---------------------------------------------------------------------------
// The punched-window family
// ---------------------------------------------------------------------------

type SlotKind = 'window' | 'shop' | 'door' | 'balcony' | 'bay';

interface Slot {
  readonly hole: Opening;
  readonly kind: SlotKind;
}

/**
 * Window module for this building, widened until the whole envelope fits inside
 * the triangle budget. Openings are the dominant cost, so this is the single
 * knob that keeps a nine-storey slab and a two-storey cottage in the same range.
 */
function budgetedModule(b: Building): number {
  const base = b.spec.module;
  let count = 0;
  for (const [facing, role] of b.roles) {
    if (role === 'party') continue;
    const side = b.sides.get(facing);
    if (!side) continue;
    const perStorey = rhythm(sideSpan(side), base, 0.9).length;
    count += perStorey * b.storeys;
  }
  if (count <= WINDOW_BUDGET) return base;
  return base * (count / WINDOW_BUDGET);
}

/** Secondary elevations get a coarser rhythm; nobody detailed a back wall. */
function moduleFor(role: SideRole, module: number): number {
  if (role === 'front') return module;
  if (role === 'return') return module * 1.1;
  return module * 1.25;
}

/** What is left of a run once the reserved stretches are taken out of it. */
function freeSegments(
  from: number,
  to: number,
  reserved: readonly { from: number; to: number }[],
): { from: number; to: number }[] {
  let segments = [{ from, to }];
  for (const zone of reserved) {
    const next: { from: number; to: number }[] = [];
    for (const segment of segments) {
      if (zone.to <= segment.from || zone.from >= segment.to) {
        next.push(segment);
        continue;
      }
      if (zone.from - segment.from > 0.1) next.push({ from: segment.from, to: zone.from });
      if (segment.to - zone.to > 0.1) next.push({ from: zone.to, to: segment.to });
    }
    segments = next;
  }
  return segments;
}

function planStorey(b: Building, side: Side, role: SideRole, storey: number, module: number): Slot[] {
  const floorY = floorLevel(b, storey);
  const height = storeyHeightOf(b, storey);
  const isFront = role === 'front';
  const slots: Slot[] = [];

  const reserved: { from: number; to: number }[] = [];
  if (isFront && storey === 0) {
    reserved.push({ from: b.doorAlong - b.door.width * 0.75, to: b.doorAlong + b.door.width * 0.75 });
  }
  if (isFront && b.variant.bay) {
    reserved.push({ from: side.start + b.variant.bayFrom - 0.3, to: side.start + b.variant.bayTo + 0.3 });
  }

  const blocked = (along: number, half: number): boolean =>
    reserved.some((zone) => along + half + 0.3 > zone.from && along - half - 0.3 < zone.to);

  // The ground floor of a shop street is glazed almost wall to wall. Bays are
  // fitted into whatever the door and the bay window leave, rather than laid on
  // an independent grid and then deleted where they clash - on a 9 m frontage
  // that difference is a shopfront or a blank wall.
  if (storey === 0 && b.spec.shopfront && (isFront || role === 'return')) {
    const bayModule = Math.max(3.2, module * 1.2);
    const pad = 0.75;
    for (const segment of freeSegments(
      side.start + pad,
      side.end - pad,
      reserved.map((zone) => ({ from: zone.from - 0.32, to: zone.to + 0.32 })),
    )) {
      const span = segment.to - segment.from;
      if (span < 1.5) continue;
      const bays = Math.max(1, Math.min(6, Math.round(span / bayModule)));
      const pitch = span / bays;
      for (let i = 0; i < bays; i += 1) {
        slots.push({
          hole: openingAt(
            segment.from + pitch * (i + 0.5),
            Math.min(pitch * 0.86, 3.4),
            floorY + 0.52,
            floorY + height - 0.86,
          ),
          kind: 'shop',
        });
      }
    }
  } else {
    const sill = storey === 0 ? b.spec.sill + 0.28 : b.spec.sill;
    const y0 = floorY + sill;
    const y1 = floorY + height - b.spec.headGap;
    if (y1 - y0 > 0.5) {
      for (const centre of rhythm(sideSpan(side), module, 0.9)) {
        const along = side.start + centre;
        const half = b.spec.windowWidth * 0.5;
        if (blocked(along, half)) continue;
        slots.push({ hole: openingAt(along, b.spec.windowWidth, y0, y1), kind: 'window' });
      }
    }
  }

  if (isFront && storey === 0) {
    slots.push({
      hole: openingAt(b.doorAlong, b.door.width, b.groundY, b.groundY + b.door.height),
      kind: 'door',
    });
  }

  if (isFront && b.variant.bay && storey === 0) {
    slots.push({
      hole: openingAt(
        side.start + (b.variant.bayFrom + b.variant.bayTo) * 0.5,
        b.variant.bayTo - b.variant.bayFrom,
        floorY + 0.45,
        floorY + height - 0.72,
      ),
      kind: 'bay',
    });
  }

  // Recessed balconies replace a pair of windows on the upper floors.
  if (b.variant.recessedBalconies && isFront && storey > 0 && slots.length >= 3) {
    const pick = 1 + ((storey * 2) % Math.max(1, slots.length - 2));
    const target = slots[pick];
    if (target && target.kind === 'window') {
      slots[pick] = {
        hole: openingAt(target.hole.along, 2.7, floorY + 0.02, floorY + height - 0.32),
        kind: 'balcony',
      };
    }
  }

  return slots;
}

function emitStorey(b: Building, side: Side, role: SideRole, storey: number, module: number): void {
  const floorY = floorLevel(b, storey);
  const top = floorY + storeyHeightOf(b, storey);
  const slots = planStorey(b, side, role, storey, module);

  punchedPanel(
    b.w,
    b.palette.wall,
    side,
    side.start,
    side.end,
    floorY,
    top,
    0,
    slots.map((s) => s.hole),
  );

  for (const slot of slots) {
    switch (slot.kind) {
      case 'window':
        emitWindow(b, side, role, slot.hole);
        break;
      case 'shop':
        emitShopfront(b, side, slot.hole, floorY, top);
        break;
      case 'door':
        emitDoorway(b, side, slot.hole);
        break;
      case 'bay':
        emitBayWindow(b, side, slot.hole);
        break;
      case 'balcony':
        emitRecessedBalcony(b, side, slot.hole);
        break;
    }
  }
}

function emitWindow(b: Building, side: Side, role: SideRole, hole: Opening): void {
  const anchor = sidePoint(side, hole.along, hole.y0, 0);
  const roll = hash2(anchor[0], anchor[1], 17);
  const roll2 = hash2(anchor[0], anchor[1], 41);
  const decorated = role === 'front' || role === 'return';

  if (b.spec.stoneSills && decorated) stoneSill(b.w, b.palette.trim, side, hole, 0);
  if (b.spec.lintels && decorated) {
    // A head over each opening: the one piece of relief that makes a punched
    // window read as masonry rather than a rectangle cut from card.
    sideBox(
      b.w,
      b.palette.trim,
      side,
      hole.along - hole.half - 0.13,
      hole.along + hole.half + 0.13,
      hole.y1,
      hole.y1 + 0.17,
      -0.02,
      0.1,
      SF.BAND,
    );
  }

  if (decorated && roll < b.spec.boardedChance) {
    // Boarded up: same relief, timber where the glass should be.
    windowInsert(b.w, side, hole, 0, { ...b.glazing, glass: 'timber' });
  } else {
    windowInsert(b.w, side, hole, 0, b.glazing);
    if (decorated && roll2 < b.spec.blindChance) {
      blind(b.w, 'shutter', side, hole, 0, b.glazing.reveal, 0.3 + roll * 0.45);
    }
  }

  if (!decorated) return;
  if (roll > 1 - b.spec.shutterChance) {
    shutters(b.w, b.palette.shutter, side, hole, 0);
  } else if (roll2 > 1 - b.spec.acChance) {
    const at = sidePoint(side, hole.along, hole.y0 + 0.02, 0.24);
    place(b.sink, 'acUnit', at[0], at[1], at[2], sideYaw(side));
  }
}

/** Shop glazing, its stall riser and the fascia band that carries the sign. */
function emitShopfront(b: Building, side: Side, hole: Opening, floorY: number, top: number): void {
  revealFor(b.w, b.palette.wall, side, hole, 0, 0.16);
  const back = -0.16;
  const bar = 0.09;
  const a0 = hole.along - hole.half;
  const a1 = hole.along + hole.half;

  sideQuad(b.w, 'windowFrame', side, a0, a1, hole.y0, hole.y0 + bar, back);
  sideQuad(b.w, 'windowFrame', side, a0, a1, hole.y1 - bar, hole.y1, back);
  sideQuad(b.w, 'windowFrame', side, a0, a0 + bar, hole.y0 + bar, hole.y1 - bar, back);
  sideQuad(b.w, 'windowFrame', side, a1 - bar, a1, hole.y0 + bar, hole.y1 - bar, back);
  // A mullion splits wide bays, which is what stops a shopfront reading as a
  // single sheet of black.
  if (hole.half > 1.1) {
    sideQuad(b.w, 'windowFrame', side, hole.along - 0.045, hole.along + 0.045, hole.y0 + bar, hole.y1 - bar, back);
  }
  sideQuad(b.w, 'glassShop', side, a0 + bar, a1 - bar, hole.y0 + bar, hole.y1 - bar, back - 0.03);

  // Stall riser under the glazing.
  sideBox(b.w, b.palette.trim, side, a0 - 0.08, a1 + 0.08, floorY + 0.04, hole.y0 + 0.02, -0.02, 0.07, SF.BAND);
  // Fascia above it, running the full bay.
  sideBox(b.w, b.palette.trim, side, a0 - 0.16, a1 + 0.16, hole.y1 + 0.05, top - 0.18, -0.02, 0.12, SF.BAND);

  if (b.variant.awning && hash2(a0, hole.y1, 61) < 0.62) {
    awning(b.w, 'canvasAwning', side, a0 - 0.1, a1 + 0.1, hole.y1 + 0.02, MAX_OVERSAIL * 0.95);
  }
}

/**
 * The front door. For an enterable building the opening is left as a real hole
 * so the interior team can fill it; everything else gets a painted leaf set
 * back in the reveal.
 */
function emitDoorway(b: Building, side: Side, hole: Opening): void {
  revealFor(b.w, b.palette.trim, side, hole, 0, 0.26, false);
  // A moulded surround gives the entrance a hierarchy the windows do not have.
  sideBox(b.w, b.palette.trim, side, hole.along - hole.half - 0.16, hole.along + hole.half + 0.16, hole.y1, hole.y1 + 0.2, -0.02, 0.14, SF.BAND);

  if (b.parcel.enterable) return;

  const back = -0.26;
  const bar = 0.09;
  const a0 = hole.along - hole.half;
  const a1 = hole.along + hole.half;
  sideQuad(b.w, 'windowFrame', side, a0, a1, hole.y1 - bar, hole.y1, back);
  sideQuad(b.w, 'windowFrame', side, a0, a0 + bar, hole.y0, hole.y1 - bar, back);
  sideQuad(b.w, 'windowFrame', side, a1 - bar, a1, hole.y0, hole.y1 - bar, back);
  sideQuad(b.w, 'doorPainted', side, a0 + bar, a1 - bar, hole.y0, hole.y1 - bar - 0.5, back - 0.02);
  // Fanlight over the door.
  sideQuad(b.w, 'glassDark', side, a0 + bar, a1 - bar, hole.y1 - bar - 0.44, hole.y1 - bar, back - 0.04);
  sideQuad(b.w, 'windowFrame', side, a0 + bar, a1 - bar, hole.y1 - bar - 0.5, hole.y1 - bar - 0.44, back - 0.01);
}

/** A projecting bay window: front light, two glazed cheeks, a lead roof. */
function emitBayWindow(b: Building, side: Side, hole: Opening): void {
  const out = 0.55;
  const a0 = hole.along - hole.half;
  const a1 = hole.along + hole.half;
  const face = shiftSide(side, out, a0, a1);
  const bar = 0.09;

  sideQuad(b.w, 'windowFrame', face, a0, a1, hole.y0, hole.y0 + bar, 0);
  sideQuad(b.w, 'windowFrame', face, a0, a1, hole.y1 - bar, hole.y1, 0);
  sideQuad(b.w, 'windowFrame', face, a0, a0 + bar, hole.y0, hole.y1, 0);
  sideQuad(b.w, 'windowFrame', face, a1 - bar, a1, hole.y0, hole.y1, 0);
  sideQuad(b.w, 'windowFrame', face, hole.along - 0.045, hole.along + 0.045, hole.y0, hole.y1, 0);
  sideQuad(b.w, 'glassDark', face, a0 + bar, a1 - bar, hole.y0 + bar, hole.y1 - bar, -0.03);

  // Cheeks, drawn as solid returns so the bay has mass.
  sideBox(b.w, b.palette.wall, side, a0, a0 + 0.14, hole.y0, hole.y1, 0, out, SF.NO_BACK);
  sideBox(b.w, b.palette.wall, side, a1 - 0.14, a1, hole.y0, hole.y1, 0, out, SF.NO_BACK);
  // Apron and roof slab.
  sideBox(b.w, b.palette.trim, side, a0 - 0.1, a1 + 0.1, hole.y0 - 0.42, hole.y0, 0, out + 0.06, SF.BAND);
  sideBox(b.w, b.palette.trim, side, a0 - 0.12, a1 + 0.12, hole.y1, hole.y1 + 0.16, 0, out + 0.08, SF.BAND);

  b.sink.collider({
    ...worldFootprint(side, a0 - 0.1, a1 + 0.1, 0, out + 0.08),
    bottom: b.groundY - 0.5,
    top: hole.y1 + 0.16,
    solid: true,
  });
}

/** A real recess with a slab, a back wall and a solid balustrade. */
function emitRecessedBalcony(b: Building, side: Side, hole: Opening): void {
  const depth = Math.min(1.45, b.depth * 0.16);
  revealFor(b.w, b.palette.wall, side, hole, 0, depth);
  const back = shiftSide(side, -depth, hole.along - hole.half, hole.along + hole.half);
  const a0 = hole.along - hole.half;
  const a1 = hole.along + hole.half;
  // Back wall with a glazed door onto the balcony.
  punchedPanel(b.w, b.palette.wall, back, a0, a1, hole.y0, hole.y1, 0, [
    openingAt(hole.along - 0.5, 1.4, hole.y0 + 0.05, hole.y1 - 0.35),
  ]);
  sideQuad(b.w, 'windowFrame', back, hole.along - 1.2, hole.along + 0.2, hole.y0 + 0.05, hole.y1 - 0.35, 0);
  sideQuad(b.w, 'glassDark', back, hole.along - 1.14, hole.along + 0.14, hole.y0 + 0.11, hole.y1 - 0.41, -0.04);
  // Solid upstand at the outer face.
  sideBox(b.w, b.palette.trim, side, a0, a1, hole.y0, hole.y0 + 1.05, -0.14, 0.05, SF.ALL);
}

/**
 * Walls, trim and roof for everything with punched openings: the harbour row,
 * the old quarter, the walk-ups, the terraces, the civic stone.
 */
function buildPunched(b: Building): void {
  const module = budgetedModule(b);
  const setbackStorey = b.variant.setback > 0 && b.storeys >= 6 ? b.storeys - 1 : -1;

  for (const [facing, role] of b.roles) {
    const side = b.sides.get(facing);
    if (!side) continue;

    if (role === 'party') {
      emitPartyWall(b, side);
      continue;
    }
    for (let storey = 0; storey < b.storeys; storey += 1) {
      if (storey === setbackStorey) continue;
      emitStorey(b, side, role, storey, moduleFor(role, module));
    }
  }

  if (b.variant.pilasters) emitPilasters(b, module);
  if (b.variant.quoins) emitQuoins(b);
  if (b.variant.eyebrows) emitEyebrows(b);
  if (b.variant.balconies) emitJulietBalconies(b, module);
  if (b.variant.fireEscape) emitFireEscape(b);
  if (b.variant.portico) emitPortico(b);
  if (b.variant.fin) emitFin(b);
  emitStringCourses(b);
  emitDownpipes(b);

  if (setbackStorey >= 0) {
    const inset = insetRect(b.rect, b.variant.setback);
    const y = floorLevel(b, setbackStorey);
    flatDeck(b.w, inset, y, b.palette.roof, -b.variant.setback + 0.2);
    parapetRing(b.w, b.rect, y, 0.95, 0.26, b.palette.wall, b.palette.trim);
    for (const facing of ALL_FACINGS) {
      const side = sideOf(inset, facing);
      emitStorey(
        { ...b, rect: inset },
        side,
        facing === b.parcel.facing ? 'front' : 'rear',
        setbackStorey,
        module,
      );
    }
    emitTop(b, inset, 0);
  } else {
    emitTop(b, b.rect, 0);
  }
}

/**
 * A blank flank, stepped so it does not read as a slab of nothing.
 *
 * Party walls are the cheapest square metres in the city - one quad each - and
 * they are also correct: a terrace shares them with its neighbours. The step and
 * the blind bay are what stop them looking like an oversight.
 */
function emitPartyWall(b: Building, side: Side): void {
  const span = sideSpan(side);
  const stepped = b.variant.partyStep && span > 7;
  const step = stepped ? 0.22 : 0;
  const cut = stepped ? side.start + span * 0.58 : side.end;

  // A shallow blind bay, the panel a real party wall carries a ghost sign on.
  const half = Math.min(1.5, span * 0.18);
  const centre = Math.min(side.start + span * 0.34, cut - half - 0.4);
  const wantBay = half > 0.7 && b.roofY - b.groundY > 5.5 && centre - half > side.start + 0.4;
  const bay = wantBay ? [openingAt(centre, half * 2, b.groundY + 1.5, b.roofY - 1.3)] : [];

  punchedPanel(b.w, b.palette.wall, side, side.start, cut, b.groundY, b.roofY, 0, bay);
  for (const hole of bay) {
    revealFor(b.w, b.palette.wall, side, hole, 0, 0.1);
    sideQuad(b.w, b.palette.trim, side, hole.along - hole.half, hole.along + hole.half, hole.y0, hole.y1, -0.1);
  }

  if (stepped) {
    sideQuad(b.w, b.palette.wall, side, cut, side.end, b.groundY, b.roofY, step);
    sideBox(b.w, b.palette.wall, side, cut - 0.01, cut + 0.01, b.groundY, b.roofY, 0, step, SF.START | SF.END);
  }
}

/**
 * A pilaster order between the window bays, standing on a rusticated base.
 * The projection is deliberately generous: a 100 mm pilaster in the same stone
 * as the wall is invisible, which is exactly the failure the art brief warns
 * about when it says every mass needs at least one reveal.
 */
function emitPilasters(b: Building, module: number): void {
  const front = b.sides.get(b.parcel.facing);
  if (!front) return;
  const span = sideSpan(front);
  const base = b.groundY + b.groundStoreyHeight;
  for (const centre of rhythm(span, module, 0.9)) {
    const at = front.start + centre - module * 0.5;
    if (at < front.start + 0.5 || at > front.end - 0.5) continue;
    sideBox(b.w, b.palette.trim, front, at - 0.33, at + 0.33, base, b.roofY - 0.12, -0.02, 0.26, SF.BAND);
    // Capital.
    sideBox(b.w, b.palette.trim, front, at - 0.42, at + 0.42, b.roofY - 0.44, b.roofY - 0.12, -0.02, 0.33, SF.BAND);
  }
  // Rustication: horizontal courses across the ground storey only, which is
  // what sets the base apart from the wall above without a texture.
  for (let i = 1; i <= 3; i += 1) {
    const y = b.groundY + (b.groundStoreyHeight * i) / 4;
    stringCourse(b.w, b.rect, y - 0.05, 0.1, 0.13, b.palette.base);
  }
  stringCourse(b.w, b.rect, base - 0.02, 0.22, 0.19, b.palette.base);
}

function emitQuoins(b: Building): void {
  const front = b.sides.get(b.parcel.facing);
  if (!front) return;
  for (const at of [front.start, front.end]) {
    const a0 = at === front.start ? front.start : front.end - 0.52;
    sideBox(b.w, b.palette.trim, front, a0, a0 + 0.52, b.groundY, b.roofY, -0.02, 0.09, SF.BAND);
  }
}

/**
 * A vertical fin carrying a sign, breaking the parapet.
 *
 * The reference read-out calls for every third or fourth building on the strip
 * to break its roofline; between this and the stepped parapet, roughly half of
 * them do, which is what stops a terrace reading as one extruded ribbon.
 */
function emitFin(b: Building): void {
  const front = b.sides.get(b.parcel.facing);
  if (!front) return;
  const span = sideSpan(front);
  const at = b.rng.chance(0.5) ? front.start + 0.75 : front.end - 0.75;
  if (span < 6) return;
  const top = b.roofY + 2.4;
  sideBox(b.w, b.palette.trim, front, at - 0.32, at + 0.32, b.groundY + b.groundStoreyHeight, top, -0.02, 0.34, SF.BAND);
  sideBox(b.w, b.variant.signKey, front, at - 0.2, at + 0.2, b.roofY - 1.6, top - 0.25, 0.3, 0.44, SF.NO_BACK);
}

/** Deco eyebrow slabs at every floor line: the harbour row's signature. */
function emitEyebrows(b: Building): void {
  const front = b.sides.get(b.parcel.facing);
  if (!front) return;
  for (let storey = 1; storey < b.storeys; storey += 1) {
    const y = floorLevel(b, storey);
    sideBox(b.w, b.palette.trim, front, front.start - 0.05, front.end + 0.05, y - 0.16, y, -0.02, 0.5, SF.BAND);
  }
}

/** Shallow wrought-iron balconies on the upper floors of the old quarter. */
function emitJulietBalconies(b: Building, module: number): void {
  const front = b.sides.get(b.parcel.facing);
  if (!front) return;
  const centres = rhythm(sideSpan(front), module, 0.9);
  let placed = 0;
  for (let storey = 1; storey < b.storeys && placed < 7; storey += 1) {
    const floorY = floorLevel(b, storey);
    for (const centre of centres) {
      if (placed >= 7) break;
      const along = front.start + centre;
      if (hash2(along, floorY, 83) > 0.55) continue;
      const half = b.spec.windowWidth * 0.5 + 0.24;
      sideBox(b.w, b.palette.metal, front, along - half, along + half, floorY + b.spec.sill - 0.14, floorY + b.spec.sill - 0.06, -0.02, 0.42, SF.BAND);
      balustrade(b.w, b.palette.metal, front, along - half, along + half, floorY + b.spec.sill - 0.06, 0.4, 0.92, 3);
      placed += 1;
    }
  }
}

/** A zig-zag fire escape, the walk-up's most recognisable feature. */
function emitFireEscape(b: Building): void {
  const facing = b.roles.get(opposite(b.parcel.facing)) === 'rear' ? opposite(b.parcel.facing) : b.parcel.facing;
  const side = b.sides.get(facing);
  if (!side) return;
  const span = sideSpan(side);
  if (span < 4) return;
  const centre = side.start + span * (b.rng.chance(0.5) ? 0.28 : 0.72);
  const half = Math.min(1.35, span * 0.22);
  const out = 0.78;
  const key = b.palette.metal;

  for (let storey = 1; storey < b.storeys; storey += 1) {
    const y = floorLevel(b, storey);
    sideBox(b.w, key, side, centre - half, centre + half, y - 0.09, y, 0, out, SF.BAND);
    balustrade(b.w, key, side, centre - half, centre + half, y, out, 0.95, 3);
    if (storey < 2) continue;
    // A flight rising from the landing below, alternating direction so the run
    // zig-zags up the wall the way a real escape does.
    const below = floorLevel(b, storey - 1);
    const dir = storey % 2 === 0 ? 1 : -1;
    const from = centre - dir * half * 0.9;
    const to = centre + dir * half * 0.9;
    const a = sidePoint(side, from, below + 0.02, out * 0.9);
    const c = sidePoint(side, to, y - 0.02, out * 0.9);
    const a2 = sidePoint(side, from, below + 0.02, out * 0.18);
    const c2 = sidePoint(side, to, y - 0.02, out * 0.18);
    b.w.quadFacing(key, a, c, c2, a2, [0, 1, 0]);
    b.w.quadFacing(key, a2, c2, c, a, [0, -1, 0]);
  }
  // Drop ladder to the street.
  const ladder = sidePoint(side, centre, 0, out * 0.75);
  b.w.tube(key, ladder[0], ladder[2], b.groundY + 0.4, floorLevel(b, 1), 0.05, 5);
}

/**
 * A columned entrance to the civic buildings.
 *
 * The order stands in front of the wall rather than in a recess: the front door
 * has to stay in the façade plane where `doorwayFor` puts it, because the
 * interior builder lines its threshold up with exactly that point. A column
 * landing across the doorway is skipped, which is what widens the centre bay -
 * and that is how a portico is proportioned anyway.
 */
function emitPortico(b: Building): void {
  const front = b.sides.get(b.parcel.facing);
  if (!front) return;
  const span = sideSpan(front);
  // The order has to sit over the entrance, and `doorwayFor` puts the door
  // wherever it likes along the elevation. A door too far off centre gets
  // pilasters and a surround instead of a squashed two-column portico.
  if (Math.abs(b.doorAlong - (front.start + front.end) * 0.5) > span * 0.2) return;
  const half = Math.min(4.4, span * 0.28);
  const a0 = clamp(b.doorAlong - half, front.start + 0.5, front.end - 3);
  const a1 = clamp(b.doorAlong + half, front.start + 3, front.end - 0.5);
  if (a1 - a0 < 3.4) return;

  const top = b.groundY + b.groundStoreyHeight - 0.55;
  const stand = 0.36;
  const radius = 0.26;
  for (let i = 0; i < 4; i += 1) {
    const at = a0 + ((a1 - a0) * (i + 0.5)) / 4;
    if (Math.abs(at - b.doorAlong) < 0.95) continue;
    const p = sidePoint(front, at, 0, stand);
    b.w.tube(b.palette.trim, p[0], p[2], b.groundY + 0.3, top - 0.36, radius, 8);
    sideBox(b.w, b.palette.trim, front, at - 0.34, at + 0.34, b.groundY, b.groundY + 0.3, 0, stand + 0.32, SF.NO_BACK);
    sideBox(b.w, b.palette.trim, front, at - 0.34, at + 0.34, top - 0.36, top, 0, stand + 0.32, SF.NO_BACK);
    b.sink.collider({
      ...worldFootprint(front, at - 0.34, at + 0.34, 0, stand + 0.32),
      bottom: b.groundY - 0.3,
      top,
      solid: true,
    });
  }
  // Entablature spanning the order, dying back into the wall at each end.
  sideBox(b.w, b.palette.trim, front, a0 - 0.28, a1 + 0.28, top, top + 0.6, -0.02, stand + 0.4, SF.BAND);
  sideBox(b.w, b.palette.trim, front, a0 - 0.38, a1 + 0.38, top + 0.6, top + 0.76, -0.02, stand + 0.46, SF.BAND);
}

/** Floor bands between the storeys, which is what gives a wall horizontal grain. */
function emitStringCourses(b: Building): void {
  if (b.storeys < 3) return;
  const first = floorLevel(b, 1);
  stringCourse(b.w, b.rect, first - 0.14, 0.16, 0.11, b.palette.trim);
  if (b.storeys >= 5) {
    const mid = floorLevel(b, Math.floor(b.storeys / 2) + 1);
    stringCourse(b.w, b.rect, mid - 0.12, 0.12, 0.08, b.palette.trim);
  }
}

function emitDownpipes(b: Building): void {
  for (const [facing, role] of b.roles) {
    if (role === 'front') continue;
    const side = b.sides.get(facing);
    if (!side) continue;
    if (role !== 'party' && !b.rng.chance(0.5)) continue;
    downpipe(b.w, b.palette.metal, side, side.start + 0.32, b.groundY + 0.1, b.roofY - 0.1);
  }
}

// ---------------------------------------------------------------------------
// Tops and roofs
// ---------------------------------------------------------------------------

/** Cornice, parapet or eaves, then the roof itself and its plant. */
function emitTop(b: Building, rect: Rect, alreadyAbove: number): void {
  const a = b.parcel.archetype;
  const clutter = b.rng.int(2, a === 'terraceHouse' ? 3 : 6);
  const headroom = MAX_ABOVE_ROOF - alreadyAbove;

  if (a === 'terraceHouse') {
    const height = Math.min(1.55, (rect.maxZ - rect.minZ) * 0.15, headroom - 0.9);
    const ridgeAxis: 'x' | 'z' = b.width >= b.depth ? 'x' : 'z';
    b.w.box(b.palette.trim, rect.minX - 0.16, b.roofY - 0.28, rect.minZ - 0.16, rect.maxX + 0.16, b.roofY, rect.maxZ + 0.16, FACE.ALL);
    gableRoof(b.w, rect, b.roofY, Math.max(0.7, height), ridgeAxis, b.palette.roof, b.palette.trim, b.palette.wall);
    emitChimney(b, rect, b.roofY + Math.max(0.7, height), headroom);
    roofClutter(b.sink, b.rng, insetRect(rect, 1.0), b.roofY + 0.2, Math.min(2, clutter), 0.4);
    return;
  }

  if (a === 'civicStone') {
    const capped = corniceStack(b.w, rect, b.roofY - 0.05, [
      { height: 0.22, proud: 0.16, key: b.palette.trim },
      { height: 0.34, proud: 0.3, key: b.palette.trim },
      { height: 0.2, proud: 0.2, key: b.palette.trim },
    ]);
    flatDeck(b.w, rect, capped, b.palette.roof, 0.3);
    parapetRing(b.w, rect, capped, Math.min(0.85, headroom - 0.9), 0.34, b.palette.wall, b.palette.trim, 0.04);
    roofClutter(b.sink, b.rng, rect, capped, clutter, 1.8);
    return;
  }

  const heavy = a === 'oldTenement';
  const capped = heavy
    ? corniceStack(b.w, rect, b.roofY - 0.1, [
        { height: 0.18, proud: 0.14, key: b.palette.trim },
        { height: 0.3, proud: 0.28, key: b.palette.trim },
        { height: 0.16, proud: 0.16, key: b.palette.trim },
      ])
    : corniceStack(b.w, rect, b.roofY - 0.08, [
        { height: 0.16, proud: 0.14, key: b.palette.trim },
        { height: 0.16, proud: 0.22, key: b.palette.trim },
      ]);

  const parapetHeight = clamp(b.rng.range(0.8, 1.5), 0.6, headroom - (capped - b.roofY) - 0.25);
  flatDeck(b.w, rect, capped, b.palette.roof, 0.2);
  parapetRing(b.w, rect, capped, parapetHeight, 0.28, b.palette.wall, b.palette.trim, 0.04);

  // A stepped parapet over the centre bays: the strip's rooflines never level out.
  if ((a === 'harbourRow' || a === 'oldTenement') && b.rng.chance(0.5)) {
    const front = b.sides.get(b.parcel.facing);
    const extra = Math.min(0.55, headroom - (capped - b.roofY) - parapetHeight - 0.14);
    if (front && extra > 0.15) {
      const span = sideSpan(front);
      sideBox(
        b.w,
        b.palette.wall,
        front,
        front.start + span * 0.3,
        front.start + span * 0.7,
        capped + parapetHeight,
        capped + parapetHeight + extra,
        -0.3,
        0.09,
        SF.NO_BACK,
      );
    }
  }

  roofClutter(b.sink, b.rng, rect, capped, clutter, 1.5);
}

function emitChimney(b: Building, rect: Rect, ridgeY: number, headroom: number): void {
  const x = rect.minX + (rect.maxX - rect.minX) * (b.rng.chance(0.5) ? 0.16 : 0.84);
  const z = (rect.minZ + rect.maxZ) * 0.5;
  const top = Math.min(ridgeY + 0.75, b.roofY + headroom - 0.14);
  if (top <= b.roofY + 0.4) return;
  b.w.box(b.palette.base, x - 0.36, b.roofY - 0.4, z - 0.34, x + 0.36, top, z + 0.34, FACE.SIDES);
  b.w.box(b.palette.trim, x - 0.44, top, z - 0.42, x + 0.44, top + 0.12, z + 0.42, FACE.NO_BOTTOM);
}

// ---------------------------------------------------------------------------
// Framed families: ribbon glazing and curtain wall
// ---------------------------------------------------------------------------

/**
 * Continuous vertical mullions.
 *
 * A curtain wall's mullions genuinely do run the full height of the shaft, and
 * modelling them that way costs one box each instead of one per storey - the
 * difference between a tower that fits its budget and one that does not.
 */
function emitMullions(b: Building, side: Side, y0: number, y1: number, pitch: number, out: number, key: MaterialKey): void {
  const span = sideSpan(side);
  const count = Math.max(1, Math.min(12, Math.round(span / pitch) - 1));
  for (let i = 1; i <= count; i += 1) {
    const at = side.start + (span * i) / (count + 1);
    sideBox(b.w, key, side, at - 0.06, at + 0.06, y0, y1, out - 0.02, out + 0.1, SF.FRONT | SF.START | SF.END);
  }
}

/** Concrete frame with ribbon glazing and spandrel bands. */
function buildRibbonFrame(b: Building): void {
  const setback = b.storeys >= 8 ? 1.25 : 0;
  const topStorey = setback > 0 ? b.storeys - 1 : -1;
  const shaftRect = b.rect;

  for (const facing of ALL_FACINGS) {
    const side = b.sides.get(facing);
    if (!side) continue;
    for (let storey = 0; storey < b.storeys; storey += 1) {
      if (storey === topStorey) continue;
      const floorY = floorLevel(b, storey);
      const height = storeyHeightOf(b, storey);
      if (storey === 0) {
        emitGlazedBase(b, side, floorY, height, facing === b.parcel.facing);
        continue;
      }
      const y0 = floorY + b.spec.sill;
      const y1 = floorY + height - b.spec.headGap;
      const hole = openingAt((side.start + side.end) * 0.5, sideSpan(side) - 1.1, y0, y1);
      punchedPanel(b.w, b.palette.wall, side, side.start, side.end, floorY, floorY + height, 0, [hole]);
      revealFor(b.w, b.palette.trim, side, hole, 0, b.spec.reveal);
      sideQuad(b.w, 'glassDark', side, hole.along - hole.half, hole.along + hole.half, y0, y1, -b.spec.reveal);
    }
    emitMullions(b, side, floorLevel(b, 1), topStorey > 0 ? floorLevel(b, topStorey) : b.roofY, b.spec.module, -b.spec.reveal + 0.06, 'windowFrame');
  }

  // Opaque core behind the glass so the tower is never see-through.
  const core = insetRect(shaftRect, 0.5);
  b.w.box(b.palette.wall, core.minX, b.groundY, core.minZ, core.maxX, b.roofY, core.maxZ, FACE.SIDES);

  emitDownpipes(b);

  if (topStorey >= 0) {
    const inset = insetRect(b.rect, setback);
    const y = floorLevel(b, topStorey);
    flatDeck(b.w, inset, y, b.palette.roof, -setback + 0.3);
    parapetRing(b.w, b.rect, y, 1.0, 0.3, b.palette.wall, b.palette.trim);
    for (const facing of ALL_FACINGS) {
      const side = sideOf(inset, facing);
      const height = storeyHeightOf(b, topStorey);
      const hole = openingAt((side.start + side.end) * 0.5, sideSpan(side) - 1.0, y + 0.9, y + height - 0.4);
      punchedPanel(b.w, b.palette.trim, side, side.start, side.end, y, y + height, 0, [hole]);
      revealFor(b.w, b.palette.trim, side, hole, 0, 0.18);
      sideQuad(b.w, 'glassDark', side, hole.along - hole.half, hole.along + hole.half, hole.y0, hole.y1, -0.18);
    }
    corniceStack(b.w, inset, b.roofY - 0.1, [{ height: 0.2, proud: 0.24, key: b.palette.trim }]);
    flatDeck(b.w, inset, b.roofY + 0.1, b.palette.roof, 0.1);
    plantEnclosure(b.w, inset, b.roofY + 0.1, 2.1, Math.min(2.6, b.depth * 0.16), b.palette.wall, b.palette.trim);
    roofClutter(b.sink, b.rng, inset, b.roofY + 0.1, b.rng.int(2, 5), 1.6);
  } else {
    emitTop(b, b.rect, 0);
  }
}

/** A full-height glazed lobby or shop base under a framed building. */
function emitGlazedBase(b: Building, side: Side, floorY: number, height: number, isFront: boolean): void {
  const openings: Opening[] = [];
  const top = floorY + height - 0.55;
  const bays = rhythm(sideSpan(side), 4.2, 1.0, 7);
  for (const centre of bays) {
    const along = side.start + centre;
    if (isFront && Math.abs(along - b.doorAlong) < b.door.width * 1.1) continue;
    openings.push(openingAt(along, Math.min(3.2, sideSpan(side) / (bays.length + 0.6)), floorY + 0.35, top));
  }
  if (isFront) openings.push(openingAt(b.doorAlong, b.door.width, b.groundY, b.groundY + b.door.height));

  punchedPanel(b.w, b.palette.base, side, side.start, side.end, floorY, floorY + height, 0, openings);
  for (const hole of openings) {
    if (isFront && Math.abs(hole.along - b.doorAlong) < 0.01) {
      emitDoorway(b, side, hole);
      continue;
    }
    revealFor(b.w, b.palette.base, side, hole, 0, 0.24);
    const a0 = hole.along - hole.half;
    const a1 = hole.along + hole.half;
    sideQuad(b.w, 'windowFrame', side, a0, a1, hole.y0, hole.y0 + 0.1, -0.24);
    sideQuad(b.w, 'windowFrame', side, a0, a1, hole.y1 - 0.1, hole.y1, -0.24);
    sideQuad(b.w, 'windowFrame', side, hole.along - 0.06, hole.along + 0.06, hole.y0, hole.y1, -0.24);
    sideQuad(b.w, 'glassShop', side, a0, a1, hole.y0 + 0.1, hole.y1 - 0.1, -0.28);
  }
  // Base band, so the podium meets the pavement with a shadow line.
  sideBox(b.w, b.palette.base, side, side.start, side.end, floorY + height - 0.55, floorY + height, -0.02, 0.15, SF.BAND);
}

/** A slender curtain-wall tower with a crown. */
function buildCurtainWall(b: Building): void {
  const shaftBase = b.groundY + b.groundStoreyHeight;

  for (const facing of ALL_FACINGS) {
    const side = b.sides.get(facing);
    if (!side) continue;
    emitGlazedBase(b, side, b.groundY, b.groundStoreyHeight, facing === b.parcel.facing);

    for (let storey = 1; storey < b.storeys; storey += 1) {
      const floorY = floorLevel(b, storey);
      const height = storeyHeightOf(b, storey);
      const spandrel = floorY + 0.92;
      // Spandrel below, vision glass above, a transom between them.
      sideQuad(b.w, 'glassDark', side, side.start, side.end, floorY + 0.06, spandrel, -0.1);
      sideQuad(b.w, hash2(floorY, side.plane, 29) < 0.35 ? 'glassDark' : 'glass', side, side.start, side.end, spandrel + 0.1, floorY + height, -0.1);
      sideBox(b.w, 'windowFrame', side, side.start, side.end, spandrel, spandrel + 0.1, -0.14, -0.02, SF.FRONT | SF.TOP | SF.BOTTOM);
    }
    emitMullions(b, side, shaftBase, b.roofY, b.spec.module, -0.02, 'windowFrame');
    // Floor-line transom at the base of the shaft ties the podium in.
    sideBox(b.w, 'windowFrame', side, side.start, side.end, shaftBase - 0.14, shaftBase, -0.16, 0.04, SF.BAND);
  }

  // The core: an opaque box that stops the player seeing through the tower.
  const core = insetRect(b.rect, 0.45);
  b.w.box(b.palette.wall, core.minX, b.groundY, core.minZ, core.maxX, b.roofY, core.maxZ, FACE.SIDES);

  // Crown: a taller parapet ring with corner fins.
  flatDeck(b.w, b.rect, b.roofY, b.palette.roof, 0.2);
  parapetRing(b.w, b.rect, b.roofY, 1.5, 0.3, b.palette.trim, b.palette.metal, 0.09);
  for (const [cx, cz] of [
    [b.rect.minX, b.rect.minZ],
    [b.rect.maxX, b.rect.minZ],
    [b.rect.minX, b.rect.maxZ],
    [b.rect.maxX, b.rect.maxZ],
  ] as const) {
    const sx = cx === b.rect.minX ? 1 : -1;
    const sz = cz === b.rect.minZ ? 1 : -1;
    b.w.box(b.palette.metal, cx, b.roofY - 3.2, cz, cx + sx * 0.34, b.roofY + 2.5, cz + sz * 0.34, FACE.NO_BOTTOM);
  }
  roofClutter(b.sink, b.rng, b.rect, b.roofY, b.rng.int(2, 4), 2.2);
}

// ---------------------------------------------------------------------------
// Industrial family
// ---------------------------------------------------------------------------

function buildWarehouse(b: Building): void {
  const height = b.roofY - b.groundY;
  const baseTop = b.groundY + Math.min(4.4, height * 0.46);
  const clerestory0 = b.roofY - Math.min(2.2, height * 0.22);
  const clerestory1 = b.roofY - 0.75;

  for (const facing of ALL_FACINGS) {
    const side = b.sides.get(facing);
    if (!side) continue;
    const isFront = facing === b.parcel.facing;
    const span = sideSpan(side);

    // Brick base, standing proud of the sheet metal above it.
    const baseHoles: Opening[] = [];
    if (isFront) {
      const doors = Math.max(1, Math.min(4, Math.floor(span / 8)));
      for (let i = 0; i < doors; i += 1) {
        const along = side.start + (span * (i + 0.5)) / doors;
        if (Math.abs(along - b.doorAlong) < 3.2) continue;
        baseHoles.push(openingAt(along, Math.min(3.4, span / (doors + 1)), b.groundY + 0.05, Math.min(baseTop - 0.5, b.groundY + 3.9)));
      }
      baseHoles.push(openingAt(b.doorAlong, b.door.width, b.groundY, b.groundY + b.door.height));
      // A three-window office bay at the corner, the only relief a shed gets.
      const office = side.start + Math.min(4.5, span * 0.16);
      for (let i = 0; i < 3; i += 1) {
        const along = office + i * 1.9;
        if (along > side.end - 1.2) break;
        if (baseHoles.some((h) => Math.abs(h.along - along) < h.half + 1.2)) continue;
        baseHoles.push(openingAt(along, 1.35, b.groundY + 1.15, b.groundY + 2.85));
      }
    }
    punchedPanel(b.w, b.palette.base, side, side.start, side.end, b.groundY, baseTop, 0.07, baseHoles);
    for (const hole of baseHoles) {
      if (isFront && Math.abs(hole.along - b.doorAlong) < 0.01) {
        emitDoorway(b, side, hole);
      } else if (hole.y1 - hole.y0 > 2.4) {
        // Roller shutter set back in its opening, with the roller box above and
        // a steel weather hood over that.
        revealFor(b.w, b.palette.base, side, hole, 0.07, 0.2);
        sideQuad(b.w, b.palette.shutter, side, hole.along - hole.half, hole.along + hole.half, hole.y0, hole.y1, -0.13);
        // Shutter slats: three ribs are enough to kill the flat-panel read.
        for (let i = 1; i <= 3; i += 1) {
          const y = hole.y0 + ((hole.y1 - hole.y0) * i) / 4;
          sideBox(b.w, 'metalLight', side, hole.along - hole.half + 0.06, hole.along + hole.half - 0.06, y - 0.035, y + 0.035, -0.14, -0.08, SF.FRONT | SF.TOP | SF.BOTTOM);
        }
        sideBox(b.w, 'metalLight', side, hole.along - hole.half - 0.12, hole.along + hole.half + 0.12, hole.y1, hole.y1 + 0.36, 0.02, 0.34, SF.BAND);
        sideBox(b.w, b.palette.trim, side, hole.along - hole.half - 0.3, hole.along + hole.half + 0.3, hole.y1 + 0.4, hole.y1 + 0.52, 0.02, 0.62, SF.BAND);
      } else {
        windowInsert(b.w, side, hole, 0.07, { ...b.glazing, reveal: 0.12, lining: b.palette.base });
      }
    }
    // Base band cap.
    sideBox(b.w, b.palette.trim, side, side.start, side.end, baseTop, baseTop + 0.16, -0.02, 0.11, SF.BAND);
    // Tilt-up panel joints: the vertical lines that give a long blank wall a
    // measurable module and therefore a sense of scale.
    const joints = Math.max(1, Math.min(8, Math.round(span / 7)));
    for (let i = 1; i < joints; i += 1) {
      const at = side.start + (span * i) / joints;
      sideBox(b.w, b.palette.trim, side, at - 0.07, at + 0.07, b.groundY + 0.1, baseTop, 0.05, 0.13, SF.FRONT | SF.START | SF.END);
    }

    // Corrugated upper with a clerestory strip.
    const strip = openingAt((side.start + side.end) * 0.5, Math.max(1, span - 1.6), clerestory0, clerestory1);
    const upper = clerestory1 > clerestory0 + 0.4 ? [strip] : [];
    punchedPanel(b.w, b.palette.wall, side, side.start, side.end, baseTop + 0.16, b.roofY, 0, upper);
    if (upper.length > 0) {
      revealFor(b.w, b.palette.wall, side, strip, 0, 0.14);
      sideQuad(b.w, 'glassDark', side, strip.along - strip.half, strip.along + strip.half, strip.y0, strip.y1, -0.14);
      const bays = Math.max(1, Math.min(14, Math.round(span / 2.6)));
      for (let i = 1; i < bays; i += 1) {
        const at = strip.along - strip.half + ((strip.half * 2) * i) / bays;
        sideQuad(b.w, 'windowFrame', side, at - 0.05, at + 0.05, strip.y0, strip.y1, -0.12);
      }
    }
    // Sheeting ribs. Corrugated cladding is the only thing holding these walls
    // up visually, so the ribs earn their triangles.
    const ribs = Math.max(2, Math.min(12, Math.round(span / 3.4)));
    for (let i = 1; i < ribs; i += 1) {
      const at = side.start + (span * i) / ribs;
      sideBox(b.w, 'metalLight', side, at - 0.055, at + 0.055, baseTop + 0.18, b.roofY - 0.06, -0.01, 0.05, SF.FRONT | SF.START | SF.END);
    }
    // Rust streaking below the sheeting fixings, on one wall only.
    if (facing === opposite(b.parcel.facing) && b.rng.chance(0.55)) {
      sideBox(b.w, 'rust', side, side.start, side.end, baseTop + 0.16, baseTop + 0.44, -0.01, 0.03, SF.BAND);
    }
  }

  emitExternalStair(b);
  emitDownpipes(b);

  // Roof: a north-light sawtooth, or a shallow gable on the smaller sheds.
  const eave = b.roofY;
  if (b.depth > 14 && b.rng.chance(0.62)) {
    b.w.box(b.palette.trim, b.rect.minX - 0.12, eave - 0.22, b.rect.minZ - 0.12, b.rect.maxX + 0.12, eave, b.rect.maxZ + 0.12, FACE.ALL);
    sawtoothRoof(b.w, b.rect, eave, sawtoothTeeth(b.depth), Math.min(1.7, MAX_ABOVE_ROOF - 0.4), b.palette.roof, 'glass');
  } else {
    b.w.box(b.palette.trim, b.rect.minX - 0.12, eave - 0.22, b.rect.minZ - 0.12, b.rect.maxX + 0.12, eave, b.rect.maxZ + 0.12, FACE.ALL);
    gableRoof(b.w, b.rect, eave, Math.min(1.5, b.depth * 0.09), b.width >= b.depth ? 'x' : 'z', b.palette.roof, b.palette.trim, b.palette.wall, 0.3);
  }
  roofClutter(b.sink, b.rng, insetRect(b.rect, 1.5), b.roofY + 0.3, b.rng.int(2, 4), 1.0);
}

/** An external steel stair up the flank of a shed. */
function emitExternalStair(b: Building): void {
  const facing = b.parcel.facing === 'north' || b.parcel.facing === 'south' ? 'west' : 'north';
  const side = b.sides.get(facing);
  if (!side) return;
  const span = sideSpan(side);
  if (span < 6) return;
  const key = b.palette.metal;
  const a0 = side.start + span * 0.62;
  const a1 = Math.min(side.end - 0.5, a0 + 3.4);
  if (a1 - a0 < 2) return;
  const top = Math.min(b.roofY - 0.4, b.groundY + 5.6);
  if (top < b.groundY + 1.8) return;
  const out = 0.76;

  const low = sidePoint(side, a0, b.groundY + 0.1, out * 0.85);
  const high = sidePoint(side, a1, top, out * 0.85);
  const lowIn = sidePoint(side, a0, b.groundY + 0.1, 0.1);
  const highIn = sidePoint(side, a1, top, 0.1);
  b.w.quadFacing(key, low, high, highIn, lowIn, [0, 1, 0]);
  b.w.quadFacing(key, lowIn, highIn, high, low, [0, -1, 0]);
  sideBox(b.w, key, side, a1 - 0.1, Math.min(side.end - 0.2, a1 + 1.5), top, top + 0.1, 0, out, SF.BAND);
  balustrade(b.w, key, side, a1 - 0.1, Math.min(side.end - 0.2, a1 + 1.5), top + 0.1, out, 0.95, 3);
}

function buildMarketHall(b: Building): void {
  const height = b.roofY - b.groundY;
  const arch0 = b.groundY + 0.35;
  const arch1 = b.groundY + Math.min(height * 0.62, 6.4);
  const clerestory0 = b.roofY - Math.min(2.4, height * 0.24);

  for (const facing of ALL_FACINGS) {
    const side = b.sides.get(facing);
    if (!side) continue;
    const isFront = facing === b.parcel.facing;
    const span = sideSpan(side);
    const openings: Opening[] = [];
    for (const centre of rhythm(span, b.spec.module, 1.4, 8)) {
      const along = side.start + centre;
      if (isFront && Math.abs(along - b.doorAlong) < b.door.width) continue;
      openings.push(openingAt(along, Math.min(3.1, span / 6), arch0, arch1));
    }
    if (isFront) openings.push(openingAt(b.doorAlong, b.door.width, b.groundY, b.groundY + b.door.height));

    const strip = openingAt((side.start + side.end) * 0.5, Math.max(1, span - 2.6), clerestory0, b.roofY - 0.85);
    const all = strip.y1 > strip.y0 + 0.4 ? [...openings, strip] : openings;
    punchedPanel(b.w, b.palette.wall, side, side.start, side.end, b.groundY, b.roofY, 0, all);

    for (const hole of openings) {
      if (isFront && Math.abs(hole.along - b.doorAlong) < 0.01) {
        emitDoorway(b, side, hole);
        continue;
      }
      revealFor(b.w, b.palette.trim, side, hole, 0, b.spec.reveal);
      // A stepped head stands in for a real arch at a fraction of the cost.
      for (let i = 0; i < 3; i += 1) {
        const shrink = hole.half * (0.06 + i * 0.05);
        sideBox(b.w, b.palette.trim, side, hole.along - hole.half + shrink, hole.along + hole.half - shrink, hole.y1 - 0.16 * (i + 1), hole.y1 - 0.16 * i, -0.02, 0.12 - i * 0.03, SF.BAND);
      }
      sideQuad(b.w, 'windowFrame', side, hole.along - hole.half, hole.along + hole.half, hole.y0, hole.y0 + 0.12, -b.spec.reveal);
      sideQuad(b.w, 'windowFrame', side, hole.along - 0.06, hole.along + 0.06, hole.y0, hole.y1 - 0.48, -b.spec.reveal);
      sideQuad(b.w, 'glassShop', side, hole.along - hole.half, hole.along + hole.half, hole.y0 + 0.12, hole.y1 - 0.48, -b.spec.reveal - 0.03);
    }
    if (all.length > openings.length) {
      revealFor(b.w, b.palette.wall, side, strip, 0, 0.16);
      sideQuad(b.w, 'glassDark', side, strip.along - strip.half, strip.along + strip.half, strip.y0, strip.y1, -0.16);
      const bays = Math.max(2, Math.min(12, Math.round(span / 3)));
      for (let i = 1; i < bays; i += 1) {
        const at = strip.along - strip.half + ((strip.half * 2) * i) / bays;
        sideQuad(b.w, 'windowFrame', side, at - 0.06, at + 0.06, strip.y0, strip.y1, -0.14);
      }
    }
    // Piers between the bays, so the wall reads as an arcade.
    for (const centre of rhythm(span, b.spec.module, 1.4, 8)) {
      const at = side.start + centre - b.spec.module * 0.5;
      if (at < side.start + 0.5 || at > side.end - 0.5) continue;
      sideBox(b.w, b.palette.trim, side, at - 0.34, at + 0.34, b.groundY, clerestory0 - 0.2, -0.02, 0.14, SF.BAND);
    }
  }

  corniceStack(b.w, b.rect, b.roofY - 0.35, [
    { height: 0.2, proud: 0.16, key: b.palette.trim },
    { height: 0.24, proud: 0.3, key: b.palette.trim },
  ]);
  const pitch = Math.min(1.1, b.depth * 0.05);
  gableRoof(b.w, b.rect, b.roofY + 0.09, pitch, b.width >= b.depth ? 'x' : 'z', b.palette.roof, b.palette.trim, b.palette.wall, 0.28);
  roofLantern(b.w, b.rect, b.roofY + pitch * 0.55, Math.min(3.4, b.width * 0.22), Math.min(1.2, MAX_ABOVE_ROOF - pitch - 0.5), 'glass', b.palette.metal);
  roofClutter(b.sink, b.rng, insetRect(b.rect, 3.0), b.roofY + 0.4, b.rng.int(2, 3), 1.0);
  emitDownpipes(b);
}

// ---------------------------------------------------------------------------
// Entrance approach: threshold, steps, sign, light, interaction
// ---------------------------------------------------------------------------

function emitApproach(b: Building): void {
  const front = b.sides.get(b.parcel.facing);
  if (!front) return;

  const rise = b.groundY - b.outsideY;
  const width = Math.min(
    b.parcel.archetype === 'civicStone' ? 7.2 : b.door.width + 1.15,
    sideSpan(front) - 0.4,
  );
  const a0 = clamp(b.doorAlong - width * 0.5, front.start + 0.1, front.end - width - 0.1);
  const a1 = a0 + width;

  const foot = Math.max(b.baseY + 0.02, b.outsideY - 0.35);

  if (rise > 0.22) {
    // Risers stay under the 0.45 m the controller can climb, and the whole
    // flight stays inside the oversail allowance so it never blocks a pavement.
    const steps = Math.max(1, Math.min(5, Math.ceil(rise / 0.235)));
    const going = Math.min(0.3, (MAX_OVERSAIL - 0.02) / steps);
    for (let i = 0; i < steps; i += 1) {
      const treadTop = b.outsideY + (rise * (i + 1)) / steps;
      const out = (steps - i) * going;
      sideBox(b.w, b.palette.base, front, a0, a1, foot, treadTop, 0, out, SF.FRONT | SF.TOP | SF.START | SF.END);
      b.sink.collider({ ...worldFootprint(front, a0, a1, 0, out), bottom: foot, top: treadTop, solid: false });
    }
    // Cheek walls give the stoop sides rather than leaving a floating slab,
    // and a handrail over each turns it into somewhere you would actually walk.
    if (b.parcel.archetype !== 'civicStone' && rise > 0.5) {
      const run = steps * going;
      for (const [c0, c1] of [
        [a0 - 0.16, a0],
        [a1, a1 + 0.16],
      ] as const) {
        sideBox(b.w, b.palette.trim, front, c0, c1, foot, b.groundY + 0.5, 0, run, SF.NO_BACK);
        const rail = b.groundY + 1.36;
        sideBox(b.w, b.palette.metal, front, c0 + 0.03, c1 - 0.03, rail - 0.05, rail, 0.06, run, SF.ALL);
        sideBox(b.w, b.palette.metal, front, c0 + 0.04, c1 - 0.04, b.groundY + 0.5, rail, run - 0.07, run, SF.ALL);
        sideBox(b.w, b.palette.metal, front, c0 + 0.04, c1 - 0.04, b.groundY + 0.5, rail, 0.06, 0.13, SF.ALL);
      }
    }
  } else {
    const out = 0.34;
    sideBox(b.w, b.palette.base, front, a0, a1, foot, b.groundY, 0, out, SF.FRONT | SF.TOP | SF.START | SF.END);
    b.sink.collider({ ...worldFootprint(front, a0, a1, 0, out), bottom: foot, top: b.groundY, solid: false });
  }

  // A hood over the door on the types that would have one.
  if (b.parcel.archetype === 'terraceHouse' || b.parcel.archetype === 'brickWalkup' || b.parcel.archetype === 'apartmentSlab') {
    const y = b.groundY + b.door.height + 0.28;
    const hw = b.door.width * 0.5 + 0.45;
    sideBox(b.w, b.palette.trim, front, b.doorAlong - hw, b.doorAlong + hw, y, y + 0.15, -0.02, 0.62, SF.BAND);
    const axis = sideAlongAxis(front);
    for (const at of [b.doorAlong - hw + 0.12, b.doorAlong + hw - 0.12]) {
      const sign = at < b.doorAlong ? -1 : 1;
      b.w.triFacing(
        b.palette.trim,
        sidePoint(front, at, y, 0.02),
        sidePoint(front, at, y, 0.6),
        sidePoint(front, at, y - 0.5, 0.02),
        [axis[0] * sign, 0, axis[2] * sign],
      );
      // A cottage porch stands on posts rather than brackets.
      if (b.parcel.archetype === 'terraceHouse') {
        const post = sidePoint(front, at, 0, 0.48);
        b.w.tube(b.palette.trim, post[0], post[2], b.groundY, y, 0.06, 6);
      }
    }
  }

  // A projecting blade sign over the entrance.
  if (b.variant.bladeSign && SIGNED.has(b.parcel.archetype)) {
    const y = b.groundY + b.groundStoreyHeight + 0.25;
    const top = Math.min(y + 1.9, b.roofY - 0.4);
    if (top > y + 0.7) {
      sideBox(b.w, b.variant.signKey, front, b.doorAlong - 0.07, b.doorAlong + 0.07, y, top, 0.16, 0.78, SF.NO_BACK);
      sideBox(b.w, b.palette.metal, front, b.doorAlong - 0.05, b.doorAlong + 0.05, top - 0.12, top, 0, 0.2, SF.NO_BACK);
    }
  }

  // One warm light per lit shopfront, and only on a quarter of them.
  if (COMMERCIAL.has(b.parcel.archetype) && b.rng.chance(0.25)) {
    const at = sidePoint(front, b.doorAlong, b.groundY + Math.min(2.9, b.groundStoreyHeight - 0.6), 0.7);
    b.sink.light({ x: at[0], y: at[1], z: at[2], color: 0xffb877, intensity: 1.2, distance: 9, priority: 2 });
  }

  if (b.parcel.enterable) {
    const approach = doorApproach(b.door, 1.5);
    const landing = doorLanding(b.door, 1.8);
    b.sink.interaction({
      id: `door-${b.parcel.id}`,
      x: approach.x,
      y: b.outsideY,
      z: approach.z,
      // Wide enough to cover the whole approach: the point sits 1.5 m out from
      // the door, so this reaches from the threshold itself to about 4 m back
      // down the pavement. It used to be 1.9, which - with the facing test
      // taken against this point rather than the door - left a usable band
      // barely two metres deep that switched off as the player arrived.
      radius: 2.8,
      prompt: 'Press E to enter',
      kind: 'door',
      // Heading matches the camera convention: forward is (-sin y, 0, -cos y),
      // so this looks straight into the building.
      target: { x: landing.x, y: b.groundY, z: landing.z, heading: Math.atan2(b.door.normalX, b.door.normalZ) },
      parcelId: b.parcel.id,
    });
  }
}

/** World-space X/Z bounds of a rectangle described in a side's frame. */
function worldFootprint(
  side: Side,
  a0: number,
  a1: number,
  out0: number,
  out1: number,
): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const p0 = side.plane + side.outward * out0;
  const p1 = side.plane + side.outward * out1;
  if (side.runAxis === 'x') {
    return { minX: Math.min(a0, a1), maxX: Math.max(a0, a1), minZ: Math.min(p0, p1), maxZ: Math.max(p0, p1) };
  }
  return { minX: Math.min(p0, p1), maxX: Math.max(p0, p1), minZ: Math.min(a0, a1), maxZ: Math.max(a0, a1) };
}

// ---------------------------------------------------------------------------
// Colliders
// ---------------------------------------------------------------------------

/**
 * The main mass. It brackets everything the building emitted vertically, so a
 * parapet or a pitched roof is solid rather than something the player could
 * clip through from a neighbouring rooftop.
 */
function emitMainCollider(b: Building): void {
  const box: ColliderBox = {
    minX: b.rect.minX - b.plinthProud,
    maxX: b.rect.maxX + b.plinthProud,
    minZ: b.rect.minZ - b.plinthProud,
    maxZ: b.rect.maxZ + b.plinthProud,
    bottom: Math.min(b.baseY, b.w.minY),
    top: Math.max(b.roofY, b.w.maxY),
    solid: true,
  };
  b.sink.collider(box);
}
