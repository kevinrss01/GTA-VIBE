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
 * ## Two control mappings, and which one is the default
 *
 * **Assisted is the default.** Up climbs, Down descends, Left and Right turn,
 * Shift is the throttle. `assist.ts` converts that into stick, pedals and the
 * back-pressure a turn needs, and writes it into the same `FlightControls` the
 * direct mapping writes - the flight model is identical either way and nothing
 * is faked. The reason it is the default is a player report: they got into an
 * aeroplane, could not work out how to fly it, and gave up. Pressing `Up` and
 * watching the nose drop is the first thing that happens on the direct
 * mapping, and it is enough to end the attempt.
 *
 * **Direct is the stick**, and it is still here. `W` pitches the NOSE DOWN and
 * `S` pitches it UP; that is a centre stick, not a throttle, and every flight
 * game that maps one to a keyboard does it this way. Binding `W` to "climb"
 * would read fine for one second and then be wrong for the whole of every
 * landing, where the entire job is holding the nose off with back pressure.
 * `A`/`D` roll rather than turn, and the rudder is on `Z`/`C` - `Q`/`E` were
 * the obvious pedals and are not usable, because `E` is the game's "get in and
 * out" key everywhere else and rebinding it inside one vehicle is how a player
 * ends up unable to leave an aeroplane.
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
 *
 * ## Taking the controls
 *
 * The key set is a FAITHFUL MIRROR OF THE KEYBOARD, held whether or not this
 * object currently owns an aeroplane, and `board` does not clear it. That is
 * not tidiness either; it is the difference between the aeroplane working and
 * not working. Shift is the game's run key, so the ordinary way a player
 * arrives at an aeroplane is at a sprint with Shift already down. An earlier
 * version ignored every keydown while no aircraft was held and then wiped the
 * set on boarding, so the throttle key the player was ALREADY HOLDING had
 * never been seen and never would be: full throttle produced nothing at all
 * until they let go and pressed it again. The same applied to W, S, A, D and
 * the arrows, which are the walking keys. Control ownership transfers with
 * the keys as they actually are.
 *
 * ## Getting unstuck
 *
 * `CollisionWorld` and `AircraftSystem` both answer "is this footprint inside
 * something solid" with a boolean, and `flight.ts` answers a refusal by
 * zeroing the refused velocity components. Together those mean an aeroplane
 * that meets a small immovable object is stopped DEAD and stays stopped: at
 * rest the nose wheel steers by `along * tan(angle)`, which is zero, and the
 * rudder's moment is proportional to dynamic pressure, which is also zero, so
 * it cannot even turn away. That is a soft-locked aeroplane with no feedback,
 * and it was live: a ground-power cart sits 0.6 m in front of the Light twin's
 * nose on stand 3, so the twin taxied 0.6 m and stopped for ever.
 *
 * Two things answer it. The jam is REPORTED - `state.blocked` and
 * `state.blockedSeconds`, which the HUD shows - and after `JAM_SECONDS` of
 * pushing, ground clutter GIVES WAY. Clutter is defined by measurement, not by
 * a list: the same footprint is re-tested in the band from `CLUTTER_HEIGHT`
 * above the wheels upward, and the obstruction only yields when that band is
 * clear, i.e. when everything refusing the aeroplane is shorter than a person.
 * A wall, a pier, a hangar or another aeroplane never yields, and none of it
 * applies in the air or above taxi speed.
 */

import type { PerspectiveCamera } from 'three';

import { clamp } from '../core/mathx';
import { BODY_HEIGHT, BODY_RADIUS } from '../player/FirstPersonController';
import type { CollisionWorld } from '../player/Collision';
import { detectPlatform, type ControlHint, type Platform } from '../ui/platform';
import { AIRCRAFT, type AircraftSpec, type AircraftType } from './AircraftCatalogue';
import { applyFlightAssist } from './assist';
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

