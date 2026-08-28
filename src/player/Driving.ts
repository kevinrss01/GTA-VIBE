/**
 * Driving a car in Meridian Bay.
 *
 * The city already simulates its own traffic with a kinematic bicycle model
 * and a real chassis spec per vehicle. When the player takes a car, this layer
 * drives that SAME chassis with the SAME limits - `takeControl` hands over
 * `wheelbase`, `maxSteer`, `steerRate`, `accelMax`, `brakeMax` and
 * `gripLateral`, and the numbers are used as given. A car therefore feels
 * continuous with the traffic it just left: a box truck still understeers, a
 * coupe still turns in, and nothing about the handover changes how it looks to
 * the drivers around it.
 *
 * The camera stays FIRST PERSON, from the driver's seat. This game has no
 * player avatar anywhere else and a chase camera would be the only place one
 * appeared.
 *
 * COORDINATES: forward is `(-sin yaw, 0, -cos yaw)`, matching the camera.
 */

import type { PerspectiveCamera } from 'three';

import { clamp } from '../core/mathx';
import type { CityGround } from '../world/CityGround';
import type { CollisionWorld, VehicleBoxSink, VehicleContact } from './Collision';
import type { FirstPersonController } from './FirstPersonController';
import type { TrafficSystem } from '../traffic/TrafficSystem';
import { collisionDamage, crushShare } from '../traffic/types';
import type { VehicleHandle, VehicleView } from '../traffic/types';

/** How close the player must be to a car to be offered it. */
export const ENTER_RADIUS = 5.5;

/**
 * Chase camera. Distance back from the car's centre, height above the road,
 * and the height of the point it aims at.
 *
 * The camera sits behind and above the car and looks slightly down at it, the
 * way a driving game does - not from the driver's seat. It is pulled in when
 * something solid is between it and the car so it never ends up inside a wall.
 */
const CAM_DISTANCE = 6.6;
const CAM_HEIGHT = 2.75;
const CAM_LOOK_HEIGHT = 1.25;
/** Minimum boom length when the camera has to tuck in against geometry. */
const CAM_MIN_DISTANCE = 1.9;
/** How quickly the boom follows the car, per second. */
const CAM_LAG = 9;

/** Reverse is deliberately slow - this is a city car park, not a race. */
const REVERSE_SPEED = 6;
/** Engine braking felt when the driver lifts off, as a fraction of speed. */
const COAST_DRAG = 0.55;

/**
 * Hard ceiling on speed, in metres per second. A backstop, not the cruise.
 *
 * There has to be one. Without it the throttle added acceleration every frame
 * with nothing opposing it, so speed grew without bound: measured 0 to 111
 * km/h in ten seconds and still climbing, at which point one frame moved the
 * car 0.51 m - more than half its own half-width. A frame that steps further
 * than the body is wide can pass clean through a wall between two collision
 * tests, so this is a correctness limit, not a handling preference.
 *
 * In practice drag settles every vehicle well below it: solving thrust against
 * the two drag terms gives 16.9 m/s (61 km/h) for the least powerful chassis
 * up to 23.9 m/s (86 km/h) for the most, which is 0.28 to 0.40 m per frame -
 * inside `MAX_COLLISION_STEP` on its own, with the sub-stepping below as the
 * guarantee rather than the only defence. This constant is also what scales
 * the drag curve, so raising it raises every vehicle's cruise together.
 */
const TOP_SPEED = 33;

/**
 * Rolling resistance, applied at ALL times including under power. Small enough
 * that it does not feel like a handbrake, large enough that a car coasts to a
 * stop instead of gliding forever.
 */
const ROLL_DRAG = 0.14;

/**
 * Largest distance the car may move between two collision tests.
 *
 * The collision resolve checks the footprint at the END of a displacement, so
 * anything longer than this is split into several steps. Half a metre is
 * comfortably inside the narrowest body half-width in the fleet.
 */
const MAX_COLLISION_STEP = 0.45;
/** Speed below which the car is simply stopped, to kill numerical creep. */
const CREEP_EPSILON = 0.12;

/** Body collision box used against the world, in metres. */
const BODY_HEIGHT = 1.4;

/**
 * How far around the car traffic is fetched each frame, in metres.
 *
 * Two box trucks nose to nose is 7.8 m of half diagonal between them, and a car
 * at the fastest speed this model reaches covers about 0.5 m in a frame.
 */
const VEHICLE_QUERY_RADIUS = 12;

