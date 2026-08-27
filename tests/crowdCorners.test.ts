/**
 * Corners and crossings: the places a pedestrian gets stuck.
 *
 * `crowdDeadlock.test.ts` is the older file and covers deadlocks the crowd can
 * produce ON ITS OWN. Everything here needs TRAFFIC, and that is the whole
 * point: the crowd's crossing gate takes `ctx.vehicles`, the shipped game
 * passes 240 of them, and no test had ever supplied a single one. Measured with
 * live traffic on the code before these fixes, over ten minutes with 270
 * people: 202 pedestrians spent more than a minute rooted to a kerb and one
 * stood in the same spot for the entire run.
 */

import { describe, expect, it } from 'vitest';

import { buildRoadNetwork, SIGNAL_CYCLE, walkSignal } from '../src/city/RoadNetwork';
import { getCityPlan } from '../src/world/CityPlan';
import { CityGround } from '../src/world/CityGround';
import { Crowd, type CrowdVehicle, type Pedestrian } from '../src/agents/crowd';
import { ObstacleIndex } from '../src/agents/obstacles';
import { buildPavementGraph, linkPoint, type PavementLink } from '../src/agents/pavement';
import { TrafficSim } from '../src/traffic/TrafficSim';

const plan = getCityPlan();
const network = buildRoadNetwork(plan);
const ground = new CityGround(plan);
const graph = buildPavementGraph(plan, network);
const obstacles = new ObstacleIndex(plan, ground);

function makeCrowd(population: number): Crowd {
  return new Crowd({ ground, network, graph, obstacles, population, seed: plan.seed });
}

// -- the pavement a pedestrian is actually offered ---------------------------

describe('the pavement graph is one connected surface', () => {
  /**
   * Links reachable from `start` by the routes the router will actually offer,
   * stopped early once the answer is obviously "plenty".
   */
  function reach(crowd: Crowd, start: number, limit: number): number {
    const seen = new Set<number>([start]);
    const queue = [start];
    while (queue.length > 0 && seen.size < limit) {
      const from = queue.shift() as number;
      const link = graph.links[from];
      if (!link) continue;
      for (const candidate of graph.linksFrom[link.to] ?? []) {
        if (crowd.isClosed(candidate) || seen.has(candidate)) continue;
        seen.add(candidate);
        queue.push(candidate);
        if (seen.size >= limit) break;
      }
    }
    return seen.size;
  }

  /**
   * The station merge used to decide, by sort order alone, whether a junction
   * arm kept its CORNER or its CROSSING. The corner and the crossing land
   * 0.20 m apart on a 2.8 m pavement - the corner at `roadHalf + sidewalk / 2`
   * and the crossing at `roadHalf + 1.6` - and the survivor took the other's
   * place. Whichever it dropped was disconnected: an arm that kept the crossing
   * lost the turn into the cross street, and an arm that kept the corner had
   * its crossing built 0.20 m off the chain, sharing no node with it.
   *
   * Measured on the unfixed graph: 100 of 964 links - 50 whole crossings, more
   * than a quarter of the city's - could reach nothing but themselves and their
   * own reverse.
   */
  it('leaves no link that can only reach itself', () => {
    const crowd = makeCrowd(1);
    const stranded: string[] = [];
    for (let i = 0; i < graph.links.length; i += 1) {
      const link = graph.links[i];
      if (!link || crowd.isClosed(i)) continue;
      if (reach(crowd, i, 24) < 24) stranded.push(`${link.id} (reach ${reach(crowd, i, 24)})`);
    }
    expect(stranded, `${stranded.length} stranded links: ${stranded.slice(0, 6).join(', ')}`).toEqual(
      [],
    );
  });

  it('joins every crossing to the pavement on both kerbs', () => {
    let crossings = 0;
    for (let i = 0; i < graph.links.length; i += 1) {
      const link = graph.links[i];
      if (!link?.crossing) continue;
      crossings += 1;
      // Somebody must be able to step ONTO it from a pavement, and OFF it onto
      // one. A crossing joined at neither end is scenery; joined at one end it
      // is a trap.
      const onto = (graph.linksFrom[link.from] ?? []).some(
        (c) => c !== i && !graph.links[c]?.crossing,
      );
      const off = (graph.linksFrom[link.to] ?? []).some(
        (c) => c !== link.reverse && !graph.links[c]?.crossing,
      );
      expect(onto, `${link.id} cannot be stepped onto from any pavement`).toBe(true);
      expect(off, `${link.id} leads to no pavement`).toBe(true);
    }
    expect(crossings, 'no crossings in the graph at all').toBeGreaterThan(100);
  });
});

// -- the crossing gate ------------------------------------------------------

/** A crossing link with a pavement link running into it. */
function findApproach(): { pavement: number; crossing: number } {
  for (let i = 0; i < graph.links.length; i += 1) {
    const link = graph.links[i];
    if (!link || link.crossing) continue;
    for (const candidate of graph.linksFrom[link.to] ?? []) {
      if (graph.links[candidate]?.crossing) return { pavement: i, crossing: candidate };
    }
  }
  throw new Error('no pavement link leads to a crossing');
}

