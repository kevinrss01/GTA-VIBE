/**
 * The authored plan of Meridian Bay.
 *
 * This module is the single source of truth for where everything in the city
 * is. Geometry builders, the minimap, the audio director, the placement
 * validator and the tests all read the same plan, so nothing can drift out of
 * agreement with anything else. It contains no Three.js code at all and is
 * therefore fully unit-testable without a renderer.
 *
 * The layout is a deliberately irregular grid rather than a procedural lattice:
 * street spacing, widths and block depths all vary, two streets are cut short
 * to make room for a park, and one is suppressed to merge the cannery blocks.
 * That irregularity is what stops the result reading as a generated chessboard.
 */

import { createRng, type Rng } from '../core/rng';
import { clamp, rectCenter, rectDepth, rectWidth, type Rect, type Vec2 } from '../core/mathx';
import { landElevation } from './elevation';

export const CITY_SEED = 'meridian-bay-01';

/** Height of a standard kerb. Pavements sit this far above the carriageway. */
export const KERB_HEIGHT = 0.15;

export type DistrictId =
  | 'harbourside'
  | 'cannery'
  | 'oldQuarter'
  | 'core'
  | 'civic'
  | 'ridge';

export type StreetKind = 'promenade' | 'arterial' | 'secondary' | 'service';

/** Which world direction a building's front elevation faces. */
export type Facing = 'north' | 'south' | 'east' | 'west';

export interface Street {
  readonly id: string;
  readonly name: string;
  readonly kind: StreetKind;
  /** `'x'` means the street runs north-south at a constant x. */
  readonly axis: 'x' | 'z';
  /** The constant coordinate of the centreline. */
  readonly position: number;
  /** Extent along the running axis. */
  readonly from: number;
  readonly to: number;
  /** Half the carriageway width. */
  readonly roadHalf: number;
  /** Pavement width on each side, measured out from the carriageway edge. */
  readonly sidewalk: number;
  readonly lanes: number;
  /** Promenade decking instead of paving slabs. */
  readonly boardwalk: boolean;
}

export interface Alley {
  readonly rect: Rect;
  /** The side of the block the alley opens onto. */
  readonly openings: readonly Facing[];
}

export type BlockKind = 'buildings' | 'park' | 'plaza';

/** Pavement height at each corner of a block; the datum for its interior. */
export interface CornerLevels {
  readonly nw: number;
  readonly ne: number;
  readonly sw: number;
  readonly se: number;
}

export interface CityBlock {
  readonly id: string;
  readonly district: DistrictId;
  readonly kind: BlockKind;
  /** Buildable area: the block between the pavements on every side. */
  readonly rect: Rect;
  readonly corners: CornerLevels;
  /** Representative height at the block centre. For labels and the minimap. */
  readonly padElevation: number;
  readonly alley: Alley | null;
  readonly column: number;
  readonly row: number;
}

/**
 * Height of a block's interior surface.
 *
 * Block interiors - courtyards, alleys, the park, the plaza - sit one kerb
 * above the continuous terrain, exactly like the pavements that surround them.
 * Nothing is flattened, so a block can never disagree with the kerb it meets.
 * The `block` argument is accepted for symmetry with the rest of the API and
 * because a future block type may want its own treatment.
 */
export function blockSurfaceY(_block: CityBlock, x: number, z: number): number {
  return landElevation(x, z) + KERB_HEIGHT;
}

export type ArchetypeId =
  | 'harbourRow'
  | 'warehouse'
  | 'oldTenement'
  | 'brickWalkup'
  | 'midriseOffice'
  | 'glassTower'
  | 'civicStone'
  | 'terraceHouse'
  | 'apartmentSlab'
  | 'marketHall';

export interface Parcel {
  readonly id: string;
  readonly blockId: string;
  readonly district: DistrictId;
  readonly archetype: ArchetypeId;
  /** Building footprint in world space. */
  readonly rect: Rect;
  readonly facing: Facing;
  readonly frontStreetId: string;
  /** Finished floor level: the top of the plinth, one step above the pavement. */
  readonly groundY: number;
  /** Lowest ground under the footprint; the plinth is carried down past this. */
  readonly baseY: number;
  readonly storeys: number;
  readonly storeyHeight: number;
  /** Extra height for a ground floor with a shopfront. */
  readonly groundStoreyHeight: number;
  readonly enterable: boolean;
  readonly interiorKind: InteriorKind | null;
  /** Deterministic per-building variation seed. */
  readonly seed: number;
}

export type InteriorKind =
  | 'cafe'
  | 'store'
  | 'gunStore'
  | 'marketHall'
  | 'lobby'
  | 'workshop'
  | 'stairhall';

export interface Landmark {
  readonly id: string;
  readonly name: string;
  readonly kind: 'lighthouse' | 'clockTower' | 'fountain' | 'ferryTerminal' | 'watertower';
  readonly x: number;
  readonly z: number;
  readonly y: number;
}

