/**
 * How much a crash costs a car, as opposed to where the crash sends it.
 *
 * The defect this pins: damage was LINEAR IN IMPULSE from zero, so a 3 m/s
 * parking shunt between two saloons took a fifth of the shell and two ordinary
 * 8 m/s urban collisions wrote a car off. Cars were made of glass, and the only
 * way to make them tougher would have been to make them lighter as well,
 * because the one number did both jobs.
 *
 * What replaced it is in `collisionDamage`: severity is each shell's OWN
 * delta-v, there is a yield threshold below which the crush structure absorbs
 * everything, and past it the damage follows the energy. `crushShare` takes the
 * part of that delta-v which spins the car rather than deforming it back out
 * again, which is what separates a corner tap from a square hit.
 *
 * The two halves of a collision are tested separately here on purpose, because
 * separating them is the point: the impulse still decides where both cars go,
 * and nothing in the damage model may touch it.
 *
 * Arithmetic only. No renderer, no browser.
 */

import { describe, expect, it } from 'vitest';

import { buildRoadNetwork, lanePoint, type RoadNetwork } from '../src/city/RoadNetwork';
import { TrafficSim, type Vehicle } from '../src/traffic/TrafficSim';
import { VEHICLE_BLUEPRINTS } from '../src/traffic/VehicleCatalogue';
import type { CityPlan, Street } from '../src/world/CityPlan';
import {
  CRIPPLED_AT,
  DAMAGED_AT,
  SCUFFED_AT,
  SCUFF_SHARE,
  VEHICLE_INTEGRITY,
  WRITE_OFF_DELTA_V,
  YIELD_DELTA_V,
  collisionDamage,
  crushShare,
  vehicleCondition,
} from '../src/traffic/types';

// -- fixtures ---------------------------------------------------------------

function makePlan(streets: readonly Street[]): CityPlan {
  return {
    seed: 'test',
    streets,
    blocks: [],
    parcels: [],
    landmarks: [],
    circuit: [],
    circuitLength: 0,
    spawn: { x: 0, z: 0, heading: 0 },
    xLines: streets.filter((s) => s.axis === 'x'),
    zLines: streets.filter((s) => s.axis === 'z'),
  };
}

function street(overrides: Partial<Street> & Pick<Street, 'id' | 'axis' | 'position'>): Street {
  return {
    name: overrides.id,
    kind: 'secondary',
    from: -200,
    to: 200,
    roadHalf: 6,
    sidewalk: 3,
    lanes: 2,
    boardwalk: false,
    ...overrides,
  };
}

function makeSim(): { sim: TrafficSim; net: RoadNetwork; laneId: string } {
  const plan = makePlan([
    street({ id: 'a', axis: 'x', position: 0 }),
    street({ id: 'b', axis: 'z', position: 0 }),
  ]);
  const net = buildRoadNetwork(plan);
  const sim = new TrafficSim({
    network: net,
    plan,
    heightAt: () => 0,
    population: 0,
    seed: 'severity-test',
  });
  const lane = net.lanes.find((l) => l.streetId === 'a');
  if (!lane) throw new Error('no lane on street a');
  return { sim, net, laneId: lane.id };
}

function seed(sim: TrafficSim, laneId: string, along: number, speed: number): Vehicle {
  sim.resize(sim.vehicles.length + 1);
  const vehicle = sim.vehicles[sim.vehicles.length - 1] as Vehicle;
  const info = sim.laneMeta(laneId);
  if (!info) throw new Error(`no lane ${laneId}`);
  vehicle.kind = 'sedan';
  vehicle.blueprint = VEHICLE_BLUEPRINTS.sedan;
  vehicle.view.kind = 'sedan';
  vehicle.view.halfLength = vehicle.blueprint.length * 0.5;
  vehicle.view.halfWidth = vehicle.blueprint.width * 0.5;
  vehicle.view.halfHeight = vehicle.blueprint.height * 0.5;
  vehicle.laneId = laneId;
  vehicle.along = along;
  vehicle.speed = speed;
  vehicle.active = true;
  vehicle.control = 'ambient';
  vehicle.claim = null;
  vehicle.stuck = 0;
  const point = lanePoint(info.lane, along);
  vehicle.x = point.x;
  vehicle.z = point.z;
  vehicle.y = 0;
  vehicle.yaw = info.heading;
  vehicle.steer = 0;
  return vehicle;
}

