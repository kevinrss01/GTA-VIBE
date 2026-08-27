/**
 * The generated fleet: the assertions that would catch a car the wrong size,
 * the wrong way round, or floating above the road.
 *
 * Two layers. The first drives the fitting arithmetic with synthetic point
 * clouds, so the rules - length exact, width and height allowed to miss rather
 * than distort, mirrors and aerials ignored - are pinned without a file. The
 * second runs the same code over every asset actually shipped in
 * `public/models/vehicles`, which is the only way to know that a re-generated
 * model still lands on its wheels inside its own collision box.
 *
 * All of it runs headless: `tools/glbMesh` reads the vertices out of the GLB
 * directly, so no renderer, no GPU and no network are involved.
 */

import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { readGlbMesh } from '../tools/glbMesh';
import {
  MAX_SCALE_RATIO,
  detectAndCutWheels,
  fitBody,
  fitWheel,
  measureBody,
  measureWheel,
  transformPositions,
} from '../src/traffic/VehicleModelFit';
import { BufferAttribute, BufferGeometry, MeshStandardMaterial } from 'three';

import { BODY_FOR_KIND, VEHICLE_BODY_ASSETS, VehicleModelSet } from '../src/traffic/VehicleModels';
import { ALL_VEHICLE_KINDS, VEHICLE_BLUEPRINTS } from '../src/traffic/VehicleCatalogue';

const PUBLIC = 'public/';

/** A closed box of points, dense enough for the percentile measurements. */
function boxCloud(
  halfWidth: number,
  height: number,
  halfLength: number,
  steps = 12,
): number[] {
  const points: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; j <= steps; j += 1) {
      const u = -1 + (2 * i) / steps;
      const v = j / steps;
      // Four walls plus a lid, which is enough surface for the sampling.
      points.push(halfWidth, v * height, u * halfLength);
      points.push(-halfWidth, v * height, u * halfLength);
      points.push(u * halfWidth, v * height, halfLength);
      points.push(u * halfWidth, v * height, -halfLength);
      points.push(u * halfWidth, height, v * halfLength - halfLength / 2);
    }
  }
  return points;
}

