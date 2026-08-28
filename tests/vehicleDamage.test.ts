/**
 * Cars are not invulnerable, and the damage they take is somewhere.
 *
 * Before this a car had one number - `integrity` - and nothing read it except
 * a colour tint: a saloon with its engine bay emptied into drove exactly as
 * well as one straight off the forecourt, and a write-off carried on down its
 * lane until something else knocked it out of it.
 *
 * What follows pins the model that replaced it. Damage lands WHERE IT HIT: on
 * the panel under the contact point, on the glazing when it went in above the
 * belt line, on the tyre when it went into a wheel arch. Each of those does
 * something - a wrecked engine bay takes the power away, a flat tyre drags the
 * steering and costs grip, a write-off stops being a car - and a blast is
 * unmistakably not a bullet.
 *
 * Arithmetic only. No renderer, no browser.
 */

import { describe, expect, it } from 'vitest';

import { buildRoadNetwork, lanePoint, type RoadNetwork } from '../src/city/RoadNetwork';
import { getCityPlan, type CityPlan, type Street } from '../src/world/CityPlan';
import { CityGround } from '../src/world/CityGround';
import { TrafficSim, type Vehicle } from '../src/traffic/TrafficSim';
import { TrafficSystem } from '../src/traffic/TrafficSystem';
import { VEHICLE_BLUEPRINTS } from '../src/traffic/VehicleCatalogue';
import {
  BLAST_SHARE,
  ENGINE_SOFT,
  GLASS_CAPACITY,
  REGION_CAPACITY,
  TYRE_CAPACITY,
  VEHICLE_INTEGRITY,
  type VehicleImpact,
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
    seed: 'damage-test',
  });
  const lane = net.lanes.find((l) => l.streetId === 'a');
  if (!lane) throw new Error('no lane on street a');
  return { sim, net, laneId: lane.id };
}

