/**
 * The sea layer's distance curve.
 *
 * This is the regression guard for "the sea sound follows the player
 * everywhere". It runs in plain Node against the real city plan and the real
 * terrain functions, with no WebGL, no Web Audio and no mocks, because the
 * whole point of `seaAudibility.ts` is that the level is decided by geometry
 * rather than by the mixer.
 *
 * Coordinates are read out of `CityPlan`/`elevation` wherever the plan defines
 * them, so moving Harbour Walk, Lantern Park or the waterline fails this file
 * instead of silently retuning the mix.
 */

import { describe, expect, it } from 'vitest';

import { INDOOR_DUCK_DB } from '../src/audio/AudioDirector';
import {
  SEA_FULL_DISTANCE,
  SEA_SILENT_DISTANCE,
  seaGain,
  shoreDistance,
} from '../src/audio/seaAudibility';
import { getCityPlan } from '../src/world/CityPlan';
import { CityGround } from '../src/world/CityGround';
import { SEAWALL_X, WORLD_BOUNDS, shorelineX } from '../src/world/elevation';

const plan = getCityPlan();
const ground = new CityGround(plan);

function street(id: string): number {
  const found = plan.streets.find((s) => s.id === id);
  if (!found) throw new Error(`no street ${id}`);
  return found.position;
}

/** Every z in the playable world, at 2 m spacing. */
function zSamples(): number[] {
  const out: number[] = [];
  for (let z = WORLD_BOUNDS.minZ; z <= WORLD_BOUNDS.maxZ; z += 2) out.push(z);
  return out;
}

const HARBOUR_WALK_X = street('harbour-walk');
const CANNERY_ROW_X = street('cannery-row');
const LANTERN_PARK = plan.blocks.find((b) => b.kind === 'park');
const FOUNTAIN = plan.landmarks.find((l) => l.id === 'park-fountain');

function gainToDb(gain: number): number {
  return 20 * Math.log10(gain);
}

describe('shoreDistance', () => {
  it('is zero out on the water and grows going east', () => {
    for (const z of zSamples()) {
      const shore = shorelineX(z);
      expect(shoreDistance(shore - 40, z)).toBe(0);
      expect(shoreDistance(shore, z)).toBe(0);
      expect(shoreDistance(shore + 25, z)).toBeCloseTo(25, 9);
    }
  });

  it('measures from the moving waterline, not from a fixed x', () => {
    // The shoreline wobbles by 19.5 m across the map, so two points at the same
    // x are genuinely different distances from the water.
    const distances = zSamples().map((z) => shoreDistance(HARBOUR_WALK_X, z));
    expect(Math.max(...distances) - Math.min(...distances)).toBeGreaterThan(15);
  });
});

