/**
 * The four aeroplanes, as physical objects.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   import { AIRCRAFT, FLYABLE_AIRCRAFT_TYPES } from './air/AircraftCatalogue';
 *
 *   const spec = AIRCRAFT.cessna;
 *   stallSpeed(spec);      // 25.1 m/s
 *
 * Nothing here imports Three.js, the DOM or any other module of the game, so
 * the numbers can be read by a unit test, by the flight model and by the
 * renderer alike. `flight.ts` consumes this file; this file consumes nothing.
 *
 * ============================================================================
 *
 * ## Why every number here is a real one
 *
 * The flight model in `flight.ts` is a force model: it computes lift from
 * `CL(alpha)`, drag from `CD0 + k*CL^2`, thrust from a propeller or turbofan
 * curve, and moments from control derivatives about real moments of inertia.
 * That only produces an aeroplane that behaves like an aeroplane if the inputs
 * are an aeroplane's inputs. Every field below is either measured from a real
 * type, derived from the dimensions the models were built to, or tuned against
 * a stated flight-test figure that is written down beside it.
 *
 * The four are, in order: a Cessna 172, a Beechcraft King Air 350, a Learjet 45
 * and an Airbus A320. The dimensions came with the generated models and are
 * within a metre of those aircraft, so their published aerodynamics are the
 * honest source for everything else.
 *
 * ## MTOW versus the weight actually simulated
 *
 * `maxMass` is the type's maximum take-off weight. `mass` - the number the
 * physics uses - is an OPERATING weight: crew, a light load and part fuel, at
 * 76 to 91 per cent of MTOW depending on type. This is not a fudge to make the
 * runway work, it is what these aircraft weigh on a regional field; a Learjet
 * at MTOW is a Learjet with 2 t of fuel for a transatlantic leg, and it needs
 * 1358 m of balanced field length to match. The two numbers are both kept so
 * the difference is visible rather than hidden inside one "mass".
 *
 * ## The airliner cannot use this runway, and that is the correct answer
 *
 * Meridian Bay Regional's runway is 600 m (`RUNWAY_LENGTH`). At 64 t an A320
 * stalls at 78.6 m/s and rotates at 87 m/s; with 240 kN of thrust that is a
 * 1100 m ground roll, and no flap setting closes the gap - flaps 3 still needs
 * about 780 m. `liner.flyable` is therefore false: it is scenery on the heavy
 * stand, fully simulated but never handed to the player. `tests/flight.test.ts`
 * measures the number rather than trusting this comment, so if anybody flips
 * the flag the test says why it was false.
 */

/** The four generated airframes. */
export type AircraftType = 'cessna' | 'twin' | 'jet' | 'liner';

/** What is turning at the front, which is the only thing the model cares about. */
export type EngineKind = 'piston' | 'turboprop' | 'turbofan';

/**
 * A propeller or fan on the airframe, in the aircraft's OWN frame.
 *
 * `along` is metres forward of the centre of gravity, `side` is metres to the
 * pilot's right, and `up` is metres above the WHEELS - the same datum the
 * model's own origin uses, so a mount can be read straight off a side
 * elevation. Expressing them this way rather than in the model's raw axes
 * means the 180-degree model correction (see `AircraftSystem`) cannot
 * silently put a propeller on the tail.
 */
export interface PropMount {
  readonly along: number;
  readonly side: number;
  readonly up: number;
  readonly radius: number;
}

/** Everything the flight model, the renderer and the collision tests need. */
export interface AircraftSpec {
  readonly type: AircraftType;
  readonly label: string;
  /** Path relative to the site root, as `Furnishings` does it. */
  readonly modelUrl: string;
  readonly engine: EngineKind;
  /**
   * False for an aircraft the player may not take. It is still parked, drawn
   * and collided with; it simply cannot be entered. See the file header.
   */
  readonly flyable: boolean;
  /** Why, when `flyable` is false. Shown by nothing; read by the tests. */
  readonly groundedReason: string | null;

  // -- geometry -------------------------------------------------------------
  /** Wingtip to wingtip, metres. This is the model's X extent. */
  readonly span: number;
  /** Nose to tail, metres. */
  readonly length: number;
  /** Ground to the top of the fin, metres. */
  readonly height: number;
  /** Reference wing area, m^2. */
  readonly wingArea: number;
  /** Mean chord, `wingArea / span`. The pitching-moment arm. */
  readonly chord: number;
  readonly aspectRatio: number;