function seed(
  sim: TrafficSim,
  laneId: string,
  along: number,
  speed: number,
  kind: 'sedan' | 'patrolSedan' = 'sedan',
): Vehicle {
  sim.resize(sim.vehicles.length + 1);
  const vehicle = sim.vehicles[sim.vehicles.length - 1] as Vehicle;
  const info = sim.laneMeta(laneId);
  if (!info) throw new Error(`no lane ${laneId}`);
  vehicle.kind = kind;
  vehicle.blueprint = VEHICLE_BLUEPRINTS[kind];
  vehicle.view.kind = kind;
  vehicle.view.police = kind === 'patrolSedan';
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

/** A world point on the vehicle, in its own frame. All three in metres. */
function at(
  vehicle: Vehicle,
  forward: number,
  right: number,
  height: number,
): { x: number; y: number; z: number } {
  const { fx, fz, rx, rz } = axes(vehicle);
  return {
    x: vehicle.x + fx * forward + rx * right,
    y: vehicle.y + height,
    z: vehicle.z + fz * forward + rz * right,
  };
}

/** One rifle round, in the game's own numbers: 34 points, no impulse. */
const RIFLE_ROUND = 34;

function run(sim: TrafficSim, seconds: number, step = 1 / 60, cameraX = 0, cameraZ = 0): void {
  for (let i = 0; i < Math.round(seconds / step); i += 1) {
    sim.update(step, cameraX, cameraZ, i * step);
  }
}

// -- bullets ----------------------------------------------------------------

describe('bullets damage the panel they hit', () => {
  it('accumulates monotonically, round after round', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    const nose = at(car, car.blueprint.length * 0.45, 0, 0.75);

    let lastIntegrity = car.integrity;
    let lastFront = car.view.regions.front;
    for (let i = 0; i < 5; i += 1) {
      expect(sim.applyDamage(car.id, RIFLE_ROUND, nose.x, nose.y, nose.z)).toBe(true);
      expect(car.integrity).toBeLessThan(lastIntegrity);
      expect(car.view.regions.front).toBeGreaterThan(lastFront);
      lastIntegrity = car.integrity;
      lastFront = car.view.regions.front;
    }
    // Five rounds into the bonnet: 170 of the shell's 260 points gone, and the
    // engine bay finished, because a region holds less than the whole car
    // does. The shell itself is still standing.
    expect(car.integrity).toBeCloseTo(VEHICLE_INTEGRITY - 5 * RIFLE_ROUND, 6);
    expect(car.view.regions.front).toBe(1);
  });

  it('keeps the damage where it landed and nowhere else', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    const nose = at(car, car.blueprint.length * 0.45, 0, 0.75);
    for (let i = 0; i < 4; i += 1) sim.applyDamage(car.id, RIFLE_ROUND, nose.x, nose.y, nose.z);

    const regions = car.view.regions;
    expect(regions.front).toBeGreaterThan(0.6);
    // The boot behind it is barely marked: the spread floor is 0.04 against a
    // front weight of 1, so the rear takes about four per cent of each round.
    expect(regions.rear).toBeLessThan(0.1);
    expect(regions.front / Math.max(regions.rear, 1e-6)).toBeGreaterThan(8);
  });

  it('takes the glazing out when the round goes in above the belt line', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    const window = at(car, 0, car.blueprint.width * 0.4, car.blueprint.beltY + 0.25);
    const sill = at(car, 0, car.blueprint.width * 0.4, car.blueprint.beltY - 0.35);

    sim.applyDamage(car.id, GLASS_CAPACITY * 0.5, sill.x, sill.y, sill.z);
    expect(car.view.regions.glass, 'a round through a door is not a window').toBeLessThan(0.1);

    sim.applyDamage(car.id, GLASS_CAPACITY, window.x, window.y, window.z);
    expect(car.view.regions.glass).toBeGreaterThan(0.9);
  });

  it('flats the tyre a round goes into, and pulls the steering that way', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    const chassis = car.blueprint.chassis;
    // Front near side: forward of centre by the axle, out past the flank, low.
    const wheel = at(
      car,
      chassis.frontAxle,
      -car.blueprint.width * 0.48,
      car.blueprint.wheelRadius,
    );
    sim.applyDamage(car.id, TYRE_CAPACITY, wheel.x, wheel.y, wheel.z);

    const tyres = car.view.regions.tyres;
    expect(tyres[0], 'the front near-side tyre').toBe(1);
    expect(tyres[1]).toBe(0);
    expect(tyres[2]).toBe(0);
    expect(tyres[3]).toBe(0);
    // Positive yaw is a left turn here, and the near side is the left, so a
    // flat there pulls left.
    expect(car.view.handling.pull).toBeGreaterThan(0);
    expect(car.view.handling.grip).toBeLessThan(1);

    // Symmetric on the other side.
    const other = makeSim();
    const twin = seed(other.sim, other.laneId, 40, 0);
    const offside = at(twin, chassis.frontAxle, twin.blueprint.width * 0.48, twin.blueprint.wheelRadius);
    other.sim.applyDamage(twin.id, TYRE_CAPACITY, offside.x, offside.y, offside.z);
    expect(twin.view.regions.tyres[1]).toBe(1);
    expect(twin.view.handling.pull).toBeCloseTo(-car.view.handling.pull, 9);
  });

  it('spreads damage evenly when the caller does not know where it hit', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    // Under the blast threshold, so this is ordinary damage with no location
    // rather than an explosion nobody bothered to place.
    sim.applyDamage(car.id, REGION_CAPACITY * 0.4);
    const regions = car.view.regions;
    expect(regions.front).toBeCloseTo(0.1, 6);
    expect(regions.rear).toBeCloseTo(0.1, 6);
    expect(regions.left).toBeCloseTo(0.1, 6);
    expect(regions.right).toBeCloseTo(0.1, 6);
    expect(regions.glass).toBe(0);
  });
});

// -- what damage does to the driving ----------------------------------------

