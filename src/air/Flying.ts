/**
 * Flying an aeroplane out of Meridian Bay Regional.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   const flying = new Flying({
 *     aircraft, collision, camera, controller, domElement,
 *     groundY:   (x, z) => ground.sample(x, z).y,
 *     standable: (x, z) => ground.isInBounds(x, z) && ground.sample(x, z).surface !== 'water',
 *   });
 *
 *   flying.tryEnter(x, z);          // E, when Driving refused
 *   flying.exit();                  // E; returns false in the air
 *   flying.update(dt);              // once a frame, before the camera is read
 *   flying.state;                   // airspeed, altitude, attitude, throttle
 *   flying.dispose();
 *
 * ============================================================================
 *
 * ## Shape
 *
 * Deliberately the same shape as `Driving`: `tryEnter(x, z)` / `exit()` /
 * `update(dt)` / `state`, a handle taken from the system that owns the
 * vehicle, and a chase camera on a boom that shortens against geometry. The
 * differences are all in the middle - the model is `flight.ts` rather than a
 * bicycle model, and the camera is behind the aircraft rather than in the
 * driver's seat, because there is nowhere in a cockpit to look from that shows
 * you what an aeroplane is doing.
 *
 * ## Controls, and why pitch is inverted
 *
 * `W` pitches the NOSE DOWN and `S` pitches it UP. That is a stick, not a
 * throttle: pulling back climbs, pushing forward descends, and every flight
 * game that maps a centre stick to a keyboard does it this way. Binding `W` to
 * "climb" would read fine for one second and then be wrong for the whole of
 * every landing, where the entire job is holding the nose off with back
 * pressure. The throttle is on Shift and Control, so `W` is not competing with
 * anything a driver would expect it to do.
 *
 * `Q`/`E` were the obvious rudder keys and are not usable: `E` is the game's
 * "get in / get out" key everywhere else, and rebinding it inside one vehicle
 * is how a player ends up unable to get out of an aeroplane. The rudder is on
 * `Z` and `C` - bottom row, left hand, where pedals belong - with the sim
 * convention `,` and `.` accepted as well, which costs nothing.
 *
 * `FLIGHT_CONTROLS` below is the same `ControlHint[]` shape as `CONTROL_HINTS`
 * in `ui/PauseMenu`, so the Controls tab can render it with the loop it
 * already has.
 *
 * ## Getting out
 *
 * Refused in the air and refused while moving. There is no parachute in this
 * game and no animation for stepping out of a moving aeroplane, so the honest
 * options were "refuse" or "kill the player", and refusing is the one that
 * does not need a death screen nobody asked for. On the ground the placement
 * is vetted exactly the way `Driving.exit` vets its own: beside a wingtip
 * first, then behind the tail, then - only if the world has nowhere else -
 * where the aircraft is.
 */

import type { PerspectiveCamera } from 'three';

import { clamp } from '../core/mathx';
import { BODY_HEIGHT, BODY_RADIUS } from '../player/FirstPersonController';
import type { CollisionWorld } from '../player/Collision';
import { detectPlatform, type ControlHint, type Platform } from '../ui/platform';
import { AIRCRAFT, type AircraftSpec, type AircraftType } from './AircraftCatalogue';
import {
  advanceFlight,
  airspeed as airspeedOf,
  angleOfAttack,
  contactHeight,
  createFlightControls,
  createFlightEvents,
  createFlightState,
  groundSpeed as groundSpeedOf,
  stallFraction,
  trimLevelFlight,
  applyTrim,
  type FlightControls,
  type FlightEvents,
  type FlightState,
  type FlightWorld,
} from './flight';
import type { AircraftHandle, AircraftPose, AircraftSystem } from './AircraftSystem';

/** How fast a held key drives a control surface to full deflection, per second. */
const STICK_RATE = 3.0;
/** How fast a released control returns to centre, per second. */
const STICK_CENTRING = 4.2;
/** Throttle lever travel per second: about 1.7 s from idle to the stop. */
const THROTTLE_RATE = 0.6;

