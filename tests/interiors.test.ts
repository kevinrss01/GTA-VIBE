import type { BufferGeometry, Matrix4 } from 'three';
import { describe, expect, it } from 'vitest';

import type { MaterialKey } from '../src/render/materials';
import { getCityPlan, type Parcel } from '../src/world/CityPlan';
import { buildInterior } from '../src/world/build/InteriorBuilder';
import {
  doorApproach,
  doorLanding,
  doorOutsideY,
  doorwayFor,
} from '../src/world/build/doorway';
import type {
  ColliderBox,
  GeometrySink,
  InteractionPoint,
  LightRequest,
  PropKey,
} from '../src/world/build/types';

/** Collects everything a builder emits, with no renderer in sight. */
class RecordingSink implements GeometrySink {
  readonly geometries: { key: MaterialKey; geometry: BufferGeometry }[] = [];
  readonly colliders: ColliderBox[] = [];
  readonly lights: LightRequest[] = [];
  readonly interactions: InteractionPoint[] = [];
  readonly instances: { prop: PropKey; matrix: Matrix4 }[] = [];

  add(key: MaterialKey, geometry: BufferGeometry): void {
    this.geometries.push({ key, geometry });
  }
  instance(prop: PropKey, matrix: Matrix4): void {
    this.instances.push({ prop, matrix });
  }
  collider(box: ColliderBox): void {
    this.colliders.push(box);
  }
  light(request: LightRequest): void {
    this.lights.push(request);
  }
  interaction(point: InteractionPoint): void {
    this.interactions.push(point);
  }
}

function build(parcel: Parcel): RecordingSink {
  const sink = new RecordingSink();
  buildInterior(parcel, sink);
  return sink;
}

function triangles(geometry: BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return index.count / 3;
  return (geometry.getAttribute('position')?.count ?? 0) / 3;
}

function totalTriangles(sink: RecordingSink): number {
  return sink.geometries.reduce((sum, entry) => sum + triangles(entry.geometry), 0);
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  nonFinite: number;
}

function boundsOf(sink: RecordingSink): Bounds {
  const bounds: Bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
    nonFinite: 0,
  };
  for (const { geometry } of sink.geometries) {
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        bounds.nonFinite += 1;
        continue;
      }
      bounds.minX = Math.min(bounds.minX, x);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
      bounds.minZ = Math.min(bounds.minZ, z);
      bounds.maxZ = Math.max(bounds.maxZ, z);
    }
  }
  return bounds;
}

/** Does the segment from a to b, at height y, run into this collider? */
function segmentBlocked(
  box: ColliderBox,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  y: number,
): boolean {
  if (!box.solid) return false;
  if (y <= box.bottom || y >= box.top) return false;
  let tMin = 0;
  let tMax = 1;
  const slab = (origin: number, delta: number, min: number, max: number): boolean => {
    if (Math.abs(delta) < 1e-9) return origin >= min && origin <= max;
    const t0 = (min - origin) / delta;
    const t1 = (max - origin) / delta;
    tMin = Math.max(tMin, Math.min(t0, t1));
    tMax = Math.min(tMax, Math.max(t0, t1));
    return tMax >= tMin;
  };
  if (!slab(ax, bx - ax, box.minX, box.maxX)) return false;
  if (!slab(az, bz - az, box.minZ, box.maxZ)) return false;
  return tMax >= tMin;
}

function contains(box: ColliderBox, x: number, y: number, z: number): boolean {
  return (
    x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ && y > box.bottom && y < box.top
  );
}

function overlapsXZ(a: ColliderBox, b: ColliderBox): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
}

const plan = getCityPlan();
const enterable = plan.parcels.filter((parcel) => parcel.enterable);
const builds = new Map<string, RecordingSink>(
  enterable.map((parcel) => [parcel.id, build(parcel)] as const),
);

function sinkFor(parcel: Parcel): RecordingSink {
  const sink = builds.get(parcel.id);
  if (!sink) throw new Error(`no interior built for ${parcel.id}`);
  return sink;
}

function roofHeight(parcel: Parcel): number {
  return parcel.groundStoreyHeight + (parcel.storeys - 1) * parcel.storeyHeight;
}

