/**
 * Struck vehicles: the assertions that would catch a car with no mass.
 *
 * Before this, a car the player drove into was inert - `moveBox` refused the
 * move, the player's own speed was scrubbed, and the thing that had just been
 * hit carried on down its lane as though nothing had happened. What follows
 * pins the whole chain that replaced it: an impulse, converted with the real
 * chassis mass and the real contact point, into linear velocity, yaw and roll;
 * a free body that leaves its lane and integrates until it stops; and a
 * recovery that either puts the car back in traffic or writes it off.
 *
 * Everything here is arithmetic. No renderer, no browser, no traffic system -
 * the simulation is driven directly so the numbers can be checked.
 */

import { describe, expect, it } from 'vitest';

import { buildRoadNetwork, lanePoint, type RoadNetwork } from '../src/city/RoadNetwork';
import { CityGround } from '../src/world/CityGround';
import { getCityPlan, type CityPlan, type Street } from '../src/world/CityPlan';
import { TrafficSim, type Vehicle } from '../src/traffic/TrafficSim';
import { TrafficSystem } from '../src/traffic/TrafficSystem';
import { VEHICLE_BLUEPRINTS } from '../src/traffic/VehicleCatalogue';
import { VEHICLE_INTEGRITY, impactDamage, type VehicleImpact } from '../src/traffic/types';

// -- fixtures ---------------------------------------------------------------

/** Minimal plan for the synthetic network; only `streets` is ever read. */
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

/** A crossroads on flat ground, with no vehicles until one is added. */
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
    seed: 'impact-test',
  });
  const lane = net.lanes.find((l) => l.streetId === 'a');
  if (!lane) throw new Error('no lane on street a');
  return { sim, net, laneId: lane.id };
}

