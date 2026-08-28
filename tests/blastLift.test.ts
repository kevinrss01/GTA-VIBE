/**
 * Whether a blast can get a car off the ground.
 *
 * The gap this closes: `VehicleImpact` carried only `dirX`/`dirZ`, and
 * `settleBody` assigns `vehicle.y` outright from the terrain under each axle on
 * every frame. Between them a rocket could yaw a car, roll it, overturn it and
 * throw it down the street - but it could never LIFT one, because there was no
 * vertical channel into the simulation and anything that wrote `y` was
 * overwritten before it was drawn.
 *
 * Two pieces answer that, and both are tested here:
 *
 *   1. `VehicleImpact.lift`, an impulse in newton-seconds that is ADDED to the
 *      horizontal one rather than taken out of it - so no horizontal number
 *      that was already calibrated moves by adding lift to a blast;
 *   2. `Vehicle.hop`/`hopRate`, a ballistic layer that rides on top of the
 *      ground assignment under real gravity and lands nearly inelastically.
 *
 * The invariant that matters most is the negative one: an ORDINARY COLLISION
 * must never lift a car. A rear-ended saloon that hops is a worse bug than one
 * that cannot be thrown at all.
 *
 * Arithmetic only. No renderer, no browser.
 */

import { describe, expect, it } from 'vitest';

import { buildRoadNetwork, lanePoint, type RoadNetwork } from '../src/city/RoadNetwork';
import { blastLift } from '../src/combat/CombatSystem';
import { TrafficSim, type Vehicle } from '../src/traffic/TrafficSim';
import { VEHICLE_BLUEPRINTS } from '../src/traffic/VehicleCatalogue';
import type { CityPlan, Street } from '../src/world/CityPlan';

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
    // Flat ground at zero, so any height a body has is the hop and nothing else.
    heightAt: () => 0,
    population: 0,
    seed: 'lift-test',
  });
  const lane = net.lanes.find((l) => l.streetId === 'a');
  if (!lane) throw new Error('no lane on street a');
  return { sim, net, laneId: lane.id };
}