export interface CityPlan {
  readonly seed: string;
  readonly streets: readonly Street[];
  readonly blocks: readonly CityBlock[];
  readonly parcels: readonly Parcel[];
  readonly landmarks: readonly Landmark[];
  /** Closed pedestrian route around the city, along the outer pavements. */
  readonly circuit: readonly Vec2[];
  readonly circuitLength: number;
  readonly spawn: { x: number; z: number; heading: number };
  readonly xLines: readonly Street[];
  readonly zLines: readonly Street[];
}

// ---------------------------------------------------------------------------
// Street grid
// ---------------------------------------------------------------------------

const NORTH_EDGE = -152;
const SOUTH_EDGE = 132;
const WEST_EDGE = -160;
const EAST_EDGE = 164;

/** North-south streets, west to east. */
const X_LINES: readonly Street[] = [
  {
    id: 'harbour-walk',
    name: 'Harbour Walk',
    kind: 'promenade',
    axis: 'x',
    position: WEST_EDGE,
    from: NORTH_EDGE,
    to: SOUTH_EDGE,
    roadHalf: 5.5,
    sidewalk: 6.5,
    lanes: 2,
    boardwalk: true,
  },
  {
    id: 'dock-street',
    name: 'Dock Street',
    kind: 'secondary',
    axis: 'x',
    position: -118,
    from: NORTH_EDGE,
    to: SOUTH_EDGE,
    roadHalf: 5.5,
    sidewalk: 3.0,
    lanes: 2,
    boardwalk: false,
  },
  {
    id: 'cannery-row',
    name: 'Cannery Row',
    kind: 'secondary',
    axis: 'x',
    position: -74,
    from: NORTH_EDGE,
    // Stops at Anchor Street: the two southern cannery blocks are merged.
    to: 76,
    roadHalf: 6.5,
    sidewalk: 3.2,
    lanes: 2,
    boardwalk: false,
  },
  {
    id: 'meridian-avenue',
    name: 'Meridian Avenue',
    kind: 'arterial',
    axis: 'x',
    position: -28,
    from: NORTH_EDGE,
    to: SOUTH_EDGE,
    roadHalf: 8,
    sidewalk: 5.0,
    lanes: 4,
    boardwalk: false,
  },
  {
    id: 'salt-lane',
    name: 'Salt Lane',
    kind: 'secondary',
    axis: 'x',
    position: 22,
    from: NORTH_EDGE,
    to: SOUTH_EDGE,
    roadHalf: 5.0,
    sidewalk: 2.8,
    lanes: 2,
    boardwalk: false,
  },
  {
    id: 'ferro-street',
    name: 'Ferro Street',
    kind: 'secondary',
    axis: 'x',
    position: 68,
    from: NORTH_EDGE,
    to: SOUTH_EDGE,
    roadHalf: 6.5,
    sidewalk: 3.2,
    lanes: 2,
    boardwalk: false,
  },
  {
    id: 'ridge-road',
    name: 'Ridge Road',
    kind: 'secondary',
    axis: 'x',
    position: 118,
    from: NORTH_EDGE,
    to: SOUTH_EDGE,
    roadHalf: 7.0,
    sidewalk: 3.5,
    lanes: 2,
    boardwalk: false,
  },
  {
    id: 'east-circuit',
    name: 'East Circuit',
    kind: 'secondary',
    axis: 'x',
    position: EAST_EDGE,
    from: NORTH_EDGE,
    to: SOUTH_EDGE,
    roadHalf: 7.5,
    sidewalk: 3.5,
    lanes: 2,
    boardwalk: false,
  },
];