function axes(vehicle: Vehicle): { fx: number; fz: number; rx: number; rz: number } {
  return {
    fx: -Math.sin(vehicle.yaw),
    fz: -Math.cos(vehicle.yaw),
    rx: Math.cos(vehicle.yaw),
    rz: -Math.sin(vehicle.yaw),
  };
}

/** Shell lost as a fraction, which is what the stages are quoted in. */
function lost(vehicle: Vehicle): number {
  return (VEHICLE_INTEGRITY - vehicle.integrity) / VEHICLE_INTEGRITY;
}

/**
 * A rig that runs a stationary saloon into the back of another one, again and
 * again, at whatever closing speed the caller asks for.
 *
 * The collision goes through the SIMULATION'S OWN path - a free body
 * penetrating another car, resolved by `exchangeImpulse` - rather than through
 * a hand-built `VehicleImpact`, so what is measured is the arithmetic the game
 * actually runs. The striker is a fresh car each time and is retired
 * immediately afterwards; the target accumulates.
 *
 * `offset` moves the striker sideways, so the same speed can arrive square on
 * the boot or on a rear corner.
 */
function rearEndRig(): {
  sim: TrafficSim;
  target: Vehicle;
  crash: (closing: number, offset?: number) => Vehicle;
} {
  const { sim, laneId } = makeSim();
  const target = seed(sim, laneId, 60, 0);
  // Detached, so nothing steers it away and its impulse is banked rather than
  // spent - the damage still lands the moment the collision is resolved.
  sim.detach(target);
  let time = 0;

  const crash = (closing: number, offset = 0): Vehicle => {
    const striker = seed(sim, laneId, 20, 0);
    // A weightless shove is the only way in to the free-body path from
    // outside; `damage: 0` keeps it out of the measurement.
    sim.applyImpact(striker.id, {
      x: striker.x,
      y: 0.6,
      z: striker.z,
      dirX: 1,
      dirZ: 0,
      impulse: 5000,
      damage: 0,
    });
    expect(striker.control, 'the striker must be a free body to collide').toBe('loose');
    striker.impactCooldown = 0;
    target.impactCooldown = 0;
    const { fx, fz, rx, rz } = axes(target);
    // Overlapping by 15 cm, so the contact resolves on the first step before
    // drag has taken anything meaningful off the closing speed.
    const gap = target.blueprint.length - 0.15;
    striker.yaw = target.yaw;
    striker.x = target.x - fx * gap + rx * offset;
    striker.z = target.z - fz * gap + rz * offset;
    striker.vx = fx * closing;
    striker.vz = fz * closing;
    striker.yawRate = 0;
    striker.rollRate = 0;
    sim.update(1 / 60, target.x, target.z, time);
    time += 1 / 60;
    striker.active = false;
    return striker;
  };

  return { sim, target, crash };
}

// -- the calibration --------------------------------------------------------

