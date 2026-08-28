/**
 * Officers on foot: how they move, what they decide, and where a round leaves.
 *
 * THE COMPLAINT THIS PINS. Police "slid" toward the player: they translated at
 * a speed no animation was following, pivoted to face the player with no
 * angular limit, always ran, always ran STRAIGHT at the player, and fired
 * rounds out of the middle of their chest. Measured on the old code at 60 Hz,
 * against a player merely walking a two-metre circle: peak officer
 * acceleration 384 m/s² - a standing start to 6.4 m/s inside a single frame -
 * and a peak turn rate of 7.1 rad/s, unbounded in the general case because the
 * heading was assigned `atan2` of the bearing every frame.
 *
 * Everything below is a bound, not a vibe. The kinematics and the behaviour
 * table are pure functions and are driven directly; the bounds themselves are
 * then measured out of the REAL `PoliceSystem`, frame by frame, from the
 * outside - so they hold for whatever route the code takes to move a body.
 */

import { describe, expect, it } from 'vitest';

import { buildRoadNetwork, lanePoint, type RoadNetwork } from '../src/city/RoadNetwork';
import { WorldRayIndex } from '../src/combat/rays';
import { CollisionWorld } from '../src/player/Collision';
import { PlayerState } from '../src/player/PlayerState';
import { OfficerRig, type MuzzleTransform, type OfficerPose } from '../src/police/OfficerRig';
import { PoliceSystem, type PoliceContext } from '../src/police/PoliceSystem';
import {
  approachSpeed,
  desiredSpeed,
  headingOf,
  isTravelling,
  nextBehaviour,
  rotateX,
  rotateZ,
  shortestTurn,
  shouldRun,
  stanceFor,
  steerAround,
  turnToward,
  type OfficerBehaviour,
  type OfficerSense,
  type OfficerTuning,
} from '../src/police/locomotion';
import {
  ARREST_STANDOFF,
  CLOSE_MARGIN,
  FIRING_STANDOFF,
  OFFICER_ACCEL,
  OFFICER_BRAKE,
  OFFICER_DRAW_TIME,
  OFFICER_HIT_RECOVER,
  OFFICER_LOSE_PATIENCE,
  OFFICER_MAGAZINE,
  OFFICER_NOTICE_TIME,
  OFFICER_RELOAD_TIME,
  OFFICER_REPOSITION_TIME,
  OFFICER_RUN_HYSTERESIS,
  OFFICER_RUN_RANGE,
  OFFICER_RUN_SPEED,
  OFFICER_TURN_RATE,
  OFFICER_WALK_SPEED,
} from '../src/police/policy';
import type { ColliderBox } from '../src/world/build/types';
import type { ChassisSpec, VehicleHandle, VehicleKind, VehicleView } from '../src/traffic/types';
import { getCityPlan } from '../src/world/CityPlan';

const plan = getCityPlan();
const network: RoadNetwork = buildRoadNetwork(plan);

// -- test doubles -------------------------------------------------------------

const CHASSIS: ChassisSpec = {
  length: 4.88, width: 1.92, height: 1.5, wheelbase: 2.94, track: 1.64,
  wheelRadius: 0.35, frontAxle: 1.62, mass: 1780, maxSteer: 0.62, steerRate: 2.4,
  accelMax: 3.54, brakeMax: 8, gripLateral: 7,
};

interface MutableView {
  id: number; kind: VehicleKind; police: boolean; x: number; y: number; z: number; yaw: number;
  halfLength: number; halfWidth: number; halfHeight: number; speed: number; pitch: number;
  roll: number; braking: boolean; control: 'ambient' | 'player';
}

/** The same stub fleet `police.test.ts` uses: patrol cars parked far away. */
class StubFleet {
  readonly views: MutableView[] = [];

  constructor(count: number, distance = 400) {
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      this.views.push({
        id: 100 + i, kind: 'patrolSedan', police: true,
        x: Math.cos(angle) * distance, y: 0.75, z: Math.sin(angle) * distance, yaw: 0,
        halfLength: 2.44, halfWidth: 0.96, halfHeight: 0.75, speed: 0, pitch: 0, roll: 0,
        braking: false, control: 'ambient',
      });
    }
  }

  get vehicles(): readonly VehicleView[] {
    return this.views as unknown as readonly VehicleView[];
  }

  takeControl(id: number): VehicleHandle | null {
    const view = this.views.find((v) => v.id === id && v.control === 'ambient');
    if (!view) return null;
    view.control = 'player';
    return {
      id: view.id,
      kind: view.kind,
      view: view as unknown as VehicleView,
      chassis: CHASSIS,
      setPose: (pose) => {
        view.x = pose.x;
        view.z = pose.z;
        view.yaw = pose.yaw;
        view.speed = pose.speed;
      },
      release: () => this.releaseControl(view.id),
    };
  }

  releaseControl(id: number): void {
    const view = this.views.find((v) => v.id === id);
    if (view) view.control = 'ambient';
  }
}

function onTheRoad(): { x: number; z: number } {
  const lane = network.lanes[40] ?? network.lanes[0];
  if (!lane) throw new Error('the city has no lanes');
  return lanePoint(lane, lane.length * 0.5);
}

function context(x: number, z: number, extra: Partial<PoliceContext> = {}): PoliceContext {
  return {
    time: 0, playerX: x, playerY: 0, playerZ: z, playerSpeed: 0,
    forwardX: 0, forwardZ: -1, driving: false, ...extra,
  };
}

