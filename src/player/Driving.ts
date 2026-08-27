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
import type { CollisionWorld, VehicleBoxSink } from './Collision';
import type { FirstPersonController } from './FirstPersonController';
import type { TrafficSystem } from '../traffic/TrafficSystem';
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
/** Rolling resistance and drag, as a fraction of speed per second. */
const COAST_DRAG = 0.55;
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
      y: this.options.ground.sample(this.x, this.z).y + CAM_LOOK_HEIGHT,
      z: this.z,
      yaw: this.yaw,
    };
  }

  /** The car the player would get into from here, if any. */
  candidateAt(x: number, z: number): { id: number; kind: string } | null {
    if (this.handle) return null;
    const view = this.options.traffic.nearestVehicle(x, z, ENTER_RADIUS);
    return view ? { id: view.id, kind: view.kind } : null;
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

    handle.release();
    this.handle = null;
    this.speed = 0;
    traffic.setPlayerIsObstacle(true);
    controller.setPaused(false);
  }

  /** Integrates the car and puts the camera in the driver's seat. */
  update(dt: number): void {
    const handle = this.handle;
    if (!handle) return;
    const { chassis } = handle;
    const { ground, collision, camera } = this.options;

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
    if (throttle > 0) accel += chassis.accelMax * throttle;
    if (brake > 0) {
      if (this.speed > CREEP_EPSILON) accel -= chassis.brakeMax;
      else accel -= chassis.accelMax * 0.6; // roll back into reverse
    }
    if (throttle === 0 && brake === 0) accel -= this.speed * COAST_DRAG;
    if (handbrake) accel -= Math.sign(this.speed) * chassis.brakeMax * 1.15;

    this.braking = brake > 0 || handbrake;
    this.speed += accel * dt;
    // Reverse is capped well below the forward limit.
    if (this.speed < -REVERSE_SPEED) this.speed = -REVERSE_SPEED;
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
      const maxTan = (chassis.gripLateral * chassis.wheelbase) / (speedAbs * speedAbs);
      const maxAngle = Math.atan(Math.max(0.02, maxTan));
      this.steer = clamp(this.steer, -maxAngle, maxAngle);
    }

    // -- integrate -----------------------------------------------------------
    const yawRate = (this.speed / chassis.wheelbase) * Math.tan(this.steer);
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
    const surface = ground.sample(this.x, this.z);
    const moved = collision.moveBox(
      this.x,
      this.z,
      this.yaw,
      dx,
      dz,
      handle.view.halfLength,
      handle.view.halfWidth,
      surface.y,
      BODY_HEIGHT,
      true,
    );
    const gotX = moved.x - this.x;
    const gotZ = moved.z - this.z;
    const wanted = Math.hypot(dx, dz);
    const achieved = Math.hypot(gotX, gotZ);
    if (wanted > 1e-5 && achieved < wanted - 1e-4) {
      // Something is in the way. Keep whatever sliding the world allowed and
      // scrub speed by how much was refused, so a glance costs less than a
      // head-on hit.
      const lost = 1 - achieved / wanted;
      this.speed *= Math.max(0, 1 - lost * 1.6);
      if (lost > 0.75) this.speed = -this.speed * 0.12;
      dx = gotX;
      dz = gotZ;
    }
    this.x += dx;
    this.z += dz;

    // Keep the car inside the world rather than letting it drive into the bay.
    if (!ground.isInBounds(this.x, this.z) || ground.sample(this.x, this.z).surface === 'water') {
      this.x -= dx;
      this.z -= dz;
      this.speed = 0;
    }

    // -- suspension, purely for the camera -----------------------------------
    // Critically damped lean driven by the same accelerations the body feels.
    const targetPitch = clamp(-accel * 0.010, -0.07, 0.07);
    const targetRoll = clamp(-yawRate * this.speed * 0.014, -0.09, 0.09);
    this.pitchLean += (targetPitch - this.pitchLean) * Math.min(1, dt * 7);
    this.rollLean += (targetRoll - this.rollLean) * Math.min(1, dt * 7);

    // -- hand the pose back to the renderer ----------------------------------
    handle.setPose({
      x: this.x,
      z: this.z,
      yaw: this.yaw,
      speed: this.speed,
      steer: this.steer,
      braking: this.braking,
    });

    // -- chase camera --------------------------------------------------------
    // The boom trails the car rather than snapping to it, so a hard turn swings
    // the view around instead of teleporting it. Mouse look orbits the boom.
    const roadY = ground.sample(this.x, this.z).y;
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