describe('what an ordinary collision costs a car', () => {
  it('leaves a parking shunt to the bumpers', () => {
    const { target, crash } = rearEndRig();
    crash(3);
    // A couple of per cent at the very most: paint, and nothing structural.
    expect(lost(target)).toBeLessThan(0.02);
    expect(target.view.destroyed).toBe(false);
    expect(target.view.handling.destroyed).toBe(false);
    expect(target.view.handling.power).toBe(1);
    expect(target.view.handling.grip).toBe(1);
    expect(target.view.condition).toBe('pristine');
  });

  it('leaves both cars drivable after an ordinary urban collision', () => {
    const { target, crash } = rearEndRig();
    const striker = crash(8);
    // 8 m/s closing is 29 km/h between two cars: real damage, not a write-off.
    for (const car of [target, striker]) {
      expect(lost(car), `${car.id} lost ${(lost(car) * 100).toFixed(0)} %`).toBeGreaterThan(0.1);
      expect(lost(car)).toBeLessThan(0.25);
      expect(car.view.destroyed).toBe(false);
      expect(car.view.handling.destroyed).toBe(false);
      expect(car.view.handling.power, 'still has an engine').toBeGreaterThan(0);
      expect(car.view.condition).not.toBe('wrecked');
    }
  });

  it('does not mark a healthy body destroyed after one ordinary collision', () => {
    // The specific regression: one 8 m/s hit used to cost 56 % of the shell,
    // and two of them wrote a perfectly good physics body off.
    const { sim, target, crash } = rearEndRig();
    crash(8);
    crash(8);
    expect(target.integrity).toBeGreaterThan(VEHICLE_INTEGRITY * 0.5);
    expect(target.view.destroyed).toBe(false);
    expect(target.view.handling.power).toBe(1);

    // And it is still a car: handed back to the traffic AI it drives away
    // rather than being treated as a wreck.
    sim.attach(target);
    for (let i = 0; i < 60 * 4; i += 1) sim.update(1 / 60, target.x, target.z, i / 60);
    expect(target.control).toBe('ambient');
    expect(target.speed).toBeGreaterThan(2);
  });

  it('accumulates over repeated urban collisions until the shell is spent', () => {
    const { target, crash } = rearEndRig();
    const trail: number[] = [];
    while (!target.view.destroyed && trail.length < 20) {
      crash(8);
      trail.push(target.integrity);
      if (trail.length <= 2) {
        expect(target.view.destroyed, `written off after ${trail.length} hits`).toBe(false);
      }
    }
    // Strictly progressive, never a step backwards.
    for (let i = 1; i < trail.length; i += 1) {
      expect(trail[i] as number).toBeLessThan(trail[i - 1] as number);
    }
    // Several ordinary collisions is what it takes, and nothing about any one
    // of them was fatal on its own. Six at 17 % of the shell each.
    expect(trail.length, `wrecked after ${trail.length} hits at 8 m/s`).toBeGreaterThanOrEqual(5);
    expect(trail.length).toBeLessThanOrEqual(8);
    expect(target.view.destroyed).toBe(true);
    expect(target.view.condition).toBe('wrecked');
  });

  it('writes a car off in one severe head-on', () => {
    const { target, crash } = rearEndRig();
    crash(22);
    expect(target.integrity).toBe(0);
    expect(target.view.destroyed).toBe(true);
    expect(target.view.handling.power).toBe(0);
    expect(target.view.condition).toBe('wrecked');
  });

  it('orders the whole range the way a driver would expect', () => {
    const cost = (closing: number): number => {
      const { target, crash } = rearEndRig();
      crash(closing);
      return VEHICLE_INTEGRITY - target.integrity;
    };
    const shunt = cost(3);
    const nudge = cost(5);
    const urban = cost(8);
    const heavy = cost(12);
    expect(shunt).toBeLessThan(nudge);
    expect(nudge).toBeLessThan(urban);
    expect(urban).toBeLessThan(heavy);
    // Superlinear: doubling the closing speed does far more than double the
    // damage, which is what makes a serious crash worth more than the several
    // small ones that carry the same total impulse.
    expect(heavy).toBeGreaterThan(urban * 2.5);
  });
});

// -- the model itself -------------------------------------------------------

describe('the severity law', () => {
  it('charges nothing structural below the yield threshold', () => {
    expect(collisionDamage({ deltaV: 0 })).toBe(0);
    expect(collisionDamage({ deltaV: -4 })).toBe(0);
    const atYield = collisionDamage({ deltaV: YIELD_DELTA_V });
    expect(atYield).toBeCloseTo(VEHICLE_INTEGRITY * SCUFF_SHARE, 9);
    // Continuous across the threshold: no cliff for a hit to fall off.
    expect(collisionDamage({ deltaV: YIELD_DELTA_V + 1e-6 })).toBeCloseTo(atYield, 6);
  });

  it('spends the whole shell at the write-off delta-v', () => {
    const total = collisionDamage({ deltaV: WRITE_OFF_DELTA_V });
    expect(total).toBeGreaterThanOrEqual(VEHICLE_INTEGRITY);
    expect(total).toBeLessThan(VEHICLE_INTEGRITY * 1.05);
  });

  it('grows with the square of the excess, not with the impulse', () => {
    const span = WRITE_OFF_DELTA_V - YIELD_DELTA_V;
    const one = collisionDamage({ deltaV: YIELD_DELTA_V + span * 0.25 });
    const two = collisionDamage({ deltaV: YIELD_DELTA_V + span * 0.5 });
    const scuff = VEHICLE_INTEGRITY * SCUFF_SHARE;
    expect(two - scuff).toBeCloseTo((one - scuff) * 4, 6);
  });
});

// -- the angle and the place ------------------------------------------------

