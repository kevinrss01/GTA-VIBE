/**
 * First-person walking controller.
 *
 * There is deliberately no avatar: no body, no hands, no weapon, no shadow of a
 * character. The player is an invisible cylinder with the camera at eye height.
 *
 * Movement runs on a fixed timestep accumulator so behaviour is identical at 30
 * and at 144 FPS - a variable-dt controller drifts in step height, acceleration
 * and gravity as the frame rate changes, which is exactly the "behaves
 * differently at different frame rates" failure the brief calls out.
 *
 * Yaw convention: forward is `(-sin yaw, 0, -cos yaw)`, so yaw 0 faces north
 * (-Z) and -PI/2 faces east (+X). The rest of the project shares this.
 */

import { Euler, Vector3, type PerspectiveCamera } from 'three';

import { clamp, damp } from '../core/mathx';
import type { CityGround, SurfaceId } from '../world/CityGround';
import { CollisionWorld, STEP_HEIGHT } from './Collision';

/** Eye height of an average adult, measured from the sole of the foot. */
export const EYE_HEIGHT = 1.68;
/** The player's collision cylinder. Exported so headless audits use it too. */
export const BODY_RADIUS = 0.34;
export const BODY_HEIGHT = 1.8;

export const WALK_SPEED = 2.8;
export const RUN_SPEED = 6.0;

const ACCELERATION = 26;
const AIR_ACCELERATION = 3.5;
const GRAVITY = -22;
export const FIXED_STEP = 1 / 120;
const MAX_SUBSTEPS = 8;
const PITCH_LIMIT = Math.PI / 2 - 0.02;

/** Seconds a full-strength camera shake takes to die away. */
const SHAKE_DECAY = 0.85;
/** Peak angular deviation of a full-strength shake, radians. About 2.6°. */
const SHAKE_RADIANS = 0.046;

/**
 * Ceilings on the accumulated recoil offset, radians.
 *
 * A held burst adds a kick per round and these are what stop a carbine walking
 * the crosshair into the sky: about 11 degrees of climb and 3.4 either side.
 */
const RECOIL_PITCH_MAX = 0.2;
const RECOIL_YAW_MAX = 0.06;
/** How fast the offset returns to zero. Higher settles sooner. */
const RECOIL_RECOVERY = 9;

/**
 * How far around the player traffic is fetched each frame, in metres.
 *
 * A box truck's half diagonal is about 3.9 m and a running player covers 0.1 m
 * in a frame at 60 Hz, so 9 m is comfortably more than a body can reach in the
 * time between two refreshes.
 */
const VEHICLE_QUERY_RADIUS = 9;

/** What one fixed step of vertical resolution did to the player. */
export interface VerticalStep {
  readonly y: number;
  readonly verticalVelocity: number;
  readonly grounded: boolean;
  /** True when the body settled onto its support rather than falling toward it. */
  readonly settled: boolean;
}

/**
 * The vertical half of one fixed simulation step: settle onto the support under
 * the feet, otherwise fall toward it, then rescue a body jammed into geometry.
 *
 * This is a pure function of the collision world so the headless placement audit
 * can walk a player through a doorway using exactly the code the game runs,
 * rather than a reimplementation of it that is free to drift. Without that, a
 * regression like "the door drops the player inside the building's own mass
 * collider and the rescue lifts them onto the roof" is only ever visible in a
 * browser.
 */
export function resolveVerticalStep(
  collision: CollisionWorld,
  x: number,
  z: number,
  feetY: number,
  verticalVelocity: number,
  supportY: number,
  dt: number,
): VerticalStep {
  let y = feetY;
  let vy = verticalVelocity;
  let grounded: boolean;
  let settled = false;

  if (y <= supportY + 0.02) {
    y = supportY;
    vy = 0;
    grounded = true;
    settled = true;
  } else {
    vy += GRAVITY * dt;
    y += vy * dt;
    if (y < supportY) {
      y = supportY;
      vy = 0;
      grounded = true;
    } else {
      grounded = y - supportY < 0.06;
    }
  }

  // A build error or a bad placement could leave the player jammed into
  // geometry with nowhere to stand; lifting them out is far better than
  // trapping them. Two guards keep that rescue from becoming the problem it is
  // meant to solve:
  //
  // - it only runs on a body that has *settled*, i.e. one with nothing left to
  //   fall to. A body above its support is already on its way out of trouble,
  //   and lifting it there fights gravity every step - which is what turns
  //   brushing past a knee-high fitting into a visible bob.
  // - it only runs when the lift actually frees the body. A lift that changes
  //   nothing repeats every fixed step, and at 120 Hz that is 27 m/s of
  //   vertical teleport: the difference between a rescue and a ride to the roof.
  if (settled && collision.isStuck(x, z, y, BODY_HEIGHT, BODY_RADIUS)) {
    const lifted = y + STEP_HEIGHT * 0.5;
    if (!collision.isStuck(x, z, lifted, BODY_HEIGHT, BODY_RADIUS)) y = lifted;
  }

  return { y, verticalVelocity: vy, grounded, settled };
}