/** Puts a vehicle of a known kind at a known place, bypassing random spawning. */
function seed(
  sim: TrafficSim,
  laneId: string,
  along: number,
  speed: number,
  kind: 'sedan' | 'boxTruck' | 'compact' = 'sedan',
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

/** The vehicle's own axes, matching the game's `(-sin yaw, -cos yaw)` forward. */
function axes(vehicle: Vehicle): { fx: number; fz: number; rx: number; rz: number } {
  return {
    fx: -Math.sin(vehicle.yaw),
    fz: -Math.cos(vehicle.yaw),
    rx: Math.cos(vehicle.yaw),
    rz: -Math.sin(vehicle.yaw),
  };
}

/** A hit on the tail, straight up the vehicle's own axis. */
function rearEnd(vehicle: Vehicle, impulse: number): VehicleImpact {
  const { fx, fz } = axes(vehicle);
  const reach = vehicle.blueprint.length * 0.5;
  return {
    x: vehicle.x - fx * reach,
    y: 0.6,
    z: vehicle.z - fz * reach,
    dirX: fx,
    dirZ: fz,
    impulse,
    damage: impactDamage(impulse),
  };
}

function run(sim: TrafficSim, seconds: number, step = 1 / 60, cameraX = 0, cameraZ = 0): void {
  for (let i = 0; i < Math.round(seconds / step); i += 1) {
    sim.update(step, cameraX, cameraZ, i * step);
  }
}

// -- the impulse ------------------------------------------------------------

describe('an impulse becomes motion, through the chassis', () => {
  it('divides the impulse by the vehicle mass', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    const mass = car.blueprint.chassis.mass;
    expect(sim.applyImpact(car.id, rearEnd(car, 6000))).toBe(true);
    expect(car.control).toBe('loose');
    expect(Math.hypot(car.vx, car.vz)).toBeCloseTo(6000 / mass, 6);
  });

  it('moves a light car further than a heavy one for the same hit', () => {
    const light = makeSim();
    const heavy = makeSim();
    const hatch = seed(light.sim, light.laneId, 40, 0, 'compact');
    const lorry = seed(heavy.sim, heavy.laneId, 40, 0, 'boxTruck');
    expect(lorry.blueprint.chassis.mass).toBeGreaterThan(hatch.blueprint.chassis.mass * 3);

    light.sim.applyImpact(hatch.id, rearEnd(hatch, 9000));
    heavy.sim.applyImpact(lorry.id, rearEnd(lorry, 9000));
    const hatchSpeed = Math.hypot(hatch.vx, hatch.vz);
    const lorrySpeed = Math.hypot(lorry.vx, lorry.vz);
    // Mass is the only thing separating them, so the ratio is the mass ratio.
    expect(hatchSpeed / lorrySpeed).toBeCloseTo(
      lorry.blueprint.chassis.mass / hatch.blueprint.chassis.mass,
      4,
    );
    // And the lorry shrugs it off: a hit that throws the hatchback at 7.6 m/s
    // moves 4.2 tonnes of box truck at 2.1.
    expect(hatchSpeed).toBeGreaterThan(7);
    expect(lorrySpeed).toBeLessThan(2.5);
  });

  it('spins a corner hit and does not spin a square one', () => {
    const square = makeSim();
    const corner = makeSim();
    const straight = seed(square.sim, square.laneId, 40, 0);
    const clipped = seed(corner.sim, corner.laneId, 40, 0);

    square.sim.applyImpact(straight.id, rearEnd(straight, 8000));
    expect(straight.yawRate).toBeCloseTo(0, 9);

    // Same impulse, same magnitude, applied across the front off-side corner.
    const { fx, fz, rx, rz } = axes(clipped);
    const nose = clipped.blueprint.length * 0.5;
    const flank = clipped.blueprint.width * 0.5;
    corner.sim.applyImpact(clipped.id, {
      x: clipped.x + fx * nose + rx * flank,
      y: 0.6,
      z: clipped.z + fz * nose + rz * flank,
      dirX: -rx,
      dirZ: -rz,
      impulse: 8000,
      damage: 0,
    });
    // Pushing the off-side nose across swings the nose the other way: positive
    // yaw is a left turn in this game's convention.
    expect(clipped.yawRate).toBeGreaterThan(1);
  });

  it('leaves a light brush to the driver instead of freeing the car', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 5);
    const before = car.speed;
    expect(sim.applyImpact(car.id, rearEnd(car, 400))).toBe(true);
    expect(car.control).toBe('ambient');
    expect(car.speed).toBeGreaterThan(before);
    expect(car.laneId).toBe(laneId);
  });

  it('refuses a hit on a vehicle that does not exist', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    expect(sim.applyImpact(4242, rearEnd(car, 6000))).toBe(false);
  });

  it('does not re-apply the same sustained contact every frame', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    const hit = rearEnd(car, 6000);
    expect(sim.applyImpact(car.id, hit)).toBe(true);
    const afterOne = Math.hypot(car.vx, car.vz);

    // Something pressed against the car, reporting the same contact at the
    // frame rate. Without the cooldown this integrates to a launch.
    let accepted = 0;
    for (let i = 0; i < 12; i += 1) {
      if (sim.applyImpact(car.id, hit)) accepted += 1;
      sim.update(1 / 120, 0, 0, i / 120);
    }
    expect(accepted, 'a contact held for a tenth of a second is one collision').toBe(0);
    expect(Math.hypot(car.vx, car.vz)).toBeLessThanOrEqual(afterOne);

    // A genuinely later hit is still accepted.
    run(sim, 0.4);
    expect(sim.applyImpact(car.id, hit)).toBe(true);
  });
});

// -- the free body ----------------------------------------------------------

