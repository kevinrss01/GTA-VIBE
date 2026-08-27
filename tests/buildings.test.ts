/**
 * Building geometry invariants.
 *
 * Every parcel in the city plan is built through a recording sink, so these are
 * not spot checks: each assertion holds for all ~120 buildings at once. The
 * three that matter most are the horizontal bound (a building that oversails
 * its parcel is a building standing in the street), the vertical bound (nothing
 * floats above the ground or sinks below its plinth) and the triangle budget
 * (the whole point of merging geometry per material key).
 */

import { describe, expect, it } from 'vitest';
import type { BufferAttribute, BufferGeometry, Matrix4 } from 'three';

import type { MaterialKey } from '../src/render/materials';
import { getCityPlan, type ArchetypeId, type Parcel } from '../src/world/CityPlan';
import { buildBuilding } from '../src/world/build/BuildingFactory';
import type {
  ColliderBox,
  GeometrySink,
  InteractionPoint,
  LightRequest,
  PropKey,
} from '../src/world/build/types';

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

class RecordingSink implements GeometrySink {
  readonly geometries: { key: MaterialKey; geometry: BufferGeometry }[] = [];
  readonly instances: { prop: PropKey; matrix: Matrix4 }[] = [];
  readonly colliders: ColliderBox[] = [];
  readonly lights: LightRequest[] = [];
  readonly interactions: InteractionPoint[] = [];

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

  get triangles(): number {
    let total = 0;
    for (const entry of this.geometries) total += triangleCount(entry.geometry);
    return total;
  }

  get vertices(): number {
    let total = 0;
    for (const entry of this.geometries) {
      total += entry.geometry.getAttribute('position').count;
    }
    return total;
  }

  bounds(): Bounds | null {
    let out: Bounds | null = null;
    for (const entry of this.geometries) {
      const position = entry.geometry.getAttribute('position') as BufferAttribute;
      for (let i = 0; i < position.count; i += 1) {
        const x = position.getX(i);
        const y = position.getY(i);
        const z = position.getZ(i);
        if (!out) out = { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z };
        else {
          out.minX = Math.min(out.minX, x);
          out.maxX = Math.max(out.maxX, x);
          out.minY = Math.min(out.minY, y);
          out.maxY = Math.max(out.maxY, y);
          out.minZ = Math.min(out.minZ, z);
          out.maxZ = Math.max(out.maxZ, z);
        }
      }
    }
    return out;
  }
}

function triangleCount(geometry: BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return index.count / 3;
  return geometry.getAttribute('position').count / 3;
}

function roofHeightOf(parcel: Parcel): number {
  return parcel.groundY + parcel.groundStoreyHeight + (parcel.storeys - 1) * parcel.storeyHeight;
}

const plan = getCityPlan();

interface Built {
  parcel: Parcel;
  sink: RecordingSink;
  triangles: number;
  bounds: Bounds | null;
}

const built: Built[] = plan.parcels.map((parcel) => {
  const sink = new RecordingSink();
  buildBuilding(parcel, sink);
  return { parcel, sink, triangles: sink.triangles, bounds: sink.bounds() };
});

const cityTriangles = built.reduce((total, entry) => total + entry.triangles, 0);