export interface ControllerState {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly speed: number;
  readonly running: boolean;
  readonly grounded: boolean;
  readonly surface: SurfaceId;
  readonly indoors: boolean;
  /** Recoil currently added to the look angles, radians. See `addRecoil`. */
  readonly recoilPitch: number;
  readonly recoilYaw: number;
}

/**
 * Somewhere a weapon can put its kick.
 *
 * Declared here rather than in the combat layer so the controller owns the
 * shape of its own input, and narrow enough that the combat layer never gets a
 * handle on the controller itself.
 */
export interface RecoilSink {
  addRecoil(pitch: number, yaw: number): void;
}

export interface ControllerOptions {
  readonly ground: CityGround;
  readonly collision: CollisionWorld;
  readonly camera: PerspectiveCamera;
  readonly domElement: HTMLElement;
  readonly spawn: { x: number; z: number; heading: number };
}

export class FirstPersonController {
  private readonly ground: CityGround;
  private readonly collision: CollisionWorld;
  private readonly camera: PerspectiveCamera;
  private readonly domElement: HTMLElement;

  private readonly position = new Vector3();
  private readonly velocity = new Vector3();
  private yaw: number;
  private pitch = 0;
  /**
   * Recoil, as an offset the absolute camera write composes in.
   *
   * IT IS PART OF THE AIM, not a picture of one. The controller writes the
   * camera quaternion absolutely every frame from `pitch`/`yaw`, so a kick
   * applied to the camera AFTER that write - which is what the combat layer
   * used to do - is discarded on the next frame and, worse, is not in the pose
   * the shot was cast from: the frame the player looked at was rotated
   * relative to the bullet that left in it. Held here instead, the rendered
   * pose and the pose anything casts from `camera.matrixWorld` are the same
   * pose by construction, the kick accumulates through a burst, and it
   * recovers on its own.
   */
  private recoilPitch = 0;
  private recoilYaw = 0;
  private shakeAmount = 0;
  private shakePhase = 0;
  private verticalVelocity = 0;
  private grounded = true;
  private accumulator = 0;

  /** Head bob phase, and the smoothed eye offset it drives. */
  private bobPhase = 0;
  private eyeOffset = 0;
  private landingDip = 0;

  private surface: SurfaceId = 'pavement';
  private indoors = false;

  private readonly keys = new Set<string>();
  private mouseSensitivity = 0.0022;
  /** Pointer lock drives mouse look, but must not be required to walk. */
  private pointerLockActive = false;
  /** Fallback look mode: hold the mouse down and drag. */
  private dragging = false;
  private paused = false;
  private disposed = false;

  /** Fires each time a foot lands, so the audio director can play a step. */
  onFootstep: ((surface: SurfaceId, running: boolean) => void) | null = null;

  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly wish = new Vector3();

  constructor(options: ControllerOptions) {
    this.ground = options.ground;
    this.collision = options.collision;
    this.camera = options.camera;
    this.domElement = options.domElement;
    this.yaw = options.spawn.heading;

    const groundY = this.ground.sample(options.spawn.x, options.spawn.z).y;
    this.position.set(options.spawn.x, groundY, options.spawn.z);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    this.domElement.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
  }

  // -- input -----------------------------------------------------------------

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Arrow keys scroll the page by default, which fights the game.
    if (event.code.startsWith('Arrow')) event.preventDefault();
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  /** Dropping focus must not leave a key stuck down. */
  private readonly onBlur = (): void => {
    this.keys.clear();
  };

  private readonly onPointerLockChange = (): void => {
    this.pointerLockActive = document.pointerLockElement === this.domElement;
  };

