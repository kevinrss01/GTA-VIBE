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
 * Velocity change, m/s, a shell absorbs without yielding anything.
 *
 * The bumper beam and its crush cans are designed to eat a low-speed shunt and
 * spring back, which is why a car park is not a scrapyard. 2 m/s of delta-v is
 * a 7 km/h barrier hit - the regulatory bumper test is slower still - and
 * below it nothing structural has happened.
 */
export const YIELD_DELTA_V = 2;

/**
 * Velocity change, m/s, that costs a shell all of `VEHICLE_INTEGRITY` at once.
 *
 * 8.5 m/s is a 31 km/h barrier-equivalent crash: past the delta-v where
 * restraint systems fire and injury risk climbs steeply, and comfortably the
 * point at which nobody drives the car home.
 */
export const WRITE_OFF_DELTA_V = 8.5;

/**
 * Share of the shell a hit right at `YIELD_DELTA_V` costs in paint alone.
 *
 * Not structure: this is the scrape down the wing that a shunt leaves and the
 * crush cans do not. Small enough that a car park cannot write a car off in
 * any plausible number of bumps, large enough that a car which has been used
 * badly looks it.
 */
export const SCUFF_SHARE = 0.01;

/** One collision, from the point of view of the single shell being damaged. */
export interface CollisionSeverity {
  /**
   * This vehicle's own velocity change, m/s: `impulse / mass`, the number
   * `applyImpact` already computes to move it. Never negative.
   */
  readonly deltaV: number;
  /**
   * The share of that delta-v the structure has to absorb, 0 to 1. See
   * `crushShare`; 1 - a square, central hit - when the caller cannot say.
   */
  readonly crush?: number;
}

/**
 * Structural damage from one collision, in the `VEHICLE_INTEGRITY` scale.
 *
 * SEVERITY IS DELTA-V, NOT IMPULSE. The same 12 kN.s writes off a hatchback
 * and barely marks a box truck, so an impulse on its own cannot say how badly
 * one particular shell was hurt - but the velocity change it caused THAT shell
 * can, and it is what crash reconstruction uses for exactly this reason: it is
 * the barrier-equivalent velocity, the speed at which driving into a rigid
 * wall would have done the same damage.
 *
 * Two properties matter, and the previous mapping - damage linear in impulse,
 * from zero - had neither:
 *
 *  - A DEADBAND. Below `YIELD_DELTA_V` the crush structure absorbs the whole
 *    event, so an ordinary parking shunt costs paint and nothing else.
 *  - A SUPERLINEAR RESPONSE. Past that point the shell has to absorb energy,
 *    which goes as the SQUARE of the excess, so a serious crash is worth far
 *    more than the several small ones that carry the same total impulse.
 *
 * Calibrated against the collisions this game actually produces. Two 1400 kg
 * cars with `CAR_RESTITUTION` 0.15 give each car a delta-v of 1.15 * closing
 * / 2, and a square hit crushes all of it:
 *
 *   closing    delta-v   damage   of the shell   condition afterwards
 *   3 m/s      1.7       1.9      0.7 %          pristine, drivable
 *   5 m/s      2.9       7        3 %            pristine, drivable
 *   8 m/s      4.6       44       17 %           scuffed, drivable
 *   8 m/s x 3  -         133      51 %           damaged, drivable
 *   8 m/s x 6  -         265      102 %          wrecked
 *   12 m/s     6.9       150      58 %           damaged, drivable
 *   15 m/s     8.6       273      105 %          wrecked
 *   22 m/s     12.7      701      270 %          wrecked outright
 *
 * A vehicle hitting immovable geometry passes the speed it lost to it, which
 * is the same quantity: hitting a wall at 8 m/s is an 8 m/s delta-v, worth
 * far more than an 8 m/s closing speed shared between two cars that both give.
 */