/** The first time at or after `from` at which this crossing shows a walk. */
function nextWalk(link: PavementLink, from: number): number {
  const crossing = link.crossing;
  if (!crossing) throw new Error('not a crossing');
  for (let t = from; t < from + SIGNAL_CYCLE * 2; t += 0.1) {
    if (walkSignal(network, crossing, t)) return t;
  }
  throw new Error('this crossing never shows a walk signal');
}

describe('a queue stopped at the lights does not veto the crossing', () => {
  /**
   * THE MECHANISM. `crossingClear` used to reject a crossing whenever any
   * vehicle's centre came within `link.length / 2 + 2.4` of the crossing's
   * centre - 11.15 m at a typical junction here, larger than the junction
   * itself. The queue stopped at the red is inside that circle by construction:
   * `TrafficSim` parks it with its nose 0.4 m short of the crossing.
   *
   * And `walkSignal` is true PRECISELY WHEN that carriageway is stopped, so the
   * two conditions were very nearly mutually exclusive. Measured over three
   * minutes with 240 vehicles: of 118,098 frames in which somebody stood at a
   * kerb with the walk signal in their favour, 117,809 were vetoed and ONE was
   * clear.
   *
   * This is that geometry exactly, and nothing else: one pedestrian, one
   * stationary car parked where the stop line puts it, and a walk signal.
   */
  it('lets a pedestrian cross in front of a car waiting at the stop line', () => {
    const { pavement, crossing } = findApproach();
    const approach = graph.links[pavement] as PavementLink;
    const cross = graph.links[crossing] as PavementLink;

    // Where `TrafficSim` leaves a car: nose 0.4 m short of the crossing strip,
    // lined up along the carriageway, which is the crossing link's normal.
    const halfLength = 2.3;
    const centreAlong = (cross.crossing?.halfWidth ?? 1.6) + 0.4 + halfLength;
    const cx = (cross.ax + cross.bx) * 0.5;
    const cz = (cross.az + cross.bz) * 0.5;
    const car: CrowdVehicle = {
      x: cx + cross.nx * centreAlong,
      z: cz + cross.nz * centreAlong,
      vx: 0,
      vz: 0,
      halfLength,
      halfWidth: 0.95,
    };

    const crowd = makeCrowd(1);
    const point = { x: 0, z: 0 };
    linkPoint(approach, approach.length - 2, 0, point);
    // Far enough away that the player's own avoidance never touches them.
    const px = point.x;
    const pz = point.z + 120;
    const start = nextWalk(cross, 0);

    crowd.update(1 / 30, { x: px, y: 0, z: pz, time: start, vehicles: [car] });
    const ped = crowd.peds[0] as Pedestrian;
    ped.active = true;
    ped.link = pavement;
    ped.next = crossing;
    ped.along = approach.length - 2;
    ped.lateral = 0;
    ped.lateralTarget = 0;
    ped.state = 'walk';
    ped.timer = 0;
    ped.due = 0;
    ped.x = point.x;
    ped.z = point.z;
    ped.vx = approach.dx * ped.speed;
    ped.vz = approach.dz * ped.speed;
    ped.anchorX = ped.x;
    ped.anchorZ = ped.z;

    // Ten seconds. Two metres of pavement and one signal check; the walk phase
    // is 14.5 s, so a clear crossing is taken well inside this.
    let stepped = false;
    for (let step = 1; step <= 300 && !stepped; step += 1) {
      crowd.update(1 / 30, {
        x: px,
        y: 0,
        z: pz,
        time: start + step / 30,
        vehicles: [car],
      });
      if (ped.link === crossing) stepped = true;
    }
    expect(
      stepped,
      `never stepped onto ${cross.id} in 10 s: still ${ped.state} on ` +
        `${graph.links[ped.link]?.id} with the walk signal ` +
        `${walkSignal(network, cross.crossing!, start + 10) ? 'on' : 'off'}`,
    ).toBe(true);
  });

  it('still refuses a crossing a car is standing on', () => {
    const { pavement, crossing } = findApproach();
    const approach = graph.links[pavement] as PavementLink;
    const cross = graph.links[crossing] as PavementLink;
    const cx = (cross.ax + cross.bx) * 0.5;
    const cz = (cross.az + cross.bz) * 0.5;
    // Broken down across the middle of the crossing itself.
    const car: CrowdVehicle = { x: cx, z: cz, vx: 0, vz: 0, halfLength: 2.3, halfWidth: 0.95 };

    const crowd = makeCrowd(1);
    const point = { x: 0, z: 0 };
    linkPoint(approach, approach.length - 0.6, 0, point);
    const px = point.x;
    const pz = point.z + 120;
    const start = nextWalk(cross, 0);
    crowd.update(1 / 30, { x: px, y: 0, z: pz, time: start, vehicles: [car] });
    const ped = crowd.peds[0] as Pedestrian;
    ped.active = true;
    ped.link = pavement;
    ped.next = crossing;
    ped.along = approach.length - 0.6;
    ped.lateral = 0;
    ped.lateralTarget = 0;
    ped.state = 'walk';
    ped.due = 0;
    ped.x = point.x;
    ped.z = point.z;

    let onCrossing = false;
    for (let step = 1; step <= 150; step += 1) {
      crowd.update(1 / 30, { x: px, y: 0, z: pz, time: start + step / 30, vehicles: [car] });
      if (ped.link === crossing) onCrossing = true;
    }
    expect(onCrossing, 'walked into a car parked on the crossing').toBe(false);
  });
});

