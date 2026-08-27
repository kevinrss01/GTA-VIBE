/**
 * The pedestrian crowd, asserted without a renderer.
 *
 * These are the checks that would have caught the failures a player notices
 * first: people in the road, people inside a wall, people walking through each
 * other, a crowd huddled around the spawn point, and anyone stepping off a kerb
 * while the traffic they are crossing still has a green.
 */

import { describe, expect, it } from 'vitest';

import { buildRoadNetwork, walkSignal } from '../src/city/RoadNetwork';
import { getCityPlan } from '../src/world/CityPlan';
import { CityGround } from '../src/world/CityGround';
import { Crowd, PED_RADIUS } from '../src/agents/crowd';
import { ObstacleIndex } from '../src/agents/obstacles';
import { buildPavementGraph, linkPoint } from '../src/agents/pavement';
import { makeLook, SHAPE_HAT, SHAPE_SKIRT } from '../src/agents/appearance';
import {
  GAIT_DUTY,
  GAIT_MAX_SWING,
  gaitCadence,
  hipAmplitude,
  hipAngle,
  stanceSlip,
} from '../src/agents/gait';
import { createRng } from '../src/core/rng';

const plan = getCityPlan();
const network = buildRoadNetwork(plan);
const ground = new CityGround(plan);
const graph = buildPavementGraph(plan, network);
const obstacles = new ObstacleIndex(plan, ground);

const SPAWN = plan.spawn;

function makeCrowd(population = 220): Crowd {
  return new Crowd({ ground, network, graph, obstacles, population, seed: plan.seed });
}

interface RunResult {
  readonly crowd: Crowd;
  /** One entry per time a pedestrian stepped onto a crossing. */
  readonly crossingEntries: { safe: boolean; crossing: string }[];
  readonly minPairDistance: number;
  readonly sawWaiting: boolean;
  readonly sawCrossing: boolean;
  readonly sawPause: boolean;
}

/**
 * Steps the crowd at a fixed rate and records the things a test wants to know.
 * A fixed timestep is what makes every assertion below reproducible.
 */
function run(crowd: Crowd, steps: number, dt = 1 / 30): RunResult {
  const crossingEntries: { safe: boolean; crossing: string }[] = [];
  const lastLink = new Int32Array(crowd.peds.length).fill(-1);
  let minPairDistance = Infinity;
  let sawWaiting = false;
  let sawCrossing = false;
  let sawPause = false;
  let time = 0;

  crowd.update(dt, { x: SPAWN.x, y: 0, z: SPAWN.z, time });

  for (let step = 0; step < steps; step += 1) {
    time += dt;
    crowd.update(dt, { x: SPAWN.x, y: 0, z: SPAWN.z, time });

    for (let i = 0; i < crowd.peds.length; i += 1) {
      const ped = crowd.peds[i];
      if (!ped || !ped.active) continue;
      if (ped.state === 'wait') sawWaiting = true;
      if (ped.state === 'cross') sawCrossing = true;
      if (ped.state === 'pause') sawPause = true;
      const previous = lastLink[i] ?? -1;
      if (previous !== ped.link) {
        const link = graph.links[ped.link];
        if (link?.crossing && previous >= 0) {
          crossingEntries.push({
            safe: walkSignal(network, link.crossing, time),
            crossing: link.crossing.id,
          });
        }
        lastLink[i] = ped.link;
      }
    }

    // Sampling the pair distance every fifth step keeps the test quick while
    // still covering every crowded moment several times over.
    if (step % 5 === 0) {
      for (let i = 0; i < crowd.peds.length; i += 1) {
        const a = crowd.peds[i];
        if (!a || !a.active || a.lod > 1) continue;
        for (let j = i + 1; j < crowd.peds.length; j += 1) {
          const b = crowd.peds[j];
          if (!b || !b.active || b.lod > 1) continue;
          const d = Math.hypot(a.x - b.x, a.z - b.z);
          if (d < minPairDistance) minPairDistance = d;
        }
      }
    }
  }

  return { crowd, crossingEntries, minPairDistance, sawWaiting, sawCrossing, sawPause };
}

