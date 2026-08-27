/**
 * The walkable surface pedestrians are allowed to occupy.
 *
 * WHY THIS EXISTS INSTEAD OF USING `network.walkNodes` / `network.walkEdges`
 * DIRECTLY. The shared `RoadNetwork` is the authority for junctions, crossings
 * and signals, and this module uses it as such. Its pavement *geometry*,
 * however, cannot be walked on as published: a walk node is placed at the
 * junction's own coordinate along the street, which is the centre of the
 * CROSSING street's carriageway. Measured against `CityGround`, 188 of the 220
 * published walk nodes and 326 of the 376 non-crossing walk edges are on a
 * carriageway. Following them verbatim would put a pedestrian in the road at
 * nearly every junction, which is exactly the behaviour we must not ship.
 *
 * So this module keeps the shared topology - the same streets, the same
 * junctions, the same `Crossing` records, the same `walkSignal` clock - and
 * rebuilds only the polyline the pedestrian actually stands on:
 *
 *   - a pavement chain per street per side, running along the pavement
 *     centreline (`position ± (roadHalf + sidewalk/2)`),
 *   - broken wherever a crossing street's carriageway interrupts it,
 *   - with a station at each corner, so the chains of two streets meet at the
 *     exact same point and turning a corner needs no special case,
 *   - and a crossing link at each `Crossing`, spanning kerb to kerb at the
 *     crossing's own position along the street.
 *
 * `tests/pedestrians.test.ts` asserts against `CityGround` that no point on a
 * non-crossing link is on a carriageway or inside a building, so this claim is
 * checked rather than asserted.
 *
 * COORDINATES: +X east, +Z south, 1 unit = 1 metre, matching the rest of the
 * project. `n` is the left-hand normal of `d` in the XZ plane.
 */

import type { Crossing, RoadNetwork } from '../city/RoadNetwork';
import type { CityPlan, Street } from '../world/CityPlan';

/**
 * Lateral clearance kept between a pedestrian's centre and the pavement edge.
 * Half a shoulder width plus a little, so a person never overhangs the kerb.
 */
export const PAVEMENT_MARGIN = 0.46;

/** Narrowest corridor we will still route through, in metres either side. */
const MIN_HALF_WIDTH = 0.34;

export interface PavementNode {
  readonly x: number;
  readonly z: number;
}

/** One directed run of walkable surface. Every link has a reverse. */
export interface PavementLink {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  /** Unit direction from A to B. */
  readonly dx: number;
  readonly dz: number;
  /** Unit left-hand normal of `d`. Positive lateral is to the walker's left. */
  readonly nx: number;
  readonly nz: number;
  readonly length: number;
  /** How far from the centreline a pedestrian may stray, either side. */
  readonly halfWidth: number;
  readonly streetId: string;
  /** Non-null while the link is on the carriageway; obey its signal. */
  readonly crossing: Crossing | null;
  /** Index of the link running the other way. Always valid. */
  reverse: number;
}

export interface PavementGraph {
  readonly nodes: readonly PavementNode[];
  readonly links: readonly PavementLink[];
  /** Link indices leaving each node. */
  readonly linksFrom: readonly (readonly number[])[];
  /** Prefix sums of link length, for length-weighted sampling. */
  readonly lengthCdf: Float64Array;
  readonly totalLength: number;
}

/** Pavement centreline offset from a street's centreline, on one side. */
export function pavementOffset(street: Street, side: 1 | -1): number {
  return street.position + side * (street.roadHalf + street.sidewalk * 0.5);
}

function nodeKey(x: number, z: number): string {
  return `${Math.round(x * 100)}:${Math.round(z * 100)}`;
}

interface Station {
  readonly at: number;
  readonly crossing: Crossing | null;
}

/**
 * Builds the pedestrian surface for a plan.
 *
 * `network` supplies the junctions and crossings; nothing about the returned
 * graph is invented independently of it.
 */
