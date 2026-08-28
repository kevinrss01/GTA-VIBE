/**
 * The traffic system's public contract.
 *
 * Everything outside `src/traffic` that needs to know about a car - the
 * pedestrian crowd deciding whether it is safe to step off a kerb, the player
 * controller resolving a collision, a future driving layer taking a car over -
 * reads a `VehicleView` and nothing else. Keeping that surface small and
 * geometric (position, heading, half-extents) is what lets the internals stay
 * free to change.
 *
 * COORDINATES: +X east, +Z south, +Y up, 1 unit = 1 metre. Yaw follows the
 * game's convention, where forward is `(-sin yaw, 0, -cos yaw)`, so yaw 0 faces
 * north (-Z) and -PI/2 faces east (+X). The vehicle's local axes after that
 * yaw are: -Z forward, +X to the driver's right, +Y up.
 */

/**
 * One body shell. These are the silhouettes a street is built from; the
 * catalogue in `VehicleCatalogue.ts` gives each one its proportions, its paint
 * range and how often it appears.
 */
export type VehicleKind =
  | 'compact'
  | 'sedan'
  | 'coupe'
  | 'wagon'
  | 'crossover'
  | 'pickup'
  | 'van'
  | 'boxTruck'
  | 'taxi'
  | 'patrolSedan'
  | 'patrolSuv';

/**
 * Who is driving.
 *
 * `ambient` runs the traffic AI. `player` is a pose written from outside every
 * frame - the driven car, and every police unit. `loose` is neither: the
 * vehicle has been hit hard enough to leave its lane and is integrating as a
 * free body until it comes to rest, at which point it rejoins traffic or is
 * written off. See `TrafficSim.stepLoose`.
 */
export type VehicleControl = 'ambient' | 'player' | 'loose';

/**
 * Structural points a vehicle starts with, and the scale every system that
 * damages one must speak.
 *
 * The number is the police system's original `VEHICLE_INTEGRITY` - roughly
 * three rifle magazines - kept exactly so that a patrol car and an ordinary
 * car are equally tough. There is one damage model in this game, not two.
 */
export const VEHICLE_INTEGRITY = 260;

/**
 * Structural damage from a collision impulse, in the scale above.
 *
 * Calibrated against one number: a 15 m/s closing hit between two 1400 kg cars
 * transfers about 12 kN.s, and that is the crash a car does not drive away
 * from. Everything else follows - a 3 m/s parking shunt costs a fifth of the
 * shell, a 25 m/s head-on writes off both.
 */
export function impactDamage(impulse: number): number {
  return Math.max(0, impulse) * (VEHICLE_INTEGRITY / 12000);
}

/**
 * One collision, as the thing that detected it describes it.
 *
 * The direction and the contact point are what separate a shunt from a spin:
 * `applyImpact` turns them into linear velocity, yaw and - if the hit is high
 * and lateral enough for the track width to give up - roll.
 */
export interface VehicleImpact {
  /** World contact point. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Unit direction the impulse pushes the vehicle. */
  readonly dirX: number;
  readonly dirZ: number;
  /** Impulse magnitude, newton-seconds. Scale from mass * closing speed. */
  readonly impulse: number;
  /** Structural damage, in the `VEHICLE_INTEGRITY` scale. */
  readonly damage: number;
}

/** What an impact sounded like, for whoever is wiring audio to it. */
export interface ImpactReport {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 0 for a nudge, 1 for a write-off. Drives the sample and its gain. */
  readonly intensity: number;
  readonly kind: 'vehicle' | 'world';
}

/**
 * A read-only snapshot of one vehicle.
 *
 * `x`, `y`, `z` are the centre of the vehicle's oriented bounding box, so the
 * box is symmetric about that point and the ground contact plane is
 * `y - halfHeight`. The box is oriented by `yaw` alone: `pitch` and `roll` are
 * the body's lean and the slope of the road under it, and are small enough
 * (a few degrees) that no consumer needs to include them in a broad-phase
 * test - they are exposed for anything that wants to match the visual exactly.
 *
 * Views are live objects owned by the traffic system and mutated in place each
 * frame. Read them during the frame; never retain or mutate one.
 */
