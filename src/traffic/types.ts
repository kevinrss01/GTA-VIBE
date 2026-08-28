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
 * frame - the driven car, and every police unit. `loose` is neither: nobody is
 * driving, and the body is where the physics left it. See `TrafficSim`.
 */
export type VehicleControl = 'ambient' | 'player' | 'loose';

/**
 * What the vehicle actually IS, which `control` alone cannot say.
 *
 * `control` answers "who is driving", and for both a car still rolling to a
 * stop after a crash and a car the player parked and walked away from the
 * answer is the same: nobody, which is what `'loose'` has always meant. The
 * two are nothing alike in every other respect, though - one is mid-episode
 * and will either rejoin traffic or be written off within seconds, the other
 * is finished and must stay exactly where it was left - so anything that cares
 * about the difference reads this instead.
 *
 *  - `ambient`  the traffic AI is driving it.
 *  - `player`   somebody outside writes its pose each frame.
 *  - `loose`    knocked out of its lane, integrating until it comes to rest.
 *  - `parked`   at rest and staying there: abandoned by the player, or a
 *               burnt-out wreck. It never rejoins traffic and never moves
 *               again unless something hits it hard enough to free it.
 *
 * `VehicleView.control` publishes `'loose'` for a parked vehicle, because that
 * is the honest answer to the question `control` asks and it keeps every
 * existing consumer - which all test `=== 'ambient'` or `=== 'player'` -
 * correct without knowing this type exists.
 */
export type VehicleState = 'ambient' | 'player' | 'loose' | 'parked';

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

// -- localized damage -------------------------------------------------------

/**
 * Points ONE region of the shell absorbs before it is destroyed.
 *
 * Deliberately larger than a quarter of `VEHICLE_INTEGRITY`: the regions are a
 * second, finer accounting of the same events the integrity total records, not
 * a partition of it. A car can lose its engine bay long before it is written
 * off, which is the whole point - the engine is what stops working first.
 *
 * At 156 points a carbine (34 a round) needs five rounds concentrated on the
 * bonnet to kill the engine, by which time the shell has lost 170 of its 260
 * points and is visibly wrecked but still standing. Spread over the whole car
 * the same five rounds destroy nothing.
 */
export const REGION_CAPACITY = VEHICLE_INTEGRITY * 0.6;
/** Points one tyre takes before it is flat. One rifle round, near enough. */
export const TYRE_CAPACITY = 30;
/** Points the glazing takes before every window is out. */
export const GLASS_CAPACITY = 40;

/**
 * How wrecked the engine bay has to be before power starts going, and before
 * it has gone entirely. Between the two the car loses power in proportion.
 */
export const ENGINE_SOFT = 0.55;
export const ENGINE_DEAD = 1.0;
/** Lateral grip a single flat tyre costs, as a fraction. */
export const TYRE_GRIP_LOSS = 0.22;
/** Steering bias one flat tyre drags in, radians. Positive steers left. */
export const TYRE_PULL = 0.055;

/**
 * The share of the shell one blow has to cost before it is a blast rather than
 * a bullet.
 *
 * A rifle round is 34 points of 260, or 0.13; the launcher's warhead is 190,
 * or 0.73. Nothing between them exists, so a single threshold cleanly
 * separates "something hit this panel" from "the whole side of the car was in
 * the fireball" - and that is what decides whether the glazing goes, whether
 * the tyres on the struck side are shredded, and how far the damage spreads
 * from the point of contact.
 */
export const BLAST_SHARE = 0.25;

/**
 * How badly each part of one shell is damaged, 0 undamaged to 1 destroyed.
 *
 * Regions are in the vehicle's own frame: `front` is the engine bay and the
 * nose, `rear` the boot and tail, `left` and `right` the flanks as the driver
 * sees them. `tyres` is one entry per corner in the order the renderer draws
 * them - front left, front right, rear left, rear right.
 *
 * Live objects owned by the traffic system and mutated in place. Read them
 * during the frame; never retain or mutate one.
 */
export interface VehicleDamageRegions {
  readonly front: number;
  readonly rear: number;
  readonly left: number;
  readonly right: number;
  readonly glass: number;
  readonly tyres: readonly number[];
}

/**
 * What the damage above does to the way the car drives.
 *
 * Derived from the regions rather than stored, so there is one rule and both
 * the traffic AI and the player's own driving layer obey it.
 */
export interface VehicleHandling {
  /** Engine power available, 1 undamaged to 0 dead. */
  readonly power: number;
  /** Lateral grip available, as a fraction of the chassis figure. */
  readonly grip: number;
  /** Steering bias in radians from uneven tyres. Positive pulls left. */
  readonly pull: number;
  /** True once the shell is a write-off: no power, no recovery. */
  readonly destroyed: boolean;
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
   * The finer answer `control` cannot give: in particular whether this car is
   * mid-crash or has been left where it is. See `VehicleState`.
   */
  readonly state: VehicleState;
  /**
   * Structural points remaining, out of `VEHICLE_INTEGRITY`. Zero is a
   * write-off: the shell is still there, it just cannot be driven again.
   */
  readonly integrity: number;
  /** The same thing as a fraction, 0 undamaged to 1 written off. */
  readonly damage: number;
  /** `integrity <= 0`. Published so nothing has to know the scale to ask. */
  readonly destroyed: boolean;
  /** Where the damage actually is. See `VehicleDamageRegions`. */
  readonly regions: VehicleDamageRegions;
  /** What that damage does to the driving. See `VehicleHandling`. */
  readonly handling: VehicleHandling;
  /** Engine smoke, 0 none to 1 pouring. Rises with engine-bay damage. */
  readonly smoke: number;
  /** Fire, 0 out to 1 fully alight. Only ever non-zero on a write-off. */
  readonly fire: number;
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
  /**
   * Gives the vehicle up. It stays EXACTLY where it was left.
   *
   * A car with nobody in it does not drive off, so releasing parks it: same
   * position, same heading, same damage, whatever speed it still had bled off
   * against the road rather than zeroed. It never rejoins the traffic AI, and
   * the player can get back into it. See `TrafficSystem.releaseControl`.
   */
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