/**
 * How long an aeroplane must push against ground clutter before it gives way.
 *
 * Long enough that it is never mistaken for a collision response - a wall
 * still stops the aircraft on the frame it is touched, and stays stopping it -
 * and short enough that a player who has just applied power sees the aircraft
 * move rather than concluding the controls are dead.
 */
const JAM_SECONDS = 1;
/**
 * Ground speed under which a refusal is a jam rather than a crash, m/s.
 *
 * A taxi speed. Above it the aircraft is arriving at the obstruction, not
 * leaning on it, and `flight.ts` should be free to report the impact and break
 * the airframe exactly as it does today.
 */
const JAM_SPEED = 8;
/**
 * Height above the wheels below which an obstruction counts as ground clutter.
 *
 * Measured against the airport's own props: a ground-power cart is 1.3 m, a
 * baggage cart 1.6 m, a tug 1.9 m, a bollard 0.6 m. The things that must never
 * yield are all far taller - air stairs 3.4 m, the fuel bowser 2.9 m, the
 * terminal, the hangars and the tower - so 2.2 m separates them with a margin
 * at both ends rather than threading a gap.
 */
const CLUTTER_HEIGHT = 2.2;

/**
 * How long the contextual control panel stays up once the aircraft is rolling.
 *
 * It holds indefinitely while the aeroplane is stopped on the ground, which is
 * exactly when a player is reading it, and fades this many seconds after they
 * start doing something, which is exactly when they are not.
 */
const HINT_HOLD_SECONDS = 7;
/** Ground speed above which the aircraft counts as under way, m/s. */
const HINT_IDLE_SPEED = 1.5;

/** Matches `FirstPersonController`; kept local so `src/air` owns no player state. */
const PLAYER_CLEARANCE = 1.6;

/**
 * The control list, in the same shape as `CONTROL_HINTS` in `ui/PauseMenu`.
 *
 * Only the modifier labels differ by platform, for exactly the reason
 * `ui/platform` gives: a hint that prints a key the player does not have is
 * worse than no hint.
 */
export function flightControlHints(
  platform: Platform = detectPlatform(),
  assist = true,
): readonly ControlHint[] {
  const mac = platform === 'mac';
  if (assist) {
    /*
     * The ASSISTED mapping, which is what the player is flying unless they
     * turned it off - so it is what the Controls tab has to describe. A
     * reference that documents a different set of keys from the ones the
     * aeroplane answers is worse than no reference.
     */
    return [
      { keys: '↑ / W', action: 'Climb' },
      { keys: '↓ / S', action: 'Descend' },
      { keys: '← / A', action: 'Turn left' },
      { keys: '→ / D', action: 'Turn right' },
      { keys: mac ? '⇧ Shift / ⌃ Control' : 'Shift / Ctrl', action: 'Throttle up / down' },
      { keys: 'Space', action: 'Wheel brakes' },
      { keys: 'G', action: 'Landing gear (retractable types)' },
      { keys: 'Mouse', action: 'Look around the aircraft' },
      { keys: 'E', action: 'Get out - stopped, on the ground' },
    ];
  }
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
/** The direct stick, for a player who has turned the assist off. */
export const FLIGHT_CONTROLS_DIRECT: readonly ControlHint[] = flightControlHints(
  detectPlatform(),
  false,
);

/**
 * The subset the in-flight HUD panel shows, with labels written for a corner
 * of the screen rather than for a settings page.
 *
 * The Controls tab keeps all nine and keeps the long wording - it is a
 * reference and the reader is not flying at the time. The panel is an overlay
 * competing with the airspeed readout and the vitals bar, and measured at
 * 844x424 the full list was 187 px tall and reached across into the prompt.
 * Mouse-look and the gear lever are the two a player discovers without being
 * told, so they are the two that go.
 */
export function flightHudHints(
  platform: Platform = detectPlatform(),
  assist = true,
): readonly ControlHint[] {
  const mac = platform === 'mac';
  if (assist) {
    // Five lines, in the order a player needs them: get it moving, get it off
    // the ground, point it somewhere, put it down.
    return [
      { keys: mac ? '⇧ Shift' : 'Shift', action: 'Throttle up' },
      { keys: '↑ / W', action: 'Climb' },
      { keys: '↓ / S', action: 'Descend' },
      { keys: '← / A', action: 'Turn left' },
      { keys: '→ / D', action: 'Turn right' },
      { keys: 'Space', action: 'Brakes' },
      { keys: 'E', action: 'Get out (stopped)' },
    ];
  }
  return [
    { keys: 'S / W', action: 'Nose up / down' },
    { keys: 'A / D', action: 'Roll' },
    { keys: 'Z / C', action: 'Rudder, steering' },
    { keys: mac ? '⇧ / ⌃' : 'Shift / Ctrl', action: 'Throttle' },
    { keys: 'Space', action: 'Brakes' },
    { keys: 'E', action: 'Get out (stopped)' },
  ];
}

/** Resolved once, for the same reason as `FLIGHT_CONTROLS`. */
export const FLIGHT_HUD_CONTROLS: readonly ControlHint[] = flightHudHints();
/** The direct mapping's panel, for a player who has turned the assist off. */
export const FLIGHT_HUD_CONTROLS_DIRECT: readonly ControlHint[] = flightHudHints(
  detectPlatform(),
  false,
);

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
  /**
   * True while the aircraft is being refused by solid geometry on the ground.
   *
   * The one thing a pinned aeroplane owes the player is an explanation, so
   * this is deliberately part of the public state rather than an internal
   * detail: the HUD reads it, and so does the QA harness.
   */
  readonly blocked: boolean;
  /** How long it has been blocked, seconds. Zero when it is not. */
  readonly blockedSeconds: number;
}

