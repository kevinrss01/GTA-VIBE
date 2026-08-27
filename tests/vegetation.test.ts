/**
 * Vegetation geometry audit.
 *
 * This is the test that would have caught the floating leaf cards. The cards
 * on the broadleaf tree were laid out on a ring of their own radius, 1.5-1.98 m
 * from the trunk and reaching 2.6 m at the tip, while the canopy mass they were
 * meant to sit in was only 0.8-1.35 m across. Nine of the sixteen cards on
 * every one of the 128 trees in the city therefore had all four corners outside
 * every canopy lobe, and rendered as flat dark quads hanging in clear air.
 *
 * The invariant asserted here is the one that makes that impossible: every
 * foliage vertex of a vegetation prop lies inside the canopy hull the prop
 * publishes. The lump geometry sits exactly on the hull, so anything further
 * out can only be a card that has escaped.
 */

import { describe, expect, it } from 'vitest';
import type { BufferAttribute, BufferGeometry, InterleavedBufferAttribute } from 'three';

import {
  BROADLEAF_TRUNK,
  CANOPY_CARD_REACH,
  CANOPY_LOBES,
  PROP_SPECS,
  broadleafTrunkAxis,
  canopyRadius,
  createPropGeometry,
  propTriangleCount,
  type CanopyProp,
} from '../src/world/build/PropLibrary';
import { ALL_PROP_KEYS } from '../src/world/build/types';

const CANOPY_PROPS = Object.keys(CANOPY_LOBES) as CanopyProp[];
const FOLIAGE_KEYS = new Set(['foliage', 'foliageDark']);

/**
 * The bound the vegetation family is held to.
 *
 * A leaf card is supposed to break the surface of its lobe - that is what
 * ragged the silhouette - so the limit is the card reach the library
 * publishes, plus floating-point slack. The lumps themselves are icosahedra
 * inscribed in the lobes and land on 1.0 exactly. What this rejects is a card
 * that has left the canopy altogether: the ones this replaced reached 1.93.
 */
const HULL_TOLERANCE = CANOPY_CARD_REACH + 0.005;