describe('damage changes how the car drives, at documented thresholds', () => {
  it('holds full power until the engine bay is past ENGINE_SOFT', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    const nose = at(car, car.blueprint.length * 0.45, 0, 0.75);

    // Two rifle rounds in the bonnet, which is under the threshold: nothing
    // has changed about the way it drives.
    sim.applyDamage(car.id, RIFLE_ROUND, nose.x, nose.y, nose.z);
    sim.applyDamage(car.id, RIFLE_ROUND, nose.x, nose.y, nose.z);
    expect(car.view.regions.front).toBeLessThan(ENGINE_SOFT);
    expect(car.view.handling.power).toBe(1);

    // A third puts it past, and the power starts going.
    sim.applyDamage(car.id, RIFLE_ROUND, nose.x, nose.y, nose.z);
    expect(car.view.regions.front).toBeGreaterThan(ENGINE_SOFT);
    expect(car.view.handling.power).toBeLessThan(1);
    expect(car.view.handling.power).toBeGreaterThan(0);
  });

  it('kills the engine outright when the bay is destroyed', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    const nose = at(car, car.blueprint.length * 0.45, 0, 0.75);
    for (let i = 0; i < 5; i += 1) sim.applyDamage(car.id, RIFLE_ROUND, nose.x, nose.y, nose.z);
    expect(car.view.regions.front).toBe(1);
    expect(car.view.handling.power).toBe(0);
    // And the shell is still standing: a dead engine is not a write-off.
    expect(car.integrity).toBeGreaterThan(0);
    expect(car.view.destroyed).toBe(false);
  });

  it('stops a car whose engine is gone from driving away', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 9);
    const nose = at(car, car.blueprint.length * 0.45, 0, 0.75);
    for (let i = 0; i < 5; i += 1) sim.applyDamage(car.id, RIFLE_ROUND, nose.x, nose.y, nose.z);
    expect(car.view.handling.power).toBe(0);
    run(sim, 6, 1 / 60, car.x, car.z);
    // The traffic AI is still driving it - it has a driver - but with no power
    // to reach for it rolls to a stop rather than carrying on at the limit.
    expect(car.control).toBe('ambient');
    expect(car.speed).toBeLessThan(0.5);
  });

  it('costs grip for every tyre that goes', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    const chassis = car.blueprint.chassis;
    const before = car.view.handling.grip;
    expect(before).toBe(1);

    const corners: [number, number][] = [
      [chassis.frontAxle, -1],
      [chassis.frontAxle, 1],
      [chassis.frontAxle - chassis.wheelbase, -1],
    ];
    let last = before;
    for (const [along, side] of corners) {
      const point = at(car, along, side * car.blueprint.width * 0.48, car.blueprint.wheelRadius);
      sim.applyDamage(car.id, TYRE_CAPACITY, point.x, point.y, point.z);
      expect(car.view.handling.grip).toBeLessThan(last);
      last = car.view.handling.grip;
    }
    // Never to nothing: a car on three rims still steers, badly.
    expect(car.view.handling.grip).toBeGreaterThanOrEqual(0.3);
  });
});

// -- terminal damage --------------------------------------------------------

describe('a destroyed car', () => {
  it('stops driving, stays present and reports itself destroyed', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 11);
    sim.applyDamage(car.id, VEHICLE_INTEGRITY);

    expect(car.view.destroyed).toBe(true);
    expect(car.view.handling.destroyed).toBe(true);
    expect(car.view.handling.power).toBe(0);
    // Cut loose the instant it is written off, so it coasts to a stop where it
    // was rather than continuing down its lane with no engine.
    expect(car.control).toBe('loose');

    run(sim, 8, 1 / 60, car.x, car.z);
    expect(car.active, 'a write-off must not disappear').toBe(true);
    expect(car.control, 'a write-off is parked, not traffic').toBe('parked');
    expect(car.speed).toBe(0);

    // Still there a long time later, in the same place.
    const restX = car.x;
    const restZ = car.z;
    run(sim, 40, 1 / 30, car.x, car.z);
    expect(car.active).toBe(true);
    expect(car.x).toBe(restX);
    expect(car.z).toBe(restZ);
    expect(car.view.destroyed).toBe(true);
  });

  it('burns, and then is a burnt-out shell rather than a permanent bonfire', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    sim.applyDamage(car.id, VEHICLE_INTEGRITY);

    run(sim, 2, 1 / 60, car.x, car.z);
    expect(car.view.fire, 'a write-off catches').toBeGreaterThan(0.5);
    expect(car.view.smoke).toBeGreaterThan(0.5);

    run(sim, 20, 1 / 60, car.x, car.z);
    expect(car.view.fire, 'the flame goes out').toBe(0);

    run(sim, 15, 1 / 60, car.x, car.z);
    expect(car.view.smoke, 'and so does the smoke').toBe(0);
    // The shell stays.
    expect(car.active).toBe(true);
    expect(car.view.destroyed).toBe(true);
  });

  it('cannot be got into', () => {
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
      expect(system.applyDamage(target.id, VEHICLE_INTEGRITY)).toBe(true);
      expect(system.takeControl(target.id), 'a write-off is not a car').toBeNull();
    } finally {
      system.dispose();
    }
  });

  it('applies the same model to a patrol car as to any other', () => {
    const ordinary = makeSim();
    const police = makeSim();
    const car = seed(ordinary.sim, ordinary.laneId, 40, 0, 'sedan');
    const patrol = seed(police.sim, police.laneId, 40, 0, 'patrolSedan');
    expect(patrol.view.police).toBe(true);

    const rounds = 6;
    for (let i = 0; i < rounds; i += 1) {
      const a = at(car, car.blueprint.length * 0.45, 0, 0.75);
      const b = at(patrol, patrol.blueprint.length * 0.45, 0, 0.75);
      ordinary.sim.applyDamage(car.id, RIFLE_ROUND, a.x, a.y, a.z);
      police.sim.applyDamage(patrol.id, RIFLE_ROUND, b.x, b.y, b.z);
    }
    expect(patrol.integrity).toBe(car.integrity);
    expect(patrol.view.regions.front).toBeCloseTo(car.view.regions.front, 9);
    expect(patrol.view.handling.power).toBeCloseTo(car.view.handling.power, 9);
  });
});