describe('a loose car', () => {
  it('leaves its lane instead of being dragged back onto the centreline', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    const { rx, rz } = axes(car);
    const startX = car.x;
    const startZ = car.z;

    // Shoved sideways off the line. The rail snap in `steerAndMove` pulls any
    // ambient car back inside 1.6 m of its lane; a free body must be exempt
    // from it, or a knocked car slides straight back where it came from.
    sim.applyImpact(car.id, {
      x: car.x,
      y: 0.6,
      z: car.z,
      dirX: rx,
      dirZ: rz,
      impulse: 5000,
      damage: 0,
    });
    run(sim, 0.35, 1 / 60, car.x, car.z);
    const across = (car.x - startX) * rx + (car.z - startZ) * rz;
    // Four locked tyres, so it does not go far - but it goes, and it stays.
    expect(across).toBeGreaterThan(0.25);
    expect(across).toBeLessThan(1.5);
  });

  it('comes to rest in a couple of seconds rather than instantly or never', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    sim.applyImpact(car.id, rearEnd(car, 10000));
    const launched = Math.hypot(car.vx, car.vz);
    expect(launched).toBeGreaterThan(6);

    run(sim, 0.5);
    expect(Math.hypot(car.vx, car.vz), 'still travelling after half a second').toBeGreaterThan(3);

    let stoppedAt = -1;
    for (let i = 0; i < 60 * 8; i += 1) {
      sim.update(1 / 60, 0, 0, i / 60);
      if (stoppedAt < 0 && Math.hypot(car.vx, car.vz) < 0.3) stoppedAt = i / 60;
    }
    expect(stoppedAt, `stopped after ${stoppedAt.toFixed(2)} s`).toBeGreaterThan(1.5);
    expect(stoppedAt).toBeLessThan(4);
  });

  it('rejoins traffic on a lane once it settles upright', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    sim.applyImpact(car.id, rearEnd(car, 8000));
    expect(car.control).toBe('loose');

    run(sim, 6);
    expect(car.active).toBe(true);
    expect(car.control).toBe('ambient');
    expect(car.view.control).toBe('ambient');
    expect(car.laneId).toBeTruthy();
    expect(sim.laneMeta(car.laneId)).toBeDefined();
    expect(car.crashRoll).toBe(0);
    expect(car.view.overturned).toBe(false);
    // And it drives again rather than sitting where it stopped.
    run(sim, 4);
    expect(car.speed).toBeGreaterThan(2);
  });

  it('does not slide through the car it is shoved into', () => {
    const { sim, laneId } = makeSim();
    const parked = seed(sim, laneId, 40, 0);
    sim.detach(parked);
    // Alongside it, one lane over, then shoved straight at its flank.
    const shoved = seed(sim, laneId, 40, 0);
    const { rx, rz } = axes(shoved);
    shoved.x = parked.x + rx * 3.4;
    shoved.z = parked.z + rz * 3.4;
    sim.applyImpact(shoved.id, {
      x: shoved.x + rx,
      y: 0.6,
      z: shoved.z + rz,
      dirX: -rx,
      dirZ: -rz,
      impulse: 9000,
      damage: 0,
    });

    let closest = Infinity;
    for (let i = 0; i < 60 * 4; i += 1) {
      sim.update(1 / 60, 0, 0, i / 60);
      closest = Math.min(closest, Math.hypot(shoved.x - parked.x, shoved.z - parked.z));
    }
    // Flank to flank is two half widths. The free body is kept out of the car
    // it lands among, because the lane model's own non-overlap guarantee is
    // one-dimensional and a car that has left its lane is outside it.
    expect(closest, `closed to ${closest.toFixed(2)} m`).toBeGreaterThan(
      parked.blueprint.width * 0.5 + shoved.blueprint.width * 0.5 - 0.05,
    );
  });

  it('waits rather than rejoining a lane through the car standing on it', () => {
    const { sim, laneId } = makeSim();
    const blocker = seed(sim, laneId, 40, 0);
    sim.detach(blocker);

    const shunted = seed(sim, laneId, 40, 0);
    const { rx, rz } = axes(shunted);
    shunted.x = blocker.x + rx * 3.4;
    shunted.z = blocker.z + rz * 3.4;
    sim.applyImpact(shunted.id, {
      x: shunted.x,
      y: 0.6,
      z: shunted.z,
      dirX: rx,
      dirZ: rz,
      impulse: 3000,
      damage: 0,
    });
    run(sim, 4, 1 / 60, shunted.x, shunted.z);
    // The lane spot it would take is occupied, so it stays where it is.
    expect(shunted.control).toBe('loose');

    // Once the road clears it goes back to work.
    blocker.active = false;
    run(sim, 2, 1 / 60, shunted.x, shunted.z);
    expect(shunted.control).toBe('ambient');
  });

  it('will not back into traffic from inside a junction box', () => {
    const { sim, laneId } = makeSim();
    const info = sim.laneMeta(laneId);
    expect(info?.exit).toBeTruthy();
    if (!info?.exit) return;
    // Stopped inside the box, where it holds no junction claim and the
    // admission rules cannot see it.
    const car = seed(sim, laneId, info.exit.stopAlong + 2, 0);
    const { rx, rz } = axes(car);
    sim.applyImpact(car.id, {
      x: car.x,
      y: 0.6,
      z: car.z,
      dirX: rx,
      dirZ: rz,
      impulse: 3000,
      damage: 0,
    });
    run(sim, 5, 1 / 60, car.x, car.z);
    expect(car.control).toBe('loose');
    expect(car.active).toBe(true);
  });

  it('is published to the rest of traffic as something to queue behind', () => {
    const plan = getCityPlan();
    const network = buildRoadNetwork(plan);
    const ground = new CityGround(plan);
    const system = new TrafficSystem({ plan, ground, network, quality: 'medium' });
    try {
      for (let i = 0; i < 120; i += 1) {
        system.update(1 / 60, { x: plan.spawn.x, z: plan.spawn.z, time: i / 60 });
      }
      const target = system.vehicles.find((v) => v.control === 'ambient');
      expect(target).toBeDefined();
      if (!target) return;
      const { fx, fz } = { fx: -Math.sin(target.yaw), fz: -Math.cos(target.yaw) };
      expect(
        system.applyImpact(target.id, {
          x: target.x - fx * target.halfLength,
          y: 0.6,
          z: target.z - fz * target.halfLength,
          dirX: fx,
          dirZ: fz,
          impulse: 9000,
          damage: 0,
        }),
      ).toBe(true);

      const wreck = system.vehicles.find((v) => v.id === target.id);
      expect(wreck?.control).toBe('loose');
      system.update(1 / 60, { x: plan.spawn.x, z: plan.spawn.z, time: 3 });
      // Traffic must still keep clear of it: obstacle publication now covers
      // every car the AI is not driving, not only the player's.
      let nearest = Infinity;
      system.forEachNear(wreck?.x ?? 0, wreck?.z ?? 0, 12, (view) => {
        if (view.id === target.id || view.control !== 'ambient') return;
        nearest = Math.min(nearest, Math.hypot(view.x - (wreck?.x ?? 0), view.z - (wreck?.z ?? 0)));
      });
      if (nearest < Infinity) expect(nearest).toBeGreaterThan(2);
    } finally {
      system.dispose();
    }
  });
});

