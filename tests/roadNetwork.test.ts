/**
 * The movement graph every moving thing shares.
 *
 * These assertions are the ones that would have caught a car driving on the
 * wrong side, two green lights facing each other, or a pavement network with
 * dead ends - all of which look like bugs long before anyone reads the code.
 */

import { describe, expect, it } from 'vitest';

import {
  SIGNAL_CYCLE,
  buildRoadNetwork,
  exitsFrom,
  laneHeading,
  laneOffset,
  lanePoint,
  signalFor,
} from '../src/city/RoadNetwork';
import { getCityPlan } from '../src/world/CityPlan';
import { CityGround } from '../src/world/CityGround';

const plan = getCityPlan();
const net = buildRoadNetwork(plan);
const ground = new CityGround(plan);

describe('road network', () => {
  it('covers the city with junctions and lanes', () => {
    expect(net.junctions.length).toBeGreaterThanOrEqual(20);
    expect(net.lanes.length).toBeGreaterThanOrEqual(60);
    expect(net.crossings.length).toBe(net.junctions.length * 4);
  });

  it('is deterministic', () => {
    const again = buildRoadNetwork(getCityPlan());
    expect(again.lanes.length).toBe(net.lanes.length);
    expect(again.junctions[3]?.phaseOffset).toBe(net.junctions[3]?.phaseOffset);
  });

  it('puts every lane on the correct side of its street', () => {
    for (const lane of net.lanes) {
      const street = plan.streets.find((s) => s.id === lane.streetId);
      expect(street).toBeDefined();
      if (!street) continue;
      // Driving on the right: facing +Z the kerb is at -X, facing +X it is +Z.
      const expected = laneOffset(street, lane.travel);
      expect(lane.offset).toBeCloseTo(expected, 6);
      // The lane must sit inside the carriageway, never on the pavement.
      expect(Math.abs(lane.offset - street.position)).toBeLessThan(street.roadHalf);
    }
  });

  it('never shows green to both axes of a junction at once', () => {
    for (const junction of net.junctions) {
      for (let t = 0; t < SIGNAL_CYCLE; t += 0.25) {
        const gx = signalFor(junction, 'x', t);
        const gz = signalFor(junction, 'z', t);
        expect(
          gx === 'green' && gz === 'green',
          `${junction.id} shows green both ways at t=${t}`,
        ).toBe(false);
      }
    }
  });

  it('gives every axis a green some of the time', () => {
    const junction = net.junctions[0];
    expect(junction).toBeDefined();
    if (!junction) return;
    const seen = new Set<string>();
    for (let t = 0; t < SIGNAL_CYCLE; t += 0.25) {
      seen.add(`x:${signalFor(junction, 'x', t)}`);
      seen.add(`z:${signalFor(junction, 'z', t)}`);
    }
    for (const expected of ['x:green', 'x:red', 'z:green', 'z:red']) {
      expect(seen.has(expected), `missing ${expected}`).toBe(true);
    }
  });

  it('never offers a U-turn as a normal continuation', () => {
    for (const lane of net.lanes) {
      for (const next of exitsFrom(net, lane)) {
        const isUturn = next.streetId === lane.streetId && next.travel !== lane.travel;
        // A dead-end terminus is allowed to turn a car around; a junction is not.
        const node = net.nodes.get(lane.toNode);
        if (node?.kind === 'junction') {
          expect(isUturn, `${lane.id} may U-turn at ${lane.toNode}`).toBe(false);
        }
      }
    }
  });

  it('leaves no lane stranded without a continuation', () => {
    let stranded = 0;
    for (const lane of net.lanes) if (exitsFrom(net, lane).length === 0) stranded += 1;
    // Termini legitimately end; anything more means a broken graph.
    expect(stranded).toBeLessThanOrEqual(plan.streets.length * 2);
  });

  it('points a lane the way it actually travels', () => {
    for (const lane of net.lanes.slice(0, 40)) {
      const a = lanePoint(lane, 0);
      const b = lanePoint(lane, Math.min(5, lane.length));
      const yaw = laneHeading(lane);
      // Forward is (-sin yaw, 0, -cos yaw).
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const dot = fx * dx + fz * dz;
      expect(dot, `${lane.id} heading disagrees with travel`).toBeGreaterThan(0);
    }
  });

  it('never lays pavement across a carriageway', () => {
    // The regression this guards: nodes were placed at each junction's own
    // coordinate, which is the CENTRE of the crossing street's road. 188 of
    // 220 nodes and 326 of 376 edges sat in live traffic, so anything
    // following the graph walked through the road at nearly every junction.
    let badNodes = 0;
    for (const [, node] of net.walkNodes) {
      if (ground.sample(node.x, node.z).onRoad) badNodes += 1;
    }
    expect(badNodes, 'walk nodes standing on a carriageway').toBe(0);

    let badEdges = 0;
    for (const edge of net.walkEdges) {
      // Crossing edges are SUPPOSED to be on the road - that is their job.
      if (edge.crossingId) continue;
      const a = net.walkNodes.get(edge.fromNode);
      const b = net.walkNodes.get(edge.toNode);
      if (!a || !b) continue;
      for (let t = 0; t <= 1.0001; t += 0.1) {
        if (ground.sample(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t).onRoad) {
          badEdges += 1;
          break;
        }
      }
    }
    expect(badEdges, 'pavement edges crossing a carriageway').toBe(0);
  });

  it('connects the pavement graph in both directions', () => {
    expect(net.walkEdges.length).toBeGreaterThan(80);
    let isolated = 0;
    for (const [id] of net.walkNodes) if ((net.walkFrom.get(id) ?? []).length === 0) isolated += 1;
    expect(isolated, 'pavement nodes with no exit').toBe(0);
  });

  it('places crossings clear of the junction box', () => {
    for (const crossing of net.crossings) {
      const junction = net.junctionById.get(crossing.junctionId);
      expect(junction).toBeDefined();
      if (!junction) continue;
      const d = crossing.axis === 'x'
        ? Math.abs(crossing.z - junction.z)
        : Math.abs(crossing.x - junction.x);
      const half = crossing.axis === 'x' ? junction.halfZ : junction.halfX;
      expect(d, `${crossing.id} sits inside the junction`).toBeGreaterThan(half);
    }
  });
});