/** East-west streets, north to south. */
const Z_LINES: readonly Street[] = [
  {
    id: 'north-circuit',
    name: 'North Circuit',
    kind: 'secondary',
    axis: 'z',
    position: NORTH_EDGE,
    from: WEST_EDGE,
    to: EAST_EDGE,
    roadHalf: 7.5,
    sidewalk: 3.5,
    lanes: 2,
    boardwalk: false,
  },
  {
    id: 'lantern-street',
    name: 'Lantern Street',
    kind: 'secondary',
    axis: 'z',
    position: -108,
    from: WEST_EDGE,
    to: EAST_EDGE,
    roadHalf: 5.5,
    sidewalk: 3.2,
    lanes: 2,
    boardwalk: false,
  },
  {
    id: 'grand-concourse',
    name: 'Grand Concourse',
    kind: 'arterial',
    axis: 'z',
    position: -62,
    from: WEST_EDGE,
    to: EAST_EDGE,
    roadHalf: 11,
    sidewalk: 5.0,
    lanes: 4,
    boardwalk: false,
  },
  {
    id: 'cooper-street',
    name: 'Cooper Street',
    kind: 'secondary',
    axis: 'z',
    position: -18,
    from: WEST_EDGE,
    // Terminates at Ferro Street; Lantern Park occupies the ground east of it.
    to: 68,
    roadHalf: 5.0,
    sidewalk: 2.8,
    lanes: 2,
    boardwalk: false,
  },
  {
    id: 'cooper-street-east',
    name: 'Cooper Street East',
    kind: 'secondary',
    axis: 'z',
    position: -18,
    from: 118,
    to: EAST_EDGE,
    roadHalf: 5.0,
    sidewalk: 2.8,
    lanes: 2,
    boardwalk: false,
  },
  {
    id: 'vestry-street',
    name: 'Vestry Street',
    kind: 'secondary',
    axis: 'z',
    position: 28,
    from: WEST_EDGE,
    to: EAST_EDGE,
    roadHalf: 5.5,
    sidewalk: 3.0,
    lanes: 2,
    boardwalk: false,
  },
  {
    id: 'anchor-street',
    name: 'Anchor Street',
    kind: 'secondary',
    axis: 'z',
    position: 76,
    from: WEST_EDGE,
    to: EAST_EDGE,
    roadHalf: 6.5,
    sidewalk: 3.2,
    lanes: 2,
    boardwalk: false,
  },
  {
    id: 'south-circuit',
    name: 'South Circuit',
    kind: 'secondary',
    axis: 'z',
    position: SOUTH_EDGE,
    from: WEST_EDGE,
    to: EAST_EDGE,
    roadHalf: 7.5,
    sidewalk: 3.5,
    lanes: 2,
    boardwalk: false,
  },
];

/** Distance from a street centreline to the outer edge of its pavement. */
export function corridorHalfWidth(street: Street): number {
  return street.roadHalf + street.sidewalk;
}

// Grid columns and rows used to lay out blocks. `cooper-street-east` shares its
// position with `cooper-street`, so only the primary lines define the grid.
const GRID_X = X_LINES;
const GRID_Z = Z_LINES.filter((s) => s.id !== 'cooper-street-east');

const DISTRICT_GRID: readonly (readonly DistrictId[])[] = [
  // c0            c1            c2            c3            c4            c5         c6
  ['harbourside', 'core', 'core', 'core', 'core', 'ridge', 'ridge'], // r0
  ['harbourside', 'oldQuarter', 'core', 'core', 'core', 'ridge', 'ridge'], // r1
  ['harbourside', 'oldQuarter', 'oldQuarter', 'core', 'core', 'civic', 'ridge'], // r2
  ['harbourside', 'oldQuarter', 'oldQuarter', 'oldQuarter', 'civic', 'civic', 'ridge'], // r3
  ['harbourside', 'cannery', 'cannery', 'oldQuarter', 'civic', 'civic', 'civic'], // r4
  ['harbourside', 'cannery', 'cannery', 'cannery', 'oldQuarter', 'civic', 'civic'], // r5
];

/** Blocks that are not built on. */
const SPECIAL_BLOCKS: Readonly<Record<string, BlockKind>> = {
  // Lantern Park spans two rows because Cooper Street stops short of it.
  'block-5-2': 'park',
  'block-5-3': 'park',
  // Meridian Plaza, at the city's main crossroads.
  'block-3-2': 'plaza',
};

// ---------------------------------------------------------------------------
// Archetypes
// ---------------------------------------------------------------------------

interface ArchetypeSpec {
  readonly storeys: readonly [number, number];
  readonly storeyHeight: readonly [number, number];
  readonly groundStoreyHeight: readonly [number, number];
  /** Preferred street frontage width for one building. */
  readonly frontage: readonly [number, number];
  readonly minDepth: number;
  readonly maxDepth: number;
}

