import { describe, expect, it } from 'vitest';

import { rectDepth, rectWidth } from '../src/core/mathx';
import { CityGround } from '../src/world/CityGround';
import {
  blockSurfaceY,
  corridorHalfWidth,
  getCityPlan,
  type Parcel,
} from '../src/world/CityPlan';
import {
  gradientAt,
  groundElevation,
  landElevation,
  SEA_LEVEL,
} from '../src/world/elevation';

/** Default walking speed used by the first-person controller, in metres/second. */
const WALK_SPEED = 2.8;

const plan = getCityPlan();
const ground = new CityGround(plan);

function overlaps(a: Parcel, b: Parcel, tolerance = 0.05): boolean {
  return (
    a.rect.minX < b.rect.maxX - tolerance &&
    b.rect.minX < a.rect.maxX - tolerance &&
    a.rect.minZ < b.rect.maxZ - tolerance &&
    b.rect.minZ < a.rect.maxZ - tolerance
  );
}

describe('city plan', () => {
  it('is deterministic across builds', () => {
    const again = getCityPlan();
    expect(again.parcels.length).toBe(plan.parcels.length);
    expect(again.parcels[10]?.rect).toEqual(plan.parcels[10]?.rect);
  });

  it('has a dense, varied building stock', () => {
    expect(plan.parcels.length).toBeGreaterThanOrEqual(90);
    const archetypes = new Set(plan.parcels.map((p) => p.archetype));
    expect(archetypes.size).toBeGreaterThanOrEqual(7);
    const districts = new Set(plan.parcels.map((p) => p.district));
    expect(districts.size).toBe(6);
  });

  it('produces buildings of believable size', () => {
    for (const parcel of plan.parcels) {
      const w = rectWidth(parcel.rect);
      const d = rectDepth(parcel.rect);
      expect(w).toBeGreaterThan(5);
      expect(d).toBeGreaterThan(5);
      expect(w).toBeLessThan(70);
      expect(d).toBeLessThan(40);
      const height =
        parcel.groundStoreyHeight + (parcel.storeys - 1) * parcel.storeyHeight;
      expect(height).toBeGreaterThan(5);
      expect(height).toBeLessThan(90);
    }
  });

  it('never overlaps two buildings', () => {
    const sorted = [...plan.parcels].sort((a, b) => a.rect.minX - b.rect.minX);
    for (let i = 0; i < sorted.length; i += 1) {
      const a = sorted[i] as Parcel;
      for (let j = i + 1; j < sorted.length; j += 1) {
        const b = sorted[j] as Parcel;
        if (b.rect.minX >= a.rect.maxX) break;
        expect(overlaps(a, b), `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });

  it('keeps every building clear of the carriageway', () => {
    for (const parcel of plan.parcels) {
      for (const street of plan.streets) {
        const nearMin = street.axis === 'x' ? parcel.rect.minX : parcel.rect.minZ;
        const nearMax = street.axis === 'x' ? parcel.rect.maxX : parcel.rect.maxZ;
        const alongMin = street.axis === 'x' ? parcel.rect.minZ : parcel.rect.minX;
        const alongMax = street.axis === 'x' ? parcel.rect.maxZ : parcel.rect.maxX;
        if (alongMax < street.from || alongMin > street.to) continue;
        const overlapsCorridor =
          nearMin < street.position + corridorHalfWidth(street) - 0.01 &&
          nearMax > street.position - corridorHalfWidth(street) + 0.01;
        expect(
          overlapsCorridor,
          `${parcel.id} intrudes into ${street.id}`,
        ).toBe(false);
      }
    }
  });

  it('grounds every building without burying or floating it', () => {
    for (const parcel of plan.parcels) {
      const block = plan.blocks.find((b) => b.id === parcel.blockId);
      expect(block, parcel.id).toBeDefined();
      if (!block) continue;
      // Sample the surface the building actually stands on, across its whole
      // footprint - not just its corners - so a bulge in the middle is caught.
      let lowest = Infinity;
      let highest = -Infinity;
      for (let u = 0; u <= 1.0001; u += 0.25) {
        for (let v = 0; v <= 1.0001; v += 0.25) {
          const y = blockSurfaceY(
            block,
            parcel.rect.minX + (parcel.rect.maxX - parcel.rect.minX) * u,
            parcel.rect.minZ + (parcel.rect.maxZ - parcel.rect.minZ) * v,
          );
          lowest = Math.min(lowest, y);
          highest = Math.max(highest, y);
        }
      }
      // Finished floor is at or above every bit of ground under the footprint,
      // so no corner of the building can be swallowed by the hill.
      expect(parcel.groundY, `${parcel.id} is buried`).toBeGreaterThanOrEqual(highest);
      // The plinth reaches below the lowest ground, so no corner can float.
      expect(parcel.baseY, `${parcel.id} floats`).toBeLessThan(lowest);
      // Plinths stay plausible rather than becoming towers of their own.
      expect(parcel.groundY - parcel.baseY).toBeLessThan(4.5);
      expect(parcel.groundY).toBeGreaterThan(SEA_LEVEL + 1);
    }
  });

  it('puts the front door within a step of its pavement', () => {
    for (const parcel of plan.parcels) {
      const street = plan.streets.find((s) => s.id === parcel.frontStreetId);
      expect(street).toBeDefined();
      const centreX = (parcel.rect.minX + parcel.rect.maxX) / 2;
      const centreZ = (parcel.rect.minZ + parcel.rect.maxZ) / 2;
      const along = street?.axis === 'x' ? centreZ : centreX;
      const pavement =
        street?.axis === 'x'
          ? landElevation(street.position, along)
          : landElevation(along, street?.position ?? 0);
      // At most one flight of steps between pavement and threshold.
      expect(parcel.groundY - pavement).toBeGreaterThan(0);
      expect(parcel.groundY - pavement).toBeLessThan(2.6);
    }
  });

  it('walks the outer circuit in five to eight minutes', () => {
    const minutes = plan.circuitLength / WALK_SPEED / 60;
    expect(minutes).toBeGreaterThanOrEqual(5);
    expect(minutes).toBeLessThanOrEqual(8);
  });

  it('connects every street to at least two others', () => {
    for (const street of plan.streets) {
      const crossings = plan.streets.filter((other) => {
        if (other.axis === street.axis) return false;
        const alongOk = other.position >= street.from && other.position <= street.to;
        const otherOk = street.position >= other.from && street.position <= other.to;
        return alongOk && otherOk;
      });
      expect(crossings.length, `${street.id} is poorly connected`).toBeGreaterThanOrEqual(2);
    }
  });

  it('offers several enterable buildings across the city', () => {
    const enterable = plan.parcels.filter((p) => p.enterable);
    expect(enterable.length).toBeGreaterThanOrEqual(5);
    expect(new Set(enterable.map((p) => p.district)).size).toBeGreaterThanOrEqual(4);
  });
});

describe('city ground', () => {
  it('spawns the player on dry, walkable land', () => {
    const sample = ground.sample(plan.spawn.x, plan.spawn.z);
    expect(sample.surface).not.toBe('water');
    expect(sample.y).toBeGreaterThan(SEA_LEVEL + 0.5);
    expect(ground.isBuilt(plan.spawn.x, plan.spawn.z)).toBe(false);
  });

  it('keeps road camber within a believable range', () => {
    // Carriageways follow the terrain rather than being flattened, so they do
    // carry a cross-fall. It has to stay in camber territory, not banking.
    for (const street of plan.streets) {
      const along = (street.from + street.to) / 2;
      const inner = street.position - street.roadHalf;
      const outer = street.position + street.roadHalf;
      const a = street.axis === 'x' ? ground.sample(inner, along) : ground.sample(along, inner);
      const b = street.axis === 'x' ? ground.sample(outer, along) : ground.sample(along, outer);
      const fall = Math.abs(a.y - b.y) / (street.roadHalf * 2);
      expect(fall, `${street.id} cross-fall is ${(fall * 100).toFixed(1)}%`).toBeLessThan(0.04);
    }
  });

  it('keeps the walking grade comfortable everywhere in the grid', () => {
    let worst = 0;
    for (let x = -170; x < 175; x += 2.5) {
      for (let z = -160; z < 140; z += 2.5) {
        worst = Math.max(worst, gradientAt(x, z));
      }
    }
    expect(worst, `steepest grade ${(worst * 100).toFixed(1)}%`).toBeLessThan(0.06);
  });

  it('never returns a step a walker could not climb on walkable ground', () => {
    // Only outdoor walkable points matter: the inside of a building footprint
    // is served by its own floor, not by the ground field.
    const walkable = (x: number, z: number): boolean =>
      !ground.isBuilt(x, z) && ground.sample(x, z).surface !== 'water';
    let worst = 0;
    let worstAt = '';
    for (let z = -150; z < 130; z += 2.5) {
      for (let x = -158; x < 162; x += 0.25) {
        if (!walkable(x, z) || !walkable(x + 0.25, z)) continue;
        const step = Math.abs(ground.sample(x, z).y - ground.sample(x + 0.25, z).y);
        if (step > worst) {
          worst = step;
          worstAt = `${x.toFixed(1)}, ${z.toFixed(1)}`;
        }
      }
    }
    // The controller can step up 0.45 m; anything taller needs built stairs.
    expect(worst, `worst step ${worst.toFixed(2)}m at ${worstAt}`).toBeLessThanOrEqual(0.45);
  });

  it('never lays a street over the beach slope or the water', () => {
    // The regression this guards: the shoreline curve once reached x = -166.5,
    // while Harbour Walk's corridor runs from -172 to -148. The beach slope
    // therefore began underneath the promenade - the carriageway is drawn at
    // land height, so the whole road hung in the air above the sand.
    for (const street of plan.streets) {
      const half = corridorHalfWidth(street);
      for (let along = street.from; along <= street.to; along += 4) {
        for (let t = -1; t <= 1; t += 0.25) {
          const across = street.position + t * half;
          const x = street.axis === 'x' ? across : along;
          const z = street.axis === 'x' ? along : across;
          const drop = landElevation(x, z) - groundElevation(x, z);
          expect(
            drop,
            `${street.id} is unsupported by ${drop.toFixed(2)}m at ${x.toFixed(1)}, ${z.toFixed(1)}`,
          ).toBeLessThan(0.02);
        }
      }
    }
  });

  it('reports water in the bay and land in the city', () => {
    expect(ground.sample(-224, 0).surface).toBe('water');
    expect(ground.sample(0, -40).surface).not.toBe('water');
  });

  it('classifies surfaces the footstep mixer relies on', () => {
    const surfaces = new Set<string>();
    // Starts out in the bay: the waterline sits west of the promenade wall.
    for (let x = -215; x < 170; x += 3.5) {
      for (let z = -165; z < 145; z += 3.5) {
        surfaces.add(ground.sample(x, z).surface);
      }
    }
    for (const expected of ['asphalt', 'pavement', 'grass', 'water', 'boardwalk']) {
      expect(surfaces.has(expected), `missing surface ${expected}`).toBe(true);
    }
  });
});
