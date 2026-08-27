/**
 * The vehicle catalogue: every shell that can appear in Meridian Bay traffic.
 *
 * A blueprint is pure numbers - proportions, axle positions, where the cabin
 * sits on the body - and `VehicleGeometry` lofts a shell from it. Authoring the
 * shapes this way rather than as eleven hand-built meshes is what makes it
 * cheap to keep the silhouettes genuinely different from each other, which is
 * the whole point: a street where every car is the same outline reads as a
 * screensaver no matter how good the individual model is.
 *
 * Everything here is original. The patrol cars carry an invented Meridian Bay
 * livery - a two-tone flank with a shoulder stripe and a geometric crest - and
 * are ordinary ambient traffic: no beacons, no pursuit, no crime system.
 *
 * All dimensions are metres and follow the real thing: a mid-size saloon is
 * 4.55 m long, 1.82 m wide and 1.46 m tall, on a 2.75 m wheelbase.
 */

import type { ChassisSpec, VehicleKind } from './types';

/** How the shell is massed. Drives which lofts the geometry builder runs. */
export type BodyForm = 'hatch' | 'notch' | 'wagon' | 'suv' | 'pickup' | 'van' | 'box';

export type Livery = 'none' | 'patrol' | 'taxi';

export interface VehicleBlueprint {
  readonly kind: VehicleKind;
  readonly form: BodyForm;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly wheelbase: number;
  /** Centre-to-front-axle, positive forward. Rear axle sits at this minus wheelbase. */
  readonly frontAxle: number;
  readonly track: number;
  readonly wheelRadius: number;
  readonly wheelWidth: number;
  /** Lowest point of the painted body above the ground. */
  readonly rideHeight: number;
  /** Top of the lower body, i.e. where the glazing starts. */
  readonly beltY: number;
  /** Top of the roof. Equals `height` for everything without a roof fitting. */
  readonly roofY: number;
  /** Bonnet height at the base of the windscreen. */
  readonly cowlY: number;
  /** Bonnet height at the front edge, before the nose falls away. */
  readonly noseY: number;
  readonly tailY: number;
  /** Front and rear of the greenhouse, measured from the vehicle centre. */
  readonly cabinFront: number;
  readonly cabinRear: number;
  /** Width of the greenhouse as a fraction of the body's half width. */
  readonly cabinInset: number;
  /** Half width at the extreme nose and tail, as a fraction of the body's. */
  readonly noseTaper: number;
  readonly tailTaper: number;
  /** Cross-section fullness: higher is squarer. Upper and lower halves. */
  readonly sectionTop: number;
  readonly sectionBottom: number;
  /** Bed floor height and extent, for pickups. */
  readonly bedFloorY: number;
  readonly bedFront: number;
  readonly livery: Livery;
  readonly lightBar: boolean;
  readonly pushBar: boolean;
  readonly roofRails: boolean;
  readonly roofSign: boolean;
  /** How often this shell appears, relative to the other entries. */
  readonly weight: number;
  readonly chassis: ChassisSpec;
  /** Fraction of the street's speed limit this shell aims for. */
  readonly speedFactor: number;
  /** Paint choices, authored sRGB. Picked deterministically per vehicle. */
  readonly paints: readonly number[];
  /** Wheel rim choices. */
  readonly rims: readonly number[];
}

/** Realistic, deliberately desaturated body colours. */
const COMMON_PAINTS: readonly number[] = [
  0xd8d9d6, // pearl white
  0xb7bbbe, // silver
  0x8d9296, // light graphite
  0x4d5358, // graphite
  0x23262a, // near black
  0x2e3f56, // navy
  0x6d2f2c, // burgundy
  0x8c4a2f, // rust orange
  0x4a5f4a, // olive
  0x2f5b5c, // teal
  0xa89a7b, // sand
  0x76889b, // dusty blue
  0x93413f, // brick red
  0x5b4a63, // aubergine
];

const UTILITY_PAINTS: readonly number[] = [
  0xd8d9d6, 0xc9c6bd, 0x8d9296, 0x4d5358, 0x2f5b5c, 0x3f5b3f, 0x8c4a2f, 0x2e3f56,
];