// -- going over -------------------------------------------------------------

describe('an overturned car', () => {
  /** A lateral hit a metre above the contact patches: a lorry into the flank. */
  function tBone(vehicle: Vehicle, impulse: number): VehicleImpact {
    const { rx, rz } = axes(vehicle);
    return {
      x: vehicle.x - rx * vehicle.blueprint.width * 0.5,
      y: 1,
      z: vehicle.z - rz * vehicle.blueprint.width * 0.5,
      dirX: rx,
      dirZ: rz,
      impulse,
      damage: 0,
    };
  }

  it('rocks back onto its wheels below the tipping threshold', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    sim.applyImpact(car.id, tBone(car, 10000));
    run(sim, 6);
    expect(car.view.overturned).toBe(false);
    expect(car.control).toBe('ambient');
    expect(car.crashRoll).toBe(0);
  });

  it('goes over above it, and never rejoins a lane', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    sim.applyImpact(car.id, tBone(car, 13000));
    run(sim, 6);
    expect(car.view.overturned).toBe(true);
    expect(car.control, 'a car on its roof is not ambient traffic').toBe('parked');
    expect(car.view.control, 'nobody is driving it').toBe('loose');
    expect(car.view.state).toBe('parked');
    expect(Math.abs(car.crashRoll)).toBeCloseTo(Math.PI, 2);
    // The roll survives the distance culling that zeroes the road-slope angles.
    run(sim, 1, 1 / 60, 900, 900);
    expect(Math.abs(car.crashRoll)).toBeCloseTo(Math.PI, 2);
    expect(Math.abs(car.view.roll)).toBeGreaterThan(2.5);
    // And it is lifted onto its roof rather than sunk into the road.
    expect(car.bodyLift).toBeCloseTo(car.blueprint.height, 2);
  });

  it('stays on its roof where it stopped, watched or not', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    sim.applyImpact(car.id, tBone(car, 13000));
    // Watched from close by, it stays: nothing may vanish in front of the
    // player who just caused it.
    run(sim, 25, 1 / 30, car.x, car.z);
    expect(car.control).toBe('parked');
    expect(car.view.overturned).toBe(true);
    const restX = car.x;
    const restZ = car.z;
    const restYaw = car.yaw;

    // AND IT STILL STAYS once the camera has moved on. A wreck is part of the
    // bounded abandoned pool now, not something on a countdown: one wreck is
    // far below `PARKED_LIMIT`, so nothing is removed and the car the player
    // rolled is still lying there when they come back. See the cleanup tests
    // in `abandonedVehicle.test.ts` for the rule that eventually clears it.
    run(sim, 30, 1 / 30, car.x + 400, car.z + 400);
    expect(car.active).toBe(true);
    expect(car.view.overturned).toBe(true);
    expect(car.x).toBeCloseTo(restX, 6);
    expect(car.z).toBeCloseTo(restZ, 6);
    expect(car.yaw).toBeCloseTo(restYaw, 6);
  });

  it('cannot be taken over by a driving layer', () => {
    const plan = getCityPlan();
    const network = buildRoadNetwork(plan);
    const ground = new CityGround(plan);
    const system = new TrafficSystem({ plan, ground, network, quality: 'medium' });
    try {
      for (let i = 0; i < 60; i += 1) {
        system.update(1 / 60, { x: plan.spawn.x, z: plan.spawn.z, time: i / 60 });
      }
      const target = system.vehicles.find((v) => v.control === 'ambient');
      expect(target).toBeDefined();
      if (!target) return;
      system.applyImpact(target.id, {
        x: target.x,
        y: 0.6,
        z: target.z,
        dirX: 1,
        dirZ: 0,
        impulse: 9000,
        damage: 0,
      });
      expect(system.takeControl(target.id)).toBeNull();
    } finally {
      system.dispose();
    }
  });
});

