/**
 * A car the player gets out of stays where they left it.
 *
 * THE DEFECT THIS PINS. `Driving.exit` ended with `handle.release()`, which
 * went to `TrafficSystem.releaseControl`, which called `TrafficSim.attach`.
 * `attach` searched the whole lane graph for the nearest lane pointing roughly
 * the way the car happened to be facing, wrote the car onto it, zeroed its
 * velocity and chose it a new destination - so the traffic AI immediately
 * snapped the body onto that lane's centreline, rotated it to the lane heading
 * and drove it away. Worse, `attach` recycled the vehicle outright when no
 * lane scored well enough, so a car parked on a forecourt, in a car park or at
 * an angle in the road simply vanished and reappeared somewhere across the
 * city as a different-coloured car.
 *
 * What follows is the whole contract that replaced it: the transform is
 * untouched, the state is `parked`, no lane is ever rejoined, the car survives
 * in exactly the places the old attach search rejected, traffic still queues
 * behind it, it can be got back into, and the pool it belongs to is bounded
 * and is only ever emptied out of the player's sight.
 *
 * Arithmetic only. No renderer, no browser.
 */

import { describe, expect, it } from 'vitest';

import { buildRoadNetwork, lanePoint, type RoadNetwork } from '../src/city/RoadNetwork';
import { CityGround } from '../src/world/CityGround';
import { getCityPlan, type CityPlan, type Street } from '../src/world/CityPlan';
import { TrafficSim, type Vehicle } from '../src/traffic/TrafficSim';
import { TrafficSystem } from '../src/traffic/TrafficSystem';
import { VEHICLE_BLUEPRINTS } from '../src/traffic/VehicleCatalogue';

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
    seed: 'abandoned-test',
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

/**
 * Drives a car to an arbitrary pose and leaves it there, the way the player
 * does: `detach`, write the pose, `park`. That is exactly the sequence
 * `TrafficSystem.takeControl` / `handle.setPose` / `releaseControl` runs.
 */
function driveAndLeave(
  sim: TrafficSim,
  vehicle: Vehicle,
  x: number,
  z: number,
  yaw: number,
  speed = 0,
): void {
  sim.detach(vehicle);
  vehicle.x = x;
  vehicle.z = z;
  vehicle.yaw = yaw;
  vehicle.speed = speed;
  sim.park(vehicle);
}

function run(sim: TrafficSim, seconds: number, step = 1 / 60, cameraX = 0, cameraZ = 0): void {
  for (let i = 0; i < Math.round(seconds / step); i += 1) {
    sim.update(step, cameraX, cameraZ, i * step);
  }
}

// -- the contract -----------------------------------------------------------

describe('a car the player abandons', () => {
  it('does not move, rotate, rejoin a lane or vanish', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    // Somewhere no lane runs and at a heading no lane has: kerbed at an angle,
    // the way a car actually gets parked.
    const x = 24.5;
    const z = -17.25;
    const yaw = 0.83;
    driveAndLeave(sim, car, x, z, yaw);

    expect(car.control).toBe('parked');
    expect(car.view.state).toBe('parked');

    const laneBefore = car.laneId;
    // Ten seconds of fixed steps, watched from close by.
    run(sim, 10, 1 / 60, x, z);

    expect(car.active, 'the car the player parked was recycled').toBe(true);
    expect(car.control).toBe('parked');
    expect(car.view.state).toBe('parked');
    expect(car.x).toBeCloseTo(x, 9);
    expect(car.z).toBeCloseTo(z, 9);
    expect(car.yaw).toBeCloseTo(yaw, 9);
    expect(car.speed).toBe(0);
    // It never took a route, and never became an occupant of a lane again.
    expect(car.next).toBeNull();
    const info = sim.laneMeta(laneBefore);
    expect(info?.occupants.includes(car) ?? false).toBe(false);
  });

  it('survives in a spot the old attach search would have rejected', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    // `findAttachLane` refuses anything more than 1.0 rad off a lane heading
    // and scores `offset + facing * 6` against a threshold of 14, so a car
    // 120 m off the nearest carriageway is far outside it. The old
    // `releaseControl` recycled exactly this case.
    const x = 140;
    const z = 150;
    const yaw = 2.6;
    driveAndLeave(sim, car, x, z, yaw);

    run(sim, 20, 1 / 60, x, z);
    expect(car.active, 'a car parked off the road was deleted').toBe(true);
    expect(car.control).toBe('parked');
    expect(car.x).toBeCloseTo(x, 9);
    expect(car.z).toBeCloseTo(z, 9);
    expect(car.yaw).toBeCloseTo(yaw, 9);
  });

  it('rolls to a stop when it is let go of at a walking pace, and then stays', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    const yaw = 0.4;
    driveAndLeave(sim, car, 30, -30, yaw, 4);

    // Whatever speed it had is real velocity, not something teleported away.
    expect(Math.hypot(car.vx, car.vz)).toBeCloseTo(4, 6);
    run(sim, 4, 1 / 60, 30, -30);
    expect(car.speed).toBe(0);
    // Rolling drag is 3 m/s2, so 4 m/s coasts 2.7 m along its own heading.
    const travelled = Math.hypot(car.x - 30, car.z + 30);
    expect(travelled).toBeGreaterThan(1.5);
    expect(travelled).toBeLessThan(4);
    expect(car.yaw, 'coasting is not steering').toBeCloseTo(yaw, 6);

    // And once stopped it is frozen: not a millimetre over another ten seconds.
    const restX = car.x;
    const restZ = car.z;
    run(sim, 10, 1 / 60, 30, -30);
    expect(car.x).toBe(restX);
    expect(car.z).toBe(restZ);
  });

  it('keeps the damage it was parked with', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    sim.applyDamage(car.id, 90);
    const integrity = car.integrity;
    driveAndLeave(sim, car, 20, 20, 1.1);
    run(sim, 8, 1 / 60, 20, 20);
    expect(car.integrity).toBe(integrity);
    expect(car.view.damage).toBeGreaterThan(0);
  });

  it('can be got back into, and is not a wreck', () => {
    const { sim, laneId } = makeSim();
    const car = seed(sim, laneId, 40, 0);
    driveAndLeave(sim, car, 12, -8, 0.2);
    run(sim, 3, 1 / 60, 12, -8);

    sim.detach(car);
    expect(car.control).toBe('player');
    expect(car.view.state).toBe('player');
    // Taking it back out of the pool is what keeps the cleanup rule honest:
    // a car being driven is not something waiting to be tidied away.
    expect(sim.parkedCount).toBe(0);
  });
});