/**
 * Coefficient of restitution between two car bodies.
 *
 * Sheet metal, not rubber: almost all of the energy goes into the panels. 0.15
 * is enough for the two cars to separate afterwards rather than travel on
 * locked together, which is the only thing a higher number would buy.
 */
const CAR_RESTITUTION = 0.15;
/**
 * What the striking car pays, as a share of what its own delta-v would
 * otherwise cost it.
 *
 * The nose is the end of a car designed to be crushed, and it is pointed at
 * the impact; the panel it lands on rarely is. Slight on purpose - this is a
 * bias, not an exemption, and driving into things still wrecks the car.
 */
const STRIKER_SHARE = 0.85;
/**
 * Closing speed, m/s, below which touching another car is a nudge.
 *
 * Below this the existing block-and-scrub already does the right thing, and
 * generating an impulse for every kerb-crawling contact would have traffic
 * being knocked loose in a car park.
 */
const CONTACT_SPEED = 1.4;
/**
 * How long a yaw impulse is credited for, in seconds.
 *
 * `Driving` integrates a heading, not an angular velocity - the steering model
 * is kinematic - so a torque has to be spent as a heading change rather than
 * as a spin that decays. A quarter of a second is about how long a real body
 * takes to shed the yaw from a shunt, and it keeps the kick bounded whatever
 * the mass ratio.
 */
/**
 * Gravity, landing restitution and the lift trigger for a driven car a blast
 * threw. The same three numbers `TrafficSim` uses for an ambient body, so the
 * identical car follows the identical arc whoever is sitting in it. Kept here
 * rather than imported because they are the driving model's own constants and
 * the traffic layer does not export them.
 */
const BLAST_GRAVITY = 9.81;
const LANDING_RESTITUTION = 0.12;
const BLAST_LIFT_TRIGGER = 0.6;

const YAW_KICK_SECONDS = 0.25;
/** Ceiling on the heading a single hit may change, radians. */
const YAW_KICK_LIMIT = 0.7;

export interface DrivingOptions {
  readonly traffic: TrafficSystem;
  readonly ground: CityGround;
  readonly collision: CollisionWorld;
  readonly camera: PerspectiveCamera;
  readonly controller: FirstPersonController;
  readonly domElement: HTMLElement;
}

export interface DrivingState {
  readonly driving: boolean;
  readonly speed: number;
  readonly kind: string | null;
  readonly police: boolean;
  /** Car position, so the rest of the game can follow the player into it. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

export class Driving {
  private readonly options: DrivingOptions;
  private handle: VehicleHandle | null = null;

  private x = 0;
  private z = 0;
  private yaw = 0;
  private speed = 0;
  private steer = 0;
  /** Mouse look offset relative to the car's own heading. */
  private lookYaw = 0;
  private lookPitch = 0;
  private braking = false;
  /** Suspension state, purely for camera feel. */
  private pitchLean = 0;
  private rollLean = 0;
  /** Smoothed chase-camera position, so the boom trails rather than snaps. */
  private camX = 0;
  private camY = 0;
  private camZ = 0;

  private readonly keys = new Set<string>();

  /**
   * Where the last sub-step was refused, reused every frame so the collision
   * resolve allocates nothing. `id` is -1 whenever a vehicle was not involved.
   */
  private readonly contact: VehicleContact = { id: -1, x: 0, y: 0, z: 0 };

  /**
   * Traffic, as the collision world wants to see it.
   *
   * `Driving` is the only player-side module that holds the traffic system, so
   * it is the one that can wire the two together - and wiring it here rather
   * than in the game's setup keeps the collision world free of any dependency
   * on the traffic module. The two closures are created once and the visitor is
   * a bound field, so a frame's worth of this allocates nothing.
   */
  private currentSink: VehicleBoxSink | null = null;

  private readonly visitVehicle = (view: VehicleView): void => {
    this.currentSink?.(
      view.id,
      view.x,
      view.z,
      view.yaw,
      view.halfLength,
      view.halfWidth,
      // `view.y` is the centre of the body, so the contact plane is y - half.
      view.y - view.halfHeight,
      view.y + view.halfHeight,
    );
  };

  private readonly vehicleSource = (
    x: number,
    z: number,
    radius: number,
    sink: VehicleBoxSink,
  ): void => {
    this.currentSink = sink;
    this.options.traffic.forEachNear(x, z, radius, this.visitVehicle);
    this.currentSink = null;
  };

  constructor(options: DrivingOptions) {
    this.options = options;
    options.collision.setVehicleSource(this.vehicleSource);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    options.domElement.addEventListener('mousemove', this.onMouseMove);
  }

