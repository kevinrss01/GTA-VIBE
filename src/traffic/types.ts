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

/** Who is driving. Ambient cars run the traffic AI; player cars do not. */
export type VehicleControl = 'ambient' | 'player';

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
  readonly control: VehicleControl;
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