describe('pavement graph', () => {
  it('covers the city', () => {
    expect(graph.nodes.length).toBeGreaterThan(150);
    expect(graph.links.length).toBeGreaterThan(300);
    expect(graph.totalLength).toBeGreaterThan(4000);
  });

  it('never routes a walking pedestrian onto a carriageway or into a building', () => {
    const point = { x: 0, z: 0 };
    let checked = 0;
    for (const link of graph.links) {
      if (link.crossing) continue;
      const samples = Math.max(3, Math.ceil(link.length / 1.5));
      for (let i = 0; i <= samples; i += 1) {
        const along = (i / samples) * link.length;
        // Both edges of the corridor, not just the centreline: a pedestrian
        // may be anywhere within `halfWidth` of it.
        for (const lateral of [-link.halfWidth, 0, link.halfWidth]) {
          linkPoint(link, along, lateral, point);
          const sample = ground.sample(point.x, point.z);
          checked += 1;
          expect(
            sample.onRoad,
            `${link.id} at ${along.toFixed(1)}/${lateral.toFixed(2)} is on the carriageway`,
          ).toBe(false);
          expect(
            ground.isBuilt(point.x, point.z),
            `${link.id} at ${along.toFixed(1)} is inside a building`,
          ).toBe(false);
          expect(
            sample.surface === 'pavement' || sample.surface === 'boardwalk',
            `${link.id} at ${along.toFixed(1)} is on ${sample.surface}, not a pavement`,
          ).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });

  it('spans a crossing from kerb to kerb, and only there', () => {
    const point = { x: 0, z: 0 };
    let crossings = 0;
    for (const link of graph.links) {
      if (!link.crossing) continue;
      crossings += 1;
      // The ends are pavement, the middle is carriageway. Anything else means
      // the crossing is not actually spanning the road it claims to.
      linkPoint(link, 0.05, 0, point);
      expect(ground.sample(point.x, point.z).onRoad, `${link.id} starts in the road`).toBe(false);
      linkPoint(link, link.length * 0.5, 0, point);
      expect(
        ground.sample(point.x, point.z).onRoad,
        `${link.id} does not cross a carriageway`,
      ).toBe(true);
    }
    expect(crossings).toBeGreaterThan(40);
  });

  it('has a reverse for every link and no dead nodes', () => {
    for (const link of graph.links) {
      expect(link.reverse, `${link.id} has no reverse`).toBeGreaterThanOrEqual(0);
      const back = graph.links[link.reverse];
      expect(back?.from).toBe(link.to);
      expect(back?.to).toBe(link.from);
    }
    let isolated = 0;
    for (let i = 0; i < graph.nodes.length; i += 1) {
      if ((graph.linksFrom[i] ?? []).length === 0) isolated += 1;
    }
    expect(isolated).toBe(0);
  });

  it('joins the streets at their corners', () => {
    // A corner node carries links belonging to two different streets. Without
    // these a pedestrian could only ever walk up and down one street.
    let corners = 0;
    for (let i = 0; i < graph.nodes.length; i += 1) {
      const streets = new Set<string>();
      for (const index of graph.linksFrom[i] ?? []) {
        const link = graph.links[index];
        if (link && !link.crossing) streets.add(link.streetId);
      }
      if (streets.size > 1) corners += 1;
    }
    expect(corners, 'no corner joins two streets').toBeGreaterThan(40);
  });
});

describe('spawn spread', () => {
  it('covers many streets instead of clustering at the spawn point', () => {
    const crowd = makeCrowd();
    crowd.seed(SPAWN.x, SPAWN.z);

    const perStreet = new Map<string, number>();
    let active = 0;
    let within20 = 0;
    for (const ped of crowd.peds) {
      if (!ped.active) continue;
      active += 1;
      const link = graph.links[ped.link];
      if (!link) continue;
      perStreet.set(link.streetId, (perStreet.get(link.streetId) ?? 0) + 1);
      if (Math.hypot(ped.x - SPAWN.x, ped.z - SPAWN.z) < 20) within20 += 1;
    }

    expect(active).toBeGreaterThan(200);
    expect(perStreet.size, 'pedestrians occupy too few streets').toBeGreaterThanOrEqual(8);

    const largest = Math.max(...perStreet.values());
    expect(largest / active, 'one street holds too much of the crowd').toBeLessThan(0.3);
    // A crowd huddled at spawn is the failure this test exists for.
    expect(within20 / active).toBeLessThan(0.2);
  });

  it('keeps the population spread once it has been running', () => {
    const crowd = makeCrowd();
    const { crowd: after } = run(crowd, 900);
    const streets = new Set<string>();
    for (const ped of after.peds) {
      if (!ped.active) continue;
      const link = graph.links[ped.link];
      if (link) streets.add(link.streetId);
    }
    expect(streets.size).toBeGreaterThanOrEqual(8);
  });
});

describe('path following', () => {
  it('keeps every walking pedestrian on a pavement', () => {
    const { crowd } = run(makeCrowd(), 1200);
    let checked = 0;
    for (const ped of crowd.peds) {
      if (!ped.active) continue;
      const link = graph.links[ped.link];
      expect(link).toBeDefined();
      if (!link) continue;
      const sample = ground.sample(ped.x, ped.z);
      checked += 1;
      if (!link.crossing) {
        expect(sample.onRoad, `pedestrian on ${link.id} strayed onto the carriageway`).toBe(false);
      }
      expect(ground.isBuilt(ped.x, ped.z), 'pedestrian is inside a building').toBe(false);
      // The lateral clamp is the invariant that guarantees the two above.
      expect(Math.abs(ped.lateral)).toBeLessThanOrEqual(link.halfWidth + 1e-6);
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('stays on the ground', () => {
    const { crowd } = run(makeCrowd(), 600);
    for (const ped of crowd.peds) {
      if (!ped.active || ped.lod > 1) continue;
      expect(Math.abs(ped.y - ground.sample(ped.x, ped.z).y)).toBeLessThan(0.35);
    }
  });

  it('does not stand inside the street furniture', () => {
    const { crowd } = run(makeCrowd(), 900);
    const push = { x: 0, z: 0 };
    let inside = 0;
    for (const ped of crowd.peds) {
      if (!ped.active || ped.lod !== 0) continue;
      if (obstacles.resolve(ped.x, ped.z, PED_RADIUS * 0.6, push)) inside += 1;
    }
    expect(inside).toBe(0);
  });

  it('is deterministic for a given seed', () => {
    const a = run(makeCrowd(120), 400).crowd;
    const b = run(makeCrowd(120), 400).crowd;
    for (let i = 0; i < a.peds.length; i += 1) {
      expect(a.peds[i]?.x).toBeCloseTo(b.peds[i]?.x ?? Number.NaN, 9);
      expect(a.peds[i]?.z).toBeCloseTo(b.peds[i]?.z ?? Number.NaN, 9);
      expect(a.peds[i]?.phase).toBeCloseTo(b.peds[i]?.phase ?? Number.NaN, 9);
    }
  });
});

describe('crossings', () => {
  it('never steps off the kerb while the traffic it crosses has a green', () => {
    const result = run(makeCrowd(), 2400);
    expect(result.crossingEntries.length, 'nobody used a crossing').toBeGreaterThan(20);
    const unsafe = result.crossingEntries.filter((entry) => !entry.safe);
    expect(unsafe.length, `${unsafe.length} pedestrians crossed against the signal`).toBe(0);
    expect(result.sawWaiting, 'nobody ever waited at a red').toBe(true);
    expect(result.sawCrossing).toBe(true);
  });

  it('waits for a vehicle that is about to arrive even on a walk signal', () => {
    const crowd = makeCrowd(60);
    crowd.seed(SPAWN.x, SPAWN.z);
    // A wall of traffic sitting on every crossing: nobody may enter one.
    const vehicles = graph.links
      .filter((link) => link.crossing !== null)
      .map((link) => ({
        x: (link.ax + link.bx) * 0.5,
        z: (link.az + link.bz) * 0.5,
        vx: 0,
        vz: 0,
      }));

    let time = 0;
    let entries = 0;
    const lastLink = new Int32Array(crowd.peds.length).fill(-1);
    for (let step = 0; step < 1500; step += 1) {
      time += 1 / 30;
      crowd.update(1 / 30, { x: SPAWN.x, y: 0, z: SPAWN.z, time, vehicles });
      for (let i = 0; i < crowd.peds.length; i += 1) {
        const ped = crowd.peds[i];
        if (!ped || !ped.active) continue;
        const previous = lastLink[i] ?? -1;
        if (previous !== ped.link) {
          if (graph.links[ped.link]?.crossing && previous >= 0) entries += 1;
          lastLink[i] = ped.link;
        }
      }
    }
    expect(entries, 'walked into a stationary vehicle').toBe(0);
  });
});

describe('separation', () => {
  it('keeps a minimum distance between simulated pedestrians', () => {
    const result = run(makeCrowd(), 1500);
    // The positional pass targets 2 * PED_RADIUS = 0.54 m and the pavement
    // clamp occasionally shaves a few millimetres off that; measured worst
    // case over this run is 0.532 m. Anything materially below would mean
    // people are walking through each other.
    expect(
      result.minPairDistance,
      `closest pair was ${result.minPairDistance.toFixed(3)} m`,
    ).toBeGreaterThan(PED_RADIUS * 1.9);
  });

  it('separates a deliberately stacked pair', () => {
    const crowd = makeCrowd(40);
    crowd.seed(SPAWN.x, SPAWN.z);
    const a = crowd.peds[0];
    const b = crowd.peds[1];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (!a || !b) return;
    b.link = a.link;
    b.along = a.along;
    b.lateral = a.lateral;
    b.x = a.x;
    b.z = a.z;
    for (let step = 0; step < 90; step += 1) {
      crowd.update(1 / 30, { x: a.x, y: 0, z: a.z, time: step / 30 });
    }
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(PED_RADIUS);
  });
});

describe('appearance', () => {
  it('produces a visibly varied crowd from one seed', () => {
    const rng = createRng('variety');
    const looks = Array.from({ length: 240 }, () => makeLook(rng));

    const heights = looks.map((look) => look.height);
    expect(Math.min(...heights)).toBeLessThan(1.62);
    expect(Math.max(...heights)).toBeGreaterThan(1.84);

    const tops = new Set(looks.map((look) => look.topColor));
    expect(tops.size, 'clothing colours repeat too much').toBeGreaterThan(120);
    expect(new Set(looks.map((look) => look.skinColor)).size).toBeGreaterThanOrEqual(10);
    expect(new Set(looks.map((look) => look.hairColor)).size).toBeGreaterThanOrEqual(10);

    const hats = looks.filter((look) => (look.shape & SHAPE_HAT) !== 0).length;
    const skirts = looks.filter((look) => (look.shape & SHAPE_SKIRT) !== 0).length;
    expect(hats).toBeGreaterThan(10);
    expect(skirts).toBeGreaterThan(20);

    const speeds = looks.map((look) => look.preferredSpeed);
    expect(Math.min(...speeds)).toBeGreaterThan(0.7);
    expect(Math.max(...speeds)).toBeLessThan(2.1);
    expect(Math.max(...speeds) - Math.min(...speeds)).toBeGreaterThan(0.5);
  });

  it('is reproducible', () => {
    const a = makeLook(createRng('same'));
    const b = makeLook(createRng('same'));
    expect(a).toEqual(b);
  });
});

describe('simulation levels', () => {
  it('splits the population into near, mid and far bands', () => {
    const { crowd } = run(makeCrowd(), 600);
    const s = crowd.stats;
    expect(s.active).toBeGreaterThan(200);
    expect(s.near + s.mid + s.far).toBe(s.active);
    expect(s.near).toBeGreaterThan(0);
    expect(s.mid).toBeGreaterThan(0);
    expect(s.rendered).toBeLessThanOrEqual(s.active);
  });

  it('actually steps fewer agents than it holds', () => {
    // The mid band runs every other frame and the far band every fourth, so a
    // settled crowd must be stepping well under its own population. Averaged
    // over four frames, because the schedule repeats on that period.
    const crowd = makeCrowd();
    const { crowd: settled } = run(crowd, 900);
    let stepped = 0;
    let time = 30;
    for (let i = 0; i < 4; i += 1) {
      time += 1 / 30;
      settled.update(1 / 30, { x: SPAWN.x, y: 0, z: SPAWN.z, time });
      stepped += settled.stats.stepped;
    }
    const perFrame = stepped / 4;
    const s = settled.stats;
    // near + mid/2 + far/4 is the schedule's own arithmetic.
    const predicted = s.near + s.mid / 2 + s.far / 4;
    expect(perFrame).toBeLessThan(s.active * 0.75);
    expect(Math.abs(perFrame - predicted)).toBeLessThan(s.active * 0.12);
  });

  it('respects a reduced budget without reallocating', () => {
    const crowd = makeCrowd(240);
    crowd.seed(SPAWN.x, SPAWN.z);
    crowd.budget = 60;
    for (let step = 0; step < 20; step += 1) {
      crowd.update(1 / 30, { x: SPAWN.x, y: 0, z: SPAWN.z, time: step / 30 });
    }
    expect(crowd.stats.active).toBeLessThanOrEqual(60);
    expect(crowd.peds.length).toBe(240);
  });
});

describe('walk cycle', () => {
  /**
   * The whole point of the gait module: a planted foot must not move. If this
   * fails the crowd is skating, which is the single most obvious way for
   * procedural characters to look wrong.
   */
  it('holds a planted foot still at every speed and build', () => {
    let worst = 0;
    let worstCase = '';
    for (let speed = 0.4; speed <= 2.2; speed += 0.05) {
      for (let height = 1.5; height <= 1.95; height += 0.05) {
        for (let base = 0.75; base <= 1.15; base += 0.05) {
          const cadence = gaitCadence(speed, 1.35, base, height);
          const slip = stanceSlip(speed, cadence, height);
          if (slip > worst) {
            worst = slip;
            worstCase = `v=${speed.toFixed(2)} h=${height.toFixed(2)} base=${base.toFixed(2)}`;
          }
        }
      }
    }
    // A millimetre over a whole stance phase is far below anything visible.
    expect(worst, `worst foot slip ${worst.toFixed(4)} m at ${worstCase}`).toBeLessThan(0.001);
  });

  it('takes quicker steps rather than an impossible stride', () => {
    // A fast walker on short legs is the case that used to clamp and slide.
    const slow = gaitCadence(0.9, 1.35, 0.95, 1.55);
    const fast = gaitCadence(2.1, 1.35, 0.95, 1.55);
    expect(fast).toBeGreaterThan(slow);
    expect(hipAmplitude(2.1, fast, 1.55)).toBeLessThanOrEqual(GAIT_MAX_SWING + 1e-9);
    expect(stanceSlip(2.1, fast, 1.55)).toBeLessThan(0.001);
  });

  it('sweeps the hip through a full, continuous cycle', () => {
    const amp = 0.45;
    expect(hipAngle(0, amp)).toBeCloseTo(amp, 6);
    // Stance ends with the leg fully behind, and swing returns it to the front.
    expect(hipAngle(GAIT_DUTY - 1e-6, amp)).toBeCloseTo(-amp, 4);
    expect(hipAngle(0.9999, amp)).toBeCloseTo(amp, 3);
    let previous = hipAngle(0, amp);
    for (let u = 0.002; u < 1; u += 0.002) {
      const next = hipAngle(u, amp);
      // No jumps: a discontinuity here is a visible flick of the leg.
      expect(Math.abs(next - previous)).toBeLessThan(0.04);
      previous = next;
    }
  });

  it('stands still when the amplitude is zero', () => {
    for (let u = 0; u < 1; u += 0.05) expect(hipAngle(u, 0)).toBeCloseTo(0, 9);
  });
});