function seed(
  sim: TrafficSim,
  laneId: string,
  along: number,
  kind: 'sedan' | 'boxTruck' = 'sedan',
): Vehicle {
  sim.resize(sim.vehicles.length + 1);
  const vehicle = sim.vehicles[sim.vehicles.length - 1] as Vehicle;
  const info = sim.laneMeta(laneId);
  if (!info) throw new Error(`no lane ${laneId}`);
  vehicle.kind = kind;
  vehicle.blueprint = VEHICLE_BLUEPRINTS[kind];
  vehicle.view.kind = kind;
  vehicle.view.halfLength = vehicle.blueprint.length * 0.5;
  vehicle.view.halfWidth = vehicle.blueprint.width * 0.5;
  vehicle.view.halfHeight = vehicle.blueprint.height * 0.5;
  vehicle.laneId = laneId;
  vehicle.along = along;
  vehicle.speed = 0;
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

/** Runs the simulation and reports the highest the body ever got. */
function fly(
  sim: TrafficSim,
  vehicle: Vehicle,
  seconds: number,
): { peak: number; airborneFor: number; landed: boolean } {
  let peak = 0;
  let airborneFor = 0;
  let time = 0;
  const dt = 1 / 120;
  for (let i = 0; i < Math.round(seconds / dt); i += 1) {
    sim.update(dt, vehicle.x, vehicle.z, time);
    time += dt;
    peak = Math.max(peak, vehicle.hop);
    if (vehicle.hop > 0) airborneFor += dt;
  }
  return { peak, airborneFor, landed: vehicle.hop <= 0 };
}

// -- the lift law, on its own -----------------------------------------------

describe('how much of a blast goes underneath a car', () => {
  // A saloon is 1.5 m tall in the catalogue, so its half height is 0.75 m and
  // its CENTRE - which is what `CombatVehicleView.y` publishes - sits at 0.75 m
  // when the wheels are on flat ground at zero.
  const half = 0.75;
  const centre = 0.75;

  it('passes entirely under a car when it goes off beside it at road level', () => {
    // Road level is a full half height below the centre.
    expect(blastLift(0, centre, half, false)).toBeCloseTo(1, 6);
  });

  it('is pure shove when it goes off level with the centre of mass', () => {
    expect(blastLift(centre, centre, half, false)).toBeCloseTo(0, 6);
  });

  it('presses DOWN when the warhead arrives through the roof', () => {
    // The roof of a saloon on flat ground is at 1.5 m.
    expect(blastLift(1.5, centre, half, false)).toBeCloseTo(-1, 6);
  });

  it('is bounded either way, however far off the blast is', () => {
    for (const seatY of [-50, -3, 0, 3, 50]) {
      const share = blastLift(seatY, centre, half, false);
      expect(share).toBeGreaterThanOrEqual(-1);
      expect(share).toBeLessThanOrEqual(1);
    }
  });

  it('still throws the car when the warhead struck it high up', () => {
    // A rocket into a windscreen must not merely press the car into the road.
    // On the bare geometry this case is NEGATIVE - the seat of the blast is
    // above the body's centre - and the direct floor is what overrides it.
    expect(blastLift(1.5, centre, half, false)).toBeLessThan(0);
    expect(blastLift(1.5, centre, half, true)).toBeGreaterThanOrEqual(0.75);
  });

  it('is scale free: the same geometry on a taller body gives the same share', () => {
    // A box truck is taller, so its centre is higher; a road-level blast is
    // still exactly one half height below it and still lifts the same share.
    expect(blastLift(0, 0.75, 0.75, false)).toBeCloseTo(blastLift(0, 1.6, 1.6, false), 6);
  });
});

// -- the ballistic layer ----------------------------------------------------

describe('a car a blast has thrown', () => {
  it('leaves the ground, arcs and comes back down', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    sim.applyImpact(car.id, {
      x: car.x,
      y: 0.2,
      z: car.z,
      dirX: 1,
      dirZ: 0,
      impulse: 2000,
      // Roughly a direct rocket hit on a saloon.
      lift: 5800,
      damage: 10,
    });
    expect(car.control, 'a blast this size must free the body').toBe('loose');
    expect(car.hopRate).toBeGreaterThan(3);

    const flight = fly(sim, car, 2);
    // 4.08 m/s under real gravity is about 0.85 m of air and 0.83 s of hang.
    expect(flight.peak).toBeGreaterThan(0.5);
    expect(flight.peak).toBeLessThan(1.5);
    expect(flight.airborneFor).toBeGreaterThan(0.5);
    expect(flight.airborneFor).toBeLessThan(1.4);
    expect(flight.landed, 'it has to come down again').toBe(true);
  });

  it('is drawn above the road while it is in the air', () => {
    // The regression this exists for: `settleBody` assigns `y` from the terrain
    // on every frame, so a hop that is not added AFTER that assignment is
    // computed correctly and then thrown away before anything can see it.
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    sim.applyImpact(car.id, {
      x: car.x, y: 0.2, z: car.z, dirX: 1, dirZ: 0, impulse: 2000, lift: 5800, damage: 10,
    });
    let sawItUp = false;
    let time = 0;
    for (let i = 0; i < 120; i += 1) {
      sim.update(1 / 120, car.x, car.z, time);
      time += 1 / 120;
      // The ground is flat at zero everywhere in this fixture.
      if (car.y > 0.3) sawItUp = true;
    }
    expect(sawItUp, 'the published y never left the road').toBe(true);
  });

  it('carries its speed through the arc instead of scrubbing on air', () => {
    // Wheels off the ground means no rolling or scrubbing drag. Without this a
    // thrown car lands almost where it took off, which reads as a hop rather
    // than as being thrown.
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    const startX = car.x;
    sim.applyImpact(car.id, {
      x: car.x, y: 0.2, z: car.z, dirX: 1, dirZ: 0, impulse: 9000, lift: 5800, damage: 10,
    });
    const launched = Math.hypot(car.vx, car.vz);
    fly(sim, car, 0.4);
    // Still most of its speed a third of a second in, and visibly moved.
    expect(Math.hypot(car.vx, car.vz)).toBeGreaterThan(launched * 0.9);
    expect(Math.abs(car.x - startX)).toBeGreaterThan(1);
  });

  it('lands heavily rather than bouncing like a ball', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    sim.applyImpact(car.id, {
      x: car.x, y: 0.2, z: car.z, dirX: 1, dirZ: 0, impulse: 2000, lift: 5800, damage: 10,
    });
    const first = fly(sim, car, 2);
    // Whatever it does after the first landing must be far smaller than the
    // throw itself, or a thrown car reads as weightless.
    const after = fly(sim, car, 2);
    expect(after.peak).toBeLessThan(first.peak * 0.25);
  });

  it('comes to rest on the road, not in the air', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    sim.applyImpact(car.id, {
      x: car.x, y: 0.2, z: car.z, dirX: 1, dirZ: 0, impulse: 2000, lift: 5800, damage: 10,
    });
    fly(sim, car, 12);
    expect(car.hop).toBe(0);
    expect(car.hopRate).toBe(0);
  });

  it('barely moves a body three times the mass on the same impulse', () => {
    const light = makeSim();
    const lightCar = seed(light.sim, light.laneId, 60, 'sedan');
    light.sim.applyImpact(lightCar.id, {
      x: lightCar.x, y: 0.2, z: lightCar.z, dirX: 1, dirZ: 0, impulse: 2000, lift: 5800, damage: 10,
    });

    const heavy = makeSim();
    const truck = seed(heavy.sim, heavy.laneId, 60, 'boxTruck');
    heavy.sim.applyImpact(truck.id, {
      x: truck.x, y: 0.2, z: truck.z, dirX: 1, dirZ: 0, impulse: 2000, lift: 5800, damage: 10,
    });

    expect(VEHICLE_BLUEPRINTS.boxTruck.chassis.mass).toBeGreaterThan(
      VEHICLE_BLUEPRINTS.sedan.chassis.mass,
    );
    expect(fly(heavy.sim, truck, 2).peak).toBeLessThan(fly(light.sim, lightCar, 2).peak);
  });
});