export interface VehicleView {
  /** Stable for the lifetime of one vehicle; reused after recycling. */
  readonly id: number;
  readonly kind: VehicleKind;
  /** True for the patrol variants, which are ordinary traffic here. */
  readonly police: boolean;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  /** Nose-to-tail half-extent, along the vehicle's forward axis. */
  readonly halfLength: number;
  /** Half-extent across the vehicle, mirrors excluded. */
  readonly halfWidth: number;
  readonly halfHeight: number;
  /** Forward speed in metres per second; never negative for ambient traffic. */
  readonly speed: number;
  /** Nose-up radians: negative under braking. Body lean plus road slope. */
  readonly pitch: number;
  /** Right-side-up radians: negative when leaning into a left-hand bend. */
  readonly roll: number;
  /** True while the brake lights are lit. */
  readonly braking: boolean;
  /**
   * Longitudinal acceleration, m/s². Negative under braking.
   *
   * Published because `braking` is a LAMP, not a force: the lights come on at
   * 0.55 m/s² of lift-off, which is most of what a car in traffic does all day
   * and nothing like hard enough to make a tyre squeal. Anything deciding how
   * violently a car is stopping has to read this instead.
   */
  readonly accelLong: number;
  readonly control: VehicleControl;
  /**
   * Structural points remaining, out of `VEHICLE_INTEGRITY`. Zero is a
   * write-off: the shell is still there, it just cannot be driven again.
   */
  readonly integrity: number;
  /** The same thing as a fraction, 0 undamaged to 1 written off. */
  readonly damage: number;
  /**
   * True once the body has come to rest on its side or its roof. An overturned
   * car never rejoins traffic and is never worth taking control of.
   */
  readonly overturned: boolean;
}

/**
 * Anything traffic must not drive into: a pedestrian, the player on foot, a
 * player-driven car. Obstacles are supplied per frame by the owner of the
 * thing that moves; the traffic system never reaches into another system.
 */
export interface TrafficObstacle {
  readonly x: number;
  readonly z: number;
  /** Plan-view radius in metres. A pedestrian is about 0.35. */
  readonly radius: number;
}

/** Where the camera is, and the shared clock the signals run on. */
export interface TrafficContext {
  readonly x: number;
  readonly z: number;
  /** Seconds since world start. Must be the same clock `signalFor` is given. */
  readonly time: number;
}

/**
 * Handle returned by `TrafficSystem.takeControl`.
 *
 * The traffic system keeps drawing the vehicle and keeps other drivers aware
 * of it, but stops steering it. The holder writes a new pose every frame and
 * the renderer follows. See `docs` in `TrafficSystem` for the full handover.
 */
export interface VehicleHandle {
  readonly id: number;
  readonly kind: VehicleKind;
  readonly view: VehicleView;
  /** Wheelbase, track, mass and grip limits, so a driving layer can reuse them. */
  readonly chassis: ChassisSpec;
  /**
   * Sets the pose the renderer will draw. `speed` and `steer` drive the wheel
   * spin, the steered front wheels and the brake lights; they do not move the
   * vehicle, the caller does.
   */
  setPose(pose: {
    x: number;
    z: number;
    yaw: number;
    speed: number;
    steer?: number;
    braking?: boolean;
  }): void;
  /** Returns the vehicle to ambient control on the nearest lane, or recycles it. */
  release(): void;
}

/** The physical numbers a driving model needs. All SI. */
export interface ChassisSpec {
  readonly length: number;
  readonly width: number;
  readonly height: number;
  /** Front-axle to rear-axle distance. */
  readonly wheelbase: number;
  readonly track: number;
  readonly wheelRadius: number;
  /** Distance from the vehicle centre to the front axle, positive forward. */
  readonly frontAxle: number;
  readonly mass: number;
  readonly maxSteer: number;
  /** Steering rate limit at rest, radians per second. */
  readonly steerRate: number;
  readonly accelMax: number;
  readonly brakeMax: number;
  /** Lateral acceleration the tyres hold before the model gives up grip. */
  readonly gripLateral: number;
}