const RIMS: readonly number[] = [0xc4c7c9, 0xa8acae, 0x8e9295, 0x55595c];
const STEEL_RIMS: readonly number[] = [0xa8acae, 0x8e9295, 0x62666a];

function chassis(spec: Partial<ChassisSpec> & Pick<ChassisSpec,
  'length' | 'width' | 'height' | 'wheelbase' | 'track' | 'wheelRadius' | 'frontAxle'>): ChassisSpec {
  return {
    mass: 1350,
    maxSteer: 0.60,
    steerRate: 2.1,
    accelMax: 3.07,
    brakeMax: 7.4,
    gripLateral: 6.6,
    ...spec,
  };
}

/**
 * Blueprints, in the order they appear on screen most often.
 *
 * The numbers are checked against each other in `tests/traffic.test.ts`: the
 * axles must lie inside the body, the cabin inside the wheelbase envelope, and
 * every shell must be a plausible size for a car. It is very easy to typo a
 * proportion here and only notice it as a strange silhouette in a screenshot.
 */
export const VEHICLE_BLUEPRINTS: Readonly<Record<VehicleKind, VehicleBlueprint>> = {
  sedan: {
    kind: 'sedan',
    form: 'notch',
    length: 4.56,
    width: 1.82,
    height: 1.46,
    wheelbase: 2.74,
    frontAxle: 1.51,
    track: 1.56,
    wheelRadius: 0.33,
    wheelWidth: 0.22,
    rideHeight: 0.16,
    beltY: 1.02,
    roofY: 1.46,
    cowlY: 0.99,
    noseY: 0.88,
    tailY: 0.95,
    cabinFront: -0.72,
    cabinRear: 1.32,
    cabinInset: 0.90,
    noseTaper: 0.80,
    tailTaper: 0.83,
    sectionTop: 4.0,
    sectionBottom: 5.0,
    bedFloorY: 0,
    bedFront: 0,
    livery: 'none',
    lightBar: false,
    pushBar: false,
    roofRails: false,
    roofSign: false,
    weight: 16,
    speedFactor: 1.0,
    paints: COMMON_PAINTS,
    rims: RIMS,
    chassis: chassis({
      length: 4.56, width: 1.82, height: 1.46, wheelbase: 2.74, track: 1.56,
      wheelRadius: 0.33, frontAxle: 1.51, mass: 1420,
    }),
  },

  compact: {
    kind: 'compact',
    form: 'hatch',
    length: 3.92,
    width: 1.72,
    height: 1.50,
    wheelbase: 2.48,
    frontAxle: 1.30,
    track: 1.48,
    wheelRadius: 0.31,
    wheelWidth: 0.20,
    rideHeight: 0.17,
    beltY: 1.02,
    roofY: 1.50,
    cowlY: 1.00,
    noseY: 0.86,
    tailY: 1.02,
    cabinFront: -0.60,
    cabinRear: 1.56,
    cabinInset: 0.91,
    noseTaper: 0.79,
    tailTaper: 0.90,
    sectionTop: 3.8,
    sectionBottom: 4.8,
    bedFloorY: 0,
    bedFront: 0,
    livery: 'none',
    lightBar: false,
    pushBar: false,
    roofRails: false,
    roofSign: false,
    weight: 15,
    speedFactor: 0.98,
    paints: COMMON_PAINTS,
    rims: RIMS,
    chassis: chassis({
      length: 3.92, width: 1.72, height: 1.50, wheelbase: 2.48, track: 1.48,
      wheelRadius: 0.31, frontAxle: 1.30, mass: 1180, accelMax: 2.95, maxSteer: 0.64,
    }),
  },

  crossover: {
    kind: 'crossover',
    form: 'suv',
    length: 4.62,
    width: 1.88,
    height: 1.70,
    wheelbase: 2.72,
    frontAxle: 1.50,
    track: 1.61,
    wheelRadius: 0.37,
    wheelWidth: 0.24,
    rideHeight: 0.22,
    beltY: 1.18,
    roofY: 1.70,
    cowlY: 1.16,
    noseY: 1.02,
    tailY: 1.18,
    cabinFront: -0.62,
    cabinRear: 1.62,
    cabinInset: 0.92,
    noseTaper: 0.82,
    tailTaper: 0.90,
    sectionTop: 4.8,
    sectionBottom: 5.2,
    bedFloorY: 0,
    bedFront: 0,
    livery: 'none',
    lightBar: false,
    pushBar: false,
    roofRails: true,
    roofSign: false,
    weight: 13,
    speedFactor: 0.96,
    paints: COMMON_PAINTS,
    rims: RIMS,
    chassis: chassis({
      length: 4.62, width: 1.88, height: 1.70, wheelbase: 2.72, track: 1.61,
      wheelRadius: 0.37, frontAxle: 1.50, mass: 1780, accelMax: 2.60,
      brakeMax: 6.9, gripLateral: 5.9, maxSteer: 0.58,
    }),
  },

  wagon: {
    kind: 'wagon',
    form: 'wagon',
    length: 4.80,
    width: 1.84,
    height: 1.52,
    wheelbase: 2.80,
    frontAxle: 1.56,
    track: 1.58,
    wheelRadius: 0.33,
    wheelWidth: 0.22,
    rideHeight: 0.16,
    beltY: 1.04,
    roofY: 1.52,
    cowlY: 1.01,
    noseY: 0.88,
    tailY: 1.06,
    cabinFront: -0.70,
    cabinRear: 2.02,
    cabinInset: 0.90,
    noseTaper: 0.80,
    tailTaper: 0.92,
    sectionTop: 4.2,
    sectionBottom: 5.0,
    bedFloorY: 0,
    bedFront: 0,
    livery: 'none',
    lightBar: false,
    pushBar: false,
    roofRails: true,
    roofSign: false,
    weight: 8,
    speedFactor: 0.98,
    paints: COMMON_PAINTS,
    rims: RIMS,
    chassis: chassis({
      length: 4.80, width: 1.84, height: 1.52, wheelbase: 2.80, track: 1.58,
      wheelRadius: 0.33, frontAxle: 1.56, mass: 1520,
    }),
  },

  coupe: {
    kind: 'coupe',
    form: 'notch',
    length: 4.34,
    width: 1.86,
    height: 1.32,
    wheelbase: 2.62,
    frontAxle: 1.44,
    track: 1.62,
    wheelRadius: 0.34,
    wheelWidth: 0.25,
    rideHeight: 0.12,
    beltY: 0.94,
    roofY: 1.32,
    cowlY: 0.91,
    noseY: 0.76,
    tailY: 0.90,
    cabinFront: -0.44,
    cabinRear: 1.18,
    cabinInset: 0.87,
    noseTaper: 0.78,
    tailTaper: 0.82,
    sectionTop: 3.6,
    sectionBottom: 4.6,
    bedFloorY: 0,
    bedFront: 0,
    livery: 'none',
    lightBar: false,
    pushBar: false,
    roofRails: false,
    roofSign: false,
    weight: 7,
    speedFactor: 1.06,
    paints: COMMON_PAINTS,
    rims: RIMS,
    chassis: chassis({
      length: 4.34, width: 1.86, height: 1.32, wheelbase: 2.62, track: 1.62,
      wheelRadius: 0.34, frontAxle: 1.44, mass: 1400, accelMax: 3.89,
      gripLateral: 7.6, brakeMax: 8.2,
    }),
  },

  pickup: {
    kind: 'pickup',
    form: 'pickup',
    length: 5.24,
    width: 1.96,
    height: 1.80,
    wheelbase: 3.20,
    frontAxle: 1.72,
    track: 1.68,
    wheelRadius: 0.39,
    wheelWidth: 0.26,
    rideHeight: 0.26,
    beltY: 1.24,
    roofY: 1.80,
    cowlY: 1.22,
    noseY: 1.12,
    tailY: 1.22,
    cabinFront: -0.52,
    cabinRear: 0.72,
    cabinInset: 0.94,
    noseTaper: 0.86,
    tailTaper: 0.96,
    sectionTop: 5.2,
    sectionBottom: 5.4,
    bedFloorY: 0.86,
    bedFront: 0.78,
    livery: 'none',
    lightBar: false,
    pushBar: false,
    roofRails: false,
    roofSign: false,
    weight: 8,
    speedFactor: 0.92,
    paints: UTILITY_PAINTS,
    rims: STEEL_RIMS,
    chassis: chassis({
      length: 5.24, width: 1.96, height: 1.80, wheelbase: 3.20, track: 1.68,
      wheelRadius: 0.39, frontAxle: 1.72, mass: 2050, accelMax: 2.36,
      brakeMax: 6.6, gripLateral: 5.4, maxSteer: 0.56, steerRate: 1.8,
    }),
  },

  van: {
    kind: 'van',
    form: 'van',
    length: 5.36,
    width: 1.98,
    height: 2.28,
    wheelbase: 3.30,
    frontAxle: 1.60,
    track: 1.70,
    wheelRadius: 0.36,
    wheelWidth: 0.24,
    rideHeight: 0.24,
    beltY: 1.24,
    roofY: 2.28,
    cowlY: 1.22,
    noseY: 1.06,
    tailY: 2.10,
    cabinFront: -0.86,
    cabinRear: 0.10,
    cabinInset: 0.95,
    noseTaper: 0.86,
    tailTaper: 0.97,
    sectionTop: 5.4,
    sectionBottom: 5.4,
    bedFloorY: 0,
    bedFront: 0,
    livery: 'none',
    lightBar: false,
    pushBar: false,
    roofRails: false,
    roofSign: false,
    weight: 7,
    speedFactor: 0.90,
    paints: UTILITY_PAINTS,
    rims: STEEL_RIMS,
    chassis: chassis({
      length: 5.36, width: 1.98, height: 2.28, wheelbase: 3.30, track: 1.70,
      wheelRadius: 0.36, frontAxle: 1.60, mass: 2350, accelMax: 2.24,
      brakeMax: 6.2, gripLateral: 5.0, maxSteer: 0.55, steerRate: 1.7,
    }),
  },

  boxTruck: {
    kind: 'boxTruck',
    form: 'box',
    length: 6.70,
    width: 2.14,
    height: 2.92,
    wheelbase: 3.72,
    frontAxle: 2.36,
    track: 1.82,
    wheelRadius: 0.44,
    wheelWidth: 0.28,
    rideHeight: 0.34,
    beltY: 1.52,
    roofY: 2.92,
    cowlY: 1.50,
    noseY: 1.36,
    tailY: 2.80,
    cabinFront: -2.02,
    cabinRear: -0.92,
    cabinInset: 0.96,
    noseTaper: 0.92,
    tailTaper: 0.99,
    sectionTop: 5.8,
    sectionBottom: 5.8,
    bedFloorY: 1.12,
    bedFront: -0.86,
    livery: 'none',
    lightBar: false,
    pushBar: false,
    roofRails: false,
    roofSign: false,
    weight: 4,
    speedFactor: 0.82,
    paints: [0xd8d9d6, 0xc9c6bd, 0x8d9296, 0x4d5358, 0x2f5b5c, 0x8c4a2f],
    rims: STEEL_RIMS,
    chassis: chassis({
      length: 6.70, width: 2.14, height: 2.92, wheelbase: 3.72, track: 1.82,
      wheelRadius: 0.44, frontAxle: 2.36, mass: 4200, accelMax: 1.65,
      brakeMax: 5.4, gripLateral: 4.3, maxSteer: 0.50, steerRate: 1.4,
    }),
  },

  taxi: {
    kind: 'taxi',
    form: 'notch',
    length: 4.62,
    width: 1.84,
    height: 1.52,
    wheelbase: 2.80,
    frontAxle: 1.54,
    track: 1.58,
    wheelRadius: 0.33,
    wheelWidth: 0.22,
    rideHeight: 0.16,
    beltY: 1.06,
    roofY: 1.52,
    cowlY: 1.03,
    noseY: 0.90,
    tailY: 0.99,
    cabinFront: -0.70,
    cabinRear: 1.36,
    cabinInset: 0.90,
    noseTaper: 0.81,
    tailTaper: 0.84,
    sectionTop: 4.2,
    sectionBottom: 5.0,
    bedFloorY: 0,
    bedFront: 0,
    livery: 'taxi',
    lightBar: false,
    pushBar: false,
    roofRails: false,
    roofSign: true,
    weight: 6,
    speedFactor: 1.02,
    paints: [0xd8a63c, 0xd8a63c, 0xc9963a],
    rims: STEEL_RIMS,
    chassis: chassis({
      length: 4.62, width: 1.84, height: 1.52, wheelbase: 2.80, track: 1.58,
      wheelRadius: 0.33, frontAxle: 1.54, mass: 1480,
    }),
  },

  patrolSedan: {
    kind: 'patrolSedan',
    form: 'notch',
    length: 4.88,
    width: 1.92,
    height: 1.50,
    wheelbase: 2.94,
    frontAxle: 1.62,
    track: 1.64,
    wheelRadius: 0.35,
    wheelWidth: 0.24,
    rideHeight: 0.15,
    beltY: 1.04,
    roofY: 1.50,
    cowlY: 1.01,
    noseY: 0.88,
    tailY: 0.98,
    cabinFront: -0.68,
    cabinRear: 1.42,
    cabinInset: 0.90,
    noseTaper: 0.82,
    tailTaper: 0.85,
    sectionTop: 4.2,
    sectionBottom: 5.0,
    bedFloorY: 0,
    bedFront: 0,
    livery: 'patrol',
    lightBar: true,
    pushBar: true,
    roofRails: false,
    roofSign: false,
    weight: 2,
    speedFactor: 1.02,
    // White only. The livery is a dark navy flank, and a navy car wearing it
    // is a plain navy car: the mark has to have something to sit against.
    paints: [0xdcdcd8, 0xe6e6e2, 0xd2d5d8],
    rims: STEEL_RIMS,
    chassis: chassis({
      length: 4.88, width: 1.92, height: 1.50, wheelbase: 2.94, track: 1.64,
      wheelRadius: 0.35, frontAxle: 1.62, mass: 1780, accelMax: 3.54,
      gripLateral: 7.0, brakeMax: 8.0,
    }),
  },

  patrolSuv: {
    kind: 'patrolSuv',
    form: 'suv',
    length: 4.94,
    width: 1.96,
    height: 1.82,
    wheelbase: 2.94,
    frontAxle: 1.60,
    track: 1.68,
    wheelRadius: 0.39,
    wheelWidth: 0.26,
    rideHeight: 0.24,
    beltY: 1.26,
    roofY: 1.82,
    cowlY: 1.24,
    noseY: 1.08,
    tailY: 1.26,
    cabinFront: -0.62,
    cabinRear: 1.74,
    cabinInset: 0.92,
    noseTaper: 0.84,
    tailTaper: 0.92,
    sectionTop: 5.0,
    sectionBottom: 5.2,
    bedFloorY: 0,
    bedFront: 0,
    livery: 'patrol',
    lightBar: true,
    pushBar: true,
    roofRails: false,
    roofSign: false,
    weight: 1.5,
    speedFactor: 0.98,
    paints: [0xdcdcd8, 0xe6e6e2],
    rims: STEEL_RIMS,
    chassis: chassis({
      length: 4.94, width: 1.96, height: 1.82, wheelbase: 2.94, track: 1.68,
      wheelRadius: 0.39, frontAxle: 1.60, mass: 2150, accelMax: 2.83,
      brakeMax: 7.0, gripLateral: 6.0, maxSteer: 0.58,
    }),
  },
};

export const ALL_VEHICLE_KINDS: readonly VehicleKind[] = [
  'sedan',
  'compact',
  'crossover',
  'wagon',
  'coupe',
  'pickup',
  'van',
  'boxTruck',
  'taxi',
  'patrolSedan',
  'patrolSuv',
];

export const POLICE_KINDS: ReadonlySet<VehicleKind> = new Set<VehicleKind>([
  'patrolSedan',
  'patrolSuv',
]);

/** Selection weights parallel to `ALL_VEHICLE_KINDS`. */
export const VEHICLE_WEIGHTS: readonly number[] = ALL_VEHICLE_KINDS.map(
  (kind) => VEHICLE_BLUEPRINTS[kind].weight,
);