/** Ground speed above which stepping out is refused, m/s. A brisk walk. */
const EXIT_SPEED_LIMIT = 2.5;

/** How quickly the chase boom follows the aircraft, per second. */
const CAM_LAG = 5;
/**
 * How much of the aircraft's bank the camera takes.
 *
 * All of it and the player loses the horizon as a reference; none of it and a
 * turn reads as a flat slide. 0.7 keeps a visible horizon tilt without the
 * frame ever going fully sideways.
 */
const CAM_BANK = 0.7;

/** Seconds after a write-off before the player is put out on the ground. */
const WRECK_EJECT_SECONDS = 2.5;

/** Matches `FirstPersonController`; kept local so `src/air` owns no player state. */
const PLAYER_CLEARANCE = 1.6;

/**
 * The control list, in the same shape as `CONTROL_HINTS` in `ui/PauseMenu`.
 *
 * Only the modifier labels differ by platform, for exactly the reason
 * `ui/platform` gives: a hint that prints a key the player does not have is
 * worse than no hint.
 */
export function flightControlHints(platform: Platform = detectPlatform()): readonly ControlHint[] {
  const mac = platform === 'mac';
  return [
    { keys: 'S / Down', action: 'Pull back - nose up' },
    { keys: 'W / Up', action: 'Push forward - nose down' },
    { keys: 'A / D or Left / Right', action: 'Roll left / right' },
    { keys: 'Z / C (or , / .)', action: 'Rudder, and nose-wheel steering' },
    { keys: mac ? '⇧ Shift / ⌃ Control' : 'Shift / Ctrl', action: 'Throttle up / down' },
    { keys: 'Space', action: 'Wheel brakes' },
    { keys: 'G', action: 'Landing gear (retractable types)' },
    { keys: 'Mouse', action: 'Look around the aircraft' },
    { keys: 'E', action: 'Get out - stopped, on the ground' },
  ];
}

/** Resolved once, like `CONTROL_HINTS`: nobody changes machine mid-flight. */
export const FLIGHT_CONTROLS: readonly ControlHint[] = flightControlHints();

/**
 * The slice of the walking player this module touches.
 *
 * Structural rather than `FirstPersonController` itself, so a unit test can
 * pass two functions and the game can pass the real controller unchanged.
 */
export interface FlyingPlayer {
  teleport(x: number, z: number, heading?: number): void;
  setPaused(paused: boolean): void;
}

/** The engine, as whoever owns the audio wants to hear about it. */
export interface EngineReport {
  x: number;
  y: number;
  z: number;
  /**
   * Engine speed. A real figure per engine family rather than a normalised
   * one, because a piston at 2700 and a fan at 22000 are different sounds:
   * piston 700-2700, turboprop 1000-1900 (gas generator), fan 5000-22000.
   */
  rpm: number;
  /** Spooled throttle, 0..1. Lags the lever; this is the one to mix on. */
  throttle: number;
  airspeed: number;
  type: AircraftType;
  onGround: boolean;
}

export interface FlyingOptions {
  readonly aircraft: AircraftSystem;
  readonly collision: CollisionWorld;
  /** Ground height at a point, metres above sea level. */
  readonly groundY: (x: number, z: number) => number;
  /** True where the player could be put down on foot. Defaults to anywhere. */
  readonly standable?: ((x: number, z: number) => boolean) | undefined;
  /** Omit for a headless test; the model runs without any of these. */
  readonly camera?: PerspectiveCamera | null | undefined;
  readonly controller?: FlyingPlayer | null | undefined;
  readonly domElement?: HTMLElement | null | undefined;
}

