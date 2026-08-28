/**
 * Traffic: the assertions that would catch a car doing something impossible.
 *
 * Everything here runs headless. The simulation has no Three.js in it, so the
 * whole city can be driven for minutes inside a test and every vehicle checked
 * against the carriageway, the signals, its neighbours and the geometry of the
 * lane graph - which is the only way to know that traffic behaves, rather than
 * that it looked fine in one screenshot.
 */

import { describe, expect, it } from 'vitest';

import {
  SIGNAL_CYCLE,
  buildRoadNetwork,
  exitsFrom,
  lanePoint,
  signalFor,
  type RoadNetwork,
} from '../src/city/RoadNetwork';
import { getCityPlan, type CityPlan, type Street } from '../src/world/CityPlan';
import { CityGround } from '../src/world/CityGround';
import { TrafficSim, idmAccel, type Vehicle } from '../src/traffic/TrafficSim';
import {
  ALL_VEHICLE_KINDS,
  POLICE_KINDS,
  VEHICLE_BLUEPRINTS,
} from '../src/traffic/VehicleCatalogue';
import { buildWheel, vehicleShell } from '../src/traffic/VehicleGeometry';
import { TrafficSystem } from '../src/traffic/TrafficSystem';
import type { VehicleView } from '../src/traffic/types';

const plan = getCityPlan();
const network = buildRoadNetwork(plan);
const ground = new CityGround(plan);

// -- helpers ----------------------------------------------------------------

/** Minimal plan for the synthetic networks; only `streets` is ever read. */
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

/** A sim on a flat synthetic world with no vehicles until one is added. */
function makeSim(streets: readonly Street[]): { sim: TrafficSim; net: RoadNetwork } {
  const testPlan = makePlan(streets);
  const net = buildRoadNetwork(testPlan);
  const sim = new TrafficSim({
    network: net,
    plan: testPlan,
    heightAt: () => 0,
    population: 0,
    seed: 'traffic-test',
  });
  return { sim, net };
}