// -- damage -----------------------------------------------------------------

describe('one damage model for every car', () => {
  it('accumulates and saturates on the police integrity scale', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    expect(car.integrity).toBe(VEHICLE_INTEGRITY);
    expect(car.view.integrity).toBe(VEHICLE_INTEGRITY);

    expect(sim.applyDamage(car.id, 60)).toBe(true);
    expect(car.integrity).toBe(VEHICLE_INTEGRITY - 60);
    expect(sim.applyDamage(car.id, 60)).toBe(true);
    expect(car.integrity).toBe(VEHICLE_INTEGRITY - 120);
    expect(car.damage).toBeCloseTo(120 / VEHICLE_INTEGRITY, 6);

    // It never goes below zero however much more is thrown at it.
    expect(sim.applyDamage(car.id, 10_000)).toBe(true);
    expect(car.integrity).toBe(0);
    expect(car.damage).toBe(1);
    expect(sim.applyDamage(car.id, 10_000)).toBe(true);
    expect(car.integrity).toBe(0);

    // Published on the next step the vehicle takes. Distant cars run on the
    // simulation stride, so give it more than a single frame.
    run(sim, 0.2, 1 / 60, car.x, car.z);
    expect(car.view.integrity).toBe(0);
    expect(car.view.damage).toBe(1);
  });

  it('is not rate limited the way an impulse is - a rifle fires faster', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    for (let i = 0; i < 5; i += 1) expect(sim.applyDamage(car.id, 10)).toBe(true);
    expect(car.integrity).toBe(VEHICLE_INTEGRITY - 50);
  });

  it('scales a collision to a write-off at the crash that would cause one', () => {
    // Two 1400 kg cars closing at 15 m/s transfer about 12 kN.s. See
    // `impactDamage`: that is the crash a car does not drive away from.
    expect(impactDamage(12000)).toBeCloseTo(VEHICLE_INTEGRITY, 5);
    // A parking shunt costs a fifth of the shell, not the whole car.
    expect(impactDamage(2415)).toBeGreaterThan(VEHICLE_INTEGRITY * 0.15);
    expect(impactDamage(2415)).toBeLessThan(VEHICLE_INTEGRITY * 0.25);
    expect(impactDamage(-50)).toBe(0);
  });

  it('will not let a written-off car rejoin traffic', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    sim.applyImpact(car.id, rearEnd(car, 6000));
    sim.applyDamage(car.id, VEHICLE_INTEGRITY);
    run(sim, 6);
    expect(car.integrity).toBe(0);
    expect(car.control, 'a write-off is a wreck, not traffic').toBe('parked');
    expect(car.view.destroyed).toBe(true);
    expect(car.view.handling.power, 'a write-off has no engine').toBe(0);
  });
});