export const ARCHETYPES: Readonly<Record<ArchetypeId, ArchetypeSpec>> = {
  harbourRow: {
    storeys: [2, 4],
    storeyHeight: [3.1, 3.5],
    groundStoreyHeight: [3.8, 4.4],
    frontage: [8, 15],
    minDepth: 9,
    maxDepth: 15,
  },
  warehouse: {
    storeys: [1, 2],
    storeyHeight: [5.2, 6.4],
    groundStoreyHeight: [5.6, 7.0],
    frontage: [22, 46],
    minDepth: 16,
    maxDepth: 34,
  },
  oldTenement: {
    storeys: [4, 6],
    storeyHeight: [3.2, 3.6],
    groundStoreyHeight: [4.0, 4.6],
    frontage: [9, 16],
    minDepth: 10,
    maxDepth: 15,
  },
  brickWalkup: {
    storeys: [3, 5],
    storeyHeight: [3.0, 3.4],
    groundStoreyHeight: [3.6, 4.2],
    frontage: [10, 18],
    minDepth: 10,
    maxDepth: 15,
  },
  midriseOffice: {
    storeys: [7, 13],
    storeyHeight: [3.5, 3.9],
    groundStoreyHeight: [4.8, 6.0],
    frontage: [16, 28],
    minDepth: 13,
    maxDepth: 22,
  },
  glassTower: {
    storeys: [13, 21],
    storeyHeight: [3.6, 4.0],
    groundStoreyHeight: [5.5, 7.0],
    frontage: [17, 26],
    minDepth: 15,
    maxDepth: 24,
  },
  civicStone: {
    storeys: [3, 5],
    storeyHeight: [4.4, 5.2],
    groundStoreyHeight: [5.4, 6.4],
    frontage: [24, 42],
    minDepth: 14,
    maxDepth: 24,
  },
  terraceHouse: {
    storeys: [2, 3],
    storeyHeight: [2.9, 3.2],
    groundStoreyHeight: [3.1, 3.5],
    frontage: [7, 12],
    minDepth: 9,
    maxDepth: 13,
  },
  apartmentSlab: {
    storeys: [6, 9],
    storeyHeight: [3.0, 3.3],
    groundStoreyHeight: [3.8, 4.4],
    frontage: [18, 32],
    minDepth: 12,
    maxDepth: 17,
  },
  marketHall: {
    storeys: [1, 1],
    storeyHeight: [9.5, 11.5],
    groundStoreyHeight: [9.5, 11.5],
    frontage: [26, 40],
    minDepth: 18,
    maxDepth: 28,
  },
};

const DISTRICT_ARCHETYPES: Readonly<
  Record<DistrictId, { readonly ids: readonly ArchetypeId[]; readonly weights: readonly number[] }>
> = {
  harbourside: { ids: ['harbourRow', 'oldTenement', 'warehouse'], weights: [7, 3, 1] },
  cannery: { ids: ['warehouse', 'brickWalkup', 'marketHall'], weights: [7, 3, 1] },
  oldQuarter: { ids: ['oldTenement', 'brickWalkup', 'harbourRow'], weights: [6, 4, 2] },
  core: { ids: ['midriseOffice', 'glassTower', 'brickWalkup', 'civicStone'], weights: [6, 3, 2, 1] },
  civic: { ids: ['civicStone', 'midriseOffice', 'marketHall', 'brickWalkup'], weights: [3, 3, 1, 3] },
  ridge: { ids: ['terraceHouse', 'apartmentSlab', 'brickWalkup'], weights: [6, 3, 2] },
};

// ---------------------------------------------------------------------------
// Plan construction
// ---------------------------------------------------------------------------

function blockRect(column: number, row: number): Rect {
  const west = GRID_X[column] as Street;
  const east = GRID_X[column + 1] as Street;
  const north = GRID_Z[row] as Street;
  const south = GRID_Z[row + 1] as Street;
  return {
    minX: west.position + corridorHalfWidth(west),
    maxX: east.position - corridorHalfWidth(east),
    minZ: north.position + corridorHalfWidth(north),
    maxZ: south.position - corridorHalfWidth(south),
  };
}

/** Blocks whose dividing street was suppressed get merged into their neighbour. */
function isMergedAway(column: number, row: number): boolean {
  // Cannery Row stops at Anchor Street, so column 2 row 5 joins column 1 row 5.
  return column === 2 && row === 5;
}

function mergedRect(column: number, row: number): Rect {
  const rect = blockRect(column, row);
  if (column === 1 && row === 5) {
    const eastNeighbour = blockRect(2, 5);
    return { ...rect, maxX: eastNeighbour.maxX };
  }
  if (column === 5 && row === 2) {
    // Lantern Park runs across the missing stretch of Cooper Street.
    const southNeighbour = blockRect(5, 3);
    return { ...rect, maxZ: southNeighbour.maxZ };
  }
  return rect;
}

function blockCornerLevels(rect: Rect): CornerLevels {
  return {
    nw: landElevation(rect.minX, rect.minZ) + KERB_HEIGHT,
    ne: landElevation(rect.maxX, rect.minZ) + KERB_HEIGHT,
    sw: landElevation(rect.minX, rect.maxZ) + KERB_HEIGHT,
    se: landElevation(rect.maxX, rect.maxZ) + KERB_HEIGHT,
  };
}

function buildBlocks(rng: Rng): CityBlock[] {
  const blocks: CityBlock[] = [];
  for (let row = 0; row < GRID_Z.length - 1; row += 1) {
    for (let column = 0; column < GRID_X.length - 1; column += 1) {
      if (isMergedAway(column, row)) continue;
      // Lantern Park's southern half is absorbed by its northern half.
      if (column === 5 && row === 3) continue;

      const id = `block-${column}-${row}`;
      const rect = mergedRect(column, row);
      const kind = SPECIAL_BLOCKS[id] ?? 'buildings';
      const district = (DISTRICT_GRID[row]?.[column] ?? 'oldQuarter') as DistrictId;
      const corners = blockCornerLevels(rect);

      blocks.push({
        id,
        district,
        kind,
        rect,
        corners,
        padElevation: (corners.nw + corners.ne + corners.sw + corners.se) / 4,
        alley: kind === 'buildings' ? planAlley(rect, rng) : null,
        column,
        row,
      });
    }
  }
  return blocks;
}