export function collisionDamage(hit: CollisionSeverity): number {
  const crush = hit.crush === undefined ? 1 : clamp01(hit.crush);
  const absorbed = Math.max(0, hit.deltaV) * crush;
  if (absorbed <= 0) return 0;
  const elastic = Math.min(absorbed, YIELD_DELTA_V) / YIELD_DELTA_V;
  const scuff = VEHICLE_INTEGRITY * SCUFF_SHARE * elastic * elastic;
  const excess = Math.max(0, absorbed - YIELD_DELTA_V);
  if (excess <= 0) return scuff;
  const span = WRITE_OFF_DELTA_V - YIELD_DELTA_V;
  const reach = excess / span;
  return scuff + VEHICLE_INTEGRITY * reach * reach;
}

/** Where a collision landed on one vehicle, and which way it pushed. */
export interface ImpactGeometry {
  /** The vehicle's centre and heading. */
  readonly centreX: number;
  readonly centreZ: number;
  readonly yaw: number;
  /** World contact point. */
  readonly x: number;
  readonly z: number;
  /** Direction the impulse pushes the vehicle. Need not be normalized. */
  readonly dirX: number;
  readonly dirZ: number;
  /** Plan dimensions of the shell, metres. */
  readonly length: number;
  readonly width: number;
}

/**
 * The share of a vehicle's delta-v that crushes structure, 0 to 1.
 *
 * A square hit through the centre of mass has nowhere else to go: all of it
 * deforms the body. A hit whose line of action misses the centre spends part
 * of itself spinning the car instead, and that part costs the shell nothing -
 * which is the whole difference between a rear-corner tap that slews the car
 * round and the same speed taken flat on the boot.
 *
 * The moment arm `d` is the perpendicular distance from the centre to the line
 * of action. A rigid box of mass m has yaw inertia m(L2 + W2)/12, so the
 * effective mass resisting the hit at that point is m / (1 + 12d2/(L2 + W2)) -
 * mass cancels, leaving pure geometry. Damage goes as absorbed ENERGY and
 * energy as delta-v squared, so the share applied to a delta-v is the square
 * root of that effective-mass ratio.
 *
 * On the 4.56 m x 1.82 m saloon in the catalogue: flat on the boot, 1.00;
 * clipped on a rear corner from behind, 0.84; shoved sideways at the nose,
 * 0.53. At the delta-v of an 8 m/s urban collision that last one costs less
 * than a tenth of what the same speed costs square on: a car that has been
 * spun round rather than stoved in.
 */
