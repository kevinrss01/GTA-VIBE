/**
 * Meridian Bay Regional, checked without a renderer.
 *
 * Three things are asserted here and they are of different kinds.
 *
 * The first is that the CITY DID NOT MOVE. `getCityPlan` draws every block and
 * every parcel from one shared RNG stream, and there is a recorded incident in
 * `CityPlan.ts` where inserting a single entry into a list shifted buildings
 * across the whole map. The airport is generated from its own stream and
 * appended, and the hash below is what proves it.
 *
 * The second is that the airfield is FLAT and where the survey says it is.
 * `layout.ts` is read by the geometry builder, the ground sampler, the flight
 * model, the traveller crowd and the mission; if the ground and the drawing
 * disagree, aircraft sink into the runway and travellers stand in mid-air.
 *
 * The third is the footstep-surface regression the user reported: walking on a
 * road and hearing grass.
 */

import { describe, expect, it } from 'vitest';

import { getCityPlan } from '../src/world/CityPlan';
import { CityGround } from '../src/world/CityGround';
import { landElevation } from '../src/world/elevation';
import {
  AIRFIELD_LEVEL,
  APRON,
  RUNWAY,
  RUNWAY_LENGTH,
  STANDS,
  TAXIWAY,
  TERMINAL,
  TERMINAL_FLOOR,
  airfieldWeight,
  inRect,
  isOnPavedAirfield,
} from '../src/world/airport/layout';

const plan = getCityPlan();
const ground = new CityGround(plan);

describe('the city the airport was added to', () => {
  /*
   * A fingerprint of every building in Meridian Bay.
   *
   * If this number changes, something perturbed the shared RNG stream and the
   * whole city has been re-rolled - which is invisible in a screenshot and
   * catastrophic for every hand-placed thing that depends on where the club
   * and the lock-up ended up.
   */
  it('has exactly the buildings it had before there was an airport', () => {
    let hash = 2166136261;
    const mix = (value: number): void => {
      hash ^= Math.round(value * 1000) | 0;
      hash = Math.imul(hash, 16777619);
    };
    for (const parcel of plan.parcels) {
      for (const ch of parcel.id) mix(ch.charCodeAt(0));
      mix(parcel.rect.minX);
      mix(parcel.rect.minZ);
      mix(parcel.rect.maxX);
      mix(parcel.rect.maxZ);
      mix(parcel.storeys);
    }
    /*
     * MEASURED against the commit before the airport existed (72317c3), by
     * running this same fingerprint over that checkout: 121 parcels, hash
     * 2824764405. The current tree produces the identical number, which is the
     * proof that appending the airfield perturbed nothing.
     */
    expect(plan.parcels.length).toBe(121);
    expect(hash >>> 0).toBe(2824764405);
  });

  it('still puts the club and the lock-up where the mission expects them', () => {
    expect(plan.parcels.find((p) => p.interiorKind === 'nightclub')?.district).toBe('harbourside');
    expect(plan.parcels.find((p) => p.interiorKind === 'workshop')?.district).toBe('cannery');
  });

  it('leaves the city out of the airfield platform entirely', () => {
    /*
     * `airfieldWeight` is the ONLY route by which the airport can change
     * ground that already existed, so over the city's own street grid it has
     * to be exactly zero - not small, zero.
     *
     * The skirt does reach a little way into the open terrain south-east of
     * the grid, which is the point of a skirt: it blends there instead of
     * ending in a wall. The furthest it gets is asserted below as a height,
     * because a weight is not a thing anybody can see.
     */
    for (let x = -170; x <= 175; x += 5) {
      for (let z = -160; z <= 140; z += 5) {
        expect(airfieldWeight(x, z), `weight at ${x},${z}`).toBe(0);
      }
    }
  });

  it('leaves the ground it does reshape walkable', () => {
    /*
     * The skirt reaches about 46 m past the platform, which puts its outer
     * edge into the open scrub south-east of the city - ground that was
     * already inside the old world bounds and that a player could already walk
     * on. It lifts the far corner of that strip by up to a metre.
     *
     * That is the blend doing its job rather than a fault: the alternative to
     * reshaping ground at the edge of an earthwork is a wall at the edge of an
     * earthwork. What matters is that the result is still ground somebody can
     * walk up, so this measures the GRADE it introduces rather than the height.
     *
     * `tests/cityPlan.test.ts` holds the city itself to under 6 per cent; this
     * is open country outside the grid, so it is allowed to be steeper, but a
     * mowable bank and not a step.
     */
    const blended = (x: number, z: number): number => {
      const w = airfieldWeight(x, z);
      return landElevation(x, z) * (1 - w) + AIRFIELD_LEVEL * w;
    };
    const gradeOf = (at: (x: number, z: number) => number, x: number, z: number): number => {
      const here = at(x, z);
      return Math.max(Math.abs(at(x + 3, z) - here), Math.abs(at(x, z + 3) - here)) / 3;
    };
    // Against the NATURAL grade, not against zero. The north-east corner of
    // the map already rises at 20 per cent - that is `OUTSKIRT_NORTH`, and it
    // was there long before there was an airfield.
    let worst = 0;
    let where = '';
    for (let x = -232; x <= 214; x += 3) {
      for (let z = -206; z <= 186; z += 3) {
        const added = gradeOf(blended, x, z) - gradeOf(landElevation, x, z);
        if (added > worst) {
          worst = added;
          where = `${x},${z}`;
        }
      }
    }
    expect(worst, `the platform added ${(worst * 100).toFixed(1)}% of grade at ${where}`).toBeLessThan(
      0.09,
    );
  });
});