// -- a rocket is not a bullet -----------------------------------------------

describe('a blast is unmistakably not a bullet', () => {
  /** The launcher's own numbers: 190 points of blast, 7000 N.s of shove. */
  function warhead(vehicle: Vehicle, share: number): VehicleImpact {
    const { rx, rz } = axes(vehicle);
    return {
      x: vehicle.x - rx * vehicle.blueprint.width * 0.5,
      y: vehicle.y + 0.7,
      z: vehicle.z - rz * vehicle.blueprint.width * 0.5,
      dirX: rx,
      dirZ: rz,
      impulse: 7000 * share,
      damage: 190 * share,
    };
  }

  it('does far more damage than a magazine, in one blow', () => {
    const gunfire = makeSim();
    const rocket = makeSim();
    const shot = seed(gunfire.sim, gunfire.laneId, 40, 0);
    const blown = seed(rocket.sim, rocket.laneId, 40, 0);

    // Four rifle rounds into the bonnet - most of a burst.
    const nose = at(shot, shot.blueprint.length * 0.45, 0, 0.75);
    for (let i = 0; i < 4; i += 1) {
      gunfire.sim.applyDamage(shot.id, RIFLE_ROUND, nose.x, nose.y, nose.z);
    }
    rocket.sim.applyImpact(blown.id, warhead(blown, 1));

    expect(190).toBeGreaterThan(VEHICLE_INTEGRITY * BLAST_SHARE);
    expect(VEHICLE_INTEGRITY - blown.integrity).toBeGreaterThan(
      (VEHICLE_INTEGRITY - shot.integrity) * 1.3,
    );
  });

  it('blows the glazing out and shreds the tyres on the side it came from', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    sim.applyImpact(car.id, warhead(car, 1));

    expect(car.view.regions.glass, 'every window goes').toBe(1);
    const tyres = car.view.regions.tyres;
    // The warhead above arrives on the near side, so the near-side pair go.
    expect(tyres[0]).toBeGreaterThan(0.9);
    expect(tyres[2]).toBeGreaterThan(0.9);
    expect(tyres[1]).toBe(0);
    expect(tyres[3]).toBe(0);
  });

  it('wraps the damage around the body where a bullet marks one panel', () => {
    const gunfire = makeSim();
    const rocket = makeSim();
    const shot = seed(gunfire.sim, gunfire.laneId, 40, 0);
    const blown = seed(rocket.sim, rocket.laneId, 40, 0);

    // The same total damage, one blow against many.
    const flank = at(shot, 0, -shot.blueprint.width * 0.5, 0.7);
    for (let i = 0; i < 6; i += 1) {
      gunfire.sim.applyDamage(shot.id, 190 / 6, flank.x, flank.y, flank.z);
    }
    rocket.sim.applyImpact(blown.id, warhead(blown, 1));

    // Gunfire concentrates: the far flank is untouched. A blast does not.
    expect(shot.view.regions.left / Math.max(shot.view.regions.right, 1e-6)).toBeGreaterThan(8);
    expect(blown.view.regions.right).toBeGreaterThan(shot.view.regions.right * 3);
  });

  it('shoves the car it hits sideways, where gunfire does not move it at all', () => {
    const gunfire = makeSim();
    const rocket = makeSim();
    const shot = seed(gunfire.sim, gunfire.laneId, 40, 0);
    const blown = seed(rocket.sim, rocket.laneId, 40, 0);
    // A lane whose `axis` is 'x' is offset in X and RUNS along Z, so lateral
    // displacement is displacement in X - and a car driving off down its own
    // lane cannot be mistaken for having been shoved off it.
    const shotX = shot.x;
    const blownX = blown.x;

    const flank = at(shot, 0, -shot.blueprint.width * 0.5, 0.7);
    for (let i = 0; i < 6; i += 1) {
      gunfire.sim.applyDamage(shot.id, RIFLE_ROUND, flank.x, flank.y, flank.z);
    }
    // No impulse at all from gunfire: a bullet dents a car, it does not push one.
    expect(Math.hypot(shot.vx, shot.vz)).toBe(0);
    expect(shot.control).toBe('ambient');

    rocket.sim.applyImpact(blown.id, warhead(blown, 1));
    // 7000 N.s into 1350 kg is 5.2 m/s, five times the threshold that frees a
    // car from its lane.
    expect(Math.hypot(blown.vx, blown.vz)).toBeGreaterThan(4);
    expect(blown.control, 'a rocket takes the car out of traffic').toBe('loose');

    run(gunfire.sim, 2, 1 / 60, shot.x, shot.z);
    run(rocket.sim, 2, 1 / 60, blown.x, blown.z);
    expect(Math.abs(shot.x - shotX), 'gunfire did not move it off its lane').toBeLessThan(0.3);
    expect(Math.abs(blown.x - blownX), 'the blast threw it clear').toBeGreaterThan(1);
  });
});