  get driving(): boolean {
    return this.handle !== null;
  }

  get state(): DrivingState {
    return {
      driving: this.handle !== null,
      speed: this.speed,
      kind: this.handle?.kind ?? null,
      police: this.handle?.view.police ?? false,
      x: this.x,
      y: this.options.ground.sample(this.x, this.z).y + this.hop + CAM_LOOK_HEIGHT,
      z: this.z,
      yaw: this.yaw,
    };
  }

  /**
   * The car the player would get into from here, if any.
   *
   * A write-off and a car on its roof are refused, because `takeControl`
   * refuses them: offering a prompt that does nothing when pressed is worse
   * than offering none. An abandoned one is not refused - getting back into
   * the car you left at the kerb is the point of being able to leave it there.
   */
  candidateAt(x: number, z: number): { id: number; kind: string } | null {
    if (this.handle) return null;
    const view = this.options.traffic.nearestVehicle(x, z, ENTER_RADIUS);
    if (!view || view.destroyed || view.overturned) return null;
    return { id: view.id, kind: view.kind };
  }

  /**
   * Takes the nearest car. Returns false when there is nothing to take, so the
   * caller can fall through to whatever else `E` does here.
   */
  tryEnter(x: number, z: number): boolean {
    if (this.handle) return false;
    const view = this.options.traffic.nearestVehicle(x, z, ENTER_RADIUS);
    if (!view) return false;
    const handle = this.options.traffic.takeControl(view.id);
    if (!handle) return false;

    this.handle = handle;
    this.hop = 0;
    this.hopRate = 0;
    this.x = view.x;
    this.z = view.z;
    this.yaw = view.yaw;
    this.speed = view.speed;
    this.steer = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.pitchLean = 0;
    this.rollLean = 0;
    // Seat the boom behind the car immediately so entering does not sweep the
    // camera across the city from wherever the walker was standing.
    this.camX = view.x + Math.sin(view.yaw) * CAM_DISTANCE;
    this.camY = this.options.ground.sample(view.x, view.z).y + CAM_HEIGHT;
    this.camZ = view.z + Math.cos(view.yaw) * CAM_DISTANCE;
    // The player's own body must stop braking the traffic it is now part of.
    this.options.traffic.setPlayerIsObstacle(false);
    this.options.controller.setPaused(true);
    return true;
  }

  /**
   * Steps out. The player is placed beside the car on ground they can stand
   * on; if both flanks are blocked they are put behind it, and only then at
   * the car's own position, so leaving can never fail and never buries anyone.
   */
  exit(): void {
    const handle = this.handle;
    if (!handle) return;

    const { ground, collision, controller, traffic } = this.options;
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    // Right of the car is forward rotated -90 degrees.
    const rx = -fz;
    const rz = fx;
    const halfWidth = handle.view.halfWidth;

    const candidates: [number, number][] = [
      [this.x - rx * (halfWidth + 0.9), this.z - rz * (halfWidth + 0.9)],
      [this.x + rx * (halfWidth + 0.9), this.z + rz * (halfWidth + 0.9)],
      [this.x - fx * (handle.view.halfLength + 1.2), this.z - fz * (handle.view.halfLength + 1.2)],
      [this.x, this.z],
    ];

    // Stepping out into the side of a passing bus is not a placement. The car
    // being left is excluded, since standing beside it is the whole point.
    collision.refreshVehicles(this.x, this.z, VEHICLE_QUERY_RADIUS, handle.id);

    let placed = false;
    for (const [cx, cz] of candidates) {
      if (!ground.isInBounds(cx, cz)) continue;
      const sample = ground.sample(cx, cz);
      if (sample.surface === 'water') continue;
      if (collision.isStuck(cx, cz, sample.y, BODY_HEIGHT, 0.34, true)) continue;
      controller.teleport(cx, cz, this.yaw);
      placed = true;
      break;
    }
    if (!placed) controller.teleport(this.x, this.z, this.yaw);

    // DRAIN WHAT IS STILL QUEUED FIRST. A blast that lands after this frame's
    // `update` and before the player steps out leaves an impulse banked in the
    // traffic layer that nothing will ever consume: `park` does not read the
    // queue, and the driving layer is about to stop existing for this car. This
    // is the last moment anything can, so it folds the shove into the speed and
    // the lift into the arc that the pose below hands over.
    this.absorbImpulse();

    // HAND THE WHOLE ARC OVER, NOT JUST ITS HEIGHT. A car abandoned mid-flight
    // still has somewhere to be going: publishing the height alone would drop
    // the upward velocity, so it would stop climbing and fall from wherever it
    // happened to be when the door opened. Published BEFORE `release`, because
    // release parks the car and the traffic layer integrates it from there -
    // and a blast that lands in the same frame as the exit would otherwise have
    // its lift thrown away before a single pose was ever published.
    handle.setPose({
      x: this.x,
      z: this.z,
      yaw: this.yaw,
      speed: this.speed,
      steer: this.steer,
      braking: false,
      lift: this.hop,
      liftRate: this.hopRate,
    });
    handle.release();
    this.handle = null;
    this.hop = 0;
    this.hopRate = 0;
    this.speed = 0;
    traffic.setPlayerIsObstacle(true);
    controller.setPaused(false);
  }

