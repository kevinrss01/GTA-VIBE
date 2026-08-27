/**
 * The visible traffic signals.
 *
 * These tests do two jobs. The first is placement: a signal head is only useful
 * if it stands on the pavement, on the correct side of the road, facing the
 * traffic it governs - and every one of those is easy to get subtly wrong and
 * hard to spot in a screenshot of one junction. The second is agreement: the
 * lens that is lit must be the one `RoadNetwork.signalFor` says, at the same
 * clock value, because a head that disagrees with the simulation is worse than
 * no head at all.
 *
 * No WebGL is involved. Three.js geometry, materials and InstancedMeshes are
 * all constructible headless, so the instance matrices and the instance colour
 * buffer can be read back and asserted on directly.
 */

import { describe, expect, it } from 'vitest';
import { Color, Matrix4, Vector3 } from 'three';

import {
  SIGNAL_ALL_RED,
  SIGNAL_AMBER,
  SIGNAL_CYCLE,
  SIGNAL_GREEN,
  buildRoadNetwork,
  signalFor,
  type SignalState,
} from '../src/city/RoadNetwork';
import { SignalHeads, approachesFor, cityApproaches } from '../src/city/SignalHeads';
import { MaterialLibrary } from '../src/render/materials';
import { CityGround } from '../src/world/CityGround';
import { getCityPlan } from '../src/world/CityPlan';

const plan = getCityPlan();
const network = buildRoadNetwork(plan);
const ground = new CityGround(plan);

function makeHeads(): { heads: SignalHeads; materials: MaterialLibrary } {
  const materials = new MaterialLibrary();
  const heads = new SignalHeads({
    network,
    materials,
    heightAt: (x, z) => ground.heightAt(x, z),
  });
  return { heads, materials };
}

