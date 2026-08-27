/**
 * The authored fallback shells.
 *
 * THE FLEET IS NORMALLY GENERATED. `VehicleModels` loads a Tripo body per
 * silhouette and one Tripo wheel, fits them to the same blueprints used here,
 * and hands them to `TrafficRenderer`. What follows only draws when one of
 * those assets is missing or malformed, so a failed download degrades the
 * look of the traffic instead of emptying the streets - and it is what the
 * headless tests measure, because they cannot load a GLB into a GPU.
 *
 * It is also still the reference for the five surface channels: everything
 * below shows what a shell carrying paint, glazing, rubber, chrome and lit
 * lamps in ONE draw call looks like when every value is authored rather than
 * recovered from a texture.
 *
 * Turns a blueprint into a drawable shell.
 *
 * Every vehicle is one lofted lower body, one lofted greenhouse whose roof and
 * glazing are separated per vertex rather than per material, and a handful of
 * small parts - lamps, plate, mirrors, arch trims, livery strips. The result is
 * a single indexed geometry of roughly 900-1500 triangles carrying all five
 * surface channels, so the whole city's sedans are one draw call.
 *
 * Wheels are built once, separately, as a unit-radius unit-half-width shape.
 * They have to be their own instanced draw because they spin and steer, and
 * scaling them per vehicle in the instance matrix is what lets a single wheel
 * mesh serve a compact hatch and a box truck.
 *
 * WHAT A GENERATED ASSET COSTS TO USE INSTEAD. A Tripo mesh arrives as one
 * fused shell with one material and no separation between paint, glazing,
 * lamps and wheels, so all four of the things this file gets for free have to
 * be recovered: the wheels are cut out geometrically, the paint is gated on
 * the texture's own luminance, the brake lamps are found by looking for red in
 * the base colour map, and the headlamp channel is lost outright. See
 * `VehicleModels` for how, and `docs/vehicle-assets.md` for what survived.
 */

import type { BufferGeometry } from 'three';

import { clamp, lerp } from '../core/mathx';
import {
  CHANNEL_BEACON_A,
  CHANNEL_BEACON_B,
  CHANNEL_BRAKE,
  CHANNEL_HEAD,
  VehicleMeshBuilder,
  type LoftOptions,
  type Station,
  type SurfaceStyle,
} from './MeshBuilder';
import { VEHICLE_BLUEPRINTS, type VehicleBlueprint } from './VehicleCatalogue';
import type { VehicleKind } from './types';

// -- surface palette --------------------------------------------------------

const PAINT: SurfaceStyle = { albedo: 0xffffff, roughness: 0.28, metalness: 0.12, paint: true };
const PAINT_MATT: SurfaceStyle = { albedo: 0xf2f2f2, roughness: 0.45, metalness: 0.06, paint: true };
/** Opaque dark glazing. Transparent glass would cost a sorted pass per car. */
const GLASS: SurfaceStyle = { albedo: 0x11161a, roughness: 0.06, metalness: 0.08 };
const TRIM: SurfaceStyle = { albedo: 0x26282b, roughness: 0.52, metalness: 0.05 };
const TRIM_SOFT: SurfaceStyle = { albedo: 0x3c4044, roughness: 0.72 };
const RUBBER: SurfaceStyle = { albedo: 0x151617, roughness: 0.95 };
const TREAD: SurfaceStyle = { albedo: 0x101112, roughness: 0.98 };
const CHROME: SurfaceStyle = { albedo: 0xb9bec1, roughness: 0.22, metalness: 0.85 };
const RIM: SurfaceStyle = { albedo: 0xffffff, roughness: 0.3, metalness: 0.62, paint: true };
const HUB: SurfaceStyle = { albedo: 0x4a4e51, roughness: 0.45, metalness: 0.6 };
const PLATE: SurfaceStyle = { albedo: 0xe6e4da, roughness: 0.5 };
const PLATE_MARK: SurfaceStyle = { albedo: 0x1e2126, roughness: 0.6 };
const UNDERBODY: SurfaceStyle = { albedo: 0x121314, roughness: 0.96 };
const HEADLAMP: SurfaceStyle = {
  albedo: 0xcfd6d9,
  roughness: 0.1,
  metalness: 0.1,
  emissive: 0xfff0d2,
  emissiveIntensity: 2.4,
  channel: CHANNEL_HEAD,
};
const TAILLAMP: SurfaceStyle = {
  albedo: 0x5a1210,
  roughness: 0.14,
  emissive: 0xff2a0c,
  emissiveIntensity: 6.0,
  channel: CHANNEL_BRAKE,
};
const MARKER_AMBER: SurfaceStyle = { albedo: 0x8a5416, roughness: 0.2 };
const REVERSE_LAMP: SurfaceStyle = { albedo: 0xd6d6cf, roughness: 0.2 };
const BEACON_BLUE: SurfaceStyle = {
  albedo: 0x16264e,
  roughness: 0.12,
  emissive: 0x2f6cff,
  emissiveIntensity: 6.0,
  channel: CHANNEL_BEACON_A,
};
const BEACON_RED: SurfaceStyle = {
  albedo: 0x4e1620,
  roughness: 0.12,
  emissive: 0xff2440,
  emissiveIntensity: 6.0,
  channel: CHANNEL_BEACON_B,
};
/** Meridian Bay patrol livery: invented, and deliberately not any real force. */
const LIVERY_DARK: SurfaceStyle = { albedo: 0x1a2740, roughness: 0.3, metalness: 0.1 };
const LIVERY_STRIPE: SurfaceStyle = { albedo: 0xc9a24a, roughness: 0.35 };
const TAXI_BAND: SurfaceStyle = { albedo: 0x24262a, roughness: 0.4 };
const TAXI_SIGN: SurfaceStyle = {
  albedo: 0xd9b256,
  roughness: 0.36,
  emissive: 0xffc061,
  emissiveIntensity: 1.5,
};