  /**
   * Called when this car knocks a pedestrian down.
   *
   * A person does not stop a car, but you feel it: a short scrub of speed and
   * a jolt through the body, which the chase camera then inherits through the
   * suspension. Deliberately small - making it stop the car would turn a
   * pedestrian into a bollard.
   */
  reportImpact(speed: number, _dirX: number, _dirZ: number): void {
    if (!this.handle) return;
    const severity = Math.min(1, Math.abs(speed) / 14);
    this.speed *= 1 - 0.10 * severity;
    // Nose-down jolt, on top of whatever the suspension is already doing.
    this.pitchLean -= 0.045 * severity;
    this.braking = true;
  }

  /** Integrates the car and puts the camera in the driver's seat. */
  update(dt: number): void {
    const handle = this.handle;
    if (!handle) return;
    const { chassis } = handle;
    const { ground, collision, camera } = this.options;

    // Anything that ran into THIS car since the last frame. The simulation
    // cannot move a car it does not own, so it banks the exchange and the
    // owner spends it - which is what makes an ambient driver running into the
    // parked player shove them forward instead of stopping dead against them.
    this.absorbImpulse();

    // What the bodywork has done to the car. One rule, shared with the traffic
    // AI: see `VehicleHandling`. A wrecked engine bay takes the power away, a
    // flat tyre drags the steering towards its own side and costs grip, and a
    // write-off has nothing left at all.
    const handling = handle.view.handling;

    // -- input ---------------------------------------------------------------
    const throttle = this.pressed('ArrowUp', 'KeyW') ? 1 : 0;
    const brake = this.pressed('ArrowDown', 'KeyS') ? 1 : 0;
    const steerInput =
      (this.pressed('ArrowLeft', 'KeyA') ? 1 : 0) - (this.pressed('ArrowRight', 'KeyD') ? 1 : 0);
    const handbrake = this.keys.has('Space');

    // -- steering ------------------------------------------------------------
    // The rack limit tightens with speed, which is what stops a flick of the
    // key spinning a car at 20 m/s, and the rate limit is what gives the wheel
    // weight instead of snapping to full lock.
    const speedFactor = 1 / (1 + Math.abs(this.speed) * 0.08);
    const target = steerInput * chassis.maxSteer * speedFactor;
    const rate = chassis.steerRate * dt;
    this.steer += clamp(target - this.steer, -rate, rate);
    if (steerInput === 0) {
      // Self-centring, proportional to speed: a parked car keeps its lock.
      const centring = Math.min(Math.abs(this.steer), rate * 0.9 * Math.min(1, Math.abs(this.speed) / 3));
      this.steer -= Math.sign(this.steer) * centring;
    }

    // -- longitudinal --------------------------------------------------------
    let accel = 0;
    // The brakes are hydraulic and the engine is not: a car with its bonnet
    // shot off still stops, it just cannot pull away. That asymmetry is why
    // `power` multiplies the two drive terms and never the brake.
    if (throttle > 0) accel += chassis.accelMax * throttle * handling.power;
    if (brake > 0) {
      if (this.speed > CREEP_EPSILON) accel -= chassis.brakeMax;
      else accel -= chassis.accelMax * 0.6 * handling.power; // roll back into reverse
    }
    if (throttle === 0 && brake === 0) accel -= this.speed * COAST_DRAG;
    if (handbrake) accel -= Math.sign(this.speed) * chassis.brakeMax * 1.15;

    // Resistance that never switches off. Aerodynamic drag rises with the
    // square of speed, so it is negligible in traffic and is what actually
    // sets the top speed: the car settles where thrust equals drag. Deriving
    // the coefficient from this vehicle's own `accelMax` means a laden truck
    // tops out lower than a coupe without needing a second number per vehicle.
    const dragK = chassis.accelMax / (TOP_SPEED * TOP_SPEED);
    accel -= dragK * this.speed * Math.abs(this.speed);
    accel -= this.speed * ROLL_DRAG;

    this.braking = brake > 0 || handbrake;
    this.speed += accel * dt;
    // Hard limits behind the drag, so no combination of inputs, dt spikes or
    // downhill slope can put the car beyond what collision can resolve.
    if (this.speed < -REVERSE_SPEED) this.speed = -REVERSE_SPEED;
    if (this.speed > TOP_SPEED) this.speed = TOP_SPEED;
    // Only kill creep when the driver is asking for NOTHING. Testing throttle
    // alone meant that holding brake from rest - which is how you select
    // reverse - had its speed zeroed every frame before it could build, so the
    // car could never back up at all.
    if (Math.abs(this.speed) < CREEP_EPSILON && throttle === 0 && brake === 0) this.speed = 0;

    // -- grip ----------------------------------------------------------------
    // Lateral acceleration is v^2 * tan(steer) / wheelbase. Past the tyre
    // limit the model gives up steering angle rather than inventing a slide it
    // has no way to resolve against buildings.
    const speedAbs = Math.abs(this.speed);
    if (speedAbs > 0.5) {
      const maxTan =
        (chassis.gripLateral * handling.grip * chassis.wheelbase) / (speedAbs * speedAbs);
      const maxAngle = Math.atan(Math.max(0.02, maxTan));
      this.steer = clamp(this.steer, -maxAngle, maxAngle);
    }

    // -- integrate -----------------------------------------------------------
    // The wheel the DRIVER is holding is `this.steer`, which is what the front
    // wheels are drawn at; what the car actually does is that plus whatever a
    // flat tyre is dragging it towards. Separating the two is what lets the
    // player fight a blown near-side tyre by holding opposite lock - and never
    // quite win, because the pull does not go away.
    const steerNow = this.steer + handling.pull;
    const yawRate = (this.speed / chassis.wheelbase) * Math.tan(steerNow);
    this.yaw += yawRate * dt;

    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    let dx = fx * this.speed * dt;
    let dz = fz * this.speed * dt;

    // -- collision -----------------------------------------------------------
    // The car's whole footprint, not a probe on the nose.
    //
    // A single circle at one point can only ever notice what that point runs
    // into. On a 4.5 m by 1.9 m body that left both flanks and the entire rear
    // free to pass through anything they touched: reversing into a wall, or
    // clipping a corner while turning, simply did not collide. `moveBox` puts
    // the real oriented box against the world and still resolves one axis at a
    // time, so scraping along a wall keeps the component parallel to it exactly
    // as it did before.
    //
    // Other traffic is included as well, so the player cannot drive through the
    // cars that are already braking for them.
    collision.refreshVehicles(this.x, this.z, VEHICLE_QUERY_RADIUS, handle.id);

    // Swept, not teleported. `moveBox` tests the footprint where the step ENDS,
    // so one long step can begin in front of a wall and end behind it, having
    // touched nothing in between. Splitting the frame into sub-steps no longer
    // than `MAX_COLLISION_STEP` makes that impossible at any speed the car can
    // reach, and costs nothing at ordinary speeds where the loop runs once.
    const wanted = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(wanted / MAX_COLLISION_STEP));
    // Where the car was before any of this frame's movement, so an impossible
    // position can be undone even after several sub-steps have been committed.
    const startX = this.x;
    const startZ = this.z;
    let achieved = 0;
    let blocked = false;
    let struck = false;
    for (let i = 0; i < steps; i += 1) {
      const stepX = dx / steps;
      const stepZ = dz / steps;
      const surface = ground.sample(this.x, this.z);
      // THE BOX RIDES WITH THE BODY. `this.hop` is the height a blast threw the
      // car to, and it is published to the renderer - so testing the footprint
      // at the road height instead would stop a visibly airborne car dead
      // against a kerb or a bonnet it had already cleared, and charge it for
      // the collision. Zero on every frame of ordinary driving, so this is the
      // same test it always was until something lifts the car.
      const moved = collision.moveBox(
        this.x,
        this.z,
        this.yaw,
        stepX,
        stepZ,
        handle.view.halfLength,
        handle.view.halfWidth,
        surface.y + this.hop,
        BODY_HEIGHT,
        true,
        this.contact,
      );

      // Refuse a sub-step that would put the car in the bay or outside the
      // world, BEFORE committing it. Testing after the whole frame instead
      // meant the car had already been moved there and the old rollback had
      // nothing left to subtract, so it stopped dead in the water rather than
      // at the edge of it.
      if (
        !ground.isInBounds(moved.x, moved.z) ||
        ground.sample(moved.x, moved.z).surface === 'water'
      ) {
        blocked = true;
        this.speed = 0;
        break;
      }

      const gotX = moved.x - this.x;
      const gotZ = moved.z - this.z;
      this.x = moved.x;
      this.z = moved.z;
      achieved += Math.hypot(gotX, gotZ);
      const stepWanted = Math.hypot(stepX, stepZ);
      if (stepWanted > 1e-6 && Math.hypot(gotX, gotZ) < stepWanted - 1e-5) {
        blocked = true;
        // A car refused this step, rather than a building. That is a collision
        // between two bodies with masses, and momentum decides what happens to
        // both of them.
        if (this.contact.id >= 0) struck = this.strike();
        // Nothing further this frame: the remaining sub-steps would push into
        // whatever just stopped us.
        break;
      }
    }