  // -- mass -----------------------------------------------------------------
  /** The weight actually flown, kg. See the header. */
  readonly mass: number;
  /** Maximum take-off weight, kg. Not simulated; kept for reference. */
  readonly maxMass: number;
  /** Roll inertia about the longitudinal axis, kg m^2. */
  readonly inertiaRoll: number;
  /** Pitch inertia, kg m^2. */
  readonly inertiaPitch: number;
  /** Yaw inertia, kg m^2. */
  readonly inertiaYaw: number;

  // -- lift -----------------------------------------------------------------
  /** CL at zero body incidence. Sets the zero-lift angle, `-clZero / clAlpha`. */
  readonly clZero: number;
  /** Lift-curve slope, per radian. */
  readonly clAlpha: number;
  /**
   * Angle of attack MEASURED FROM THE ZERO-LIFT ANGLE at which the wing stalls.
   * `clAlpha * alphaStall` is therefore exactly CLmax.
   */
  readonly alphaStall: number;
  /** How many radians past the stall the wing takes to fully separate. */
  readonly stallWidth: number;
  /** `clAlpha * alphaStall`. Cached because every speed derives from it. */
  readonly clMax: number;

  // -- drag -----------------------------------------------------------------
  readonly cd0: number;
  /** Added to `cd0` while the gear is down. Zero on the fixed-gear type. */
  readonly cd0Gear: number;
  readonly retractableGear: boolean;
  /** Seconds for the gear to travel end to end. */
  readonly gearTransit: number;
  /** Induced-drag factor, `1 / (pi * AR * oswald)`. */
  readonly inducedK: number;
  /**
   * Speed at which the drag rise begins, m/s.
   *
   * Compressibility on the jets, and the airframe simply running out of shape
   * on the propeller types. This is what actually stops an aeroplane going
   * faster in level flight than its published maximum; without it the thrust
   * curve alone let the Learjet settle at 486 kt at sea level.
   */
  readonly dragRiseSpeed: number;
  readonly dragRiseCoefficient: number;

  // -- propulsion -----------------------------------------------------------
  /** Static thrust at sea level with every engine at full power, newtons. */
  readonly thrustStatic: number;
  /** Speed at which the thrust curve reaches zero, m/s. */
  readonly thrustZeroSpeed: number;
  /**
   * Shape of the thrust curve, `1 - (V / thrustZeroSpeed) ^ exponent`.
   *
   * 2 for a propeller, whose thrust falls away sharply as the blades unload;
   * 1 with a very large `thrustZeroSpeed` for a turbofan, which is the flat
   * curve the brief asks for expressed through the same formula rather than a
   * second one.
   */
  readonly thrustExponent: number;
  /** Thrust at the idle stop, as a fraction of static. A jet never stops pushing. */
  readonly idleFraction: number;
  /** Throttle travel per second. A turbofan spools slowly and it matters. */
  readonly spoolRate: number;
  readonly propMounts: readonly PropMount[];

  // -- pitch ----------------------------------------------------------------
  /** `Cm_de * de_max`: pitching moment coefficient at full elevator. */
  readonly elevatorPower: number;
  /** Static longitudinal stability, per radian. Negative is stable. */
  readonly cmAlpha: number;
  /** Pitch damping, `Cmq`. Negative. */
  readonly cmq: number;
  /** Angle of attack the airframe trims to hands-off. */
  readonly alphaTrim: number;

  // -- roll -----------------------------------------------------------------
  /** `Cl_da * da_max`. Chosen from a target non-dimensional roll rate; see below. */
  readonly aileronPower: number;
  /** Roll damping, `Clp`. Negative. */
  readonly clp: number;
  /** Dihedral effect, `Cl_beta`. Negative: sideslip to the right rolls left. */
  readonly clBeta: number;

  // -- yaw ------------------------------------------------------------------
  /** `Cn_dr * dr_max`. */
  readonly rudderPower: number;
  /** Weathercock stability, `Cn_beta`. Positive. */
  readonly cnBeta: number;
  /** Yaw damping, `Cnr`. Negative. */
  readonly cnr: number;
  /** Side force from sideslip, `Cy_beta`. Negative. */
  readonly cyBeta: number;