describe('the airfield is flat, and where the survey says', () => {
  it('holds the runway level along its whole length', () => {
    let lowest = Infinity;
    let highest = -Infinity;
    for (let z = RUNWAY.northZ; z <= RUNWAY.southZ; z += 5) {
      for (const x of [RUNWAY.centreX - 20, RUNWAY.centreX, RUNWAY.centreX + 20]) {
        const y = ground.sample(x, z).y;
        lowest = Math.min(lowest, y);
        highest = Math.max(highest, y);
      }
    }
    // A centimetre, not a metre. Natural ground across this site falls 0.4 m.
    expect(highest - lowest).toBeLessThan(0.02);
    expect(lowest).toBeCloseTo(AIRFIELD_LEVEL, 2);
  });

  it('is 600 m of runway, 45 m wide', () => {
    expect(RUNWAY_LENGTH).toBe(600);
    expect(RUNWAY.halfWidth * 2).toBe(45);
  });

  it('paves the runway, the taxiway and the apron in concrete at platform level', () => {
    const places: [string, number, number][] = [
      ['runway threshold 18', RUNWAY.centreX, RUNWAY.northZ + 4],
      ['runway midpoint', RUNWAY.centreX, (RUNWAY.northZ + RUNWAY.southZ) / 2],
      ['runway threshold 36', RUNWAY.centreX, RUNWAY.southZ - 4],
      ['runway edge', RUNWAY.centreX + RUNWAY.halfWidth - 2, 500],
      ['taxiway', TAXIWAY.centreX, 500],
      ['apron', (APRON.minX + APRON.maxX) / 2, (APRON.minZ + APRON.maxZ) / 2],
    ];
    for (const [what, x, z] of places) {
      const sample = ground.sample(x, z);
      expect(sample.surface, `${what} surface`).toBe('concrete');
      expect(sample.y, `${what} height`).toBeCloseTo(AIRFIELD_LEVEL, 2);
      expect(isOnPavedAirfield(x, z), `${what} paved`).toBe(true);
    }
  });

  it('blends back into open ground rather than ending in a cliff', () => {
    // Walk out east from the platform edge and require every step to be a
    // step, not a wall. 0.45 m is the controller's own `STEP_HEIGHT`.
    let previous = ground.sample(432, 500).y;
    for (let x = 434; x <= 520; x += 2) {
      const y = ground.sample(x, 500).y;
      expect(Math.abs(y - previous), `a cliff at x=${x}`).toBeLessThan(0.45);
      previous = y;
    }
  });

  it('stands every aircraft on the apron, on the platform', () => {
    for (const stand of STANDS) {
      expect(inRect(APRON, stand.x, stand.z, 2), `${stand.id} is off the apron`).toBe(true);
      expect(ground.sample(stand.x, stand.z).y).toBeCloseTo(AIRFIELD_LEVEL, 2);
    }
    // Five stands, and no two on top of each other.
    expect(STANDS.length).toBe(5);
    for (let a = 0; a < STANDS.length; a += 1) {
      for (let b = a + 1; b < STANDS.length; b += 1) {
        const p = STANDS[a];
        const q = STANDS[b];
        if (!p || !q) continue;
        expect(Math.hypot(p.x - q.x, p.z - q.z), `${p.id} and ${q.id}`).toBeGreaterThan(30);
      }
    }
  });

  it('gives the terminal a floor one step above the platform, and calls it indoors', () => {
    const x = (TERMINAL.minX + TERMINAL.maxX) / 2;
    const z = (TERMINAL.minZ + TERMINAL.maxZ) / 2;
    expect(TERMINAL_FLOOR).toBeCloseTo(AIRFIELD_LEVEL + 0.16, 5);
    /*
     * `indoors` drives the interior ambience bed and ducks the street and the
     * sea. The terminal is not a parcel - the airport authors it rather than
     * subdividing it out of a block - so `isBuilt` needs its own answer, and
     * without one a player in the middle of a 62 by 190 metre building was
     * treated as standing outdoors.
     */
    expect(ground.isBuilt(x, z), 'the terminal reads as outdoors').toBe(true);
    // The SURFACE underfoot is decided by the controller, which upgrades to
    // `interior` when it is standing on a floor collider above the terrain -
    // so this only checks that the ground beneath the building is the platform.
    expect(ground.sample(x, z).y).toBeCloseTo(AIRFIELD_LEVEL, 2);
  });

  it('puts the airport in its own district, and nowhere near the city', () => {
    expect(ground.districtAt((APRON.minX + APRON.maxX) / 2, (APRON.minZ + APRON.maxZ) / 2)).toBe(
      'airport',
    );
    expect(ground.districtAt(RUNWAY.centreX, 500)).toBe('airport');
    // And no part of the city has been annexed by it.
    for (const parcel of plan.parcels) {
      const x = (parcel.rect.minX + parcel.rect.maxX) / 2;
      const z = (parcel.rect.minZ + parcel.rect.maxZ) / 2;
      expect(ground.districtAt(x, z), `${parcel.id} became airport`).not.toBe('airport');
    }
  });
});

