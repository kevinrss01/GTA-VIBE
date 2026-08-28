/**
 * The airport's structures: the terminal shell, the control tower, the
 * hangars, the perimeter fence, the airfield lighting and the signage.
 *
 * The terminal's INSIDE is `terminal.ts`; this module builds the box it sits
 * in, and the two agree about one thing only - `TERMINAL`, `TERMINAL_FLOOR`
 * and the door table below, which both import.
 *
 * ## Lighting
 *
 * Every airfield light here is emissive geometry, not a `LightRequest`. This
 * project measured point lights at 61 per cent of frame cost, and a runway
 * carries 42 edge fittings, 24 threshold fittings and 30 taxiway fittings. As
 * geometry they are 96 boxes on one unlit material and cost nothing; as lights
 * they would have been the frame budget.
 *
 * The colours are a compromise and it is worth writing down. Real edge lights
 * are white, thresholds green and runway ends red, and the palette has exactly
 * one unlit key - `signalLens`, white. Adding green and red keys means adding
 * to `MaterialKey`, and `CombatFx.ts` holds an exhaustive
 * `Record<MaterialKey, ImpactKind>` that another workstream owns. So the edge
 * and centreline fittings are `signalLens` and the threshold wing bars take
 * `signEmissiveWarm`, which at least reads as a different bar of light at the
 * end of the runway.
 */