export interface FlyingState {
  readonly flying: boolean;
  readonly type: AircraftType | null;
  readonly label: string | null;
  /** Ground contact point of the aircraft - where the wheels are. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  /** Nose-up radians. */
  readonly pitch: number;
  /** Right-wing-down radians. */
  readonly bank: number;
  /** True airspeed, m/s. */
  readonly airspeed: number;
  readonly groundSpeed: number;
  /** Wheel height above sea level, m. */
  readonly altitude: number;
  /** Wheel height above the ground under them, m. */
  readonly altitudeAgl: number;
  /** Rate of climb, m/s. Positive up. */
  readonly verticalSpeed: number;
  /** Spooled throttle, 0..1. */
  readonly throttle: number;
  readonly onGround: boolean;
  readonly gearDown: boolean;
  /** 0 attached, 1 fully separated. Above about 0.2 the wing has let go. */
  readonly stall: number;
  readonly angleOfAttack: number;
  readonly crashed: boolean;
}

const IDLE_STATE: FlyingState = {
  flying: false,
  type: null,
  label: null,
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  bank: 0,
  airspeed: 0,
  groundSpeed: 0,
  altitude: 0,
  altitudeAgl: 0,
  verticalSpeed: 0,
  throttle: 0,
  onGround: true,
  gearDown: true,
  stall: 0,
  angleOfAttack: 0,
  crashed: false,
};

export class Flying {
  private readonly options: FlyingOptions;
  private handle: AircraftHandle | null = null;
  private spec: AircraftSpec | null = null;
  private flight: FlightState | null = null;

  private readonly events: FlightEvents = createFlightEvents();
  private readonly controls: FlightControls = createFlightControls();
  private readonly keys = new Set<string>();

  /** Where this frame started, for the collision world's containment waiver. */
  private fromX = 0;
  private fromZ = 0;

  private throttleLever = 0;
  private gearLever = true;
  private gearLatch = false;
  private lookYaw = 0;
  private lookPitch = 0;
  private wreckTimer = 0;

  private camX = 0;
  private camY = 0;
  private camZ = 0;

  /** Reused so a frame of flight allocates nothing. See `onEngine`. */
  private readonly engineReport: EngineReport = {
    x: 0,
    y: 0,
    z: 0,
    rpm: 0,
    throttle: 0,
    airspeed: 0,
    type: 'cessna',
    onGround: true,
  };

  /**
   * Per-frame engine state, for the audio layer. The object is LIVE and reused
   * - read it inside the callback, never retain it.
   */
  onEngine: ((info: EngineReport) => void) | null = null;
  /** Wheels on the ground. `verticalSpeed` is positive downward, m/s. */
  onTouchdown: ((x: number, y: number, z: number, verticalSpeed: number) => void) | null = null;
  /** Something solid. `severity` is 0 for a scrape, 1 for a write-off. */
  onImpact: ((x: number, y: number, z: number, severity: number) => void) | null = null;