describe('where the hit lands decides what the same speed costs', () => {
  /** A saloon, as `crushShare` sees one: 4.6 m by 1.85 m, facing north. */
  const shell = { centreX: 0, centreZ: 0, yaw: 0, length: 4.6, width: 1.85 };

  it('crushes all of a hit whose line passes through the centre of mass', () => {
    // Square on the boot, pushed straight up the car's own axis.
    expect(crushShare({ ...shell, x: 0, z: 2.3, dirX: 0, dirZ: -1 })).toBeCloseTo(1, 9);
    // And square in the flank, which is just as central.
    expect(crushShare({ ...shell, x: 0.925, z: 0, dirX: -1, dirZ: 0 })).toBeCloseTo(1, 9);
  });

  it('charges a rear-corner tap less than the same speed taken square', () => {
    const square = crushShare({ ...shell, x: 0, z: 2.3, dirX: 0, dirZ: -1 });
    const corner = crushShare({ ...shell, x: 0.9, z: 2.3, dirX: 0, dirZ: -1 });
    expect(corner).toBeLessThan(square);

    const deltaV = 4.6; // Two saloons closing at 8 m/s.
    const flat = collisionDamage({ deltaV, crush: square });
    const clipped = collisionDamage({ deltaV, crush: corner });
    expect(clipped).toBeLessThan(flat * 0.6);
    expect(clipped).toBeGreaterThan(0);
  });

  it('charges a glancing shove at the nose least of all', () => {
    // Shoved sideways at the front corner: almost all of it goes into the
    // spin, which is why a clipped wing slews a car round and barely marks it.
    const glance = crushShare({ ...shell, x: 0.925, z: -2.3, dirX: -1, dirZ: 0 });
    expect(glance).toBeLessThan(0.6);
    expect(collisionDamage({ deltaV: 4.6, crush: glance })).toBeLessThan(
      VEHICLE_INTEGRITY * 0.02,
    );
  });

  it('treats the two flanks alike', () => {
    const left = crushShare({ ...shell, x: -0.9, z: 2.3, dirX: 0, dirZ: -1 });
    const right = crushShare({ ...shell, x: 0.9, z: 2.3, dirX: 0, dirZ: -1 });
    expect(left).toBeCloseTo(right, 12);
  });

  it('refuses to be broken by a degenerate contact', () => {
    expect(crushShare({ ...shell, x: 0, z: 0, dirX: 0, dirZ: 0 })).toBe(1);
    expect(crushShare({ ...shell, length: 0, width: 0, x: 1, z: 1, dirX: 1, dirZ: 0 })).toBe(1);
  });

  it('costs less in the simulation when the same crash lands off the centreline', () => {
    const square = rearEndRig();
    square.crash(8, 0);
    const corner = rearEndRig();
    corner.crash(8, 1.2);
    expect(VEHICLE_INTEGRITY - corner.target.integrity).toBeLessThan(
      VEHICLE_INTEGRITY - square.target.integrity,
    );
  });
});

// -- the two halves stay apart ----------------------------------------------

describe('damage never decides where the car goes', () => {
  it('moves the struck car by exactly the impulse, whatever the damage says', () => {
    const gentle = makeSim();
    const brutal = makeSim();
    const soft = seed(gentle.sim, gentle.laneId, 40, 0);
    const hard = seed(brutal.sim, brutal.laneId, 40, 0);
    const { fx, fz, rx, rz } = axes(soft);
    const nose = soft.blueprint.length * 0.5;
    const flank = soft.blueprint.width * 0.5;

    for (const [sim, car, damage] of [
      [gentle.sim, soft, 0],
      [brutal.sim, hard, VEHICLE_INTEGRITY],
    ] as const) {
      sim.applyImpact(car.id, {
        x: car.x + fx * nose + rx * flank,
        y: 1,
        z: car.z + fz * nose + rz * flank,
        dirX: -rx,
        dirZ: -rz,
        impulse: 9000,
        damage,
      });
    }

    // One is a write-off and the other is untouched; they move identically.
    expect(soft.view.destroyed).toBe(false);
    expect(hard.view.destroyed).toBe(true);
    expect(hard.vx).toBe(soft.vx);
    expect(hard.vz).toBe(soft.vz);
    expect(hard.yawRate).toBe(soft.yawRate);
    expect(hard.rollRate).toBe(soft.rollRate);
  });

  it('keeps a hard shove with no structural meaning free of charge', () => {
    // A blast wave shoves a car it does not deform. The impulse field carries
    // that on its own; nothing derives one from the other any more.
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    const { fx, fz } = axes(car);
    sim.applyImpact(car.id, {
      x: car.x - fx * 2.3,
      y: 0.6,
      z: car.z - fz * 2.3,
      dirX: fx,
      dirZ: fz,
      impulse: 12000,
      damage: 0,
    });
    expect(Math.hypot(car.vx, car.vz)).toBeCloseTo(12000 / car.blueprint.chassis.mass, 6);
    expect(car.integrity).toBe(VEHICLE_INTEGRITY);
    expect(car.view.condition).toBe('pristine');
  });
});