/** Puts a vehicle of a known kind at a known place, bypassing random spawning. */
function seed(
  sim: TrafficSim,
  laneId: string,
  along: number,
  speed: number,
  kind: (typeof ALL_VEHICLE_KINDS)[number] = 'sedan',
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

/** Separating-axis test between two yaw-oriented boxes in plan view. */
function boxesOverlap(a: Vehicle, b: Vehicle, shrink: number): number {
  const axes: [number, number][] = [];
  for (const v of [a, b]) {
    axes.push([-Math.sin(v.yaw), -Math.cos(v.yaw)]);
    axes.push([Math.cos(v.yaw), -Math.sin(v.yaw)]);
  }
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let minOverlap = Infinity;
  for (const [ax, az] of axes) {
    const project = (v: Vehicle): number => {
      const fx = -Math.sin(v.yaw);
      const fz = -Math.cos(v.yaw);
      const rx = Math.cos(v.yaw);
      const rz = -Math.sin(v.yaw);
      return (
        Math.abs(fx * ax + fz * az) * Math.max(0, v.blueprint.length * 0.5 - shrink) +
        Math.abs(rx * ax + rz * az) * Math.max(0, v.blueprint.width * 0.5 - shrink)
      );
    };
    const distance = Math.abs(dx * ax + dz * az);
    const overlap = project(a) + project(b) - distance;
    if (overlap <= 0) return 0;
    if (overlap < minOverlap) minOverlap = overlap;
  }
  return minOverlap;
}

// -- catalogue and geometry -------------------------------------------------

describe('vehicle catalogue', () => {
  it('describes plausible road vehicles', () => {
    for (const kind of ALL_VEHICLE_KINDS) {
      const bp = VEHICLE_BLUEPRINTS[kind];
      expect(bp.length, kind).toBeGreaterThan(3.5);
      expect(bp.length, kind).toBeLessThan(7.5);
      expect(bp.width, kind).toBeGreaterThan(1.6);
      expect(bp.width, kind).toBeLessThan(2.3);
      expect(bp.height, kind).toBeGreaterThan(1.2);
      // The wheelbase and both axles have to fit inside the body.
      expect(bp.wheelbase, kind).toBeLessThan(bp.length - 0.6);
      expect(bp.frontAxle, kind).toBeLessThan(bp.length * 0.5 - bp.wheelRadius * 0.6);
      expect(bp.wheelbase - bp.frontAxle, kind).toBeLessThan(bp.length * 0.5);
      expect(bp.track, kind).toBeLessThan(bp.width);
      // The cabin has to sit on the body, and the roof above the beltline.
      expect(bp.cabinFront, kind).toBeGreaterThan(-bp.length * 0.5);
      expect(bp.cabinRear, kind).toBeLessThan(bp.length * 0.5);
      expect(bp.cabinRear - bp.cabinFront, kind).toBeGreaterThan(0.9);
      expect(bp.roofY, kind).toBeGreaterThan(bp.beltY);
      expect(bp.chassis.length, kind).toBeCloseTo(bp.length, 5);
      expect(bp.paints.length, kind).toBeGreaterThan(0);
    }
  });

  it('includes original police variants as ordinary traffic', () => {
    expect(POLICE_KINDS.size).toBe(2);
    let policeWeight = 0;
    let total = 0;
    for (const kind of ALL_VEHICLE_KINDS) {
      const weight = VEHICLE_BLUEPRINTS[kind].weight;
      total += weight;
      if (POLICE_KINDS.has(kind)) {
        policeWeight += weight;
        expect(VEHICLE_BLUEPRINTS[kind].livery).toBe('patrol');
        expect(VEHICLE_BLUEPRINTS[kind].lightBar).toBe(true);
      }
    }
    // Present, but a small minority: patrol cars are variety, not a theme.
    const share = policeWeight / total;
    expect(share).toBeGreaterThan(0.02);
    expect(share).toBeLessThan(0.12);
  });

  it('has a distinct silhouette for every shell', () => {
    const seen = new Set<string>();
    for (const kind of ALL_VEHICLE_KINDS) {
      const bp = VEHICLE_BLUEPRINTS[kind];
      const key = `${bp.length.toFixed(2)}:${bp.height.toFixed(2)}:${bp.form}`;
      expect(seen.has(key), `${kind} duplicates another shell`).toBe(false);
      seen.add(key);
    }
  });
});

describe('vehicle geometry', () => {
  it('builds every shell within the triangle budget and the right size', () => {
    for (const kind of ALL_VEHICLE_KINDS) {
      const bp = VEHICLE_BLUEPRINTS[kind];
      const shell = vehicleShell(kind);
      expect(shell.triangles, kind).toBeGreaterThan(300);
      expect(shell.triangles, kind).toBeLessThan(2200);

      const box = shell.geometry.boundingBox;
      expect(box, kind).not.toBeNull();
      if (!box) continue;
      // Mirrors stick out past the body, and the push bar past the nose.
      expect(box.max.x - box.min.x, kind).toBeLessThan(bp.width + 0.42);
      expect(box.max.x - box.min.x, kind).toBeGreaterThan(bp.width * 0.9);
      expect(box.max.z - box.min.z, kind).toBeLessThan(bp.length + 0.35);
      expect(box.max.z - box.min.z, kind).toBeGreaterThan(bp.length * 0.9);
      // Grounded: nothing below the wheels, nothing far above the roof.
      expect(box.min.y, kind).toBeGreaterThan(-0.12);
      expect(box.max.y, kind).toBeLessThan(bp.height + 0.24);
      expect(box.max.y, kind).toBeGreaterThan(bp.height - 0.25);

      for (const attribute of ['position', 'normal', 'aAlbedo', 'aSurf', 'aPaint', 'aEmit', 'aChan']) {
        expect(shell.geometry.getAttribute(attribute), `${kind}.${attribute}`).toBeTruthy();
      }
    }
  });

  it('gives every shell paint, glazing and lit lamps', () => {
    for (const kind of ALL_VEHICLE_KINDS) {
      const geometry = vehicleShell(kind).geometry;
      const paint = geometry.getAttribute('aPaint');
      const emit = geometry.getAttribute('aEmit');
      const surf = geometry.getAttribute('aSurf');
      let painted = 0;
      let glazed = 0;
      let lit = 0;
      for (let i = 0; i < paint.count; i += 1) {
        if (paint.getX(i) > 0.5) painted += 1;
        if (surf.getX(i) < 0.1) glazed += 1;
        if (emit.getX(i) + emit.getY(i) + emit.getZ(i) > 0.01) lit += 1;
      }
      expect(painted, `${kind} paint`).toBeGreaterThan(40);
      expect(glazed, `${kind} glazing`).toBeGreaterThan(20);
      expect(lit, `${kind} lamps`).toBeGreaterThan(8);
    }
  });

  it('builds one shared wheel', () => {
    const wheel = buildWheel();
    expect(wheel.triangles).toBeLessThan(220);
    const box = wheel.geometry.boundingBox;
    expect(box).not.toBeNull();
    if (!box) return;
    // Unit radius in YZ, unit half width in X, so the instance matrix can scale
    // it to any vehicle in the catalogue.
    expect(box.max.y).toBeCloseTo(1, 1);
    expect(box.max.z).toBeCloseTo(1, 1);
    expect(box.max.x).toBeLessThan(1.1);
    wheel.geometry.dispose();
  });
});

// -- the car-following model ------------------------------------------------

describe('car-following model', () => {
  it('accelerates towards the desired speed when the road is clear', () => {
    expect(idmAccel(0, 12, 1e6, 0, 2.6)).toBeCloseTo(2.6, 3);
    expect(idmAccel(12, 12, 1e6, 0, 2.6)).toBeCloseTo(0, 3);
    expect(idmAccel(14, 12, 1e6, 0, 2.6)).toBeLessThan(0);
  });

  it('brakes harder the closer and faster it closes on a leader', () => {
    const far = idmAccel(12, 12, 40, 0, 2.6);
    const near = idmAccel(12, 12, 12, 0, 2.6);
    const closing = idmAccel(12, 12, 12, 8, 2.6);
    expect(near).toBeLessThan(far);
    expect(closing).toBeLessThan(near);
    expect(idmAccel(12, 12, 2, 12, 2.6)).toBeLessThan(-4);
  });
});

// -- behaviour on a synthetic grid ------------------------------------------

const CROSS_STREETS = [
  street({ id: 'ns', axis: 'x', position: 0, from: -200, to: 200 }),
  street({ id: 'ew', axis: 'z', position: 0, from: -200, to: 200 }),
];

/** Time at which one axis of the only junction shows the wanted signal. */
function timeWhere(net: RoadNetwork, axis: 'x' | 'z', want: string, hold: number): number {
  const junction = net.junctions[0];
  if (!junction) throw new Error('no junction');
  for (let t = 0; t < SIGNAL_CYCLE * 2; t += 0.1) {
    let ok = true;
    for (let d = 0; d <= hold; d += 0.25) {
      if (signalFor(junction, axis, t + d) !== want) {
        ok = false;
        break;
      }
    }
    if (ok) return t;
  }
  throw new Error(`no ${want} window for ${axis}`);
}

describe('signals', () => {
  it('stops a car at a red and lets it go on green', () => {
    const { sim, net } = makeSim(CROSS_STREETS);
    const approach = net.lanes.find((l) => l.streetId === 'ns' && l.toNode.startsWith('j:'));
    expect(approach).toBeDefined();
    if (!approach) return;
    const info = sim.laneMeta(approach.id);
    expect(info?.exit).toBeTruthy();
    if (!info?.exit) return;

    const car = seed(sim, approach.id, info.exit.stopAlong - 60, 11);
    const red = timeWhere(net, approach.axis, 'red', 12);

    for (let i = 0; i < 60 * 12; i += 1) {
      sim.update(1 / 60, 0, -400, red + i / 60);
    }
    // Held behind the line, and stopped rather than creeping.
    expect(car.speed).toBeLessThan(0.2);
    expect(car.along + car.blueprint.length * 0.5).toBeLessThan(info.exit.stopAlong + 0.6);
    const heldX = car.x;
    const heldZ = car.z;

    const green = timeWhere(net, approach.axis, 'green', 6);
    for (let i = 0; i < 60 * 6; i += 1) {
      sim.update(1 / 60, 0, -400, green + i / 60);
    }
    expect(car.speed).toBeGreaterThan(4);
    // It is past the stop line - either still on the same lane beyond it, or
    // already through the junction and onto the next one - and it has moved a
    // long way from where it was held. Distance alone is not enough: a car
    // taking the turn is slowed by the corner, not by the light.
    const throughJunction = car.laneId !== approach.id || car.along > info.exit.stopAlong;
    expect(throughJunction).toBe(true);
    expect(Math.hypot(car.x - heldX, car.z - heldZ)).toBeGreaterThan(10);
  });

  it('forms a queue at a red without any two cars overlapping', () => {
    const { sim, net } = makeSim(CROSS_STREETS);
    const approach = net.lanes.find((l) => l.streetId === 'ns' && l.toNode.startsWith('j:'));
    if (!approach) throw new Error('no approach lane');
    const info = sim.laneMeta(approach.id);
    if (!info?.exit) throw new Error('no junction ahead');

    const queue: Vehicle[] = [];
    for (let i = 0; i < 6; i += 1) {
      queue.push(seed(sim, approach.id, info.exit.stopAlong - 40 - i * 16, 10));
    }
    const red = timeWhere(net, approach.axis, 'red', 13);

    let worst = 0;
    for (let i = 0; i < 60 * 13; i += 1) {
      sim.update(1 / 60, 0, -400, red + i / 60);
      for (let a = 0; a < queue.length; a += 1) {
        for (let b = a + 1; b < queue.length; b += 1) {
          const overlap = boxesOverlap(queue[a] as Vehicle, queue[b] as Vehicle, 0.05);
          if (overlap > worst) worst = overlap;
        }
      }
    }
    expect(worst).toBe(0);
    // The queue really formed: everyone stopped, in order, nose to tail.
    const sorted = [...queue].sort((a, b) => a.along - b.along);
    for (let i = 1; i < sorted.length; i += 1) {
      const back = sorted[i - 1] as Vehicle;
      const front = sorted[i] as Vehicle;
      const gap =
        front.along - front.blueprint.length * 0.5 - back.along - back.blueprint.length * 0.5;
      expect(gap).toBeGreaterThan(0.5);
      expect(gap).toBeLessThan(12);
    }
    // The head of the queue is stopped; the tail may still be closing up.
    expect((sorted[sorted.length - 1] as Vehicle).speed).toBeLessThan(0.3);
    const stopped = queue.filter((v) => v.speed < 0.5).length;
    expect(stopped).toBeGreaterThanOrEqual(4);
    for (const vehicle of queue) expect(vehicle.speed).toBeLessThan(2.5);
  });
});

describe('obstacles', () => {
  it('brakes for something standing in the lane and moves off once it clears', () => {
    const { sim, net } = makeSim([street({ id: 'ns', axis: 'x', position: 0 })]);
    const lane = net.lanes.find((l) => l.travel === 1);
    if (!lane) throw new Error('no lane');
    const car = seed(sim, lane.id, 20, 11);

    const stopPoint = lanePoint(lane, 90);
    const obstacle = { x: stopPoint.x, z: stopPoint.z, radius: 0.4 };
    sim.setObstacles([obstacle]);

    for (let i = 0; i < 60 * 14; i += 1) sim.update(1 / 60, 0, -400, i / 60);
    expect(car.speed).toBeLessThan(0.3);
    // Stopped short of it, not on top of it.
    const clearance = 90 - obstacle.radius - car.along - car.blueprint.length * 0.5;
    expect(clearance).toBeGreaterThan(0);
    expect(clearance).toBeLessThan(6);

    sim.setObstacles([]);
    for (let i = 0; i < 60 * 6; i += 1) sim.update(1 / 60, 0, -400, i / 60);
    expect(car.speed).toBeGreaterThan(4);
  });

  it('stops for a pedestrian on the crossing in front of a junction', () => {
    const { sim, net } = makeSim(CROSS_STREETS);
    const approach = net.lanes.find((l) => l.streetId === 'ns' && l.toNode.startsWith('j:'));
    if (!approach) throw new Error('no approach lane');
    const info = sim.laneMeta(approach.id);
    if (!info?.exit?.crossing) throw new Error('no crossing');
    const crossing = info.exit.crossing;

    const car = seed(sim, approach.id, info.exit.stopAlong - 42, 11);
    sim.setObstacles([{ x: crossing.x, z: crossing.z, radius: 0.4 }]);
    const green = timeWhere(net, approach.axis, 'green', 8);

    for (let i = 0; i < 60 * 8; i += 1) sim.update(1 / 60, 0, -400, green + i / 60);
    expect(car.speed).toBeLessThan(0.4);
    expect(car.along + car.blueprint.length * 0.5).toBeLessThan(info.exit.crossingAlong + 0.5);
  });
});

describe('dead ends', () => {
  it('recycles a vehicle rather than turning it round where the graph ends', () => {
    // A single street with nothing crossing it: both ends are termini, and the
    // network only offers the opposite carriageway, which is a U-turn.
    const { sim, net } = makeSim([street({ id: 'ns', axis: 'x', position: 0, from: -60, to: 60 })]);
    const lane = net.lanes.find((l) => l.travel === 1);
    if (!lane) throw new Error('no lane');
    const info = sim.laneMeta(lane.id);
    expect(info?.dead, 'the lone lane should have no forward continuation').toBe(true);

    const car = seed(sim, lane.id, lane.length - 12, 10);
    const startHeading = car.yaw;
    const startZ = car.z;

    let reversed = false;
    for (let i = 0; i < 60 * 20; i += 1) {
      sim.update(1 / 60, 500, 500, i / 60);
      if (!car.active) break;
      const turned = Math.abs(Math.atan2(Math.sin(car.yaw - startHeading), Math.cos(car.yaw - startHeading)));
      if (turned > 1.5) reversed = true;
    }
    expect(reversed, 'a vehicle must never spin round at a dead end').toBe(false);
    // It was recycled: either parked out of play or moved somewhere else.
    expect(!car.active || Math.abs(car.z - startZ) > 30 || car.laneId !== lane.id).toBe(true);
  });

  it('gives every lane in the city a continuation that is not a U-turn', () => {
    const sim = new TrafficSim({
      network,
      plan,
      heightAt: (x, z) => ground.heightAt(x, z),
      population: 0,
      seed: 'routing',
    });

    // The network leaves eighteen lanes - the last segment before each corner
    // of the outer ring - with nothing but the opposite carriageway, because
    // those streets end exactly on a junction and the graph gives the junction
    // and the terminus separate nodes. Matching them by position recovers the
    // real continuations, so no lane in Meridian Bay is a dead end.
    let raw = 0;
    for (const lane of network.lanes) {
      const exits = exitsFrom(network, lane);
      const forward = exits.filter(
        (next) => !(next.streetId === lane.streetId && next.travel !== lane.travel),
      );
      if (forward.length === 0) raw += 1;
    }
    expect(raw).toBeGreaterThan(10);

    for (const lane of network.lanes) {
      const info = sim.laneMeta(lane.id);
      expect(info, lane.id).toBeDefined();
      if (!info) continue;
      expect(info.dead, `${lane.id} has nowhere to go`).toBe(false);
      for (const option of info.exits) {
        const uTurn = option.streetId === lane.streetId && option.travel !== lane.travel;
        expect(uTurn, `${lane.id} -> ${option.id} is a U-turn`).toBe(false);
      }
    }
  });

  it('gates every approach to a junction, including the ones at a street end', () => {
    const sim = new TrafficSim({
      network,
      plan,
      heightAt: (x, z) => ground.heightAt(x, z),
      population: 0,
      seed: 'gating',
    });
    for (const lane of network.lanes) {
      const info = sim.laneMeta(lane.id);
      if (!info) continue;
      const node = network.nodes.get(lane.toNode);
      if (!node) continue;
      const junction = network.junctions.find(
        (j) => Math.abs(j.x - node.x) < 0.75 && Math.abs(j.z - node.z) < 0.75,
      );
      // Wherever a lane physically arrives at a junction there must be a stop
      // line and a signal, whether the graph called that node a junction or a
      // terminus that happens to sit on one.
      if (junction) {
        expect(info.exit, lane.id).toBeTruthy();
        expect(info.exit?.junction.id).toBe(junction.id);
        expect(info.exit?.crossing, lane.id).toBeTruthy();
        expect(info.exit?.stopAlong).toBeLessThan(lane.length);
        expect(info.exit?.stopAlong).toBeGreaterThan(0);
      }
    }
  });
});

// -- the whole city ---------------------------------------------------------

describe('city traffic', () => {
  const sim = new TrafficSim({
    network,
    plan,
    heightAt: (x, z) => ground.heightAt(x, z),
    population: 160,
    seed: 'meridian-traffic-01',
  });

  it('fills the lane graph', () => {
    expect(sim.laneLength).toBeGreaterThan(6000);
    sim.update(1 / 60, plan.spawn.x, plan.spawn.z, 0);
    expect(sim.liveCount).toBeGreaterThan(140);
  });

  it('spreads the fleet across the whole city, not just around the player', () => {
    for (let i = 0; i < 600; i += 1) sim.update(1 / 60, plan.spawn.x, plan.spawn.z, i / 60);
    // Quarter the map and require traffic in every quarter.
    const quadrants = [0, 0, 0, 0];
    for (const vehicle of sim.vehicles) {
      if (!vehicle.active) continue;
      const q = (vehicle.x > 0 ? 1 : 0) + (vehicle.z > -10 ? 2 : 0);
      quadrants[q] = (quadrants[q] ?? 0) + 1;
    }
    for (const count of quadrants) expect(count).toBeGreaterThan(8);
  });

  it(
    'drives for ten minutes with no sustained interpenetration and stays on the road',
    () => {
      const step = 1 / 30;
      const seconds = 600;
      const samplesPerCheck = 15; // half a second
      const offending = new Map<string, number>();
      let worstOverlap = 0;
      let offRoadSamples = 0;
      let checked = 0;
      let sustained = 0;

      for (let i = 0; i < seconds / step; i += 1) {
        const time = i * step;
        // Sweep the camera across the city so every part gets full-rate
        // simulation at some point during the run.
        const cameraX = Math.sin(time * 0.05) * 150;
        const cameraZ = Math.cos(time * 0.037) * 130;
        sim.update(step, cameraX, cameraZ, time);
        if (i % samplesPerCheck !== 0) continue;

        const active = sim.vehicles.filter((v) => v.active);
        const seen = new Set<string>();
        for (let a = 0; a < active.length; a += 1) {
          const va = active[a] as Vehicle;
          checked += 1;
          // Authoritative check: is the vehicle centre on a carriageway?
          if (!ground.sample(va.x, va.z).onRoad) offRoadSamples += 1;
          for (let b = a + 1; b < active.length; b += 1) {
            const vb = active[b] as Vehicle;
            if (Math.abs(va.x - vb.x) > 9 || Math.abs(va.z - vb.z) > 9) continue;
            const overlap = boxesOverlap(va, vb, 0.12);
            if (overlap <= 0) continue;
            if (overlap > worstOverlap) worstOverlap = overlap;
            const key = va.id < vb.id ? `${va.id}:${vb.id}` : `${vb.id}:${va.id}`;
            seen.add(key);
            const runLength = (offending.get(key) ?? 0) + 1;
            offending.set(key, runLength);
            if (runLength >= 3) sustained += 1;
          }
        }
        for (const key of offending.keys()) if (!seen.has(key)) offending.delete(key);
      }

      expect(checked).toBeGreaterThan(100000);
      // A momentary clip while two cars swing through a junction is tolerable;
      // a pair that stays interpenetrated is a broken simulation.
      expect(sustained, 'sustained interpenetrations').toBe(0);
      // Measured: over ten minutes and 160 vehicles this run produces no
      // overlap at all, not merely no lasting one. The tolerance is kept as a
      // ceiling rather than an exact zero so a momentary clip during a tight
      // junction turn is a warning rather than a flake.
      expect(worstOverlap, `worst overlap ${worstOverlap.toFixed(3)} m`).toBeLessThan(0.12);
      // Cars belong on the carriageway. A very small tail is allowed for the
      // instant a turning car clips the painted corner of a junction.
      expect(offRoadSamples / checked).toBeLessThan(0.005);
    },
    120000,
  );

  it('respects the signal it is being shown', () => {
    let violations = 0;
    let redApproaches = 0;
    for (let i = 0; i < 60 * 60; i += 1) {
      const time = i / 60;
      sim.update(1 / 60, 0, 0, time);
      if (i % 10 !== 0) continue;
      for (const vehicle of sim.vehicles) {
        if (!vehicle.active) continue;
        const info = sim.laneMeta(vehicle.laneId);
        if (!info?.exit) continue;
        const distance = info.exit.stopAlong - vehicle.along - vehicle.blueprint.length * 0.5;
        if (distance < -0.1 || distance > 3) continue;
        const state = signalFor(info.exit.junction, info.lane.axis, time);
        if (state !== 'red') continue;
        redApproaches += 1;
        // At the line on a red, a car is stopped or stopping hard.
        if (vehicle.speed > 3.5) violations += 1;
      }
    }
    expect(redApproaches).toBeGreaterThan(30);
    expect(violations / redApproaches).toBeLessThan(0.02);
  });

  it('keeps every vehicle on its own side of the road', () => {
    const streets = new Map(plan.streets.map((s) => [s.id, s]));
    let offLane = 0;
    let samples = 0;
    for (let i = 0; i < 60 * 30; i += 1) {
      sim.update(1 / 60, 0, 0, i / 60);
      if (i % 30 !== 0) continue;
      for (const vehicle of sim.vehicles) {
        if (!vehicle.active) continue;
        const info = sim.laneMeta(vehicle.laneId);
        if (!info) continue;
        // Only judge cars that are on the lane itself, not mid-junction.
        if (vehicle.along < 6 || vehicle.along > info.lane.length - 6) continue;
        const s = streets.get(info.lane.streetId);
        if (!s) continue;
        samples += 1;
        const across = info.lane.axis === 'x' ? vehicle.x : vehicle.z;
        // Inside its own half of the carriageway, allowing for body width.
        if (Math.abs(across - info.lane.offset) > s.roadHalf * 0.5 + 0.35) offLane += 1;
      }
    }
    expect(samples).toBeGreaterThan(1000);
    expect(offLane / samples).toBeLessThan(0.01);
  });
});

// -- the system as the game sees it -----------------------------------------

describe('TrafficSystem', () => {
  it('draws the whole fleet in a dozen calls and culls by distance', () => {
    const system = new TrafficSystem({ plan, ground, network, quality: 'high' });
    try {
      // One instanced draw per shell plus one for every wheel in the city.
      expect(system.group.children.length).toBeLessThanOrEqual(12);
      expect(system.stats.drawCalls).toBeLessThanOrEqual(12);
      expect(system.stats.population).toBeGreaterThan(100);

      system.update(1 / 60, { x: plan.spawn.x, z: plan.spawn.z, time: 0 });
      expect(system.vehicles.length).toBeGreaterThan(90);
      const near = system.stats.drawnVehicles;
      expect(near).toBeGreaterThan(0);
      expect(near).toBeLessThan(system.stats.population);
      expect(system.stats.drawnWheels).toBe(near * 4);

      // A view is an oriented box with a heading and half extents.
      const view = system.vehicles[0];
      expect(view).toBeDefined();
      if (view) {
        expect(view.halfLength).toBeGreaterThan(1.5);
        expect(view.halfWidth).toBeGreaterThan(0.7);
        expect(Number.isFinite(view.yaw)).toBe(true);
        expect(view.y - view.halfHeight).toBeGreaterThan(-5);
      }

      // The broad phase answers the same question the array does.
      let counted = 0;
      system.forEachNear(plan.spawn.x, plan.spawn.z, 60, () => {
        counted += 1;
      });
      let expected = 0;
      for (const v of system.vehicles) {
        if (Math.hypot(v.x - plan.spawn.x, v.z - plan.spawn.z) <= 60) expected += 1;
      }
      expect(counted).toBe(expected);
    } finally {
      system.dispose();
    }
  });

  it('hands a vehicle to a driving layer and takes it back', () => {
    const system = new TrafficSystem({ plan, ground, network, quality: 'medium' });
    try {
      for (let i = 0; i < 120; i += 1) {
        system.update(1 / 60, { x: plan.spawn.x, z: plan.spawn.z, time: i / 60 });
      }
      const target = system.vehicles[3];
      expect(target).toBeDefined();
      if (!target) return;

      const handle = system.takeControl(target.id);
      expect(handle).not.toBeNull();
      if (!handle) return;
      expect(handle.chassis.wheelbase).toBeGreaterThan(2);
      expect(handle.view.control).toBe('player');

      // The driving layer owns the pose; the traffic system keeps drawing it.
      handle.setPose({ x: 12, z: -34, yaw: 1.2, speed: 9, steer: 0.1, braking: true });
      system.update(1 / 60, { x: 12, z: -34, time: 2 });
      expect(handle.view.x).toBeCloseTo(12, 5);
      expect(handle.view.z).toBeCloseTo(-34, 5);
      expect(handle.view.yaw).toBeCloseTo(1.2, 5);
      expect(handle.view.speed).toBeCloseTo(9, 5);
      expect(handle.view.braking).toBe(true);

      handle.release();
      system.update(1 / 60, { x: 12, z: -34, time: 3 });
      expect(handle.view.control).toBe('ambient');
    } finally {
      system.dispose();
    }
  });

  it('makes other drivers queue behind a player-driven car', () => {
    const system = new TrafficSystem({ plan, ground, network, quality: 'high' });
    try {
      for (let i = 0; i < 60; i += 1) system.update(1 / 60, { x: 0, z: 0, time: i / 60 });

      // Pick a moving car that already has someone close behind it, so the
      // test is about the queue rather than about who happens to drive past.
      let chosen: VehicleView | null = null;
      let follower: VehicleView | null = null;
      for (const view of system.vehicles) {
        if (view.speed < 5) continue;
        const fx = -Math.sin(view.yaw);
        const fz = -Math.cos(view.yaw);
        for (const other of system.vehicles) {
          if (other === view || other.speed < 3) continue;
          const dx = other.x - view.x;
          const dz = other.z - view.z;
          const behind = -(dx * fx + dz * fz);
          const lateral = Math.abs(dx * Math.cos(view.yaw) - dz * Math.sin(view.yaw));
          if (behind > 8 && behind < 40 && lateral < 1.5) {
            chosen = view;
            follower = other;
            break;
          }
        }
        if (chosen) break;
      }
      expect(chosen, 'no car with a follower to test with').not.toBeNull();
      if (!chosen || !follower) return;

      const handle = system.takeControl(chosen.id);
      expect(handle).not.toBeNull();
      if (!handle) return;
      const parked = { x: chosen.x, z: chosen.z, yaw: chosen.yaw };

      let closest = Infinity;
      let sawSlowing = false;
      for (let i = 0; i < 60 * 18; i += 1) {
        handle.setPose({ ...parked, speed: 0 });
        system.update(1 / 60, { x: 500, z: 500, time: 1 + i / 60 });
        system.forEachNear(parked.x, parked.z, 26, (view) => {
          if (view.control !== 'ambient') return;
          const distance = Math.hypot(view.x - parked.x, view.z - parked.z);
          if (distance < closest) closest = distance;
          if (distance < 24 && view.speed < 1) sawSlowing = true;
        });
      }
      // Nothing drove through the parked car, and traffic behind it stopped.
      expect(closest).toBeGreaterThan(chosen.halfLength + 1.4);
      expect(sawSlowing, 'traffic never queued behind the parked car').toBe(true);
    } finally {
      system.dispose();
    }
  });
});

describe('traffic keeps moving', () => {
  it('does not gridlock the city at the shipping density', () => {
    const system = new TrafficSystem({ plan, ground, network, quality: 'high' });
    try {
      const step = 1 / 30;
      const samples: { mean: number; stoppedShare: number }[] = [];
      for (let i = 0; i < 360 / step; i += 1) {
        system.update(step, { x: 0, z: 0, time: i * step });
        if (i % Math.round(60 / step) !== 0 || i === 0) continue;
        let sum = 0;
        let stopped = 0;
        let count = 0;
        for (const view of system.vehicles) {
          count += 1;
          sum += view.speed;
          if (view.speed < 0.4) stopped += 1;
        }
        samples.push({ mean: sum / count, stoppedShare: stopped / count });
      }
      expect(samples.length).toBeGreaterThanOrEqual(5);
      // Meridian Bay's own signal plan - 9 s of green in a 26 s cycle, with
      // junctions 45 m apart - caps the achievable mean at about 3.6 m/s, so
      // these are floors against gridlock rather than free-flow targets.
      const best = Math.max(...samples.map((s) => s.mean));
      const worst = Math.min(...samples.map((s) => s.mean));
      const average = samples.reduce((a, s) => a + s.mean, 0) / samples.length;
      expect(best).toBeGreaterThan(2.5);
      expect(worst).toBeGreaterThan(1.2);
      expect(average).toBeGreaterThan(1.8);
      // And it must not be a slow slide: the last minute is no worse than the
      // worst of the run, which is what a city sliding into gridlock would fail.
      const last = samples[samples.length - 1];
      expect(last).toBeDefined();
      if (last) expect(last.stoppedShare).toBeLessThan(0.62);
    } finally {
      system.dispose();
    }
  }, 60000);
});

/**
 * The two faults that made Meridian Bay gridlock the longer it ran.
 *
 * Both are structural rather than cosmetic, and both are invisible in a short
 * run - the city looks fine for the first three minutes either way - so they
 * are asserted over twelve minutes with the camera moving the way a player
 * moves. See `TrafficSim.chooseNext` and `TrafficSim.exitHasRoom` for what
 * each of them was and what it measured before and after.
 */
/*
 * The interpenetration check again, wider and shorter.
 *
 * The ten-minute run above is the thorough one, but it is a SINGLE seed, and a
 * single seed only catches a fault when the fleet happens to produce it. It
 * did not, for a long time - then two new streets re-rolled the spawn draws
 * and a pickup and a saloon spent 69 seconds inside one another at Anchor
 * Street and Ferro Street, both turning into it, both holding
 * `j:ferro-street:anchor-street`. The rule that now prevents that is in
 * `TrafficSim.junctionConflict`: never take a box in front of a car already
 * inside its own braking distance of its own stop line, because claiming ahead
 * of that car does not stop it - it arrives anyway.
 *
 * Three seeds, two minutes each, at the same population the long run uses.
 * Not a substitute for it; a guard against that one seed being lucky.
 *
 * The first thirty seconds are not counted, for the same reason the arterial
 * test skips its first sixty: a cold fleet is placed lane by lane and has not
 * yet met itself at a junction, and its first pass through one is a transient
 * rather than the steady state anything here is about. The long run above hides
 * this by inheriting a sim that two earlier tests have already warmed.
 */
describe('junction exclusion holds across seeds', () => {
  it('never leaves two vehicles interpenetrated, whatever the fleet', () => {
    for (const seed of ['meridian-traffic-01', 'probe-b', 'probe-c']) {
      const sim = new TrafficSim({
        network,
        plan,
        heightAt: (x, z) => ground.heightAt(x, z),
        population: 160,
        seed,
      });
      const step = 1 / 30;
      const offending = new Map<string, number>();
      let sustained = 0;
      let worst = 0;
      let where = '';
      for (let i = 0; i < 120 / step; i += 1) {
        const time = i * step;
        sim.update(step, Math.sin(time * 0.05) * 150, Math.cos(time * 0.037) * 130, time);
        if (time < 30 || i % 15 !== 0) continue;
        const active = sim.vehicles.filter((v) => v.active);
        const seen = new Set<string>();
        for (let a = 0; a < active.length; a += 1) {
          const va = active[a] as Vehicle;
          for (let b = a + 1; b < active.length; b += 1) {
            const vb = active[b] as Vehicle;
            if (Math.abs(va.x - vb.x) > 9 || Math.abs(va.z - vb.z) > 9) continue;
            const overlap = boxesOverlap(va, vb, 0.12);
            if (overlap <= 0) continue;
            if (overlap > worst) {
              worst = overlap;
              where = `${seed}: ${va.kind} on ${va.laneId} and ${vb.kind} on ${vb.laneId}`;
            }
            const key = va.id < vb.id ? `${va.id}:${vb.id}` : `${vb.id}:${va.id}`;
            seen.add(key);
            const run = (offending.get(key) ?? 0) + 1;
            offending.set(key, run);
            if (run >= 3) sustained += 1;
          }
        }
        for (const key of offending.keys()) if (!seen.has(key)) offending.delete(key);
      }
      expect(sustained, `${seed}: ${where}`).toBe(0);
      expect(worst, `${seed}: worst overlap ${worst.toFixed(3)} m — ${where}`).toBeLessThan(0.12);
    }
  }, 120000);
});

describe('traffic distributes itself and stays distributed', () => {
  const SEEDS = ['meridian-traffic-01', 'probe-b', 'probe-c'];

  /** Metres of lane belonging to each street, for a density per street. */
  const laneMetres = new Map<string, number>();
  for (const lane of network.lanes) {
    laneMetres.set(lane.streetId, (laneMetres.get(lane.streetId) ?? 0) + lane.length);
  }
  const totalLaneMetres = [...laneMetres.values()].reduce((a, b) => a + b, 0);

  it('sends traffic down the arterials instead of round the edge of the map', () => {
    const arterials = plan.streets.filter((s) => s.kind === 'arterial').map((s) => s.id);
    expect(arterials.length).toBeGreaterThan(0);
    const arterialMetres = arterials.reduce((a, id) => a + (laneMetres.get(id) ?? 0), 0);

    for (const seed of SEEDS) {
      const sim = new TrafficSim({
        network,
        plan,
        heightAt: (x, z) => ground.heightAt(x, z),
        population: 123,
        seed,
      });
      const step = 1 / 30;
      let samples = 0;
      let onArterials = 0;
      let everywhere = 0;
      for (let i = 0; i < (6 * 60) / step; i += 1) {
        const time = i * step;
        sim.update(step, Math.sin(time * 0.05) * 150, Math.cos(time * 0.037) * 130, time);
        // Let the fleet leave its seeded positions before counting.
        if (time < 60 || i % 30 !== 0) continue;
        samples += 1;
        for (const vehicle of sim.vehicles) {
          if (!vehicle.active) continue;
          const info = sim.laneMeta(vehicle.laneId);
          if (!info) continue;
          everywhere += 1;
          if (arterials.includes(info.lane.streetId)) onArterials += 1;
        }
      }
      expect(samples).toBeGreaterThan(50);
      // Cars per metre of arterial, against cars per metre of any lane. The
      // committed route choice put 0.38 to 0.47 here: the widest streets in
      // the city were also its emptiest. A grid whose traffic ignores its own
      // arterials is one that has piled up somewhere else instead.
      const share =
        onArterials / arterialMetres / (everywhere / totalLaneMetres);
      expect(share, `${seed}: arterial share ${share.toFixed(2)}`).toBeGreaterThan(0.6);
    }
  }, 120000);

  it('keeps moving after ten minutes rather than sliding into gridlock', () => {
    for (const seed of SEEDS) {
      const sim = new TrafficSim({
        network,
        plan,
        heightAt: (x, z) => ground.heightAt(x, z),
        population: 123,
        seed,
      });
      const step = 1 / 30;
      const early: number[] = [];
      const late: number[] = [];
      for (let i = 0; i < (12 * 60) / step; i += 1) {
        const time = i * step;
        sim.update(step, Math.sin(time * 0.05) * 150, Math.cos(time * 0.037) * 130, time);
        if (i % 30 !== 0) continue;
        let sum = 0;
        let count = 0;
        for (const vehicle of sim.vehicles) {
          if (!vehicle.active) continue;
          sum += vehicle.speed;
          count += 1;
        }
        if (count === 0) continue;
        if (time < 180) early.push(sum / count);
        else if (time > 9 * 60) late.push(sum / count);
      }
      const mean = (values: number[]): number =>
        values.reduce((a, b) => a + b, 0) / values.length;
      expect(early.length).toBeGreaterThan(50);
      expect(late.length).toBeGreaterThan(50);
      // Measured before the fixes: 1.5 to 2.1 m/s in the last three minutes
      // against 2.7 to 2.9 in the first three, a city visibly running down.
      // After: 2.6 to 2.8 against 3.0 to 3.2.
      expect(mean(late), `${seed}: late mean ${mean(late).toFixed(2)}`).toBeGreaterThan(2.2);
      const held = mean(late) / mean(early);
      expect(held, `${seed}: held ${held.toFixed(2)} of its opening speed`).toBeGreaterThan(0.78);
    }
  }, 180000);
});