interface Vertex {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function vertices(attribute: BufferAttribute | InterleavedBufferAttribute): Vertex[] {
  const out: Vertex[] = [];
  for (let i = 0; i < attribute.count; i += 1) {
    out.push({ x: attribute.getX(i), y: attribute.getY(i), z: attribute.getZ(i) });
  }
  return out;
}

describe('vegetation canopies', () => {
  it('keeps every foliage vertex inside the canopy hull', () => {
    for (const prop of CANOPY_PROPS) {
      const lobes = CANOPY_LOBES[prop];
      expect(lobes.length, `${prop} has no canopy lobes`).toBeGreaterThan(0);

      let worst = 0;
      let worstAt: Vertex = { x: 0, y: 0, z: 0 };
      let foliageVertices = 0;
      for (const part of createPropGeometry(prop)) {
        if (FOLIAGE_KEYS.has(part.key)) {
          for (const v of vertices(part.geometry.getAttribute('position'))) {
            foliageVertices += 1;
            const radius = canopyRadius(lobes, v.x, v.y, v.z);
            if (radius > worst) {
              worst = radius;
              worstAt = v;
            }
          }
        }
        part.geometry.dispose();
      }

      expect(foliageVertices, `${prop} emits no foliage`).toBeGreaterThan(0);
      expect(
        worst,
        `${prop}: a foliage vertex at (${worstAt.x.toFixed(2)}, ${worstAt.y.toFixed(2)}, ${worstAt.z.toFixed(2)}) sits ${worst.toFixed(2)}x the canopy radius from the nearest lobe centre`,
      ).toBeLessThanOrEqual(HULL_TOLERANCE);
    }
  });

  it('fills the canopy hull rather than shrinking inside it', () => {
    // The mirror of the check above: cards must still reach the surface, or
    // "inside the hull" could be satisfied by deleting them.
    for (const prop of CANOPY_PROPS) {
      const lobes = CANOPY_LOBES[prop];
      let reaching = 0;
      for (const part of createPropGeometry(prop)) {
        if (FOLIAGE_KEYS.has(part.key)) {
          for (const v of vertices(part.geometry.getAttribute('position'))) {
            if (canopyRadius(lobes, v.x, v.y, v.z) > 0.9) reaching += 1;
          }
        }
        part.geometry.dispose();
      }
      expect(reaching, `${prop} has no foliage near its canopy surface`).toBeGreaterThan(8);
    }
  });

  it('roots every piece of bark in the trunk', () => {
    // The broadleaf's branches used to be free-floating cylinders: both ends
    // 0.63 m out from a trunk 0.16 m in radius, spanning y 3.25-4.55 while the
    // foliage started at 4.35, so their lower halves read as a bare crossed
    // "X" of sticks hanging under the tree.
    //
    // The check is structural rather than a distance threshold: split the bark
    // into connected pieces and require each one to be anchored in the trunk.
    // Four detached cylinders are four unanchored pieces however they are
    // positioned.
    const parts = createPropGeometry('broadleafTree').filter((p) => p.key === 'barkTree');
    expect(parts.length, 'the broadleaf emits no bark').toBe(1);
    const geometry = (parts[0] as { geometry: BufferGeometry }).geometry;
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    expect(index, 'bark geometry is not indexed').not.toBeNull();

    // Union-find over vertices, welding any that share a position and joining
    // any that share a triangle.
    const parent = new Int32Array(position.count);
    for (let i = 0; i < parent.length; i += 1) parent[i] = i;
    const find = (a: number): number => {
      let root = a;
      while (parent[root] !== root) root = parent[root] as number;
      let walk = a;
      while (parent[walk] !== walk) {
        const next = parent[walk] as number;
        parent[walk] = root;
        walk = next;
      }
      return root;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    const byPosition = new Map<string, number>();
    for (let i = 0; i < position.count; i += 1) {
      const key = `${position.getX(i).toFixed(4)}|${position.getY(i).toFixed(4)}|${position.getZ(i).toFixed(4)}`;
      const seen = byPosition.get(key);
      if (seen === undefined) byPosition.set(key, i);
      else union(i, seen);
    }
    const indices = index as NonNullable<typeof index>;
    for (let i = 0; i < indices.count; i += 3) {
      union(indices.getX(i), indices.getX(i + 1));
      union(indices.getX(i + 1), indices.getX(i + 2));
    }

    // A piece is anchored if any of its vertices lies inside the trunk, and
    // it must die inside the crown: a limb that stopped short of the foliage
    // would leave a bare stick poking out of the canopy instead.
    const anchored = new Set<number>();
    const pieces = new Map<number, { seen: Vertex; top: Vertex }>();
    for (let i = 0; i < position.count; i += 1) {
      const root = find(i);
      const v = { x: position.getX(i), y: position.getY(i), z: position.getZ(i) };
      const piece = pieces.get(root);
      if (!piece) pieces.set(root, { seen: v, top: v });
      else if (v.y > piece.top.y) piece.top = v;
      if (v.y < -0.01 || v.y > BROADLEAF_TRUNK.height) continue;
      const axis = broadleafTrunkAxis(v.y);
      if (Math.hypot(v.x - axis.x, v.z - axis.z) <= axis.radius + 1e-3) anchored.add(root);
    }
    geometry.dispose();

    expect(pieces.size, 'the bark has no connected pieces at all').toBeGreaterThan(1);
    const floating = [...pieces.entries()]
      .filter(([root]) => !anchored.has(root))
      .map(([, p]) => `piece near (${p.seen.x.toFixed(2)}, ${p.seen.y.toFixed(2)}, ${p.seen.z.toFixed(2)}) is not rooted in the trunk`);
    const lobes = CANOPY_LOBES.broadleafTree;
    const bare = [...pieces.values()]
      .filter((p) => canopyRadius(lobes, p.top.x, p.top.y, p.top.z) > 1)
      .map((p) => `piece ending at (${p.top.x.toFixed(2)}, ${p.top.y.toFixed(2)}, ${p.top.z.toFixed(2)}) is not buried in the canopy`);
    expect([...floating, ...bare].join('; ')).toBe('');
  });

  it('emits no degenerate surface normal', () => {
    // A tapered blade whose first segment starts at a point collapses one edge
    // of its quad. That used to leave 144 vertices per palm with a zero-length
    // normal, which shades black.
    for (const prop of ALL_PROP_KEYS) {
      for (const part of createPropGeometry(prop)) {
        const normal = part.geometry.getAttribute('normal');
        let bad = 0;
        for (let i = 0; i < normal.count; i += 1) {
          const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
          if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-3) bad += 1;
        }
        part.geometry.dispose();
        expect(bad, `${prop}/${part.key} has ${bad} degenerate normals`).toBe(0);
      }
    }
  });

  it('grounds every vegetation prop and matches its declared bounds', () => {
    for (const prop of ['broadleafTree', 'palmTree', 'shrub'] as const) {
      const spec = PROP_SPECS[prop];
      let minY = Infinity;
      let maxY = -Infinity;
      let halfX = 0;
      let halfZ = 0;
      for (const part of createPropGeometry(prop)) {
        for (const v of vertices(part.geometry.getAttribute('position'))) {
          minY = Math.min(minY, v.y);
          maxY = Math.max(maxY, v.y);
          halfX = Math.max(halfX, Math.abs(v.x));
          halfZ = Math.max(halfZ, Math.abs(v.z));
        }
        part.geometry.dispose();
      }
      // Origin at the base, so nothing may dip below the ground it stands on.
      expect(minY, `${prop} starts at ${minY.toFixed(3)}m, not on the ground`).toBeCloseTo(0, 3);
      expect(maxY, `${prop} is ${maxY.toFixed(2)}m tall, declared ${spec.height}m`).toBeLessThanOrEqual(
        spec.height + 0.05,
      );
      // The palm's fronds are deliberately wider than its declared footprint;
      // its spec describes the spread it needs, so only check the canopies
      // whose bounds the scatterer is told about.
      if (prop !== 'palmTree') {
        expect(halfX * 2, `${prop} is ${(halfX * 2).toFixed(2)}m wide, declared ${spec.width}m`)
          .toBeLessThanOrEqual(spec.width + 0.2);
        expect(halfZ * 2, `${prop} is ${(halfZ * 2).toFixed(2)}m deep, declared ${spec.depth}m`)
          .toBeLessThanOrEqual(spec.depth + 0.2);
      }
    }
  });

  it('stays inside the vegetation triangle ceiling', () => {
    // Trees are instanced 128 and 38 times; the ceiling is the one already
    // enforced in tests/streets.test.ts, restated here next to the geometry.
    for (const prop of ['broadleafTree', 'palmTree', 'shrub', 'planter'] as const) {
      const ceiling = prop === 'broadleafTree' || prop === 'palmTree' ? 900 : 400;
      const count = propTriangleCount(prop);
      expect(count, `${prop} is ${count} triangles`).toBeLessThanOrEqual(ceiling);
    }
  });
});