// -- the whole city, with traffic -------------------------------------------

/** The ambient fleet, as `Crowd` wants to see it. */
function fleet(sim: TrafficSim, out: CrowdVehicle[]): readonly CrowdVehicle[] {
  out.length = 0;
  for (const vehicle of sim.vehicles) {
    if (!vehicle.active) continue;
    out.push({
      x: vehicle.x,
      z: vehicle.z,
      vx: -Math.sin(vehicle.yaw) * vehicle.speed,
      vz: -Math.cos(vehicle.yaw) * vehicle.speed,
      halfLength: vehicle.blueprint.length * 0.5,
      halfWidth: vehicle.blueprint.width * 0.5,
    });
  }
  return out;
}

describe('nobody is rooted to the spot with traffic on the roads', () => {
  /**
   * The catch-all, and the one that matters most: judged on WORLD displacement
   * and INCLUDING the `wait` state, because a player cannot see a state name.
   * They see a person standing at a corner not moving.
   *
   * `crowdDeadlock.test.ts`'s equivalent excludes `wait` on the grounds that
   * waiting is deliberate and bounded by the signal cycle. That was true with
   * no vehicles in the context and false with them: nothing bounded a wait at
   * all until `WAIT_PATIENCE`, and the gate above meant almost nobody was ever
   * released. Measured on the unfixed code over exactly this run: 41 people
   * stood still for more than a minute and the worst for 296 s.
   */
  it('keeps everybody moving through five minutes of city traffic', () => {
    const dt = 1 / 30;
    const steps = Math.round(300 / dt);
    const windowSteps = Math.round(4 / dt);
    const crowd = makeCrowd(240);
    const sim = new TrafficSim({
      network,
      plan,
      heightAt: (x, z) => ground.heightAt(x, z),
      population: 0,
      seed: plan.seed,
    });
    sim.resize(120);
    const cars: CrowdVehicle[] = [];

    const at = plan.spawn;
    const count = crowd.peds.length;
    const historyX = new Float64Array(count * windowSteps);
    const historyZ = new Float64Array(count * windowSteps);
    const stalled = new Float64Array(count);
    let worst = 0;
    let worstWho = '';
    let overThirty = 0;

    crowd.update(dt, { x: at.x, y: 0, z: at.z, time: 0, vehicles: fleet(sim, cars) });
    for (let step = 0; step < steps; step += 1) {
      const time = (step + 1) * dt;
      sim.update(dt, at.x, at.z, time);
      crowd.update(dt, { x: at.x, y: 0, z: at.z, time, vehicles: fleet(sim, cars) });
      const slot = step % windowSteps;
      for (let i = 0; i < count; i += 1) {
        const ped = crowd.peds[i];
        if (!ped) continue;
        const base = i * windowSteps;
        const wasX = historyX[base + slot] ?? 0;
        const wasZ = historyZ[base + slot] ?? 0;
        historyX[base + slot] = ped.x;
        historyZ[base + slot] = ped.z;
        if (!ped.active || step < windowSteps) {
          stalled[i] = 0;
          continue;
        }
        const moved = Math.hypot(ped.x - wasX, ped.z - wasZ);
        // A respawn is a jump, not progress and not a stall.
        if (moved > 40 || moved > 0.6) {
          stalled[i] = 0;
          continue;
        }
        const held = (stalled[i] ?? 0) + dt;
        stalled[i] = held;
        if (held > 30 && held - dt <= 30) overThirty += 1;
        if (held > worst) {
          worst = held;
          const link = graph.links[ped.link];
          worstWho =
            `#${i} ${ped.state} on ${link?.id ?? '?'} at ` +
            `${ped.along.toFixed(2)}/${(link?.length ?? 0).toFixed(2)}, ` +
            `${ped.speed.toFixed(2)} m/s, at (${ped.x.toFixed(1)}, ${ped.z.toFixed(1)})`;
        }
      }
    }

    expect(overThirty, `${overThirty} people stood still for over 30 s`).toBe(0);
    expect(worst, `stalled for ${worst.toFixed(1)} s: ${worstWho}`).toBeLessThan(30);
  });
});