function pinStars(player: PlayerState, stars: number): void {
  player.clearHeat();
  if (stars <= 0) return;
  let guard = 0;
  while (player.wanted < stars && guard < 2000) {
    player.addHeat(1);
    guard += 1;
  }
}

interface Harness {
  police: PoliceSystem;
  player: PlayerState;
  shots: { x: number; y: number; z: number }[];
}

function makeHarness(options: {
  colliders?: readonly ColliderBox[];
  occluders?: readonly ColliderBox[];
} = {}): Harness {
  const player = new PlayerState();
  const fleet = new StubFleet(8);
  const shots: { x: number; y: number; z: number }[] = [];
  const police = new PoliceSystem({
    player,
    traffic: fleet,
    network,
    collision: new CollisionWorld(options.colliders ?? []),
    world: new WorldRayIndex(options.occluders ?? []),
    heightAt: () => 0,
    quality: 'low',
    seed: 'police-officers',
    onOfficerShot: (x, y, z) => { shots.push({ x, y, z }); },
  });
  return { police, player, shots };
}

/** One officer, as the diagnostics getter reports them. */
type Sample = PoliceSystem['officerPoses'][number];

/**
 * Runs a chase and hands every consecutive PAIR of frames for one officer to
 * `visit`, so a per-frame bound can be measured from the outside.
 *
 * Only officers that were ALREADY on foot last frame are paired. The frame an
 * officer steps out of a car is a placement, not a stride, and pairing across
 * it would measure the width of the car as a velocity.
 */
function eachStep(
  harness: Harness,
  seconds: number,
  dt: number,
  at: (t: number) => { x: number; z: number; speed?: number },
  visit: (before: Sample, after: Sample, dt: number) => void,
  stars = 3,
): void {
  let previous = new Map<number, Sample>();
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i += 1) {
    const t = i * dt;
    pinStars(harness.player, stars);
    harness.player.heal(100);
    const where = at(t);
    harness.police.update(
      dt,
      context(where.x, where.z, { time: t, playerSpeed: where.speed ?? 0 }),
    );
    const next = new Map<number, Sample>();
    for (const pose of harness.police.officerPoses) {
      const before = previous.get(pose.id);
      if (before) visit(before, pose, dt);
      next.set(pose.id, { ...pose });
    }
    previous = next;
  }
}

// -- the kinematics -----------------------------------------------------------

describe('officer kinematics are bounded', () => {
  it('never changes speed faster than the acceleration allows', () => {
    const dt = 1 / 60;
    let speed = 0;
    let frames = 0;
    // Ask for the run speed from a standing start, then for a dead stop.
    for (let i = 0; i < 200; i += 1) {
      const want = i < 100 ? OFFICER_RUN_SPEED : 0;
      const next = approachSpeed(speed, want, OFFICER_ACCEL, OFFICER_BRAKE, dt);
      const limit = (next > speed ? OFFICER_ACCEL : OFFICER_BRAKE) * dt;
      expect(Math.abs(next - speed)).toBeLessThanOrEqual(limit + 1e-12);
      expect(next).toBeLessThanOrEqual(OFFICER_RUN_SPEED + 1e-12);
      speed = next;
      frames += 1;
    }
    expect(frames).toBe(200);
    // Reached full speed on the way up and a dead stop on the way down: the
    // bound is a rate limit, not a ceiling that stops it arriving.
    expect(speed).toBe(0);
  });

  it('reaches the run speed in a human time and stops faster than it starts', () => {
    const dt = 1 / 240;
    const timeTo = (from: number, to: number): number => {
      let speed = from;
      let t = 0;
      for (let i = 0; i < 10000 && Math.abs(speed - to) > 1e-3; i += 1) {
        speed = approachSpeed(speed, to, OFFICER_ACCEL, OFFICER_BRAKE, dt);
        t += dt;
      }
      return t;
    };
    const start = timeTo(0, OFFICER_RUN_SPEED);
    const stop = timeTo(OFFICER_RUN_SPEED, 0);
    expect(start).toBeGreaterThan(0.8);
    expect(start).toBeLessThan(1.6);
    expect(stop).toBeLessThan(start);
  });

  it('never turns faster than the turn rate, and takes the short way round', () => {
    const dt = 1 / 60;
    let heading = 0;
    // A target on the far side of the wrap, which a naive lerp would chase the
    // long way around.
    const target = -3.0;
    let turned = 0;
    for (let i = 0; i < 200; i += 1) {
      const next = turnToward(heading, target, OFFICER_TURN_RATE, dt);
      const step = Math.abs(shortestTurn(heading, next));
      expect(step).toBeLessThanOrEqual(OFFICER_TURN_RATE * dt + 1e-12);
      turned += shortestTurn(heading, next);
      heading = next;
    }
    expect(Math.abs(shortestTurn(heading, target))).toBeLessThan(1e-6);
    // Went the SHORT way: 3.00 rad clockwise rather than 3.28 the other way.
    // A naive lerp toward the raw number would have taken the long one.
    expect(turned).toBeCloseTo(target, 6);
    expect(Math.abs(turned)).toBeLessThan(Math.PI * 2 - Math.abs(target));
  });

  it('asks for no speed above the run speed, in any state', () => {
    const states: OfficerBehaviour[] = [
      'idle', 'notice', 'draw', 'pursue', 'close', 'hold',
      'aim', 'fire', 'reload', 'reposition', 'hit',
    ];
    const speeds = { walk: OFFICER_WALK_SPEED, run: OFFICER_RUN_SPEED };
    for (const state of states) {
      for (const distance of [0, 1, 5, 12, 40, 200]) {
        for (const running of [false, true]) {
          const want = desiredSpeed(state, distance, FIRING_STANDOFF, running, speeds);
          expect(want).toBeGreaterThanOrEqual(0);
          expect(want).toBeLessThanOrEqual(OFFICER_RUN_SPEED);
          // Only a state that is meant to be travelling asks for anything.
          if (!isTravelling(state)) expect(want).toBe(0);
        }
      }
    }
  });

  it('runs only when the chase needs it, with hysteresis on the boundary', () => {
    // Far away: a run. At the standoff: a walk. Neither depends on last frame.
    expect(shouldRun(40, 0, false, OFFICER_RUN_RANGE, OFFICER_RUN_HYSTERESIS, OFFICER_WALK_SPEED))
      .toBe(true);
    expect(shouldRun(3, 0, true, OFFICER_RUN_RANGE, OFFICER_RUN_HYSTERESIS, OFFICER_WALK_SPEED))
      .toBe(false);

    // Inside the band the answer is whatever it already was, which is the
    // whole point: an officer at the threshold does not alternate gaits.
    const inBand = OFFICER_RUN_RANGE - OFFICER_RUN_HYSTERESIS * 0.5;
    expect(shouldRun(inBand, 0, true, OFFICER_RUN_RANGE, OFFICER_RUN_HYSTERESIS, OFFICER_WALK_SPEED))
      .toBe(true);
    expect(shouldRun(inBand, 0, false, OFFICER_RUN_RANGE, OFFICER_RUN_HYSTERESIS, OFFICER_WALK_SPEED))
      .toBe(false);

    // A suspect actually running away is chased at a run whatever the range.
    expect(shouldRun(6, 6, false, OFFICER_RUN_RANGE, OFFICER_RUN_HYSTERESIS, OFFICER_WALK_SPEED))
      .toBe(true);
  });

  it('does not flicker the locomotion clip across a boundary', () => {
    // Sweep the speed slowly down through both band edges and count how many
    // times the answer changes. Three states means at most two changes.
    let stance = stanceFor(OFFICER_RUN_SPEED, 'idle', OFFICER_RUN_SPEED);
    expect(stance).toBe('run');
    let changes = 0;
    for (let i = 0; i <= 2000; i += 1) {
      const speed = OFFICER_RUN_SPEED * (1 - i / 2000);
      const next = stanceFor(speed, stance, OFFICER_RUN_SPEED);
      if (next !== stance) changes += 1;
      stance = next;
    }
    expect(stance).toBe('idle');
    expect(changes).toBe(2);

    // And the band really is a band: the same speed gives a different answer
    // depending on which side it was approached from.
    const between = OFFICER_RUN_SPEED * 0.55;
    expect(stanceFor(between, 'run', OFFICER_RUN_SPEED)).toBe('run');
    expect(stanceFor(between, 'walk', OFFICER_RUN_SPEED)).toBe('walk');
  });
});