// -- the hook the rest of the game hangs off --------------------------------

describe('the impact hook', () => {
  it('reports every resolved impact once, with an intensity', () => {
    const plan = getCityPlan();
    const network = buildRoadNetwork(plan);
    const ground = new CityGround(plan);
    const system = new TrafficSystem({ plan, ground, network, quality: 'medium' });
    try {
      const heard: { intensity: number; kind: string }[] = [];
      system.onImpact = (info) => {
        heard.push({ intensity: info.intensity, kind: info.kind });
      };
      system.update(1 / 60, { x: plan.spawn.x, z: plan.spawn.z, time: 0 });
      const target = system.vehicles.find((v) => v.control === 'ambient');
      expect(target).toBeDefined();
      if (!target) return;

      system.applyImpact(target.id, {
        x: target.x,
        y: 0.6,
        z: target.z,
        dirX: 1,
        dirZ: 0,
        impulse: 9000,
        damage: 40,
      });
      expect(heard.length).toBe(1);
      expect(heard[0]?.kind).toBe('vehicle');
      expect(heard[0]?.intensity).toBeGreaterThan(0);
      expect(heard[0]?.intensity).toBeLessThanOrEqual(1);

      // The refused repeat is silent as well as inert.
      system.applyImpact(target.id, {
        x: target.x,
        y: 0.6,
        z: target.z,
        dirX: 1,
        dirZ: 0,
        impulse: 9000,
        damage: 40,
      });
      expect(heard.length).toBe(1);

      // Somebody else's collision reaches the same subscription.
      system.reportImpact(1, 2, 3, 0.4, 'world');
      expect(heard.length).toBe(2);
      expect(heard[1]?.kind).toBe('world');
    } finally {
      system.dispose();
    }
  });

  it('hands the chassis out so a caller can do momentum with it', () => {
    const plan = getCityPlan();
    const network = buildRoadNetwork(plan);
    const ground = new CityGround(plan);
    const system = new TrafficSystem({ plan, ground, network, quality: 'medium' });
    try {
      system.update(1 / 60, { x: plan.spawn.x, z: plan.spawn.z, time: 0 });
      const target = system.vehicles[0];
      expect(target).toBeDefined();
      if (!target) return;
      const chassis = system.chassisOf(target.id);
      expect(chassis).not.toBeNull();
      expect(chassis?.mass).toBeGreaterThan(900);
      expect(system.chassisOf(999_999)).toBeNull();
    } finally {
      system.dispose();
    }
  });
});

// -- the car nobody in here owns --------------------------------------------

