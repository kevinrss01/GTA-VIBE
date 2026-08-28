/**
 * Nothing solid may stand where an aircraft has to taxi.
 *
 * ## The defect
 *
 * `apronEquipment` placed a ground power unit at a flat `stand.x + 9.5`. Every
 * stand at Meridian Bay Regional faces +X, so on stand 3 that put the cart's
 * near face at x = 248.5 with the parked twin turboprop's nose at 247.9 - 0.6 m
 * of clearance, directly across the only way off the stand. Measured in a
 * production build before the fix: the twin at full throttle for five seconds
 * moved exactly 0.60 m and stopped at 0.000 m/s, `crashed: false`, and nothing
 * was reported to the player. It stopped at the cart's own `minX`, not at a
 * tuned number. The business jet on stand 2 got out only because its longer
 * fuselage already contained the cart and a containment waiver let it through -
 * the same bug with a luckier outcome.
 *
 * ## What is asserted
 *
 * Not "the ground power unit is somewhere else", which would pass the next time
 * somebody dresses the apron. The invariant: for every stand, the box the
 * parked aircraft sweeps taxiing out contains no solid prop collider, and no
 * prop stands inside the fuselage it is meant to be serving.
 *
 * The envelope table in `plan.ts` is deliberately not imported from the
 * aircraft catalogue - the world builder must not pull `AircraftSystem`, and
 * therefore Three.js, into itself - so this test reads BOTH and fails if the
 * table ever stops covering the fleet that is actually parked.
 */

import { describe, expect, it } from 'vitest';

import { AIRCRAFT } from '../src/air/AircraftCatalogue';
import { STAND_FLEET } from '../src/air/AircraftSystem';
import { getCityPlan } from '../src/world/CityPlan';
import { CityGround } from '../src/world/CityGround';
import { RecordingSink } from '../src/world/validate';
import { STANDS, type AirportRect } from '../src/world/airport/layout';
import {
  STAND_ENVELOPE,
  STAND_WINGTIP_CLEARANCE,
  standForward,
  standFuselage,
  standTaxiCorridor,
} from '../src/world/airport/plan';
import { scatterAirportProps } from '../src/world/airport/props';
import { PROP_SPECS } from '../src/world/build/PropLibrary';
import type { ColliderBox } from '../src/world/build/types';

const plan = getCityPlan();
const ground = new CityGround(plan);
const sink = new RecordingSink();
scatterAirportProps(ground, sink);

function overlaps(a: AirportRect, b: AirportRect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
}

function rectOf(box: ColliderBox): AirportRect {
  return { minX: box.minX, maxX: box.maxX, minZ: box.minZ, maxZ: box.maxZ };
}

/** How far short of a rectangle a box stops, or a negative overlap depth. */
function describeBox(box: ColliderBox): string {
  return `x ${box.minX.toFixed(1)}..${box.maxX.toFixed(1)}, z ${box.minZ.toFixed(1)}..${box.maxZ.toFixed(1)}`;
}

describe('the stand envelope covers the aircraft actually parked on it', () => {
  it('reaches past the nose and the wingtips of every type in the fleet', () => {
    for (const stand of STANDS) {
      const type = STAND_FLEET[stand.id];
      expect(type, `${stand.id} has no aircraft`).toBeDefined();
      const spec = AIRCRAFT[type as keyof typeof AIRCRAFT];
      const env = STAND_ENVELOPE[stand.size];
      expect(
        env.halfLength,
        `${stand.id} (${spec.label}) is ${spec.length} m long; the ${stand.size} envelope reaches ${env.halfLength * 2} m`,
      ).toBeGreaterThanOrEqual(spec.length / 2);
      expect(
        env.halfSpan,
        `${stand.id} (${spec.label}) spans ${spec.span} m; the ${stand.size} envelope reaches ${env.halfSpan * 2} m`,
      ).toBeGreaterThanOrEqual(spec.span / 2);
    }
  });
});