const LOFT_SEGMENTS = 18;

// -- section helpers --------------------------------------------------------

function sectionOptions(bp: VehicleBlueprint): LoftOptions {
  return {
    fullnessTop: bp.sectionTop,
    fullnessBottom: bp.sectionBottom,
    segments: LOFT_SEGMENTS,
  };
}

/**
 * Half width of a lofted section at a given height.
 *
 * Inverts the superellipse so a decal - a sill strip, a livery flank, a window
 * trim - can be laid exactly on the curved side of the body instead of hovering
 * off it or sinking into it.
 */
function widthAtHeight(station: Station, y: number, options: LoftOptions): number {
  const centreY = (station.top + station.bottom) * 0.5;
  const halfHeight = (station.top - station.bottom) * 0.5;
  if (halfHeight <= 1e-5 || station.halfWidth <= 1e-5) return 0;
  const t = clamp((y - centreY) / halfHeight, -0.999, 0.999);
  const power = t >= 0 ? options.fullnessTop : options.fullnessBottom;
  // |sin a|^(2/p) = |t|  =>  |sin a| = |t|^(p/2)
  const sinA = Math.abs(t) ** (power / 2);
  const cosA = Math.sqrt(Math.max(0, 1 - sinA * sinA));
  return station.halfWidth * cosA ** (2 / power);
}

/** Station interpolated at an arbitrary z, so decals can be sampled densely. */
function stationAt(stations: readonly Station[], z: number): Station {
  const first = stations[0] as Station;
  const last = stations[stations.length - 1] as Station;
  if (z <= first.z) return first;
  if (z >= last.z) return last;
  for (let i = 1; i < stations.length; i += 1) {
    const b = stations[i] as Station;
    if (b.z < z) continue;
    const a = stations[i - 1] as Station;
    const t = (z - a.z) / Math.max(1e-6, b.z - a.z);
    return {
      z,
      halfWidth: lerp(a.halfWidth, b.halfWidth, t),
      bottom: lerp(a.bottom, b.bottom, t),
      top: lerp(a.top, b.top, t),
    };
  }
  return last;
}

/**
 * Lays a band of colour on the flank, following the body's curvature.
 *
 * This is how the patrol livery, the taxi band and every sill strip are made:
 * as surface-hugging quads rather than as vertex colours, because a lofted
 * section has far too few vertices down its flat sides to give a crisp edge.
 */