export function crushShare(contact: ImpactGeometry): number {
  const spread = contact.length * contact.length + contact.width * contact.width;
  const speed = Math.hypot(contact.dirX, contact.dirZ);
  if (!(spread > 0) || !(speed > 0)) return 1;
  // The vehicle's own axes: -Z forward, +X to the driver's right, after yaw.
  const fx = -Math.sin(contact.yaw);
  const fz = -Math.cos(contact.yaw);
  const rx = Math.cos(contact.yaw);
  const rz = -Math.sin(contact.yaw);
  const dx = contact.x - contact.centreX;
  const dz = contact.z - contact.centreZ;
  const along = dx * fx + dz * fz;
  const across = dx * rx + dz * rz;
  const dirAlong = (contact.dirX * fx + contact.dirZ * fz) / speed;
  const dirAcross = (contact.dirX * rx + contact.dirZ * rz) / speed;
  const lever = Math.abs(along * dirAcross - across * dirAlong);
  return Math.sqrt(1 / (1 + (12 * lever * lever) / spread));
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
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
 * How badly used one shell is, as a stage rather than a number.
 *
 * The fraction alone cannot answer the question anything outside actually
 * asks - can this car still be driven, and does it look like it has been in a
 * crash - because a car with a dead engine and 40 % of its shell left is in a
 * worse state than one with 60 % gone spread evenly over four panels. The
 * stages combine both accounts:
 *
 *  - `pristine`  off the forecourt.
 *  - `scuffed`   paint and panels, nothing that changes how it drives.
 *  - `damaged`   visibly in a crash, down on power or on a soft tyre.
 *  - `crippled`  still moves, but barely: no engine, flats, or a shell most
 *                of the way gone.
 *  - `wrecked`   a write-off. `handling.destroyed`, and it never drives again.
 */
export type VehicleCondition = 'pristine' | 'scuffed' | 'damaged' | 'crippled' | 'wrecked';

/** Shell fraction at which a car stops looking new. One parking shunt is less. */
export const SCUFFED_AT = 0.05;
/** Shell fraction at which it is visibly a crashed car. */
export const DAMAGED_AT = 0.3;
/** Shell fraction at which it is only just still a car. */
export const CRIPPLED_AT = 0.65;
/** Engine power at or below which the car is crippled whatever the shell says. */
export const CRIPPLED_POWER = 0.35;

/** The inputs the stage is a function of. All published on a `VehicleView`. */
export interface ConditionInputs {
  /** Shell lost, 0 to 1. */
  readonly damage: number;
  readonly destroyed: boolean;
  /** `VehicleHandling.power`. */
  readonly power: number;
  /** Tyre wear summed over the four corners, so 1 is one flat tyre. */
  readonly flats: number;
}

/** The stage above, from the two accounts the damage model keeps. */
export function vehicleCondition(state: ConditionInputs): VehicleCondition {
  if (state.destroyed) return 'wrecked';
  if (state.damage >= CRIPPLED_AT || state.power <= CRIPPLED_POWER || state.flats >= 2) {
    return 'crippled';
  }
  if (state.damage >= DAMAGED_AT || state.power < 1 || state.flats >= 1) return 'damaged';
  if (state.damage >= SCUFFED_AT) return 'scuffed';
  return 'pristine';
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
  /**
   * Impulse straight up, newton-seconds. Optional, and zero by default.
   *
   * SEPARATE FROM `impulse` RATHER THAN A THIRD COMPONENT OF THE DIRECTION,
   * deliberately. Making the direction three-dimensional would redistribute a
   * fixed magnitude between the horizontal and the vertical, so adding lift to
   * a blast would silently weaken its shove and change every horizontal number
   * that was already calibrated. This adds instead of dividing: the horizontal
   * behaviour of every existing caller is untouched by definition.
   *
   * A COLLISION HAS NONE and must not pass one - two cars meeting on a road
   * exchange momentum in the plane, and a car that hops when it is rear-ended
   * is a bug. A BLAST does: overpressure passing under a sill is what lifts,
   * rolls and overturns a car rather than merely sliding it. Negative is
   * downward, which is what a warhead arriving through the roof does.
   */
  readonly lift?: number;
  /** Impulse magnitude, newton-seconds. Scale from mass * closing speed. */
  readonly impulse: number;
  /**
   * Structural damage, in the `VEHICLE_INTEGRITY` scale.
   *
   * SEPARATE FROM THE IMPULSE ABOVE, and deliberately so: the impulse decides
   * where the car goes and this decides what it costs. A caller resolving a
   * collision fills the first from momentum and the second from
   * `collisionDamage`, and changing how hard cars are cannot change how they
   * move. Anything with no structural meaning - a shove from a blast wave -
   * passes an impulse with no damage.
   */
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
  /** The same two accounts as one legible stage. See `VehicleCondition`. */
  readonly condition: VehicleCondition;
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
    /**
     * Height above the ground, in metres, for a car a blast has thrown.
     *
     * Optional and zero by default, which is every frame of ordinary driving.
     * The driving layer integrates the arc because it owns the car's motion
     * while the player is in it; the traffic layer adds this to the ground it
     * samples, exactly as it does for an ambient body's own `hop`. Without it a
     * rocket would lift a parked car and not the identical one the player
     * happens to be sitting in.
     */
    lift?: number;
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