/** Where a head looks, from the game's yaw convention. */
function faceOf(yaw: number): { x: number; z: number } {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

/** The driver's right hand for a heading. Facing +Z it points to -X. */
function rightOf(d: { x: number; z: number }): { x: number; z: number } {
  return { x: -d.z, z: d.x };
}

// ---------------------------------------------------------------------------

describe('signal placement', () => {
  it('puts one head on every approach to every junction', () => {
    const approaches = cityApproaches(network);
    expect(network.junctions.length).toBeGreaterThan(20);
    expect(approaches).toHaveLength(network.junctions.length * 4);

    for (const junction of network.junctions) {
      const four = approachesFor(junction);
      expect(four.filter((a) => a.axis === 'x')).toHaveLength(2);
      expect(four.filter((a) => a.axis === 'z')).toHaveLength(2);
    }
  });

  it('never stands a post on a carriageway', () => {
    const offending: string[] = [];
    for (const approach of cityApproaches(network)) {
      if (ground.sample(approach.x, approach.z).onRoad) {
        offending.push(`${approach.junction.id} ${approach.axis} at ${approach.x},${approach.z}`);
      }
    }
    expect(offending, `posts standing in traffic:\n${offending.join('\n')}`).toHaveLength(0);
  });

  it('stands every post upstream of the junction and on the driver right', () => {
    for (const approach of cityApproaches(network)) {
      const face = faceOf(approach.yaw);
      // The head looks back at the traffic, so travel is the other way.
      const travel = { x: -face.x, z: -face.z };
      const right = rightOf(travel);
      const offset = {
        x: approach.x - approach.junction.x,
        z: approach.z - approach.junction.z,
      };
      const along = offset.x * travel.x + offset.z * travel.z;
      const lateral = offset.x * right.x + offset.z * right.z;

      expect(along, `${approach.junction.id} head is past its own stop line`).toBeLessThan(0);
      expect(lateral, `${approach.junction.id} head is on the wrong side`).toBeGreaterThan(0);
    }
  });

  it('gives each junction four heads on four different corners', () => {
    for (const junction of network.junctions) {
      const corners = new Set(
        approachesFor(junction).map((a) => {
          const sx = a.x < junction.x ? '-' : '+';
          const sz = a.z < junction.z ? '-' : '+';
          return `${sx}${sz}`;
        }),
      );
      expect(corners.size, `${junction.id} stacks heads on a corner`).toBe(4);
    }
  });

  it('governs the street the head stands on, not the one it looks across', () => {
    for (const approach of cityApproaches(network)) {
      const travel = faceOf(approach.yaw);
      // A head on the 'x' (north-south) street faces along Z, and vice versa.
      if (approach.axis === 'x') {
        expect(Math.abs(travel.z)).toBeCloseTo(1, 6);
        expect(Math.abs(travel.x)).toBeCloseTo(0, 6);
      } else {
        expect(Math.abs(travel.x)).toBeCloseTo(1, 6);
        expect(Math.abs(travel.z)).toBeCloseTo(0, 6);
      }
    }
  });
});

describe('signal geometry', () => {
  it('builds three lenses per head at a readable height, in front of the housing', () => {
    const { heads, materials } = makeHeads();
    const approaches = cityApproaches(network);
    expect(heads.stats.heads).toBe(approaches.length);
    expect(heads.stats.lenses).toBe(approaches.length * 3);

    const masts = heads.group.children.find((c) => c.name === 'signal-masts');
    const lenses = heads.group.children.find((c) => c.name === 'signal-lenses');
    expect(masts).toBeDefined();
    expect(lenses).toBeDefined();

    const matrix = new Matrix4();
    const position = new Vector3();
    const mesh = lenses as unknown as { getMatrixAt(i: number, m: Matrix4): void };

    for (let head = 0; head < approaches.length; head += 1) {
      const approach = approaches[head];
      if (!approach) continue;
      const groundY = ground.heightAt(approach.x, approach.z);
      const face = faceOf(approach.yaw);

      const ys: number[] = [];
      for (let lens = 0; lens < 3; lens += 1) {
        mesh.getMatrixAt(head * 3 + lens, matrix);
        position.setFromMatrixPosition(matrix);
        ys.push(position.y - groundY);
        // The lens sits proud of the post, on the side the head faces.
        const outward =
          (position.x - approach.x) * face.x + (position.z - approach.z) * face.z;
        expect(outward).toBeGreaterThan(0);
      }
      // Red on top, green at the bottom, all at driver eye level or above.
      expect(ys[0]).toBeGreaterThan(ys[1] as number);
      expect(ys[1]).toBeGreaterThan(ys[2] as number);
      expect(ys[2]).toBeGreaterThan(2);
      expect(ys[0]).toBeLessThan(3.6);
    }

    heads.dispose();
    materials.dispose();
  });

  it('adds no lights of any kind', () => {
    const { heads, materials } = makeHeads();
    let lights = 0;
    heads.group.traverse((child) => {
      if ((child as unknown as { isLight?: boolean }).isLight === true) lights += 1;
    });
    expect(lights).toBe(0);
    heads.dispose();
    materials.dispose();
  });

  it('costs three draw calls and stays inside a small triangle budget', () => {
    const { heads, materials } = makeHeads();
    expect(heads.stats.drawCalls).toBe(3);
    // The street lamps alone are 1.39 M triangles; this must not be in that
    // league for something that is mostly a post and a coloured dot.
    expect(heads.stats.triangles).toBeLessThan(40000);
    heads.dispose();
    materials.dispose();
  });
});

describe('signal state', () => {
  it('shows exactly what signalFor says, on the same clock', () => {
    const { heads, materials } = makeHeads();
    const approaches = cityApproaches(network);

    for (let t = 0; t < SIGNAL_CYCLE * 2; t += 0.37) {
      heads.update(t);
      for (let i = 0; i < approaches.length; i += 1) {
        const approach = approaches[i];
        if (!approach) continue;
        expect(heads.stateAt(i)).toBe(signalFor(approach.junction, approach.axis, t));
      }
    }

    heads.dispose();
    materials.dispose();
  });

  it('lights exactly one lens per head and darkens the other two', () => {
    const { heads, materials } = makeHeads();
    const litFor: Readonly<Record<SignalState, number>> = { red: 0, amber: 1, green: 2 };

    for (let t = 0; t < SIGNAL_CYCLE; t += 1.1) {
      heads.update(t);
      for (let head = 0; head < heads.stats.heads; head += 1) {
        const state = heads.stateAt(head);
        expect(state).not.toBeNull();
        const lit = litFor[state as SignalState];
        let bright = 0;
        for (let lens = 0; lens < 3; lens += 1) {
          const colour = heads.lensColour(head, lens);
          expect(colour).not.toBeNull();
          const luminance = (colour?.r ?? 0) + (colour?.g ?? 0) + (colour?.b ?? 0);
          if (lens === lit) {
            expect(luminance, `lens ${lens} should be lit for ${String(state)}`).toBeGreaterThan(0.3);
            bright += 1;
          } else {
            expect(luminance, `lens ${lens} should be dark for ${String(state)}`).toBeLessThan(0.05);
          }
        }
        expect(bright).toBe(1);
      }
    }

    heads.dispose();
    materials.dispose();
  });

  it('shows red, amber and green in turn on every approach over one cycle', () => {
    const { heads, materials } = makeHeads();
    const seen = new Map<number, Set<SignalState>>();

    for (let t = 0; t <= SIGNAL_CYCLE; t += 0.25) {
      heads.update(t);
      for (let head = 0; head < heads.stats.heads; head += 1) {
        const state = heads.stateAt(head);
        if (!state) continue;
        const set = seen.get(head) ?? new Set<SignalState>();
        set.add(state);
        seen.set(head, set);
      }
    }

    for (let head = 0; head < heads.stats.heads; head += 1) {
      const set = seen.get(head);
      expect(set?.size, `approach ${head} never showed all three states`).toBe(3);
    }

    heads.dispose();
    materials.dispose();
  });

  it('never shows green to both axes of a junction at once', () => {
    const { heads, materials } = makeHeads();
    const approaches = cityApproaches(network);

    for (let t = 0; t < SIGNAL_CYCLE * 1.5; t += 0.19) {
      heads.update(t);
      const greenAxes = new Map<string, Set<'x' | 'z'>>();
      for (let i = 0; i < approaches.length; i += 1) {
        const approach = approaches[i];
        if (!approach || heads.stateAt(i) !== 'green') continue;
        const set = greenAxes.get(approach.junction.id) ?? new Set<'x' | 'z'>();
        set.add(approach.axis);
        greenAxes.set(approach.junction.id, set);
      }
      for (const [id, axes] of greenAxes) {
        expect(axes.size, `${id} showed green on both axes at t=${t}`).toBe(1);
      }
    }

    heads.dispose();
    materials.dispose();
  });

  it('holds the amber and all-red gap the timing promises', () => {
    const { heads, materials } = makeHeads();
    const approaches = cityApproaches(network);
    const first = approaches[0];
    expect(first).toBeDefined();
    if (!first) return;

    // Walk one whole cycle finely and measure how long each state is held.
    const held: Record<SignalState, number> = { green: 0, amber: 0, red: 0 };
    const step = 0.005;
    for (let t = 0; t < SIGNAL_CYCLE; t += step) {
      heads.update(t);
      const state = heads.stateAt(0);
      if (state) held[state] += step;
    }
    expect(held.green).toBeCloseTo(SIGNAL_GREEN, 1);
    expect(held.amber).toBeCloseTo(SIGNAL_AMBER, 1);
    expect(held.red).toBeCloseTo(SIGNAL_GREEN + SIGNAL_AMBER + SIGNAL_ALL_RED * 2, 1);

    heads.dispose();
    materials.dispose();
  });

  it('only re-uploads the colour buffer on a frame where a phase changed', () => {
    const { heads, materials } = makeHeads();
    const before = heads.stats.uploads;

    // Ten seconds at 60 Hz. 55 junctions on a 26 s cycle change phase about
    // thirteen times a second, so most frames must do no GPU work at all.
    const frames = 600;
    for (let f = 1; f <= frames; f += 1) heads.update(f / 60);
    const uploads = heads.stats.uploads - before;

    expect(uploads).toBeGreaterThan(0);
    expect(uploads).toBeLessThan(frames * 0.35);

    heads.dispose();
    materials.dispose();
  });

  it('is correct on the very first frame, before update has been called', () => {
    const { heads, materials } = makeHeads();
    const approaches = cityApproaches(network);
    for (let i = 0; i < approaches.length; i += 1) {
      const approach = approaches[i];
      if (!approach) continue;
      expect(heads.stateAt(i)).toBe(signalFor(approach.junction, approach.axis, 0));
    }
    heads.dispose();
    materials.dispose();
  });

  it('reports every approach for automated QA', () => {
    const { heads, materials } = makeHeads();
    heads.update(3);
    const described = heads.describe();
    expect(described).toHaveLength(network.junctions.length * 4);
    for (const entry of described) {
      expect(network.junctionById.has(entry.junctionId)).toBe(true);
      expect(['red', 'amber', 'green']).toContain(entry.state);
    }
    heads.dispose();
    materials.dispose();
  });
});

describe('lifecycle', () => {
  it('survives dispose being called twice and stops updating afterwards', () => {
    const { heads, materials } = makeHeads();
    heads.update(1);
    const state = heads.stateAt(0);
    heads.dispose();
    expect(() => heads.dispose()).not.toThrow();
    heads.update(500);
    expect(heads.stateAt(0)).toBe(state);
    materials.dispose();
  });

  it('uses the shared palette rather than creating materials of its own', () => {
    const materials = new MaterialLibrary();
    const housing = materials.get('signalHousing');
    const lens = materials.get('signalLens');
    const heads = new SignalHeads({ network, materials, heightAt: () => 0 });

    const used = heads.group.children.map(
      (child) => (child as unknown as { material: { name: string } }).material,
    );
    expect(used).toContain(housing);
    expect(used).toContain(lens);
    // The lens must not be tone mapped, or a saturated red rolls off to amber.
    expect((lens as unknown as { toneMapped: boolean }).toneMapped).toBe(false);
    // And its base must be white, because the instance colour IS the output.
    const base = (lens as unknown as { color: Color }).color;
    expect(base.r).toBeCloseTo(1, 6);
    expect(base.g).toBeCloseTo(1, 6);
    expect(base.b).toBeCloseTo(1, 6);

    heads.dispose();
    materials.dispose();
  });
});