function sideBand(
  mesh: VehicleMeshBuilder,
  stations: readonly Station[],
  options: LoftOptions,
  from: number,
  to: number,
  yLow: number,
  yHigh: number,
  style: SurfaceStyle,
  samples = 6,
  lift = 0.008,
): void {
  for (const side of [1, -1] as const) {
    for (let i = 0; i < samples; i += 1) {
      const z0 = lerp(from, to, i / samples);
      const z1 = lerp(from, to, (i + 1) / samples);
      const s0 = stationAt(stations, z0);
      const s1 = stationAt(stations, z1);
      const l0 = widthAtHeight(s0, yLow, options) + lift;
      const h0 = widthAtHeight(s0, yHigh, options) + lift;
      const l1 = widthAtHeight(s1, yLow, options) + lift;
      const h1 = widthAtHeight(s1, yHigh, options) + lift;
      if (l0 < 0.02 || l1 < 0.02) continue;
      mesh.quad(
        [side * l0, yLow, z0],
        [side * l1, yLow, z1],
        [side * h1, yHigh, z1],
        [side * h0, yHigh, z0],
        style,
        [side, 0, 0],
      );
    }
  }
}

/**
 * Dark arch lip around a wheel, laid on the flank.
 *
 * The arc is centred on the AXLE, not on the ground: an arch drawn about y = 0
 * wraps the bottom of the tyre instead of the top of it, and the wheel then
 * reads as a dark hole in the sill rather than as a wheel in an arch.
 */
function wheelArch(
  mesh: VehicleMeshBuilder,
  stations: readonly Station[],
  options: LoftOptions,
  axleZ: number,
  radius: number,
  style: SurfaceStyle,
): void {
  const segments = 8;
  const inner = radius * 1.04;
  const outer = radius * 1.24;
  for (const side of [1, -1] as const) {
    for (let i = 0; i < segments; i += 1) {
      const a0 = Math.PI * (i / segments);
      const a1 = Math.PI * ((i + 1) / segments);
      const p = (angle: number, r: number): [number, number, number] => {
        const z = axleZ - Math.cos(angle) * r;
        const y = radius + Math.sin(angle) * r;
        const station = stationAt(stations, z);
        const clampedY = clamp(y, station.bottom + 0.01, station.top - 0.01);
        return [side * (widthAtHeight(station, clampedY, options) + 0.007), y, z];
      };
      mesh.quad(p(a0, inner), p(a1, inner), p(a1, outer), p(a0, outer), style, [side, 0, 0]);
    }
  }
}

// -- body forms -------------------------------------------------------------

/** Builds a strictly increasing station list, dropping anything out of order. */
function orderStations(raw: readonly Station[]): Station[] {
  const out: Station[] = [];
  for (const station of raw) {
    const last = out[out.length - 1];
    if (last && station.z <= last.z + 0.05) continue;
    out.push(station);
  }
  return out;
}

function lowerBody(bp: VehicleBlueprint): Station[] {
  const hl = bp.length * 0.5;
  const hw = bp.width * 0.5;
  const ride = bp.rideHeight;
  const cowlZ = bp.cabinFront - 0.22;
  const raw: Station[] = [
    { z: -hl, halfWidth: hw * bp.noseTaper, bottom: ride + 0.13, top: bp.noseY - 0.1 },
    { z: -hl + 0.14, halfWidth: hw * (bp.noseTaper * 0.4 + 0.6), bottom: ride + 0.02, top: bp.noseY },
    { z: -hl + 0.44, halfWidth: hw * 0.99, bottom: ride, top: bp.noseY + 0.03 },
    { z: cowlZ, halfWidth: hw, bottom: ride, top: bp.cowlY },
    { z: bp.cabinFront + 0.3, halfWidth: hw, bottom: ride, top: bp.beltY },
    { z: 0, halfWidth: hw, bottom: ride, top: bp.beltY + 0.01 },
    { z: bp.cabinRear - 0.3, halfWidth: hw, bottom: ride, top: bp.beltY },
    { z: bp.cabinRear + 0.35, halfWidth: hw * 0.995, bottom: ride, top: lerp(bp.beltY, bp.tailY, 0.75) },
    { z: hl - 0.3, halfWidth: hw * 0.97, bottom: ride + 0.02, top: bp.tailY },
    { z: hl, halfWidth: hw * bp.tailTaper, bottom: ride + 0.13, top: bp.tailY - 0.09 },
  ];
  return orderStations(raw);
}