export function buildPavementGraph(plan: CityPlan, network: RoadNetwork): PavementGraph {
  const nodes: PavementNode[] = [];
  const nodeIndex = new Map<string, number>();
  const links: PavementLink[] = [];
  const byKey = new Map<string, number>();

  const streetById = new Map<string, Street>(plan.streets.map((s) => [s.id, s]));

  const addNode = (x: number, z: number): number => {
    const key = nodeKey(x, z);
    const found = nodeIndex.get(key);
    if (found !== undefined) return found;
    const index = nodes.length;
    nodes.push({ x, z });
    nodeIndex.set(key, index);
    return index;
  };

  const addLink = (
    id: string,
    ax: number,
    az: number,
    bx: number,
    bz: number,
    halfWidth: number,
    streetId: string,
    crossing: Crossing | null,
  ): void => {
    const length = Math.hypot(bx - ax, bz - az);
    if (length < 0.6) return;
    const key = `${nodeKey(ax, az)}>${nodeKey(bx, bz)}`;
    if (byKey.has(key)) return;
    const from = addNode(ax, az);
    const to = addNode(bx, bz);
    const dx = (bx - ax) / length;
    const dz = (bz - az) / length;
    byKey.set(key, links.length);
    links.push({
      id,
      from,
      to,
      ax,
      az,
      bx,
      bz,
      dx,
      dz,
      // Left-hand normal: rotating (dx, dz) a quarter turn about +Y.
      nx: -dz,
      nz: dx,
      length,
      halfWidth: Math.max(MIN_HALF_WIDTH, halfWidth),
      streetId,
      crossing,
      reverse: -1,
    });
  };

  /** Junctions on a street, as {along, crossStreet}. */
  const junctionsOn = (street: Street): { at: number; cross: Street }[] => {
    const out: { at: number; cross: Street }[] = [];
    for (const junction of network.junctions) {
      const mine = street.axis === 'x' ? junction.streetX : junction.streetZ;
      if (mine !== street.id) continue;
      const crossId = street.axis === 'x' ? junction.streetZ : junction.streetX;
      const cross = streetById.get(crossId);
      if (!cross) continue;
      out.push({ at: street.axis === 'x' ? junction.z : junction.x, cross });
    }
    return out;
  };

  for (const street of plan.streets) {
    const junctions = junctionsOn(street);
    // Crossings that span THIS street's carriageway are the ones a pedestrian
    // on this street's pavement steps onto; they share the street's axis.
    const ownCrossings = network.crossings.filter((c) => {
      const junction = network.junctionById.get(c.junctionId);
      if (!junction) return false;
      const owner = c.axis === 'x' ? junction.streetX : junction.streetZ;
      return owner === street.id;
    });

    const halfWidth = street.sidewalk * 0.5 - PAVEMENT_MARGIN;

    for (const side of [1, -1] as const) {
      const off = pavementOffset(street, side);

      // A crossing street only interrupts this pavement where its carriageway
      // actually reaches. `cooper-street` stops before the park, so the
      // pavement of the street it would have met stays continuous there.
      const blockers = junctions.filter(
        ({ cross }) => off >= cross.from && off <= cross.to,
      );

      const insideCarriageway = (at: number): boolean =>
        blockers.some(({ at: jAt, cross }) => Math.abs(at - jAt) <= cross.roadHalf + 0.01);

      const stations: Station[] = [];
      const push = (at: number, crossing: Crossing | null): void => {
        if (at < street.from - 0.01 || at > street.to + 0.01) return;
        if (insideCarriageway(at)) return;
        stations.push({ at, crossing });
      };

      push(street.from, null);
      push(street.to, null);
      for (const { at, cross } of junctions) {
        // Corner stations: where this pavement meets the crossing street's.
        const corner = cross.roadHalf + cross.sidewalk * 0.5;
        push(at - corner, null);
        push(at + corner, null);
      }
      for (const crossing of ownCrossings) {
        const at = street.axis === 'x' ? crossing.z : crossing.x;
        push(at, crossing);
      }

      stations.sort((a, b) => a.at - b.at);

      // Merge stations that land within a few centimetres of each other, but
      // never lose a crossing: an arterial's corner and its crossing coincide
      // whenever the pavement happens to be 3.2 m wide.
      const merged: Station[] = [];
      for (const station of stations) {
        const last = merged[merged.length - 1];
        if (last && Math.abs(last.at - station.at) < 0.25) {
          if (!last.crossing && station.crossing) {
            merged[merged.length - 1] = { at: last.at, crossing: station.crossing };
          }
          continue;
        }
        merged.push(station);
      }

      const point = (at: number): { x: number; z: number } =>
        street.axis === 'x' ? { x: off, z: at } : { x: at, z: off };

      for (let i = 0; i < merged.length - 1; i += 1) {
        const a = merged[i];
        const b = merged[i + 1];
        if (!a || !b) continue;
        // The gap a crossing street's carriageway punches through the pavement.
        if (insideCarriageway((a.at + b.at) * 0.5)) continue;
        const pa = point(a.at);
        const pb = point(b.at);
        const id = `p:${street.id}:${side}:${i}`;
        addLink(id, pa.x, pa.z, pb.x, pb.z, halfWidth, street.id, null);
        addLink(`${id}:r`, pb.x, pb.z, pa.x, pa.z, halfWidth, street.id, null);
      }
    }

    // Crossing links: kerb to kerb, at the crossing's own position along the
    // street, joining the two pavement chains this street already has.
    for (const crossing of ownCrossings) {
      const at = street.axis === 'x' ? crossing.z : crossing.x;
      if (at < street.from - 0.01 || at > street.to + 0.01) continue;
      const near = pavementOffset(street, 1);
      const far = pavementOffset(street, -1);
      const pa = street.axis === 'x' ? { x: near, z: at } : { x: at, z: near };
      const pb = street.axis === 'x' ? { x: far, z: at } : { x: at, z: far };
      const half = Math.max(MIN_HALF_WIDTH, crossing.halfWidth - PAVEMENT_MARGIN);
      addLink(`x:${crossing.id}`, pa.x, pa.z, pb.x, pb.z, half, street.id, crossing);
      addLink(`x:${crossing.id}:r`, pb.x, pb.z, pa.x, pa.z, half, street.id, crossing);
    }
  }

  // Pair every link with its reverse.
  for (let i = 0; i < links.length; i += 1) {
    const link = links[i];
    if (!link) continue;
    const key = `${nodeKey(link.bx, link.bz)}>${nodeKey(link.ax, link.az)}`;
    link.reverse = byKey.get(key) ?? -1;
  }

  const linksFrom: number[][] = nodes.map(() => []);
  for (let i = 0; i < links.length; i += 1) {
    const link = links[i];
    if (!link) continue;
    linksFrom[link.from]?.push(i);
  }

  const lengthCdf = new Float64Array(links.length);
  let total = 0;
  for (let i = 0; i < links.length; i += 1) {
    // Crossings are short and busy; sampling them for spawns would put a
    // disproportionate share of the population standing in the road.
    total += links[i]?.crossing ? 0 : (links[i]?.length ?? 0);
    lengthCdf[i] = total;
  }

  return { nodes, links, linksFrom, lengthCdf, totalLength: total };
}

/** Picks a link with probability proportional to its length. `r` is in [0, 1). */
export function sampleLinkByLength(graph: PavementGraph, r: number): number {
  const target = r * graph.totalLength;
  let lo = 0;
  let hi = graph.lengthCdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((graph.lengthCdf[mid] ?? 0) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** World position `along` metres down a link, offset `lateral` to the left. */
export function linkPoint(
  link: PavementLink,
  along: number,
  lateral: number,
  out: { x: number; z: number },
): void {
  out.x = link.ax + link.dx * along + link.nx * lateral;
  out.z = link.az + link.dz * along + link.nz * lateral;
}
