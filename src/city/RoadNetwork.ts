/**
 * The city's movement graph: lanes, junctions, signals, crossings, pavements.
 *
 * This is the single source of truth every moving thing shares. Vehicles read
 * the lane graph, pedestrians read the pavement graph, and both read the same
 * signal clock, so a car stopping at a red and a pedestrian stepping off the
 * kerb are agreeing about the same junction rather than each guessing.
 *
 * It is derived entirely from `CityPlan` and holds no Three.js types, which
 * means the whole network can be built and asserted on in a unit test with no
 * WebGL - the same trick `validate.ts` uses for placement.
 *
 * COORDINATES: +X is east, +Z is south, 1 unit = 1 metre. Traffic drives on the
 * RIGHT. Facing +Z (south) the right hand points to -X, and facing +X (east) it
 * points to +Z; those two facts fix every lane offset below.
 */

import { hash2 } from '../core/rng';
import type { CityPlan, Street } from '../world/CityPlan';

/** Direction of travel along a street's running axis. */
export type Travel = 1 | -1;

export type SignalState = 'green' | 'amber' | 'red';

export interface NetworkNode {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  /** Junctions carry a signal; termini are where a street simply ends. */
  readonly kind: 'junction' | 'terminus';
}

/**
 * One directed run of carriageway between two nodes.
 *
 * `offset` is the cross-axis coordinate of the lane centreline, already placed
 * on the correct side of the road for `travel`.
 */
export interface LaneSegment {
  readonly id: string;
  readonly streetId: string;
  readonly axis: 'x' | 'z';
  readonly travel: Travel;
  readonly offset: number;
  readonly fromNode: string;
  readonly toNode: string;
  /** Along-axis start and end, in travel order. */
  readonly start: number;
  readonly end: number;
  readonly length: number;
}

export interface Junction {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  /** Street running north-south (axis 'x') through this junction. */
  readonly streetX: string;
  /** Street running east-west (axis 'z') through this junction. */
  readonly streetZ: string;
  readonly halfX: number;
  readonly halfZ: number;
  /** Seconds added to the shared clock so the city does not blink in unison. */
  readonly phaseOffset: number;
}

export interface Crossing {
  readonly id: string;
  readonly junctionId: string;
  /** Axis of the carriageway being crossed. */
  readonly axis: 'x' | 'z';
  /** Centre of the crossing. */
  readonly x: number;
  readonly z: number;
  /** Half-length across the carriageway, and half-width along the street. */
  readonly halfSpan: number;
  readonly halfWidth: number;
}

/** One directed run of pavement between two pavement nodes. */
export interface WalkEdge {
  readonly id: string;
  readonly fromNode: string;
  readonly toNode: string;
  readonly length: number;
  /** Crossing edges put a pedestrian on the carriageway and need a signal. */
  readonly crossingId: string | null;
}

export interface WalkNode {
  readonly id: string;
  readonly x: number;
  readonly z: number;
}

export interface RoadNetwork {
  readonly nodes: ReadonlyMap<string, NetworkNode>;
  readonly lanes: readonly LaneSegment[];
  readonly junctions: readonly Junction[];
  readonly crossings: readonly Crossing[];
  readonly walkNodes: ReadonlyMap<string, WalkNode>;
  readonly walkEdges: readonly WalkEdge[];
  /** Lane segments leaving a node, for choosing a turn. */
  readonly lanesFrom: ReadonlyMap<string, readonly LaneSegment[]>;
  /** Pavement edges leaving a pavement node. */
  readonly walkFrom: ReadonlyMap<string, readonly WalkEdge[]>;
  readonly crossingById: ReadonlyMap<string, Crossing>;
  readonly junctionById: ReadonlyMap<string, Junction>;
}

/**
 * Signal timing, in seconds.
 *
 * A short cycle keeps a compact city feeling busy without leaving a driver
 * sitting at a red for long enough to notice the wait. The all-red gap is what
 * stops a car that entered on amber from meeting cross traffic head-on.
 */
/** How far past a kerb a pavement node stands, in metres. */
const KERB_MARGIN = 0.4;

export const SIGNAL_GREEN = 9;
export const SIGNAL_AMBER = 2.5;
export const SIGNAL_ALL_RED = 1.5;
const PHASE = SIGNAL_GREEN + SIGNAL_AMBER + SIGNAL_ALL_RED;
export const SIGNAL_CYCLE = PHASE * 2;

