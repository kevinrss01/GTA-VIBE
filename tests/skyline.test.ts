/**
 * Distant-skyline audit.
 *
 * Two things have to hold for the horizon. It must stay out of the world the
 * player can walk around - the previous near band was generated on an arc that
 * reached x = -175, which put a thirty-metre "distant" block on the promenade,
 * filling half the frame from the beach. And it must stay cheap and
 * deterministic, because it is background geometry that exists only to keep
 * the city from reading as a diorama.
 */

import { describe, expect, it } from 'vitest';
import type { BufferGeometry, Matrix4 } from 'three';

import type { MaterialKey } from '../src/render/materials';
import { SKYLINE_STANDOFF, buildDistantSkyline } from '../src/world/Environment';
import { SEA_LEVEL, WORLD_BOUNDS, groundElevation } from '../src/world/elevation';
import type {
  ColliderBox,
  GeometrySink,
  InteractionPoint,
  LightRequest,
  PropKey,
} from '../src/world/build/types';

/** Keeps the geometry instead of summarising it, so vertices can be inspected. */
class KeepingSink implements GeometrySink {
  readonly parts: { key: MaterialKey; geometry: BufferGeometry }[] = [];
  readonly instances: { prop: PropKey; matrix: Matrix4 }[] = [];
  readonly colliders: ColliderBox[] = [];
  readonly lights: LightRequest[] = [];
  readonly interactions: InteractionPoint[] = [];

  add(key: MaterialKey, geometry: BufferGeometry): void {
    this.parts.push({ key, geometry });
  }
  instance(prop: PropKey, matrix: Matrix4): void {
    this.instances.push({ prop, matrix });
  }
  collider(box: ColliderBox): void {
    this.colliders.push(box);
  }
  light(request: LightRequest): void {
    this.lights.push(request);
  }
  interaction(point: InteractionPoint): void {
    this.interactions.push(point);
  }
}

function buildSkyline(): KeepingSink {
  const sink = new KeepingSink();
  buildDistantSkyline(sink);
  return sink;
}

interface SkylineVertex {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** uv.x: which building this vertex belongs to, as the shader sees it. */
  readonly id: number;
  /** uv.y: how deep in the haze the building sits. */
  readonly haze: number;
}

function readVertices(sink: KeepingSink): SkylineVertex[] {
  const out: SkylineVertex[] = [];
  for (const part of sink.parts) {
    const position = part.geometry.getAttribute('position');
    const uv = part.geometry.getAttribute('uv');
    for (let i = 0; i < position.count; i += 1) {
      out.push({
        x: position.getX(i),
        y: position.getY(i),
        z: position.getZ(i),
        id: uv.getX(i),
        haze: uv.getY(i),
      });
    }
  }
  return out;
}

/** How far a point is outside the playable rectangle; negative means inside. */
function distanceOutsideWorld(x: number, z: number): number {
  const dx = Math.max(WORLD_BOUNDS.minX - x, x - WORLD_BOUNDS.maxX);
  const dz = Math.max(WORLD_BOUNDS.minZ - z, z - WORLD_BOUNDS.maxZ);
  if (dx <= 0 && dz <= 0) return -Math.min(-dx, -dz);
  return Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
}