// -- boundedness ------------------------------------------------------------

describe('destruction stays bounded', () => {
  it('caps the wrecks a rampage can leave behind', () => {
    const plan = getCityPlan();
    const network = buildRoadNetwork(plan);
    const ground = new CityGround(plan);
    const system = new TrafficSystem({ plan, ground, network, quality: 'high' });
    try {
      for (let i = 0; i < 120; i += 1) {
        system.update(1 / 60, { x: plan.spawn.x, z: plan.spawn.z, time: i / 60 });
      }
      const limit = system.stats.parkedLimit;
      expect(limit).toBeGreaterThan(0);

      // Write off everything within reach, repeatedly, and keep the camera on
      // the scene of the crime the whole time.
      for (let pass = 0; pass < 40; pass += 1) {
        const doomed: number[] = [];
        system.forEachNear(plan.spawn.x, plan.spawn.z, 120, (view) => {
          if (!view.destroyed) doomed.push(view.id);
        });
        for (const id of doomed) system.applyDamage(id, VEHICLE_INTEGRITY);
        for (let i = 0; i < 30; i += 1) {
          system.update(1 / 60, { x: plan.spawn.x, z: plan.spawn.z, time: 2 + pass + i / 60 });
        }
        // Never unbounded, even with the player standing in the middle of it.
        expect(system.stats.parked).toBeLessThanOrEqual(16);
        expect(system.stats.particles).toBeLessThanOrEqual(96);
      }

      // Walk away, and it settles back to the documented cap.
      for (let i = 0; i < 240; i += 1) {
        system.update(1 / 60, { x: 4000, z: 4000, time: 100 + i / 60 });
      }
      expect(system.stats.parked).toBeLessThanOrEqual(limit);
      // And the draw-call ceiling never moved: damage is instanced.
      expect(system.stats.drawCalls).toBeLessThanOrEqual(13);
    } finally {
      system.dispose();
    }
  });
});
