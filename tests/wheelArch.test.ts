/**
 * The hole the wheel goes through.
 *
 * THE DEFECT. `detectAndCutWheels` used to drop a whole triangle whenever its
 * CENTROID fell inside the tyre. On a generated body of about fifteen hundred
 * triangles a triangle is 10-20 cm across, so the hole that left was up to a
 * triangle's width wider than the tyre in every direction - measured on the
 * shipped fleet, a 33 cm wheel in a 49 cm hole. Something has to be behind an
 * opening that size or you can see through the car, and what was behind it was
 * the dark wheel-well liner: a 16 cm band of flat grey ringing every wheel,
 * reported as "some 3D element around the wheels, hidden, but really visible".
 *
 * The cut clips the triangles now. These are pure arithmetic over synthetic
 * geometry, so they say exactly what the clip guarantees without needing an
 * asset, a renderer or a screenshot:
 *
 *   1. Nothing survives inside the tyre.  (the wheel has somewhere to go)
 *   2. Nothing is removed outside it.     (the hole is not wider than the wheel)
 *   3. The reported arch radius is the tyre's, so the liner sized to it is
 *      hidden by the wheel rather than ringing it.
 */

import { describe, expect, it } from 'vitest';

import { detectAndCutWheels, type WheelCutParams } from '../src/traffic/VehicleModelFit';

/** A saloon's numbers, so the detector's own thresholds are the real ones. */
const BLUEPRINT = {
  length: 4.6,
  width: 1.82,
  wheelRadius: 0.33,
  wheelWidth: 0.22,
  frontAxleZ: -1.35,
  rearAxleZ: 1.35,
  track: 1.56,
  rideHeight: 0.16,
};

const PARAMS: WheelCutParams = {
  halfWidth: BLUEPRINT.width * 0.5,
  length: BLUEPRINT.length,
  wheelRadius: BLUEPRINT.wheelRadius,
  wheelWidth: BLUEPRINT.wheelWidth,
  frontAxleZ: BLUEPRINT.frontAxleZ,
  rearAxleZ: BLUEPRINT.rearAxleZ,
  track: BLUEPRINT.track,
  rideHeight: BLUEPRINT.rideHeight,
};

interface Built {
  readonly positions: number[];
  readonly index: number[];
  /** Index length before the tyres were added, so a test can drop them. */
  readonly bodyIndexLength: number;
}

/**
 * A crude car: two flanks of large quads, plus a disc of tyre at each corner
 * so the detector finds something to cut around.
 *
 * The flank quads are deliberately COARSE - 0.4 m across, twice the size of a
 * generated body's triangles - because that is the case the old centroid test
 * failed hardest at, and a clip that is right for a 0.4 m triangle is right for
 * a 0.15 m one.
 */
function buildCar(): Built {
  const positions: number[] = [];
  const index: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  const quad = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
  ): void => {
    const ia = push(...a);
    const ib = push(...b);
    const ic = push(...c);
    const id = push(...d);
    index.push(ia, ib, ic, ia, ic, id);
  };

  const STEP = 0.4;
  // The flank starts at the sill, not at the road: the wheels have to be the
  // only thing that reaches the ground or the detector reads the whole car as
  // one enormous tyre.
  const SILL = 0.4;
  for (const side of [-1, 1]) {
    const x = side * BLUEPRINT.width * 0.5;
    for (let z = -BLUEPRINT.length / 2; z < BLUEPRINT.length / 2 - 1e-6; z += STEP) {
      for (let y = SILL; y < SILL + 1.2 - 1e-6; y += STEP) {
        quad([x, y, z], [x, y, z + STEP], [x, y + STEP, z + STEP], [x, y + STEP, z]);
      }
    }
  }

  /*
   * Four tyres, just outboard of the flank so the detector's ground-contact
   * scan finds them.
   *
   * Built as a TREAD BAND plus a hub rather than as one fan from the centre,
   * because the scan reads triangle CENTROIDS: a fan's centroids all sit a
   * third of a radius up from the rim, so a fan tyre never appears to touch
   * the road and nothing is detected at all. A band's do.
   */
  const bodyIndexLength = index.length;
  const R = BLUEPRINT.wheelRadius;
  for (const z of [BLUEPRINT.frontAxleZ, BLUEPRINT.rearAxleZ]) {
    for (const side of [-1, 1]) {
      const x = side * (BLUEPRINT.track * 0.5);
      const at = (angle: number, radius: number): number =>
        push(x, R + Math.sin(angle) * radius, z + Math.cos(angle) * radius);
      const hub = push(x, R, z);
      for (let i = 0; i < 24; i += 1) {
        const a0 = (i / 24) * Math.PI * 2;
        const a1 = ((i + 1) / 24) * Math.PI * 2;
        const outer0 = at(a0, R);
        const outer1 = at(a1, R);
        const inner0 = at(a0, R * 0.7);
        const inner1 = at(a1, R * 0.7);
        index.push(inner0, outer0, outer1, inner0, outer1, inner1);
        index.push(hub, inner0, inner1);
      }
    }
  }

  return { positions, index, bodyIndexLength };
}