describe('building geometry', () => {
  it('builds every parcel in the plan', () => {
    expect(built.length).toBe(plan.parcels.length);
    expect(built.length).toBeGreaterThanOrEqual(90);
  });

  it('emits geometry and a solid collider for every building', () => {
    for (const entry of built) {
      expect(entry.sink.geometries.length, `${entry.parcel.id} emitted nothing`).toBeGreaterThan(0);
      for (const { key, geometry } of entry.sink.geometries) {
        expect(triangleCount(geometry), `${entry.parcel.id}/${key} is empty`).toBeGreaterThan(0);
      }
      const solid = entry.sink.colliders.filter((c) => c.solid);
      expect(solid.length, `${entry.parcel.id} has no solid collider`).toBeGreaterThanOrEqual(1);
    }
  });

  it('gives every geometry position, normal and uv attributes', () => {
    for (const entry of built) {
      for (const { key, geometry } of entry.sink.geometries) {
        for (const attribute of ['position', 'normal', 'uv']) {
          expect(
            geometry.hasAttribute(attribute),
            `${entry.parcel.id}/${key} is missing ${attribute}`,
          ).toBe(true);
        }
        const position = geometry.getAttribute('position');
        expect(geometry.getAttribute('normal').count).toBe(position.count);
        expect(geometry.getAttribute('uv').count).toBe(position.count);
        expect(geometry.getIndex(), `${entry.parcel.id}/${key} is not indexed`).not.toBeNull();
      }
    }
  });

  it('never produces a non-finite vertex', () => {
    for (const entry of built) {
      for (const { key, geometry } of entry.sink.geometries) {
        const position = geometry.getAttribute('position') as BufferAttribute;
        const normal = geometry.getAttribute('normal') as BufferAttribute;
        for (let i = 0; i < position.count; i += 1) {
          const finite =
            Number.isFinite(position.getX(i)) &&
            Number.isFinite(position.getY(i)) &&
            Number.isFinite(position.getZ(i)) &&
            Number.isFinite(normal.getX(i)) &&
            Number.isFinite(normal.getY(i)) &&
            Number.isFinite(normal.getZ(i));
          expect(finite, `${entry.parcel.id}/${key} vertex ${i} is not finite`).toBe(true);
        }
      }
    }
  });

  it('keeps every building on its own plot', () => {
    // Cornices, balconies and entrance steps may oversail a little. Anything
    // more than this and the building is standing in the street.
    const allowance = 0.9;
    for (const { parcel, bounds } of built) {
      expect(bounds, parcel.id).not.toBeNull();
      if (!bounds) continue;
      expect(bounds.minX, `${parcel.id} spills west`).toBeGreaterThanOrEqual(parcel.rect.minX - allowance);
      expect(bounds.maxX, `${parcel.id} spills east`).toBeLessThanOrEqual(parcel.rect.maxX + allowance);
      expect(bounds.minZ, `${parcel.id} spills north`).toBeGreaterThanOrEqual(parcel.rect.minZ - allowance);
      expect(bounds.maxZ, `${parcel.id} spills south`).toBeLessThanOrEqual(parcel.rect.maxZ + allowance);
    }
  });

  it('keeps every building between its plinth and its roofline', () => {
    for (const { parcel, bounds } of built) {
      if (!bounds) continue;
      expect(bounds.minY, `${parcel.id} digs below its plinth`).toBeGreaterThanOrEqual(parcel.baseY - 0.01);
      // Parapets, crowns, chimneys and plant rooms all live in this allowance.
      expect(bounds.maxY, `${parcel.id} overshoots its roof`).toBeLessThanOrEqual(roofHeightOf(parcel) + 3);
    }
  });

  it('reaches the ground and the roof with its colliders', () => {
    for (const { parcel, sink, bounds } of built) {
      if (!bounds) continue;
      const solid = sink.colliders.filter((c) => c.solid);
      const bottom = Math.min(...solid.map((c) => c.bottom));
      const top = Math.max(...solid.map((c) => c.top));
      expect(bottom, `${parcel.id} collider floats`).toBeLessThanOrEqual(bounds.minY + 0.01);
      expect(top, `${parcel.id} collider is short`).toBeGreaterThanOrEqual(bounds.maxY - 0.01);
      // And it never claims volume the building does not occupy.
      expect(top, `${parcel.id} collider overshoots`).toBeLessThanOrEqual(bounds.maxY + 0.01);
      for (const box of sink.colliders) {
        expect(box.maxX - box.minX, `${parcel.id} degenerate collider`).toBeGreaterThan(0);
        expect(box.maxZ - box.minZ, `${parcel.id} degenerate collider`).toBeGreaterThan(0);
        expect(box.top, `${parcel.id} inverted collider`).toBeGreaterThan(box.bottom);
        expect(box.minX).toBeGreaterThanOrEqual(parcel.rect.minX - 0.9);
        expect(box.maxX).toBeLessThanOrEqual(parcel.rect.maxX + 0.9);
        expect(box.minZ).toBeGreaterThanOrEqual(parcel.rect.minZ - 0.9);
        expect(box.maxZ).toBeLessThanOrEqual(parcel.rect.maxZ + 0.9);
      }
    }
  });

  it('emits entrance steps as walkable platforms, not walls', () => {
    // A solid box across the doorway would make every stoop in the city an
    // obstacle; steps have to be the kind the controller can climb.
    for (const { parcel, sink } of built) {
      const walkable = sink.colliders.filter((c) => !c.solid);
      expect(walkable.length, `${parcel.id} has no threshold`).toBeGreaterThanOrEqual(1);
      for (const step of walkable) {
        expect(step.top, `${parcel.id} step above the floor`).toBeLessThanOrEqual(parcel.groundY + 0.01);
      }
    }
  });

  it('stays inside the city triangle budget', () => {
    expect(cityTriangles, `city total ${cityTriangles}`).toBeLessThan(320_000);
  });

  it('stays inside the per-building triangle budget', () => {
    for (const { parcel, triangles } of built) {
      expect(triangles, `${parcel.id} (${parcel.archetype}) costs ${triangles}`).toBeLessThan(6000);
      // A building this cheap would have to be a bare box.
      expect(triangles, `${parcel.id} is under-detailed`).toBeGreaterThan(200);
    }
  });

  it('merges geometry rather than emitting one mesh per feature', () => {
    for (const { parcel, sink } of built) {
      const keys = new Set(sink.geometries.map((entry) => entry.key));
      // One geometry per material key, never one per window.
      expect(sink.geometries.length, `${parcel.id} did not merge`).toBe(keys.size);
      expect(sink.geometries.length, `${parcel.id} uses too many materials`).toBeLessThanOrEqual(14);
    }
  });

  it('offers exactly one door to every enterable building', () => {
    for (const { parcel, sink } of built) {
      const doors = sink.interactions.filter((point) => point.kind === 'door');
      expect(doors.length, `${parcel.id} door count`).toBe(parcel.enterable ? 1 : 0);
      const door = doors[0];
      if (!door) continue;
      expect(door.parcelId).toBe(parcel.id);
      expect(door.prompt).toBe('Press E to enter');
      expect(door.radius).toBeGreaterThan(0);
      // The prompt has to be reachable from outside the building.
      const inside =
        door.x > parcel.rect.minX &&
        door.x < parcel.rect.maxX &&
        door.z > parcel.rect.minZ &&
        door.z < parcel.rect.maxZ;
      expect(inside, `${parcel.id} door prompt is inside the walls`).toBe(false);
    }
    const enterable = plan.parcels.filter((parcel) => parcel.enterable);
    expect(enterable.length).toBeGreaterThanOrEqual(5);
  });

  it('spends its light budget on a minority of shopfronts', () => {
    let lit = 0;
    for (const { parcel, sink } of built) {
      expect(sink.lights.length, `${parcel.id} light count`).toBeLessThanOrEqual(1);
      for (const light of sink.lights) {
        expect(light.priority).toBe(2);
        expect(light.distance).toBeGreaterThan(4);
        expect(light.y).toBeGreaterThan(parcel.groundY);
      }
      lit += sink.lights.length;
    }
    expect(lit).toBeGreaterThan(0);
    expect(lit / built.length, `${lit} of ${built.length} buildings are lit`).toBeLessThan(0.2);
  });

  it('puts believable clutter on the roofs', () => {
    const roofProps: ReadonlySet<PropKey> = new Set<PropKey>([
      'acUnit',
      'roofVent',
      'waterTank',
      'satelliteDish',
    ]);
    let roofed = 0;
    for (const { parcel, sink } of built) {
      const roofY = roofHeightOf(parcel);
      let onRoof = 0;
      for (const entry of sink.instances) {
        const x = entry.matrix.elements[12] ?? Number.NaN;
        const y = entry.matrix.elements[13] ?? Number.NaN;
        const z = entry.matrix.elements[14] ?? Number.NaN;
        expect(
          Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z),
          `${parcel.id} instance position`,
        ).toBe(true);
        expect(x).toBeGreaterThanOrEqual(parcel.rect.minX - 0.9);
        expect(x).toBeLessThanOrEqual(parcel.rect.maxX + 0.9);
        expect(z).toBeGreaterThanOrEqual(parcel.rect.minZ - 0.9);
        expect(z).toBeLessThanOrEqual(parcel.rect.maxZ + 0.9);
        expect(y).toBeGreaterThan(parcel.groundY - 0.5);
        expect(y).toBeLessThanOrEqual(roofY + 3);

        if (!roofProps.has(entry.prop) || y < roofY - 1) continue;
        onRoof += 1;
        // Plant perched on the coping is one of the clearest generated tells.
        expect(x, `${parcel.id} clutter on the parapet`).toBeGreaterThan(parcel.rect.minX + 0.3);
        expect(x).toBeLessThan(parcel.rect.maxX - 0.3);
        expect(z).toBeGreaterThan(parcel.rect.minZ + 0.3);
        expect(z).toBeLessThan(parcel.rect.maxZ - 0.3);
      }
      expect(onRoof, `${parcel.id} roof clutter`).toBeLessThanOrEqual(7);
      if (onRoof >= 2) roofed += 1;
    }
    expect(roofed / built.length).toBeGreaterThan(0.7);
  });

  it('faces its outside walls outward', () => {
    // A flipped winding is invisible in a triangle count and catastrophic on
    // screen: back-face culling turns the wall into a hole. Every triangle
    // lying in one of the four elevation planes has to face the street.
    for (const { parcel, sink } of built) {
      const planes = [
        { axis: 'x' as const, value: parcel.rect.minX, sign: -1 },
        { axis: 'x' as const, value: parcel.rect.maxX, sign: 1 },
        { axis: 'z' as const, value: parcel.rect.minZ, sign: -1 },
        { axis: 'z' as const, value: parcel.rect.maxZ, sign: 1 },
      ];
      for (const { key, geometry } of sink.geometries) {
        const position = geometry.getAttribute('position') as BufferAttribute;
        const normal = geometry.getAttribute('normal') as BufferAttribute;
        const index = geometry.getIndex();
        if (!index) continue;
        for (let t = 0; t < index.count; t += 3) {
          const a = index.getX(t);
          const b = index.getX(t + 1);
          const c = index.getX(t + 2);
          for (const plane of planes) {
            const at = (i: number) => (plane.axis === 'x' ? position.getX(i) : position.getZ(i));
            // Only geometry genuinely in the plane, not trim standing off it.
            const flat =
              Math.abs(at(a) - plane.value) < 0.005 &&
              Math.abs(at(b) - plane.value) < 0.005 &&
              Math.abs(at(c) - plane.value) < 0.005;
            if (!flat) continue;
            const n = plane.axis === 'x' ? normal.getX(a) : normal.getZ(a);
            // Reveal jambs sit in the plane but run perpendicular to it.
            if (Math.abs(n) < 0.5) continue;
            expect(
              Math.sign(n),
              `${parcel.id}/${key} faces inward on ${plane.axis}=${plane.value.toFixed(2)}`,
            ).toBe(plane.sign);
          }
        }
      }
    }
  });

  it('lines its windows up between storeys', () => {
    // Windows scattered independently per floor is the single most obvious
    // procedural tell on a façade. Every storey has to reuse the same columns.
    const skip: ReadonlySet<ArchetypeId> = new Set<ArchetypeId>([
      // These two replace openings with balcony recesses and setbacks, so
      // their columns legitimately move between floors.
      'apartmentSlab',
      'midriseOffice',
    ]);
    let checked = 0;
    for (const { parcel, sink } of built) {
      if (skip.has(parcel.archetype) || parcel.storeys < 3) continue;
      const alongAxis = parcel.facing === 'north' || parcel.facing === 'south' ? 'x' : 'z';
      const outward =
        parcel.facing === 'north' || parcel.facing === 'west' ? -1 : 1;
      const perStorey = new Map<number, Set<number>>();
      const groundTop = parcel.groundY + parcel.groundStoreyHeight;

      for (const { key, geometry } of sink.geometries) {
        if (key !== 'glassDark') continue;
        const position = geometry.getAttribute('position') as BufferAttribute;
        const normal = geometry.getAttribute('normal') as BufferAttribute;
        const index = geometry.getIndex();
        if (!index) continue;
        for (let t = 0; t < index.count; t += 3) {
          const a = index.getX(t);
          const nAlongPlane = alongAxis === 'x' ? normal.getZ(a) : normal.getX(a);
          if (Math.sign(nAlongPlane) !== outward || Math.abs(nAlongPlane) < 0.9) continue;
          let along = 0;
          let y = 0;
          for (const i of [a, index.getX(t + 1), index.getX(t + 2)]) {
            along += (alongAxis === 'x' ? position.getX(i) : position.getZ(i)) / 3;
            y += position.getY(i) / 3;
          }
          if (y < groundTop) continue;
          const storey = Math.floor((y - groundTop) / parcel.storeyHeight);
          const columns = perStorey.get(storey) ?? new Set<number>();
          columns.add(Math.round(along * 20) / 20);
          perStorey.set(storey, columns);
        }
      }

      if (perStorey.size < 2) continue;
      checked += 1;
      const union = new Set<number>();
      let widest = 0;
      for (const columns of perStorey.values()) {
        for (const value of columns) union.add(value);
        widest = Math.max(widest, columns.size);
      }
      // If every storey reuses the same columns the union is no larger than
      // the busiest storey. Anything more means the grid drifted.
      expect(union.size, `${parcel.id} (${parcel.archetype}) window columns drift`).toBeLessThanOrEqual(widest);
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('is deterministic', () => {
    for (const parcel of [plan.parcels[0], plan.parcels[37], plan.parcels[plan.parcels.length - 1]]) {
      if (!parcel) continue;
      const first = new RecordingSink();
      const second = new RecordingSink();
      buildBuilding(parcel, first);
      buildBuilding(parcel, second);
      expect(second.vertices, `${parcel.id} vertex count drifted`).toBe(first.vertices);
      expect(second.triangles).toBe(first.triangles);
      expect(second.geometries.length).toBe(first.geometries.length);
      expect(second.colliders.length).toBe(first.colliders.length);
      expect(second.instances.length).toBe(first.instances.length);
      expect(second.interactions.length).toBe(first.interactions.length);
    }
  });

  it('gives every archetype in the plan a modelled treatment', () => {
    const byArchetype = new Map<ArchetypeId, number[]>();
    for (const { parcel, triangles } of built) {
      const bucket = byArchetype.get(parcel.archetype) ?? [];
      bucket.push(triangles);
      byArchetype.set(parcel.archetype, bucket);
    }
    for (const [archetype, counts] of byArchetype) {
      const mean = counts.reduce((a, c) => a + c, 0) / counts.length;
      // Anything this cheap on average is a texture on a box, not a building.
      expect(mean, `${archetype} averages ${Math.round(mean)} triangles`).toBeGreaterThan(450);
    }
    expect(byArchetype.size).toBeGreaterThanOrEqual(7);
  });
});