describe('distant skyline', () => {
  const sink = buildSkyline();
  const vertices = readVertices(sink);

  it('emits one cheap geometry under its own material key', () => {
    expect(sink.parts.map((p) => p.key)).toEqual(['skyline']);
    // One geometry, deliberately: `WorldSink` buckets by bounding-box centre,
    // so splitting the horizon would push each piece into a chunk far enough
    // out that `updateChunks` stops drawing it.
    expect(sink.parts.length).toBe(1);
    // No colliders, no lights, no props: the far shore is never approachable.
    expect(sink.colliders.length).toBe(0);
    expect(sink.lights.length).toBe(0);
    expect(sink.instances.length).toBe(0);
  });

  it('never reaches into the world the player can walk around', () => {
    let worst = Infinity;
    let worstAt: SkylineVertex | null = null;
    for (const v of vertices) {
      const outside = distanceOutsideWorld(v.x, v.z);
      if (outside < worst) {
        worst = outside;
        worstAt = v;
      }
    }
    expect(worstAt).not.toBeNull();
    const at = worstAt as SkylineVertex;
    expect(
      worst,
      `a skyline vertex at (${at.x.toFixed(0)}, ${at.z.toFixed(0)}) is only ${worst.toFixed(0)}m outside the playable world`,
    ).toBeGreaterThanOrEqual(SKYLINE_STANDOFF - 1);
  });

  it('sinks every building past its own ground and past the waterline', () => {
    // There is no terrain mesh outside the world bounds, so the sea plane and
    // the fog are the only things that can hide a base. A building whose foot
    // stopped at the analytic hillside would show a band of sky underneath it.
    const byBuilding = new Map<number, SkylineVertex[]>();
    for (const v of vertices) {
      const list = byBuilding.get(v.id);
      if (list) list.push(v);
      else byBuilding.set(v.id, [v]);
    }
    expect(byBuilding.size, 'the skyline is not split into buildings').toBeGreaterThan(80);

    const floating: string[] = [];
    for (const list of byBuilding.values()) {
      const foot = Math.min(...list.map((v) => v.y));
      const lowest = list.filter((v) => v.y <= foot + 1e-3);
      for (const v of lowest) {
        if (foot > groundElevation(v.x, v.z) || foot > SEA_LEVEL) {
          floating.push(
            `building at (${v.x.toFixed(0)}, ${v.z.toFixed(0)}) stops at y=${foot.toFixed(1)} above ground ${groundElevation(v.x, v.z).toFixed(1)}`,
          );
          break;
        }
      }
    }
    expect(floating.slice(0, 5).join('; ')).toBe('');
  });

  it('gives the shader the per-building data it needs', () => {
    // uv.x identifies the building, uv.y its haze layer. Both are read as
    // normalised values by `makeSkylineFacades`, so anything outside [0, 1]
    // would silently pick the wrong façade family.
    const ids = new Set<number>();
    const hazes = new Set<number>();
    for (const v of vertices) {
      expect(v.id).toBeGreaterThanOrEqual(0);
      expect(v.id).toBeLessThanOrEqual(1);
      expect(v.haze).toBeGreaterThanOrEqual(0);
      expect(v.haze).toBeLessThanOrEqual(1);
      ids.add(v.id);
      hazes.add(v.haze);
    }
    // Enough distinct ids to cover all four façade families, and at least
    // three depth layers so the horizon does not read as one flat cut-out.
    expect(ids.size).toBeGreaterThan(80);
    expect(hazes.size).toBeGreaterThanOrEqual(3);
    const spread = [...ids];
    expect(Math.min(...spread)).toBeLessThan(0.3);
    expect(Math.max(...spread)).toBeGreaterThan(0.8);
  });

  it('varies the silhouette instead of repeating one profile', () => {
    // Height and footprint spread, measured per building. A row of blocks all
    // the same height is the specific failure this replaced.
    const tops = new Map<number, number>();
    const bases = new Map<number, number>();
    for (const v of vertices) {
      tops.set(v.id, Math.max(tops.get(v.id) ?? -Infinity, v.y));
      bases.set(v.id, Math.min(bases.get(v.id) ?? Infinity, v.y));
    }
    const heights = [...tops.entries()].map(([id, top]) => top - (bases.get(id) as number));
    heights.sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)] as number;
    expect(median).toBeGreaterThan(15);
    // The tallest must stand well clear of the median, or there is no skyline.
    expect((heights[heights.length - 1] as number) / median).toBeGreaterThan(2.5);
    // ...and the shortest must be genuinely low, or there is no layering.
    expect((heights[0] as number) / median).toBeLessThan(0.6);
  });

  it('rebuilds identically from the seed', () => {
    const again = readVertices(buildSkyline());
    expect(again.length).toBe(vertices.length);
    for (let i = 0; i < vertices.length; i += 1) {
      const a = vertices[i] as SkylineVertex;
      const b = again[i] as SkylineVertex;
      if (a.x !== b.x || a.y !== b.y || a.z !== b.z || a.id !== b.id || a.haze !== b.haze) {
        throw new Error(`skyline vertex ${i} differs between builds`);
      }
    }
  });

  it('stays background geometry', () => {
    let triangles = 0;
    for (const part of sink.parts) {
      const index = part.geometry.getIndex();
      triangles += index ? index.count / 3 : part.geometry.getAttribute('position').count / 3;
    }
    // Measured: the horizon was 1,960 triangles as plain stepped boxes and is
    // now around 5,000 with setback ledges, parapets, crowns and masts. The
    // ceiling leaves room to add profile, not to start modelling windows -
    // those come from the shader precisely because geometry at this range is
    // the wrong currency.
    expect(triangles, `the skyline is ${triangles} triangles`).toBeLessThan(9_000);
  });
});