/** Van and box-truck lower body: the roof line is part of the same shell. */
function tallBody(bp: VehicleBlueprint, roofY: number, tailZ: number): Station[] {
  const hl = bp.length * 0.5;
  const hw = bp.width * 0.5;
  const ride = bp.rideHeight;
  const raw: Station[] = [
    { z: -hl, halfWidth: hw * bp.noseTaper, bottom: ride + 0.12, top: bp.noseY - 0.1 },
    { z: -hl + 0.16, halfWidth: hw * (bp.noseTaper * 0.4 + 0.6), bottom: ride + 0.02, top: bp.noseY },
    { z: bp.cabinFront - 0.1, halfWidth: hw * 0.99, bottom: ride, top: bp.cowlY },
    { z: bp.cabinFront + 0.62, halfWidth: hw, bottom: ride, top: roofY - 0.03 },
    { z: bp.cabinRear + 0.3, halfWidth: hw, bottom: ride, top: roofY },
    { z: tailZ - 0.16, halfWidth: hw * 0.995, bottom: ride, top: roofY - 0.01 },
    { z: tailZ, halfWidth: hw * bp.tailTaper, bottom: ride + 0.1, top: bp.tailY },
  ];
  return orderStations(raw);
}

function greenhouse(bp: VehicleBlueprint, roofY: number, front: number, rear: number): Station[] {
  const hw = bp.width * 0.5 * bp.cabinInset;
  const base = bp.beltY - 0.03;
  const k = clamp((rear - front) / 2.0, 0.42, 1);
  const raw: Station[] = [
    { z: front, halfWidth: hw * 0.78, bottom: base, top: bp.beltY + 0.05 },
    { z: front + 0.42 * k, halfWidth: hw * 0.94, bottom: base, top: lerp(bp.beltY, roofY, 0.72) },
    { z: front + 0.86 * k, halfWidth: hw, bottom: base, top: roofY },
    { z: rear - 0.6 * k, halfWidth: hw, bottom: base, top: roofY },
    { z: rear - 0.22 * k, halfWidth: hw * 0.95, bottom: base, top: lerp(bp.beltY, roofY, 0.8) },
    { z: rear, halfWidth: hw * 0.8, bottom: base, top: bp.beltY + 0.06 },
  ];
  return orderStations(raw);
}

/** Roof paint above this angle from horizontal; glazing below it. */
const ROOF_BAND = Math.PI * 0.5 - 0.52;

function greenhouseStyle(roofStyle: SurfaceStyle): (
  station: number,
  angle: number,
  x: number,
  y: number,
  z: number,
) => SurfaceStyle {
  return (_station, angle) => {
    const up = Math.sin(angle);
    return up > Math.sin(ROOF_BAND) ? roofStyle : GLASS;
  };
}

// -- details ----------------------------------------------------------------

function addPlate(
  mesh: VehicleMeshBuilder,
  z: number,
  y: number,
  facing: 1 | -1,
  width = 0.21,
  height = 0.06,
): void {
  mesh.box(0, y, z, width, height, 0.012, PLATE);
  // Five short marks read as a registration at street distance. No texture is
  // used anywhere on a vehicle, so the characters are geometry or nothing.
  for (let i = 0; i < 5; i += 1) {
    const x = (i - 2) * width * 0.33;
    mesh.box(x, y, z + facing * 0.014, width * 0.075, height * 0.5, 0.004, PLATE_MARK);
  }
}

function addMirrors(mesh: VehicleMeshBuilder, bp: VehicleBlueprint, z: number): void {
  const hw = bp.width * 0.5;
  const y = bp.beltY + 0.03;
  for (const side of [1, -1] as const) {
    mesh.strut(side * hw * 0.92, y, z, side * (hw + 0.1), y + 0.03, z + 0.03, 0.03, 0.02, TRIM);
    mesh.box(side * (hw + 0.14), y + 0.04, z + 0.03, 0.05, 0.06, 0.1, TRIM, 0);
  }
}