    if (blocked && !struck && wanted > 1e-5 && this.speed !== 0) {
      // Keep whatever sliding the world allowed and scrub speed by how much
      // was refused, so a glance costs less than a head-on hit.
      //
      // Skipped when the refusal was a car this frame actually struck: the
      // momentum exchange has already taken the speed that went into the other
      // vehicle, and scrubbing on top of it would stop a lorry dead against a
      // hatchback it had just launched.
      const lost = Math.max(0, 1 - achieved / wanted);
      const before = this.speed;
      this.speed *= Math.max(0, 1 - lost * 1.6);
      if (lost > 0.75) this.speed = -this.speed * 0.12;
      const shed = Math.abs(before) - Math.abs(this.speed);
      if (shed > 1.5) {
        // Hitting the city itself: same hook, different material, so audio can
        // tell a wall from a wing. The shell pays for it as well, and the
        // speed the building took is exactly the delta-v `collisionDamage`
        // wants - a wall does not give and there is no second shell to share
        // it with. The old 40 per cent factor was there to stop a scrape
        // writing a car off; the yield threshold does that properly now, and
        // charging a fraction of the real severity on top would only make the
        // number impossible to reason about.
        const roadY = ground.sample(this.x, this.z).y;
        this.options.traffic.reportImpact(this.x, roadY + 0.6, this.z, shed / 12, 'world');
        // Charged to the end that was leading, so scraping a wall in reverse
        // wrecks the boot and not the bonnet. Taken from the speed BEFORE the
        // scrub: a hard enough hit reverses it, and charging the sign that
        // came out of the bounce would put a head-on into the boot.
        const lead = handle.view.halfLength * Math.sign(before || 1);
        this.options.traffic.applyDamage(
          handle.id,
          collisionDamage({ deltaV: shed }),
          this.x + fx * lead,
          roadY + 0.6,
          this.z + fz * lead,
        );
        this.pitchLean -= Math.min(0.09, shed * 0.006);
      }
    }
    // The sub-step loop has already committed the movement.
    dx = 0;
    dz = 0;