/**
 * Larger blocks get a service alley cut straight through them, open at both
 * ends so it is a real route rather than a decorative recess.
 */
function planAlley(rect: Rect, rng: Rng): Alley | null {
  const w = rectWidth(rect);
  const d = rectDepth(rect);
  if (w < 26 && d < 26) return null;
  if (!rng.chance(0.62)) return null;

  const alleyWidth = rng.range(3.4, 5.0);
  if (d >= w) {
    // Runs north-south, opening onto the streets at both ends of the block.
    const centreX = (rect.minX + rect.maxX) * 0.5 + rng.range(-2.5, 2.5);
    return {
      rect: {
        minX: centreX - alleyWidth * 0.5,
        maxX: centreX + alleyWidth * 0.5,
        minZ: rect.minZ,
        maxZ: rect.maxZ,
      },
      openings: ['north', 'south'],
    };
  }
  const centreZ = (rect.minZ + rect.maxZ) * 0.5 + rng.range(-2.5, 2.5);
  return {
    rect: {
      minX: rect.minX,
      maxX: rect.maxX,
      minZ: centreZ - alleyWidth * 0.5,
      maxZ: centreZ + alleyWidth * 0.5,
    },
    openings: ['east', 'west'],
  };
}

/**
 * Removes the alley from a set of footprints, splitting any building the alley
 * passes through into the two halves left either side of it.
 */
function carveAlley(drafts: readonly ParcelDraft[], alley: Alley | null): ParcelDraft[] {
  if (!alley) return drafts.slice();
  const out: ParcelDraft[] = [];
  const a = alley.rect;
  const runsNorthSouth = a.maxZ - a.minZ > a.maxX - a.minX;

  for (const draft of drafts) {
    const r = draft.rect;
    const intersects = r.minX < a.maxX && a.minX < r.maxX && r.minZ < a.maxZ && a.minZ < r.maxZ;
    if (!intersects) {
      out.push(draft);
      continue;
    }
    if (runsNorthSouth) {
      if (a.minX - r.minX > 5.5) {
        out.push({ ...draft, rect: { ...r, maxX: a.minX } });
      }
      if (r.maxX - a.maxX > 5.5) {
        out.push({ ...draft, rect: { ...r, minX: a.maxX } });
      }
    } else {
      if (a.minZ - r.minZ > 5.5) {
        out.push({ ...draft, rect: { ...r, maxZ: a.minZ } });
      }
      if (r.maxZ - a.maxZ > 5.5) {
        out.push({ ...draft, rect: { ...r, minZ: a.maxZ } });
      }
    }
  }
  return out;
}

/** Splits a run into lots of varying width, never leaving a sliver at the end. */
function splitRun(
  start: number,
  end: number,
  min: number,
  max: number,
  rng: Rng,
): [number, number][] {
  const total = end - start;
  if (total < min) return [[start, end]];
  const cuts: [number, number][] = [];
  let cursor = start;
  while (cursor < end) {
    const remaining = end - cursor;
    if (remaining <= max * 1.35) {
      cuts.push([cursor, end]);
      break;
    }
    const width = rng.range(min, max);
    cuts.push([cursor, cursor + width]);
    cursor += width;
  }
  return cuts;
}

interface ParcelDraft {
  rect: Rect;
  facing: Facing;
}

/**
 * Lays out building footprints around a block's perimeter, leaving a courtyard
 * or alley in the middle when the block is deep enough for one.
 */