  // -- undercarriage --------------------------------------------------------
  /** Height of the centre of gravity above the wheels, metres. */
  readonly gearHeight: number;
  /**
   * Distance from the centre of gravity back to the main wheels, metres.
   *
   * This is what sets the rotation speed. The weight on the wheels acting
   * through this arm is a nose-down moment; the elevator has to beat it, and
   * the speed at which it does is Vr - emergent, not a threshold.
   */
  readonly mainGearArm: number;
  /** Pitch attitude sitting on the ground, radians. */
  readonly groundPitch: number;
  /** Largest nose-up attitude before the tail would strike, radians. */
  readonly maxRotation: number;
  /** Nose wheel to main wheels, metres. Steering geometry. */
  readonly wheelBase: number;
  /** Rolling resistance coefficient. */
  readonly rollMu: number;
  /** Braking friction coefficient on dry concrete. */
  readonly brakeMu: number;
  /** Sideways tyre friction. What stops an aeroplane sliding off a taxiway. */
  readonly tyreSideMu: number;
  /** Full nose-wheel deflection, radians. */
  readonly maxSteerAngle: number;
  /**
   * Speed above which the nose-wheel steering has faded out entirely, m/s.
   *
   * The rudder is taking over across this band. Below it the aeroplane steers
   * like a tricycle; above it, like an aeroplane.
   */
  readonly steerFadeSpeed: number;
  /** How hard the nose wheel drags the yaw rate onto its geometric target. */
  readonly steerStiffness: number;

  // -- limits ---------------------------------------------------------------
  /** Descent rate at touchdown above which the landing is FIRM, m/s. */
  readonly gearLimitVs: number;
  /** Descent rate at touchdown above which the gear fails, m/s. */
  readonly crashVs: number;
  /** Speed of a solid impact that writes the airframe off, m/s. */
  readonly impactCrashSpeed: number;

  // -- reference figures, for the tests -------------------------------------
  /** Published cruise, m/s at sea level. */
  readonly referenceCruise: number;
  /** Published maximum level speed, m/s at sea level. */
  readonly referenceMaxSpeed: number;

  // -- presentation ---------------------------------------------------------
  /** Beyond this the aircraft is not drawn, metres. See `AircraftSystem`. */
  readonly cullDistance: number;
  /** Half-extent along the nose-tail axis, for `CollisionWorld.blockedBox`. */
  readonly halfLength: number;
  /** Half-extent across the wings. The wings are what hits the hangar. */
  readonly halfWidth: number;
}

/** ISA sea-level density, kg/m^3. */
export const SEA_LEVEL_DENSITY = 1.225;
export const GRAVITY = 9.80665;

/**
 * The authored half of a spec. Everything omitted is derived by `define`
 * below, so a number can never be written down twice and drift.
 */
interface Blueprint
  extends Omit<
    AircraftSpec,
    | 'chord'
    | 'aspectRatio'
    | 'inertiaRoll'
    | 'inertiaPitch'
    | 'inertiaYaw'
    | 'inducedK'
    | 'clMax'
    | 'halfLength'
    | 'halfWidth'
  > {
  /** Oswald efficiency. Only used to derive `inducedK`. */
  readonly oswald: number;
  /**
   * Radius of gyration in roll, as a fraction of the semi-span.
   *
   * Checked against published inertias: 0.21 reproduces the Cessna 172's
   * 1285 kg m^2 to within five per cent, and 0.26 reproduces the A320's
   * 1.4e6 kg m^2. It is the standard way to size an inertia from a span.
   */
  readonly gyrationRoll: number;
  /** The same, in pitch, as a fraction of the half-length. */
  readonly gyrationPitch: number;
}

function define(blueprint: Blueprint): AircraftSpec {
  const { oswald, gyrationRoll, gyrationPitch, ...rest } = blueprint;
  const aspectRatio = (blueprint.span * blueprint.span) / blueprint.wingArea;
  const inertiaRoll = blueprint.mass * (blueprint.span * 0.5 * gyrationRoll) ** 2;
  const inertiaPitch = blueprint.mass * (blueprint.length * 0.5 * gyrationPitch) ** 2;
  return {
    ...rest,
    aspectRatio,
    chord: blueprint.wingArea / blueprint.span,
    inducedK: 1 / (Math.PI * aspectRatio * oswald),
    clMax: blueprint.clAlpha * blueprint.alphaStall,
    inertiaRoll,
    inertiaPitch,
    // A flat body: the yaw inertia is very nearly the sum of the other two.
    inertiaYaw: inertiaRoll + inertiaPitch,
    halfLength: blueprint.length * 0.5,
    halfWidth: blueprint.span * 0.5,
  };
}