  constructor(options: FlyingOptions) {
    this.options = options;
    // `window` is absent in the headless tests, and the model has to run there.
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
      window.addEventListener('blur', this.onBlur);
    }
    options.domElement?.addEventListener('mousemove', this.onMouseMove);
  }

  get flying(): boolean {
    return this.handle !== null;
  }

  get state(): FlyingState {
    const flight = this.flight;
    const spec = this.spec;
    const handle = this.handle;
    if (!flight || !spec || !handle) return IDLE_STATE;
    const contact = contactHeight(flight, spec);
    return {
      flying: true,
      type: handle.type,
      label: spec.label,
      x: flight.x,
      y: contact,
      z: flight.z,
      yaw: flight.yaw,
      pitch: flight.pitch,
      bank: flight.roll,
      airspeed: airspeedOf(flight),
      groundSpeed: groundSpeedOf(flight),
      altitude: contact,
      altitudeAgl: contact - this.options.groundY(flight.x, flight.z),
      verticalSpeed: flight.vy,
      throttle: flight.throttle,
      onGround: flight.onGround,
      gearDown: flight.gear > 0.5,
      stall: stallFraction(spec, angleOfAttack(flight)),
      angleOfAttack: angleOfAttack(flight),
      crashed: flight.crashed,
    };
  }

  /** The aircraft the player would climb into from here, if any. */
  candidateAt(x: number, z: number): { id: number; type: AircraftType; label: string } | null {
    if (this.handle) return null;
    const found = this.options.aircraft.nearest(x, z);
    return found ? { id: found.id, type: found.type, label: found.spec.label } : null;
  }

  /**
   * Takes the nearest aircraft. False when there is nothing here to take, so
   * the caller can fall through to whatever else `E` does at this spot.
   */
  tryEnter(x: number, z: number): boolean {
    if (this.handle) return false;
    const found = this.options.aircraft.nearest(x, z);
    if (!found) return false;
    return this.board(found.id);
  }

  /**
   * Puts the player into a named type at a point, for automated QA.
   *
   * With no `altitude` the aircraft is moved to the point and boarded on the
   * ground. With one, it is placed there trimmed for level flight at its own
   * cruise, which is what makes an airborne check reproducible without having
   * to fly a take-off first.
   */
  placeInAircraft(
    type: AircraftType,
    x: number,
    z: number,
    heading = 0,
    altitude?: number,
  ): boolean {
    if (this.handle) this.exit(true);
    const spec = AIRCRAFT[type];
    if (!spec.flyable) return false;
    const found = this.options.aircraft.firstOfType(type);
    if (!found) return false;
    if (!this.options.aircraft.place(found.id, x, z, heading)) return false;
    if (!this.board(found.id)) return false;

    const flight = this.flight;
    if (!flight || altitude === undefined) return true;
    const trim = trimLevelFlight(spec, spec.referenceCruise, altitude);
    if (!trim) return true;
    flight.y = altitude + spec.gearHeight;
    applyTrim(flight, spec, trim);
    this.throttleLever = trim.throttle;
    this.gearLever = !spec.retractableGear;
    this.controls.elevator = trim.elevator;
    return true;
  }

  private board(id: number): boolean {
    const handle = this.options.aircraft.takeControl(id);
    if (!handle) return false;
    const info = this.options.aircraft.byId(id);
    if (!info) {
      handle.release();
      return false;
    }

    this.handle = handle;
    this.spec = handle.spec;
    this.flight = createFlightState(handle.spec, info.x, info.z, info.yaw, info.y);
    this.throttleLever = 0;
    this.gearLever = true;
    this.gearLatch = false;
    this.wreckTimer = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.controls.elevator = 0;
    this.controls.aileron = 0;
    this.controls.rudder = 0;
    this.controls.throttle = 0;
    this.controls.brakes = true;
    this.controls.gearDown = true;
    this.keys.clear();
    this.seatCamera();
    this.options.controller?.setPaused(true);
    return true;
  }

  /**
   * Steps out. Returns false - and does nothing - in the air or while moving.
   *
   * `force` is how the wreck of a crashed aeroplane lets go of the player; it
   * skips the speed and altitude checks but still vets the placement.
   */
  exit(force = false): boolean {
    const flight = this.flight;
    const spec = this.spec;
    if (!this.handle || !flight || !spec) return false;
    if (!force) {
      if (!flight.onGround) return false;
      if (groundSpeedOf(flight) > EXIT_SPEED_LIMIT) return false;
    }
    this.leave(flight.x, flight.z);
    return true;
  }

  /** Releases the aircraft and puts the player on the ground beside it. */
  private leave(x: number, z: number): void {
    const flight = this.flight;
    const spec = this.spec;
    const handle = this.handle;
    if (!handle || !spec || !flight) return;

    const yaw = flight.yaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = -fz;
    const rz = fx;
    // Off a wingtip first, then behind the tail. A wingtip is the only place
    // beside an airliner that is not still under the wing.
    const side = spec.halfWidth + PLAYER_CLEARANCE;
    const back = spec.halfLength + PLAYER_CLEARANCE;
    const candidates: readonly (readonly [number, number])[] = [
      [x - rx * side, z - rz * side],
      [x + rx * side, z + rz * side],
      [x - fx * back, z - fz * back],
      [x, z],
    ];

    let placed = false;
    for (const candidate of candidates) {
      const cx = candidate[0];
      const cz = candidate[1];
      if (!this.standableAt(cx, cz)) continue;
      this.options.controller?.teleport(cx, cz, yaw);
      placed = true;
      break;
    }
    if (!placed) this.options.controller?.teleport(x, z, yaw);

    handle.setPose(this.poseFrom(flight, spec));
    handle.release();
    this.handle = null;
    this.spec = null;
    this.flight = null;
    this.keys.clear();
    this.options.controller?.setPaused(false);
  }

  /** True when the player could stand here: solid, clear and out of the sea. */
  private standableAt(x: number, z: number): boolean {
    const standable = this.options.standable;
    if (standable && !standable(x, z)) return false;
    const y = this.options.groundY(x, z);
    if (this.options.collision.isStuck(x, z, y, BODY_HEIGHT, BODY_RADIUS)) return false;
    // Standing inside another aeroplane is not a placement either.
    return !this.options.aircraft.blockedBy(
      x,
      z,
      0,
      BODY_RADIUS,
      BODY_RADIUS,
      y,
      y + BODY_HEIGHT,
      this.handle?.id ?? -1,
    );
  }

  /**
   * Flies the aircraft for one frame.
   *
   * `override` replaces the keyboard entirely, which is how the unit tests fly
   * a measured take-off and how a QA hook could fly one without synthesising
   * key events.
   */
  update(dt: number, override?: Readonly<FlightControls>): void {
    const flight = this.flight;
    const spec = this.spec;
    const handle = this.handle;
    if (!flight || !spec || !handle) return;

    const controls = override ? this.copyControls(override) : this.readInput(dt, spec);
    this.fromX = flight.x;
    this.fromZ = flight.z;
    advanceFlight(flight, controls, spec, this.world, this.events, dt);
    handle.setPose(this.poseFrom(flight, spec));

    this.reportEvents(flight, spec);
    this.reportEngine(flight, spec, handle.type);
    this.updateCamera(dt, flight, spec);

    if (flight.crashed) {
      this.wreckTimer += dt;
      // Let the wreck come to rest, then hand the player back. Leaving them
      // sealed inside a written-off aeroplane would be a soft lock.
      if (this.wreckTimer > WRECK_EJECT_SECONDS && groundSpeedOf(flight) < 4) this.exit(true);
    }
  }

  private copyControls(source: Readonly<FlightControls>): FlightControls {
    this.controls.elevator = source.elevator;
    this.controls.aileron = source.aileron;
    this.controls.rudder = source.rudder;
    this.controls.throttle = source.throttle;
    this.controls.brakes = source.brakes;
    this.controls.gearDown = source.gearDown;
    this.throttleLever = source.throttle;
    this.gearLever = source.gearDown;
    return this.controls;
  }

  /**
   * Turns held keys into control positions.
   *
   * The surfaces RAMP rather than snapping: a keyboard has no analogue axis, so
   * without a rate limit every input is a full-deflection input and the
   * aeroplane is impossible to fly smoothly. They also self-centre, which is
   * what a spring-loaded stick does and what makes hands-off flight settle.
   */
  private readInput(dt: number, spec: AircraftSpec): FlightControls {
    const pitchInput =
      (this.pressed('KeyS', 'ArrowDown') ? 1 : 0) - (this.pressed('KeyW', 'ArrowUp') ? 1 : 0);
    const rollInput =
      (this.pressed('KeyD', 'ArrowRight') ? 1 : 0) - (this.pressed('KeyA', 'ArrowLeft') ? 1 : 0);
    const yawInput =
      (this.pressed('KeyC', 'Period') ? 1 : 0) - (this.pressed('KeyZ', 'Comma') ? 1 : 0);

    this.controls.elevator = axis(this.controls.elevator, pitchInput, dt);
    this.controls.aileron = axis(this.controls.aileron, rollInput, dt);
    this.controls.rudder = axis(this.controls.rudder, yawInput, dt);

    const up = this.pressed('ShiftLeft', 'ShiftRight') ? 1 : 0;
    const down = this.pressed('ControlLeft', 'ControlRight') ? 1 : 0;
    this.throttleLever = clamp(this.throttleLever + (up - down) * THROTTLE_RATE * dt, 0, 1);
    this.controls.throttle = this.throttleLever;

    this.controls.brakes = this.keys.has('Space');

    // The gear lever is edge-triggered: holding G must not cycle it.
    const gearKey = this.keys.has('KeyG');
    if (gearKey && !this.gearLatch && spec.retractableGear) this.gearLever = !this.gearLever;
    this.gearLatch = gearKey;
    this.controls.gearDown = spec.retractableGear ? this.gearLever : true;

    return this.controls;
  }

  private poseFrom(flight: FlightState, spec: AircraftSpec): AircraftPose {
    this.pose.x = flight.x;
    this.pose.y = contactHeight(flight, spec);
    this.pose.z = flight.z;
    this.pose.yaw = flight.yaw;
    this.pose.pitch = flight.pitch;
    this.pose.roll = flight.roll;
    this.pose.power = flight.throttle;
    this.pose.wrecked = flight.crashed;
    return this.pose;
  }

  private readonly pose: AircraftPose = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    power: 0,
    wrecked: false,
  };

  private reportEvents(flight: FlightState, spec: AircraftSpec): void {
    const events = this.events;
    const contact = contactHeight(flight, spec);
    if (events.touchdown && this.onTouchdown) {
      this.onTouchdown(flight.x, contact, flight.z, events.touchdownVs);
    }
    if (events.impact && this.onImpact) {
      // Severity is scaled by the speed that writes this airframe off, so a
      // graze is a graze whatever is flying and a write-off is always 1.
      const severity = clamp(events.impactSpeed / spec.impactCrashSpeed, 0, 1);
      this.onImpact(flight.x, contact, flight.z, severity);
    }
  }

  private reportEngine(flight: FlightState, spec: AircraftSpec, type: AircraftType): void {
    const report = this.onEngine;
    if (!report) return;
    const info = this.engineReport;
    info.x = flight.x;
    info.y = contactHeight(flight, spec);
    info.z = flight.z;
    info.rpm = engineRpm(spec, flight.throttle, flight.crashed);
    info.throttle = flight.crashed ? 0 : flight.throttle;
    info.airspeed = airspeedOf(flight);
    info.type = type;
    info.onGround = flight.onGround;
    report(info);
  }

  // -- world ------------------------------------------------------------------

  /**
   * What the flight model is allowed to ask about the world.
   *
   * Two closures, created once. `blocked` combines the baked city with the
   * other aircraft, and passes this frame's starting point as the containment
   * waiver - without it an aeroplane whose box happens to overlap a terminal
   * pier on its stand would be refused every direction at once and pinned.
   *
   * Note what is NOT here: `CollisionWorld.setVehicleSource` is owned by
   * `Driving` for the whole game, so aircraft-versus-traffic is out of scope
   * and aircraft-versus-aircraft is answered by `AircraftSystem` instead.
   */
  private readonly world: FlightWorld = {
    groundY: (x: number, z: number): number => this.options.groundY(x, z),
    blocked: (
      x: number,
      z: number,
      yaw: number,
      halfLength: number,
      halfWidth: number,
      bottom: number,
      top: number,
    ): boolean => {
      if (
        this.options.collision.blockedBox(
          x,
          z,
          yaw,
          halfLength,
          halfWidth,
          bottom,
          top,
          this.fromX,
          this.fromZ,
        )
      ) {
        return true;
      }
      return this.options.aircraft.blockedBy(
        x,
        z,
        yaw,
        halfLength,
        halfWidth,
        bottom,
        top,
        this.handle?.id ?? -1,
      );
    },
  };

  // -- camera -----------------------------------------------------------------

  private seatCamera(): void {
    const flight = this.flight;
    const spec = this.spec;
    if (!flight || !spec) return;
    const distance = boomLength(spec);
    this.camX = flight.x + Math.sin(flight.yaw) * distance;
    this.camY = flight.y + boomHeight(spec);
    this.camZ = flight.z + Math.cos(flight.yaw) * distance;
  }

  /**
   * Chase camera on a trailing boom, shortened when something solid is behind
   * the aircraft - taxiing back toward a hangar wall must not put the view
   * inside it. The boom, its height and its floor are all scaled by the
   * aircraft, because 6.6 m behind an airliner is inside the airliner.
   */
  private updateCamera(dt: number, flight: FlightState, spec: AircraftSpec): void {
    const camera = this.options.camera;
    if (!camera) return;
    const full = boomLength(spec);
    const floor = spec.halfLength + 2.5;
    const camYaw = flight.yaw + this.lookYaw;
    const bx = Math.sin(camYaw);
    const bz = Math.cos(camYaw);
    const eyeY = flight.y + boomHeight(spec) + this.lookPitch * -(full * 0.4);

    let distance = full;
    for (let i = 0; i < 6; i += 1) {
      const test = full - i * ((full - floor) / 5);
      if (!this.options.collision.isStuck(flight.x + bx * test, flight.z + bz * test, eyeY, 1.2, 0.6)) {
        distance = test;
        break;
      }
      distance = floor;
    }

    const follow = Math.min(1, dt * CAM_LAG);
    this.camX += (flight.x + bx * distance - this.camX) * follow;
    this.camY += (eyeY - this.camY) * follow;
    this.camZ += (flight.z + bz * distance - this.camZ) * follow;

    camera.position.set(this.camX, this.camY, this.camZ);
    camera.up.set(0, 1, 0);
    camera.lookAt(flight.x, flight.y, flight.z);
    // Negative, so a right-wing-down bank drops the right of the frame.
    camera.rotateZ(-flight.roll * CAM_BANK);
  }

  // -- lifecycle --------------------------------------------------------------

  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
      window.removeEventListener('blur', this.onBlur);
    }
    this.options.domElement?.removeEventListener('mousemove', this.onMouseMove);
    this.keys.clear();
    this.handle?.release();
    this.handle = null;
    this.flight = null;
    this.spec = null;
  }

  private pressed(...codes: string[]): boolean {
    for (const code of codes) if (this.keys.has(code)) return true;
    return false;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.handle) return;
    this.keys.add(event.code);
    // Arrows and Space scroll the page otherwise, which fights the aeroplane.
    if (event.code.startsWith('Arrow') || event.code === 'Space') event.preventDefault();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  /** A lost focus must not leave the throttle open and the stick hard over. */
  private readonly onBlur = (): void => {
    this.keys.clear();
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.handle) return;
    if (
      typeof document !== 'undefined' &&
      this.options.domElement &&
      document.pointerLockElement !== this.options.domElement
    ) {
      return;
    }
    this.lookYaw = clamp(this.lookYaw - event.movementX * 0.0022, -2.2, 2.2);
    this.lookPitch = clamp(this.lookPitch - event.movementY * 0.0022, -0.7, 0.6);
  };
}

/** One control axis: ramp toward the input, spring back to centre when free. */
function axis(current: number, input: number, dt: number): number {
  if (input === 0) {
    const back = STICK_CENTRING * dt;
    if (Math.abs(current) <= back) return 0;
    return current - Math.sign(current) * back;
  }
  return clamp(current + input * STICK_RATE * dt, -1, 1);
}

/** Boom length, scaled so the whole aircraft fits in frame with room ahead. */
function boomLength(spec: AircraftSpec): number {
  return spec.length * 1.4 + 6;
}

function boomHeight(spec: AircraftSpec): number {
  return spec.height * 0.85 + 3;
}

/**
 * Engine speed for the audio layer.
 *
 * Three families, three ranges, because they are three different sounds: a
 * piston revs with the throttle, a turboprop's propeller is nearly
 * constant-speed so the gas generator is what varies, and a fan spends its
 * life between 25 and 100 per cent N1.
 */
function engineRpm(spec: AircraftSpec, throttle: number, crashed: boolean): number {
  if (crashed) return 0;
  const t = clamp(throttle, 0, 1);
  if (spec.engine === 'piston') return 700 + 2000 * t;
  if (spec.engine === 'turboprop') return 1000 + 900 * t;
  return 5000 + 17000 * t;
}