function subdivideBlock(block: CityBlock, spec: ArchetypeSpec, rng: Rng): ParcelDraft[] {
  const { rect } = block;
  const w = rectWidth(rect);
  const d = rectDepth(rect);
  const drafts: ParcelDraft[] = [];
  const [minFront, maxFront] = spec.frontage;
  const gap = 0.0; // Terraced rows share party walls; detached types inset later.

  const canSplitDepth = d >= spec.minDepth * 2 + 4.5;
  const canSplitWidth = w >= spec.minDepth * 2 + 4.5;
  // A block too shallow for a courtyard still gets two ranges of buildings set
  // back to back sharing a rear wall, which is how a real terrace block works.
  const backToBackDepth = d >= 17 && d < spec.minDepth * 2 + 4.5 && w > d;
  const backToBackWidth = w >= 17 && w < spec.minDepth * 2 + 4.5 && d >= w;

  if (backToBackDepth) {
    const split = d * rng.range(0.44, 0.56);
    for (const [x0, x1] of splitRun(rect.minX, rect.maxX, minFront, maxFront, rng)) {
      drafts.push({
        rect: { minX: x0 + gap, maxX: x1 - gap, minZ: rect.minZ, maxZ: rect.minZ + split },
        facing: 'north',
      });
    }
    for (const [x0, x1] of splitRun(rect.minX, rect.maxX, minFront, maxFront, rng)) {
      drafts.push({
        rect: { minX: x0 + gap, maxX: x1 - gap, minZ: rect.minZ + split, maxZ: rect.maxZ },
        facing: 'south',
      });
    }
    return drafts;
  }

  if (backToBackWidth) {
    const split = w * rng.range(0.44, 0.56);
    for (const [z0, z1] of splitRun(rect.minZ, rect.maxZ, minFront, maxFront, rng)) {
      drafts.push({
        rect: { minX: rect.minX, maxX: rect.minX + split, minZ: z0 + gap, maxZ: z1 - gap },
        facing: 'west',
      });
    }
    for (const [z0, z1] of splitRun(rect.minZ, rect.maxZ, minFront, maxFront, rng)) {
      drafts.push({
        rect: { minX: rect.minX + split, maxX: rect.maxX, minZ: z0 + gap, maxZ: z1 - gap },
        facing: 'east',
      });
    }
    return drafts;
  }

  if (canSplitDepth) {
    const northDepth = clamp(rng.range(spec.minDepth, spec.maxDepth), spec.minDepth, (d - 4.5) / 2);
    const southDepth = clamp(rng.range(spec.minDepth, spec.maxDepth), spec.minDepth, (d - 4.5) / 2);
    for (const [x0, x1] of splitRun(rect.minX, rect.maxX, minFront, maxFront, rng)) {
      drafts.push({
        rect: { minX: x0 + gap, maxX: x1 - gap, minZ: rect.minZ, maxZ: rect.minZ + northDepth },
        facing: 'north',
      });
    }
    for (const [x0, x1] of splitRun(rect.minX, rect.maxX, minFront, maxFront, rng)) {
      drafts.push({
        rect: { minX: x0 + gap, maxX: x1 - gap, minZ: rect.maxZ - southDepth, maxZ: rect.maxZ },
        facing: 'south',
      });
    }
    // Cap the ends so the courtyard is enclosed by building, the way a real
    // perimeter block is, rather than opening onto the street as a gap.
    const coreMinZ = rect.minZ + northDepth;
    const coreMaxZ = rect.maxZ - southDepth;
    if (w > 30 && coreMaxZ - coreMinZ > 6) {
      const capDepth = clamp(rng.range(spec.minDepth, spec.maxDepth), 7, w * 0.3);
      drafts.push({
        rect: { minX: rect.minX, maxX: rect.minX + capDepth, minZ: coreMinZ, maxZ: coreMaxZ },
        facing: 'west',
      });
      drafts.push({
        rect: { minX: rect.maxX - capDepth, maxX: rect.maxX, minZ: coreMinZ, maxZ: coreMaxZ },
        facing: 'east',
      });
    }
    return drafts;
  }

  if (canSplitWidth) {
    const westDepth = clamp(rng.range(spec.minDepth, spec.maxDepth), spec.minDepth, (w - 4.5) / 2);
    const eastDepth = clamp(rng.range(spec.minDepth, spec.maxDepth), spec.minDepth, (w - 4.5) / 2);
    for (const [z0, z1] of splitRun(rect.minZ, rect.maxZ, minFront, maxFront, rng)) {
      drafts.push({
        rect: { minX: rect.minX, maxX: rect.minX + westDepth, minZ: z0 + gap, maxZ: z1 - gap },
        facing: 'west',
      });
    }
    for (const [z0, z1] of splitRun(rect.minZ, rect.maxZ, minFront, maxFront, rng)) {
      drafts.push({
        rect: { minX: rect.maxX - eastDepth, maxX: rect.maxX, minZ: z0 + gap, maxZ: z1 - gap },
        facing: 'east',
      });
    }
    return drafts;
  }

  // Shallow block: one run of buildings straight through, fronting the long side.
  if (w >= d) {
    for (const [x0, x1] of splitRun(rect.minX, rect.maxX, minFront, maxFront, rng)) {
      drafts.push({
        rect: { minX: x0 + gap, maxX: x1 - gap, minZ: rect.minZ, maxZ: rect.maxZ },
        facing: rng.chance(0.5) ? 'north' : 'south',
      });
    }
  } else {
    for (const [z0, z1] of splitRun(rect.minZ, rect.maxZ, minFront, maxFront, rng)) {
      drafts.push({
        rect: { minX: rect.minX, maxX: rect.maxX, minZ: z0 + gap, maxZ: z1 - gap },
        facing: rng.chance(0.5) ? 'west' : 'east',
      });
    }
  }
  return drafts;
}

