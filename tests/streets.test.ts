/**
 * Street, block-ground and prop-placement checks.
 *
 * These tests build the real city through a recording sink - no WebGL - and
 * then interrogate the emitted triangles directly. The point is to prove the
 * two things that cannot be seen from the source alone: that the drawn surface
 * agrees with `CityGround.sample()`, the surface the player actually walks on,
 * and that streets and junctions tile the grid with no hole and no overlap.
 */

import { describe, expect, it } from 'vitest';
import type { BufferGeometry, Matrix4 } from 'three';

import type { MaterialKey } from '../src/render/materials';
import { CityGround } from '../src/world/CityGround';
import { corridorHalfWidth, getCityPlan, KERB_HEIGHT, type Street } from '../src/world/CityPlan';
import { landElevation } from '../src/world/elevation';
import { PROP_SPECS, propTriangleCount } from '../src/world/build/PropLibrary';
import { scatterStreetProps } from '../src/world/build/PropScatter';
import {
  buildBlockGround,
  buildIntersections,
  buildStreet,
} from '../src/world/build/StreetBuilder';
import {
  ALL_PROP_KEYS,
  type ColliderBox,
  type GeometrySink,
  type InteractionPoint,
  type LightRequest,
  type PropKey,
} from '../src/world/build/types';

// ---------------------------------------------------------------------------
// Recording sink
// ---------------------------------------------------------------------------

interface Triangle {
  readonly key: MaterialKey;
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** Y component of the face normal; 1 is flat, 0 is a wall. */
  readonly up: number;
}

interface Instance {
  readonly prop: PropKey;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly elements: readonly number[];
}

class FakeSink implements GeometrySink {
  readonly triangles: Triangle[] = [];
  readonly keys = new Set<MaterialKey>();
  readonly instances: Instance[] = [];
  readonly colliders: ColliderBox[] = [];
  readonly lights: LightRequest[] = [];
  readonly interactions: InteractionPoint[] = [];
  finite = true;