// -- the stages -------------------------------------------------------------

describe('the stages a shell goes through', () => {
  const sound = { destroyed: false, power: 1, flats: 0 };

  it('runs pristine to wrecked as the shell is spent', () => {
    expect(vehicleCondition({ ...sound, damage: 0 })).toBe('pristine');
    expect(vehicleCondition({ ...sound, damage: SCUFFED_AT - 0.001 })).toBe('pristine');
    expect(vehicleCondition({ ...sound, damage: SCUFFED_AT })).toBe('scuffed');
    expect(vehicleCondition({ ...sound, damage: DAMAGED_AT })).toBe('damaged');
    expect(vehicleCondition({ ...sound, damage: CRIPPLED_AT })).toBe('crippled');
    expect(vehicleCondition({ ...sound, damage: 1, destroyed: true })).toBe('wrecked');
  });

  it('reads the regions as well as the total', () => {
    // A car with most of its shell but no engine is in a worse state than one
    // with half of it gone and everything working.
    expect(vehicleCondition({ ...sound, damage: 0.2, power: 0 })).toBe('crippled');
    expect(vehicleCondition({ ...sound, damage: 0.2, flats: 2 })).toBe('crippled');
    expect(vehicleCondition({ ...sound, damage: 0.1, flats: 1 })).toBe('damaged');
    expect(vehicleCondition({ ...sound, damage: 0.1, power: 0.9 })).toBe('damaged');
  });

  it('is published on the view, and climbs one crash at a time', () => {
    const { target, crash } = rearEndRig();
    expect(target.view.condition).toBe('pristine');
    crash(8);
    expect(target.view.condition).toBe('scuffed');
    crash(12);
    expect(['damaged', 'crippled']).toContain(target.view.condition);
    crash(12);
    expect(target.view.condition).toBe('wrecked');
    expect(target.view.destroyed).toBe(true);
  });
});

// -- explosions are untouched -----------------------------------------------

describe('an explosion still destroys a car outright', () => {
  it('writes one off with a single located blow', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    const { rx, rz } = axes(car);
    // Located, at the near-side flank, at the scale combat uses for a warhead.
    expect(
      sim.applyDamage(
        car.id,
        VEHICLE_INTEGRITY,
        car.x - rx * car.blueprint.width * 0.5,
        car.y + 0.7,
        car.z - rz * car.blueprint.width * 0.5,
      ),
    ).toBe(true);
    expect(car.integrity).toBe(0);
    expect(car.view.destroyed).toBe(true);
    expect(car.view.handling.destroyed).toBe(true);
    expect(car.view.condition).toBe('wrecked');
    // And the blast behaviour the combat layer relies on is unchanged.
    expect(car.view.regions.glass).toBe(1);
    expect(car.view.regions.tyres[0]).toBeGreaterThan(0.9);
    expect(car.view.regions.tyres[2]).toBeGreaterThan(0.9);
  });

  it('finishes a car that a collision had already damaged', () => {
    const { sim, target, crash } = rearEndRig();
    crash(8);
    crash(8);
    expect(target.view.destroyed, 'two urban shunts are not a write-off').toBe(false);
    // The launcher's own 190 points, on a car that has already been in two
    // crashes. Accumulated damage is a way to lose a car, as it should be.
    const { rx, rz } = axes(target);
    sim.applyDamage(
      target.id,
      190,
      target.x - rx * target.blueprint.width * 0.5,
      target.y + 0.7,
      target.z - rz * target.blueprint.width * 0.5,
    );
    expect(target.integrity).toBe(0);
    expect(target.view.condition).toBe('wrecked');
  });
});