/**
 * Light single, fixed gear. A Cessna 172.
 *
 * Forgiving on purpose and by construction rather than by exception: the
 * highest CLmax of the four, the lowest wing loading (62 kg/m^2 against the
 * Learjet's 249), the gentlest stall band and the most static stability. It
 * flies at 25 m/s and floats.
 */
const CESSNA = define({
  type: 'cessna',
  label: 'Light single',
  modelUrl: 'models/aircraft/cessna.glb',
  engine: 'piston',
  flyable: true,
  groundedReason: null,

  span: 11.0,
  length: 8.3,
  height: 2.72,
  wingArea: 16.2,
  oswald: 0.75,

  mass: 1010,
  maxMass: 1110,
  gyrationRoll: 0.21,
  gyrationPitch: 0.33,

  clZero: 0.25,
  clAlpha: 5.3,
  alphaStall: 0.3,
  stallWidth: 0.15,

  // Struts, a fixed undercarriage and a blunt cowling: the draggiest of the
  // four by a wide margin, which is also why it is the slowest.
  cd0: 0.035,
  cd0Gear: 0,
  retractableGear: false,
  gearTransit: 0,
  dragRiseSpeed: 72,
  dragRiseCoefficient: 1.4,

  // 2400 N static is a measured figure for a 160 hp fixed-pitch installation:
  // T/W of 0.22 at MTOW. Thrust reaches zero at 95 m/s, which is what holds
  // the top speed near the published 126 kt without a speed clamp.
  thrustStatic: 2400,
  thrustZeroSpeed: 95,
  thrustExponent: 2,
  idleFraction: 0.02,
  spoolRate: 1.5,
  // Spinner on the nose, 1.25 m up: a 0.95 m blade clears the ground by 0.30 m.
  propMounts: [{ along: 3.5, side: 0, up: 1.25, radius: 0.95 }],

  elevatorPower: 0.34,
  cmAlpha: -0.9,
  cmq: -14,
  alphaTrim: 0,

  // Target non-dimensional roll rate pb/2V = 0.09, which is 53 deg/s at
  // cruise - a Cessna's measured full-aileron rate.
  aileronPower: 0.0423,
  clp: -0.47,
  clBeta: -0.09,

  rudderPower: 0.045,
  cnBeta: 0.075,
  cnr: -0.1,
  cyBeta: -0.31,

  gearHeight: 1.15,
  mainGearArm: 0.4,
  groundPitch: 0,
  maxRotation: 0.2,
  wheelBase: 1.65,
  rollMu: 0.02,
  brakeMu: 0.45,
  tyreSideMu: 0.7,
  maxSteerAngle: 0.5,
  steerFadeSpeed: 22,
  steerStiffness: 6,

  gearLimitVs: 3.0,
  crashVs: 6.0,
  impactCrashSpeed: 14,

  referenceCruise: 57,
  referenceMaxSpeed: 63,

  cullDistance: 640,
});

/**
 * Light twin turboprop. A King Air 350.
 *
 * A long, high aspect-ratio wing (13.1) makes it the most efficient of the
 * four: it has the lowest induced drag and climbs hard. Retractable gear, so
 * leaving it down costs a measurable 0.022 of CD0.
 */
const TWIN = define({
  type: 'twin',
  label: 'Light twin',
  modelUrl: 'models/aircraft/twin.glb',
  engine: 'turboprop',
  flyable: true,
  groundedReason: null,

  span: 19.8,
  length: 15.8,
  height: 4.4,
  wingArea: 30,
  oswald: 0.8,

  mass: 4700,
  maxMass: 5670,
  gyrationRoll: 0.21,
  gyrationPitch: 0.28,

  clZero: 0.22,
  clAlpha: 5.4,
  alphaStall: 0.29,
  stallWidth: 0.14,

  cd0: 0.026,
  cd0Gear: 0.022,
  retractableGear: true,
  gearTransit: 6,
  dragRiseSpeed: 120,
  dragRiseCoefficient: 1.2,

  // Two 1050 shp turboprops. 14 kN static was solved backwards from a King
  // Air's measured 700 m ground roll to 100 kt at 6800 kg, then applied here.
  thrustStatic: 14000,
  thrustZeroSpeed: 185,
  thrustExponent: 2,
  idleFraction: 0.03,
  spoolRate: 0.9,
  // Nacelles at 17 per cent of span from the centreline, 2.1 m up.
  propMounts: [
    { along: 2.2, side: -3.4, up: 2.1, radius: 1.35 },
    { along: 2.2, side: 3.4, up: 2.1, radius: 1.35 },
  ],

  elevatorPower: 0.32,
  cmAlpha: -1.0,
  cmq: -15,
  alphaTrim: 0,

  aileronPower: 0.035,
  clp: -0.5,
  clBeta: -0.11,

  rudderPower: 0.05,
  cnBeta: 0.09,
  cnr: -0.12,
  cyBeta: -0.4,

  gearHeight: 1.65,
  mainGearArm: 0.45,
  groundPitch: 0,
  maxRotation: 0.17,
  wheelBase: 4.6,
  rollMu: 0.02,
  brakeMu: 0.45,
  tyreSideMu: 0.7,
  maxSteerAngle: 0.35,
  steerFadeSpeed: 32,
  steerStiffness: 6,

  gearLimitVs: 2.7,
  crashVs: 5.0,
  impactCrashSpeed: 12,

  referenceCruise: 105,
  referenceMaxSpeed: 130,

  cullDistance: 900,
});