// -- the negative invariant -------------------------------------------------

describe('what must never lift a car', () => {
  it('leaves an ordinary collision entirely in the plane', () => {
    // The impulse a hard urban collision carries, with no lift, must not put a
    // single centimetre of air under the car.
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    sim.applyImpact(car.id, {
      x: car.x, y: 0.6, z: car.z, dirX: 1, dirZ: 0, impulse: 12000, damage: 140,
    });
    expect(car.hopRate).toBe(0);
    expect(fly(sim, car, 3).peak).toBe(0);
  });

  it('ignores a lift too small to clear the suspension', () => {
    // Under the trigger the arc would be shorter than the travel that absorbs
    // it, so it stays on the road rather than shivering a centimetre upward.
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    sim.applyImpact(car.id, {
      x: car.x, y: 0.2, z: car.z, dirX: 1, dirZ: 0, impulse: 3000, lift: 500, damage: 10,
    });
    expect(fly(sim, car, 2).peak).toBe(0);
  });

  it('never lifts a body a warhead pressed down on', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    sim.applyImpact(car.id, {
      x: car.x, y: 2.2, z: car.z, dirX: 1, dirZ: 0, impulse: 3000, lift: -4000, damage: 10,
    });
    expect(fly(sim, car, 2).peak).toBe(0);
  });
});

// -- the player's own car ---------------------------------------------------