describe('officer obstacle steering', () => {
  it('keeps the direct line when it is clear', () => {
    const result = steerAround(0, -1, 1, () => true);
    expect(result).toEqual({ x: 0, z: -1, turn: 0, blocked: false, deflected: false });
  });

  it('takes the nearest clear angle, and reports the angle it took', () => {
    // A wall dead ahead: anything pointing more than 0.3 rad off -Z is clear.
    const clear = (x: number, z: number): boolean =>
      Math.abs(Math.atan2(x, -z)) > 0.3;
    const result = steerAround(0, -1, 1, clear);
    expect(result.blocked).toBe(false);
    expect(result.deflected).toBe(true);
    expect(Math.abs(result.turn)).toBeGreaterThan(0.3);
    // The smallest whisker that clears it, not the widest available one.
    expect(Math.abs(result.turn)).toBeLessThan(0.6);
    // The reported angle reproduces the reported direction, which is what
    // lets a caller hold the DEFLECTION and re-apply it to a line that has
    // rotated since.
    expect(result.x).toBeCloseTo(rotateX(0, -1, result.turn), 12);
    expect(result.z).toBeCloseTo(rotateZ(0, -1, result.turn), 12);
  });

  it('prefers the biased side, so an officer commits to one way round', () => {
    const clear = (x: number, z: number): boolean => Math.abs(Math.atan2(x, -z)) > 0.3;
    const left = steerAround(0, -1, -1, clear);
    const right = steerAround(0, -1, 1, clear);
    expect(Math.sign(left.turn)).toBe(-Math.sign(right.turn));
    expect(Math.abs(left.turn)).toBeCloseTo(Math.abs(right.turn), 9);
  });

  it('says so when nothing is clear rather than inventing a way through', () => {
    const result = steerAround(0, -1, 1, () => false);
    expect(result.blocked).toBe(true);
    expect(result.turn).toBe(0);
  });
});

// -- the behaviour table ------------------------------------------------------

const TUNING: OfficerTuning = {
  notice: OFFICER_NOTICE_TIME,
  draw: OFFICER_DRAW_TIME,
  reload: OFFICER_RELOAD_TIME,
  recover: OFFICER_HIT_RECOVER,
  reposition: OFFICER_REPOSITION_TIME,
  losePatience: OFFICER_LOSE_PATIENCE,
  closeMargin: CLOSE_MARGIN,
};