    // Belt and braces: if the car has ended up somewhere impossible anyway -
    // a terrain edge case, or a sub-step that started on bad ground - put it
    // back where this frame began rather than leaving it stranded.
    if (!ground.isInBounds(this.x, this.z) || ground.sample(this.x, this.z).surface === 'water') {
      this.x = startX;
      this.z = startZ;
      this.speed = 0;
    }

    // -- suspension, purely for the camera -----------------------------------
    // Critically damped lean driven by the same accelerations the body feels.
    const targetPitch = clamp(-accel * 0.010, -0.07, 0.07);
    const targetRoll = clamp(-yawRate * this.speed * 0.014, -0.09, 0.09);
    this.pitchLean += (targetPitch - this.pitchLean) * Math.min(1, dt * 7);
    this.rollLean += (targetRoll - this.rollLean) * Math.min(1, dt * 7);

    // -- hand the pose back to the renderer ----------------------------------
    this.stepHop(dt);
    handle.setPose({
      x: this.x,
      z: this.z,
      yaw: this.yaw,
      speed: this.speed,
      steer: this.steer,
      braking: this.braking,
      lift: this.hop,
      liftRate: this.hopRate,
    });

    // -- chase camera --------------------------------------------------------
    // The boom trails the car rather than snapping to it, so a hard turn swings
    // the view around instead of teleporting it. Mouse look orbits the boom.
    const roadY = ground.sample(this.x, this.z).y + this.hop;
    const camYaw = this.yaw + this.lookYaw;
    const bx = Math.sin(camYaw);
    const bz = Math.cos(camYaw);