// -- the rest of the traffic ------------------------------------------------

describe('traffic around an abandoned car', () => {
  it('treats it as a static obstacle rather than driving through it', () => {
    const plan = getCityPlan();
    const network = buildRoadNetwork(plan);
    const ground = new CityGround(plan);
    const system = new TrafficSystem({ plan, ground, network, quality: 'high' });
    try {
      for (let i = 0; i < 120; i += 1) {
        system.update(1 / 60, { x: plan.spawn.x, z: plan.spawn.z, time: i / 60 });
      }
      // A moving car with somebody behind it, so this is about the queue.
      let chosen: { id: number; x: number; z: number; yaw: number; half: number } | null = null;
      for (const view of system.vehicles) {
        if (view.speed < 5 || view.control !== 'ambient') continue;
        chosen = { id: view.id, x: view.x, z: view.z, yaw: view.yaw, half: view.halfLength };
        break;
      }
      expect(chosen).not.toBeNull();
      if (!chosen) return;

      const handle = system.takeControl(chosen.id);
      expect(handle).not.toBeNull();
      if (!handle) return;
      handle.setPose({ x: chosen.x, z: chosen.z, yaw: chosen.yaw, speed: 0 });
      handle.release();

      let closest = Infinity;
      for (let i = 0; i < 60 * 20; i += 1) {
        system.update(1 / 60, { x: chosen.x, z: chosen.z, time: 2 + i / 60 });
        system.forEachNear(chosen.x, chosen.z, 26, (view) => {
          if (view.id === chosen.id || view.control !== 'ambient') return;
          const distance = Math.hypot(view.x - chosen.x, view.z - chosen.z);
          if (distance < closest) closest = distance;
        });
      }
      // Nothing drove through it, and it is still exactly where it was left.
      expect(closest).toBeGreaterThan(chosen.half + 1.2);
      expect(handle.view.x).toBeCloseTo(chosen.x, 5);
      expect(handle.view.z).toBeCloseTo(chosen.z, 5);
      expect(handle.view.yaw).toBeCloseTo(chosen.yaw, 5);
      expect(handle.view.state).toBe('parked');
    } finally {
      system.dispose();
    }
  });
});

// -- the bounded lifecycle --------------------------------------------------

describe('the abandoned pool is bounded, and only emptied out of sight', () => {
  it('never removes one that is still within the render distance', () => {
    const { sim, laneId } = makeSim();
    const { limit, removeDistance } = sim.parkedLimits;
    expect(removeDistance).toBeGreaterThan(140);

    // Twice the cap, every one of them under the camera's nose.
    const cars: Vehicle[] = [];
    for (let i = 0; i < limit * 2; i += 1) {
      const car = seed(sim, laneId, 20 + i * 0.001, 0);
      driveAndLeave(sim, car, i * 9 - 100, 60, 0.5);
      cars.push(car);
    }
    run(sim, 3, 1 / 60, 0, 60);
    for (const car of cars) {
      const distance = Math.hypot(car.x, car.z - 60);
      if (distance < removeDistance) {
        expect(car.active, 'a parked car inside the render distance was removed').toBe(true);
      }
    }
  });

  it('holds the pool at its cap once the player walks away', () => {
    const { sim, laneId } = makeSim();
    const { limit, hardLimit, removeDistance } = sim.parkedLimits;
    expect(hardLimit).toBeGreaterThanOrEqual(limit);

    for (let i = 0; i < limit + 8; i += 1) {
      const car = seed(sim, laneId, 20 + i * 0.001, 0);
      driveAndLeave(sim, car, i * 6 - 60, 40, 0.5);
      // The pool never exceeds the hard ceiling even while everything is in
      // view, which is the invariant that stops it growing without bound.
      expect(sim.parkedCount).toBeLessThanOrEqual(hardLimit);
    }

    // Walk well past the removal distance and let the lifecycle run.
    run(sim, 2, 1 / 60, removeDistance + 600, removeDistance + 600);
    expect(sim.parkedCount).toBeLessThanOrEqual(limit);
  });

  it('removes the oldest first, so the car you just left is the last to go', () => {
    const { sim, laneId } = makeSim();
    const { limit } = sim.parkedLimits;
    const cars: Vehicle[] = [];
    for (let i = 0; i < limit + 3; i += 1) {
      const car = seed(sim, laneId, 20 + i * 0.001, 0);
      driveAndLeave(sim, car, i * 6 - 60, 40, 0.5);
      cars.push(car);
    }
    // From far away every one of them is removable, so the cap decides.
    run(sim, 1, 1 / 60, 5000, 5000);
    expect(sim.parkedCount).toBe(limit);
    const newest = cars[cars.length - 1] as Vehicle;
    expect(newest.control, 'the most recently parked car went first').toBe('parked');
    const oldest = cars[0] as Vehicle;
    expect(oldest.control).not.toBe('parked');
  });
});