function sense(over: Partial<OfficerSense> = {}): OfficerSense {
  return {
    state: 'idle',
    elapsed: 0,
    distance: 30,
    standoff: FIRING_STANDOFF,
    seesPlayer: true,
    unseen: 0,
    armedIntent: true,
    armed: false,
    settled: false,
    aimTime: 1.1,
    rounds: OFFICER_MAGAZINE,
    shotReady: true,
    onTarget: true,
    canShoot: false,
    hurt: false,
    blocked: false,
    ...over,
  };
}

describe('officer behaviour transitions', () => {
  it('goes idle, notice, draw, pursue when it acquires an armed suspect', () => {
    expect(nextBehaviour(sense({ state: 'idle', seesPlayer: false }), TUNING)).toBe('idle');
    expect(nextBehaviour(sense({ state: 'idle' }), TUNING)).toBe('notice');
    // Registering takes a moment; it is not instant.
    expect(nextBehaviour(sense({ state: 'notice', elapsed: 0.1 }), TUNING)).toBe('notice');
    expect(nextBehaviour(sense({ state: 'notice', elapsed: OFFICER_NOTICE_TIME }), TUNING))
      .toBe('draw');
    expect(nextBehaviour(sense({ state: 'draw', elapsed: 0.1 }), TUNING)).toBe('draw');
    expect(nextBehaviour(sense({ state: 'draw', elapsed: OFFICER_DRAW_TIME }), TUNING))
      .toBe('pursue');
  });

  it('skips the draw when the officer means to make an arrest', () => {
    const s = sense({ state: 'notice', elapsed: OFFICER_NOTICE_TIME, armedIntent: false });
    expect(nextBehaviour(s, TUNING)).toBe('pursue');
  });

  it('draws mid-chase when an arrest turns into a gunfight', () => {
    // THE GAP THIS PINS. The draw used to be reachable only out of `notice`,
    // so an officer who set out to cuff a one-star suspect and was then shot
    // at spent the rest of the chase closing on an armed player with empty
    // hands - and, having never drawn, could never fire back.
    for (const state of ['pursue', 'close', 'hold'] as OfficerBehaviour[]) {
      const s = sense({ state, distance: 5, armedIntent: true, armed: false });
      expect(nextBehaviour(s, TUNING)).toBe('draw');
    }
    // Already holding it: the draw does not repeat.
    expect(nextBehaviour(sense({ state: 'pursue', armed: true }), TUNING)).toBe('pursue');
  });

  it('drops to a walk before the standoff and stops on it', () => {
    // Weapon already out, so the draw rule does not shadow the range rules.
    const armed = { armed: true };
    const far = sense({ state: 'pursue', distance: 40, ...armed });
    expect(nextBehaviour(far, TUNING)).toBe('pursue');
    const near = sense({
      state: 'pursue', distance: FIRING_STANDOFF + CLOSE_MARGIN - 0.5, ...armed,
    });
    expect(nextBehaviour(near, TUNING)).toBe('close');
    const on = sense({ state: 'close', distance: FIRING_STANDOFF - 0.1, ...armed });
    expect(nextBehaviour(on, TUNING)).toBe('hold');
    // Hysteresis coming back out: being a shade outside the close band is not
    // enough to break back into a run.
    const drifting = sense({
      state: 'close', distance: FIRING_STANDOFF + CLOSE_MARGIN + 0.5, ...armed,
    });
    expect(nextBehaviour(drifting, TUNING)).toBe('close');
  });

  it('runs draw, aim, fire, aim, reload, hold in that order', () => {
    const armed = { armed: true, canShoot: true, settled: true };
    expect(nextBehaviour(sense({ state: 'hold', distance: 6, ...armed }), TUNING)).toBe('aim');
    // The aim time has to elapse before the first round.
    expect(nextBehaviour(sense({ state: 'aim', distance: 6, elapsed: 0.2, ...armed }), TUNING))
      .toBe('aim');
    expect(nextBehaviour(sense({ state: 'aim', distance: 6, elapsed: 1.2, ...armed }), TUNING))
      .toBe('fire');
    // ... and a raised weapon is a precondition, not a decoration.
    const unsettled = sense({ state: 'aim', distance: 6, elapsed: 1.2, ...armed, settled: false });
    expect(nextBehaviour(unsettled, TUNING)).toBe('aim');

    // One state per round: `fire` is a moment, then back to the sights.
    expect(nextBehaviour(sense({ state: 'fire', distance: 6, elapsed: 0.2, ...armed }), TUNING))
      .toBe('aim');
    // An empty magazine is a reload from either side of the shot.
    expect(nextBehaviour(sense({ state: 'fire', elapsed: 0.2, rounds: 0, ...armed }), TUNING))
      .toBe('reload');
    expect(nextBehaviour(sense({ state: 'aim', rounds: 0, ...armed }), TUNING)).toBe('reload');
    expect(nextBehaviour(sense({ state: 'reload', elapsed: 0.5 }), TUNING)).toBe('reload');
    expect(nextBehaviour(sense({ state: 'reload', elapsed: OFFICER_RELOAD_TIME }), TUNING))
      .toBe('hold');
  });

  it('follows a suspect who walks away instead of shooting from further off', () => {
    const armed = { armed: true, canShoot: true, settled: true };
    const opening = sense({ state: 'aim', distance: FIRING_STANDOFF * 2, elapsed: 3, ...armed });
    expect(nextBehaviour(opening, TUNING)).toBe('close');
  });

  it('holds fire the moment the shot is not clear', () => {
    const s = sense({ state: 'aim', distance: 6, elapsed: 3, armed: true, settled: true, canShoot: false });
    expect(nextBehaviour(s, TUNING)).toBe('hold');
  });

  it('will not fire while facing the wrong way', () => {
    const s = sense({
      state: 'aim', distance: 6, elapsed: 3,
      armed: true, canShoot: true, settled: true, onTarget: false,
    });
    expect(nextBehaviour(s, TUNING)).toBe('aim');
  });

  it('is staggered by a round from any state, then picks up where it left off', () => {
    for (const state of ['pursue', 'aim', 'reload', 'hold'] as OfficerBehaviour[]) {
      expect(nextBehaviour(sense({ state, hurt: true }), TUNING)).toBe('hit');
    }
    expect(nextBehaviour(sense({ state: 'hit', elapsed: 0.1 }), TUNING)).toBe('hit');
    expect(nextBehaviour(sense({ state: 'hit', elapsed: OFFICER_HIT_RECOVER }), TUNING))
      .toBe('notice');
    expect(
      nextBehaviour(sense({ state: 'hit', elapsed: OFFICER_HIT_RECOVER, seesPlayer: false }), TUNING),
    ).toBe('idle');
  });

  it('repositions instead of pressing into something, and gives up on it in time', () => {
    expect(nextBehaviour(sense({ state: 'pursue', armed: true, blocked: true }), TUNING))
      .toBe('reposition');
    expect(nextBehaviour(sense({ state: 'reposition', blocked: true, elapsed: 0.2 }), TUNING))
      .toBe('reposition');
    // Clear again, or out of patience: back to the chase either way.
    expect(nextBehaviour(sense({ state: 'reposition', blocked: false, elapsed: 0.2 }), TUNING))
      .toBe('pursue');
    const bored = sense({ state: 'reposition', blocked: true, elapsed: OFFICER_REPOSITION_TIME });
    expect(nextBehaviour(bored, TUNING)).toBe('pursue');
  });

  it('stands easy once the suspect has been out of sight long enough', () => {
    const lost = { seesPlayer: false, unseen: OFFICER_LOSE_PATIENCE + 0.1 };
    for (const state of ['pursue', 'close', 'hold', 'reposition'] as OfficerBehaviour[]) {
      expect(nextBehaviour(sense({ state, armed: true, ...lost }), TUNING)).toBe('idle');
    }
  });
});