    // Shorten the boom if anything solid sits between the camera and the car,
    // otherwise reversing into a wall puts the view inside the building.
    let distance = CAM_DISTANCE;
    for (let i = 0; i < 6; i += 1) {
      const test = CAM_DISTANCE - i * ((CAM_DISTANCE - CAM_MIN_DISTANCE) / 5);
      const tx = this.x + bx * test;
      const tz = this.z + bz * test;
      if (!collision.isStuck(tx, tz, roadY + 0.5, 1.2, 0.5)) {
        distance = test;
        break;
      }
      distance = CAM_MIN_DISTANCE;
    }

    const wantX = this.x + bx * distance;
    const wantZ = this.z + bz * distance;
    const wantY = roadY + CAM_HEIGHT + this.lookPitch * -3.2;
    const follow = Math.min(1, dt * CAM_LAG);
    this.camX += (wantX - this.camX) * follow;
    this.camY += (wantY - this.camY) * follow;
    this.camZ += (wantZ - this.camZ) * follow;

    camera.position.set(this.camX, this.camY, this.camZ);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.x, roadY + CAM_LOOK_HEIGHT, this.z);
    // Body roll leans the frame a little, which sells the weight of a turn.
    camera.rotateZ(this.rollLean * 0.45);
  }

  /**
   * Resolves this frame's contact with another car, in both directions.
   *
   * A one-dimensional inelastic collision along the line from this car's centre
   * to the point it touched: the reduced mass is what makes the exchange read
   * correctly whichever way round it happens. Two saloons at 12 m/s closing
   * transfer 9.8 kN.s, which leaves the striker at 5.1 m/s and sends the struck
   * car off at 6.9; the same arithmetic against a 4.2 tonne box truck leaves
   * the saloon at 1.7 and moves the truck at 3.5. Nothing is special-cased.
   *
   * Returns false when the hit was not taken - too slow to count, or the same
   * contact as last frame, which `TrafficSystem` refuses for a fifth of a
   * second so that leaning on a car is one collision rather than a hundred.
   */
  private strike(): boolean {
    const handle = this.handle;
    if (!handle) return false;
    const { traffic } = this.options;
    const contact = this.contact;

    let other: VehicleView | null = null;
    for (const view of traffic.vehicles) {
      if (view.id === contact.id) {
        other = view;
        break;
      }
    }
    if (!other) return false;

    // The line of the hit: from our centre out to where we touched them.
    let nx = contact.x - this.x;
    let nz = contact.z - this.z;
    const range = Math.hypot(nx, nz);
    if (range < 1e-4) return false;
    nx /= range;
    nz /= range;

    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const ofx = -Math.sin(other.yaw);
    const ofz = -Math.cos(other.yaw);
    const closing =
      (fx * this.speed - ofx * other.speed) * nx + (fz * this.speed - ofz * other.speed) * nz;
    if (closing < CONTACT_SPEED) return false;

    const mass = handle.chassis.mass;
    const otherMass = traffic.chassisOf(contact.id)?.mass ?? mass;
    const impulse = (1 + CAR_RESTITUTION) * closing * ((mass * otherMass) / (mass + otherMass));
    // The impulse is shared and the damage is not: each shell is charged for
    // its OWN velocity change, through the geometry of its own contact. Being
    // run into by a box truck and running into one are the same newton-seconds
    // and nothing like the same crash.
    const theirDamage = collisionDamage({
      deltaV: impulse / otherMass,
      crush: crushShare({
        centreX: other.x,
        centreZ: other.z,
        yaw: other.yaw,
        x: contact.x,
        z: contact.z,
        dirX: nx,
        dirZ: nz,
        length: other.halfLength * 2,
        width: other.halfWidth * 2,
      }),
    });
    if (
      !traffic.applyImpact(contact.id, {
        x: contact.x,
        y: contact.y,
        z: contact.z,
        dirX: nx,
        dirZ: nz,
        impulse,
        damage: theirDamage,
      })
    ) {
      return false;
    }

    // Newton's third law, spent on the only degree of freedom this model has.
    const deltaV = impulse / mass;
    this.speed -= deltaV * (nx * fx + nz * fz);
    this.speed = clamp(this.speed, -REVERSE_SPEED, TOP_SPEED);
    // On the panel that made the contact: the hit point is out along the line
    // from this car's centre, so it lands on the corner that struck. That line
    // passes through the centre of mass, so all of the delta-v crushes and
    // none of it spins - `crushShare` would return 1 here and is left out.
    traffic.applyDamage(
      handle.id,
      collisionDamage({ deltaV }) * STRIKER_SHARE,
      this.x + nx * handle.view.halfLength,
      contact.y,
      this.z + nz * handle.view.halfLength,
    );
    this.pitchLean -= Math.min(0.09, deltaV * 0.02);
    this.braking = true;
    return true;
  }

  /**
   * Spends whatever ran into this car while the simulation was stepping.
   *
   * Only the longitudinal component moves the car: the steering model here is
   * kinematic and has no lateral velocity to put a sideways shove into, so a
   * side impact arrives as a heading change and a jolt rather than as a slide.
   */
  /**
   * Height above the road, and the rate it is changing, for a car a blast threw.
   *
   * The driven car is kinematic: it has a speed along its heading and no
   * velocity vector, which is why a sideways shove arrives as a heading change
   * rather than as a slide. A blast's LIFT has nowhere to go in that model, so
   * it gets its own one-dimensional ballistic state here and is published
   * through `setPose`. Zero on every frame of ordinary driving.
   *
   * Without this, `TrafficSim.applyImpact` would hand a driven car the same
   * vertical impulse it hands an ambient one and the pending-impulse queue
   * would drop it on the floor - so the identical car would be thrown by a
   * rocket when parked and merely shoved when the player was sitting in it.
   */
  private hop = 0;
  private hopRate = 0;

  private absorbImpulse(): void {
    const handle = this.handle;
    if (!handle) return;
    const bump = this.options.traffic.takeImpulse(handle.id);
    if (!bump) return;
    const chassis = handle.chassis;
    const mass = Math.max(1, chassis.mass);
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const deltaV = (bump.x * fx + bump.z * fz) / mass;
    this.speed = clamp(this.speed + deltaV, -REVERSE_SPEED, TOP_SPEED);
    const yawInertia =
      (mass * (chassis.length * chassis.length + chassis.width * chassis.width)) / 12;
    this.yaw += clamp(
      (bump.yaw / yawInertia) * YAW_KICK_SECONDS,
      -YAW_KICK_LIMIT,
      YAW_KICK_LIMIT,
    );
    this.pitchLean -= Math.min(0.09, Math.abs(deltaV) * 0.02);
    // Straight up, in the same units the ambient body uses. Under the trigger
    // the suspension absorbs it and the car stays on the road.
    const lift = bump.lift / mass;
    if (lift >= BLAST_LIFT_TRIGGER) this.hopRate += lift;
  }

  /**
   * One step of the arc, and the way back down.
   *
   * Real gravity and a nearly inelastic landing, matching the ambient body so a
   * car thrown by the same blast behaves the same whoever is in it.
   */
  private stepHop(dt: number): void {
    if (this.hop <= 0 && this.hopRate <= 0) return;
    this.hopRate -= BLAST_GRAVITY * dt;
    this.hop += this.hopRate * dt;
    if (this.hop <= 0) {
      const landing = -this.hopRate;
      this.hop = 0;
      this.hopRate = landing > 1 ? landing * LANDING_RESTITUTION : 0;
      if (this.hopRate <= 0.2) this.hopRate = 0;
      // Coming down on the suspension takes speed off, and pitches the nose.
      this.speed *= 0.7;
      this.pitchLean -= Math.min(0.12, landing * 0.02);
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.options.domElement.removeEventListener('mousemove', this.onMouseMove);
    // The collision world outlives this layer, and a source that reaches into a
    // disposed traffic system is a leak with teeth.
    this.options.collision.setVehicleSource(null);
    this.keys.clear();
  }

  private pressed(...codes: string[]): boolean {
    for (const code of codes) if (this.keys.has(code)) return true;
    return false;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.handle) return;
    this.keys.add(event.code);
    // Arrow keys scroll the page otherwise, which fights the drive.
    if (event.code.startsWith('Arrow') || event.code === 'Space') event.preventDefault();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.handle) return;
    if (document.pointerLockElement !== this.options.domElement) return;
    // Looking around the cabin, bounded: the driver cannot spin their head.
    this.lookYaw = clamp(this.lookYaw - event.movementX * 0.0022, -1.5, 1.5);
    this.lookPitch = clamp(this.lookPitch - event.movementY * 0.0022, -0.6, 0.5);
  };
}