/** Finds the street a parcel fronts onto, given the side it faces. */
function frontStreet(rect: Rect, facing: Facing, streets: readonly Street[]): Street {
  const centre = rectCenter(rect);
  const wantAxis: 'x' | 'z' = facing === 'east' || facing === 'west' ? 'x' : 'z';
  const target =
    facing === 'north' ? rect.minZ : facing === 'south' ? rect.maxZ : facing === 'west' ? rect.minX : rect.maxX;
  const along = wantAxis === 'x' ? centre.y : centre.x;

  let best: Street | null = null;
  let bestDistance = Infinity;
  for (const street of streets) {
    if (street.axis !== wantAxis) continue;
    if (along < street.from - 1 || along > street.to + 1) continue;
    const distance = Math.abs(street.position - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = street;
    }
  }
  return best ?? (streets[0] as Street);
}

/** Pavement height on the near side of a street, at a given point along it. */
export function pavementElevation(street: Street, along: number): number {
  const y =
    street.axis === 'x'
      ? landElevation(street.position, along)
      : landElevation(along, street.position);
  return y + KERB_HEIGHT;
}

const ENTERABLE_TARGETS: readonly { district: DistrictId; kind: InteriorKind; count: number }[] = [
  { district: 'harbourside', kind: 'cafe', count: 1 },
  // The Old Quarter's two shopfronts: a general store and, next door in the
  // same close-grained commercial grain, the gun shop. Splitting one
  // `count: 2` target into two `count: 1` targets draws the same parcels in
  // the same order from the same RNG stream, so promoting one of them to a
  // gun shop moves no other building in the city.
  { district: 'oldQuarter', kind: 'store', count: 1 },
  { district: 'oldQuarter', kind: 'gunStore', count: 1 },
  { district: 'cannery', kind: 'workshop', count: 1 },
  { district: 'core', kind: 'lobby', count: 1 },
  { district: 'civic', kind: 'marketHall', count: 1 },
  { district: 'ridge', kind: 'stairhall', count: 1 },
];

function buildParcels(blocks: readonly CityBlock[], streets: readonly Street[], rng: Rng): Parcel[] {
  const parcels: Parcel[] = [];
  let index = 0;

  for (const block of blocks) {
    if (block.kind === 'park') continue;

    const table = DISTRICT_ARCHETYPES[block.district];
    // One archetype family per block keeps a street reading as a coherent row,
    // while individual buildings still vary in width, height and detail.
    const blockArchetype = rng.weighted(table.ids, table.weights);
    const spec = ARCHETYPES[blockArchetype];

    let drafts = carveAlley(subdivideBlock(block, spec, rng), block.alley);
    if (block.kind === 'plaza') {
      // The plaza keeps only its northern range of buildings; the rest is open.
      drafts = drafts.filter((d) => d.facing === 'north').slice(0, 3);
    }

    for (const draft of drafts) {
      const w = rectWidth(draft.rect);
      const dep = rectDepth(draft.rect);
      if (w < 5.5 || dep < 5.5) continue;

      // Occasionally swap in a neighbouring archetype so rows are not uniform.
      const archetype = rng.chance(0.22) ? rng.weighted(table.ids, table.weights) : blockArchetype;
      const localSpec = ARCHETYPES[archetype];

      const street = frontStreet(draft.rect, draft.facing, streets);
      const centre = rectCenter(draft.rect);
      const along = street.axis === 'x' ? centre.y : centre.x;
      const frontPavement = pavementElevation(street, along);

      // Grounding contract. The surfaces that actually exist under a building
      // are the pavement out front and the block's own interior surface, so
      // those - not the raw terrain function - are what the plinth reconciles.
      // Finished floor goes a step above the highest of them, which is what
      // makes it impossible for a building to end up part-buried; the plinth
      // is carried below the lowest, so it cannot float either.
      const footprintLevels = [
        blockSurfaceY(block, draft.rect.minX, draft.rect.minZ),
        blockSurfaceY(block, draft.rect.maxX, draft.rect.minZ),
        blockSurfaceY(block, draft.rect.minX, draft.rect.maxZ),
        blockSurfaceY(block, draft.rect.maxX, draft.rect.maxZ),
        frontPavement,
      ];
      const groundY = Math.max(...footprintLevels) + 0.16;
      const baseY = Math.min(...footprintLevels) - 0.7;

      // Cap the height against the footprint. Without this a tower archetype
      // landing on a narrow infill lot produces a 66 m building on a 13 m base,
      // which reads as a mistake from every angle.
      const footprint = Math.max(w, dep);
      const maxHeight = Math.max(12, footprint * 3.6);
      let storeys = rng.int(localSpec.storeys[0], localSpec.storeys[1]);
      const heightOf = (n: number): number =>
        localSpec.groundStoreyHeight[0] + (n - 1) * localSpec.storeyHeight[0];
      while (storeys > localSpec.storeys[0] && heightOf(storeys) > maxHeight) storeys -= 1;

      parcels.push({
        id: `parcel-${index}`,
        blockId: block.id,
        district: block.district,
        archetype,
        rect: draft.rect,
        facing: draft.facing,
        frontStreetId: street.id,
        groundY,
        baseY,
        storeys,
        storeyHeight: rng.range(localSpec.storeyHeight[0], localSpec.storeyHeight[1]),
        groundStoreyHeight: rng.range(
          localSpec.groundStoreyHeight[0],
          localSpec.groundStoreyHeight[1],
        ),
        enterable: false,
        interiorKind: null,
        seed: (rng.next() * 0xffffffff) >>> 0,
      });
      index += 1;
    }
  }

  return assignInteriors(parcels, rng);
}