function addLamps(mesh: VehicleMeshBuilder, bp: VehicleBlueprint): void {
  const hl = bp.length * 0.5;
  const hw = bp.width * 0.5;

  // Headlamps, set into a dark surround so they read as units, not stickers.
  const headY = lerp(bp.rideHeight, bp.noseY, 0.66);
  for (const side of [1, -1] as const) {
    mesh.box(side * hw * 0.6, headY, -hl + 0.05, 0.16, 0.075, 0.05, TRIM);
    mesh.box(side * hw * 0.6, headY, -hl + 0.02, 0.135, 0.055, 0.035, HEADLAMP);
    mesh.box(side * hw * 0.83, headY - 0.04, -hl + 0.07, 0.045, 0.035, 0.04, MARKER_AMBER);
  }
  // Grille and lower intake.
  const grilleY = lerp(bp.rideHeight, bp.noseY, 0.78);
  mesh.box(0, grilleY, -hl + 0.045, hw * 0.42, 0.055, 0.04, TRIM);
  mesh.box(0, bp.rideHeight + 0.16, -hl + 0.05, hw * 0.62, 0.09, 0.05, TRIM_SOFT);

  // Tail lamps: a dark red lens with the lit element inside it.
  const tailY = lerp(bp.rideHeight, bp.tailY, 0.72);
  for (const side of [1, -1] as const) {
    mesh.box(side * hw * 0.7, tailY, hl - 0.05, 0.15, 0.085, 0.05, TRIM);
    mesh.box(side * hw * 0.7, tailY, hl - 0.02, 0.125, 0.065, 0.035, TAILLAMP);
    mesh.box(side * hw * 0.46, tailY - 0.05, hl - 0.03, 0.045, 0.025, 0.03, REVERSE_LAMP);
  }
  mesh.box(0, bp.rideHeight + 0.14, hl - 0.05, hw * 0.66, 0.09, 0.05, TRIM_SOFT);
}

function addExhaust(mesh: VehicleMeshBuilder, bp: VehicleBlueprint): void {
  const hl = bp.length * 0.5;
  mesh.box(bp.width * 0.22, bp.rideHeight - 0.04, hl - 0.16, 0.04, 0.035, 0.1, CHROME);
}

function addPatrolKit(mesh: VehicleMeshBuilder, bp: VehicleBlueprint, roofY: number): void {
  const hw = bp.width * 0.5;
  const hl = bp.length * 0.5;
  const cabMid = (bp.cabinFront + bp.cabinRear) * 0.5;

  // Low-profile roof bar: a dark shell with blue and red lens segments. The
  // lenses are wired to the beacon channels but ambient patrol traffic drives
  // with them off - a flashing car implies a pursuit, which is out of scope.
  const barZ = cabMid - 0.35;
  const barY = roofY + 0.045;
  mesh.box(0, roofY + 0.015, barZ, hw * 0.66, 0.02, 0.13, TRIM);
  mesh.box(0, barY, barZ, hw * 0.62, 0.045, 0.1, TRIM);
  for (const side of [1, -1] as const) {
    mesh.box(side * hw * 0.42, barY, barZ - 0.005, hw * 0.16, 0.032, 0.095, side > 0 ? BEACON_RED : BEACON_BLUE);
    mesh.box(side * hw * 0.14, barY, barZ - 0.005, hw * 0.1, 0.03, 0.09, side > 0 ? BEACON_BLUE : BEACON_RED);
  }

  // Front push bar.
  const pushY = lerp(bp.rideHeight, bp.noseY, 0.44);
  for (const side of [1, -1] as const) {
    mesh.strut(side * hw * 0.62, pushY - 0.24, -hl + 0.12, side * hw * 0.62, pushY + 0.2, -hl - 0.1, 0.035, 0.03, TRIM_SOFT);
  }
  mesh.strut(-hw * 0.66, pushY + 0.12, -hl - 0.09, hw * 0.66, pushY + 0.12, -hl - 0.09, 0.03, 0.035, TRIM_SOFT);
  mesh.strut(-hw * 0.66, pushY - 0.1, -hl - 0.09, hw * 0.66, pushY - 0.1, -hl - 0.09, 0.03, 0.035, TRIM_SOFT);

  // A geometric door crest: three offset bars inside a plate. Invented mark.
  for (const side of [1, -1] as const) {
    const x = side * (hw + 0.012);
    const y = lerp(bp.rideHeight, bp.beltY, 0.62);
    const z = cabMid - 0.15;
    mesh.quad(
      [x, y - 0.13, z - 0.13],
      [x, y - 0.13, z + 0.13],
      [x, y + 0.13, z + 0.13],
      [x, y + 0.13, z - 0.13],
      PAINT_MATT,
      [side, 0, 0],
    );
    for (let i = 0; i < 3; i += 1) {
      const inset = 0.02 + i * 0.03;
      mesh.quad(
        [x + side * 0.004, y - 0.1 + i * 0.06, z - 0.1 + inset],
        [x + side * 0.004, y - 0.1 + i * 0.06, z + 0.1 - inset],
        [x + side * 0.004, y - 0.07 + i * 0.06, z + 0.1 - inset],
        [x + side * 0.004, y - 0.07 + i * 0.06, z - 0.1 + inset],
        LIVERY_DARK,
        [side, 0, 0],
      );
    }
  }
}