/**
 * Business jet. A Learjet 45.
 *
 * Slippery is the whole point: CD0 of 0.020 against the Cessna's 0.035, the
 * least static stability of the four, the highest wing loading, and a turbofan
 * that takes four seconds to spool. It stalls at 55 m/s and it does not slow
 * down when you close the throttle, which is what makes it need real speed and
 * real planning on a 600 m strip.
 */
const JET = define({
  type: 'jet',
  label: 'Business jet',
  modelUrl: 'models/aircraft/jet.glb',
  engine: 'turbofan',
  flyable: true,
  groundedReason: null,

  span: 15.6,
  length: 17.2,
  height: 4.3,
  wingArea: 28.9,
  oswald: 0.8,

  mass: 7200,
  maxMass: 9500,
  gyrationRoll: 0.25,
  gyrationPitch: 0.24,

  clZero: 0.1,
  clAlpha: 5.0,
  alphaStall: 0.265,
  // The sharpest stall of the four: a swept-ish jet wing lets go quickly.
  stallWidth: 0.1,

  cd0: 0.02,
  cd0Gear: 0.02,
  retractableGear: true,
  gearTransit: 7,
  // Vmo is 330 kt; the rise starts just above it at 165 m/s and is what holds
  // the sea-level maximum near 365 kt instead of the 486 kt bare thrust gives.
  dragRiseSpeed: 165,
  dragRiseCoefficient: 0.9,

  // Two 15.6 kN turbofans. Exponent 1 with a 900 m/s zero-thrust speed is a
  // nearly flat curve - the same formula the propellers use, with the numbers
  // that make it behave like a fan.
  thrustStatic: 31200,
  thrustZeroSpeed: 900,
  thrustExponent: 1,
  idleFraction: 0.055,
  spoolRate: 0.25,
  // Fans on the rear fuselage, above the wing, as a Learjet carries them.
  propMounts: [
    { along: -4.0, side: -1.5, up: 3.0, radius: 0.55 },
    { along: -4.0, side: 1.5, up: 3.0, radius: 0.55 },
  ],

  elevatorPower: 0.3,
  cmAlpha: -0.8,
  cmq: -16,
  alphaTrim: 0,

  aileronPower: 0.0294,
  clp: -0.42,
  clBeta: -0.06,

  rudderPower: 0.055,
  cnBeta: 0.1,
  cnr: -0.14,
  cyBeta: -0.6,

  gearHeight: 1.55,
  mainGearArm: 0.5,
  groundPitch: 0,
  maxRotation: 0.16,
  wheelBase: 6.5,
  rollMu: 0.02,
  // Carbon brakes on dry concrete. This is what stops it inside the runway.
  brakeMu: 0.5,
  tyreSideMu: 0.75,
  maxSteerAngle: 0.28,
  steerFadeSpeed: 40,
  steerStiffness: 6,

  gearLimitVs: 2.6,
  crashVs: 4.6,
  impactCrashSpeed: 11,

  referenceCruise: 165,
  referenceMaxSpeed: 190,

  cullDistance: 900,
});

/**
 * Narrowbody airliner. An Airbus A320.
 *
 * Simulated in full and never flown by the player - see the file header for
 * the measurement. It is on the heavy stand because a regional field with no
 * airliner on it looks like a model railway, and because it is the thing that
 * makes the runway read as short.
 */