/**
 * Promotes a handful of parcels to enterable buildings. Candidates must have a
 * generous frontage so the doorway and interior read properly from the street.
 */
function assignInteriors(parcels: readonly Parcel[], rng: Rng): Parcel[] {
  const chosen = new Map<string, InteriorKind>();

  for (const target of ENTERABLE_TARGETS) {
    const candidates = parcels.filter(
      (p) =>
        p.district === target.district &&
        !chosen.has(p.id) &&
        rectWidth(p.rect) >= 11 &&
        rectDepth(p.rect) >= 9.5,
    );
    if (candidates.length === 0) continue;
    for (let i = 0; i < target.count; i += 1) {
      const remaining = candidates.filter((p) => !chosen.has(p.id));
      if (remaining.length === 0) break;
      chosen.set(rng.pick(remaining).id, target.kind);
    }
  }

  return parcels.map((parcel) => {
    const kind = chosen.get(parcel.id);
    return kind ? { ...parcel, enterable: true, interiorKind: kind } : parcel;
  });
}

/** The outer pedestrian circuit, traced along the inner pavements of the loop. */
function buildCircuit(): Vec2[] {
  const west = X_LINES[0] as Street;
  const east = X_LINES[X_LINES.length - 1] as Street;
  const north = Z_LINES[0] as Street;
  const south = Z_LINES[Z_LINES.length - 1] as Street;

  const wx = west.position + west.roadHalf + west.sidewalk * 0.5;
  const ex = east.position - east.roadHalf - east.sidewalk * 0.5;
  const nz = north.position + north.roadHalf + north.sidewalk * 0.5;
  const sz = south.position - south.roadHalf - south.sidewalk * 0.5;

  return [
    { x: wx, y: nz },
    { x: ex, y: nz },
    { x: ex, y: sz },
    { x: wx, y: sz },
  ];
}

function circuitLengthOf(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i] as Vec2;
    const b = points[(i + 1) % points.length] as Vec2;
    total += Math.hypot(a.x - b.x, a.y - b.y);
  }
  return total;
}

function buildLandmarks(): Landmark[] {
  const ferryX = -172;
  const ferryZ = 12;
  return [
    {
      id: 'lighthouse',
      name: 'Kestrel Point Light',
      kind: 'lighthouse',
      x: -196,
      z: -126,
      y: landElevation(-196, -126),
    },
    {
      id: 'ferry-terminal',
      name: 'Harbour Line Terminal',
      kind: 'ferryTerminal',
      x: ferryX,
      z: ferryZ,
      y: landElevation(ferryX, ferryZ),
    },
    {
      id: 'clock-tower',
      name: 'Meridian Clock Tower',
      kind: 'clockTower',
      // North edge of Meridian Plaza.
      x: -6,
      z: -40,
      y: landElevation(-6, -40),
    },
    {
      id: 'park-fountain',
      name: 'Lantern Park Fountain',
      kind: 'fountain',
      x: 92,
      z: -32,
      y: landElevation(92, -32),
    },
    {
      id: 'ridge-watertower',
      name: 'Ridge Water Tower',
      kind: 'watertower',
      x: 150,
      z: -128,
      y: landElevation(150, -128),
    },
  ];
}

let cached: CityPlan | null = null;

/** Builds (and memoises) the city plan. Deterministic for a given seed. */
export function getCityPlan(seed: string = CITY_SEED): CityPlan {
  if (cached && cached.seed === seed) return cached;

  const rng = createRng(seed);
  const streets: Street[] = [...X_LINES, ...Z_LINES];
  const blocks = buildBlocks(rng);
  const parcels = buildParcels(blocks, streets, rng);
  const circuit = buildCircuit();

  const plan: CityPlan = {
    seed,
    streets,
    blocks,
    parcels,
    landmarks: buildLandmarks(),
    circuit,
    circuitLength: circuitLengthOf(circuit),
    // Player starts on the promenade beside the ferry terminal, looking east
    // into the city so the skyline is the first thing they see. Heading is the
    // camera yaw: forward is (-sin y, 0, -cos y), so -PI/2 looks due east.
    spawn: { x: -153, z: 18, heading: -Math.PI * 0.46 },
    xLines: X_LINES,
    zLines: Z_LINES,
  };

  cached = plan;
  return plan;
}