/** The contextual control panel, as the HUD wants it. */
export interface FlightHintState {
  readonly hints: readonly ControlHint[];
  /**
   * True while the panel should stay up regardless of its age: the aeroplane
   * is stopped on the ground, or it is jammed and the player needs to know why.
   */
  readonly hold: boolean;
  /** A short line about why the aeroplane is not moving, or null. */
  readonly warning: string | null;
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
  blocked: false,
  blockedSeconds: 0,
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

  /** How long the aircraft has been refused by something solid, seconds. */
  private jamSeconds = 0;
  /**
   * Whether ground clutter may give way this frame.
   *
   * Read inside `world.blocked`, which is called from deep inside the
   * integrator and has no other way to know how long the jam has lasted.
   */
  private shoving = false;
  /** Seconds since boarding, for ageing the contextual control panel. */
  private hintAge = 0;

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
      blocked: this.jamSeconds > 0,
      blockedSeconds: this.jamSeconds,
    };
  }

  /** The aircraft the player would climb into from here, if any. */
  candidateAt(x: number, z: number): { id: number; type: AircraftType; label: string } | null {
    if (this.handle) return null;
    const found = this.options.aircraft.nearest(x, z);
    return found ? { id: found.id, type: found.type, label: found.spec.label } : null;
  }

  /**
   * The line to put under the crosshair while the player is standing here, or
   * null when there is no aircraft within reach.
   *
   * The non-flyable case is why this exists rather than the caller formatting
   * `candidateAt` itself. Walking up to the airliner used to show nothing and
   * `E` used to do nothing, which is indistinguishable from a broken key; the
   * catalogue already carries the reason it cannot be taken, so it is said.
   */
  promptAt(x: number, z: number): string | null {
    if (this.handle) return null;
    const flyable = this.options.aircraft.nearest(x, z);
    if (flyable) return `Press E to board the ${flyable.spec.label}`;
    const grounded = this.options.aircraft.nearest(x, z, false);
    if (!grounded) return null;
    const reason = grounded.spec.groundedReason;
    return reason ? `${grounded.spec.label} — ${reason}` : `${grounded.spec.label} — not flyable`;
  }

  /**
   * The contextual control panel, or null when the player is not in anything.
   *
   * Computed here rather than in the HUD because everything it depends on -
   * what is being flown, whether it is stopped, whether it is jammed - lives
   * here, and because the platform-dependent key LABELS are already resolved
   * by `flightControlHints`.
   */
  get hintState(): FlightHintState | null {
    const flight = this.flight;
    if (!flight) return null;
    const stopped = flight.onGround && groundSpeedOf(flight) < HINT_IDLE_SPEED;
    const jammed = this.jamSeconds >= JAM_SECONDS * 0.25;
    // Written into a reused object rather than a fresh literal: this is read
    // once a frame for as long as the player is flying, and the HUD compares
    // fields rather than identity, so a new object every frame would be pure
    // garbage. `hints` is a module constant, so its identity is stable and the
    // HUD can use that to skip rebuilding the rows.
    this.hint.hold = stopped || jammed || this.hintAge < HINT_HOLD_SECONDS;
    this.hint.warning = jammed ? 'Blocked — something solid ahead' : null;
    return this.hint;
  }

  private readonly hint: {
    hints: readonly ControlHint[];
    hold: boolean;
    warning: string | null;
  } = { hints: FLIGHT_HUD_CONTROLS, hold: false, warning: null };

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
    // Seeded from the keyboard rather than from `false`, so a `G` that is
    // already down when the player climbs in does not read as a fresh press
    // and cycle the undercarriage on the first frame.
    this.gearLatch = this.keys.has('KeyG');
    this.wreckTimer = 0;
    this.jamSeconds = 0;
    this.shoving = false;
    this.hintAge = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.controls.elevator = 0;
    this.controls.aileron = 0;
    this.controls.rudder = 0;
    this.controls.throttle = 0;
    this.controls.brakes = true;
    this.controls.gearDown = true;
    // The key set is NOT cleared. See the header: the player arrives holding
    // the run key, and that key is the throttle.
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
    this.jamSeconds = 0;
    this.shoving = false;
    // The key set survives, for the same reason `board` does not clear it: it
    // is what the keyboard is currently doing, not what the aeroplane was.
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

    this.trackJam(flight, dt);
    this.hintAge += dt;
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

  /**
   * Ages the jam, and decides whether clutter may give way on the NEXT frame.
   *
   * Deciding here rather than inside `world.blocked` is deliberate: the
   * closure is called several times per sub-step and must be a pure question
   * about geometry, so the one piece of history it needs is computed once,
   * after the step that produced it.
   */
  private trackJam(flight: FlightState, dt: number): void {
    const jammed =
      this.events.blocked &&
      flight.onGround &&
      !flight.crashed &&
      groundSpeedOf(flight) < JAM_SPEED;
    this.jamSeconds = jammed ? this.jamSeconds + dt : 0;
    this.shoving = this.jamSeconds >= JAM_SECONDS;
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
    const flight = this.flight;
    const up = this.pressed('ShiftLeft', 'ShiftRight') ? 1 : 0;
    const down = this.pressed('ControlLeft', 'ControlRight') ? 1 : 0;
    /*
     * The assisted throttle moves faster, because on the assisted controls the
     * throttle is the only thing between the player and the runway and a slow
     * lever reads as an aeroplane that will not go.
     */
    const rate = this.assistOn ? THROTTLE_RATE * 2.2 : THROTTLE_RATE;
    this.throttleLever = clamp(this.throttleLever + (up - down) * rate * dt, 0, 1);

    const brakes = this.keys.has('Space');

    if (this.assistOn && flight) {
      /*
       * ASSISTED: up is up, and left and right turn.
       *
       * The signs here are the ones a player expects from a keyboard, and the
       * conversion into a stick, pedals and back-pressure is `applyFlightAssist`
       * - which writes the same `FlightControls` the direct path writes and
       * changes nothing about the flight model that acts on them.
       */
      const climb =
        (this.pressed('KeyW', 'ArrowUp') ? 1 : 0) - (this.pressed('KeyS', 'ArrowDown') ? 1 : 0);
      const turn =
        (this.pressed('KeyD', 'ArrowRight') ? 1 : 0) - (this.pressed('KeyA', 'ArrowLeft') ? 1 : 0);
      this.demand.climb = climb;
      this.demand.turn = turn;
      this.demand.throttle = this.throttleLever;
      this.demand.brakes = brakes;
      const gearKeyAssist = this.keys.has('KeyG');
      if (gearKeyAssist && !this.gearLatch && spec.retractableGear) this.gearLever = !this.gearLever;
      this.gearLatch = gearKeyAssist;
      this.demand.gearDown = spec.retractableGear ? this.gearLever : true;
      return applyFlightAssist(flight, spec, this.demand, this.controls, dt);
    }

    const pitchInput =
      (this.pressed('KeyS', 'ArrowDown') ? 1 : 0) - (this.pressed('KeyW', 'ArrowUp') ? 1 : 0);
    const rollInput =
      (this.pressed('KeyD', 'ArrowRight') ? 1 : 0) - (this.pressed('KeyA', 'ArrowLeft') ? 1 : 0);
    const yawInput =
      (this.pressed('KeyC', 'Period') ? 1 : 0) - (this.pressed('KeyZ', 'Comma') ? 1 : 0);

    this.controls.elevator = axis(this.controls.elevator, pitchInput, dt);
    this.controls.aileron = axis(this.controls.aileron, rollInput, dt);
    this.controls.rudder = axis(this.controls.rudder, yawInput, dt);

    this.controls.throttle = this.throttleLever;

    this.controls.brakes = brakes;

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

  /**
   * Whether the assisted controls are in use. ON by default.
   *
   * The direct controls are a stick and they are correct; they are also the
   * reason somebody gets in, presses Up, watches the nose drop and never gets
   * airborne. The default is the one a player can fly without being taught,
   * and the sim mapping is a setting away for anyone who wants it.
   */
  private assistOn = true;

  /** Reused, so an assisted frame allocates nothing. See `applyFlightAssist`. */
  private readonly demand: {
    climb: number;
    turn: number;
    throttle: number;
    brakes: boolean;
    gearDown: boolean;
  } = { climb: 0, turn: 0, throttle: 0, brakes: false, gearDown: true };

  get assist(): boolean {
    return this.assistOn;
  }

  /**
   * Switches between the assisted and the direct controls.
   *
   * The surfaces are re-centred on the way through: a stick position that the
   * assist was holding is not one the player asked for, and leaving it in
   * would hand them an aeroplane already rolling.
   */
  setAssist(on: boolean): void {
    if (on === this.assistOn) return;
    this.assistOn = on;
    this.controls.elevator = 0;
    this.controls.aileron = 0;
    this.controls.rudder = 0;
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
   *
   * The clutter waiver at the bottom is the second half of the jam fix
   * described in the header. It is asked ONLY after `JAM_SECONDS` of pushing,
   * only about the baked city - another aeroplane is never displaced - and
   * only when re-testing the same footprint from `CLUTTER_HEIGHT` upward comes
   * back clear, which is a measurement of the obstruction rather than a guess
   * about it.
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
        this.options.aircraft.blockedBy(
          x,
          z,
          yaw,
          halfLength,
          halfWidth,
          bottom,
          top,
          this.handle?.id ?? -1,
          this.fromX,
          this.fromZ,
        )
      ) {
        return true;
      }
      if (
        !this.options.collision.blockedBox(
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
        return false;
      }
      if (!this.shoving) return true;
      return this.options.collision.blockedBox(
        x,
        z,
        yaw,
        halfLength,
        halfWidth,
        bottom + CLUTTER_HEIGHT,
        top,
        this.fromX,
        this.fromZ,
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

  /**
   * Records the key WHETHER OR NOT an aeroplane is held. See the header: a
   * player sprints up to the aircraft with Shift down, and Shift is the
   * throttle - if the press is only recorded while already flying, the key
   * they are holding when they climb in is invisible for as long as they hold
   * it. `preventDefault` stays gated, because the page's own use of Space and
   * the arrows is only wrong while the aeroplane is being flown.
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.keys.add(event.code);
    if (!this.handle) return;
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