describe('a vehicle whose pose is written from outside', () => {
  it('banks its impulse instead of being moved, and hands it over once', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    sim.detach(car);
    expect(car.control).toBe('player');

    const { fx, fz } = axes(car);
    expect(
      sim.applyImpact(car.id, {
        x: car.x - fx * 2.2,
        y: 0.6,
        z: car.z - fz * 2.2,
        dirX: fx,
        dirZ: fz,
        impulse: 7000,
        damage: 33,
      }),
    ).toBe(true);
    // Not moved: somebody else owns the pose.
    expect(car.control).toBe('player');
    expect(car.vx).toBe(0);
    expect(car.vz).toBe(0);
    expect(car.integrity).toBe(VEHICLE_INTEGRITY - 33);

    const banked = sim.takeImpulse(car.id);
    expect(banked).not.toBeNull();
    expect(Math.hypot(banked?.x ?? 0, banked?.z ?? 0)).toBeCloseTo(7000, 3);
    expect(banked?.damage).toBe(33);
    // Collected once. A second poll finds nothing.
    expect(sim.takeImpulse(car.id)).toBeNull();
  });

  it('is struck by an ambient car that runs into the back of it', () => {
    const { sim, laneId } = makeSim();
    // Parked across the lane, with a car arriving behind it at speed.
    const parked = seed(sim, laneId, 60, 0);
    sim.detach(parked);
    const runner = seed(sim, laneId, 56, 9);

    let banked: { x: number; z: number; yaw: number; damage: number } | null = null;
    for (let i = 0; i < 60 * 3 && !banked; i += 1) {
      sim.update(1 / 60, 0, 0, i / 60);
      banked = sim.takeImpulse(parked.id);
    }
    expect(banked, 'nothing ever ran into the parked car').not.toBeNull();
    if (!banked) return;
    // Pushed forwards, i.e. away from whatever hit it from behind.
    const { fx, fz } = axes(parked);
    expect(banked.x * fx + banked.z * fz).toBeGreaterThan(0);
    expect(banked.damage).toBeGreaterThan(0);
    // And the car that ran into it was knocked out of the traffic AI.
    expect(runner.control).toBe('loose');
  });
});

// -- against the world ------------------------------------------------------

describe('a free body against the city', () => {
  /** A wall running east-west at z = 0, as `CollisionWorld` would report it. */
  function wall(): {
    moveBox: (
      x: number,
      z: number,
      yaw: number,
      dx: number,
      dz: number,
      halfLength: number,
      halfWidth: number,
      feetY: number,
      height: number,
      vehicles?: boolean,
    ) => { x: number; z: number; feetY: number };
  } {
    return {
      moveBox: (x, z, _yaw, dx, dz, halfLength, _halfWidth, feetY) => {
        const limit = 4 + halfLength;
        const wantZ = z + dz;
        return { x: x + dx, z: wantZ < limit ? Math.max(z, limit) : wantZ, feetY };
      },
    };
  }

  it('bounces off a wall, loses speed to it and takes damage from it', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    sim.setCollision(wall());
    // Placed north of the wall and thrown at it.
    car.x = 0;
    car.z = 12;
    car.yaw = 0;
    car.vx = 0;
    car.vz = 0;
    const heard: string[] = [];
    sim.impactListener = (_x, _y, _z, _intensity, kind) => heard.push(kind);
    sim.applyImpact(car.id, {
      x: 0,
      y: 0.6,
      z: 12 + car.blueprint.length * 0.5,
      dirX: 0,
      dirZ: -1,
      impulse: 12000,
      damage: 0,
    });
    const launched = Math.abs(car.vz);
    // Watched only while it is a free body: once it settles and rejoins a lane
    // the traffic AI owns it again, and the AI drives on rails rather than
    // against the collision world.
    let deepest = car.z;
    for (let i = 0; i < 60 * 3 && car.control === 'loose'; i += 1) {
      sim.update(1 / 60, 0, 0, i / 60);
      deepest = Math.min(deepest, car.z);
    }
    const face = 4 + car.blueprint.length * 0.5;
    expect(deepest, `reached z = ${deepest.toFixed(3)}, the wall stops it at ${face}`).toBeGreaterThan(
      face - 0.01,
    );
    // Free travel would have carried it eleven metres, to z = 0.1.
    expect(deepest).toBeLessThan(12);
    expect(Math.abs(car.vz)).toBeLessThan(launched);
    expect(car.integrity, 'the wall cost it some of its shell').toBeLessThan(VEHICLE_INTEGRITY);
    expect(heard).toContain('world');
  });

  it('slides, spins and settles with no collision world at all', () => {
    // Every headless test and audit runs like this; a missing world must not
    // be a missing simulation.
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    sim.applyImpact(car.id, rearEnd(car, 8000));
    run(sim, 6);
    expect(car.control).toBe('ambient');
  });
});