// -- the real system ----------------------------------------------------------

describe('officers on foot move like people', () => {
  it('never exceeds the run speed and never jumps position', () => {
    const harness = makeHarness();
    const spot = onTheRoad();
    const dt = 1 / 60;
    let fastest = 0;
    let steps = 0;
    eachStep(
      harness,
      150,
      dt,
      (t) => {
        // Stand still while the response arrives, then jog away so the
        // officers have to commit to a run to keep up.
        const away = t > 70 ? Math.min(50, (t - 70) * 3) : 0;
        return { x: spot.x + away, z: spot.z, speed: away > 0 ? 3 : 0 };
      },
      (before, after) => {
        const step = Math.hypot(after.x - before.x, after.z - before.z);
        // THE NO-TELEPORT BOUND. One frame's displacement can never be more
        // than the run speed allows, so no code path can place a body.
        expect(step).toBeLessThanOrEqual(OFFICER_RUN_SPEED * dt + 1e-9);
        fastest = Math.max(fastest, step / dt);
        steps += 1;
      },
    );
    expect(steps).toBeGreaterThan(20000);
    // The bound is real rather than vacuous: somebody actually ran.
    expect(fastest).toBeGreaterThan(OFFICER_RUN_SPEED * 0.95);
    expect(fastest).toBeLessThanOrEqual(OFFICER_RUN_SPEED + 1e-9);
    harness.police.dispose();
  });

  it('accelerates and turns within the bounds, frame by frame', () => {
    const harness = makeHarness();
    const spot = onTheRoad();
    const dt = 1 / 60;
    const limit = Math.max(OFFICER_ACCEL, OFFICER_BRAKE);
    let peakAccel = 0;
    let peakTurn = 0;
    const last = new Map<number, number>();
    eachStep(
      harness,
      150,
      dt,
      (t) => {
        // Whip the player around the cordon: a snapped heading shows up here
        // as an unbounded turn rate. On the old code this measured 7.1 rad/s.
        const away = t > 70 ? Math.min(50, (t - 70) * 3) : 0;
        return {
          x: spot.x + away + Math.cos(t * 3) * 2,
          z: spot.z + Math.sin(t * 3) * 2,
          speed: away > 0 ? 3 : 0,
        };
      },
      (before, after) => {
        const speed = Math.hypot(after.x - before.x, after.z - before.z) / dt;
        const previous = last.get(after.id);
        last.set(after.id, speed);
        if (previous !== undefined) {
          const rate = Math.abs(speed - previous) / dt;
          expect(rate).toBeLessThanOrEqual(limit + 1e-6);
          peakAccel = Math.max(peakAccel, rate);
        }
        const turn = Math.abs(shortestTurn(before.heading, after.heading)) / dt;
        expect(turn).toBeLessThanOrEqual(OFFICER_TURN_RATE + 1e-6);
        peakTurn = Math.max(peakTurn, turn);
      },
    );
    // Both bounds are actually reached, so neither assertion is vacuous.
    expect(peakAccel).toBeGreaterThan(limit * 0.5);
    expect(peakTurn).toBeGreaterThan(OFFICER_TURN_RATE * 0.5);
    harness.police.dispose();
  });

  it('advances the stride by exactly the ground it covered', () => {
    const harness = makeHarness();
    const spot = onTheRoad();
    const dt = 1 / 60;
    let moving = 0;
    let still = 0;
    eachStep(
      harness,
      150,
      dt,
      (t) => {
        const away = t > 70 ? Math.min(50, (t - 70) * 3) : 0;
        return { x: spot.x + away, z: spot.z, speed: away > 0 ? 3 : 0 };
      },
      (before, after) => {
        const step = Math.hypot(after.x - before.x, after.z - before.z);
        // THE NO-SLIDE CONDITION. The clip is driven by `walked`, and `walked`
        // may only grow by the distance the body really covered, converted out
        // of metres by girth. If the body outruns the clip the feet slide; if
        // the clip outruns the body they skate.
        const stride = (after.walked - before.walked) * after.girth;
        expect(Math.abs(stride)).toBeLessThanOrEqual(step + 1e-9);
        if (step > 0.01) {
          // Moving: the officer travels along the way they face, so nearly all
          // of the displacement is explained by the stride. A small shortfall
          // is the turn taken during the frame and nothing else.
          expect(stride).toBeGreaterThan(step * 0.97);
          moving += 1;
        } else if (step === 0) {
          // Dead still: the clip does not creep. This is the other half of the
          // no-slide property - feet that move while the body does not.
          expect(stride).toBe(0);
          still += 1;
        }
      },
    );
    expect(moving).toBeGreaterThan(3000);
    expect(still).toBeGreaterThan(1000);
    harness.police.dispose();
  });

  it('walks the last few metres in rather than running into the player', () => {
    const harness = makeHarness();
    const spot = onTheRoad();
    const dt = 1 / 60;
    let closeAndFast = 0;
    let closeSamples = 0;
    eachStep(
      harness,
      150,
      dt,
      () => ({ x: spot.x, z: spot.z }),
      (before, after) => {
        const distance = Math.hypot(after.x - spot.x, after.z - spot.z);
        if (distance > FIRING_STANDOFF + CLOSE_MARGIN) return;
        closeSamples += 1;
        const speed = Math.hypot(after.x - before.x, after.z - before.z) / dt;
        // Inside the standoff band nobody is still running.
        if (speed > OFFICER_WALK_SPEED * 1.25) closeAndFast += 1;
      },
    );
    expect(closeSamples).toBeGreaterThan(1000);
    expect(closeAndFast).toBe(0);
    harness.police.dispose();
  });

  it('gets to a standoff and stops there rather than standing on the player', () => {
    const harness = makeHarness();
    const spot = onTheRoad();
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 120; i += 1) {
      pinStars(harness.player, 3);
      harness.player.heal(100);
      harness.police.update(dt, context(spot.x, spot.z, { time: i * dt }));
    }
    const poses = harness.police.officerPoses;
    expect(poses.length).toBeGreaterThan(0);
    for (const pose of poses) {
      const distance = Math.hypot(pose.x - spot.x, pose.z - spot.z);
      // Held off, weapon out, not pressed against the suspect.
      expect(distance).toBeGreaterThan(ARREST_STANDOFF);
      expect(distance).toBeLessThan(FIRING_STANDOFF + CLOSE_MARGIN * 2);
    }
    harness.police.dispose();
  });
});