describe('generated model fitting', () => {
  it('ignores wing mirrors when measuring the body width', () => {
    const points = boxCloud(0.9, 1.5, 2.2);
    // Two mirrors above the belt line, well outside the body.
    for (let i = 0; i < 24; i += 1) {
      points.push(1.25, 1.15, 0.4 + i * 0.01, -1.25, 1.15, 0.4 + i * 0.01);
    }
    const measured = measureBody(points);
    expect(measured.widthWithMirrors).toBeCloseTo(2.5, 2);
    expect(measured.width).toBeCloseTo(1.8, 1);
  });

  it('ignores a roof aerial when measuring the height', () => {
    const points = boxCloud(0.9, 1.5, 2.2, 24);
    for (let i = 0; i < 10; i += 1) points.push(0, 1.5 + i * 0.04, 0.2);
    const measured = measureBody(points);
    expect(measured.heightWithAerial).toBeGreaterThan(1.85);
    expect(measured.height).toBeCloseTo(1.5, 1);
  });

  it('lands the model on the road, centred, with the nose at -Z', () => {
    const points = boxCloud(0.9, 1.5, 2.2);
    const measured = measureBody(points);
    const fit = fitBody(measured, { length: 4.4, width: 1.8, height: 1.5 }, false);
    const moved = transformPositions(points, fit.matrix);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < moved.length; i += 3) {
      minX = Math.min(minX, moved[i] as number);
      maxX = Math.max(maxX, moved[i] as number);
      minY = Math.min(minY, moved[i + 1] as number);
      maxY = Math.max(maxY, moved[i + 1] as number);
      minZ = Math.min(minZ, moved[i + 2] as number);
      maxZ = Math.max(maxZ, moved[i + 2] as number);
    }
    expect(minY).toBeCloseTo(0, 5);
    expect(maxY).toBeCloseTo(1.5, 5);
    expect(minX + maxX).toBeCloseTo(0, 5);
    expect(minZ).toBeCloseTo(-2.2, 5);
    expect(maxZ).toBeCloseTo(2.2, 5);
    expect(fit.metres.length).toBeCloseTo(4.4, 5);
  });

  it('turns a model whose nose points the other way', () => {
    // A wedge: the tall end is at +Z, so with the nose declared at +Z it must
    // finish at -Z.
    const points: number[] = [];
    for (let i = 0; i <= 20; i += 1) {
      const t = i / 20;
      for (const side of [-0.9, 0.9]) points.push(side, 0.4 + t * 1.1, -2.2 + t * 4.4, side, 0, -2.2 + t * 4.4);
    }
    const measured = measureBody(points);
    const fit = fitBody(measured, { length: 4.4, width: 1.8, height: 1.5 }, true);
    const moved = transformPositions(points, fit.matrix);
    let tallestZ = 0;
    let tallest = -Infinity;
    for (let i = 0; i < moved.length; i += 3) {
      if ((moved[i + 1] as number) > tallest) {
        tallest = moved[i + 1] as number;
        tallestZ = moved[i + 2] as number;
      }
    }
    expect(tallestZ).toBeLessThan(0);
  });

  it('misses the target rather than distorting a model with the wrong aspect', () => {
    // A model twice as wide and half as tall as the box it must fill.
    const points = boxCloud(1.8, 0.7, 2.2);
    const measured = measureBody(points);
    const fit = fitBody(measured, { length: 4.4, width: 1.8, height: 1.5 }, false);
    expect(fit.metres.length).toBeCloseTo(4.4, 5);
    const lengthScale = 4.4 / measured.length;
    expect(fit.scale[0] as number).toBeCloseTo(lengthScale / MAX_SCALE_RATIO, 5);
    expect(fit.scale[1] as number).toBeCloseTo(lengthScale * MAX_SCALE_RATIO, 5);
  });

  it('normalises a wheel to unit radius and unit half width on X', () => {
    const points: number[] = [];
    for (let i = 0; i < 64; i += 1) {
      const a = (i / 64) * Math.PI * 2;
      for (const x of [-0.11, 0.11]) points.push(x, 0.35 * Math.sin(a), 0.35 * Math.cos(a));
    }
    const measured = measureWheel(points);
    expect(measured.axleAxis).toBe(0);
    const fit = fitWheel(measured, true);
    const moved = transformPositions(points, fit.matrix);
    let maxX = 0;
    let maxR = 0;
    for (let i = 0; i < moved.length; i += 3) {
      maxX = Math.max(maxX, Math.abs(moved[i] as number));
      maxR = Math.max(maxR, Math.hypot(moved[i + 1] as number, moved[i + 2] as number));
    }
    expect(maxX).toBeCloseTo(1, 4);
    expect(maxR).toBeCloseTo(1, 4);
  });

  it('lifts a model that arrived without wheels onto its ride height', () => {
    const points = boxCloud(0.9, 1.5, 2.2);
    const detection = detectAndCutWheels(points, indicesFor(points.length / 3), {
      halfWidth: 0.9,
      length: 4.4,
      wheelRadius: 0.33,
      wheelWidth: 0.22,
      frontAxleZ: -1.4,
      rearAxleZ: 1.2,
      track: 1.55,
      rideHeight: 0.16,
    });
    expect(detection.cut).toBe(false);
    expect(detection.lift).toBeCloseTo(0.16, 5);
    expect(detection.removed).toBe(0);
  });
});

/** A trivial index buffer, one triangle per three vertices. */
function indicesFor(vertexCount: number): Uint32Array {
  const usable = vertexCount - (vertexCount % 3);
  return Uint32Array.from({ length: usable }, (_, i) => i);
}