  private readonly onMouseDown = (): void => {
    // Only useful when the browser has not granted pointer lock; harmless
    // otherwise, since locked movement deltas arrive either way.
    if (!this.pointerLockActive) this.dragging = true;
  };

  private readonly onMouseUp = (): void => {
    this.dragging = false;
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (this.paused) return;
    if (!this.pointerLockActive && !this.dragging) return;
    // Raw pointer-lock deltas are already frame-independent; smoothing them
    // would add latency, so they are applied directly.
    this.yaw -= event.movementX * this.mouseSensitivity;
    this.pitch -= event.movementY * this.mouseSensitivity;
    this.pitch = clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    // Keep yaw bounded so it never loses precision over a long session.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  };

  requestPointerLock(): void {
    // Some environments refuse the request; walking must still work, so the
    // failure is swallowed rather than surfaced.
    try {
      const result = this.domElement.requestPointerLock() as unknown;
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      /* pointer lock unavailable; drag-to-look covers it */
    }
  }

  /** Pausing stops input without tearing anything down. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.keys.clear();
  }

  /** Sets the look pitch directly. Used by automated QA vantage points. */
  setPitch(pitch: number): void {
    this.pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  setSensitivity(value: number): void {
    this.mouseSensitivity = clamp(value, 0.0004, 0.01);
  }

  get pointerLocked(): boolean {
    return this.pointerLockActive;
  }

  // -- simulation ------------------------------------------------------------

  /** Arrow keys are the required scheme; WASD is offered alongside them. */
  private readInput(): { forward: number; strafe: number; running: boolean } {
    const k = this.keys;
    const forward =
      (k.has('ArrowUp') || k.has('KeyW') ? 1 : 0) - (k.has('ArrowDown') || k.has('KeyS') ? 1 : 0);
    const strafe =
      (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
    const running = k.has('ShiftLeft') || k.has('ShiftRight');
    return { forward, strafe, running };
  }

  update(dt: number): void {
    if (this.disposed) return;
    // Traffic is refreshed once per frame rather than once per fixed step: the
    // set only changes when the cars do, and eight substeps at 120 Hz asking
    // the same question eight times would be seven queries wasted. The radius
    // covers the longest vehicle's half diagonal plus everything a running
    // player can cover in one frame.
    this.collision.refreshVehicles(this.position.x, this.position.z, VEHICLE_QUERY_RADIUS);
    // Clamp so a long stall (tab switch, a big asset decode) cannot tunnel the
    // player through the world when the tab wakes up.
    this.accumulator = Math.min(this.accumulator + dt, FIXED_STEP * MAX_SUBSTEPS);
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_SUBSTEPS) {
      this.step(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      steps += 1;
    }
    this.applyCamera(dt);
  }

  private step(dt: number): void {
    // Movement deliberately does NOT require pointer lock: an environment that
    // refuses the lock would otherwise leave the player unable to walk at all.
    const input = this.paused ? { forward: 0, strafe: 0, running: false } : this.readInput();

    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(-this.forward.z, 0, this.forward.x);

    this.wish
      .set(0, 0, 0)
      .addScaledVector(this.forward, input.forward)
      .addScaledVector(this.right, input.strafe);
    if (this.wish.lengthSq() > 1e-6) this.wish.normalize();

    const targetSpeed = input.running ? RUN_SPEED : WALK_SPEED;
    const accel = this.grounded ? ACCELERATION : AIR_ACCELERATION;
    this.velocity.x = damp(this.velocity.x, this.wish.x * targetSpeed, accel, dt);
    this.velocity.z = damp(this.velocity.z, this.wish.z * targetSpeed, accel, dt);
    if (Math.abs(this.velocity.x) < 0.008) this.velocity.x = 0;
    if (Math.abs(this.velocity.z) < 0.008) this.velocity.z = 0;

    // `true`: cars block. Walking through one is the thing this argument is
    // here for, and the per-axis slide inside `move` means brushing along a
    // flank still carries the player past it rather than stopping them dead.
    const moved = this.collision.move(
      this.position.x,
      this.position.z,
      this.velocity.x * dt,
      this.velocity.z * dt,
      this.position.y,
      BODY_HEIGHT,
      BODY_RADIUS,
      true,
    );

    // Keep the player out of the bay and off the edge of the world.
    const sample = this.ground.sample(moved.x, moved.z);
    const swimming = sample.surface === 'water' && this.ground.waterDepth(moved.x, moved.z) > 0.55;
    if (!swimming && this.ground.isInBounds(moved.x, moved.z)) {
      this.position.x = moved.x;
      this.position.z = moved.z;
      this.position.y = moved.feetY;
    } else {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }

    const here = this.ground.sample(this.position.x, this.position.z);
    const support = this.collision.supportAt(
      this.position.x,
      this.position.z,
      this.position.y,
      here.y,
    );
    this.surface = support.built && support.y > here.y + 0.05 ? 'interior' : here.surface;
    this.indoors = this.ground.isBuilt(this.position.x, this.position.z, -0.2);

    // Vertical: snap up onto support, fall onto it from above, then rescue a
    // body that is jammed into geometry. `resolveVerticalStep` owns all of it.
    const wasGrounded = this.grounded;
    const drop = support.y - this.position.y;
    const vertical = resolveVerticalStep(
      this.collision,
      this.position.x,
      this.position.z,
      this.position.y,
      this.verticalVelocity,
      support.y,
      dt,
    );
    this.position.y = vertical.y;
    this.verticalVelocity = vertical.verticalVelocity;
    this.grounded = vertical.grounded;
    if (vertical.settled && !wasGrounded && drop < -0.4) {
      this.landingDip = clamp(-drop * 0.12, 0, 0.16);
    }

    this.updateFootsteps(dt, input.running);
  }

  private updateFootsteps(dt: number, running: boolean): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (!this.grounded || speed < 0.35) {
      this.bobPhase = damp(this.bobPhase, Math.round(this.bobPhase / Math.PI) * Math.PI, 8, dt);
      return;
    }
    // One full bob cycle is two steps, so the phase advances with distance
    // travelled rather than with time: stopping mid-stride does not re-trigger.
    const strideLength = running ? 1.95 : 1.45;
    const previous = this.bobPhase;
    this.bobPhase += (speed * dt * Math.PI) / strideLength;
    if (Math.floor(previous / Math.PI) !== Math.floor(this.bobPhase / Math.PI)) {
      this.onFootstep?.(this.surface, running);
    }
    if (this.bobPhase > Math.PI * 1e5) this.bobPhase %= Math.PI * 2;
  }

  /**
   * Shakes the camera.
   *
   * `strength` is 0..1 and is taken as a MAXIMUM rather than added, so three
   * rockets landing in the same second do not sum into a seizure. It decays
   * over `SHAKE_DECAY` seconds and is applied on top of the look angles rather
   * than into them, so it never moves where the player is actually aiming: the
   * crosshair stays on target and the world moves around it, which is what
   * makes a shake feel like an impact rather than like losing control.
   */
  shake(strength: number): void {
    this.shakeAmount = Math.max(this.shakeAmount, clamp(strength, 0, 1));
  }

  /**
   * Kicks the aim. `pitch` is positive upward, `yaw` positive to the left.
   *
   * Unlike `shake`, this DOES move where the player is pointing: it is added
   * to the look angles the camera and every shot are built from, so a burst
   * really does climb and really does have to be pulled back down. It is an
   * offset rather than a change to `pitch`/`yaw` themselves so that it can
   * recover, which is what makes a controlled burst possible at all.
   */
  addRecoil(pitch: number, yaw: number): void {
    if (!Number.isFinite(pitch) || !Number.isFinite(yaw)) return;
    this.recoilPitch = clamp(this.recoilPitch + pitch, -RECOIL_PITCH_MAX, RECOIL_PITCH_MAX);
    this.recoilYaw = clamp(this.recoilYaw + yaw, -RECOIL_YAW_MAX, RECOIL_YAW_MAX);
  }

  /** Drops the accumulated kick outright. Used on respawn. */
  clearRecoil(): void {
    this.recoilPitch = 0;
    this.recoilYaw = 0;
  }

  private applyCamera(dt: number): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    // A very small bob: enough to feel like walking, far short of nausea.
    const amplitude = this.grounded ? Math.min(speed / RUN_SPEED, 1) * 0.035 : 0;
    const targetOffset = Math.sin(this.bobPhase) * amplitude - this.landingDip;
    this.eyeOffset = damp(this.eyeOffset, targetOffset, 16, dt);
    this.landingDip = damp(this.landingDip, 0, 6, dt);

    const sway = Math.cos(this.bobPhase * 0.5) * amplitude * 0.35;
    this.camera.position.set(
      this.position.x + this.right.x * sway,
      this.position.y + EYE_HEIGHT + this.eyeOffset,
      this.position.z + this.right.z * sway,
    );
    // Recovery first, so the offset written this frame is the one anything
    // casting from this camera this frame will see.
    this.recoilPitch = damp(this.recoilPitch, 0, RECOIL_RECOVERY, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, RECOIL_RECOVERY, dt);
    const aimPitch = clamp(this.pitch + this.recoilPitch, -PITCH_LIMIT, PITCH_LIMIT);
    const aimYaw = this.yaw + this.recoilYaw;

    if (this.shakeAmount > 0) {
      this.shakeAmount = Math.max(0, this.shakeAmount - dt / SHAKE_DECAY);
      this.shakePhase += dt;
      // Two incommensurable frequencies per axis, so the trace never repeats
      // over the life of one shake and never reads as a wobble.
      const amount = this.shakeAmount * this.shakeAmount * SHAKE_RADIANS;
      const pitchShake =
        (Math.sin(this.shakePhase * 47.3) + Math.sin(this.shakePhase * 29.1)) * 0.5 * amount;
      const yawShake =
        (Math.sin(this.shakePhase * 38.7) + Math.sin(this.shakePhase * 61.9)) * 0.5 * amount;
      const rollShake = Math.sin(this.shakePhase * 23.5) * amount * 0.7;
      this.euler.set(aimPitch + pitchShake, aimYaw + yawShake, rollShake, 'YXZ');
    } else {
      this.shakePhase = 0;
      this.euler.set(aimPitch, aimYaw, 0, 'YXZ');
    }
    this.camera.quaternion.setFromEuler(this.euler);
  }

  // -- state -----------------------------------------------------------------

  get state(): ControllerState {
    return {
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      yaw: this.yaw,
      pitch: this.pitch,
      speed: Math.hypot(this.velocity.x, this.velocity.z),
      running: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      grounded: this.grounded,
      surface: this.surface,
      indoors: this.indoors,
      recoilPitch: this.recoilPitch,
      recoilYaw: this.recoilYaw,
    };
  }

  /**
   * The surface the player would stand on at a point, given the height they are
   * aiming for. Built platforms within a step of `aimY` win over the terrain,
   * which is the same rule walking uses, so a placement can never disagree with
   * the floor the player would immediately be standing on.
   *
   * Without an aim - a plain "put me here" - the reach is a whole body height
   * rather than a single step, because a placement is not a walk: dropping
   * someone at a shop front should stand them on its floor, not under it in the
   * plinth, even where the threshold is taller than a kerb.
   */
  private floorUnder(x: number, z: number, aimY?: number): number {
    const terrain = this.ground.sample(x, z).y;
    const aim = aimY ?? terrain + BODY_HEIGHT - STEP_HEIGHT;
    return this.collision.supportAt(x, z, aim, terrain).y;
  }

  /**
   * Moves the player to an outdoor point, standing them on whatever is there.
   * Used by QA vantage points and by any door whose far side is open ground.
   */
  teleport(x: number, z: number, heading?: number): void {
    this.position.x = x;
    this.position.z = z;
    this.position.y = this.floorUnder(x, z);
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
    this.grounded = true;
    // A move this abrupt is a respawn or a vantage point; carrying a burst's
    // accumulated kick across it would leave the new view tilted at the sky.
    this.clearRecoil();
    if (heading !== undefined) this.yaw = heading;
  }

  /**
   * Places the player on a known floor, e.g. the slab behind a front door.
   *
   * `floorY` is the height the caller *intends*, not the height used blindly:
   * it is resolved against the collision world so the player lands on the
   * surface that is actually there. Trusting the requested height outright is
   * how a door leaves somebody hanging above a pavement (a drop on every exit)
   * or a few centimetres inside a slab.
   */
  placeOnFloor(x: number, z: number, floorY: number, heading?: number): void {
    this.position.set(x, this.floorUnder(x, z, floorY), z);
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
    this.grounded = true;
    this.clearRecoil();
    if (heading !== undefined) this.yaw = heading;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    this.domElement.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.keys.clear();
  }
}