// -- weapon handling ----------------------------------------------------------

describe('officers handle a weapon before they fire one', () => {
  it('draws before the first round and is holding it when it leaves', () => {
    const harness = makeHarness();
    const spot = onTheRoad();
    const dt = 1 / 60;
    let sawDraw = false;
    let firstShotAt = -1;
    let drawAt = -1;
    let armedAtEveryShot = true;
    for (let i = 0; i < 60 * 120; i += 1) {
      pinStars(harness.player, 4);
      harness.player.heal(100);
      harness.police.update(dt, context(spot.x, spot.z, { time: i * dt }));
      for (const pose of harness.police.officerPoses) {
        if (pose.behaviour === 'draw' && drawAt < 0) {
          drawAt = i;
          sawDraw = true;
        }
        if (pose.behaviour === 'fire') {
          if (firstShotAt < 0) firstShotAt = i;
          if (!pose.armed) armedAtEveryShot = false;
        }
      }
    }
    expect(sawDraw).toBe(true);
    expect(firstShotAt).toBeGreaterThan(0);
    // The weapon comes out BEFORE it is used, and stays out.
    expect(drawAt).toBeLessThan(firstShotAt);
    expect(armedAtEveryShot).toBe(true);
    expect(harness.shots.length).toBeGreaterThan(0);
    harness.police.dispose();
  });

  it('reloads when the magazine runs out instead of firing for ever', () => {
    const harness = makeHarness();
    const spot = onTheRoad();
    const dt = 1 / 60;
    let sawReload = false;
    let lowest = OFFICER_MAGAZINE;
    for (let i = 0; i < 60 * 150; i += 1) {
      pinStars(harness.player, 5);
      harness.player.heal(100);
      harness.police.update(dt, context(spot.x, spot.z, { time: i * dt }));
      for (const pose of harness.police.officerPoses) {
        if (pose.behaviour === 'reload') sawReload = true;
        lowest = Math.min(lowest, pose.rounds);
      }
    }
    expect(sawReload).toBe(true);
    expect(lowest).toBe(0);
    // ... and the magazine really is refilled, or the second one never comes.
    const rounds = harness.police.officerPoses.map((p) => p.rounds);
    expect(Math.max(...rounds, 0)).toBeGreaterThan(0);
    harness.police.dispose();
  });

  it('fires from the weapon muzzle, not from the middle of the officer', () => {
    const harness = makeHarness();
    const spot = onTheRoad();
    const dt = 1 / 60;
    const muzzle: MuzzleTransform = { x: 0, y: 0, z: 0, dirX: 0, dirZ: -1 };
    let checked = 0;
    for (let i = 0; i < 60 * 120; i += 1) {
      pinStars(harness.player, 4);
      harness.player.heal(100);
      const before = harness.shots.length;
      harness.police.update(dt, context(spot.x, spot.z, { time: i * dt }));
      if (harness.shots.length === before) continue;
      const shot = harness.shots[harness.shots.length - 1];
      if (!shot) continue;
      // THE SHOT AND THE DRAWN WEAPON ARE THE SAME TRANSFORM. Some officer's
      // muzzle - the one the rig would put a weapon model at this frame - is
      // the reported origin, to the millimetre. More than one officer can be
      // mid-shot, so the shooter is identified by that match rather than
      // assumed.
      const shooter = harness.police.officerPoses.find((candidate) => {
        if (!harness.police.muzzleOf(candidate.id, muzzle)) return false;
        return Math.hypot(shot.x - muzzle.x, shot.y - muzzle.y, shot.z - muzzle.z) < 1e-6;
      });
      expect(shooter).toBeDefined();
      if (!shooter) continue;
      expect(harness.police.muzzleOf(shooter.id, muzzle)).toBe(true);
      expect(shooter.armed).toBe(true);

      // And it is NOT the body centre, which is where it used to come from.
      const offCentre = Math.hypot(shot.x - shooter.x, shot.z - shooter.z);
      expect(offCentre).toBeGreaterThan(0.2);
      // In front of the officer, along the way they are facing.
      const forwardX = -Math.sin(shooter.heading);
      const forwardZ = -Math.cos(shooter.heading);
      const ahead = (shot.x - shooter.x) * forwardX + (shot.z - shooter.z) * forwardZ;
      expect(ahead).toBeGreaterThan(0.2);
      // At the hand, not at the eye: the old origin was 1.38 m up.
      expect(shot.y).toBeGreaterThan(0.6);
      expect(shot.y).toBeLessThan(1.1);
      // Pointing where the officer is pointing.
      expect(muzzle.dirX).toBeCloseTo(forwardX, 9);
      expect(muzzle.dirZ).toBeCloseTo(forwardZ, 9);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(5);
    harness.police.dispose();
  });

  it('holds fire when a wall is between the weapon and the suspect', () => {
    // A wall taller than anybody, right across the street the officers arrive
    // on. They can neither see nor shoot through it.
    const spot = onTheRoad();
    const wall: ColliderBox = {
      minX: spot.x - 60, maxX: spot.x + 60,
      minZ: spot.z - 3.2, maxZ: spot.z - 2,
      bottom: 0, top: 6, solid: true,
    };
    const open = makeHarness();
    const walled = makeHarness({ occluders: [wall] });
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 100; i += 1) {
      for (const harness of [open, walled]) {
        pinStars(harness.player, 5);
        harness.player.heal(100);
        // The player stands on the far side of the wall from the road.
        harness.police.update(dt, context(spot.x, spot.z - 8, { time: i * dt }));
      }
    }
    // The control fires; the walled one does not fire a single round.
    expect(open.shots.length).toBeGreaterThan(0);
    expect(walled.shots.length).toBe(0);
    open.police.dispose();
    walled.police.dispose();
  });
});