describe('shipped vehicle assets', () => {
  const files = [
    ...Object.values(VEHICLE_BODY_ASSETS).map((asset) => asset.path),
    'models/vehicles/wheel.glb',
  ];

  it('ships every asset the loader asks for', () => {
    for (const path of files) {
      expect(existsSync(PUBLIC + path), path).toBe(true);
    }
  });

  it('keeps every asset inside its download and material budget', () => {
    for (const path of files) {
      const file = PUBLIC + path;
      const mesh = readGlbMesh(file);
      const bytes = statSync(file).size;
      expect(bytes, `${path} bytes`).toBeLessThan(800 * 1024);
      expect(mesh.meshes, `${path} meshes`).toBe(1);
      expect(mesh.materials, `${path} materials`).toBe(1);
      expect(mesh.textures, `${path} textures`).toBe(3);
      expect(mesh.animations, `${path} animations`).toBe(0);
      expect(mesh.skins, `${path} skins`).toBe(0);
      expect(mesh.triangles, `${path} triangles`).toBeGreaterThan(400);
      expect(mesh.triangles, `${path} triangles`).toBeLessThan(3100);
      expect(mesh.uvs, `${path} uvs`).not.toBeNull();
      for (const value of mesh.positions) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('fits every kind into its own collision box, sitting on the road', () => {
    for (const kind of ALL_VEHICLE_KINDS) {
      const bp = VEHICLE_BLUEPRINTS[kind];
      const asset = VEHICLE_BODY_ASSETS[BODY_FOR_KIND[kind]];
      const mesh = readGlbMesh(PUBLIC + asset.path);
      const measured = measureBody(mesh.positions);
      const fit = fitBody(
        measured,
        { length: bp.length, width: bp.width, height: bp.height },
        asset.noseTowardsMax,
      );

      // Length is exact; width and height are allowed to miss rather than
      // squash the model. Anything past this reads as a distorted car.
      expect(fit.metres.length, `${kind} length`).toBeCloseTo(bp.length, 5);
      expect(fit.widthRatio, `${kind} width`).toBeGreaterThan(0.9);
      expect(fit.widthRatio, `${kind} width`).toBeLessThan(1.1);
      expect(fit.heightRatio, `${kind} height`).toBeGreaterThan(0.88);
      expect(fit.heightRatio, `${kind} height`).toBeLessThan(1.15);

      const moved = transformPositions(mesh.positions, fit.matrix);
      const detection = detectAndCutWheels(moved, mesh.index, {
        halfWidth: fit.metres.width * 0.5,
        length: bp.length,
        wheelRadius: bp.wheelRadius,
        wheelWidth: bp.wheelWidth,
        frontAxleZ: -bp.chassis.frontAxle,
        rearAxleZ: bp.chassis.wheelbase - bp.chassis.frontAxle,
        track: bp.chassis.track,
        rideHeight: bp.rideHeight,
      });

      // The wheels have to go, and the body must not be gutted with them.
      const remaining = detection.index.length / 3;
      expect(remaining, `${kind} remaining triangles`).toBeGreaterThan(1200);
      // The generated alloys are detailed: on the lowest-poly body the four
      // wheels are nearly half the mesh. Past this the cut is eating bodywork.
      expect(detection.removed / mesh.triangles, `${kind} removed`).toBeLessThan(0.5);

      // Where the wheels get mounted must be inside the vehicle, and the two
      // axles must be far enough apart to be a wheelbase.
      const { frontZ, rearZ, halfTrack } = detection.mount;
      expect(frontZ, `${kind} front axle`).toBeLessThan(0);
      expect(rearZ, `${kind} rear axle`).toBeGreaterThan(0);
      expect(rearZ - frontZ, `${kind} wheelbase`).toBeGreaterThan(bp.wheelbase * 0.7);
      expect(rearZ - frontZ, `${kind} wheelbase`).toBeLessThan(bp.length * 0.95);
      expect(halfTrack, `${kind} track`).toBeGreaterThan(bp.width * 0.3);
      expect(halfTrack, `${kind} track`).toBeLessThan(bp.width * 0.55);

      /*
       * The renderer draws each wheel at the radius its own arch was cut at,
       * so that radius has to be a plausible wheel for this vehicle and not
       * merely a number the detector produced. The estimator reads the chord
       * of the tyre where it grounds and under-reads a little; anything worse
       * than a fifth off would be a visibly wrong-sized wheel.
       */
      expect(detection.mount.radius, `${kind} arch radius`).toBeGreaterThan(bp.wheelRadius * 0.8);
      expect(detection.mount.radius, `${kind} arch radius`).toBeLessThan(bp.wheelRadius * 1.25);

      // Grounding: after the cut and the lift, the body hangs above the road
      // and its roof lands where the blueprint says it should.
      const kept = new Set<number>();
      for (const value of detection.index) kept.add(value);
      // The arch clip splits triangles rather than dropping them whole, so
      // the index can reach past the model's own vertices into the ones it
      // appended. Reading only `moved` would return NaN for every one.
      const base = Math.floor(moved.length / 3);
      const extra = detection.extra;
      const yOf = (vertex: number): number =>
        vertex < base
          ? (moved[vertex * 3 + 1] as number)
          : (extra?.position[(vertex - base) * 3 + 1] as number);
      let minY = Infinity;
      let maxY = -Infinity;
      for (const vertex of kept) {
        const y = yOf(vertex) + detection.lift;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      // A truck with a three-axle model keeps the bogie pair the renderer has
      // no wheel slot for, and that pair still touches the road.
      expect(detection.leftInPlace, `${kind} spare tyres`).toBeLessThanOrEqual(1);
      if (detection.leftInPlace === 0) {
        expect(minY, `${kind} lowest point`).toBeGreaterThan(0.02);
      }
      expect(minY, `${kind} lowest point`).toBeLessThan(bp.wheelRadius * 1.25);
      expect(maxY, `${kind} roof`).toBeGreaterThan(bp.height * 0.85);
      expect(maxY, `${kind} roof`).toBeLessThan(bp.height * 1.2);
    }
  });

  it('normalises the shipped wheel to the shape the renderer scales', () => {
    const mesh = readGlbMesh(`${PUBLIC}models/vehicles/wheel.glb`);
    const measured = measureWheel(mesh.positions);
    const fit = fitWheel(measured, true);
    const moved = transformPositions(mesh.positions, fit.matrix);
    let maxX = 0;
    let maxR = 0;
    for (let i = 0; i < moved.length; i += 3) {
      maxX = Math.max(maxX, Math.abs(moved[i] as number));
      maxR = Math.max(maxR, Math.hypot(moved[i + 1] as number, moved[i + 2] as number));
    }
    expect(maxX).toBeLessThanOrEqual(1.001);
    // The generated tyre is not a perfect circle; a couple of per cent of
    // out-of-round is invisible once the renderer scales it to a road wheel.
    expect(maxR).toBeGreaterThan(0.96);
    expect(maxR).toBeLessThan(1.04);
  });
});
/**
 * You cannot see inside a car.
 *
 * `detectAndCutWheels` opens a disc in each flank so the renderer can mount a
 * wheel that turns, and a generated body is a single surface with nothing
 * behind it - so before the wheel wells were built, up to 14 per cent of the
 * sight lines a solid body blocked went straight through the shell and out the
 * other side. From beside a car it read as a black hole ringing every wheel.
 *
 * The test is stated the way the fault was: take the fitted body with its
 * wheels still ON - the solid the cut started from - and fire rays at it. Every
 * ray that solid stopped must still be stopped by the shell the game draws,
 * counting the four wheels the renderer puts back. Rays below the underbody are
 * excluded, because daylight under a car is what a car looks like.
 */
describe('you cannot see inside a car', () => {
  /** Moller-Trumbore, either winding: this asks whether a surface is there. */
  function rayHitsTriangle(
    o: readonly number[],
    d: readonly number[],
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
  ): boolean {
    const e1 = [(b[0] ?? 0) - (a[0] ?? 0), (b[1] ?? 0) - (a[1] ?? 0), (b[2] ?? 0) - (a[2] ?? 0)];
    const e2 = [(c[0] ?? 0) - (a[0] ?? 0), (c[1] ?? 0) - (a[1] ?? 0), (c[2] ?? 0) - (a[2] ?? 0)];
    const p = [
      (d[1] ?? 0) * (e2[2] ?? 0) - (d[2] ?? 0) * (e2[1] ?? 0),
      (d[2] ?? 0) * (e2[0] ?? 0) - (d[0] ?? 0) * (e2[2] ?? 0),
      (d[0] ?? 0) * (e2[1] ?? 0) - (d[1] ?? 0) * (e2[0] ?? 0),
    ];
    const det = (e1[0] ?? 0) * (p[0] ?? 0) + (e1[1] ?? 0) * (p[1] ?? 0) + (e1[2] ?? 0) * (p[2] ?? 0);
    if (Math.abs(det) < 1e-10) return false;
    const inv = 1 / det;
    const t0 = [(o[0] ?? 0) - (a[0] ?? 0), (o[1] ?? 0) - (a[1] ?? 0), (o[2] ?? 0) - (a[2] ?? 0)];
    const u = ((t0[0] ?? 0) * (p[0] ?? 0) + (t0[1] ?? 0) * (p[1] ?? 0) + (t0[2] ?? 0) * (p[2] ?? 0)) * inv;
    if (u < 0 || u > 1) return false;
    const q = [
      (t0[1] ?? 0) * (e1[2] ?? 0) - (t0[2] ?? 0) * (e1[1] ?? 0),
      (t0[2] ?? 0) * (e1[0] ?? 0) - (t0[0] ?? 0) * (e1[2] ?? 0),
      (t0[0] ?? 0) * (e1[1] ?? 0) - (t0[1] ?? 0) * (e1[0] ?? 0),
    ];
    const v = ((d[0] ?? 0) * (q[0] ?? 0) + (d[1] ?? 0) * (q[1] ?? 0) + (d[2] ?? 0) * (q[2] ?? 0)) * inv;
    if (v < 0 || u + v > 1) return false;
    return ((e2[0] ?? 0) * (q[0] ?? 0) + (e2[1] ?? 0) * (q[1] ?? 0) + (e2[2] ?? 0) * (q[2] ?? 0)) * inv > 1e-5;
  }

  function blocked(
    pos: ArrayLike<number>,
    idx: ArrayLike<number>,
    o: readonly number[],
    d: readonly number[],
  ): boolean {
    const at = (v: number): number[] => [pos[v * 3] ?? 0, pos[v * 3 + 1] ?? 0, pos[v * 3 + 2] ?? 0];
    for (let t = 0; t < idx.length / 3; t += 1) {
      if (
        rayHitsTriangle(o, d, at(idx[t * 3] ?? 0), at(idx[t * 3 + 1] ?? 0), at(idx[t * 3 + 2] ?? 0))
      ) {
        return true;
      }
    }
    return false;
  }

  /** The four road wheels the renderer instances back into the arches. */
  function wheelBlocks(
    o: readonly number[],
    d: readonly number[],
    mount: { frontZ: number; rearZ: number; halfTrack: number },
    radius: number,
    halfWidth: number,
  ): boolean {
    for (const side of [-1, 1]) {
      for (const z of [-mount.frontZ, mount.rearZ]) {
        const cx = side * mount.halfTrack;
        const oy = (o[1] ?? 0) - radius;
        const oz = (o[2] ?? 0) - z;
        const dy = d[1] ?? 0;
        const dz = d[2] ?? 0;
        const dx = d[0] ?? 0;
        const a = dy * dy + dz * dz;
        const c = oy * oy + oz * oz - radius * radius;
        if (a < 1e-9) {
          // Parallel to the axle: in through one face and out through the other.
          if (c >= 0 || Math.abs(dx) < 1e-9) continue;
          const t0 = (cx - halfWidth - (o[0] ?? 0)) / dx;
          const t1 = (cx + halfWidth - (o[0] ?? 0)) / dx;
          if (Math.max(t0, t1) > 1e-5) return true;
          continue;
        }
        const b = 2 * (oy * dy + oz * dz);
        const disc = b * b - 4 * a * c;
        if (disc < 0) continue;
        const root = Math.sqrt(disc);
        for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
          if (t < 1e-5) continue;
          if (Math.abs((o[0] ?? 0) + dx * t - cx) <= halfWidth) return true;
        }
      }
    }
    return false;
  }

  it('leaves no sight line through any shipped shell', () => {
    for (const kind of ALL_VEHICLE_KINDS) {
      const bodyId = BODY_FOR_KIND[kind];
      const asset = VEHICLE_BODY_ASSETS[bodyId];
      const mesh = readGlbMesh(`${PUBLIC}${asset.path}`);
      const bp = VEHICLE_BLUEPRINTS[kind];
      const measurement = measureBody(mesh.positions);
      const fit = fitBody(
        measurement,
        { length: bp.length, width: bp.width, height: bp.height },
        asset.noseTowardsMax,
      );
      const solid = transformPositions(mesh.positions, fit.matrix);
      const cut = detectAndCutWheels(solid, mesh.index, {
        halfWidth: fit.metres.width * 0.5,
        length: bp.length,
        wheelRadius: bp.wheelRadius,
        wheelWidth: bp.wheelWidth,
        frontAxleZ: -bp.chassis.frontAxle,
        rearAxleZ: bp.chassis.wheelbase - bp.chassis.frontAxle,
        track: bp.chassis.track,
        rideHeight: bp.rideHeight,
      });

      // The shell the game actually draws, built through the real loader path.
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
      if (mesh.uvs) geometry.setAttribute('uv', new BufferAttribute(mesh.uvs, 2));
      geometry.setIndex(new BufferAttribute(mesh.index, 1));
      const set = new VehicleModelSet(false);
      set.addBody(
        bodyId,
        {
          geometry,
          material: new MeshStandardMaterial(),
          measurement,
          triangles: mesh.triangles,
        },
        { id: bodyId, url: asset.path, triangles: mesh.triangles, measurement },
      );
      const shell = set.buildShell(kind);
      expect(shell, kind).not.toBeNull();
      if (!shell) continue;
      const shellPos = shell.geometry.getAttribute('position').array;
      const shellIndex = shell.geometry.getIndex();
      expect(shellIndex, kind).not.toBeNull();
      if (!shellIndex) continue;

      let lowest = Infinity;
      for (let i = 0; i < cut.index.length; i += 1) {
        const y = solid[(cut.index[i] ?? 0) * 3 + 1] ?? 0;
        if (y < lowest) lowest = y;
      }
      const yFrom = lowest + 0.05;

      const rays: [number[], number[]][] = [];
      for (let z = -bp.length * 0.48; z <= bp.length * 0.48; z += bp.length * 0.03) {
        for (let y = yFrom; y <= 0.9; y += 0.05) rays.push([[-6, y, z], [1, 0, 0]]);
      }
      for (let x = -bp.width * 0.48; x <= bp.width * 0.48; x += bp.width * 0.06) {
        for (let y = yFrom; y <= 0.9; y += 0.05) rays.push([[x, y, -9], [0, 0, 1]]);
      }
      // The low three-quarter view the fault was reported from.
      const diag = Math.hypot(1, 0.55);
      for (let z = -bp.length * 0.48; z <= bp.length * 0.48; z += bp.length * 0.05) {
        for (let y = yFrom; y <= 0.7; y += 0.06) {
          rays.push([[-6, y, z - 3.3], [1 / diag, 0, 0.55 / diag]]);
        }
      }

      let tested = 0;
      let through = 0;
      for (const [o, d] of rays) {
        if (!blocked(solid, mesh.index, o, d)) continue;
        // The renderer draws each wheel at the radius its own arch was cut
        // at, not at the blueprint's, so the ray test has to use the same one.
        const drawnRadius = cut.mount.radius > 0.05 ? cut.mount.radius : bp.wheelRadius;
        if (wheelBlocks(o, d, cut.mount, drawnRadius, bp.wheelWidth * 0.5)) continue;
        tested += 1;
        if (!blocked(shellPos, shellIndex.array, o, d)) through += 1;
      }
      expect(tested, `${kind} had no sight lines to test`).toBeGreaterThan(150);
      // Measured: 1.4 to 14.3 per cent of these went straight through before
      // the wells were built, and at most one ray does now.
      expect(
        through / tested,
        `${kind}: ${through} of ${tested} sight lines pass through the body`,
      ).toBeLessThan(0.005);
    }
  }, 120000);
});