describe('interiors', () => {
  it('has enterable parcels to build', () => {
    expect(enterable.length).toBeGreaterThanOrEqual(5);
    for (const parcel of enterable) expect(parcel.interiorKind).not.toBeNull();
  });

  it('furnishes and lights every enterable parcel', () => {
    for (const parcel of enterable) {
      const sink = sinkFor(parcel);
      expect(sink.geometries.length, `${parcel.id} has no geometry`).toBeGreaterThan(0);
      expect(totalTriangles(sink), `${parcel.id} is nearly empty`).toBeGreaterThan(300);
      expect(sink.lights.length, `${parcel.id} is unlit`).toBeGreaterThanOrEqual(2);
      expect(sink.lights.length, `${parcel.id} over-lights`).toBeLessThanOrEqual(5);
      expect(
        sink.colliders.some((box) => box.solid),
        `${parcel.id} has nothing solid`,
      ).toBe(true);
      expect(
        sink.colliders.some((box) => !box.solid),
        `${parcel.id} has no walkable floor`,
      ).toBe(true);
    }
  });

  it('emits one merged geometry per material key', () => {
    for (const parcel of enterable) {
      const sink = sinkFor(parcel);
      const keys = sink.geometries.map((entry) => entry.key);
      expect(new Set(keys).size, `${parcel.id} emits a key more than once`).toBe(keys.length);
    }
  });

  it('gives every interior exactly one working way out', () => {
    for (const parcel of enterable) {
      const sink = sinkFor(parcel);
      const doors = sink.interactions.filter((point) => point.kind === 'door');
      expect(doors.length, `${parcel.id} exits`).toBe(1);
      const exit = doors[0];
      expect(exit).toBeDefined();
      if (!exit) continue;

      const door = doorwayFor(parcel);
      const landing = doorLanding(door);
      const approach = doorApproach(door);
      expect(exit.prompt).toBe('Press E to leave');
      expect(exit.parcelId).toBe(parcel.id);
      expect(exit.x).toBeCloseTo(landing.x, 3);
      expect(exit.z).toBeCloseTo(landing.z, 3);
      expect(exit.target).toBeDefined();
      expect(exit.target?.x).toBeCloseTo(approach.x, 3);
      expect(exit.target?.z).toBeCloseTo(approach.z, 3);
      // Leaving lands the player on the pavement, not on the finished floor.
      // Handing back the floor level dropped them the height of the threshold
      // every time they stepped out.
      expect(exit.target?.y).toBeCloseTo(doorOutsideY(parcel, door), 6);
      expect(exit.target?.y ?? 0, `${parcel.id} exits above its own threshold`).toBeLessThan(
        parcel.groundY,
      );
      expect(exit.target?.y ?? 0, `${parcel.id} exits below its plinth`).toBeGreaterThan(
        parcel.baseY,
      );
      // Heading looks straight out of the building: forward is (-sin h, -cos h).
      const heading = exit.target?.heading ?? 0;
      expect(-Math.sin(heading)).toBeCloseTo(door.normalX, 3);
      expect(-Math.cos(heading)).toBeCloseTo(door.normalZ, 3);
    }
  });

  it('puts the floor exactly at the finished floor level', () => {
    for (const parcel of enterable) {
      const sink = sinkFor(parcel);
      const centreX = (parcel.rect.minX + parcel.rect.maxX) / 2;
      const centreZ = (parcel.rect.minZ + parcel.rect.maxZ) / 2;

      const floors = sink.colliders.filter(
        (box) =>
          !box.solid &&
          centreX >= box.minX &&
          centreX <= box.maxX &&
          centreZ >= box.minZ &&
          centreZ <= box.maxZ &&
          Math.abs(box.top - parcel.groundY) < 0.5,
      );
      expect(floors.length, `${parcel.id} has no floor under the room centre`).toBeGreaterThan(0);
      for (const floor of floors) {
        expect(floor.top, `${parcel.id} floor height`).toBeCloseTo(parcel.groundY, 2);
      }

      // And the floor surface itself is modelled at that level, not implied.
      const atFloorLevel = sink.geometries.some(({ geometry }) => {
        const position = geometry.getAttribute('position');
        for (let i = 0; i < position.count; i += 1) {
          if (Math.abs(position.getY(i) - parcel.groundY) <= 0.01) return true;
        }
        return false;
      });
      expect(atFloorLevel, `${parcel.id} has no surface at groundY`).toBe(true);
    }
  });

  it('keeps every interior inside its own building', () => {
    for (const parcel of enterable) {
      const bounds = boundsOf(sinkFor(parcel));
      const tolerance = 0.05;
      expect(bounds.minX, `${parcel.id} pokes out west`).toBeGreaterThanOrEqual(
        parcel.rect.minX - tolerance,
      );
      expect(bounds.maxX, `${parcel.id} pokes out east`).toBeLessThanOrEqual(
        parcel.rect.maxX + tolerance,
      );
      expect(bounds.minZ, `${parcel.id} pokes out north`).toBeGreaterThanOrEqual(
        parcel.rect.minZ - tolerance,
      );
      expect(bounds.maxZ, `${parcel.id} pokes out south`).toBeLessThanOrEqual(
        parcel.rect.maxZ + tolerance,
      );
      // Under the roof, and never sunk more than a threshold below the floor.
      expect(bounds.maxY, `${parcel.id} pushes through its roof`).toBeLessThanOrEqual(
        parcel.groundY + roofHeight(parcel),
      );
      expect(bounds.minY, `${parcel.id} sinks below its floor`).toBeGreaterThanOrEqual(
        parcel.groundY - 0.45,
      );
    }
  });

  it('gives the ceiling a believable height for its use', () => {
    for (const parcel of enterable) {
      const bounds = boundsOf(sinkFor(parcel));
      const height = bounds.maxY - parcel.groundY;
      expect(height, `${parcel.id} is too low`).toBeGreaterThan(2.4);
      if (parcel.interiorKind === 'marketHall') {
        expect(height, `${parcel.id} is not a hall`).toBeGreaterThan(5.0);
      }
      if (parcel.interiorKind === 'cafe' || parcel.interiorKind === 'store') {
        expect(height, `${parcel.id} is too tall for a shop`).toBeLessThan(4.2);
      }
    }
  });

  it('lines its opening up with the hole in the façade', () => {
    for (const parcel of enterable) {
      const sink = sinkFor(parcel);
      const door = doorwayFor(parcel);
      const alongX = door.facing === 'north' || door.facing === 'south';
      const at = (across: number, into: number): { x: number; z: number } => ({
        x: (alongX ? door.x + across : door.x) - door.normalX * into,
        z: (alongX ? door.z : door.z + across) - door.normalZ * into,
      });

      // The full width and height of the doorway is clear, right out to the
      // edges of the façade's hole and up to its head.
      const edge = door.width / 2 - 0.05;
      for (const across of [-edge, -0.45, 0, 0.45, edge]) {
        for (const into of [0.05, 0.15, 0.3]) {
          const { x, z } = at(across, into);
          for (const height of [0.4, 1.1, door.height - 0.15]) {
            const y = parcel.groundY + height;
            expect(
              sink.colliders.find((box) => contains(box, x, y, z)),
              `${parcel.id} blocks its own doorway at ${across.toFixed(2)}, ${into}, ${height}`,
            ).toBeUndefined();
          }
        }
      }

      // And immediately outside those edges the wall is closed, so the opening
      // is exactly as wide as the hole rather than a gap in the whole elevation.
      for (const across of [-(door.width / 2) - 0.2, door.width / 2 + 0.2]) {
        const { x, z } = at(across, 0.2);
        const y = parcel.groundY + 1.1;
        expect(
          sink.colliders.find((box) => box.solid && contains(box, x, y, z)),
          `${parcel.id} has no wall beside its door at ${across.toFixed(2)}`,
        ).toBeDefined();
      }
    }
  });

  it('leaves a clear walk from the door to the middle of the room', () => {
    for (const parcel of enterable) {
      const sink = sinkFor(parcel);
      const door = doorwayFor(parcel);
      const landing = doorLanding(door);
      const centreX = (parcel.rect.minX + parcel.rect.maxX) / 2;
      const centreZ = (parcel.rect.minZ + parcel.rect.maxZ) / 2;
      const y = parcel.groundY + 0.9;

      const blockers = sink.colliders.filter((box) =>
        segmentBlocked(box, landing.x, landing.z, centreX, centreZ, y),
      );
      expect(
        blockers.length,
        `${parcel.id} cannot be walked into: ${JSON.stringify(blockers[0])}`,
      ).toBe(0);
    }
  });

  it('never asks the player to climb more than a step at a time', () => {
    for (const parcel of enterable) {
      const platforms = sinkFor(parcel)
        .colliders.filter((box) => !box.solid)
        .sort((a, b) => a.top - b.top);

      for (let i = 0; i < platforms.length; i += 1) {
        const lower = platforms[i];
        if (!lower) continue;
        for (let j = i + 1; j < platforms.length; j += 1) {
          const upper = platforms[j];
          if (!upper) continue;
          // Only platforms that actually rest on the one below are a step up;
          // a mezzanine deck three metres overhead is not.
          if (upper.bottom > lower.top + 0.02) continue;
          if (!overlapsXZ(lower, upper)) continue;
          const rise = upper.top - lower.top;
          if (rise <= 0) continue;
          expect(rise, `${parcel.id} has a ${rise.toFixed(2)}m step`).toBeLessThanOrEqual(0.19);
        }
      }
    }
  });

  it('stays inside the triangle budget', () => {
    let total = 0;
    for (const parcel of enterable) {
      const count = totalTriangles(sinkFor(parcel));
      total += count;
      expect(count, `${parcel.id} costs ${count} triangles`).toBeLessThan(4000);
    }
    expect(total, `interiors cost ${total} triangles`).toBeLessThan(25000);
  });

  it('stays inside the light budget', () => {
    let total = 0;
    for (const parcel of enterable) {
      const sink = sinkFor(parcel);
      total += sink.lights.length;
      for (const light of sink.lights) {
        expect(light.intensity).toBeGreaterThanOrEqual(1.4);
        expect(light.intensity).toBeLessThanOrEqual(2.4);
        expect(light.distance).toBeGreaterThanOrEqual(8);
        expect(light.distance).toBeLessThanOrEqual(14);
        expect(light.priority).toBe(5);
        expect(Number.isFinite(light.x) && Number.isFinite(light.y) && Number.isFinite(light.z)).toBe(
          true,
        );
        // Lights hang inside the room they light.
        expect(light.x).toBeGreaterThan(parcel.rect.minX - 0.1);
        expect(light.x).toBeLessThan(parcel.rect.maxX + 0.1);
        expect(light.z).toBeGreaterThan(parcel.rect.minZ - 0.1);
        expect(light.z).toBeLessThan(parcel.rect.maxZ + 0.1);
        expect(light.y).toBeGreaterThan(parcel.groundY);
      }
    }
    expect(total, `interiors ask for ${total} lights`).toBeLessThanOrEqual(30);
  });

  it('produces no NaN anywhere', () => {
    for (const parcel of enterable) {
      const sink = sinkFor(parcel);
      expect(boundsOf(sink).nonFinite, `${parcel.id} has non-finite vertices`).toBe(0);
      for (const box of sink.colliders) {
        for (const value of [box.minX, box.maxX, box.minZ, box.maxZ, box.bottom, box.top]) {
          expect(Number.isFinite(value), `${parcel.id} collider ${JSON.stringify(box)}`).toBe(true);
        }
        expect(box.maxX).toBeGreaterThan(box.minX);
        expect(box.maxZ).toBeGreaterThan(box.minZ);
        expect(box.top).toBeGreaterThan(box.bottom);
      }
      for (const point of sink.interactions) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)).toBe(
          true,
        );
      }
    }
  });

  it('is deterministic across two builds', () => {
    for (const parcel of enterable) {
      const first = sinkFor(parcel);
      const second = build(parcel);

      expect(second.geometries.map((entry) => entry.key)).toEqual(
        first.geometries.map((entry) => entry.key),
      );
      expect(second.geometries.map((entry) => triangles(entry.geometry))).toEqual(
        first.geometries.map((entry) => triangles(entry.geometry)),
      );
      expect(second.colliders).toEqual(first.colliders);
      expect(second.lights).toEqual(first.lights);
      expect(second.interactions).toEqual(first.interactions);

      // Vertex positions have to match too, not just the counts.
      for (let g = 0; g < first.geometries.length; g += 1) {
        const a = first.geometries[g]?.geometry.getAttribute('position');
        const b = second.geometries[g]?.geometry.getAttribute('position');
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        if (!a || !b) continue;
        expect(b.count).toBe(a.count);
        for (let i = 0; i < a.count; i += Math.max(1, Math.floor(a.count / 200))) {
          expect(b.getX(i)).toBe(a.getX(i));
          expect(b.getY(i)).toBe(a.getY(i));
          expect(b.getZ(i)).toBe(a.getZ(i));
        }
      }
    }
  });

  it('builds nothing for a parcel with no interior', () => {
    const plain = plan.parcels.find((parcel) => !parcel.enterable);
    expect(plain).toBeDefined();
    if (!plain) return;
    const sink = build(plain);
    expect(sink.geometries.length).toBe(0);
    expect(sink.colliders.length).toBe(0);
    expect(sink.lights.length).toBe(0);
    expect(sink.interactions.length).toBe(0);
  });
});