// -- the world ----------------------------------------------------------------

describe('officers respect the world they walk in', () => {
  it('never ends a frame inside a solid box, and gets round it', () => {
    // A block between where the cars park and where the player is standing.
    const spot = onTheRoad();
    const block: ColliderBox = {
      minX: spot.x - 5, maxX: spot.x + 5,
      minZ: spot.z + 2.5, maxZ: spot.z + 9,
      bottom: 0, top: 8, solid: true,
    };
    const collision = new CollisionWorld([block]);
    const harness = makeHarness({ colliders: [block] });
    const dt = 1 / 60;
    let inside = 0;
    let samples = 0;
    let closest = Infinity;
    for (let i = 0; i < 60 * 140; i += 1) {
      pinStars(harness.player, 3);
      harness.player.heal(100);
      harness.police.update(dt, context(spot.x, spot.z, { time: i * dt }));
      for (const pose of harness.police.officerPoses) {
        samples += 1;
        // The collision world's own verdict on the body it just moved.
        if (collision.isStuck(pose.x, pose.z, pose.y, 1.8, 0.34)) inside += 1;
        closest = Math.min(closest, Math.hypot(pose.x - spot.x, pose.z - spot.z));
      }
    }
    expect(samples).toBeGreaterThan(10000);
    expect(inside).toBe(0);
    // Not merely kept out - they got past it and reached a firing position.
    expect(closest).toBeLessThan(FIRING_STANDOFF + 1);
    harness.police.dispose();
  });

  it('stands on a kerb rather than sinking through it', () => {
    // A low platform the officers have to walk over on their way in.
    const spot = onTheRoad();
    const kerb: ColliderBox = {
      minX: spot.x - 12, maxX: spot.x + 12,
      minZ: spot.z - 12, maxZ: spot.z + 12,
      bottom: 0, top: 0.15, solid: false,
    };
    const harness = makeHarness({ colliders: [kerb] });
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 120; i += 1) {
      pinStars(harness.player, 3);
      harness.player.heal(100);
      harness.police.update(dt, context(spot.x, spot.z, { time: i * dt }));
    }
    const poses = harness.police.officerPoses;
    expect(poses.length).toBeGreaterThan(0);
    for (const pose of poses) {
      expect(pose.y).toBeCloseTo(0.15, 6);
    }
    harness.police.dispose();
  });
});