const LINER = define({
  type: 'liner',
  label: 'Narrowbody airliner',
  modelUrl: 'models/aircraft/liner.glb',
  engine: 'turbofan',
  flyable: false,
  groundedReason:
    'needs about 1100 m of ground roll at 64 t; Meridian Bay Regional has 600 m',

  span: 35.8,
  length: 39.5,
  height: 11.76,
  wingArea: 122.6,
  oswald: 0.8,

  mass: 64000,
  maxMass: 79000,
  gyrationRoll: 0.26,
  gyrationPitch: 0.37,

  clZero: 0.12,
  clAlpha: 5.2,
  alphaStall: 0.26,
  stallWidth: 0.12,

  cd0: 0.021,
  cd0Gear: 0.02,
  retractableGear: true,
  gearTransit: 10,
  dragRiseSpeed: 175,
  dragRiseCoefficient: 0.9,

  thrustStatic: 240000,
  thrustZeroSpeed: 900,
  thrustExponent: 1,
  idleFraction: 0.05,
  spoolRate: 0.18,
  // Under the wing at 6 m from the centreline, fan centre 1.9 m up.
  propMounts: [
    { along: 2.5, side: -6.0, up: 1.9, radius: 0.95 },
    { along: 2.5, side: 6.0, up: 1.9, radius: 0.95 },
  ],

  elevatorPower: 0.26,
  cmAlpha: -1.1,
  cmq: -18,
  alphaTrim: 0,

  aileronPower: 0.0225,
  clp: -0.45,
  clBeta: -0.1,

  rudderPower: 0.06,
  cnBeta: 0.12,
  cnr: -0.15,
  cyBeta: -0.9,

  gearHeight: 3.6,
  mainGearArm: 0.9,
  groundPitch: 0,
  maxRotation: 0.2,
  wheelBase: 12.6,
  rollMu: 0.02,
  brakeMu: 0.45,
  tyreSideMu: 0.75,
  maxSteerAngle: 0.2,
  steerFadeSpeed: 45,
  steerStiffness: 6,

  gearLimitVs: 3.0,
  crashVs: 4.5,
  impactCrashSpeed: 10,

  referenceCruise: 185,
  referenceMaxSpeed: 205,

  cullDistance: 950,
});

export const AIRCRAFT: Readonly<Record<AircraftType, AircraftSpec>> = {
  cessna: CESSNA,
  twin: TWIN,
  jet: JET,
  liner: LINER,
};

export const ALL_AIRCRAFT_TYPES: readonly AircraftType[] = ['cessna', 'twin', 'jet', 'liner'];

/** The types the player may actually take. See `liner.groundedReason`. */
export const FLYABLE_AIRCRAFT_TYPES: readonly AircraftType[] = ALL_AIRCRAFT_TYPES.filter(
  (type) => AIRCRAFT[type].flyable,
);

/**
 * Wing loading, N/m^2. The single number that most predicts how an aircraft
 * feels: 611 for the Cessna against 2444 for the Learjet.
 */
export function wingLoading(spec: AircraftSpec): number {
  return (spec.mass * GRAVITY) / spec.wingArea;
}

/** Level, wings-level stall speed at the given density, m/s. */
export function stallSpeed(spec: AircraftSpec, density = SEA_LEVEL_DENSITY): number {
  return Math.sqrt((2 * spec.mass * GRAVITY) / (density * spec.wingArea * spec.clMax));
}

/**
 * Rotation speed, m/s.
 *
 * 1.12 Vs is the conventional figure and is what the catalogue advertises, but
 * it is NOT what the model uses: the nose comes up when the elevator beats the
 * weight on the nose wheel, which `tests/flight.test.ts` measures separately.
 * The two agree to within a few per cent by construction - see `mainGearArm`.
 */
export function rotateSpeed(spec: AircraftSpec, density = SEA_LEVEL_DENSITY): number {
  return 1.12 * stallSpeed(spec, density);
}

/** Threshold speed on approach, 1.3 Vs, m/s. */
export function approachSpeed(spec: AircraftSpec, density = SEA_LEVEL_DENSITY): number {
  return 1.3 * stallSpeed(spec, density);
}

/** Best-guess never-exceed speed: where the drag rise has properly bitten. */
export function neverExceedSpeed(spec: AircraftSpec): number {
  return spec.dragRiseSpeed * 1.2;
}