  add(key: MaterialKey, geometry: BufferGeometry): void {
    this.keys.add(key);
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const count = index ? index.count : position.count;
    for (let i = 0; i < count; i += 3) {
      const i0 = index ? index.getX(i) : i;
      const i1 = index ? index.getX(i + 1) : i + 1;
      const i2 = index ? index.getX(i + 2) : i + 2;
      const ax = position.getX(i0);
      const ay = position.getY(i0);
      const az = position.getZ(i0);
      const bx = position.getX(i1);
      const by = position.getY(i1);
      const bz = position.getZ(i1);
      const cx = position.getX(i2);
      const cy = position.getY(i2);
      const cz = position.getZ(i2);
      for (const value of [ax, ay, az, bx, by, bz, cx, cy, cz]) {
        if (!Number.isFinite(value)) this.finite = false;
      }
      const ux = bx - ax;
      const uy = by - ay;
      const uz = bz - az;
      const vx = cx - ax;
      const vy = cy - ay;
      const vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz);
      this.triangles.push({
        key,
        ax,
        ay,
        az,
        bx,
        by,
        bz,
        cx,
        cy,
        cz,
        up: length > 1e-9 ? Math.abs(ny / length) : 0,
      });
    }
    geometry.dispose();
  }

  instance(prop: PropKey, matrix: Matrix4): void {
    const e = matrix.elements;
    this.instances.push({
      prop,
      x: e[12] ?? 0,
      y: e[13] ?? 0,
      z: e[14] ?? 0,
      elements: Array.from(e),
    });
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

  get triangleCount(): number {
    return this.triangles.length;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const plan = getCityPlan();
const ground = new CityGround(plan);

function buildGround(sink: FakeSink): void {
  for (const street of plan.streets) buildStreet(street, plan, sink);
  buildIntersections(plan, sink);
  for (const block of plan.blocks) buildBlockGround(block, plan, sink);
}

const groundSink = new FakeSink();
buildGround(groundSink);

const propSink = new FakeSink();
scatterStreetProps(plan, propSink);

/** Keys that describe a walkable surface rather than paint or a wall. */
const SURFACE_KEYS: ReadonlySet<MaterialKey> = new Set<MaterialKey>([
  'asphalt',
  'asphaltWorn',
  'kerb',
  'pavement',
  'pavementDark',
  'boardwalk',
  'timberDark',
  'plazaStone',
  'gravel',
  'grass',
]);

const MARKING_KEYS: ReadonlySet<MaterialKey> = new Set<MaterialKey>([
  'roadPaint',
  'roadPaintYellow',
]);

// ---------------------------------------------------------------------------
// Triangle lookup
// ---------------------------------------------------------------------------

const LOOKUP_CELL = 6;

function cellKey(x: number, z: number): number {
  return (Math.floor(x / LOOKUP_CELL) + 1024) * 8192 + (Math.floor(z / LOOKUP_CELL) + 1024);
}

function indexTriangles(triangles: readonly Triangle[]): Map<number, Triangle[]> {
  const grid = new Map<number, Triangle[]>();
  for (const triangle of triangles) {
    const minX = Math.min(triangle.ax, triangle.bx, triangle.cx);
    const maxX = Math.max(triangle.ax, triangle.bx, triangle.cx);
    const minZ = Math.min(triangle.az, triangle.bz, triangle.cz);
    const maxZ = Math.max(triangle.az, triangle.bz, triangle.cz);
    for (let x = Math.floor(minX / LOOKUP_CELL); x <= Math.floor(maxX / LOOKUP_CELL); x += 1) {
      for (let z = Math.floor(minZ / LOOKUP_CELL); z <= Math.floor(maxZ / LOOKUP_CELL); z += 1) {
        const key = (x + 1024) * 8192 + (z + 1024);
        const bucket = grid.get(key);
        if (bucket) bucket.push(triangle);
        else grid.set(key, [triangle]);
      }
    }
  }
  return grid;
}

/** Height of a triangle at (x, z), or null if the point is outside it. */
function heightIn(triangle: Triangle, x: number, z: number): number | null {
  const d =
    (triangle.bz - triangle.cz) * (triangle.ax - triangle.cx) +
    (triangle.cx - triangle.bx) * (triangle.az - triangle.cz);
  if (Math.abs(d) < 1e-12) return null;
  const l1 =
    ((triangle.bz - triangle.cz) * (x - triangle.cx) +
      (triangle.cx - triangle.bx) * (z - triangle.cz)) /
    d;
  const l2 =
    ((triangle.cz - triangle.az) * (x - triangle.cx) +
      (triangle.ax - triangle.cx) * (z - triangle.cz)) /
    d;
  const l3 = 1 - l1 - l2;
  const tolerance = -1e-7;
  if (l1 < tolerance || l2 < tolerance || l3 < tolerance) return null;
  return l1 * triangle.ay + l2 * triangle.by + l3 * triangle.cy;
}

const surfaceGrid = indexTriangles(
  groundSink.triangles.filter((t) => SURFACE_KEYS.has(t.key) && t.up > 0.9),
);
const markingGrid = indexTriangles(groundSink.triangles.filter((t) => MARKING_KEYS.has(t.key)));
/** Only the asphalt itself: a marking must clear the road it is painted on. */
const asphaltGrid = indexTriangles(
  groundSink.triangles.filter(
    (t) => (t.key === 'asphalt' || t.key === 'asphaltWorn') && t.up > 0.9,
  ),
);

function heightsAt(grid: Map<number, Triangle[]>, x: number, z: number): number[] {
  const out: number[] = [];
  for (const triangle of grid.get(cellKey(x, z)) ?? []) {
    const y = heightIn(triangle, x, z);
    if (y !== null) out.push(y);
  }
  return out;
}

/**
 * The kerb line is where `CityGround.sample()` itself steps by 15 cm, and it is
 * also where the dropped-kerb aprons live, so height agreement is only
 * meaningful away from it.
 */
const KERB_EXCLUSION = 0.6;

function nearKerbLine(x: number, z: number): boolean {
  for (const street of plan.streets) {
    const along = street.axis === 'x' ? z : x;
    if (along < street.from - KERB_EXCLUSION || along > street.to + KERB_EXCLUSION) continue;
    const across = Math.abs((street.axis === 'x' ? x : z) - street.position);
    if (Math.abs(across - street.roadHalf) < KERB_EXCLUSION) return true;
    // The outer edge of a corridor meets the block ground; same rule applies.
    if (Math.abs(across - corridorHalfWidth(street)) < 0.35) return true;
  }
  return false;
}

/** Deterministic sample points spread over the whole grid. */
function samplePoints(count: number): { x: number; z: number }[] {
  const points: { x: number; z: number }[] = [];
  // Golden-ratio low-discrepancy sequence: no lattice alignment with the grid.
  let a = 0.31;
  let b = 0.77;
  for (let i = 0; i < count; i += 1) {
    a = (a + 0.7548776662466927) % 1;
    b = (b + 0.5698402909980532) % 1;
    points.push({ x: -172 + a * 336, z: -163 + b * 295 });
  }
  return points;
}

// ---------------------------------------------------------------------------

describe('street surfaces', () => {
  it('emits carriageway, kerb, pavement and markings for every street', () => {
    for (const street of plan.streets) {
      const sink = new FakeSink();
      buildStreet(street, plan, sink);
      const keys = sink.keys;
      expect(
        keys.has('asphalt') || keys.has('asphaltWorn'),
        `${street.id} has no carriageway`,
      ).toBe(true);
      expect(keys.has('kerb'), `${street.id} has no kerb`).toBe(true);
      const paved =
        keys.has('pavement') ||
        keys.has('pavementDark') ||
        keys.has('boardwalk') ||
        keys.has('timberDark');
      expect(paved, `${street.id} has no pavement`).toBe(true);
      expect(
        keys.has('roadPaint') || keys.has('roadPaintYellow'),
        `${street.id} has no markings`,
      ).toBe(true);
    }
  });

  it('gives every street a kerb riser and a gutter channel', () => {
    for (const street of plan.streets) {
      const sink = new FakeSink();
      buildStreet(street, plan, sink);
      const risers = sink.triangles.filter((t) => t.key === 'kerb' && t.up < 0.2);
      expect(risers.length, `${street.id} has no kerb face`).toBeGreaterThan(0);
      // A riser follows the terrain along its length, so the invariant is not
      // its bounding height but that every vertex is either on the carriageway
      // or exactly one kerb above it.
      let sawBottom = false;
      let sawTop = false;
      for (const t of risers) {
        for (const [x, y, z] of [
          [t.ax, t.ay, t.az],
          [t.bx, t.by, t.bz],
          [t.cx, t.cy, t.cz],
        ] as const) {
          const lift = y - landElevation(x, z);
          if (Math.abs(lift) < 0.002) sawBottom = true;
          else if (Math.abs(lift - KERB_HEIGHT) < 0.002) sawTop = true;
          else expect.fail(`${street.id} kerb vertex is ${lift.toFixed(3)}m above the road`);
        }
      }
      expect(sawBottom && sawTop, `${street.id} kerb is not a full riser`).toBe(true);
      expect(sink.keys.has('asphaltWorn'), `${street.id} has no gutter`).toBe(true);
    }
  });

  it('follows CityGround.sample everywhere it draws', () => {
    let checked = 0;
    let worst = 0;
    let worstAt = '';
    for (const point of samplePoints(6000)) {
      if (nearKerbLine(point.x, point.z)) continue;
      const heights = heightsAt(surfaceGrid, point.x, point.z);
      if (heights.length === 0) continue;
      const expected = ground.sample(point.x, point.z).y;
      for (const y of heights) {
        const delta = Math.abs(y - expected);
        if (delta > worst) {
          worst = delta;
          worstAt = `${point.x.toFixed(1)}, ${point.z.toFixed(1)}`;
        }
      }
      checked += 1;
    }
    expect(checked, 'not enough surface samples landed').toBeGreaterThan(400);
    expect(worst, `worst deviation ${worst.toFixed(3)}m at ${worstAt}`).toBeLessThanOrEqual(0.05);
  });

  it('leaves no hole in the street grid or the blocks', () => {
    const holes: string[] = [];
    let covered = 0;
    for (const point of samplePoints(9000)) {
      if (nearKerbLine(point.x, point.z)) continue;
      const inCorridor = plan.streets.some((street) => {
        const along = street.axis === 'x' ? point.z : point.x;
        if (along < street.from || along > street.to) return false;
        const across = Math.abs((street.axis === 'x' ? point.x : point.z) - street.position);
        return across <= corridorHalfWidth(street) - 0.35;
      });
      const block = ground.blockAt(point.x, point.z);
      if (!inCorridor && !block) continue;
      if (heightsAt(surfaceGrid, point.x, point.z).length === 0) {
        holes.push(`${point.x.toFixed(2)}, ${point.z.toFixed(2)}`);
      } else {
        covered += 1;
      }
    }
    expect(covered).toBeGreaterThan(1500);
    expect(holes.slice(0, 8).join(' | ')).toBe('');
  });

  it('never draws the same ground twice', () => {
    // A point can legitimately land on the shared edge of two adjacent cells,
    // so the invariant is not "one triangle" but "one height".
    let worstSpread = 0;
    for (const point of samplePoints(6000)) {
      if (nearKerbLine(point.x, point.z)) continue;
      const heights = heightsAt(surfaceGrid, point.x, point.z);
      if (heights.length < 2) continue;
      worstSpread = Math.max(worstSpread, Math.max(...heights) - Math.min(...heights));
    }
    expect(worstSpread).toBeLessThan(0.02);

    // And an areal check, which catches systematic double-drawing that point
    // sampling would miss: the emitted surface area has to match the ground
    // the city actually covers, to within the dropped-kerb aprons.
    let emitted = 0;
    for (const t of groundSink.triangles) {
      if (!SURFACE_KEYS.has(t.key) || t.up <= 0.9) continue;
      emitted +=
        Math.abs((t.bx - t.ax) * (t.cz - t.az) - (t.cx - t.ax) * (t.bz - t.az)) * 0.5;
    }
    // The window covers the whole plan, not just the city: the airport's
    // landside roads are ordinary streets and `groundSink` holds their surface
    // too, so integrating over the city alone counted their triangles as
    // surplus and read as 19 per cent of double-drawing that is not there.
    // Two-metre steps, each worth 4 square metres, keeps it under a second.
    const STEP = 2;
    let expected = 0;
    for (let x = -174; x < 470; x += STEP) {
      for (let z = -166; z < 1000; z += STEP) {
        const inCorridor = plan.streets.some((street) => {
          const along = street.axis === 'x' ? z : x;
          if (along < street.from || along > street.to) return false;
          const across = Math.abs((street.axis === 'x' ? x : z) - street.position);
          return across <= corridorHalfWidth(street);
        });
        const block = ground.blockAt(x, z);
        // The airfield is a block that `buildBlockGround` deliberately skips.
        const inBlock = block !== null && block.kind !== 'airfield';
        if (inCorridor || inBlock) expected += STEP * STEP;
      }
    }
    expect(emitted / expected).toBeGreaterThan(0.97);
    expect(emitted / expected).toBeLessThan(1.06);
  });

  it('paints every marking above the asphalt it sits on', () => {
    let checked = 0;
    let worst = Infinity;
    let worstAt = '';
    for (const point of samplePoints(30000)) {
      const marks = heightsAt(markingGrid, point.x, point.z);
      if (marks.length === 0) continue;
      const road = heightsAt(asphaltGrid, point.x, point.z);
      if (road.length === 0) continue;
      const top = Math.max(...road);
      for (const mark of marks) {
        if (mark - top < worst) {
          worst = mark - top;
          worstAt = `${point.x.toFixed(1)}, ${point.z.toFixed(1)}`;
        }
      }
      checked += 1;
    }
    expect(checked, 'no markings were sampled').toBeGreaterThan(60);
    expect(worst, `closest clearance ${worst.toFixed(4)}m at ${worstAt}`).toBeGreaterThan(0.005);
  });

  it('lays block interiors on the block surface', () => {
    for (const block of plan.blocks) {
      // The airfield platform is a block only so `districtAt` has an answer out
      // there; the airport builder draws its ground, not `buildBlockGround`.
      if (block.kind === 'airfield') continue;
      const sink = new FakeSink();
      buildBlockGround(block, plan, sink);
      expect(sink.triangleCount, `${block.id} is empty`).toBeGreaterThan(0);
      const grid = indexTriangles(sink.triangles.filter((t) => t.up > 0.9));
      let checked = 0;
      for (let u = 0.07; u < 1; u += 0.11) {
        for (let v = 0.09; v < 1; v += 0.13) {
          const x = block.rect.minX + (block.rect.maxX - block.rect.minX) * u;
          const z = block.rect.minZ + (block.rect.maxZ - block.rect.minZ) * v;
          const heights = heightsAt(grid, x, z);
          expect(heights.length, `${block.id} has a hole at ${u}, ${v}`).toBeGreaterThan(0);
          const expected = ground.sample(x, z).y;
          for (const y of heights) expect(Math.abs(y - expected)).toBeLessThanOrEqual(0.05);
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(20);
    }
  });

  it('mirrors the park path rule CityGround reports underfoot', () => {
    const park = plan.blocks.find((block) => block.kind === 'park');
    expect(park).toBeDefined();
    if (!park) return;
    const sink = new FakeSink();
    buildBlockGround(park, plan, sink);
    const gravel = indexTriangles(sink.triangles.filter((t) => t.key === 'gravel'));
    const grass = indexTriangles(sink.triangles.filter((t) => t.key === 'grass'));
    let checked = 0;
    for (let u = 0.03; u < 1; u += 0.037) {
      for (let v = 0.05; v < 1; v += 0.043) {
        const x = park.rect.minX + (park.rect.maxX - park.rect.minX) * u;
        const z = park.rect.minZ + (park.rect.maxZ - park.rect.minZ) * v;
        const surface = ground.sample(x, z).surface;
        const onGravel = heightsAt(gravel, x, z).length > 0;
        const onGrass = heightsAt(grass, x, z).length > 0;
        if (!onGravel && !onGrass) continue;
        expect(onGravel, `path mismatch at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBe(
          surface === 'gravel',
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('stays inside the street triangle budget', () => {
    expect(groundSink.triangleCount).toBeLessThan(120_000);
  });

  it('contains no NaN', () => {
    expect(groundSink.finite).toBe(true);
    expect(propSink.finite).toBe(true);
  });
});

describe('street props', () => {
  it('models every prop within its triangle ceiling', () => {
    for (const prop of ALL_PROP_KEYS) {
      const count = propTriangleCount(prop);
      const ceiling = prop === 'palmTree' || prop === 'broadleafTree' ? 900 : 400;
      expect(count, `${prop} is ${count} triangles`).toBeGreaterThan(0);
      expect(count, `${prop} is ${count} triangles`).toBeLessThanOrEqual(ceiling);
    }
  });

  it('sits every prop exactly on the ground', () => {
    let worst = 0;
    let worstAt = '';
    for (const instance of propSink.instances) {
      const delta = Math.abs(instance.y - ground.sample(instance.x, instance.z).y);
      if (delta > worst) {
        worst = delta;
        worstAt = `${instance.prop} @ ${instance.x.toFixed(1)}, ${instance.z.toFixed(1)}`;
      }
    }
    expect(propSink.instances.length).toBeGreaterThan(400);
    expect(worst, `worst is ${worst.toFixed(3)}m for ${worstAt}`).toBeLessThanOrEqual(0.03);
  });

  it('never puts a prop inside a building', () => {
    const inside = propSink.instances.filter((i) => ground.isBuilt(i.x, i.z, 0.35));
    expect(inside.map((i) => `${i.prop} @ ${i.x.toFixed(1)}, ${i.z.toFixed(1)}`).join(' | ')).toBe(
      '',
    );
  });

  it('never puts a prop on a carriageway or in the water', () => {
    const bad = propSink.instances.filter((i) => {
      const sample = ground.sample(i.x, i.z);
      return sample.onRoad || sample.surface === 'water';
    });
    expect(bad.map((i) => `${i.prop} @ ${i.x.toFixed(1)}, ${i.z.toFixed(1)}`).join(' | ')).toBe('');
  });

  it('puts gutter inlets in the gutter, and only inlets there', () => {
    const drainSink = new FakeSink();
    for (const street of plan.streets) buildStreet(street, plan, drainSink);
    const drains = drainSink.instances.filter((i) => i.prop === 'drainGrate');
    expect(drains.length).toBeGreaterThan(60);
    expect(drainSink.instances.every((i) => i.prop === 'drainGrate')).toBe(true);
    for (const drain of drains) {
      const sample = ground.sample(drain.x, drain.z);
      expect(sample.onRoad, 'an inlet left the carriageway').toBe(true);
      expect(Math.abs(drain.y - sample.y)).toBeLessThanOrEqual(0.03);
      // A kerb inlet belongs against the kerb, not out in the running lane.
      const nearest = Math.min(
        ...plan.streets.map((street: Street) => {
          const along = street.axis === 'x' ? drain.z : drain.x;
          if (along < street.from || along > street.to) return Infinity;
          const across = Math.abs((street.axis === 'x' ? drain.x : drain.z) - street.position);
          return Math.abs(across - street.roadHalf);
        }),
      );
      expect(nearest, 'inlet is not in a gutter').toBeLessThan(0.4);
    }
  });

  it('stays inside the instance budget', () => {
    const drainSink = new FakeSink();
    for (const street of plan.streets) buildStreet(street, plan, drainSink);
    const total = propSink.instances.length + drainSink.instances.length;
    expect(total, `${total} instances`).toBeLessThan(2500);
  });

  it('gives every lamp a warm light at head height', () => {
    const lamps = propSink.instances.filter((i) => i.prop === 'streetLamp');
    expect(lamps.length).toBeGreaterThan(80);
    expect(propSink.lights.length).toBe(lamps.length);
    for (const light of propSink.lights) {
      expect(light.color).toBe(0xffb86b);
      expect(light.intensity).toBeCloseTo(2.2, 5);
      expect(light.distance).toBe(16);
      expect(light.priority).toBe(3);
      expect(light.y - ground.sample(light.x, light.z).y).toBeCloseTo(4.0, 5);
    }
  });

  it('collides with everything the player can walk into', () => {
    const solid = propSink.instances.filter((i) => PROP_SPECS[i.prop].collider !== null);
    expect(propSink.colliders.length).toBe(solid.length);
    for (const box of propSink.colliders) {
      expect(box.top).toBeGreaterThan(box.bottom);
      expect(box.maxX).toBeGreaterThan(box.minX);
      expect(box.maxZ).toBeGreaterThan(box.minZ);
      expect(box.solid).toBe(true);
      // No collider may be wider than the widest prop that owns one.
      expect(box.maxX - box.minX).toBeLessThan(3.0);
      expect(box.maxZ - box.minZ).toBeLessThan(3.0);
    }
  });

  it('strings catenary cables between the poles', () => {
    const poles = propSink.instances.filter((i) => i.prop === 'utilityPole');
    expect(poles.length).toBeGreaterThan(12);
    const cables = propSink.triangles.filter((t) => t.key === 'metalDark');
    expect(cables.length).toBeGreaterThan(100);
    // A cable sags: its lowest point is below both of its ends.
    const lowest = Math.min(...cables.map((t) => Math.min(t.ay, t.by, t.cy)));
    const highest = Math.max(...cables.map((t) => Math.max(t.ay, t.by, t.cy)));
    expect(highest - lowest).toBeGreaterThan(0.4);
  });

  it('places the whole kit, not just the easy half', () => {
    const used = new Set(propSink.instances.map((i) => i.prop));
    for (const expected of [
      'streetLamp',
      'bollard',
      'bench',
      'litterBin',
      'hydrant',
      'utilityPole',
      'trafficSign',
      'planter',
      'palmTree',
      'broadleafTree',
      'shrub',
      'crate',
      'dumpster',
      'cafeTable',
      'cafeChair',
      'newsBox',
      'mooringBollard',
    ] as const) {
      expect(used.has(expected), `${expected} was never placed`).toBe(true);
    }
  });

  it('is deterministic', () => {
    const again = new FakeSink();
    scatterStreetProps(plan, again);
    expect(again.instances.length).toBe(propSink.instances.length);
    expect(again.colliders.length).toBe(propSink.colliders.length);
    expect(again.lights.length).toBe(propSink.lights.length);
    expect(again.instances[0]).toEqual(propSink.instances[0]);
    expect(again.instances[again.instances.length - 1]).toEqual(
      propSink.instances[propSink.instances.length - 1],
    );

    const groundAgain = new FakeSink();
    buildGround(groundAgain);
    expect(groundAgain.triangleCount).toBe(groundSink.triangleCount);
  });
});