// -- the rig ------------------------------------------------------------------

describe('the walk cycle is driven by the ground, not by a clock', () => {
  function pose(over: Partial<OfficerPose> = {}): OfficerPose {
    return {
      x: 0, y: 0, z: 0, heading: 0, speed: 0, height: 1.8, girth: 1,
      phase: 0, gait: 0, stance: 'idle', variant: 1, walked: 0,
      lastX: 0, lastZ: 0, aiming: 0, armed: false,
      down: false, downFor: 0, fallSign: 1,
      ...over,
    };
  }

  it('advances the stride by the displacement, scaled out of metres by girth', () => {
    for (const girth of [0.85, 1, 1.2]) {
      const p = pose({ girth });
      // Heading 0 faces -Z, so a step of -0.4 m in z is 0.4 m forward.
      p.z = -0.4;
      OfficerRig.advance(p, 1 / 60);
      expect(p.walked).toBeCloseTo(0.4 / girth, 9);
    }
  });

  it('does not advance the stride for a body that did not move', () => {
    const p = pose({ speed: 0 });
    for (let i = 0; i < 100; i += 1) OfficerRig.advance(p, 1 / 60);
    expect(p.walked).toBe(0);
    expect(p.gait).toBeLessThan(0.01);
    expect(p.stance).toBe('idle');
  });

  it('ignores a teleport, so getting out of a car is not a stride', () => {
    const p = pose();
    p.z = -40;
    OfficerRig.advance(p, 1 / 60);
    expect(p.walked).toBe(0);
    // ... and the accumulator is re-based, so the next real step counts.
    p.z = -40.5;
    OfficerRig.advance(p, 1 / 60);
    expect(p.walked).toBeCloseTo(0.5, 9);
  });

  it('takes only the forward part of a sideways shove', () => {
    const p = pose();
    // Pushed straight sideways while facing -Z: no stride at all.
    p.x = 0.3;
    OfficerRig.advance(p, 1 / 60);
    expect(p.walked).toBeCloseTo(0, 9);
  });

  it('picks the clip from the measured speed, with a band at each edge', () => {
    const p = pose({ speed: OFFICER_RUN_SPEED });
    OfficerRig.advance(p, 1 / 60);
    expect(p.stance).toBe('run');
    p.speed = OFFICER_WALK_SPEED;
    OfficerRig.advance(p, 1 / 60);
    expect(p.stance).toBe('walk');
    p.speed = 0;
    OfficerRig.advance(p, 1 / 60);
    expect(p.stance).toBe('idle');
  });
});

describe('the sidearm is where the hand is', () => {
  it('puts a weapon in the hand of an armed officer and nobody else', () => {
    const rig = new OfficerRig(8, false, false);
    const muzzle: MuzzleTransform = { x: 0, y: 0, z: 0, dirX: 0, dirZ: -1 };
    const officer: OfficerPose = {
      x: 4, y: 1, z: -7, heading: Math.PI / 3, speed: 0, height: 1.8, girth: 1.05,
      phase: 0, gait: 0, stance: 'idle', variant: 3, walked: 0, lastX: 4, lastZ: -7,
      aiming: 1, armed: true, down: false, downFor: 0, fallSign: 1,
    };
    rig.muzzleOf(officer, 0, muzzle);

    // In front of the body, at hand height, pointing where the officer faces.
    const forwardX = -Math.sin(officer.heading);
    const forwardZ = -Math.cos(officer.heading);
    expect(muzzle.dirX).toBeCloseTo(forwardX, 9);
    expect(muzzle.dirZ).toBeCloseTo(forwardZ, 9);
    const ahead = (muzzle.x - officer.x) * forwardX + (muzzle.z - officer.z) * forwardZ;
    expect(ahead).toBeGreaterThan(0.25);
    // Hand height scales with the officer, so a taller officer's weapon is
    // higher: the transform is the body's own, not a fixed offset.
    expect(muzzle.y - officer.y).toBeCloseTo(0.467 * officer.height, 6);
    const taller = { ...officer, height: 2 };
    rig.muzzleOf(taller, 0, muzzle);
    expect(muzzle.y - taller.y).toBeCloseTo(0.467 * 2, 6);

    rig.dispose();
  });

  it('agrees with the heading convention the rest of the police use', () => {
    const rig = new OfficerRig(4, false, false);
    const muzzle: MuzzleTransform = { x: 0, y: 0, z: 0, dirX: 0, dirZ: -1 };
    const facing: OfficerPose = {
      x: 0, y: 0, z: 0, heading: headingOf(0, -10), speed: 0, height: 1.8, girth: 1,
      phase: 0, gait: 0, stance: 'idle', variant: 1, walked: 0, lastX: 0, lastZ: 0,
      aiming: 1, armed: true, down: false, downFor: 0, fallSign: 1,
    };
    rig.muzzleOf(facing, 0, muzzle);
    // Aimed at a point 10 m along -Z, so the barrel points along -Z.
    expect(muzzle.dirX).toBeCloseTo(0, 9);
    expect(muzzle.dirZ).toBeCloseTo(-1, 9);
    expect(muzzle.z).toBeLessThan(0);
    rig.dispose();
  });
});