describe('sea gain curve', () => {
  it('is full level everywhere on the promenade and the beach', () => {
    for (const z of zSamples()) {
      // Harbour Walk's whole corridor, carriageway and both pavements.
      for (let x = HARBOUR_WALK_X - 12; x <= HARBOUR_WALK_X + 12; x += 1) {
        expect(seaGain(x, z), `promenade x=${x} z=${z}`).toBeGreaterThan(0.7);
      }
      expect(seaGain(HARBOUR_WALK_X, z), `centreline z=${z}`).toBe(1);
      expect(seaGain(SEAWALL_X, z), `seawall z=${z}`).toBe(1);
      expect(seaGain(shorelineX(z) + 4, z), `beach z=${z}`).toBe(1);
    }
  });

  it('is full level at the player spawn', () => {
    expect(seaGain(plan.spawn.x, plan.spawn.z)).toBe(1);
  });

  it('is exactly silent in Lantern Park', () => {
    expect(LANTERN_PARK).toBeDefined();
    expect(FOUNTAIN).toBeDefined();
    const rect = LANTERN_PARK?.rect;
    if (!rect || !FOUNTAIN) return;

    // The park really is the far side of the city, so this is not vacuous.
    expect(shoreDistance(rect.minX, rect.minZ)).toBeGreaterThan(250);
    expect(seaGain(FOUNTAIN.x, FOUNTAIN.z)).toBe(0);

    for (let x = rect.minX; x <= rect.maxX; x += 2) {
      for (let z = rect.minZ; z <= rect.maxZ; z += 2) {
        expect(seaGain(x, z), `park x=${x} z=${z}`).toBe(0);
      }
    }
  });

  it('is exactly silent on the east ridge', () => {
    for (let x = street('east-circuit') - 12; x <= WORLD_BOUNDS.maxX; x += 2) {
      for (const z of zSamples()) {
        expect(seaGain(x, z), `ridge x=${x} z=${z}`).toBe(0);
      }
    }
  });

  it('is inaudible east of Cannery Row and exactly silent from Meridian Avenue', () => {
    // The assertion that kills the reported defect: nowhere in the city core,
    // the civic quarter, the old quarter's east half or the outskirts can the
    // sea be heard. Cannery Row is 112-132 m from the water depending on z, so
    // where the shoreline bulges east (z = 78, x = -186.4) its far kerb is
    // still on the last shoulder of the curve rather than past it. The measured
    // worst case over this whole region is -35.5 dB, at exactly that point.
    for (let x = CANNERY_ROW_X + 7; x <= WORLD_BOUNDS.maxX; x += 2) {
      for (const z of zSamples()) {
        expect(seaGain(x, z), `inland x=${x} z=${z}`).toBeLessThan(0.032);
      }
    }

    for (let x = street('meridian-avenue') - 8; x <= WORLD_BOUNDS.maxX; x += 2) {
      for (const z of zSamples()) {
        expect(seaGain(x, z), `inland x=${x} z=${z}`).toBe(0);
      }
    }
  });

  it('falls off monotonically and without a step', () => {
    for (const z of zSamples()) {
      let previous = 1;
      for (let x = shorelineX(z); x <= shorelineX(z) + 200; x += 0.25) {
        const gain = seaGain(x, z);
        expect(gain, `monotonic at x=${x} z=${z}`).toBeLessThanOrEqual(previous + 1e-12);
        // 0.25 m of walking may never audibly jump the level.
        expect(previous - gain, `step at x=${x} z=${z}`).toBeLessThan(0.01);
        previous = gain;
      }
      expect(previous).toBe(0);
    }
  });

  it('pins the curve to its documented edges', () => {
    const z = 0;
    const shore = shorelineX(z);
    expect(seaGain(shore + SEA_FULL_DISTANCE, z)).toBe(1);
    expect(seaGain(shore + SEA_FULL_DISTANCE + 0.5, z)).toBeLessThan(1);
    expect(seaGain(shore + SEA_SILENT_DISTANCE - 0.5, z)).toBeGreaterThan(0);
    expect(seaGain(shore + SEA_SILENT_DISTANCE, z)).toBe(0);

    // The measured profile recorded in seaAudibility.ts.
    expect(gainToDb(seaGain(shore + 57.9, z))).toBeCloseTo(-2.5, 1);
    expect(gainToDb(seaGain(shore + 68.4, z))).toBeCloseTo(-5.1, 1);
    expect(gainToDb(seaGain(shore + 112.4, z))).toBeCloseTo(-26.7, 1);
  });
});

describe('sea gain against the walkable surfaces', () => {
  it('is full level on every surface that touches the water', () => {
    // sand, boardwalk and water no longer override the ambience bed, so the
    // distance curve has to cover them on its own.
    let checked = 0;
    for (const z of zSamples()) {
      for (let x = WORLD_BOUNDS.minX; x < CANNERY_ROW_X; x += 1) {
        const { surface } = ground.sample(x, z);
        if (surface !== 'sand' && surface !== 'boardwalk' && surface !== 'water') continue;
        checked += 1;
        expect(seaGain(x, z), `${surface} at x=${x} z=${z}`).toBeGreaterThan(0.7);
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe('interiors', () => {
  const duck = Math.pow(10, INDOOR_DUCK_DB / 20);

  function centre(district: string): { x: number; z: number } {
    const parcel = plan.parcels.find((p) => p.enterable && p.district === district);
    if (!parcel) throw new Error(`no enterable parcel in ${district}`);
    return {
      x: (parcel.rect.minX + parcel.rect.maxX) / 2,
      z: (parcel.rect.minZ + parcel.rect.maxZ) / 2,
    };
  }

  it('leaves a shorefront interior a muffled but audible bay', () => {
    const cafe = centre('harbourside');
    const indoors = seaGain(cafe.x, cafe.z) * duck;
    expect(indoors).toBeGreaterThan(0);
    // Present, but a long way under the outdoor level at the same spot.
    expect(gainToDb(indoors)).toBeLessThan(-12);
    expect(gainToDb(indoors)).toBeGreaterThan(-30);
  });

  it('leaves every inland interior silent', () => {
    for (const district of ['civic', 'core', 'ridge', 'oldQuarter']) {
      const inside = centre(district);
      expect(seaGain(inside.x, inside.z) * duck, `${district} interior`).toBe(0);
    }
  });
});