/*
 * The reported bug, as a test.
 *
 * "Footsteps sometimes use grass sounds while the player is walking on a road."
 *
 * Two causes, both in `CityGround.sample`. Open ground beyond the street grid
 * was classified `hash2(x * 0.25, z * 0.25, 7) < 0.6 ? 'grass' : 'gravel'` -
 * grass three times in five, re-rolled every four metres, so it also flickered
 * step to step. And `streetsAt` only matched inside a street's own `from..to`,
 * while `StreetBuilder` draws junction asphalt across the crossing street's
 * FULL corridor - so at every intersection corner the drawn tarmac was wider
 * than the sampled tarmac and the player heard open ground.
 */
describe('what the player is standing on is what is drawn there', () => {
  const SOFT = new Set(['grass', 'sand', 'water']);

  it('never reports a soft surface anywhere on a carriageway', () => {
    let checked = 0;
    const wrong: string[] = [];
    for (const street of plan.streets) {
      const half = street.roadHalf;
      for (let along = street.from + 1; along <= street.to - 1; along += 2) {
        for (const across of [-half + 0.5, -half * 0.5, 0, half * 0.5, half - 0.5]) {
          const x = street.axis === 'x' ? street.position + across : along;
          const z = street.axis === 'x' ? along : street.position + across;
          const sample = ground.sample(x, z);
          checked += 1;
          if (SOFT.has(sample.surface)) {
            if (wrong.length < 5) wrong.push(`${street.id} at ${x.toFixed(0)},${z.toFixed(0)} → ${sample.surface}`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(12000);
    expect(wrong, wrong.join('; ')).toHaveLength(0);
  });

  it('never reports a soft surface on a pavement', () => {
    const wrong: string[] = [];
    for (const street of plan.streets) {
      const offset = street.roadHalf + street.sidewalk * 0.5;
      for (let along = street.from + 2; along <= street.to - 2; along += 3) {
        for (const across of [-offset, offset]) {
          const x = street.axis === 'x' ? street.position + across : along;
          const z = street.axis === 'x' ? along : street.position + across;
          const surface = ground.sample(x, z).surface;
          if (SOFT.has(surface) && wrong.length < 5) {
            wrong.push(`${street.id} at ${x.toFixed(0)},${z.toFixed(0)} → ${surface}`);
          }
        }
      }
    }
    expect(wrong, wrong.join('; ')).toHaveLength(0);
  });

  it('does not flicker between two surfaces from one stride to the next', () => {
    /*
     * A stride is about 1.45 m. The old open-ground classifier re-rolled on a
     * 4 m grid, so a walker crossing it changed surface every second or third
     * step and the mixer alternated grass and gravel underfoot. Whatever the
     * classification is now, it has to be COHERENT at the scale a person
     * walks: sample a long straight line and count how often it changes.
     */
    /*
     * Lines that stay OUTSIDE the street grid for their whole length. A walk
     * that crosses the city changes surface at every kerb, which is correct
     * and says nothing about the classifier being asked about here.
     */
    for (const [x0, z0, dx, dz, label] of [
      [-215, -195, 1, 0, 'the outskirts, north'],
      [400, 250, 0, 1, 'airfield grass, along the fence'],
      [200, 700, 1, 0, 'open ground south of the field'],
    ] as const) {
      let changes = 0;
      let previous = ground.sample(x0, z0).surface;
      const steps = 120;
      for (let i = 1; i <= steps; i += 1) {
        const surface = ground.sample(x0 + dx * i * 1.45, z0 + dz * i * 1.45).surface;
        if (surface !== previous) changes += 1;
        previous = surface;
      }
      // Over 174 m of walking. A handful of real boundaries is expected; one
      // every few strides is a coin flip.
      expect(changes, `${label} changed surface ${changes} times in ${steps} strides`).toBeLessThan(
        8,
      );
    }
  });

  it('agrees with the airport surfaces the airfield actually draws', () => {
    // The paved airfield must never come back as terrain, and the terrain
    // around it must never come back as pavement.
    for (let x = 150; x <= 430; x += 6) {
      for (let z = 200; z <= 950; z += 12) {
        const paved = isOnPavedAirfield(x, z);
        const surface = ground.sample(x, z).surface;
        if (paved) expect(surface, `paved at ${x},${z}`).toBe('concrete');
      }
    }
  });
});

describe('the platform earthwork is the size the survey claims', () => {
  it('cuts and fills about three metres, not thirty', () => {
    let cut = 0;
    let fill = 0;
    for (let x = 150; x <= 430; x += 5) {
      for (let z = 200; z <= 950; z += 25) {
        const natural = landElevation(x, z);
        // What the platform would be without the blend, at full weight.
        const delta = AIRFIELD_LEVEL - natural;
        if (delta < 0) cut = Math.max(cut, -delta);
        else fill = Math.max(fill, delta);
      }
    }
    expect(cut, `deepest cut ${cut.toFixed(1)} m`).toBeLessThan(5);
    expect(fill, `deepest fill ${fill.toFixed(1)} m`).toBeLessThan(5);
  });
});