describe('every stand has a clear way out', () => {
  /** Every solid prop collider the airport emits, in plan. */
  const solids = sink.colliders.filter((box) => box.solid).map(rectOf);

  it('emits colliders for the equipment at all', () => {
    // A test that passes because nothing was placed proves nothing.
    expect(solids.length).toBeGreaterThan(8);
  });

  it('leaves the taxi-out corridor of every stand empty', () => {
    const offenders: string[] = [];
    for (const stand of STANDS) {
      const corridor = standTaxiCorridor(stand);
      for (const box of sink.colliders) {
        if (!box.solid) continue;
        if (!overlaps(rectOf(box), corridor)) continue;
        offenders.push(`${stand.id}: a solid box at ${describeBox(box)} is in the taxi-out corridor`);
      }
    }
    expect(offenders.join('\n')).toBe('');
  });

  it('parks nothing inside the fuselage it is serving', () => {
    const offenders: string[] = [];
    for (const stand of STANDS) {
      const fuselage = standFuselage(stand);
      for (const box of sink.colliders) {
        if (!box.solid) continue;
        if (!overlaps(rectOf(box), fuselage)) continue;
        offenders.push(`${stand.id}: a solid box at ${describeBox(box)} is inside the aircraft`);
      }
    }
    expect(offenders.join('\n')).toBe('');
  });

  it('still dresses the worked stands, rather than clearing the apron', () => {
    // The fix must not have become "delete the equipment". Each of the three
    // worked stands keeps its own set within reach of the aircraft.
    for (const stand of STANDS.slice(0, 3)) {
      const near = sink.instances.filter(
        (p) => Math.hypot(p.x - stand.x, p.z - stand.z) < STAND_ENVELOPE[stand.size].halfSpan + 12,
      );
      expect(near.length, `${stand.id} has no ground equipment`).toBeGreaterThanOrEqual(2);
      expect(near.some((p) => p.prop === 'airStairs'), `${stand.id} has no airstair`).toBe(true);
      expect(near.some((p) => p.prop === 'gpuCart'), `${stand.id} has no ground power unit`).toBe(true);
    }
  });

  it('measures a real margin between the nose and the nearest thing in front of it', () => {
    /*
     * The corridor test above is a boolean. This is the number the defect was
     * reported as: how far an aircraft can roll before it meets something.
     * 0.6 m was the failure; the whole width of the apron is the fix.
     */
    for (const stand of STANDS) {
      const env = STAND_ENVELOPE[stand.size];
      const forward = standForward(stand);
      const nose = stand.x + Math.sign(forward.x) * env.halfLength;
      // Measured over the corridor's own length, not to the apron edge: the
      // apron ends 6.25 m past the heavy stand's nose and the taxiway starts
      // there, so the edge is a change of paving and not an obstruction.
      const REACH = 40;
      let nearest = REACH;
      for (const box of sink.colliders) {
        if (!box.solid) continue;
        if (box.maxZ < stand.z - env.halfSpan - STAND_WINGTIP_CLEARANCE) continue;
        if (box.minZ > stand.z + env.halfSpan + STAND_WINGTIP_CLEARANCE) continue;
        if (box.minX < nose) continue;
        nearest = Math.min(nearest, box.minX - nose);
      }
      expect(nearest, `${stand.id} can only roll ${nearest.toFixed(2)} m`).toBeGreaterThan(20);
    }
  });
});

describe('the equipment is still on the ground it is meant to be on', () => {
  it('keeps every prop inside the apron and off the runway', () => {
    for (const instance of sink.instances) {
      if (instance.prop !== 'airStairs' && instance.prop !== 'gpuCart' && instance.prop !== 'baggageTug') {
        continue;
      }
      const spec = PROP_SPECS[instance.prop];
      expect(spec, `${instance.prop} has no spec`).toBeDefined();
      // Everything the stands are dressed with belongs on the apron itself.
      if (instance.z < 300 || instance.z > 620) continue;
      expect(instance.x, `${instance.prop} is west of the apron`).toBeGreaterThan(214);
      expect(instance.x, `${instance.prop} is east of the apron`).toBeLessThan(267);
    }
  });
});