import { BoxGeometry, BufferGeometry, CylinderGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import type { MaterialKey } from '../../render/materials';
import { landElevation } from '../elevation';
import type { GeometrySink } from '../build/types';
import {
  AIRFIELD_LEVEL,
  APRON,
  HANGARS,
  RUNWAY,
  TAXIWAY,
  TAXIWAY_LINKS,
  TERMINAL,
  TERMINAL_FLOOR,
  TOWER,
  type AirportRect,
} from './layout';
import { FENCE_RUNS, SOUTH_APRON, hangarDoorRect } from './plan';

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Collects geometry per material key and merges once.
 *
 * Same idea as `GeometryBatch` in `interiorProps`, restated here because that
 * one is bound to the interior's `Fitout` context and these builders work in
 * world space.
 */
export class WorldBatch {
  private readonly byKey = new Map<MaterialKey, BufferGeometry[]>();

  add(key: MaterialKey, geometry: BufferGeometry): void {
    const bucket = this.byKey.get(key);
    if (bucket) bucket.push(geometry);
    else this.byKey.set(key, [geometry]);
  }

  /** An axis-aligned box in world metres. */
  box(key: MaterialKey, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void {
    const w = maxX - minX;
    const h = maxY - minY;
    const d = maxZ - minZ;
    if (w < 1e-4 || h < 1e-4 || d < 1e-4) return;
    const geometry = new BoxGeometry(w, h, d);
    geometry.translate((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    this.add(key, geometry);
  }

  cylinder(key: MaterialKey, x: number, z: number, radiusTop: number, radiusBottom: number, base: number, height: number, segments = 10): void {
    const geometry = new CylinderGeometry(radiusTop, radiusBottom, height, segments);
    geometry.translate(x, base + height / 2, z);
    this.add(key, geometry);
  }

  flush(sink: GeometrySink): void {
    for (const [key, parts] of this.byKey) {
      const first = parts[0];
      if (!first) continue;
      if (parts.length === 1) {
        sink.add(key, first);
        continue;
      }
      const merged = mergeGeometries(parts);
      for (const part of parts) part.dispose();
      sink.add(key, merged);
    }
    this.byKey.clear();
  }
}

function solid(
  sink: GeometrySink,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  bottom: number,
  top: number,
  surface?: MaterialKey,
): void {
  sink.collider(
    surface === undefined
      ? { minX, minZ, maxX, maxZ, bottom, top, solid: true }
      : { minX, minZ, maxX, maxZ, bottom, top, solid: true, surface },
  );
}

// ---------------------------------------------------------------------------
// Terminal shell
// ---------------------------------------------------------------------------

/** Wall thickness of the terminal envelope. */
export const TERMINAL_WALL = 0.5;
/** Eaves height of the concourse. */
export const TERMINAL_EAVES = 11.5;
/** The check-in hall's raised roof, at the north end. */
export const TERMINAL_HALL_EAVES = 15.5;
/** Where the check-in hall's taller roof stops, measured in z. */
export const TERMINAL_HALL_Z = TERMINAL.minZ + 62;

/**
 * Every opening in the terminal envelope.
 *
 * Landside doors face the forecourt at the north end and the landside road on
 * the west; gate doors face the apron on the east, one per stand so a
 * passenger walks out at the aircraft they are boarding. The interior builder
 * reads exactly this table, so a door can never be cut in one and not the
 * other.
 */
export interface TerminalDoor {
  readonly id: string;
  readonly face: 'north' | 'west' | 'east';
  /** Centre along the face: x for north, z for west and east. */
  readonly along: number;
  readonly width: number;
  readonly height: number;
  readonly landside: boolean;
}

export const TERMINAL_DOOR_HEIGHT = 3.2;

export const TERMINAL_DOORS: readonly TerminalDoor[] = [
  { id: 'terminal-main', face: 'north', along: 183, width: 7.2, height: TERMINAL_DOOR_HEIGHT, landside: true },
  { id: 'terminal-north-west', face: 'north', along: 164, width: 3.6, height: TERMINAL_DOOR_HEIGHT, landside: true },
  { id: 'terminal-north-east', face: 'north', along: 202, width: 3.6, height: TERMINAL_DOOR_HEIGHT, landside: true },
  { id: 'terminal-kerbside', face: 'west', along: 408, width: 3.6, height: TERMINAL_DOOR_HEIGHT, landside: true },
  // The gates are all SOUTH of the security line at z = 428, which is what
  // makes the plan legible: landside doors at the north end, security across
  // the middle, and every airside door beyond it.
  { id: 'gate-1', face: 'east', along: 452, width: 3.2, height: TERMINAL_DOOR_HEIGHT, landside: false },
  { id: 'gate-2', face: 'east', along: 482, width: 3.2, height: TERMINAL_DOOR_HEIGHT, landside: false },
  { id: 'gate-3', face: 'east', along: 512, width: 3.2, height: TERMINAL_DOOR_HEIGHT, landside: false },
];

/** Outward normal of a terminal face. */
export function doorNormal(door: TerminalDoor): { x: number; z: number } {
  if (door.face === 'north') return { x: 0, z: -1 };
  return door.face === 'west' ? { x: -1, z: 0 } : { x: 1, z: 0 };
}

/** Centre of a door opening on the wall plane. */
export function doorCentre(door: TerminalDoor): { x: number; z: number } {
  if (door.face === 'north') return { x: door.along, z: TERMINAL.minZ };
  return door.face === 'west'
    ? { x: TERMINAL.minX, z: door.along }
    : { x: TERMINAL.maxX, z: door.along };
}

/** Roof height above a point on the terminal, which steps down past the hall. */
function terminalRoof(z: number): number {
  return z < TERMINAL_HALL_Z ? TERMINAL_HALL_EAVES : TERMINAL_EAVES;
}

/**
 * One wall of the terminal, cut for its doors.
 *
 * The wall is emitted as the piers between openings plus a head over each, so
 * the hole in the shell is a real hole rather than a decal - the interior is
 * visible through it from the apron, and the collider set leaves the same gap.
 */
function terminalWall(
  batch: WorldBatch,
  sink: GeometrySink,
  face: TerminalDoor['face'],
  from: number,
  to: number,
  outer: number,
  inner: number,
  top: (along: number) => number,
): void {
  const doors = TERMINAL_DOORS.filter((d) => d.face === face).sort((a, b) => a.along - b.along);
  const lo = Math.min(outer, inner);
  const hi = Math.max(outer, inner);
  const base = TERMINAL_FLOOR - 0.7;

  const pier = (a: number, b: number): void => {
    if (b - a < 0.05) return;
    const height = top((a + b) / 2);
    if (face === 'north') {
      batch.box('concreteBoard', a, base, lo, b, TERMINAL_FLOOR + height, hi);
      solid(sink, a, lo, b, hi, base, TERMINAL_FLOOR + height, 'concreteBoard');
    } else {
      batch.box('concreteBoard', lo, base, a, hi, TERMINAL_FLOOR + height, b);
      solid(sink, lo, a, hi, b, base, TERMINAL_FLOOR + height, 'concreteBoard');
    }
  };

  let cursor = from;
  for (const door of doors) {
    const half = door.width / 2;
    pier(cursor, door.along - half);
    cursor = door.along + half;
    // Head over the opening. No collider: nothing walks at 3.2 m.
    const height = top(door.along);
    if (face === 'north') {
      batch.box('concreteBoard', door.along - half, TERMINAL_FLOOR + door.height, lo, door.along + half, TERMINAL_FLOOR + height, hi);
    } else {
      batch.box('concreteBoard', lo, TERMINAL_FLOOR + door.height, door.along - half, hi, TERMINAL_FLOOR + height, door.along + half);
    }
  }
  pier(cursor, to);
}

/**
 * The terminal envelope: floor slab, walls, curtain glazing, roof and canopy.
 *
 * 62 by 190 m, which is far larger than anything else in Meridian Bay, so the
 * budget is spent on the two things that read at that size: the step in the
 * roof over the check-in hall, and a continuous glazed band that tells you
 * which side you are looking at. Everything else is flat surface.
 */
export function buildTerminalShell(sink: GeometrySink): void {
  const batch = new WorldBatch();
  const base = TERMINAL_FLOOR - 0.7;
  const w = TERMINAL_WALL;

  // Plinth: the slab the building stands on, carried down past the platform.
  batch.box('concrete', TERMINAL.minX - 0.6, base - 0.5, TERMINAL.minZ - 0.6, TERMINAL.maxX + 0.6, TERMINAL_FLOOR, TERMINAL.maxZ + 0.6);
  sink.collider({
    minX: TERMINAL.minX - 0.6,
    maxX: TERMINAL.maxX + 0.6,
    minZ: TERMINAL.minZ - 0.6,
    maxZ: TERMINAL.maxZ + 0.6,
    bottom: base - 0.5,
    top: TERMINAL_FLOOR,
    solid: false,
    surface: 'concrete',
  });

  // Four walls, cut for their doors.
  terminalWall(batch, sink, 'north', TERMINAL.minX, TERMINAL.maxX, TERMINAL.minZ, TERMINAL.minZ + w, () => terminalRoof(TERMINAL.minZ));
  terminalWall(batch, sink, 'west', TERMINAL.minZ, TERMINAL.maxZ, TERMINAL.minX, TERMINAL.minX + w, terminalRoof);
  terminalWall(batch, sink, 'east', TERMINAL.minZ, TERMINAL.maxZ, TERMINAL.maxX - w, TERMINAL.maxX, terminalRoof);
  // South gable: baggage hall, no openings.
  batch.box('concreteBoard', TERMINAL.minX, base, TERMINAL.maxZ - w, TERMINAL.maxX, TERMINAL_FLOOR + TERMINAL_EAVES, TERMINAL.maxZ);
  solid(sink, TERMINAL.minX, TERMINAL.maxZ - w, TERMINAL.maxX, TERMINAL.maxZ, base, TERMINAL_FLOOR + TERMINAL_EAVES, 'concreteBoard');

  // Curtain glazing: a continuous band above the doors on the landside faces
  // and a taller one on the apron side, which is what makes a terminal read as
  // a terminal from outside rather than as a warehouse.
  const glazeBand = (minX: number, minZ: number, maxX: number, maxZ: number, low: number, high: number): void => {
    batch.box('glass', minX, TERMINAL_FLOOR + low, minZ, maxX, TERMINAL_FLOOR + high, maxZ);
  };
  glazeBand(TERMINAL.minX + 2, TERMINAL.minZ - 0.06, TERMINAL.maxX - 2, TERMINAL.minZ + 0.06, 4.0, TERMINAL_HALL_EAVES - 1.4);
  glazeBand(TERMINAL.minX - 0.06, TERMINAL.minZ + 3, TERMINAL.minX + 0.06, TERMINAL_HALL_Z, 4.0, TERMINAL_HALL_EAVES - 1.4);
  glazeBand(TERMINAL.minX - 0.06, TERMINAL_HALL_Z, TERMINAL.minX + 0.06, TERMINAL.maxZ - 12, 3.4, TERMINAL_EAVES - 1.6);
  glazeBand(TERMINAL.maxX - 0.06, TERMINAL.minZ + 3, TERMINAL.maxX + 0.06, TERMINAL.maxZ - 12, 3.6, TERMINAL_EAVES - 1.0);

  // Mullions, so the glazing has a grain instead of reading as a sheet.
  for (let x = TERMINAL.minX + 2; x <= TERMINAL.maxX - 2; x += 3.5) {
    batch.box('windowFrame', x - 0.09, TERMINAL_FLOOR + 4.0, TERMINAL.minZ - 0.1, x + 0.09, TERMINAL_FLOOR + TERMINAL_HALL_EAVES - 1.4, TERMINAL.minZ + 0.1);
  }
  for (let z = TERMINAL.minZ + 3; z <= TERMINAL.maxZ - 12; z += 3.5) {
    const low = z < TERMINAL_HALL_Z ? 4.0 : 3.4;
    const high = (z < TERMINAL_HALL_Z ? TERMINAL_HALL_EAVES : TERMINAL_EAVES) - 1.5;
    batch.box('windowFrame', TERMINAL.minX - 0.1, TERMINAL_FLOOR + low, z - 0.09, TERMINAL.minX + 0.1, TERMINAL_FLOOR + high, z + 0.09);
    batch.box('windowFrame', TERMINAL.maxX - 0.1, TERMINAL_FLOOR + 3.6, z - 0.09, TERMINAL.maxX + 0.1, TERMINAL_FLOOR + TERMINAL_EAVES - 1.1, z + 0.09);
  }

  // Roof: two slabs at the two eaves heights, each with a parapet.
  const roofSlab = (minZ: number, maxZ: number, height: number): void => {
    batch.box('roofTar', TERMINAL.minX, TERMINAL_FLOOR + height, minZ, TERMINAL.maxX, TERMINAL_FLOOR + height + 0.35, maxZ);
    batch.box('concrete', TERMINAL.minX - 0.35, TERMINAL_FLOOR + height + 0.35, minZ - 0.35, TERMINAL.maxX + 0.35, TERMINAL_FLOOR + height + 1.05, maxZ + 0.35);
  };
  roofSlab(TERMINAL.minZ, TERMINAL_HALL_Z, TERMINAL_HALL_EAVES);
  roofSlab(TERMINAL_HALL_Z, TERMINAL.maxZ, TERMINAL_EAVES);

  // Entrance canopy over the forecourt doors, on round columns.
  const canopyZ = TERMINAL.minZ - 7;
  batch.box('metalLight', TERMINAL.minX + 4, TERMINAL_FLOOR + 5.2, canopyZ, TERMINAL.maxX - 4, TERMINAL_FLOOR + 5.6, TERMINAL.minZ);
  for (let x = TERMINAL.minX + 8; x <= TERMINAL.maxX - 8; x += 11) {
    batch.cylinder('metalLight', x, canopyZ + 1.2, 0.22, 0.26, TERMINAL_FLOOR, 5.2, 10);
    solid(sink, x - 0.3, canopyZ + 0.9, x + 0.3, canopyZ + 1.5, TERMINAL_FLOOR, TERMINAL_FLOOR + 5.2, 'metalLight');
  }

  // Roof plant, which is what stops a 190 m roof reading as a lid.
  for (let z = TERMINAL.minZ + 24; z < TERMINAL.maxZ - 12; z += 27) {
    const top = TERMINAL_FLOOR + terminalRoof(z) + 1.05;
    batch.box('metalDark', 176, top, z, 196, top + 2.4, z + 9);
    batch.box('metalLight', 199, top, z + 2, 205, top + 1.6, z + 7);
  }

  batch.flush(sink);
}

// ---------------------------------------------------------------------------
// Control tower
// ---------------------------------------------------------------------------

export function buildTower(sink: GeometrySink): void {
  const batch = new WorldBatch();
  const base = landElevation(TOWER.x, TOWER.z);
  const shaftTop = base + TOWER.height - 6;

  // Operations block at the foot, which is what gives a 27 m tower something
  // to stand on rather than sprouting from the apron.
  batch.box('concreteBoard', TOWER.x - 11, base, TOWER.z - 9, TOWER.x + 11, base + 5.2, TOWER.z + 9);
  batch.box('roofTar', TOWER.x - 11.3, base + 5.2, TOWER.z - 9.3, TOWER.x + 11.3, base + 5.6, TOWER.z + 9.3);
  solid(sink, TOWER.x - 11, TOWER.z - 9, TOWER.x + 11, TOWER.z + 9, base, base + 5.6, 'concreteBoard');
  for (let z = TOWER.z - 6; z <= TOWER.z + 6; z += 4) {
    batch.box('glassDark', TOWER.x - 11.06, base + 1.6, z - 1.2, TOWER.x - 10.94, base + 3.4, z + 1.2);
  }

  // Shaft, battered slightly so it does not read as an extruded box.
  batch.box('concrete', TOWER.x - TOWER.halfX, base, TOWER.z - TOWER.halfZ, TOWER.x + TOWER.halfX, shaftTop, TOWER.z + TOWER.halfZ);
  solid(sink, TOWER.x - TOWER.halfX, TOWER.z - TOWER.halfZ, TOWER.x + TOWER.halfX, TOWER.z + TOWER.halfZ, base, shaftTop, 'concrete');
  // Stair tower on the north face, a vertical line up the shaft.
  batch.box('concreteBoard', TOWER.x - 2.2, base, TOWER.z - TOWER.halfZ - 2.4, TOWER.x + 2.2, shaftTop + 1.2, TOWER.z - TOWER.halfZ);
  solid(sink, TOWER.x - 2.2, TOWER.z - TOWER.halfZ - 2.4, TOWER.x + 2.2, TOWER.z - TOWER.halfZ, base, shaftTop + 1.2, 'concreteBoard');

  // Cab: wider than the shaft, glazed all round, with a canted sill and a
  // capping roof. The overhang is the whole silhouette of a control tower.
  const cabBase = shaftTop;
  const cabHalf = TOWER.halfX + 3.4;
  batch.box('metalDark', TOWER.x - cabHalf, cabBase, TOWER.z - cabHalf, TOWER.x + cabHalf, cabBase + 0.9, TOWER.z + cabHalf);
  batch.box('glassDark', TOWER.x - cabHalf + 0.2, cabBase + 0.9, TOWER.z - cabHalf + 0.2, TOWER.x + cabHalf - 0.2, cabBase + 4.3, TOWER.z + cabHalf - 0.2);
  batch.box('metalDark', TOWER.x - cabHalf - 0.6, cabBase + 4.3, TOWER.z - cabHalf - 0.6, TOWER.x + cabHalf + 0.6, cabBase + 5.1, TOWER.z + cabHalf + 0.6);
  solid(sink, TOWER.x - cabHalf, TOWER.z - cabHalf, TOWER.x + cabHalf, TOWER.z + cabHalf, cabBase, cabBase + 5.1, 'glassDark');
  // Mullions round the cab.
  for (let i = 0; i < 4; i += 1) {
    const t = -cabHalf + 0.2 + ((cabHalf - 0.2) * 2 * i) / 3;
    batch.box('metalDark', TOWER.x + t - 0.07, cabBase + 0.9, TOWER.z - cabHalf, TOWER.x + t + 0.07, cabBase + 4.3, TOWER.z + cabHalf);
    batch.box('metalDark', TOWER.x - cabHalf, cabBase + 0.9, TOWER.z + t - 0.07, TOWER.x + cabHalf, cabBase + 4.3, TOWER.z + t + 0.07);
  }
  // Mast and its obstruction light.
  batch.cylinder('metalLight', TOWER.x, TOWER.z, 0.09, 0.14, cabBase + 5.1, 6.5, 6);
  batch.box('signEmissiveWarm', TOWER.x - 0.22, cabBase + 11.4, TOWER.z - 0.22, TOWER.x + 0.22, cabBase + 11.8, TOWER.z + 0.22);
  // Radar, because a tower without one reads as an office block.
  batch.cylinder('metalDark', TOWER.x, TOWER.z + 2.2, 1.9, 1.9, cabBase + 5.2, 0.16, 12);

  batch.flush(sink);
}

// ---------------------------------------------------------------------------
// Hangars
// ---------------------------------------------------------------------------

export function buildHangars(sink: GeometrySink): void {
  const batch = new WorldBatch();

  for (const hangar of HANGARS) {
    const base = landElevation((hangar.minX + hangar.maxX) / 2, (hangar.minZ + hangar.maxZ) / 2);
    const eaves = base + 12.5;
    const ridge = base + 16.5;
    const door = hangarDoorRect(hangar);

    // Three solid walls plus the piers either side of the door opening.
    const wall = (minX: number, minZ: number, maxX: number, maxZ: number): void => {
      batch.box('corrugated', minX, base, minZ, maxX, eaves, maxZ);
      solid(sink, minX, minZ, maxX, maxZ, base, eaves, 'corrugated');
    };
    wall(hangar.minX, hangar.minZ, hangar.minX + 0.4, hangar.maxZ);
    wall(hangar.minX, hangar.minZ, hangar.maxX, hangar.minZ + 0.4);
    wall(hangar.minX, hangar.maxZ - 0.4, hangar.maxX, hangar.maxZ);
    wall(hangar.maxX - 0.4, hangar.minZ, hangar.maxX, door.minZ);
    wall(hangar.maxX - 0.4, door.maxZ, hangar.maxX, hangar.maxZ);

    // Sliding door leaves, parked half open, with the head beam over them.
    batch.box('paintedMetal', hangar.maxX - 0.42, base, door.minZ, hangar.maxX - 0.1, base + 9.6, door.minZ + 5.5);
    batch.box('paintedMetal', hangar.maxX - 0.42, base, door.maxZ - 5.5, hangar.maxX - 0.1, base + 9.6, door.maxZ);
    solid(sink, hangar.maxX - 0.42, door.minZ, hangar.maxX - 0.1, door.minZ + 5.5, base, base + 9.6, 'paintedMetal');
    solid(sink, hangar.maxX - 0.42, door.maxZ - 5.5, hangar.maxX - 0.1, door.maxZ, base, base + 9.6, 'paintedMetal');
    batch.box('corrugated', hangar.maxX - 0.4, base + 9.6, door.minZ, hangar.maxX, eaves, door.maxZ);

    // Shallow gable, ridged along z so the roof drains to the long sides.
    const steps = 6;
    for (let i = 0; i < steps; i += 1) {
      const t0 = i / steps;
      const t1 = (i + 1) / steps;
      const x0 = hangar.minX + (hangar.maxX - hangar.minX) * t0;
      const x1 = hangar.minX + (hangar.maxX - hangar.minX) * t1;
      const h = (t: number): number => eaves + (ridge - eaves) * (1 - Math.abs(t * 2 - 1));
      batch.box('metalLight', x0, Math.min(h(t0), h(t1)) - 0.3, hangar.minZ - 0.4, x1, Math.max(h(t0), h(t1)), hangar.maxZ + 0.4);
    }

    // Floodlight bracket over the door, and the unit's own emissive lens.
    batch.box('metalDark', hangar.maxX - 0.1, base + 10.4, door.minZ + 2, hangar.maxX + 0.9, base + 10.8, door.minZ + 3);
    batch.box('signEmissiveWarm', hangar.maxX + 0.5, base + 10.1, door.minZ + 2.2, hangar.maxX + 0.9, base + 10.4, door.minZ + 2.8);
  }

  // A fuel farm south of the hangars: two horizontal tanks in a bund. Cheap,
  // and it is the thing that says this is an airfield rather than an industrial
  // estate with a runway next to it.
  const tankZ = SOUTH_APRON.maxZ - 14;
  const base = AIRFIELD_LEVEL;
  batch.box('concrete', 196, base, tankZ - 8, 232, base + 1.1, tankZ + 8);
  solid(sink, 196, tankZ - 8, 232, tankZ + 8, base, base + 1.1, 'concrete');
  for (const offset of [-4, 4]) {
    const geometry = new CylinderGeometry(2.2, 2.2, 16, 12);
    geometry.rotateZ(Math.PI / 2);
    geometry.translate(214, base + 3.4, tankZ + offset);
    batch.add('metalLight', geometry);
    solid(sink, 206, tankZ + offset - 2.2, 222, tankZ + offset + 2.2, base + 1.2, base + 5.6, 'metalLight');
  }

  batch.flush(sink);
}

// ---------------------------------------------------------------------------
// Perimeter fence
// ---------------------------------------------------------------------------

/** Airside fence height. 2.4 m of mesh plus a barbed outrigger. */
const FENCE_HEIGHT = 2.4;
const FENCE_POST_SPACING = 6;

export function buildFence(sink: GeometrySink): void {
  const batch = new WorldBatch();

  for (const run of FENCE_RUNS) {
    const dx = run.toX - run.fromX;
    const dz = run.toZ - run.fromZ;
    const length = Math.hypot(dx, dz);
    if (length < 1) continue;
    const ux = dx / length;
    const uz = dz / length;
    const gateFrom = run.gate === null ? -1 : run.gate * length - 6;
    const gateTo = run.gate === null ? -1 : run.gate * length + 6;

    for (let s = 0; s <= length; s += FENCE_POST_SPACING) {
      if (run.gate !== null && s > gateFrom && s < gateTo) continue;
      const x = run.fromX + ux * s;
      const z = run.fromZ + uz * s;
      const base = landElevation(x, z);
      batch.cylinder('metalDark', x, z, 0.055, 0.065, base, FENCE_HEIGHT + 0.35, 6);
    }

    // The mesh itself: one thin slab per bay, plus a top rail. Drawn as
    // geometry rather than an alpha-tested plane because the palette has no
    // cut-out material and a 1.2 km run of alpha test is a fill-rate bill.
    const bay = (from: number, to: number): void => {
      if (to - from < 0.5) return;
      const x0 = run.fromX + ux * from;
      const z0 = run.fromZ + uz * from;
      const x1 = run.fromX + ux * to;
      const z1 = run.fromZ + uz * to;
      const base = landElevation((x0 + x1) / 2, (z0 + z1) / 2);
      const t = 0.03;
      batch.box(
        'metalLight',
        Math.min(x0, x1) - (uz !== 0 ? t : 0),
        base + 0.15,
        Math.min(z0, z1) - (ux !== 0 ? t : 0),
        Math.max(x0, x1) + (uz !== 0 ? t : 0),
        base + FENCE_HEIGHT,
        Math.max(z0, z1) + (ux !== 0 ? t : 0),
      );
      sink.collider({
        minX: Math.min(x0, x1) - 0.12,
        maxX: Math.max(x0, x1) + 0.12,
        minZ: Math.min(z0, z1) - 0.12,
        maxZ: Math.max(z0, z1) + 0.12,
        bottom: base,
        top: base + FENCE_HEIGHT,
        solid: true,
        surface: 'metalLight',
      });
    };

    if (run.gate === null) {
      bay(0, length);
    } else {
      bay(0, gateFrom);
      bay(gateTo, length);
      // The gate: two leaves standing open against the fence line.
      for (const [at, dir] of [
        [gateFrom, 1],
        [gateTo, -1],
      ] as const) {
        const x = run.fromX + ux * at;
        const z = run.fromZ + uz * at;
        const base = landElevation(x, z);
        batch.box(
          'paintedMetal',
          Math.min(x, x + uz * 5 * dir) - 0.08,
          base + 0.1,
          Math.min(z, z - ux * 5 * dir) - 0.08,
          Math.max(x, x + uz * 5 * dir) + 0.08,
          base + FENCE_HEIGHT,
          Math.max(z, z - ux * 5 * dir) + 0.08,
        );
      }
    }
  }

  batch.flush(sink);
}

// ---------------------------------------------------------------------------
// Airfield lighting
// ---------------------------------------------------------------------------

/** Runway edge lights every 60 m, threshold wing bars, taxiway edge lights. */
export function buildAirfieldLighting(sink: GeometrySink): void {
  const batch = new WorldBatch();
  const y = AIRFIELD_LEVEL;

  const fitting = (key: MaterialKey, x: number, z: number, size = 0.28, height = 0.34): void => {
    batch.box('metalDark', x - size, y, z - size, x + size, y + height * 0.45, z + size);
    batch.box(key, x - size * 0.8, y + height * 0.45, z - size * 0.8, x + size * 0.8, y + height, z + size * 0.8);
  };

  // Runway edge lights, both sides, 60 m spacing.
  for (let z = RUNWAY.northZ; z <= RUNWAY.southZ; z += 60) {
    for (const side of [-1, 1] as const) {
      fitting('signalLens', RUNWAY.centreX + side * (RUNWAY.halfWidth + 1.6), z);
    }
  }
  // Threshold wing bars at both ends: six fittings across, outboard of the
  // runway edge, which is the shape a pilot picks out on approach.
  for (const [z, into] of [
    [RUNWAY.northZ, -1],
    [RUNWAY.southZ, 1],
  ] as const) {
    for (let k = 0; k < 6; k += 1) {
      for (const side of [-1, 1] as const) {
        fitting('signEmissiveWarm', RUNWAY.centreX + side * (RUNWAY.halfWidth + 1.6 + k * 2.4), z + into * 2.4, 0.24, 0.3);
      }
    }
  }
  // Taxiway edge lights.
  for (let z = TAXIWAY.fromZ; z <= TAXIWAY.toZ; z += 40) {
    for (const side of [-1, 1] as const) {
      fitting('signalLens', TAXIWAY.centreX + side * (TAXIWAY.halfWidth + 1.2), z, 0.22, 0.28);
    }
  }
  // Apron floodlight masts: a real light source would be eight more point
  // lights, so these are masts with emissive heads and nothing else.
  for (let z = APRON.minZ + 40; z < APRON.maxZ; z += 80) {
    const x = APRON.maxX - 3;
    batch.cylinder('metalDark', x, z, 0.16, 0.24, y, 16, 8);
    batch.box('signEmissiveWarm', x - 1.1, y + 15.4, z - 0.4, x + 1.1, y + 16, z + 0.4);
  }

  batch.flush(sink);
}

// ---------------------------------------------------------------------------
// Signage
// ---------------------------------------------------------------------------

/** A double-sided sign plate on two legs, facing across `axis`. */
function signBoard(
  batch: WorldBatch,
  x: number,
  z: number,
  halfX: number,
  halfZ: number,
  base: number,
  bottom: number,
  height: number,
  face: MaterialKey,
): void {
  batch.box('metalDark', x - halfX, base + bottom, z - halfZ, x + halfX, base + bottom + height, z + halfZ);
  batch.box(face, x - halfX * 0.92, base + bottom + 0.1, z - halfZ - 0.03, x + halfX * 0.92, base + bottom + height - 0.1, z + halfZ + 0.03);
  for (const t of [-0.62, 0.62]) {
    const legX = halfX > halfZ ? x + halfX * t : x;
    const legZ = halfX > halfZ ? z : z + halfZ * t;
    batch.cylinder('metalDark', legX, legZ, 0.05, 0.06, base, bottom, 6);
  }
}

export function buildAirportSignage(sink: GeometrySink): void {
  const batch = new WorldBatch();

  // Taxiway guidance signs beside each runway link, on the taxiway side of the
  // holding position. Mandatory instruction signs are red with white legend;
  // the palette's nearest is the warm sign material.
  for (const z of TAXIWAY_LINKS) {
    const base = AIRFIELD_LEVEL;
    signBoard(batch, RUNWAY.centreX - RUNWAY.halfWidth - 18, z - TAXIWAY.halfWidth - 2.5, 1.5, 0.12, base, 0.4, 0.9, 'signEmissiveWarm');
    signBoard(batch, TAXIWAY.centreX + TAXIWAY.halfWidth + 2.5, z, 0.12, 1.5, base, 0.4, 0.9, 'signEmissive');
  }

  // The airport's own sign, on the forecourt side of the terminal canopy.
  const base = AIRFIELD_LEVEL;
  signBoard(batch, 183, TERMINAL.minZ - 16, 9, 0.2, base, 2.4, 3.2, 'signEmissiveWarm');

  // Gate numbers over the airside doors, hung off the terminal's east wall.
  for (const door of TERMINAL_DOORS) {
    if (door.landside) continue;
    batch.box('metalDark', TERMINAL.maxX + 0.05, TERMINAL_FLOOR + 4.2, door.along - 1.6, TERMINAL.maxX + 0.15, TERMINAL_FLOOR + 5.4, door.along + 1.6);
    batch.box('signEmissiveWarm', TERMINAL.maxX + 0.15, TERMINAL_FLOOR + 4.35, door.along - 1.4, TERMINAL.maxX + 0.22, TERMINAL_FLOOR + 5.25, door.along + 1.4);
  }

  batch.flush(sink);
}

export type { AirportRect };