/**
 * Signal state for one axis at a junction.
 *
 * The two axes are exact opposites offset by half a cycle, so a junction can
 * never show green to both directions - that property is asserted in the tests
 * rather than left to inspection.
 */
export function signalFor(junction: Junction, axis: 'x' | 'z', time: number): SignalState {
  const t = (((time + junction.phaseOffset) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  // The 'z' street (east-west) gets the first half of the cycle.
  const local = axis === 'z' ? t : (t + PHASE) % SIGNAL_CYCLE;
  if (local < SIGNAL_GREEN) return 'green';
  if (local < SIGNAL_GREEN + SIGNAL_AMBER) return 'amber';
  return 'red';
}

/** True when a pedestrian may step onto this crossing. */
export function walkSignal(network: RoadNetwork, crossing: Crossing, time: number): boolean {
  const junction = network.junctionById.get(crossing.junctionId);
  if (!junction) return true;
  // Pedestrians cross a carriageway while that carriageway is stopped.
  return signalFor(junction, crossing.axis, time) === 'red';
}

function overlaps(street: Street, other: Street): boolean {
  return (
    other.position >= street.from &&
    other.position <= street.to &&
    street.position >= other.from &&
    street.position <= other.to
  );
}

/** Centreline offset of the lane carrying `travel` on `street`. */
export function laneOffset(street: Street, travel: Travel): number {
  const half = street.roadHalf * 0.5;
  // Facing +Z the right kerb is at -X; facing +X the right kerb is at +Z.
  const sign = street.axis === 'x' ? -travel : travel;
  return street.position + sign * half;
}

export function buildRoadNetwork(plan: CityPlan): RoadNetwork {
  const nodes = new Map<string, NetworkNode>();
  const junctions: Junction[] = [];
  const junctionById = new Map<string, Junction>();
  const crossings: Crossing[] = [];
  const crossingById = new Map<string, Crossing>();

  const xStreets = plan.streets.filter((s) => s.axis === 'x');
  const zStreets = plan.streets.filter((s) => s.axis === 'z');

  // -- junctions ------------------------------------------------------------
  for (const sx of xStreets) {
    for (const sz of zStreets) {
      if (!overlaps(sx, sz)) continue;
      const id = `j:${sx.id}:${sz.id}`;
      const junction: Junction = {
        id,
        x: sx.position,
        z: sz.position,
        streetX: sx.id,
        streetZ: sz.id,
        halfX: sx.roadHalf,
        halfZ: sz.roadHalf,
        // Deterministic spread so neighbouring junctions are out of step.
        phaseOffset: hash2(sx.position, sz.position, 41) * SIGNAL_CYCLE,
      };
      junctions.push(junction);
      junctionById.set(id, junction);
      nodes.set(id, { id, x: junction.x, z: junction.z, kind: 'junction' });

      // A crossing on each arm, set just outside the junction box so a waiting
      // pedestrian never stands in the path of a turning car.
      // A crossing displaced along Z must clear the junction's Z half-extent,
      // which is set by the east-west street - and vice versa. Getting these
      // the wrong way round puts the crossing inside the junction box, where a
      // waiting pedestrian stands in the path of turning cars.
      const armX = sx.roadHalf + 1.6;
      const armZ = sz.roadHalf + 1.6;
      for (const [side, cx, cz, axis, span, width] of [
        ['n', junction.x, junction.z - armZ, 'x', sx.roadHalf, 1.6],
        ['s', junction.x, junction.z + armZ, 'x', sx.roadHalf, 1.6],
        ['w', junction.x - armX, junction.z, 'z', sz.roadHalf, 1.6],
        ['e', junction.x + armX, junction.z, 'z', sz.roadHalf, 1.6],
      ] as const) {
        const cid = `${id}:${side}`;
        const crossing: Crossing = {
          id: cid,
          junctionId: id,
          axis,
          x: cx,
          z: cz,
          halfSpan: span,
          halfWidth: width,
        };
        crossings.push(crossing);
        crossingById.set(cid, crossing);
      }
    }
  }

  // -- lane segments --------------------------------------------------------
  const lanes: LaneSegment[] = [];
  for (const street of plan.streets) {
    // Every junction on this street, plus the two ends, ordered along the axis.
    const stops: { at: number; node: string }[] = [];
    for (const junction of junctions) {
      const onThis = street.axis === 'x' ? junction.streetX === street.id : junction.streetZ === street.id;
      if (!onThis) continue;
      stops.push({ at: street.axis === 'x' ? junction.z : junction.x, node: junction.id });
    }
    const startId = `t:${street.id}:start`;
    const endId = `t:${street.id}:end`;
    nodes.set(startId, {
      id: startId,
      x: street.axis === 'x' ? street.position : street.from,
      z: street.axis === 'x' ? street.from : street.position,
      kind: 'terminus',
    });
    nodes.set(endId, {
      id: endId,
      x: street.axis === 'x' ? street.position : street.to,
      z: street.axis === 'x' ? street.to : street.position,
      kind: 'terminus',
    });
    stops.push({ at: street.from, node: startId }, { at: street.to, node: endId });
    stops.sort((a, b) => a.at - b.at);

    for (const travel of [1, -1] as const) {
      const offset = laneOffset(street, travel);
      const ordered = travel === 1 ? stops : [...stops].reverse();
      for (let i = 0; i < ordered.length - 1; i += 1) {
        const a = ordered[i];
        const b = ordered[i + 1];
        if (!a || !b) continue;
        const length = Math.abs(b.at - a.at);
        // Junctions that coincide would otherwise produce zero-length lanes.
        if (length < 0.5) continue;
        lanes.push({
          id: `l:${street.id}:${travel}:${i}`,
          streetId: street.id,
          axis: street.axis,
          travel,
          offset,
          fromNode: a.node,
          toNode: b.node,
          start: a.at,
          end: b.at,
          length,
        });
      }
    }
  }

  const lanesFrom = new Map<string, LaneSegment[]>();
  for (const lane of lanes) {
    const list = lanesFrom.get(lane.fromNode);
    if (list) list.push(lane);
    else lanesFrom.set(lane.fromNode, [lane]);
  }

  // -- pavement graph -------------------------------------------------------
  const walkNodes = new Map<string, WalkNode>();
  const walkEdges: WalkEdge[] = [];

  /** Pavement centreline offset on one side of a street. */
  const walkOffset = (street: Street, side: 1 | -1): number =>
    street.position + side * (street.roadHalf + street.sidewalk * 0.5);

  /**
   * Pavement runs along a street and STOPS AT THE KERB of every street that
   * crosses it.
   *
   * The first version of this put a node at each junction's own coordinate,
   * which is the centre of the crossing street's carriageway - so 188 of 220
   * nodes and 326 of 376 edges sat in the road, and anything following the
   * graph walked straight through live traffic at almost every junction. The
   * chain is now broken across each crossing carriageway, and the only way
   * over that gap is a `Crossing` edge, which is signal-gated.
   */
  for (const street of plan.streets) {
    // Carriageways that interrupt this pavement, as intervals along the axis.
    const gaps: { from: number; to: number }[] = [];
    const kerbs: number[] = [];
    const crossHere: number[] = [];
    for (const junction of junctions) {
      const onThis =
        street.axis === 'x' ? junction.streetX === street.id : junction.streetZ === street.id;
      if (!onThis) continue;
      const other = plan.streets.find(
        (s2) => s2.id === (street.axis === 'x' ? junction.streetZ : junction.streetX),
      );
      if (!other) continue;
      const at = street.axis === 'x' ? junction.z : junction.x;
      gaps.push({ from: at - other.roadHalf, to: at + other.roadHalf });
      // Stand the kerb node just PAST the carriageway edge. Exactly on the
      // edge counts as being on the road, which put every kerb station in
      // live traffic.
      kerbs.push(at - other.roadHalf - KERB_MARGIN, at + other.roadHalf + KERB_MARGIN);
    }
    // Every crossing OF this street needs a node on both pavements.
    for (const crossing of crossings) {
      if (crossing.axis !== street.axis) continue;
      const junction = junctionById.get(crossing.junctionId);
      if (!junction) continue;
      const owner = street.axis === 'x' ? junction.streetX : junction.streetZ;
      if (owner !== street.id) continue;
      crossHere.push(street.axis === 'x' ? crossing.z : crossing.x);
    }

    const stations = new Set<number>([street.from, street.to]);
    for (const at of kerbs) {
      if (at > street.from && at < street.to) stations.add(at);
    }
    for (const at of crossHere) if (at > street.from && at < street.to) stations.add(at);

    const inGap = (at: number): boolean =>
      gaps.some((g) => at > g.from - 0.01 && at < g.to + 0.01);
    // A street that terminates at a cross street has its endpoint inside that
    // carriageway; such a station would be a pavement node standing in traffic.
    const ordered = [...stations].filter((at) => !inGap(at)).sort((a, b) => a - b);

    for (const side of [1, -1] as const) {
      const off = walkOffset(street, side);
      const idAt = (at: number): string => `w:${street.id}:${side}:${at.toFixed(2)}`;
      for (const at of ordered) {
        const id = idAt(at);
        if (walkNodes.has(id)) continue;
        walkNodes.set(id, {
          id,
          x: street.axis === 'x' ? off : at,
          z: street.axis === 'x' ? at : off,
        });
      }
      for (let i = 0; i < ordered.length - 1; i += 1) {
        const a = ordered[i];
        const b = ordered[i + 1];
        if (a === undefined || b === undefined) continue;
        // Skip the span that lies across a crossing carriageway.
        if (inGap((a + b) / 2)) continue;
        const na = walkNodes.get(idAt(a));
        const nb = walkNodes.get(idAt(b));
        if (!na || !nb) continue;
        const length = Math.hypot(nb.x - na.x, nb.z - na.z);
        if (length < 0.5) continue;
        walkEdges.push({ id: `we:${na.id}>${nb.id}`, fromNode: na.id, toNode: nb.id, length, crossingId: null });
        walkEdges.push({ id: `we:${nb.id}>${na.id}`, fromNode: nb.id, toNode: na.id, length, crossingId: null });
      }
    }
  }

  // Crossing edges span kerb to kerb across the street being crossed.
  for (const crossing of crossings) {
    const junction = junctionById.get(crossing.junctionId);
    if (!junction) continue;
    const streetId = crossing.axis === 'x' ? junction.streetX : junction.streetZ;
    const street = plan.streets.find((s2) => s2.id === streetId);
    if (!street) continue;
    const at = crossing.axis === 'x' ? crossing.z : crossing.x;
    const a = walkNodes.get(`w:${street.id}:1:${at.toFixed(2)}`);
    const b = walkNodes.get(`w:${street.id}:-1:${at.toFixed(2)}`);
    if (!a || !b) continue;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    walkEdges.push({ id: `wx:${crossing.id}:+`, fromNode: a.id, toNode: b.id, length, crossingId: crossing.id });
    walkEdges.push({ id: `wx:${crossing.id}:-`, fromNode: b.id, toNode: a.id, length, crossingId: crossing.id });
  }

  const walkFrom = new Map<string, WalkEdge[]>();
  for (const edge of walkEdges) {
    const list = walkFrom.get(edge.fromNode);
    if (list) list.push(edge);
    else walkFrom.set(edge.fromNode, [edge]);
  }

  // Drop stations that ended up with no edge at all - a station beside a gap
  // can lose both of its spans. A node nothing can leave is not part of the
  // graph, and leaving it in makes every consumer handle a dead end.
  for (const [id] of [...walkNodes]) {
    if (!walkFrom.has(id)) walkNodes.delete(id);
  }

  return {
    nodes,
    lanes,
    junctions,
    crossings,
    walkNodes,
    walkEdges,
    lanesFrom,
    walkFrom,
    crossingById,
    junctionById,
  };
}

/** World position a lane occupies at a given distance along it. */
export function lanePoint(lane: LaneSegment, along: number): { x: number; z: number } {
  const at = lane.start + lane.travel * along;
  return lane.axis === 'x' ? { x: lane.offset, z: at } : { x: at, z: lane.offset };
}

/** Heading, in the game's yaw convention, for travelling down a lane. */
export function laneHeading(lane: LaneSegment): number {
  // Forward is (-sin yaw, 0, -cos yaw): yaw 0 faces -Z, -PI/2 faces +X.
  if (lane.axis === 'x') return lane.travel === 1 ? Math.PI : 0;
  return lane.travel === 1 ? -Math.PI / 2 : Math.PI / 2;
}

/**
 * Legal continuations from the end of a lane, with the U-turn removed.
 *
 * Keeping the U-turn out here rather than in the driver is deliberate: every
 * consumer wants the same rule, and a car that flips direction inside a
 * junction is the single most obvious way for traffic to look fake.
 */
export function exitsFrom(network: RoadNetwork, lane: LaneSegment): readonly LaneSegment[] {
  const candidates = network.lanesFrom.get(lane.toNode) ?? [];
  const forward = candidates.filter(
    (next) => !(next.streetId === lane.streetId && next.travel !== lane.travel),
  );
  if (forward.length > 0) return forward;
  // Only a dead end may turn a car around. At a junction an empty list is the
  // honest answer: the caller recycles the vehicle rather than spinning it on
  // the spot, which is the most obvious way for traffic to read as fake.
  return network.nodes.get(lane.toNode)?.kind === 'terminus' ? candidates : [];
}