// -- assembly ---------------------------------------------------------------

export interface VehicleShell {
  readonly geometry: BufferGeometry;
  readonly triangles: number;
}

function buildShell(bp: VehicleBlueprint): VehicleShell {
  const mesh = new VehicleMeshBuilder();
  const options = sectionOptions(bp);
  const hl = bp.length * 0.5;
  const hw = bp.width * 0.5;
  // Local space puts the nose at -Z, so a positive `frontAxle` (measured
  // forward from the centre) becomes a negative z here. Getting this backwards
  // puts the front arches over the rear wheels, which is not subtle.
  const frontAxleZ = -bp.frontAxle;
  const rearAxleZ = bp.wheelbase - bp.frontAxle;

  let stations: Station[];
  let cabRoofY = bp.roofY;
  let cabFront = bp.cabinFront;
  let cabRear = bp.cabinRear;

  if (bp.form === 'van') {
    stations = tallBody(bp, bp.roofY, hl);
    cabRoofY = bp.roofY;
  } else if (bp.form === 'box') {
    // Cab only; the payload box is a separate volume behind it.
    cabRoofY = bp.beltY + (bp.roofY - bp.beltY) * 0.62;
    stations = tallBody(
      { ...bp, tailY: cabRoofY - 0.08, tailTaper: 0.98 },
      cabRoofY,
      bp.bedFront,
    );
  } else {
    stations = lowerBody(bp);
  }

  const bodyStyle = bp.livery === 'patrol' ? PAINT_MATT : PAINT;
  mesh.loft(stations, () => bodyStyle, {
    ...options,
    capStart: bp.form === 'box' ? undefined : bodyStyle,
    capEnd: bodyStyle,
  });

  if (bp.form === 'van' || bp.form === 'box') {
    // Cab glazing: a raked windscreen and two side lights, laid on the shell.
    const wsBottom = stationAt(stations, bp.cabinFront - 0.08);
    const wsTop = stationAt(stations, bp.cabinFront + 0.6);
    mesh.quad(
      [-wsBottom.halfWidth * 0.92, bp.cowlY + 0.02, bp.cabinFront - 0.06],
      [wsBottom.halfWidth * 0.92, bp.cowlY + 0.02, bp.cabinFront - 0.06],
      [wsTop.halfWidth * 0.9, cabRoofY - 0.06, bp.cabinFront + 0.58],
      [-wsTop.halfWidth * 0.9, cabRoofY - 0.06, bp.cabinFront + 0.58],
      GLASS,
      [0, 0.5, -1],
    );
    sideBand(
      mesh,
      stations,
      options,
      bp.cabinFront + 0.24,
      bp.cabinRear + 0.18,
      bp.beltY + 0.06,
      cabRoofY - 0.1,
      GLASS,
      3,
      0.006,
    );
    cabFront = bp.cabinFront;
    cabRear = bp.cabinRear;
  } else {
    mesh.loft(greenhouse(bp, bp.roofY, cabFront, cabRear), greenhouseStyle(bodyStyle), {
      ...options,
      fullnessTop: Math.max(2.6, bp.sectionTop * 0.8),
      fullnessBottom: 5.5,
      capStart: bodyStyle,
      capEnd: bodyStyle,
    });

    // Pillars. Without them a greenhouse reads as a solid tinted block.
    const gh = greenhouse(bp, bp.roofY, cabFront, cabRear);
    const ghw = hw * bp.cabinInset;
    for (const side of [1, -1] as const) {
      const a = gh[0] as Station;
      const b = gh[2] as Station;
      mesh.strut(
        side * ghw * 0.76,
        a.top - 0.02,
        a.z + 0.02,
        side * ghw * 0.86,
        b.top - 0.03,
        b.z,
        0.035,
        0.022,
        bodyStyle,
      );
      const c = gh[gh.length - 3] as Station;
      const d = gh[gh.length - 1] as Station;
      mesh.strut(
        side * ghw * 0.86,
        c.top - 0.03,
        c.z,
        side * ghw * 0.78,
        d.top - 0.02,
        d.z - 0.02,
        0.035,
        0.022,
        bodyStyle,
      );
      if (cabRear - cabFront > 1.7) {
        const mid = lerp(cabFront, cabRear, 0.46);
        const m = stationAt(gh, mid);
        mesh.strut(
          side * ghw * 0.9,
          bp.beltY,
          mid,
          side * ghw * 0.9,
          m.top - 0.02,
          mid,
          0.035,
          0.02,
          TRIM,
        );
      }
    }
  }

  // Payload volumes.
  if (bp.form === 'pickup') {
    const bedRear = hl - 0.1;
    mesh.quad(
      [-hw * 0.86, bp.bedFloorY, bp.bedFront],
      [hw * 0.86, bp.bedFloorY, bp.bedFront],
      [hw * 0.86, bp.bedFloorY, bedRear],
      [-hw * 0.86, bp.bedFloorY, bedRear],
      TRIM_SOFT,
      [0, 1, 0],
    );
    for (const side of [1, -1] as const) {
      mesh.quad(
        [side * hw * 0.86, bp.bedFloorY, bp.bedFront],
        [side * hw * 0.86, bp.bedFloorY, bedRear],
        [side * hw * 0.86, bp.beltY - 0.03, bedRear],
        [side * hw * 0.86, bp.beltY - 0.03, bp.bedFront],
        TRIM_SOFT,
        [-side, 0, 0],
      );
    }
    mesh.box(0, (bp.bedFloorY + bp.beltY) * 0.5, bp.bedFront - 0.03, hw * 0.86, (bp.beltY - bp.bedFloorY) * 0.5, 0.04, bodyStyle);
  } else if (bp.form === 'box') {
    const boxFront = bp.bedFront;
    const boxRear = hl;
    const boxTop = bp.roofY;
    const boxFloor = bp.bedFloorY;
    mesh.box(
      0,
      (boxFloor + boxTop) * 0.5,
      (boxFront + boxRear) * 0.5,
      hw * 0.99,
      (boxTop - boxFloor) * 0.5,
      (boxRear - boxFront) * 0.5,
      bodyStyle,
    );
    // Roller shutter and frame at the tail, plus the chassis under the box.
    mesh.box(0, (boxFloor + boxTop) * 0.5 - 0.05, boxRear + 0.015, hw * 0.88, (boxTop - boxFloor) * 0.5 - 0.12, 0.02, TRIM_SOFT);
    mesh.box(0, boxFloor - 0.02, (boxFront + boxRear) * 0.5, hw * 0.99, 0.04, (boxRear - boxFront) * 0.5, TRIM);
    mesh.box(0, boxFloor - 0.24, (boxFront + boxRear) * 0.5 + 0.1, hw * 0.5, 0.2, (boxRear - boxFront) * 0.5 - 0.2, UNDERBODY);
    for (const side of [1, -1] as const) {
      mesh.box(side * hw * 0.72, boxFloor + 0.06, boxRear - 0.1, 0.05, 0.05, 0.06, MARKER_AMBER);
    }
  }

  // Underbody: without it a car is hollow when seen from a kerb.
  mesh.box(0, bp.rideHeight - 0.03, (frontAxleZ + rearAxleZ) * 0.5, hw * 0.82, 0.05, bp.wheelbase * 0.5, UNDERBODY);

  // Sill strip and shoulder crease, laid on the flank.
  sideBand(mesh, stations, options, -hl + 0.5, hl - 0.4, bp.rideHeight + 0.02, bp.rideHeight + 0.14, TRIM_SOFT, 5);
  if (bp.form !== 'box') {
    sideBand(mesh, stations, options, cabFront - 0.1, Math.min(cabRear + 0.2, hl - 0.2), bp.beltY - 0.05, bp.beltY - 0.005, TRIM, 5, 0.006);
  }

  // Door handles.
  if (bp.form !== 'box') {
    const handleY = bp.beltY - 0.16;
    const handles = cabRear - cabFront > 1.5 ? [0.18, 0.66] : [0.32];
    for (const side of [1, -1] as const) {
      for (const t of handles) {
        const z = lerp(cabFront, cabRear, t);
        const station = stationAt(stations, z);
        mesh.box(
          side * (widthAtHeight(station, handleY, options) + 0.018),
          handleY,
          z,
          0.015,
          0.02,
          0.07,
          CHROME,
        );
      }
    }
  }

  wheelArch(mesh, stations, options, frontAxleZ, bp.wheelRadius, TRIM_SOFT);
  wheelArch(mesh, stations, options, rearAxleZ, bp.wheelRadius, TRIM_SOFT);

  addLamps(mesh, bp);
  addPlate(mesh, -hl - 0.005, bp.rideHeight + 0.22, -1);
  addPlate(mesh, hl + 0.005, lerp(bp.rideHeight, bp.tailY, 0.34), 1);
  addMirrors(mesh, bp, cabFront + 0.2);
  if (bp.form !== 'box' && bp.form !== 'van') addExhaust(mesh, bp);

  if (bp.roofRails) {
    for (const side of [1, -1] as const) {
      const x = side * hw * bp.cabinInset * 0.78;
      mesh.strut(x, bp.roofY + 0.03, cabFront + 0.9, x, bp.roofY + 0.03, cabRear - 0.2, 0.022, 0.02, TRIM);
    }
  }

  if (bp.livery === 'taxi') {
    sideBand(mesh, stations, options, cabFront - 0.05, cabRear + 0.1, bp.rideHeight + 0.16, bp.beltY - 0.3, TAXI_BAND, 5, 0.007);
  }
  if (bp.roofSign) {
    mesh.box(0, bp.roofY + 0.075, lerp(cabFront, cabRear, 0.34), 0.2, 0.07, 0.09, TAXI_SIGN);
    mesh.box(0, bp.roofY + 0.015, lerp(cabFront, cabRear, 0.34), 0.16, 0.02, 0.07, TRIM);
  }
  if (bp.livery === 'patrol') {
    // Dark flank over the doors with a slim stripe above it: the whole mark of
    // the invented Meridian Bay service, plus the crest added with the kit.
    const from = cabFront - 0.28;
    const to = Math.min(cabRear + 0.45, hl - 0.25);
    sideBand(mesh, stations, options, from, to, bp.rideHeight + 0.16, lerp(bp.rideHeight, bp.beltY, 0.62), LIVERY_DARK, 6, 0.007);
    sideBand(mesh, stations, options, from, to, lerp(bp.rideHeight, bp.beltY, 0.64), lerp(bp.rideHeight, bp.beltY, 0.72), LIVERY_STRIPE, 6, 0.008);
  }
  if (bp.lightBar) addPatrolKit(mesh, bp, cabRoofY);

  return { geometry: mesh.build(), triangles: mesh.triangleCount };
}