describe('a blast reaches the car the player is sitting in', () => {
  /*
   * Found by the Greptile review, and it was real: `applyImpact` routes a
   * player-controlled vehicle into `pendingImpulses`, which carried the
   * horizontal shove, the yaw and the damage - and dropped the lift on the
   * floor. The identical car was therefore thrown by a rocket when parked and
   * merely shoved when the player happened to be in it.
   *
   * The queue now carries it. `Driving` integrates the arc, because the driven
   * car is kinematic and the traffic layer is not integrating it, and publishes
   * the height back through `setPose.lift`.
   */
  it('banks the lift for a driven car instead of dropping it', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    sim.detach(car);
    expect(car.control, 'detach hands the car to the player').toBe('player');
    sim.applyImpact(car.id, {
      x: car.x, y: 0.2, z: car.z, dirX: 1, dirZ: 0, impulse: 2000, lift: 5800, damage: 10,
    });
    const banked = sim.takeImpulse(car.id);
    expect(banked).not.toBeNull();
    expect(banked?.lift).toBe(5800);
    // The horizontal half is untouched by carrying the vertical one.
    expect(banked?.x).toBeCloseTo(2000, 6);
  });

  it('sums the lift when two blasts land inside one frame', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    sim.detach(car);
    sim.applyImpact(car.id, {
      x: car.x, y: 0.2, z: car.z, dirX: 1, dirZ: 0, impulse: 1000, lift: 3000, damage: 5,
    });
    car.impactCooldown = 0;
    sim.applyImpact(car.id, {
      x: car.x, y: 0.2, z: car.z, dirX: 1, dirZ: 0, impulse: 1000, lift: 2000, damage: 5,
    });
    expect(sim.takeImpulse(car.id)?.lift).toBe(5000);
  });

  it('reports no lift for an ordinary collision on a driven car', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    sim.detach(car);
    sim.applyImpact(car.id, {
      x: car.x, y: 0.6, z: car.z, dirX: 1, dirZ: 0, impulse: 12000, damage: 140,
    });
    expect(sim.takeImpulse(car.id)?.lift).toBe(0);
  });

  it('carries the upward velocity across a handover, not just the height', () => {
    /*
     * The second Greptile finding, and it was real: publishing only the height
     * meant a car abandoned mid-flight stopped climbing at the door and fell
     * from wherever it happened to be. Worse, a blast landing in the same frame
     * as the exit had its lift thrown away entirely, because the queued impulse
     * lived in `Driving` and was zeroed on the way out.
     *
     * The sim-level contract is that both fields are the arc, and that a body
     * holding them integrates onward under gravity.
     */
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    // `release()` parks the car, and a parked body is the one the traffic layer
    // integrates from there - so this is the real handover path.
    sim.park(car);
    // Exactly what `setPose` writes for a car handed back mid-climb.
    car.hop = 0.4;
    car.hopRate = 3;
    const climbed = fly(sim, car, 1.2);
    // It kept going up from 0.4 m rather than falling from it...
    expect(climbed.peak).toBeGreaterThan(0.8);
    // ...and still came down.
    expect(car.hop).toBe(0);
  });

  it('falls rather than floating when only the height survives', () => {
    // The failure mode the field above prevents, pinned so it stays a fall and
    // never becomes a car frozen in mid-air.
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    sim.park(car);
    car.hop = 1.2;
    car.hopRate = 0;
    fly(sim, car, 3);
    expect(car.hop).toBe(0);
  });

  it('rides a driven car above the road when the pose publishes a lift', () => {
    // The other half: the traffic layer has to ADD the published height to the
    // ground it samples, or the driving layer's arc is overwritten before it is
    // drawn - the same trap `settleBody` sets for an ambient body.
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    sim.detach(car);
    // `TrafficSystem.makeHandle` wires `setPose.lift` straight to this field;
    // at the simulation level the observable contract is that `hop` is what
    // lifts the drawn body off the ground the sampler assigned.
    car.hop = 0.8;
    sim.update(1 / 120, car.x, car.z, 0);
    expect(car.y).toBeGreaterThan(0.5);
  });
});

// -- the couple -------------------------------------------------------------

describe('a lift under one side', () => {
  it('rolls the car away from the side it lifted', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    const rightX = Math.cos(car.yaw);
    const rightZ = -Math.sin(car.yaw);
    const arm = car.blueprint.chassis.track * 0.5;
    sim.applyImpact(car.id, {
      // Under the RIGHT sill: the right-hand side goes up, so the body rolls
      // the other way. Positive roll is right-side-up in this convention.
      x: car.x + rightX * arm,
      y: 0.1,
      z: car.z + rightZ * arm,
      dirX: 0,
      dirZ: 0,
      impulse: 0,
      lift: 6000,
      damage: 10,
    });
    expect(car.rollRate).toBeGreaterThan(0);
  });

  it('rolls it the other way from under the other sill', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    const rightX = Math.cos(car.yaw);
    const rightZ = -Math.sin(car.yaw);
    const arm = car.blueprint.chassis.track * 0.5;
    sim.applyImpact(car.id, {
      x: car.x - rightX * arm,
      y: 0.1,
      z: car.z - rightZ * arm,
      dirX: 0,
      dirZ: 0,
      impulse: 0,
      lift: 6000,
      damage: 10,
    });
    expect(car.rollRate).toBeLessThan(0);
  });

  it('does not roll a car a blast lifted straight up the middle', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    const before = car.rollRate;
    sim.applyImpact(car.id, {
      x: car.x, y: 0.1, z: car.z, dirX: 0, dirZ: 0, impulse: 0, lift: 6000, damage: 10,
    });
    expect(car.rollRate).toBeCloseTo(before, 6);
  });

  it('can put a car over onto its roof', () => {
    // The whole point of the couple: a big enough blast beside a car overturns
    // it rather than only sliding it down the road.
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 60);
    const rightX = Math.cos(car.yaw);
    const rightZ = -Math.sin(car.yaw);
    const arm = car.blueprint.chassis.track * 0.5;
    sim.applyImpact(car.id, {
      x: car.x + rightX * arm,
      y: 0.1,
      z: car.z + rightZ * arm,
      dirX: rightX,
      dirZ: rightZ,
      impulse: 8000,
      lift: 16000,
      damage: 40,
    });
    fly(sim, car, 6);
    expect(car.view.overturned).toBe(true);
  });
});