const car = buildCar();
const detection = detectAndCutWheels(car.positions, car.index, PARAMS);

/** Position of a vertex, from the model's own array or the clip's appended one. */
function vertexAt(v: number): [number, number, number] {
  const base = car.positions.length / 3;
  if (v < base) {
    return [
      car.positions[v * 3] as number,
      car.positions[v * 3 + 1] as number,
      car.positions[v * 3 + 2] as number,
    ];
  }
  const extra = detection.extra;
  if (!extra) throw new Error(`vertex ${v} is past the model but nothing was appended`);
  const i = v - base;
  return [
    extra.position[i * 3] as number,
    extra.position[i * 3 + 1] as number,
    extra.position[i * 3 + 2] as number,
  ];
}

describe('the wheel arch cut', () => {
  it('finds both axles and cuts around them', () => {
    expect(detection.cut).toBe(true);
    expect(detection.arches).toHaveLength(2);
    expect(detection.removed).toBeGreaterThan(0);
  });

  /*
   * THE PROPERTY THAT KILLED THE DARK RING: the opening is never wider than
   * the tyre the renderer drops into it.
   *
   * The lower bound is loose on purpose. The detector reads the chord of the
   * tyre where it meets the road and under-reads, by a little on a real mesh
   * (measured on the shipped fleet in `vehicleModels.test.ts`, within a fifth)
   * and by more on this fixture's coarse 24-sector tread band. What must never
   * happen is the other direction, and that is what the upper bound pins.
   */
  it('reports the arch at the tyre it cut around, never wider', () => {
    for (const arch of detection.arches) {
      expect(arch.radius).toBeGreaterThan(BLUEPRINT.wheelRadius * 0.7);
      expect(arch.radius).toBeLessThanOrEqual(BLUEPRINT.wheelRadius);
      // The arch is cut about the axle, so its centre is one radius up.
      expect(arch.centreY).toBeCloseTo(arch.radius, 6);
      // The wheel the renderer draws is scaled to this same number, which is
      // the whole reason it fills the opening instead of rattling around in it.
      expect(detection.mount.radius).toBeCloseTo(arch.radius, 6);
    }
  });

  it('leaves no bodywork standing inside a wheel', () => {
    const survivors: string[] = [];
    for (let t = 0; t < detection.index.length / 3; t += 1) {
      const points = [0, 1, 2].map((k) => vertexAt(detection.index[t * 3 + k] as number));
      for (const arch of detection.arches) {
        // A triangle whose every corner is well inside the tyre would be
        // drawn through the wheel that goes there.
        const inside = points.every(([x, y, z]) => {
          if (Math.abs(x) < BLUEPRINT.track * 0.5 - BLUEPRINT.wheelWidth) return false;
          const dy = y - arch.centreY;
          const dz = z - arch.z;
          return Math.hypot(dy, dz) < arch.radius * 0.9;
        });
        if (inside) survivors.push(`triangle ${t} inside arch at z=${arch.z.toFixed(2)}`);
      }
    }
    expect(survivors).toEqual([]);
  });

  it('leaves the bodywork outside a wheel alone', () => {
    // Every flank vertex a comfortable margin outside both arches must still
    // be reachable from the index. This is the property the old cut broke: it
    // took bodywork out to a triangle's width past the tyre.
    const reachable = new Set<number>(Array.from(detection.index));
    const missing: string[] = [];
    const base = car.positions.length / 3;
    for (let v = 0; v < base; v += 1) {
      const [x, y, z] = vertexAt(v);
      if (Math.abs(Math.abs(x) - BLUEPRINT.width * 0.5) > 1e-6) continue;
      if (y < 0.5) continue;
      let near = false;
      for (const arch of detection.arches) {
        if (Math.hypot(y - arch.centreY, z - arch.z) < arch.radius + 0.45) near = true;
      }
      if (near || reachable.has(v)) continue;
      missing.push(`(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);
    }
    expect(missing, `bodywork deleted away from any arch: ${missing.join(' ')}`).toEqual([]);
  });

  it('appends the vertices its cuts needed, and indexes them in range', () => {
    const extra = detection.extra;
    expect(extra).not.toBeNull();
    if (!extra) return;
    expect(extra.count).toBeGreaterThan(0);
    expect(extra.position.length).toBe(extra.count * 3);
    const total = car.positions.length / 3 + extra.count;
    for (const v of detection.index) expect(v).toBeLessThan(total);
  });

  it('does not cut a body that has no wheels in it', () => {
    // The flanks alone: nothing reaches the road, so nothing is a tyre and the
    // model is lifted onto the wheels the renderer will draw instead.
    const flanksOnly = buildCar();
    flanksOnly.index.length = flanksOnly.bodyIndexLength;
    const bare = detectAndCutWheels(flanksOnly.positions, flanksOnly.index, PARAMS);
    expect(bare.cut).toBe(false);
    expect(bare.removed).toBe(0);
    expect(bare.extra).toBeNull();
    expect(bare.lift).toBe(PARAMS.rideHeight);
  });
});