/**
 * Builds a fresh shell. The caller owns the geometry and must dispose it.
 *
 * The renderer needs its own copy per system because it hangs per-instance
 * attributes off the geometry; a shared cached geometry would mean two systems
 * writing over each other's instance buffers, and disposing one would take the
 * other's meshes with it.
 */
export function buildVehicleShell(kind: VehicleKind): VehicleShell {
  return buildShell(VEHICLE_BLUEPRINTS[kind]);
}

const shellCache = new Map<VehicleKind, VehicleShell>();

/**
 * Cached shell, for inspection and tests. Callers must not dispose it and must
 * not attach instance attributes to it - use `buildVehicleShell` for that.
 */
export function vehicleShell(kind: VehicleKind): VehicleShell {
  const cached = shellCache.get(kind);
  if (cached) return cached;
  const built = buildVehicleShell(kind);
  shellCache.set(kind, built);
  return built;
}

/**
 * One wheel, unit radius and unit half width, axle along X.
 *
 * The instance matrix scales it to each vehicle's wheel size, which is why a
 * single 136-triangle mesh covers every wheel in the city in one draw call.
 */
export function buildWheel(): VehicleShell {
  const mesh = new VehicleMeshBuilder();
  mesh.cylinderX(0, 0, 0, 1, 1, 14, TREAD, RUBBER);
  mesh.cylinderX(0, 0, 0, 0.72, 1.03, 12, RIM, RIM);
  mesh.cylinderX(0, 0, 0, 0.24, 1.06, 8, HUB, HUB);
  return { geometry: mesh.build(), triangles: mesh.triangleCount };
}
