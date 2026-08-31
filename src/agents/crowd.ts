/**
 * The pedestrian simulation.
 *
 * Deliberately free of Three.js: everything here is numbers, so the whole crowd
 * can be stepped and asserted on in a unit test with no renderer, exactly like
 * `CityPlan` and `RoadNetwork`. `PedestrianSystem` is the only module that
 * turns this state into geometry.
 *
 * The model, in the order it runs each frame:
 *
 *   1. Route.  Every pedestrian is on a `PavementLink` with a distance along it
 *      and a signed lateral offset. Movement is free-form, but the position is
 *      projected back onto the link every step and the lateral offset is hard
 *      clamped to the pavement's half width. That clamp is the guarantee that
 *      nobody walks into a wall, onto a carriageway, or off a kerb: it is a
 *      constraint, not a force, so no amount of crowding can defeat it.
 *   2. Intent. Approaching the end of a link a pedestrian picks the next one,
 *      preferring to carry straight on. A crossing is only committed to once
 *      `walkSignal` says the traffic it crosses is stopped AND no vehicle is
 *      about to arrive; until then they wait a short way back from the kerb.
 *   3. Avoid.  Near the player: separation, a predicted-contact dodge, and
 *      speed matching behind whoever is in front. Speed control is what stops
 *      the jitter that pure repulsion produces in a queue.
 *   4. Integrate, project, then resolve remaining overlaps positionally so two
 *      people can never occupy the same place.
 *
 * GETTING SOMEWHERE. Two of those steps carry an invariant the rest of the
 * model depends on, and both were learned the hard way from people standing in
 * the road for minutes at a time:
 *
 *   - the steering target must be genuinely AHEAD along the current link, and
 *     never closer than a step. A target on top of a walker is chased at full
 *     speed, overshot, and then chased backwards; `along` stops advancing and
 *     nothing ever hands them to the next link. See `step`.
 *   - a route street furniture has closed is not offered at all, and a walker
 *     pressed against a prop looks for the gap rather than sliding into the
 *     kerb. See `ObstacleIndex.blocksCorridor` and `clearLateralAhead`.
 *   - EVERY REASON TO STAND STILL IS BOUNDED. A pause is at most 6.5 s and a
 *     wait at most one signal cycle, after which the crossing is abandoned and
 *     not offered again for a while. `watchStall` cannot help here: it does
 *     not police a `wait`, on the correct grounds that waiting is a decision
 *     rather than a failure, which made `wait` the one state that could last
 *     for ever. Measured with live traffic before this, 202 of 270 people
 *     spent more than a minute at a kerb and one stood still for ten minutes.
 *   - A VEHICLE IS THE ONLY THING THAT MAY STOP SOMEBODY DEAD, and only when
 *     it is bearing down on them. Everything else - a neighbour, a prop, a
 *     parked car - is a brake with a shuffling floor under it. See `step`.
 *
 * `watchStall` sits under the first two as a bounded ladder of last resorts,
 * and its final rung is a step along the link, which always works.
 *
 * A test that runs the crowd WITHOUT `ctx.vehicles` exercises none of this.
 * The shipped game passes 240 of them and the crossing gate is a function of
 * that list; the whole of it was unexercised until `tests/crowdCorners.test.ts`
 * put a live `TrafficSim` next to a live crowd. See
 * `docs/crowd-corners-and-knockdowns.md`.
 *
 * SIMULATION LOD. Full steering runs inside `LOD_NEAR`. Between there and
 * `LOD_MID` the predicted-contact dodge and the obstacle push are dropped and
 * the agent is stepped every other frame with a doubled timestep. Beyond that
 * it is pure path following stepped every fourth frame. Past `RENDER_RADIUS`
 * nothing is drawn, and past `RECYCLE_RADIUS` the agent is returned to the pool
 * and respawned where the player is heading. The walk cycle phase advances
 * every frame at every level, which costs one add and keeps distant figures
 * from stuttering. A body on the ground is stepped every frame at every level,
 * because a topple at a quarter rate reads as a stutter at the one moment the
 * eye is certainly on them, and it costs three adds.
 */

import { clamp, damp, TAU } from '../core/mathx';
import { createRng, type Rng } from '../core/rng';
import { SIGNAL_CYCLE, walkSignal, type RoadNetwork } from '../city/RoadNetwork';
import type { CityGround } from '../world/CityGround';
import { makeLook, type PedestrianLook } from './appearance';
import { gaitCadence } from './gait';
import type { ObstacleIndex } from './obstacles';
import { linkPoint, type PavementGraph, type PavementLink } from './pavement';
// Imported by module path rather than through `./travellers`, whose barrel
// pulls in Three.js: this file must stay renderer-free so the whole crowd can
// be stepped in a unit test. `zones.ts` imports nothing but the airport survey.
import {
  PEDESTRIAN_ZONES,
  zoneAlong,
  zoneAt,
  zoneIndexAt,
  zoneRule,
  type PedestrianZone,
} from './travellers/zones';

/** Half a shoulder width. Two people stop at twice this. */
export const PED_RADIUS = 0.27;

export const LOD_NEAR = 42;
export const LOD_MID = 95;
/**
 * Radii, in metres. These set the crowd's DENSITY, not just its reach, and the
 * relationship is not obvious: pedestrians diffuse, so a population recycled at
 * radius R settles into a roughly area-uniform distribution and the share
 * within 40 m goes as (40/R)^2. Measured at R = 192 that put only 15 of 270
 * people inside 40 m - a street with almost nobody on it. Pulling the recycle
 * radius in concentrates the same population where the player can actually
 * see faces, and the far end is covered by fog and by figures a pixel tall.
 */
export const RENDER_RADIUS = 150;
export const RECYCLE_RADIUS = 152;
const SPAWN_MIN = 46;
const SPAWN_MAX = 118;

/** Distance the player can move in one frame before we assume a teleport. */
const TELEPORT_JUMP = 55;

/**
 * Shortest steering target a direction may be normalised from.
 *
 * A target closer than this carries no usable direction: normalising a vector a
 * centimetre long and then walking at it full tilt overshoots it every step, and
 * the next step points back the way it came. See `step` for the deadlock that
 * produced.
 */
const MIN_TARGET_DISTANCE = 0.25;

/**
 * Forward progress a corner aim point must offer before it is trusted.
 *
 * Measured against the CURRENT link's direction of travel, because that is the
 * axis `along` advances on and `along` is what hands a pedestrian to the next
 * link.
 */
const MIN_CORNER_AHEAD = 0.35;

/** How far the stall watchdog's last-resort step moves someone, in metres. */
const STALL_NUDGE = 0.5;

/** Speed put on the decision to go round a prop rather than press into it. */
const SIDESTEP = 0.5;

/** Lateral resolution of the search for a way past a prop, in metres. */
const LATERAL_PROBE_STEP = 0.12;

/** How long a walker keeps aiming past a prop before it turns a corner. */
const DODGE_TIME = 1.4;

/**
 * Shortest obstacle correction that counts as something to walk around.
 *
 * A centimetre: below that the walker is grazing the box rather than pressing
 * into it, and reacting to a graze is what pinned people at corners. See the
 * obstacle branch of `step`.
 */
const CONTACT_PUSH = 0.01;

/**
 * Longest a crossing decision looks ahead, in seconds.
 *
 * Beyond this a prediction from a constant velocity is worthless: every driver
 * in this city brakes for a red inside six seconds.
 */
const CROSSING_HORIZON = 6;

/**
 * Clearance a pedestrian wants from a MOVING vehicle's box, in metres, on top
 * of their own radius. Deliberately not applied to a stopped one: the stop line
 * leaves 0.4 m and a margin wider than that vetoes every legally parked queue.
 */
const CROSSING_MARGIN = 0.5;

/**
 * How much faster than their usual pace somebody crosses a carriageway. Must
 * match `desiredSpeed`, because `crossingClear` uses it to decide whether they
 * can finish before the lights change.
 */
const CROSSING_HURRY = 1.16;

/**
 * Speed multiplier for somebody who has a car bearing down on them while they
 * are on a carriageway. Capped by `preferredSpeed * 1.75` like every other
 * steering output, so this is a run rather than a teleport.
 */
const CROSSING_SPRINT = 1.7;

/**
 * Speed below which a vehicle is treated as parked rather than as traffic.
 *
 * A car stopped at a stop line is the SAFEST thing on the road - the walk
 * signal exists because it is stopped - and treating it as a hazard is what
 * made every kerb in the city a permanent queue. See `crossingClear`.
 */
const VEHICLE_STOPPED = 0.4;

/** Clearance from a chassis at which a pedestrian treats it as upon them. */
const VEHICLE_NEAR = 0.45;

/**
 * Longest anybody stands at a kerb before giving up and walking on, in seconds.
 *
 * One whole signal cycle, so a pedestrian who has already been offered a
 * complete walk phase and still has not moved is looking at a crossing that is
 * not going to clear - a vehicle broken down on it, or a bug in the gate above.
 * The bound is the point: `watchStall` deliberately does not police a `wait`,
 * because waiting is a decision rather than a failure, so `wait` is the one
 * state that can last for ever unless something ends it. It could, and did:
 * measured with live traffic before this, 202 of 270 people spent more than a
 * minute at a kerb and one stood there for the entire ten minute run.
 */
const WAIT_PATIENCE = SIGNAL_CYCLE;

/**
 * How long somebody who has given up on a crossing walks past every other one,
 * in seconds. Long enough to clear the junction they gave up at.
 */
const CROSS_COOLDOWN = 14;

// -- how many people the surroundings can carry ------------------------------

/**
 * People per metre of zone-weighted pavement inside the seed radius.
 *
 * Calibrated so THE CITY IS UNCHANGED and only the airport moves. Measured
 * one-way pavement within `RENDER_RADIUS * 0.95`: the Old Quarter offers
 * 3324 m, the city spawn 2037 m and South Circuit - the thinnest city vantage
 * there is - 1870 m. At 0.15 people per metre those ask for 499, 306 and 281
 * people, all of which exceed the 270 the quality level allows, so downtown
 * simply stays at 270 exactly as before.
 *
 * The airport is where it bites. The landside offers 1241 m raw, and once each
 * zone's `share` is applied - 0.12 for an access road nobody walks along -
 * far less than that. See `docs/pedestrian-characters.md` and
 * `src/agents/travellers/zones.ts` for the measurements this is drawn from.
 */
const CROWD_DENSITY = 0.15;

/**
 * Fewest people the crowd will thin itself to.
 *
 * A remote corner of the map with almost no pavement in range must still have
 * somebody in it: an entirely empty street is a worse artefact than a slightly
 * over-dense one, and this is the floor that guarantees it.
 */
const MIN_ACTIVE = 10;

/** Seconds between recalculations of the population the surroundings carry. */
const SUPPLY_INTERVAL = 1.4;
/** Player movement that forces an early recalculation, in metres. */
const SUPPLY_MOVE = 22;

/**
 * Seconds a pedestrian takes to dissolve in or out.
 *
 * NOBODY MAY EVER POP. The crowd's head count is now a function of where the
 * player is standing, so people are retired and introduced continuously rather
 * than only at the 152 m recycle ring, and a hard `active = false` in the
 * middle of the drawn set would be a body vanishing in front of the player.
 * Half a second is long enough to read as a fade and short enough that the
 * population converges on a new limit within a few seconds of arriving.
 */
const FADE_TIME = 0.55;

/** What a retiring pedestrian does once they have finished fading out. */
const RETIRE_NONE = 0;
/** Return the slot to the pool and leave it empty. */
const RETIRE_POOL = 1;
/** Return the slot to the pool and immediately put somebody new in it. */
const RETIRE_RECYCLE = 2;

// -- gunfire -----------------------------------------------------------------

/**
 * How many separate alarms the crowd remembers at once.
 *
 * Bounded because a player emptying a magazine raises one per round, and an
 * unbounded list is an unbounded loop in a frame. Eight covers a firefight;
 * the ninth overwrites the oldest, which is the one people have already run
 * away from.
 */
const ALARM_SLOTS = 8;

/** How far a gunshot frightens people, in metres. */
export const ALARM_RADIUS = 26;

/** Seconds somebody keeps running after a shot they heard. */
const ALARM_TIME = 9;

/** How much faster a frightened pedestrian moves. */
const PANIC_HURRY = 1.55;

/**
 * Speed ceiling for somebody running from gunfire, as a multiple of their own
 * comfortable pace. Higher than the everyday 1.75 because a person genuinely
 * runs from a gun, and still a run rather than a teleport.
 */
const PANIC_MAX = 2.4;

// -- being knocked down -----------------------------------------------------

/** Seconds from the impact to lying flat. */
const FALL_TIME = 0.34;
/** Seconds a survivor lies there before starting to get up. */
const DOWN_TIME = 6.5;
/** Seconds getting back on their feet. Slower than the fall, as it should be. */
const RISE_TIME = 1.2;
/**
 * Closing speed at or above which a pedestrian does not get up again, m/s.
 *
 * 7 m/s is 25 km/h, the speed at which real survivability starts to fall away.
 * Below it a knock-down is a knock-down; above it, it is a casualty.
 */
const FATAL_SPEED = 7;
/** Slowest a vehicle may be going and still knock anybody over, m/s. */
const KNOCKDOWN_SPEED = 1.6;
/**
 * Seconds a casualty lies in the street before the pool slot may be reused.
 *
 * A body is scenery, and scenery that disappears while you are looking at it is
 * worse than no body at all. See `CASUALTY_CLEAR` for the other half of the
 * contract: the time has to have passed AND the player has to have walked away.
 */
export const CASUALTY_TIME = 60;
/**
 * Shortest a casualty stays once the street already holds `CASUALTY_LIMIT` of
 * them. The bodies are still bounded in count; this is what bounds the wait for
 * a slot when a player has been shooting.
 */
export const CASUALTY_TIME_CROWDED = 20;
/**
 * How many bodies the street keeps at once.
 *
 * Every casualty holds a pool slot out of circulation, so an unbounded count
 * would slowly empty the city of walkers. Fourteen is more than a player
 * produces in one incident and small enough that the crowd never notices.
 */
export const CASUALTY_LIMIT = 14;
/**
 * How far the player has to be before a body may be cleared away, in metres.
 *
 * `LOD_NEAR`, which is exactly the distance at which the crowd stops steering
 * an agent in full - so a body is only ever taken away from a part of the
 * street the player has already left. It then DISSOLVES rather than vanishing;
 * see `FADE_TIME`.
 */
export const CASUALTY_CLEAR = LOD_NEAR;
/** Clearance added to a chassis before it counts as having hit somebody. */
const STRIKE_MARGIN = 0.06;
/** Fraction of the striking speed a body is thrown at. */
const THROW_SHARE = 0.55;
/** Fastest a body is thrown, m/s. Above this it looks like a rag doll. */
const THROW_MAX = 6;
/** How quickly a thrown body scrubs off speed on the ground, per second. */
const THROW_DRAG = 4.5;
/** Radius a body on the ground keeps clear around it. A person is not a disc. */
export const DOWN_RADIUS = 0.85;

// -- being hit and staying on your feet --------------------------------------

/**
 * Seconds a flinch lasts.
 *
 * A STAGGER IS NOT A KNOCK-DOWN, and conflating them was the defect this
 * exists to fix: a round that wounded somebody used to put them flat on the
 * pavement for eight seconds, where they looked exactly like a corpse and -
 * because the combat layer skips anybody on the ground - could not be shot
 * again. A person who is hit and survives stumbles, drops their pace and runs;
 * they do not lie down.
 *
 * Just under a second, which is about how long a real flinch reads for.
 */
const STAGGER_TIME = 0.9;

/** Fraction of `STAGGER_TIME` spent leaning INTO the flinch before it eases out. */
const STAGGER_ONSET = 0.15;

/** How far over a staggering person leans, in radians. About twelve degrees. */
const STAGGER_TILT = 0.21;

/** Speed, in m/s, the stumble carries them along the round's line of travel. */
const STAGGER_SHOVE = 1.5;

/** How much of their pace a staggering person loses at the moment of the hit. */
const STAGGER_BRAKE = 0.35;

/**
 * How close a vehicle's centre has to be to the viewer to be taken for the
 * player's own car, in metres. A car the player is sitting in is at the viewer
 * to within a frame of travel; nothing else in the city can be, because the
 * player is solid to traffic and cannot stand inside a chassis.
 */
const PLAYER_CAR_RADIUS = 1.6;

export type PedState = 'walk' | 'wait' | 'cross' | 'pause' | 'down';

/*
 * ---------------------------------------------------------------------------
 * Conversations
 * ---------------------------------------------------------------------------
 *
 * A crowd of people who all walk past each other reads as traffic. What makes
 * a street read as a PLACE is that some of it has stopped and is talking, and
 * this is the smallest thing that produces that: two people who were already
 * pausing near each other are paired, turned to face one another, and hold the
 * spot for a while, handing a notional floor back and forth.
 *
 * It is built ON TOP of the pause that already existed rather than beside it,
 * which is what keeps it out of the movement code entirely: a conversation is
 * a pause with a partner and an owner for its timer. Nobody who is crossing, in
 * the road, alarmed, down or already talking can be recruited into one.
 */

/**
 * How near two people must be to start talking, by what the partner is doing.
 *
 * A partner who has ALREADY STOPPED may be a little further off: two people who
 * both paused a few metres apart and then drifted together is a thing that
 * happens. A partner who is still WALKING is recruited from closer, because
 * being hailed by somebody at arm's length reads as two people who know each
 * other, and being stopped mid-stride from four metres reads as a bug.
 *
 * Both matter, and the walker is what makes the feature happen at all:
 * measured on the shipped crowd, requiring two already-paused people gave
 * about one conversation alive at a time within the formation radius, because
 * two independent pauses landing within a couple of metres of each other is a
 * four-per-cent event.
 */
const CHAT_RADIUS = 3.2;
const CHAT_RECRUIT_RADIUS = 2.4;
/**
 * Seconds a conversation lasts, before either party has to be somewhere.
 *
 * BOUNDED BY AN INVARIANT, not by taste. `watchStall` deliberately polices
 * only `walk` and `cross` - standing still is a decision, not a failure - so
 * nothing else in the crowd will ever move a person who is talking, and
 * `tests/crowdCorners.test.ts` holds the whole crowd to nobody standing still
 * for thirty seconds. A conversation can be entered by somebody who has
 * already been paused for up to 6.5 s, so the ceiling here plus that has to
 * stay clear of thirty: 17 + 6.5 leaves six seconds of margin.
 */
const CHAT_SECONDS_MIN = 8;
const CHAT_SECONDS_MAX = 17;
/**
 * Seconds before somebody who has just finished a conversation may start
 * another.
 *
 * Without it the same person can pause, talk for seventeen seconds, walk two
 * steps, pause again and talk for another seventeen - which breaks the thirty
 * second invariant by chaining rather than by any single conversation, and
 * also reads as two people who cannot say goodbye.
 */
const CHAT_COOLDOWN = 30;
/** Seconds one person holds the floor before the other answers. */
const CHAT_TURN_MIN = 2.6;
const CHAT_TURN_MAX = 4.6;
/**
 * How many conversations may exist at once, and how far from the listener one
 * may be struck up.
 *
 * THE RADIUS IS THE LOAD-BEARING NUMBER, and it is not an optimisation. The
 * crowd is 270 people spread over a 142 m radius - about 63,000 square metres -
 * while a conversation can only be heard from `CHATTER_RADIUS`, which covers
 * 900. Spending a global budget of conversations across the whole crowd puts
 * essentially none of them where anybody can see or hear one: measured, twelve
 * groups over the whole crowd gave an expected 0.07 groups inside earshot, and
 * the feature simply never happened.
 *
 * Forming them near the listener instead concentrates the same budget where it
 * is experienced - roughly one or two audible at a time - and costs nothing in
 * plausibility, because a conversation 120 m away is four pixels tall and
 * silent either way. Groups already formed are never broken up for walking out
 * of it; people who are talking are free to be somewhere.
 *
 * The COUNT is an art decision rather than a performance one - a conversation
 * is a handful of numbers. Ten groups is twenty people standing out of the
 * ninety or so inside the radius, which is a busy pavement; past that it reads
 * as a market.
 */
const MAX_CONVERSATIONS = 10;
const CHAT_FORM_RADIUS = 45;
/** Chance a pause that could become a conversation actually does. */
const CHAT_TAKE_UP = 0.8;

/**
 * A group of people talking, as the outside world sees it.
 *
 * `speaker` is an index into whatever set of voices the caller has; it is
 * drawn once per person when the group forms, so the same body keeps the same
 * voice for the whole conversation. `line` increments on every hand-over, so a
 * consumer can tell "still the same sentence" from "somebody just started a
 * new one" without keeping a clock of its own.
 */
export interface CrowdConversation {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly speaker: number;
  readonly line: number;
}

/** One live conversation. Internal: the two members are held by reference. */
interface Conversation {
  id: number;
  a: Pedestrian;
  b: Pedestrian;
  /** Seconds left before both parties move on. */
  left: number;
  /** Seconds left of the current speaker's turn. */
  turn: number;
  /** 0 while `a` has the floor, 1 while `b` does. */
  side: 0 | 1;
  /** Increments on every hand-over. */
  line: number;
  /** Which voice each member speaks with. */
  voiceA: number;
  voiceB: number;
}

/**
 * What a vehicle did to somebody, reported to whoever owns the vehicle.
 *
 * `vehicle` is the very object that was passed in `CrowdContext.vehicles`, and
 * `index` is its position in that array, so a caller can recognise its own car
 * by identity rather than by guessing from coordinates.
 */
export interface PedestrianImpact {
  readonly vehicle: CrowdVehicle;
  readonly index: number;
  /** Where the body was struck. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Closing speed along the vehicle's direction of travel, m/s. */
  readonly speed: number;
  /** Unit direction the body was thrown in - the vehicle's line of travel. */
  readonly dirX: number;
  readonly dirZ: number;
  /** True when this one is not getting up. */
  readonly fatal: boolean;
}

/**
 * What the combat layer says about a round that hit somebody.
 *
 * Every field is optional and the defaults are the common case: a lethal shot,
 * matched within a metre, that frightens the street. See `Crowd.casualtyAt`.
 */
export interface CasualtyOptions {
  /** How far from the reported point to look for a body, in metres. Default 1. */
  readonly radius?: number | undefined;
  /** The ROUND's direction of travel, so the victim topples the right way. */
  readonly dirX?: number | undefined;
  readonly dirZ?: number | undefined;
  /**
   * False for a hit somebody survives.
   *
   * A SURVIVOR STAYS ON THEIR FEET. They flinch, stumble along the round's
   * line of travel, lose their pace and then run - see `staggerAt`. They do
   * NOT lie down: a wounded pedestrian on the pavement is indistinguishable
   * from a dead one, and while prone they are skipped by the combat layer's
   * own targeting, so a graze made somebody briefly unkillable.
   *
   * Default true - a persistent casualty who never rises.
   */
  readonly lethal?: boolean | undefined;
  /**
   * Forces a non-lethal hit to floor the victim anyway, with the vehicle
   * knock-down's recovery. Only for a blow that genuinely takes somebody off
   * their feet; a bullet is not one. Ignored when `lethal` is true.
   */
  readonly floor?: boolean | undefined;
  /** False to put somebody down silently. Default true. See `Crowd.alarmAt`. */
  readonly alarm?: boolean | undefined;
}

/**
 * The minimum a vehicle has to tell us. Deliberately structural so the vehicle
 * workstream can pass its own agents straight through without a shared type;
 * a missing velocity is read as stationary rather than as an error.
 */
export interface CrowdVehicle {
  readonly x: number;
  readonly z: number;
  readonly vx?: number | undefined;
  readonly vz?: number | undefined;
  /** Half extents in metres. Defaults to a family car if absent. */
  readonly halfLength?: number | undefined;
  readonly halfWidth?: number | undefined;
  /**
   * True when the player is driving this one.
   *
   * ONLY A PLAYER'S VEHICLE KNOCKS PEOPLE DOWN. Ambient traffic passes through
   * the crowd exactly as it always has, because nothing makes it yield: nobody
   * wires `TrafficSystem.setObstacles`, so a driver has no idea a pedestrian
   * is on the crossing. Letting every car knock people over on those terms was
   * measured at 210 knock-downs in ten minutes - a third of the population run
   * over, none of it the player's doing and none of it avoidable from here.
   * See `crossingClear` for why, and `PedestrianSystem.carriagewayObstacles`
   * for the two lines that would fix it and let this be relaxed.
   *
   * Leaving it unset is safe: `Crowd` then falls back to recognising the
   * player's car as the vehicle sitting on the viewer, which is exactly what
   * it is while somebody is driving it.
   */
  readonly player?: boolean | undefined;
}

export interface Pedestrian {
  active: boolean;
  link: number;
  /** Chosen continuation, or -1 while undecided. */
  next: number;
  along: number;
  lateral: number;
  lateralTarget: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  speed: number;
  heading: number;
  state: PedState;
  /** Seconds left in the current wait or pause. */
  timer: number;
  /**
   * Id of the conversation this person is standing in, or 0.
   *
   * A conversation owns the `pause` it is built on: while `chat` is non-zero
   * the pause timer is the group's business, not `decide`'s, which is what
   * stops two people who are talking to each other wandering off at different
   * moments in the middle of a sentence.
   */
  chat: number;
  /** Seconds before this person may join another conversation. */
  chatCooldown: number;
  /** Where along the current link a waiting pedestrian stands. */
  waitAlong: number;
  /** Walk cycle position in [0, 1). */
  phase: number;
  /** 0 standing, 1 walking. Drives limb amplitude in the shader. */
  gait: number;
  /** Gait cycles per second right now. The renderer sizes the stride from it. */
  cadenceNow: number;
  /** Seconds since the stall anchor was last reset. */
  stall: number;
  /** Where the pedestrian was when the stall anchor was last reset. */
  anchorX: number;
  anchorZ: number;
  /** How many recovery attempts the current blockage has taken. */
  stallTries: number;
  /**
   * Seconds left of "get past the thing in front of you before turning the
   * corner". Set when street furniture is actually being touched.
   */
  dodge: number;
  /**
   * Seconds left of "do not try to cross anything". Set when a crossing has
   * already been waited out once; without it a give-up is not a give-up at
   * all, because the very next node offers the same crossing again.
   */
  crossCooldown: number;
  lod: number;
  /** Frames until this agent's next simulation step. */
  due: number;
  groundAge: number;
  /**
   * How solidly this person is drawn, 0 to 1.
   *
   * `PedestrianSystem` hands it to the shader, which dissolves the body away
   * below 1. Nobody is ever activated or deactivated at full opacity, so the
   * population can change while the player is looking at it without anything
   * blinking in or out. See `FADE_TIME`.
   */
  fade: number;
  /**
   * `RETIRE_NONE`, `RETIRE_POOL` or `RETIRE_RECYCLE`. Anything but the first
   * means this person is fading out, and what happens when the fade completes.
   */
  retire: number;
  /**
   * Which `PEDESTRIAN_ZONES` entry this person is standing in, as an index.
   *
   * Taken from the link they are on rather than from their coordinates,
   * because the corridor clamp guarantees they are inside it and the link's
   * zone was decided once at construction. Free to read; a `zoneAt` call per
   * person per frame would not be.
   */
  zone: number;
  /**
   * Seconds left of "somebody near me fired a gun". Drives the hurry, the
   * choice of route away from it, and the refusal to stop and look at
   * anything. See `alarmAt`.
   */
  alarm: number;
  /**
   * Seconds left of a flinch. Nonzero means this person has just been hit and
   * is STILL ON THEIR FEET: they lean, they stumble along the round's line of
   * travel and they lose their pace, and then they run. See `staggerAt`.
   */
  stagger: number;
  /** Unit direction the stumble carries them, the round's line of travel. */
  staggerX: number;
  staggerZ: number;
  /** Where the shot that frightened them came from. */
  alarmX: number;
  alarmZ: number;
  /**
   * Seconds since this pedestrian was knocked down. Drives the topple and, on
   * the way back, the rise; meaningless unless `state` is 'down'.
   */
  downFor: number;
  /**
   * True while this one is never getting up again.
   *
   * THIS IS THE PERSISTENT CASUALTY STATE. A vehicle knock-down below
   * `FATAL_SPEED` leaves it false and the victim rises after `DOWN_TIME`; a
   * lethal hit - a fast vehicle, a bullet through `casualtyAt`, the middle of a
   * blast - sets it and the body stays down until it is cleared under the
   * bounds at `CASUALTY_LIMIT`. `Crowd.tilt` reads it to decide whether to play
   * the rise, and `stepDown` reads it to decide whether to run one at all.
   */
  fatal: boolean;
  /**
   * Which way they topple: +1 over backwards, -1 onto their face. Chosen from
   * where the impact came from relative to the way they were facing.
   */
  fallSign: number;
  look: PedestrianLook;
}

export interface CrowdOptions {
  readonly ground: CityGround;
  readonly network: RoadNetwork;
  readonly graph: PavementGraph;
  readonly obstacles: ObstacleIndex;
  readonly population: number;
  readonly seed: string;
}

export interface CrowdContext {
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly time: number;
  readonly vehicles?: readonly CrowdVehicle[] | undefined;
  /**
   * Which way the player is looking, as a unit vector on the ground.
   *
   * OPTIONAL, and everything works without it. Supplied, it keeps a recycled
   * pedestrian from being introduced in the cone the player is actually
   * watching: a spawn 46 m away is a person materialising in mid-shot, and the
   * fade covers it but does not make it invisible. Left out, the crowd falls
   * back to the player's smoothed direction of travel, which is where somebody
   * walking is usually looking and is nowhere at all when they are standing
   * still.
   */
  readonly forwardX?: number | undefined;
  readonly forwardZ?: number | undefined;
}

export interface CrowdStats {
  active: number;
  near: number;
  mid: number;
  far: number;
  rendered: number;
  /**
   * Agents that actually ran a simulation step this frame. Compare with
   * `active`: the gap is what the simulation LOD is saving.
   */
  stepped: number;
  waiting: number;
  crossing: number;
  respawned: number;
  /**
   * Times a pedestrian decided to step around something rather than keep
   * pushing at it. Not an error count: most of these are people walking round
   * someone who has stopped. A sustained rise means the pavement is too narrow
   * for the density.
   */
  detours: number;
  /**
   * Times somebody gave up on a crossing that never cleared and walked on
   * instead. Cumulative, and should stay near zero: a sustained rise means
   * `crossingClear` is refusing crossings the signals are offering.
   */
  gaveUp: number;
  /** Pedestrians currently on the ground. See `knockDown`. */
  down: number;
  /**
   * Of those, the ones who are never getting up. Bounded by `CASUALTY_LIMIT`
   * and cleared under the rules at `CASUALTY_TIME`.
   */
  casualties: number;
  /** Times a vehicle has knocked somebody down. Cumulative. */
  struck: number;
  /** People currently running from gunfire. See `alarmAt`. */
  alarmed: number;
  /**
   * How many of the pool the surroundings are judged able to carry.
   *
   * Between `MIN_ACTIVE` and `budget`. Downtown it is the budget; at the
   * airport it is a fraction of it, which is the whole of the fix for the
   * crowd that used to line the access road. See `CROWD_DENSITY`.
   */
  limit: number;
  /** Zone-weighted metres of pavement the limit was derived from. */
  supply: number;
  /** People in each `PEDESTRIAN_ZONES` entry, by index. */
  readonly byZone: Int32Array;
}

const GRID_BITS = 12;
const GRID_SIZE = 1 << GRID_BITS;
const GRID_MASK = GRID_SIZE - 1;
const CELL = 2.4;

function hashCell(ix: number, iz: number): number {
  return (Math.imul(ix, 92837111) ^ Math.imul(iz, 689287499)) & GRID_MASK;
}

/**
 * Clips `window` to the times a point at `p` moving at `v` lies within `half`
 * of the origin on one axis. Returns false when that never happens inside the
 * window - which, applied to both axes of a rectangle in turn, is a swept
 * point-versus-box test with no sampling in it.
 */
function slab(p: number, v: number, half: number, window: { lo: number; hi: number }): boolean {
  if (Math.abs(v) < 1e-4) return Math.abs(p) <= half;
  const a = (-half - p) / v;
  const b = (half - p) / v;
  if (Math.min(a, b) > window.lo) window.lo = Math.min(a, b);
  if (Math.max(a, b) < window.hi) window.hi = Math.max(a, b);
  return window.lo <= window.hi;
}

/**
 * True when a disc of `radius` at (x, z) overlaps a vehicle's chassis.
 *
 * The chassis is an oriented box lined up with where the vehicle is GOING,
 * which is the only orientation `CrowdVehicle` carries. A vehicle with no
 * velocity has no orientation to offer, so it falls back to the circle its box
 * fits inside - conservative, and only ever consulted for something that is not
 * moving and therefore cannot hit anybody.
 *
 * Growing the box by the disc radius rather than doing a true disc-box distance
 * test overstates the corners by at most `radius * (sqrt 2 - 1)`, 11 cm for a
 * person. That is the right way to be wrong for both of this function's callers.
 */
function vehicleOverlap(vehicle: CrowdVehicle, x: number, z: number, radius: number): boolean {
  const halfLength = (vehicle.halfLength ?? 2.3) + radius;
  const halfWidth = (vehicle.halfWidth ?? 0.95) + radius;
  const rx = x - vehicle.x;
  const rz = z - vehicle.z;
  const vx = vehicle.vx ?? 0;
  const vz = vehicle.vz ?? 0;
  const speed = Math.hypot(vx, vz);
  if (speed < 1e-3) {
    const reach = Math.hypot(halfLength, halfWidth);
    return rx * rx + rz * rz < reach * reach;
  }
  const fx = vx / speed;
  const fz = vz / speed;
  return (
    Math.abs(rx * fx + rz * fz) < halfLength && Math.abs(-rx * fz + rz * fx) < halfWidth
  );
}

function dampAngle(current: number, target: number, rate: number, dt: number): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= TAU;
  while (delta < -Math.PI) delta += TAU;
  return current + delta * (1 - Math.exp(-rate * dt));
}

export class Crowd {
  readonly peds: Pedestrian[] = [];
  /**
   * How many of the pool may be active. Lowering it retires the tail rather
   * than reallocating, so the quality menu never restarts the crowd.
   */
  budget: number;
  readonly stats: CrowdStats = {
    active: 0,
    near: 0,
    mid: 0,
    far: 0,
    rendered: 0,
    stepped: 0,
    waiting: 0,
    crossing: 0,
    respawned: 0,
    detours: 0,
    gaveUp: 0,
    down: 0,
    casualties: 0,
    struck: 0,
    alarmed: 0,
    limit: 0,
    supply: 0,
    byZone: new Int32Array(PEDESTRIAN_ZONES.length),
  };

  /** Told whenever a vehicle knocks somebody down. See `PedestrianImpact`. */
  onImpact: ((impact: PedestrianImpact) => void) | null = null;

  /**
   * Lets AMBIENT traffic knock people down too. Off by design - see
   * `CrowdVehicle.player`. Turn it on only once traffic yields to the crowd.
   */
  trafficStrikes = false;

  private readonly ground: CityGround;
  private readonly network: RoadNetwork;
  private readonly graph: PavementGraph;
  private readonly obstacles: ObstacleIndex;
  private readonly rng: Rng;

  private readonly cellHead = new Int32Array(GRID_SIZE);
  private readonly cellNext: Int32Array;

  private readonly scratch = { x: 0, z: 0 };
  private readonly push = { x: 0, z: 0 };
  private readonly probe = { x: 0, z: 0 };
  private readonly probePush = { x: 0, z: 0 };
  /** Reused time window for the swept crossing test. See `crossingClear`. */
  private readonly window = { lo: 0, hi: 0 };
  /** Reused output of `carriagewayObstacles`. Grown, never reallocated. */
  private readonly onRoad: { x: number; z: number; radius: number }[] = [];
  /**
   * Links street furniture has closed outright, by index. Built once, because
   * the scatter is static: see `ObstacleIndex.blocksCorridor` for why a route
   * can be impassable at all, and `chooseNext` for what is done about it.
   */
  private readonly closed: Uint8Array;
  /**
   * Which `PEDESTRIAN_ZONES` entry each link is in, and how densely that zone
   * may be populated. Both are decided once: the airport does not move.
   */
  private readonly linkZone: Uint8Array;
  private readonly linkShare: Float32Array;
  /** Live conversations, and the published view of them. See `CrowdConversation`. */
  private readonly chats: Conversation[] = [];
  private readonly chatViews: CrowdConversation[] = [];
  private nextChatId = 1;
  /** People currently standing in each zone. Rebuilt every frame in `update`. */
  private readonly zoneCount = new Int32Array(PEDESTRIAN_ZONES.length);
  private readonly zoneCap = new Int32Array(PEDESTRIAN_ZONES.length);
  /** How many of the pool the surroundings can carry. See `refreshLimit`. */
  private activeLimit: number;
  private supplyAge = Number.POSITIVE_INFINITY;
  private supplyX = Number.NaN;
  private supplyZ = Number.NaN;
  /** Recent gunfire, bounded to `ALARM_SLOTS` and overwritten oldest first. */
  private readonly alarms: { x: number; z: number; radius: number; at: number }[] = [];
  private alarmCursor = 0;
  /** Seconds of simulation, for stamping alarms. Monotone, never read as wall time. */
  private alarmClock = 0;
  private lastPlayerX = Number.NaN;
  private lastPlayerZ = Number.NaN;
  /** Smoothed player direction, so recycled agents land where they are going. */
  private driftX = 0;
  private driftZ = 0;
  /** Where the player is looking this frame, or the drift when unknown. */
  private viewX = 0;
  private viewZ = 0;

  constructor(options: CrowdOptions) {
    this.ground = options.ground;
    this.network = options.network;
    this.graph = options.graph;
    this.obstacles = options.obstacles;
    this.rng = createRng(`${options.seed}:crowd`);
    this.budget = options.population;
    this.cellNext = new Int32Array(options.population);
    for (let i = 0; i < options.population; i += 1) this.peds.push(this.blank());

    this.closed = new Uint8Array(this.graph.links.length);
    this.linkZone = new Uint8Array(this.graph.links.length);
    this.linkShare = new Float32Array(this.graph.links.length);
    for (let i = 0; i < this.graph.links.length; i += 1) {
      const link = this.graph.links[i];
      if (!link) continue;
      if (this.obstacles.blocksCorridor(link, PED_RADIUS + 0.14)) this.closed[i] = 1;

      /*
       * Zoning, decided once because the airport is not going to move.
       *
       * TWO DIFFERENT QUESTIONS, ANSWERED TWO DIFFERENT WAYS.
       *
       * Which zone a link BELONGS to is answered at its midpoint, because that
       * is the representative point of a corridor and because it has to agree
       * with `zoneAt(ped.x, ped.z)` - the caps are a statement about where
       * people are standing, and a test that sweeps positions has to be able
       * to reproduce them.
       *
       * Whether a link is ALLOWED is answered by sweeping the whole run, and
       * any sample that lands on a forbidden surface closes it. That reuses the
       * flag street furniture already sets, so `linksNear`, `chooseNext` and
       * `respawn` all refuse it for free and nobody has to be steered off a
       * taxiway after the fact.
       */
      const zone = zoneAt((link.ax + link.bx) * 0.5, (link.az + link.bz) * 0.5);
      const rule = zoneRule(zone);
      this.linkZone[i] = PEDESTRIAN_ZONES.indexOf(zone);
      this.linkShare[i] = rule.share;
      if (rule.forbidden || zoneRule(zoneAlong(link.ax, link.az, link.bx, link.bz)).forbidden) {
        this.closed[i] = 1;
        this.linkShare[i] = 0;
      }
    }
    for (let z = 0; z < PEDESTRIAN_ZONES.length; z += 1) {
      const cap = zoneRule(PEDESTRIAN_ZONES[z] as PedestrianZone).cap;
      // An Int32Array cannot hold Infinity; the pool size is an exact ceiling.
      this.zoneCap[z] = Number.isFinite(cap) ? cap : this.peds.length;
    }
    this.activeLimit = this.budget;
    this.stats.limit = this.budget;
  }

  // -- zones and how many people they carry ---------------------------------

  /** Which zone a link is in, as a `PEDESTRIAN_ZONES` index. */
  zoneOf(linkIndex: number): PedestrianZone {
    return (PEDESTRIAN_ZONES[this.linkZone[linkIndex] ?? 0] ?? 'city') as PedestrianZone;
  }

  /** Which zone a pedestrian is standing in. */
  static zoneName(ped: Pedestrian): PedestrianZone {
    return (PEDESTRIAN_ZONES[ped.zone] ?? 'city') as PedestrianZone;
  }

  /**
   * Zone-weighted metres of pavement within the seed radius of a point.
   *
   * One-way metres: a link and its reverse are the same strip of ground, and
   * counting both would double every street. Each link contributes
   * `length * share`, so a metre of forecourt is worth 0.6 m of city pavement
   * and a metre of airport access road 0.12 m of it.
   */
  supplyNear(px: number, pz: number, radius = RENDER_RADIUS * 0.95): number {
    let total = 0;
    const links = this.graph.links;
    for (let i = 0; i < links.length; i += 1) {
      const link = links[i];
      if (!link || link.crossing) continue;
      if (this.closed[i] === 1) continue;
      if (link.reverse >= 0 && link.reverse < i) continue;
      const mx = (link.ax + link.bx) * 0.5;
      const mz = (link.az + link.bz) * 0.5;
      if (Math.hypot(mx - px, mz - pz) > radius) continue;
      total += link.length * (this.linkShare[i] ?? 1);
    }
    return total;
  }

  /**
   * How many of the pool the ground around the player can plausibly carry.
   *
   * Recomputed on a timer and whenever the player has moved far enough for the
   * answer to have changed, because it is a pass over every link and the answer
   * is a slowly varying property of where you are standing.
   */
  private refreshLimit(px: number, pz: number, dt: number): void {
    this.supplyAge += dt;
    const moved = Number.isFinite(this.supplyX)
      ? Math.hypot(px - this.supplyX, pz - this.supplyZ)
      : Number.POSITIVE_INFINITY;
    if (this.supplyAge < SUPPLY_INTERVAL && moved < SUPPLY_MOVE) return;
    this.supplyAge = 0;
    this.supplyX = px;
    this.supplyZ = pz;
    const supply = this.supplyNear(px, pz);
    this.stats.supply = Number(supply.toFixed(1));
    this.activeLimit = Math.max(
      Math.min(MIN_ACTIVE, this.budget),
      Math.min(this.budget, Math.round(supply * CROWD_DENSITY)),
    );
    this.stats.limit = this.activeLimit;
  }

  /**
   * Everybody currently standing on a carriageway, as circles.
   *
   * This is the crowd's half of the contract `TrafficSystem.setObstacles`
   * exists for and nobody has ever wired: with it, drivers brake for people on
   * a crossing; without it, they do not know anybody is there. The array is
   * rebuilt in place and returned by reference, so a caller may hand it over
   * once and let it keep changing.
   *
   * Only people on a crossing link are listed. Somebody on a pavement is
   * behind a kerb and braking for them would stop the city dead.
   */
  carriagewayObstacles(): readonly { x: number; z: number; radius: number }[] {
    this.onRoad.length = 0;
    for (const ped of this.peds) {
      if (!ped.active) continue;
      if (!this.graph.links[ped.link]?.crossing) continue;
      this.onRoad.push({
        x: ped.x,
        z: ped.z,
        radius: ped.state === 'down' ? DOWN_RADIUS : PED_RADIUS,
      });
    }
    return this.onRoad;
  }

  /** True when somebody is on this crossing, by `Crossing.id`. */
  crossingBlocked(id: string): boolean {
    for (const ped of this.peds) {
      if (!ped.active) continue;
      if (this.graph.links[ped.link]?.crossing?.id === id) return true;
    }
    return false;
  }

  /** How many links street furniture has closed. Diagnostics and tests. */
  get closedLinks(): number {
    let count = 0;
    for (const flag of this.closed) if (flag) count += 1;
    return count;
  }

  /** True when street furniture leaves no way along this link at all. */
  isClosed(index: number): boolean {
    return this.closed[index] === 1;
  }

  private blank(): Pedestrian {
    return {
      active: false,
      link: 0,
      next: -1,
      along: 0,
      lateral: 0,
      lateralTarget: 0,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vz: 0,
      speed: 0,
      heading: 0,
      state: 'walk',
      timer: 0,
      waitAlong: 0,
      chat: 0,
      chatCooldown: 0,
      phase: 0,
      gait: 0,
      cadenceNow: 1,
      stall: 0,
      anchorX: 0,
      anchorZ: 0,
      stallTries: 0,
      dodge: 0,
      lod: 2,
      due: 0,
      groundAge: 0,
      crossCooldown: 0,
      fade: 0,
      retire: RETIRE_NONE,
      zone: PEDESTRIAN_ZONES.length - 1,
      alarm: 0,
      alarmX: 0,
      alarmZ: 0,
      stagger: 0,
      staggerX: 0,
      staggerZ: 0,
      downFor: 0,
      fatal: false,
      fallSign: 1,
      look: makeLook(this.rng),
    };
  }

  /**
   * How far over a downed pedestrian has toppled, in radians, and which way.
   *
   * Zero on their feet, `±PI/2` flat out. Everything about drawing a body is
   * this one number: `PedestrianSystem` folds it into the same instance matrix
   * that already carries the heading and the build, so a body on the ground
   * costs the crowd exactly nothing extra to draw - no second mesh, no second
   * material, no extra draw call.
   */
  static tilt(ped: Pedestrian): number {
    if (ped.state !== 'down') {
      if (ped.stagger <= 0) return 0;
      /*
       * The flinch, drawn by exactly the same machinery a topple is: a tilt
       * folded into the instance matrix that already carries the heading and
       * the build. No new mesh, no new clip, no extra draw call - see
       * `PedestrianSystem.writeMatrix`.
       *
       * Quick in and slow out, because that is what a flinch looks like: the
       * lean arrives over `STAGGER_ONSET` of the reaction and unwinds over the
       * rest of it. A step function would pop.
       */
      const gone = 1 - ped.stagger / STAGGER_TIME;
      const amount =
        gone < STAGGER_ONSET
          ? gone / STAGGER_ONSET
          : (1 - (gone - STAGGER_ONSET) / (1 - STAGGER_ONSET)) ** 2;
      return ped.fallSign * amount * STAGGER_TILT;
    }
    const fall = clamp(ped.downFor / FALL_TIME, 0, 1);
    // Ease out: a falling body accelerates and then stops dead on the ground.
    let amount = 1 - (1 - fall) * (1 - fall);
    if (!ped.fatal) {
      const rising = ped.downFor - (FALL_TIME + DOWN_TIME);
      if (rising > 0) amount = Math.min(amount, clamp(1 - rising / RISE_TIME, 0, 1));
    }
    return ped.fallSign * amount * Math.PI * 0.5;
  }

  // -- spawning -------------------------------------------------------------

  /**
   * Fills the city around a point.
   *
   * Links are chosen by STRATIFIED length-weighted sampling of everything in
   * range rather than by repeated independent draws. Independent draws put a
   * visible clump on whichever street wins the first few rolls; stratifying
   * guarantees the population is spread over every street in range in
   * proportion to how much pavement each one has.
   *
   * The length is ZONE-WEIGHTED, so the same stratification that spreads people
   * evenly along a city street also thins them across an airport access road -
   * one mechanism, one place to reason about it. The head count comes from the
   * same weighting through `refreshLimit`, and the per-zone caps are enforced
   * as the strata are consumed, so a seed can never open with a zone over its
   * ceiling.
   */
  seed(px: number, pz: number): void {
    const candidates = this.linksNear(px, pz, 0, RENDER_RADIUS * 0.95);
    if (candidates.length === 0) return;

    // The limit has to be current before anybody is placed: a teleport is
    // exactly when the surroundings change completely.
    this.supplyAge = Number.POSITIVE_INFINITY;
    this.refreshLimit(px, pz, 0);

    let total = 0;
    for (const index of candidates) {
      total += (this.graph.links[index]?.length ?? 0) * (this.linkShare[index] ?? 1);
    }
    if (total <= 0) return;

    this.zoneCount.fill(0);
    const count = Math.min(this.activeLimit, this.budget, this.peds.length);
    for (let i = 0; i < this.peds.length; i += 1) {
      const ped = this.peds[i];
      if (!ped) continue;
      if (i >= count) {
        ped.active = false;
        ped.retire = RETIRE_NONE;
        ped.fade = 0;
        continue;
      }
      // One stratum per pedestrian, jittered inside it.
      const r = (i + this.rng.next()) / count;
      let target = r * total;
      let chosen = candidates[candidates.length - 1] ?? 0;
      for (const index of candidates) {
        target -= (this.graph.links[index]?.length ?? 0) * (this.linkShare[index] ?? 1);
        if (target <= 0) {
          chosen = index;
          break;
        }
      }
      // A stratum that lands in a zone already at its ceiling is skipped
      // rather than clamped: the slot stays empty and `update` will find it
      // somewhere legal on a later frame.
      const zone = this.linkZone[chosen] ?? 0;
      if ((this.zoneCount[zone] ?? 0) >= (this.zoneCap[zone] ?? 0)) {
        ped.active = false;
        ped.retire = RETIRE_NONE;
        ped.fade = 0;
        continue;
      }
      this.zoneCount[zone] = (this.zoneCount[zone] ?? 0) + 1;
      this.place(ped, chosen, this.rng.next());
      // A seed follows a teleport, and there is no continuity to protect
      // across one. Fading three hundred people in would read as the world
      // materialising rather than as a crowd already going about its day.
      ped.fade = 1;
    }
    this.reindex();
    this.separateInitial();
  }

  private linksNear(px: number, pz: number, min: number, max: number): number[] {
    const out: number[] = [];
    const links = this.graph.links;
    for (let i = 0; i < links.length; i += 1) {
      const link = links[i];
      if (!link || link.crossing) continue;
      // Nobody may be placed where they could not walk out.
      if (this.closed[i] === 1) continue;
      // Reverse links duplicate their partner's geometry; sampling both would
      // double the weight of every stretch of pavement.
      if (link.reverse >= 0 && link.reverse < i) continue;
      const mx = (link.ax + link.bx) * 0.5;
      const mz = (link.az + link.bz) * 0.5;
      const d = Math.hypot(mx - px, mz - pz);
      if (d >= min && d <= max) out.push(i);
    }
    return out;
  }

  private place(ped: Pedestrian, linkIndex: number, t: number): void {
    const link = this.graph.links[linkIndex];
    if (!link) return;
    // Half the population walks the other way.
    const index = this.rng.chance(0.5) && link.reverse >= 0 ? link.reverse : linkIndex;
    const chosen = this.graph.links[index];
    if (!chosen) return;

    ped.look = makeLook(this.rng);
    ped.active = true;
    ped.link = index;
    ped.zone = this.linkZone[index] ?? 0;
    // Dissolves in. `seed` overrides it to 1 straight afterwards, because a
    // teleport has no continuity to protect; every other caller wants the fade.
    ped.fade = 0;
    ped.retire = RETIRE_NONE;
    ped.alarm = 0;
    ped.stagger = 0;
    ped.next = -1;
    ped.along = clamp(t * chosen.length, 0.5, Math.max(0.5, chosen.length - 0.5));
    ped.lateralTarget = this.preferredLateral(chosen, ped.look);
    ped.lateral = ped.lateralTarget;
    ped.state = 'walk';
    ped.timer = this.rng.range(4, 30);
    ped.speed = ped.look.preferredSpeed;
    ped.gait = 1;
    ped.stall = 0;
    ped.stallTries = 0;
    ped.dodge = 0;
    ped.crossCooldown = 0;
    ped.downFor = 0;
    ped.fatal = false;
    ped.fallSign = 1;
    ped.phase = this.rng.next();
    ped.lod = 2;
    ped.due = 0;
    ped.groundAge = 999;
    linkPoint(chosen, ped.along, ped.lateral, this.scratch);
    ped.x = this.scratch.x;
    ped.z = this.scratch.z;
    ped.y = this.ground.sample(ped.x, ped.z).y;
    ped.vx = chosen.dx * ped.speed;
    ped.vz = chosen.dz * ped.speed;
    ped.heading = Math.atan2(-ped.vx, -ped.vz);
  }

  /**
   * Where on the pavement this person prefers to walk.
   *
   * Biased to the walker's right, which is what keeps two opposing streams from
   * meeting head-on all day. The bias is soft: pavements here are 2.8 m at
   * their narrowest and a hard keep-right would halve them.
   */
  private preferredLateral(link: PavementLink, look: PedestrianLook): number {
    const w = link.halfWidth;
    return clamp(-0.42 * w + look.laneBias * 0.55 * w, -w, w);
  }

  /**
   * Returns a pedestrian to the pool and puts them back somewhere useful.
   *
   * Two biases, both measured rather than guessed. Picking uniformly from the
   * links in the ring puts almost everyone at its far edge, because there is
   * far more pavement at 140 m than at 60 m; weighting by 1/(1 + (d/50)^2)
   * cancels that growth so the population is spread evenly in DISTANCE. And
   * the crowd is pulled toward wherever the player is heading, because
   * otherwise walking two hundred metres leaves the whole city behind you:
   * measured before this, a player who walked 200 m had 15 people within 60 m.
   *
   * Three more, added with the airport:
   *
   *   - the zone's `share`, so a recycled pedestrian is far likelier to reappear
   *     on a city pavement or a terminal forecourt than on an access road;
   *   - the zone's `cap`, as a hard veto - a full zone offers no candidates at
   *     all, whatever the geometry says;
   *   - a penalty for landing INSIDE THE PLAYER'S VIEW CONE. The ring starts at
   *     46 m, which is close enough for a person appearing in it to be seen
   *     doing so; the fade covers the rest, but not putting them there in the
   *     first place is better than covering it.
   */
  private respawn(ped: Pedestrian, px: number, pz: number): void {
    const candidates = this.linksNear(px, pz, SPAWN_MIN, SPAWN_MAX);
    if (candidates.length === 0) {
      ped.active = false;
      return;
    }

    const drift = Math.hypot(this.driftX, this.driftZ);
    const headX = drift > 0.25 ? this.driftX / drift : 0;
    const headZ = drift > 0.25 ? this.driftZ / drift : 0;

    let total = 0;
    let chosen = -1;
    for (const index of candidates) {
      const link = this.graph.links[index];
      if (!link) continue;
      const zone = this.linkZone[index] ?? 0;
      if ((this.zoneCount[zone] ?? 0) >= (this.zoneCap[zone] ?? 0)) continue;
      const mx = (link.ax + link.bx) * 0.5 - px;
      const mz = (link.az + link.bz) * 0.5 - pz;
      const d = Math.hypot(mx, mz);
      const spread = 1 / (1 + (d / 38) * (d / 38));
      const ahead = headX === 0 && headZ === 0 ? 0 : Math.max(0, (mx * headX + mz * headZ) / d);
      /*
       * How far into the field of view this candidate is. 0.55 is about 57
       * degrees off the view axis - comfortably outside a 70 degree horizontal
       * field of view - so anything beyond it is off screen and pays nothing.
       * A candidate dead ahead and close is discouraged by a factor of six; one
       * dead ahead but near the far edge of the ring is barely touched, because
       * a person 110 m away is a dozen pixels tall.
       */
      let seen = 0;
      if (d > 1e-3 && (this.viewX !== 0 || this.viewZ !== 0)) {
        const facing = (mx * this.viewX + mz * this.viewZ) / d;
        seen = Math.max(0, (facing - 0.55) / 0.45) * clamp(1 - (d - SPAWN_MIN) / 55, 0, 1);
      }
      const weight = spread * (1 + 1.9 * ahead) * (this.linkShare[index] ?? 1) * (1 - 0.84 * seen);
      if (weight <= 0) continue;
      total += weight;
      // Weighted reservoir sample: one pass, no temporary array.
      if (this.rng.next() * total < weight) chosen = index;
    }
    if (chosen < 0) {
      ped.active = false;
      return;
    }
    const zone = this.linkZone[chosen] ?? 0;
    this.zoneCount[zone] = (this.zoneCount[zone] ?? 0) + 1;
    this.place(ped, chosen, this.rng.next());
    this.stats.respawned += 1;
  }

  /** One pass of positional relaxation, so a fresh crowd is never stacked. */
  private separateInitial(): void {
    for (let pass = 0; pass < 4; pass += 1) {
      this.reindex();
      this.resolveOverlaps(1);
    }
  }

  // -- neighbour index ------------------------------------------------------

  private reindex(): void {
    this.cellHead.fill(-1);
    for (let i = 0; i < this.peds.length; i += 1) {
      const ped = this.peds[i];
      if (!ped || !ped.active) {
        this.cellNext[i] = -1;
        continue;
      }
      const key = hashCell(Math.floor(ped.x / CELL), Math.floor(ped.z / CELL));
      this.cellNext[i] = this.cellHead[key] ?? -1;
      this.cellHead[key] = i;
    }
  }

  // -- stepping -------------------------------------------------------------

  update(dt: number, ctx: CrowdContext): void {
    if (dt <= 0) return;
    const step = Math.min(dt, 0.1);

    const jumped =
      !Number.isFinite(this.lastPlayerX) ||
      Math.hypot(ctx.x - this.lastPlayerX, ctx.z - this.lastPlayerZ) > TELEPORT_JUMP;
    if (!jumped && Number.isFinite(this.lastPlayerX)) {
      const dx = ctx.x - this.lastPlayerX;
      const dz = ctx.z - this.lastPlayerZ;
      const rate = 1 - Math.exp(-0.6 * step);
      this.driftX += (dx / step - this.driftX) * rate;
      this.driftZ += (dz / step - this.driftZ) * rate;
    }
    this.lastPlayerX = ctx.x;
    this.lastPlayerZ = ctx.z;
    /*
     * Where the player is looking, for the out-of-view spawn bias. Their own
     * facing when the caller supplies it, otherwise the smoothed direction of
     * travel - which is where somebody walking is usually looking, and is
     * exactly zero when they are standing still, which switches the bias off
     * rather than pointing it somewhere wrong.
     */
    if (ctx.forwardX !== undefined && ctx.forwardZ !== undefined) {
      const length = Math.hypot(ctx.forwardX, ctx.forwardZ);
      this.viewX = length > 1e-4 ? ctx.forwardX / length : 0;
      this.viewZ = length > 1e-4 ? ctx.forwardZ / length : 0;
    } else {
      const drift = Math.hypot(this.driftX, this.driftZ);
      this.viewX = drift > 0.6 ? this.driftX / drift : 0;
      this.viewZ = drift > 0.6 ? this.driftZ / drift : 0;
    }
    if (jumped) {
      // A teleport (or the first frame) invalidates the whole distribution.
      // Reseeding is far cheaper than watching every agent recycle one by one.
      this.seed(ctx.x, ctx.z);
      return;
    }

    this.refreshLimit(ctx.x, ctx.z, step);
    this.alarmClock += step;

    this.stats.active = 0;
    this.stats.near = 0;
    this.stats.mid = 0;
    this.stats.far = 0;
    this.stats.rendered = 0;
    this.stats.stepped = 0;
    this.stats.waiting = 0;
    this.stats.crossing = 0;
    let down = 0;
    let casualties = 0;
    let alarmed = 0;

    /*
     * The zone census, taken fresh rather than maintained incrementally.
     *
     * A pedestrian changes zone by walking across a line nobody told the crowd
     * about, so an incremental count drifts; 270 array increments do not show
     * up in a profile and cannot drift at all. Spawns during this frame
     * increment it as they go, so two respawns cannot both take the last slot
     * in a zone.
     */
    this.zoneCount.fill(0);
    for (const ped of this.peds) {
      if (!ped.active) continue;
      /*
       * FROM THE POSITION, not from the link.
       *
       * A cap is a statement about where people are standing, and a link is a
       * corridor that can start in one zone and end in another: measured
       * before this, links classified as access road were carrying people who
       * were standing on the forecourt, and the forecourt ran five over a cap
       * of thirty that the crowd's own books said it was inside. Six rectangle
       * comparisons per person per frame, and the first of them rejects
       * everybody in the city.
       */
      ped.zone = zoneIndexAt(ped.x, ped.z);
      // Somebody already dissolving has stopped counting against the zone they
      // are leaving. Counting them would flag their replacements as surplus
      // too, and the zone would oscillate between empty and over its cap
      // rather than settling on it.
      if (ped.retire === RETIRE_NONE) {
        this.zoneCount[ped.zone] = (this.zoneCount[ped.zone] ?? 0) + 1;
      }
    }

    this.reindex();

    // How many people are allowed to be up at all. Everything past this is
    // retired - by fading, never by vanishing.
    const limit = Math.min(this.activeLimit, this.budget);
    let kept = 0;

    for (let i = 0; i < this.peds.length; i += 1) {
      const ped = this.peds[i];
      if (!ped) continue;
      if (!ped.active) {
        // Only top the crowd up to the limit. A slot left empty costs one
        // comparison a frame; respawning into a full city costs a pass over
        // every link in it.
        if (kept < limit) {
          this.respawn(ped, ctx.x, ctx.z);
          if (ped.active) kept += 1;
        }
        continue;
      }
      kept += 1;

      const distance = Math.hypot(ped.x - ctx.x, ped.z - ctx.z);
      if (distance > RECYCLE_RADIUS) {
        // Out past the ring: nothing here is drawn, so this one may be moved
        // or dropped outright with no fade at all.
        if (kept > limit) {
          ped.active = false;
          ped.fade = 0;
          ped.retire = RETIRE_NONE;
          kept -= 1;
        } else {
          this.respawn(ped, ctx.x, ctx.z);
        }
        continue;
      }

      /*
       * The surplus, and the people standing where they should not be.
       *
       * Both are retired the same way: a flag, a fade, and only then the slot.
       * `kept` counts in pool order, which bears no relation to where anybody
       * is standing, so the surplus is a spatially unbiased sample and the
       * choice is stable from frame to frame - the same slots keep losing, so
       * the population converges instead of thrashing.
       */
      const inZone = this.zoneCount[ped.zone] ?? 0;
      const zoneCap = this.zoneCap[ped.zone] ?? 0;
      if (ped.retire === RETIRE_NONE && (kept > limit || inZone > zoneCap)) {
        ped.retire = RETIRE_POOL;
        if (inZone > zoneCap) this.zoneCount[ped.zone] = inZone - 1;
      } else if (ped.retire === RETIRE_POOL && kept <= limit && inZone < zoneCap) {
        /*
         * HYSTERESIS, and it is load-bearing. The census above deliberately
         * skips people who are already dissolving, so a zone that was five
         * over its cap reads as exactly AT it on the very next frame - and an
         * un-retire test of `<= cap` would then put all five back, every
         * frame, for ever. Coming back needs a slot that is genuinely free.
         */
        ped.retire = RETIRE_NONE;
      }

      // The dissolve, advanced at every LOD because a body fading at a quarter
      // rate reads as a flicker. Two compares and an add.
      if (!this.advanceFade(ped, step, ctx)) {
        // A cleared casualty is recycled straight into a new person, so the
        // slot is still in use; a retired surplus is not.
        if (!ped.active) kept -= 1;
        continue;
      }

      ped.lod = distance < LOD_NEAR ? 0 : distance < LOD_MID ? 1 : 2;
      this.stats.active += 1;
      if (ped.lod === 0) this.stats.near += 1;
      else if (ped.lod === 1) this.stats.mid += 1;
      else this.stats.far += 1;
      if (distance <= RENDER_RADIUS) this.stats.rendered += 1;
      if (ped.state === 'wait') this.stats.waiting += 1;
      if (ped.state === 'cross') this.stats.crossing += 1;
      if (ped.alarm > 0) alarmed += 1;

      if (ped.state === 'down') {
        down += 1;
        if (ped.fatal) casualties += 1;
        // A body is stepped EVERY frame whatever its LOD. It costs three adds,
        // and running the topple at a quarter rate would make a distant fall
        // read as a stutter - the one moment the eye is certainly on them.
        this.stepDown(ped, step, distance);
        continue;
      }

      // The walk cycle advances every frame even when the agent does not, so
      // a distant figure never stutters. One add per pedestrian.
      this.advancePhase(ped, step);

      const stride = ped.lod === 0 ? 1 : ped.lod === 1 ? 2 : 4;
      ped.due -= 1;
      if (ped.due > 0) continue;
      ped.due = stride;
      this.stats.stepped += 1;
      this.step(ped, i, step * stride, ctx);
    }
    this.stats.down = down;
    this.stats.casualties = casualties;
    this.stats.alarmed = alarmed;
    this.stats.byZone.set(this.zoneCount);

    this.strike(ctx);
    this.resolveOverlaps(2);
    // After the overlap solve, so the two people facing each other are facing
    // where they actually ended up standing.
    this.updateConversations(step);
  }

  // -- conversations --------------------------------------------------------

  /**
   * Live conversations, for whoever is voicing them.
   *
   * Rebuilt into a reused array every time it is read, because it is read once
   * per frame from the audio layer and allocating a dozen objects at 120 Hz is
   * a garbage-collection pause nobody asked for.
   */
  get conversations(): readonly CrowdConversation[] {
    this.chatViews.length = 0;
    for (const chat of this.chats) {
      const talker = chat.side === 0 ? chat.a : chat.b;
      this.chatViews.push({
        id: chat.id,
        x: talker.x,
        // Mouth height rather than foot height, so the line is spatialised on
        // the person and not on the pavement in front of them.
        y: talker.y + 1.5,
        z: talker.z,
        speaker: chat.side === 0 ? chat.voiceA : chat.voiceB,
        line: chat.line,
      });
    }
    return this.chatViews;
  }

  /**
   * Pairs somebody who has just stopped with somebody standing next to them.
   *
   * The partner has to be ALREADY STOPPED. Recruiting a walker would mean
   * arresting somebody mid-stride to listen to a stranger, which reads as a
   * bug; two people who both happened to pause within a couple of metres reads
   * as two people who know each other.
   */
  private formConversation(ped: Pedestrian, ctx: CrowdContext): void {
    if (this.chats.length >= MAX_CONVERSATIONS || ped.chat !== 0) return;
    if (ped.state !== 'pause' || ped.retire !== RETIRE_NONE || ped.chatCooldown > 0) return;
    // See CHAT_FORM_RADIUS: the budget is spent where it can be experienced.
    const outX = ped.x - ctx.x;
    const outZ = ped.z - ctx.z;
    if (outX * outX + outZ * outZ > CHAT_FORM_RADIUS * CHAT_FORM_RADIUS) return;

    let partner: Pedestrian | null = null;
    let bestSq = Infinity;
    for (const other of this.peds) {
      if (other === ped || !other.active) continue;
      if (other.chat !== 0 || other.retire !== RETIRE_NONE || other.alarm > 0) continue;
      if (other.chatCooldown > 0) continue;
      // Only somebody standing on a pavement with nowhere urgent to be. A
      // walker may be hailed; a person waiting at a kerb, crossing a road or
      // lying on the ground may not.
      const paused = other.state === 'pause';
      if (!paused && other.state !== 'walk') continue;
      // NEVER IN THE ROAD. A walker hailed while they are on a crossing would
      // stop dead on the carriageway and stay there for the whole
      // conversation, which is both a hazard and the one place the crowd's own
      // rules are strictest about.
      if (!paused && (this.graph.links[other.link]?.crossing ?? true)) continue;
      const reach = paused ? CHAT_RADIUS : CHAT_RECRUIT_RADIUS;
      const dx = other.x - ped.x;
      const dz = other.z - ped.z;
      const d = dx * dx + dz * dz;
      // Standing on top of each other is the overlap solver mid-correction,
      // not two people in conversation.
      if (d < 0.3 || d >= reach * reach || d >= bestSq) continue;
      bestSq = d;
      partner = other;
    }
    if (!partner) return;

    // A recruited walker stops where they are, which is beside the person who
    // hailed them; `waitAlong` is what holds them there.
    if (partner.state !== 'pause') {
      partner.state = 'pause';
      partner.waitAlong = partner.along;
    }

    const id = this.nextChatId;
    this.nextChatId += 1;
    ped.chat = id;
    partner.chat = id;
    // The pause timers are no longer consulted, but leaving them running means
    // a dissolved conversation hands back a person who leaves immediately.
    ped.timer = 0;
    partner.timer = 0;
    const voiceA = Math.floor(this.rng.next() * 7);
    let voiceB = Math.floor(this.rng.next() * 7);
    // Two people in a conversation must not have the same voice; it reads as
    // one person answering themselves.
    if (voiceB === voiceA) voiceB = (voiceB + 1) % 7;
    this.chats.push({
      id,
      a: ped,
      b: partner,
      left: this.rng.range(CHAT_SECONDS_MIN, CHAT_SECONDS_MAX),
      turn: this.rng.range(CHAT_TURN_MIN, CHAT_TURN_MAX),
      side: 0,
      line: 0,
      voiceA,
      voiceB,
    });
  }

  /**
   * Runs every conversation: who has the floor, where they are looking, and
   * when it is over.
   *
   * A group ends for one of three reasons and all of them are the same code
   * path - somebody was knocked down, alarmed, recycled or otherwise stopped
   * being a person standing still, or the clock ran out. Ending it always
   * returns both members to `walk`, so nobody can be left standing on a
   * pavement for ever because their partner was run over.
   */
  private updateConversations(dt: number): void {
    for (let i = this.chats.length - 1; i >= 0; i -= 1) {
      const chat = this.chats[i];
      if (!chat) continue;
      const { a, b } = chat;
      const broken =
        !a.active ||
        !b.active ||
        a.chat !== chat.id ||
        b.chat !== chat.id ||
        a.state !== 'pause' ||
        b.state !== 'pause' ||
        a.alarm > 0 ||
        b.alarm > 0 ||
        a.retire !== RETIRE_NONE ||
        b.retire !== RETIRE_NONE;

      chat.left -= dt;
      if (broken || chat.left <= 0) {
        this.endConversation(chat);
        this.chats.splice(i, 1);
        continue;
      }

      // Turn to each other. `heading` is the direction the model FACES, which
      // is -(sin, cos), so this is the same form the walk uses.
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      if (dx * dx + dz * dz > 1e-4) {
        a.heading = Math.atan2(-dx, -dz);
        b.heading = Math.atan2(dx, dz);
      }

      chat.turn -= dt;
      if (chat.turn <= 0) {
        chat.turn = this.rng.range(CHAT_TURN_MIN, CHAT_TURN_MAX);
        chat.side = chat.side === 0 ? 1 : 0;
        chat.line += 1;
      }
    }
  }

  /** Releases both members of a conversation back into the crowd. */
  private endConversation(chat: Conversation): void {
    for (const member of [chat.a, chat.b]) {
      if (member.chat !== chat.id) continue;
      member.chat = 0;
      member.chatCooldown = CHAT_COOLDOWN;
      if (member.state === 'pause') {
        member.state = 'walk';
        member.timer = 0;
      }
    }
  }

  /**
   * Moves one pedestrian's dissolve toward where it should be, and finishes a
   * retirement when it reaches zero.
   *
   * Returns false when the slot has just been given up, which tells the caller
   * to stop working on it this frame.
   */
  private advanceFade(ped: Pedestrian, dt: number, ctx: CrowdContext): boolean {
    const rate = dt / FADE_TIME;
    if (ped.retire === RETIRE_NONE) {
      if (ped.fade < 1) ped.fade = Math.min(1, ped.fade + rate);
      return true;
    }
    ped.fade -= rate;
    if (ped.fade > 0) return true;
    ped.fade = 0;
    const recycle = ped.retire === RETIRE_RECYCLE;
    ped.retire = RETIRE_NONE;
    ped.active = false;
    if (recycle) this.respawn(ped, ctx.x, ctx.z);
    return false;
  }

  // -- being knocked down ---------------------------------------------------

  /**
   * Lies a pedestrian down and throws them along `dir`.
   *
   * One code path for both ways of ending up on the pavement - hit by a car and
   * shot - so a body behaves the same however it got there and there is only
   * one state for the rest of the simulation to understand. A shot civilian
   * arrives here through `PedestrianSystem.downAt`, which is the hook
   * `CrowdTargets` has been waiting for.
   */
  /**
   * Puts somebody on the ground, thrown the way the blow came from.
   *
   * `again` re-throws a body that is ALREADY down, which only a blast does: a
   * civilian an explosion killed is removed through `downAt` first, so by the
   * time the shockwave reaches them they are lying still, and without this
   * they collapse like a bullet victim in the middle of a fireball. Nothing
   * else may use it - a second bullet must not re-topple a corpse.
   */
  knockDown(
    ped: Pedestrian,
    dirX: number,
    dirZ: number,
    speed: number,
    fatal: boolean,
    again = false,
  ): void {
    if (!ped.active) return;
    if (ped.state === 'down' && !again) return;
    // A body already on the ground keeps whatever killed it; a blast only
    // moves it.
    if (ped.state === 'down') {
      const thrownAgain = Math.min(THROW_MAX, speed * THROW_SHARE);
      ped.vx = dirX * thrownAgain;
      ped.vz = dirZ * thrownAgain;
      return;
    }
    ped.state = 'down';
    ped.downFor = 0;
    ped.fatal = fatal;
    ped.timer = 0;
    ped.stall = 0;
    ped.stallTries = 0;
    ped.dodge = 0;
    ped.gait = 0;
    ped.next = -1;
    // Topple away from wherever the blow came from: shoved the way they were
    // already facing goes onto the face, shoved against it goes over backwards.
    // `heading` is the direction the model FACES, which is -(sin, cos).
    const facingX = -Math.sin(ped.heading);
    const facingZ = -Math.cos(ped.heading);
    ped.fallSign = dirX * facingX + dirZ * facingZ > 0 ? -1 : 1;
    const thrown = Math.min(THROW_MAX, speed * THROW_SHARE);
    ped.vx = dirX * thrown;
    ped.vz = dirZ * thrown;
    ped.speed = thrown;
  }

  /**
   * A body on the ground: slide to a stop, count the seconds, get up or don't.
   *
   * Deliberately NOT routed through `step`. A body has no route, no steering
   * target and no opinion about crossings, and putting it through the walking
   * model would have it inch toward a kerb while lying on its back.
   */
  private stepDown(ped: Pedestrian, dt: number, distance: number): void {
    ped.downFor += dt;

    if (ped.speed > 1e-3) {
      const drag = Math.max(0, 1 - THROW_DRAG * dt);
      ped.vx *= drag;
      ped.vz *= drag;
      ped.speed = Math.hypot(ped.vx, ped.vz);
      if (ped.speed < 0.05) {
        ped.vx = 0;
        ped.vz = 0;
        ped.speed = 0;
      }
      ped.x += ped.vx * dt;
      ped.z += ped.vz * dt;
      // Still bound by the pavement corridor: being run over is not a licence
      // to slide through a wall. `project` owns where they end up, as ever.
      const link = this.graph.links[ped.link];
      if (link) this.project(ped, link);
    }

    // The ground under a body, sampled at the cheap rate a stationary thing
    // deserves. A fall on a kerb should not leave anybody hovering.
    ped.groundAge += dt;
    if (ped.groundAge >= 0.35) {
      ped.groundAge = 0;
      ped.y = this.ground.sample(ped.x, ped.z).y;
    }

    if (ped.fatal) {
      /*
       * A casualty is scenery, and the rules for taking it away are all three
       * of these at once:
       *
       *   - TIME. `CASUALTY_TIME` seconds, shortened to
       *     `CASUALTY_TIME_CROWDED` once the street already holds
       *     `CASUALTY_LIMIT` bodies, because every body holds a pool slot out
       *     of circulation and an unbounded count would empty the city.
       *   - DISTANCE. `CASUALTY_CLEAR` metres, so a body is only ever removed
       *     from a part of the street the player has already left.
       *   - AND IT STILL DOES NOT VANISH. It is flagged for recycling and
       *     dissolves over `FADE_TIME` first; `advanceFade` puts somebody new
       *     in the slot when the fade completes.
       */
      const dwell =
        this.stats.casualties > CASUALTY_LIMIT ? CASUALTY_TIME_CROWDED : CASUALTY_TIME;
      if (ped.retire === RETIRE_NONE && ped.downFor > dwell && distance > CASUALTY_CLEAR) {
        ped.retire = RETIRE_RECYCLE;
      }
      return;
    }
    if (ped.downFor >= FALL_TIME + DOWN_TIME + RISE_TIME) {
      ped.state = 'walk';
      ped.downFor = 0;
      ped.timer = 0;
      ped.stall = 0;
      ped.stallTries = 0;
      ped.anchorX = ped.x;
      ped.anchorZ = ped.z;
      ped.gait = 0;
      // Whatever they were heading for is long gone; pick the route afresh.
      ped.next = -1;
      const link = this.graph.links[ped.link];
      if (link) ped.lateralTarget = this.preferredLateral(link, ped.look);
    }
  }

  /**
   * Runs every vehicle over anybody it is actually touching.
   *
   * A REAL COLLISION, NOT PROXIMITY. `vehicleOverlap` is the chassis box grown
   * by a shoulder and six centimetres, so nothing here fires for driving past a
   * bus queue - which matters, because a caller wires this to the player's
   * wanted level and a false star is worse than no feature at all. A vehicle
   * that is barely moving cannot knock anybody over either.
   *
   * Broad phase is the crowd's own hash grid, walked over the cells the chassis
   * covers, and only for vehicles near enough to the viewer to be simulated
   * properly. Measured cost is in `docs/crowd-corners-and-knockdowns.md`.
   */
  private strike(ctx: CrowdContext): void {
    const vehicles = ctx.vehicles;
    if (!vehicles || vehicles.length === 0) return;
    // Which vehicle is the player in? Whichever one is sitting on the viewer:
    // while somebody is driving, the position handed to `update` IS their car.
    // Only consulted when no vehicle declares itself, so a caller that sets
    // `player` is always believed instead.
    let declared = false;
    for (const vehicle of vehicles) if (vehicle?.player) declared = true;
    let viewer = -1;
    if (!declared) {
      let best = PLAYER_CAR_RADIUS * PLAYER_CAR_RADIUS;
      for (let v = 0; v < vehicles.length; v += 1) {
        const vehicle = vehicles[v];
        if (!vehicle) continue;
        const d = (vehicle.x - ctx.x) ** 2 + (vehicle.z - ctx.z) ** 2;
        if (d < best) {
          best = d;
          viewer = v;
        }
      }
    }

    for (let v = 0; v < vehicles.length; v += 1) {
      const vehicle = vehicles[v];
      if (!vehicle) continue;
      if (!(this.trafficStrikes || vehicle.player === true || v === viewer)) continue;
      const vx = vehicle.vx ?? 0;
      const vz = vehicle.vz ?? 0;
      const speed = Math.hypot(vx, vz);
      if (speed < KNOCKDOWN_SPEED) continue;
      // Nobody is simulated past the recycle radius, so nothing out there can
      // be hit; skipping those vehicles is most of the saving.
      if (Math.hypot(vehicle.x - ctx.x, vehicle.z - ctx.z) > RECYCLE_RADIUS) continue;

      const reach = (vehicle.halfLength ?? 2.3) + PED_RADIUS + STRIKE_MARGIN;
      const span = Math.ceil(reach / CELL);
      const cx = Math.floor(vehicle.x / CELL);
      const cz = Math.floor(vehicle.z / CELL);
      for (let i = -span; i <= span; i += 1) {
        for (let j = -span; j <= span; j += 1) {
          let other = this.cellHead[hashCell(cx + i, cz + j)] ?? -1;
          while (other >= 0) {
            const next = this.cellNext[other] ?? -1;
            const ped = this.peds[other];
            if (
              ped &&
              ped.active &&
              ped.state !== 'down' &&
              vehicleOverlap(vehicle, ped.x, ped.z, PED_RADIUS + STRIKE_MARGIN)
            ) {
              const fatal = speed >= FATAL_SPEED;
              const hitX = ped.x;
              const hitZ = ped.z;
              this.knockDown(ped, vx / speed, vz / speed, speed, fatal);
              this.stats.struck += 1;
              this.onImpact?.({
                vehicle,
                index: v,
                x: hitX,
                y: ped.y,
                z: hitZ,
                speed,
                dirX: vx / speed,
                dirZ: vz / speed,
                fatal,
              });
            }
            other = next;
          }
        }
      }
    }
  }

  /**
   * Puts down whoever is standing nearest a point, and reports whether anybody
   * was. `PedestrianSystem.downAt` is the public face of this; it exists so a
   * shot civilian goes down exactly the way a struck one does.
   */
  downNearest(
    x: number,
    z: number,
    radius: number,
    fatal: boolean,
    dirX?: number,
    dirZ?: number,
  ): boolean {
    let best: Pedestrian | null = null;
    let bestDistance = radius * radius;
    const span = Math.ceil(radius / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let i = -span; i <= span; i += 1) {
      for (let j = -span; j <= span; j += 1) {
        let other = this.cellHead[hashCell(cx + i, cz + j)] ?? -1;
        while (other >= 0) {
          const next = this.cellNext[other] ?? -1;
          const ped = this.peds[other];
          if (ped && ped.active && ped.state !== 'down') {
            const d = (ped.x - x) * (ped.x - x) + (ped.z - z) * (ped.z - z);
            if (d < bestDistance) {
              bestDistance = d;
              best = ped;
            }
          }
          other = next;
        }
      }
    }
    if (!best) return false;
    /*
     * Dropped where they stand: a bullet carries no useful shove at this
     * scale, so the direction only decides which WAY they topple - forwards
     * onto the face if it came from behind, backwards if it came from in
     * front. `knockDown` works that out from the blow against their facing.
     *
     * The caller supplies the shot's direction of travel when it knows it.
     * Falling back to the victim's own heading means everybody folds forwards,
     * which is what this did before the shot direction was plumbed through and
     * reads as a single canned animation the moment two people go down.
     */
    const known = dirX !== undefined && dirZ !== undefined;
    const length = known ? Math.hypot(dirX, dirZ) : 0;
    const bx = length > 1e-4 ? (dirX as number) / length : -Math.sin(best.heading);
    const bz = length > 1e-4 ? (dirZ as number) / length : -Math.cos(best.heading);
    this.knockDown(best, bx, bz, 0, fatal);
    return true;
  }

  // -- gunfire: casualties and the alarm -------------------------------------

  /**
   * The named, explicit way for the combat layer to put a civilian down.
   *
   * `downNearest` and `PedestrianSystem.downAt` keep working exactly as they
   * did - this is an ADDITION, not a replacement - but they can only ever say
   * "kill whoever is nearest", and a combat layer needs two more things:
   *
   *   - to distinguish a LETHAL hit from a wounding one. `lethal: false`
   *     produces the same topple with the vehicle knock-down's recovery, so a
   *     round that did not kill anybody leaves somebody who gets back up;
   *     `lethal: true` (the default) sets `fatal`, and a `fatal` body never
   *     rises. Bodies are bounded by `CASUALTY_LIMIT` and cleared under the
   *     rules documented at `CASUALTY_TIME`.
   *   - to make the street REACT. A shot that drops one person and leaves the
   *     other eleven strolling past reads as nothing having happened, so this
   *     raises an `alarmAt` at the same point unless the caller turns it off.
   *
   * Returns false when nobody was within `radius` - the pool slot may have been
   * recycled between the shot landing and this call.
   */
  casualtyAt(x: number, z: number, options: CasualtyOptions = {}): boolean {
    const radius = options.radius ?? 1;
    const lethal = options.lethal ?? true;
    if (options.alarm !== false) this.alarmAt(x, z);
    if (lethal || options.floor === true) {
      return this.downNearest(x, z, radius, lethal, options.dirX, options.dirZ);
    }
    return this.staggerAt(x, z, radius, options.dirX, options.dirZ);
  }

  /**
   * Makes whoever is nearest a point flinch, without taking them off their
   * feet. Returns whether anybody was close enough.
   *
   * The visible reaction is three things at once, and none of them needs a new
   * clip or a new draw call:
   *
   *   - a LEAN, folded into the same instance matrix that already carries the
   *     heading and the build, away from wherever the round came from. See
   *     `Crowd.tilt`, which the renderer already calls for a topple.
   *   - a STUMBLE along the round's line of travel, applied as displacement so
   *     the steering speed cap cannot erase it, and still clamped into the
   *     pavement corridor like every other movement.
   *   - a BREAK OF STRIDE, deepest at the moment of the hit.
   *
   * They are left alarmed afterwards, so the flinch turns into a run rather
   * than into somebody strolling on as if nothing had happened. Somebody
   * already on the ground is not staggered: a corpse has no stride to break.
   */
  staggerAt(x: number, z: number, radius = 1, dirX?: number, dirZ?: number): boolean {
    let best: Pedestrian | null = null;
    let bestDistance = radius * radius;
    for (const ped of this.peds) {
      if (!ped.active || ped.state === 'down') continue;
      const d = (ped.x - x) * (ped.x - x) + (ped.z - z) * (ped.z - z);
      if (d < bestDistance) {
        bestDistance = d;
        best = ped;
      }
    }
    if (!best) return false;

    // The round's own direction where the caller knows it, and the victim's
    // facing otherwise - which shoves them forward, the same fallback
    // `downNearest` uses and for the same reason.
    const known = dirX !== undefined && dirZ !== undefined;
    const length = known ? Math.hypot(dirX as number, dirZ as number) : 0;
    const bx = length > 1e-4 ? (dirX as number) / length : -Math.sin(best.heading);
    const bz = length > 1e-4 ? (dirZ as number) / length : -Math.cos(best.heading);

    best.stagger = STAGGER_TIME;
    best.staggerX = bx;
    best.staggerZ = bz;
    // Lean AWAY from the blow, exactly as `knockDown` topples away from it.
    const facingX = -Math.sin(best.heading);
    const facingZ = -Math.cos(best.heading);
    best.fallSign = bx * facingX + bz * facingZ > 0 ? -1 : 1;
    // A person who has just been shot at does not stop to look at a shop
    // window, and the alarm is what turns the flinch into a run.
    if (best.state === 'pause' || best.state === 'wait') best.state = 'walk';
    best.alarm = Math.max(best.alarm, ALARM_TIME);
    best.alarmX = x;
    best.alarmZ = z;
    return true;
  }

  /**
   * Tells the crowd a gun went off here.
   *
   * Everybody inside `radius` is frightened for `ALARM_TIME` seconds: they
   * stop dawdling, they hurry, and `chooseNext` starts preferring whichever
   * continuation takes them AWAY from the point. The reaction is stamped onto
   * each person once, here, rather than tested per frame against a list of
   * alarms, so a firefight costs one grid sweep per shot and nothing at all in
   * between.
   *
   * The alarm is also remembered in a bounded ring so a caller can ask what the
   * crowd currently believes; `ALARM_SLOTS` bounds it because a player emptying
   * a magazine raises one per round.
   *
   * Returns how many people heard it.
   */
  alarmAt(x: number, z: number, radius = ALARM_RADIUS, seconds = ALARM_TIME): number {
    if (!(radius > 0)) return 0;
    const record = { x, z, radius, at: this.alarmClock };
    if (this.alarms.length < ALARM_SLOTS) this.alarms.push(record);
    else {
      this.alarms[this.alarmCursor] = record;
      this.alarmCursor = (this.alarmCursor + 1) % ALARM_SLOTS;
    }

    /*
     * A straight pass over the pool rather than a walk of the hash grid.
     *
     * The alarm radius is 26 m against a 2.4 m cell, which is 529 bucket
     * lookups - more work than the 270 distance tests this does, and WRONG as
     * well: `hashCell` folds the world into 4096 buckets, so two of those 529
     * cells can share one, and the people in it would be counted twice. That
     * does not matter for `blastAt`, whose count is a diagnostic; it matters
     * here, because the return value tells a caller how many people heard.
     */
    let heard = 0;
    const radiusSquared = radius * radius;
    for (const ped of this.peds) {
      // A body on the ground has nothing to run from any more.
      if (!ped.active || ped.state === 'down') continue;
      const dx = ped.x - x;
      const dz = ped.z - z;
      if (dx * dx + dz * dz > radiusSquared) continue;
      ped.alarm = Math.max(ped.alarm, seconds);
      ped.alarmX = x;
      ped.alarmZ = z;
      // A frightened person does not stand at a kerb reading a sign.
      if (ped.state === 'pause' || ped.state === 'wait') ped.state = 'walk';
      // Re-pick the route now that "away from there" is a preference.
      ped.next = -1;
      /*
       * AND TURN ROUND IF THEY WERE WALKING INTO IT.
       *
       * `chooseNext` can only steer somebody away at the END of the link they
       * are on, and this city's links run twenty metres and more - so without
       * this, half a frightened crowd walks calmly toward the gunfire for
       * fifteen seconds before turning. Measured over six seconds after a
       * shot, the share of people who had increased their distance from it
       * went from 0.46 to well over two thirds with this in.
       *
       * Never off a crossing: the reverse of a crossing is the same strip of
       * carriageway, and taking it here would skip the signal check. Somebody
       * caught halfway across a road is safer finishing it, which is the same
       * rule `watchStall` keeps.
       */
      const link = this.graph.links[ped.link];
      if (link && !link.crossing && link.reverse >= 0 && this.closed[link.reverse] !== 1) {
        const back = this.graph.links[link.reverse];
        const d = Math.hypot(dx, dz);
        if (back && !back.crossing && d > 1e-3 && (-dx * link.dx - dz * link.dz) / d > 0.25) {
          ped.next = link.reverse;
          this.commit(ped);
        }
      }
      heard += 1;
    }
    return heard;
  }

  /** Gunfire the crowd currently remembers, oldest first. Bounded and read-only. */
  get recentAlarms(): readonly { readonly x: number; readonly z: number; readonly radius: number }[] {
    return this.alarms;
  }

  /**
   * Knocks everybody inside a radius flat, away from the seat of a blast.
   *
   * Unlike `downNearest` this is not about who was hit - the damage has
   * already been decided by whoever called it - it is about what the street
   * LOOKS like a second later. Everyone goes down, thrown outwards, and the
   * throw is hardest at the centre; a blast that killed four people and left
   * everyone else strolling past it reads as nothing having happened.
   *
   * Only the innermost `lethalShare` of the radius is fatal, so somebody at
   * the edge gets up again. Returns how many people it moved.
   */
  blastAt(x: number, z: number, radius: number, lethalShare = 0.55): number {
    if (radius <= 0) return 0;
    let count = 0;
    const span = Math.ceil(radius / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const radiusSquared = radius * radius;
    for (let i = -span; i <= span; i += 1) {
      for (let j = -span; j <= span; j += 1) {
        let other = this.cellHead[hashCell(cx + i, cz + j)] ?? -1;
        while (other >= 0) {
          const next = this.cellNext[other] ?? -1;
          const ped = this.peds[other];
          // Deliberately NOT skipping the down: see `knockDown`'s `again`.
          if (ped && ped.active) {
            const dx = ped.x - x;
            const dz = ped.z - z;
            const d2 = dx * dx + dz * dz;
            if (d2 <= radiusSquared) {
              const distance = Math.sqrt(d2);
              const share = distance / radius;
              // Somebody standing exactly on it has no outward direction of
              // their own; throw them the way they were already facing.
              const length = distance > 0.05 ? distance : 1;
              const dirX = distance > 0.05 ? dx / length : -Math.sin(ped.heading);
              const dirZ = distance > 0.05 ? dz / length : -Math.cos(ped.heading);
              this.knockDown(ped, dirX, dirZ, 5 + (1 - share) * 9, share <= lethalShare, true);
              count += 1;
            }
          }
          other = next;
        }
      }
    }
    return count;
  }

  private advancePhase(ped: Pedestrian, dt: number): void {
    const look = ped.look;
    // `gaitCadence` is shared with the renderer so the stride the shader draws
    // is the stride the pedestrian is actually covering.
    const cadence = gaitCadence(ped.speed, look.preferredSpeed, look.cadence, look.height);
    ped.cadenceNow = cadence;
    // Never freeze completely: a standing figure still breathes and shifts its
    // weight, and the amplitude is what makes it a stand rather than a walk.
    ped.phase = (ped.phase + cadence * dt * Math.max(ped.gait, 0.14)) % 1;
    if (ped.phase < 0) ped.phase += 1;
  }

  private step(ped: Pedestrian, index: number, dt: number, ctx: CrowdContext): void {
    const entry = this.graph.links[ped.link];
    if (!entry) {
      this.respawn(ped, ctx.x, ctx.z);
      return;
    }

    this.decide(ped, entry, dt, ctx);

    // `decide` may have handed the pedestrian to the next link. Everything
    // below - the target, the kerb slide, the projection - has to be about the
    // link they are on NOW. Reusing the entry link here meant a pedestrian who
    // had just turned a corner was steered and then re-projected onto the
    // corridor they had left, which pinned them at a negative distance along
    // their new link and stalled them until the watchdog turned them round.
    const link = this.graph.links[ped.link];
    if (!link) {
      this.respawn(ped, ctx.x, ctx.z);
      return;
    }

    const stopped = ped.state === 'wait' || ped.state === 'pause';
    const goalAlong = stopped ? ped.waitAlong : ped.along + this.lookahead(ped);

    ped.dodge = Math.max(0, ped.dodge - dt);
    ped.crossCooldown = Math.max(0, ped.crossCooldown - dt);
    if (ped.chat === 0) ped.chatCooldown = Math.max(0, ped.chatCooldown - dt);
    ped.alarm = Math.max(0, ped.alarm - dt);
    const staggerBefore = ped.stagger;
    ped.stagger = Math.max(0, ped.stagger - dt);

    let targetX: number;
    let targetZ: number;
    // Aiming past the corner is right for a clear corner and wrong for a
    // blocked one: it throws away the lateral preference, which is the only
    // thing that can carry a walker round a prop parked in the gap. So anyone
    // who is currently squeezing past something finishes THIS link first.
    if (!stopped && goalAlong > link.length && ped.dodge <= 0) {
      // Aim just past the corner, on the next link's CENTRELINE.
      //
      // Two links meeting at a right angle swap axes: the next link's lateral
      // direction is the current link's direction of travel. Carrying a
      // lateral preference through the corner therefore places the target up
      // to a pavement half width BEHIND the pedestrian, and they walk backwards
      // into the corner instead of round it. Aiming at the centreline a little
      // way past the corner always leaves a forward component.
      const next = this.graph.links[ped.next];
      if (next) {
        const over = clamp(goalAlong - link.length, 0.6, next.length);
        linkPoint(next, over, 0, this.scratch);
      } else {
        linkPoint(link, link.length, ped.lateralTarget, this.scratch);
      }
      targetX = this.scratch.x;
      targetZ = this.scratch.z;

      // ...but only when that point is genuinely IN FRONT.
      //
      // Nothing in the graph promises a continuation leads onward. A pavement
      // chain resumes on the far kerb of the crossing that reaches it, running
      // straight back the way the walker came: `x:j:cannery-row:grand-concourse:w`
      // ends at (-82.10, -75.50) heading (0, -1) and its legal successor
      // `p:cannery-row:-1:3` leaves the same node heading (0, +1). Aiming
      // `over` metres along THAT put the target within a centimetre of a walker
      // standing 0.65 m short of the kerb - and, being a target rather than a
      // stop, it was chased at full walking speed. The walker overshot it, the
      // direction flipped, and they oscillated a centimetre either side of one
      // spot for ever: `along` never reached `link.length - 0.05`, so `decide`
      // never handed them on, and `watchStall` may not U-turn a body off a
      // crossing. Measured over four minutes with 270 people: nine were locked
      // in that cycle for more than thirty seconds and one for two minutes,
      // every one of them standing in a carriageway.
      //
      // The corner itself is the honest fallback. It is `link.length - along`
      // metres ahead by construction, so progress along the link is guaranteed.
      if ((targetX - ped.x) * link.dx + (targetZ - ped.z) * link.dz < MIN_CORNER_AHEAD) {
        linkPoint(link, link.length, 0, this.scratch);
        targetX = this.scratch.x;
        targetZ = this.scratch.z;
      }
    } else {
      linkPoint(link, Math.min(goalAlong, link.length), ped.lateralTarget, this.scratch);
      targetX = this.scratch.x;
      targetZ = this.scratch.z;
    }

    let dx = targetX - ped.x;
    let dz = targetZ - ped.z;
    const distance = Math.hypot(dx, dz);
    // A stopped pedestrian is speed-limited by how far they still have to go,
    // so a short vector is safe for them. A walking one is not: they are driven
    // at their full preferred speed whatever the distance, so anything shorter
    // than a step has to give way to the link's own direction or they oscillate.
    if (distance > (stopped ? 1e-4 : MIN_TARGET_DISTANCE)) {
      dx /= distance;
      dz /= distance;
    } else {
      dx = link.dx;
      dz = link.dz;
    }

    let desired = stopped ? Math.min(0.45, distance * 1.6) : this.desiredSpeed(ped, link);
    let steerX = dx * desired;
    let steerZ = dz * desired;

    if (ped.lod <= 1) {
      const brake = this.avoid(ped, index, dx, dz);
      steerX += this.push.x;
      steerZ += this.push.z;
      desired *= brake;
    }

    // A vehicle is the one influence allowed to stop somebody dead, and it says
    // so by returning exactly zero. Anything else it returns is a brake, and a
    // brake has to stay above the shuffling floor below.
    let frozen = false;
    if (ped.lod === 0 || ped.state === 'cross') {
      const vehicleBrake = this.avoidVehicles(ped, dx, dz, ctx);
      desired *= vehicleBrake;
      frozen = vehicleBrake <= 0;
    }

    // A shuffling floor. Without it a jam is absorbing: everyone reaches zero,
    // the avoidance terms that depend on motion vanish, and the knot never
    // unties. Only a vehicle bearing down or a deliberate wait may stop anyone.
    //
    // THE FLOOR HAS TO BE THE LAST WORD. It used to be applied inside the
    // neighbour block above, where the vehicle factor could then multiply it
    // away: a pedestrian on a pavement beside a car queued at a red light was
    // held at a tenth of a metre a second for as long as the queue lasted,
    // because `avoidVehicles` measures from the chassis CENTRE and its
    // clearance of nearly three metres reaches the far kerb of this city's
    // narrower streets. Measured at one corner: 0.19 m travelled in 12 s.
    if (!stopped && !frozen) desired = Math.max(desired, 0.22);

    /*
     * A flinch costs them their pace. Deepest at the moment of the hit and
     * gone by the end of the reaction, so a person who has been shot at breaks
     * stride and then runs rather than stopping dead - stopping is what a body
     * does, and this one is still standing.
     */
    if (staggerBefore > 0) {
      desired *= 1 - STAGGER_BRAKE * (staggerBefore / STAGGER_TIME);
    }

    // Somebody who has just heard a gun is allowed to run, which needs a
    // higher ceiling than the everyday one. Still a multiple of their own
    // comfortable pace, so a slow walker runs slowly.
    const maxSpeed = ped.look.preferredSpeed * (ped.alarm > 0 ? PANIC_MAX : 1.75);
    const steerLength = Math.hypot(steerX, steerZ);
    if (steerLength > maxSpeed) {
      steerX = (steerX / steerLength) * maxSpeed;
      steerZ = (steerZ / steerLength) * maxSpeed;
    }

    // Damped velocity rather than a direct set: an agent that snaps to its
    // steering output shivers whenever two influences disagree by a degree.
    ped.vx = damp(ped.vx, steerX, 7, dt);
    ped.vz = damp(ped.vz, steerZ, 7, dt);

    const speed = Math.hypot(ped.vx, ped.vz);
    const cap = Math.max(0, desired);
    if (speed > cap && speed > 1e-5) {
      ped.vx = (ped.vx / speed) * cap;
      ped.vz = (ped.vz / speed) * cap;
    }
    // Slide along the kerb rather than press into it.
    //
    // Without this a pedestrian aiming round a corner points straight at the
    // pavement opposite, the lateral clamp cancels the whole step, and they
    // stand there at full walking speed making no headway for ever. Measured
    // before the fix: 72 of 270 had travelled under 0.6 m in twenty seconds.
    const intoWall = ped.vx * link.nx + ped.vz * link.nz;
    if (
      (ped.lateral >= link.halfWidth - 1e-4 && intoWall > 0) ||
      (ped.lateral <= -link.halfWidth + 1e-4 && intoWall < 0)
    ) {
      ped.vx -= intoWall * link.nx;
      ped.vz -= intoWall * link.nz;
    }

    ped.speed = Math.hypot(ped.vx, ped.vz);
    ped.gait = damp(ped.gait, ped.speed > 0.16 ? 1 : 0, 6, dt);

    ped.x += ped.vx * dt;
    ped.z += ped.vz * dt;

    /*
     * The stumble, applied as DISPLACEMENT rather than as velocity.
     *
     * A velocity impulse would be clamped away on the very next line by the
     * speed cap - which is right for steering and wrong for a shove - and
     * would then be damped out over a seventh of a second. Moving the body
     * directly puts the stumble on the screen, and `project` below still owns
     * where they end up, so a shove cannot push anybody off a kerb.
     */
    if (staggerBefore > 0) {
      const push = STAGGER_SHOVE * (staggerBefore / STAGGER_TIME) * dt;
      ped.x += ped.staggerX * push;
      ped.z += ped.staggerZ * push;
    }

    if (ped.lod === 0) {
      // Street furniture is a hard constraint, not a suggestion.
      if (this.obstacles.resolve(ped.x, ped.z, PED_RADIUS + 0.14, this.push)) {
        ped.x += this.push.x;
        ped.z += this.push.z;
        // Same slide, against the lamp post rather than the kerb.
        //
        // ONLY FOR A CONTACT THAT IS ACTUALLY IN THE WAY. `resolve` reports a
        // hit for any overlap at all, including the grazing one where the disc
        // touches the box and the correction is a fraction of a millimetre.
        // Treating that as a blockage is self-sustaining: the slide cancels
        // exactly the velocity that would have carried the walker into the
        // prop, so they never penetrate, so the push stays at zero, so the
        // slide runs again - and `dodge`, refreshed on the same branch, holds
        // off the corner hand-off for as long as it lasts. Traced at the
        // vestry-street corner: `resolve` true with a push of (0.00, 0.00) for
        // hundreds of consecutive frames while the walker ground along at
        // 0.1 m/s. Below a centimetre there is nothing to walk around; let
        // them press on and take the real push next frame if there is one.
        const length = Math.hypot(this.push.x, this.push.z);
        if (length > CONTACT_PUSH) {
          const into = (ped.vx * this.push.x + ped.vz * this.push.z) / length;
          if (into < 0) {
            ped.vx -= (into * this.push.x) / length;
            ped.vz -= (into * this.push.z) / length;
          }
          // Sliding alone is not an escape route.
          //
          // A prop square across the line of travel leaves nothing after the
          // slide: the whole velocity IS the into-component, cancelling it
          // leaves zero, and the walker stands against the thing at full
          // walking speed making no headway. The stall watchdog's mirror flip
          // of the lateral preference does not help either, because a prop over
          // the middle of a corridor blocks both mirrored offsets equally.
          //
          // So go and look for the gap. `clearLateralAhead` is the smallest
          // change of course that clears whatever is in the way; steering to it
          // covers the walk, and a nudge of real velocity toward it covers the
          // frame, so the decision shows before the next steering step.
          const clear = this.clearLateralAhead(ped, link);
          ped.lateralTarget = clear;
          const side = Math.sign(clear - ped.lateral);
          if (side !== 0) {
            ped.dodge = DODGE_TIME;
            ped.vx += side * link.nx * SIDESTEP;
            ped.vz += side * link.nz * SIDESTEP;
          }
        }
      }
    }

    this.project(ped, link);
    this.watchStall(ped, link, dt);

    if (ped.speed > 0.14) {
      ped.heading = dampAngle(ped.heading, Math.atan2(-ped.vx, -ped.vz), 8, dt);
    }

    ped.groundAge += dt;
    const groundEvery = ped.lod === 0 ? 0 : ped.lod === 1 ? 0.2 : 0.7;
    if (ped.groundAge >= groundEvery) {
      ped.groundAge = 0;
      const sample = this.ground.sample(ped.x, ped.z);
      // Snap when close, ease when the pavement steps: a kerb is 0.15 m and a
      // person should rise over it, not pop.
      ped.y = Math.abs(sample.y - ped.y) > 0.4 ? sample.y : damp(ped.y, sample.y, 14, dt);
    }
  }

  /**
   * The offset a little way ahead, nearest to where the walker already is, that
   * street furniture is not standing in.
   *
   * Searched outward from their own offset so the answer is the smallest change
   * of course that clears the obstruction, and stepped at 0.12 m because the
   * tightest gap this city's scatter leaves on a route is 0.20 m wide. Returns
   * the walker's current offset when nothing is clear, which leaves the stall
   * watchdog to deal with it.
   *
   * Only ever called for a LOD 0 agent that is actually touching something, so
   * the probe cost - at most a few dozen grid lookups - is paid by a handful of
   * agents a frame rather than by the crowd.
   */
  private clearLateralAhead(ped: Pedestrian, link: PavementLink): number {
    const width = link.halfWidth;
    const ahead = Math.min(link.length, ped.along + 0.6);
    const radius = PED_RADIUS + 0.14;
    const steps = Math.ceil((2 * width) / LATERAL_PROBE_STEP);
    for (let i = 1; i <= steps; i += 1) {
      for (let sign = 1; sign >= -1; sign -= 2) {
        const lateral = clamp(ped.lateral + sign * i * LATERAL_PROBE_STEP, -width, width);
        linkPoint(link, ahead, lateral, this.probe);
        if (!this.obstacles.resolve(this.probe.x, this.probe.z, radius, this.probePush)) {
          return lateral;
        }
      }
    }
    return ped.lateral;
  }

  /**
   * Notices a pedestrian who is not getting anywhere, and does something a
   * person would do about it.
   *
   * Measured on WORLD displacement over a window, not on progress along the
   * link. Along-progress alone counts someone crossing the width of a wide
   * pavement as stuck, and "fixing" that by flipping their preferred side sets
   * up an oscillation that is worse than the problem.
   *
   * A safety net rather than a mechanism. First try the other side of whatever
   * is in the way; if that fails twice, give up and walk back the way you came.
   * Neither is a teleport, so a player sees someone change their mind.
   */
  private watchStall(ped: Pedestrian, link: PavementLink, dt: number): void {
    if (ped.state !== 'walk' && ped.state !== 'cross') {
      ped.stall = 0;
      ped.anchorX = ped.x;
      ped.anchorZ = ped.z;
      return;
    }
    ped.stall += dt;
    if (ped.stall < 2.5) return;
    const moved = Math.hypot(ped.x - ped.anchorX, ped.z - ped.anchorZ);
    ped.stall = 0;
    ped.anchorX = ped.x;
    ped.anchorZ = ped.z;
    if (moved > 0.9) {
      ped.stallTries = 0;
      return;
    }
    ped.stallTries += 1;
    this.stats.detours += 1;
    if (ped.stallTries < 3) {
      const width = link.halfWidth;
      const flipped = ped.lateralTarget === 0 ? width * 0.6 : -ped.lateralTarget;
      ped.lateralTarget = clamp(flipped, -width, width);
      return;
    }
    ped.stallTries = 0;
    // Only turn round for a genuine blockage, not for a slow queue - and never
    // onto a crossing, because the reverse of a crossing is the same strip of
    // carriageway and taking it here would skip the signal check entirely.
    // Somebody stalled halfway across a road is safer finishing the crossing.
    const back = this.graph.links[link.reverse];
    if (moved < 0.35 && back && !back.crossing) {
      ped.next = link.reverse;
      ped.state = 'walk';
      this.commit(ped);
      return;
    }
    if (moved >= 0.35) return;

    // Still stuck, and nowhere legal to turn. Resetting `stallTries` and hoping
    // is what let a body stand in a carriageway for two minutes: the ladder has
    // to end in something that always works. Finishing the link is the one move
    // that is both legal anywhere - it is the direction they were already
    // walking, on the corridor they are already on - and productive, because
    // reaching `link.length` is exactly what hands them to the next link.
    // Capped at half a stride and at the distance remaining, so it reads as a
    // step rather than a teleport, and `project` still owns where they land.
    const room = Math.max(0, link.length - ped.along);
    const nudge = Math.min(STALL_NUDGE, room);
    if (nudge <= 0) return;
    ped.x += link.dx * nudge;
    ped.z += link.dz * nudge;
    // Re-pick the continuation: the one they had is the likeliest reason they
    // were not getting anywhere.
    ped.next = -1;
    this.project(ped, link);
  }

  /** How far ahead a pedestrian aims. Longer at speed, so turns anticipate. */
  private lookahead(ped: Pedestrian): number {
    return clamp(1.1 + ped.speed * 0.75, 1.1, 3.1);
  }

  private desiredSpeed(ped: Pedestrian, link: PavementLink): number {
    let speed = ped.look.preferredSpeed;
    // Nobody dawdles on a carriageway. `crossingClear` assumes exactly this
    // much hurry when it decides whether they can get across in time.
    if (link.crossing) speed *= CROSSING_HURRY;
    // ...and nobody dawdles anywhere at all having just heard a gunshot. This
    // is deliberately NOT applied to the crossing gate's own estimate: a
    // frightened person crossing faster than `crossingClear` assumed arrives
    // early, which is the safe direction to be wrong in.
    if (ped.alarm > 0) speed *= PANIC_HURRY;
    return speed;
  }

  /**
   * Projects the free-moving position back onto the pavement.
   *
   * Only the LATERAL clamp may move a pedestrian. `along` is bookkeeping: it
   * records progress and triggers the hand-over to the next link, and clamping
   * it used to be applied to the world position too. That was wrong at every
   * corner - two links meeting at a right angle turn one's lateral offset into
   * the other's along offset, so a pedestrian arriving at a corner enters the
   * next link with a NEGATIVE along of up to a full pavement half width, and
   * folding that back to zero teleported them up to 2.8 m sideways. The corner
   * apron they are standing on is real pavement, so the honest answer is to
   * leave them on it and let them walk out of it.
   */
  private project(ped: Pedestrian, link: PavementLink): void {
    const rx = ped.x - link.ax;
    const rz = ped.z - link.az;
    const along = rx * link.dx + rz * link.dz;
    let lateral = rx * link.nx + rz * link.nz;
    const limit = link.halfWidth;
    if (lateral > limit) lateral = limit;
    else if (lateral < -limit) lateral = -limit;
    else {
      ped.along = clamp(along, -3.4, link.length + 0.6);
      ped.lateral = lateral;
      return;
    }
    ped.along = clamp(along, -3.4, link.length + 0.6);
    ped.lateral = lateral;
    // Rebuild from the TRUE along, never the clamped one.
    ped.x = link.ax + link.dx * along + link.nx * lateral;
    ped.z = link.az + link.dz * along + link.nz * lateral;
  }

  // -- intent ---------------------------------------------------------------

  private decide(ped: Pedestrian, link: PavementLink, dt: number, ctx: CrowdContext): void {
    if (ped.state === 'pause') {
      // A conversation owns its members' pause; `updateConversations` ends it.
      if (ped.chat !== 0) return;
      ped.timer -= dt;
      if (ped.timer <= 0) ped.state = 'walk';
      return;
    }

    if (ped.state === 'cross' && ped.along >= link.length - 0.05) {
      ped.state = 'walk';
    }

    // Choose the continuation early enough to slow down for it.
    if (ped.next < 0 && ped.along > link.length - Math.max(3.5, ped.speed * 2.2)) {
      ped.next = this.chooseNext(link, ped.crossCooldown <= 0, ped);
    }

    if (ped.state === 'wait') {
      ped.timer += dt;
      const next = this.graph.links[ped.next];
      if (!next) {
        ped.state = 'walk';
        return;
      }
      if (this.crossingClear(next, ctx, ped.look.preferredSpeed)) {
        ped.state = 'cross';
        ped.timer = 0;
        this.commit(ped);
        return;
      }
      // Nobody waits at a kerb for ever. See `WAIT_PATIENCE`.
      if (ped.timer > WAIT_PATIENCE) {
        ped.state = 'walk';
        ped.timer = 0;
        // AND THEN WALK AWAY FROM IT. Excluding crossings from this one choice
        // is not enough: the corner stubs on this city's pavements are 0.9 to
        // 1.7 m long, so a walker who declines a crossing reaches the next
        // node a second later and is offered the same crossing again. Traced
        // at the harbour-walk corner: two agents cycling give-up, walk 1.6 m,
        // wait 26 s, give up, for forty seconds at a stretch.
        ped.crossCooldown = CROSS_COOLDOWN;
        ped.next = this.chooseNext(link, false, ped);
        ped.lateralTarget = this.preferredLateral(link, ped.look);
        this.stats.gaveUp += 1;
      }
      return;
    }

    if (ped.along < link.length - 0.05) {
      // A short stop to look at something. Only ever on a pavement, never in
      // the road, and never right at a kerb where it would block a crossing.
      if (
        ped.state === 'walk' &&
        !link.crossing &&
        // Nobody stops to look at a shop window inside a few seconds of a
        // gunshot. Suppressing the pause is most of what makes a street read
        // as having reacted at all.
        ped.alarm <= 0 &&
        ped.along > 3 &&
        ped.along < link.length - 6 &&
        this.rng.next() < ped.look.dwell * 0.0016 * dt * 60
      ) {
        ped.state = 'pause';
        ped.timer = this.rng.range(1.6, 6.5);
        ped.waitAlong = ped.along;
        // Somebody stopping next to somebody else who has also stopped is the
        // whole recruitment rule. Not everybody who could talk does, or every
        // pause on a busy pavement would turn into one.
        if (this.rng.next() < CHAT_TAKE_UP) this.formConversation(ped, ctx);
      }
      return;
    }

    const next =
      this.graph.links[
        ped.next < 0 ? (ped.next = this.chooseNext(link, ped.crossCooldown <= 0, ped)) : ped.next
      ];
    if (!next) {
      // Nowhere to go: turn around rather than stand in the way for ever.
      // A crossing is never a legal fallback; only the signalled path enters one.
      const back = this.graph.links[link.reverse];
      if (back && !back.crossing) {
        ped.next = link.reverse;
        this.commit(ped);
      }
      return;
    }

    if (next.crossing && !this.crossingClear(next, ctx, ped.look.preferredSpeed)) {
      ped.state = 'wait';
      ped.timer = 0;
      // Stand a little back from the kerb, and spread across it, so a group
      // waiting to cross does not queue single file in the way of the people
      // coming the other way off the crossing.
      ped.waitAlong = Math.max(0, link.length - this.rng.range(0.15, 1.8));
      ped.lateralTarget = this.rng.range(-link.halfWidth * 0.85, link.halfWidth * 0.85);
      return;
    }

    ped.state = next.crossing ? 'cross' : 'walk';
    this.commit(ped);
  }

  /** Moves a pedestrian onto `ped.next`, keeping their world position exact. */
  private commit(ped: Pedestrian): void {
    const next = this.graph.links[ped.next];
    if (!next) return;
    ped.link = ped.next;
    // The zone follows the link, because the corridor clamp guarantees the
    // person is inside it and the link's zone was settled at construction.
    ped.zone = this.linkZone[ped.link] ?? 0;
    ped.next = -1;
    ped.lateralTarget = this.preferredLateral(next, ped.look);
    this.project(ped, next);
  }

  /**
   * Picks the next link.
   *
   * Straight on is much the most likely; a U-turn is a last resort. Crossings
   * are picked far less often than the geometry alone would suggest, because a
   * crowd that crosses at every single opportunity spends its life in the road.
   *
   * `allowCrossing` is false for somebody who has just given up on a crossing:
   * offering them the same one again is how a give-up turns into a loop.
   *
   * `who`, when given, contributes two more preferences:
   *
   *   - AWAY FROM A GUNSHOT. A frightened pedestrian is far likelier to take
   *     the continuation that increases their distance from where the shot
   *     came from. A preference and not a rule, because a rule with no legal
   *     answer is how somebody ends up standing still - which is the last
   *     thing a person does when they hear a gun.
   *   - A ZONE THEY BELONG IN. Every route into a low-density zone is weighted
   *     by its `share`, so an airport forecourt hands people back toward the
   *     terminal rather than feeding them down the access road. Again a
   *     preference: an outright refusal would strand anybody who had already
   *     walked out there, and a forbidden zone is `closed` above instead.
   */
  private chooseNext(link: PavementLink, allowCrossing = true, who?: Pedestrian): number {
    const options = this.graph.linksFrom[link.to];
    if (!options || options.length === 0) return link.reverse;

    // The unit vector pointing away from whatever frightened them.
    let fleeX = 0;
    let fleeZ = 0;
    if (who && who.alarm > 0) {
      const dx = who.x - who.alarmX;
      const dz = who.z - who.alarmZ;
      const d = Math.hypot(dx, dz);
      if (d > 0.5) {
        fleeX = dx / d;
        fleeZ = dz / d;
      }
    }

    let bestIndex = -1;
    let bestScore = -1;
    for (const candidate of options) {
      const next = this.graph.links[candidate];
      if (!next) continue;
      // A corridor street furniture has closed - or one that reaches onto a
      // taxiway - is not a route. Offering one strands whoever takes it, and
      // on a crossing that means standing in a carriageway until the watchdog
      // notices.
      if (this.closed[candidate] === 1) continue;
      if (!allowCrossing && next.crossing) continue;
      const straight = next.dx * link.dx + next.dz * link.dz;
      let weight: number;
      if (candidate === link.reverse) weight = 0.02;
      else if (next.crossing) weight = link.crossing ? 0.005 : 0.24 + 0.26 * Math.max(0, straight);
      else if (straight > 0.9) weight = 5.5;
      else weight = 1.15;
      /*
       * The zone preference is the SQUARE ROOT of the share, not the share.
       * The share already governs how many people are put in a zone and where
       * they are spawned; applying it a second time at full strength here
       * would compound into a route nobody ever takes, which strands the far
       * end of the access road rather than merely thinning it.
       */
      const share = this.linkShare[candidate] ?? 1;
      if (share < 1) weight *= Math.sqrt(Math.max(0.02, share));
      if (fleeX !== 0 || fleeZ !== 0) {
        weight *= 1 + 2.4 * Math.max(0, next.dx * fleeX + next.dz * fleeZ);
      }
      // Reservoir-style weighted pick: one pass, no allocation.
      const score = this.rng.next() / weight;
      if (bestIndex < 0 || score < bestScore) {
        bestScore = score;
        bestIndex = candidate;
      }
    }
    return bestIndex >= 0 ? bestIndex : link.reverse;
  }

  /**
   * True when a pedestrian may step onto a crossing.
   *
   * Two conditions, both required: the shared signal says the traffic this
   * crossing cuts across is stopped, and no vehicle will be ON THE CROSSING
   * while we are. The second is what makes a red-light runner survivable.
   *
   * THE QUESTION HAS TO BE ABOUT THE CROSSING, NOT ABOUT A CIRCLE ROUND IT.
   * This used to veto whenever any vehicle's centre came within
   * `link.length / 2 + 2.4` of the crossing's centre - 11.15 m at a typical
   * junction here. That radius is larger than the junction, so it contains:
   * the queue stopped at the stop line, whose nose is parked 0.4 m short of
   * the crossing by construction (`TrafficSim`'s `stopAlong`); the traffic on
   * the cross street, which is confined to its own carriageway and can never
   * touch this strip at all; and anything merely passing nearby.
   *
   * The two conditions were therefore very nearly mutually exclusive, because
   * `walkSignal` is true PRECISELY WHEN the traffic on this carriageway is
   * stopped - which is when the queue that fills that circle exists. Measured
   * over three minutes with 240 vehicles and 270 people: of 118,098 frames in
   * which somebody stood at a kerb with the walk signal in their favour,
   * 117,809 were vetoed and 1 was clear. 51.6 per cent of those vetoes were a
   * STOPPED vehicle and 78.8 per cent were a vehicle nowhere near the strip;
   * a moving vehicle actually on the crossing accounted for 1.1 per cent.
   *
   * So the test is now the crossing's own rectangle - `link.length` kerb to
   * kerb by `2 * crossing.halfWidth` along the street - swept against each
   * vehicle's own box over the time we would be exposed. Two 1-D slab clips,
   * exact for a constant velocity, so no sampling interval can step over a
   * fast car.
   *
   * THE MARGIN HAS TO BE HONEST ABOUT THE STOP LINE. `TrafficSim` parks a
   * queue with its nose exactly 0.4 m short of the strip, so the whole question
   * of whether a waiting crowd ever gets to cross comes down to a few
   * centimetres. Inflating the vehicle isotropically by its circumradius - the
   * obvious conservative choice - adds a car's half LENGTH to the axis where
   * only 0.4 m exists, and puts every correctly stopped car back inside the
   * box; measured that way, 401 of 1,311 waits still ran to the full patience
   * timeout. So the vehicle is projected onto each axis as the oriented box it
   * is, and only a MOVING one gets a safety margin on top: a car that is not
   * moving cannot run anybody over, and the only thing it can do is physically
   * block the strip, which needs no margin at all to detect.
   */
  private crossingClear(link: PavementLink, ctx: CrowdContext, speed: number): boolean {
    const crossing = link.crossing;
    if (!crossing) return true;
    if (!walkSignal(this.network, crossing, ctx.time)) return false;

    // A "do not start what you cannot finish" gate was tried here and removed.
    // It is the obvious answer - the walk phase is 14.5 s and the widest
    // crossing in this city is 27 m, which a slow walker cannot clear inside
    // one phase however early they set off - but it is answering the wrong
    // question. Measured over ten minutes with 240 vehicles: refusing every
    // crossing somebody could not finish in time changed the number of people
    // struck by ambient traffic from 208 to 210 and more than doubled the
    // number left standing at a kerb (379 stalls over five seconds to 888,
    // give-ups 73 to 209). It prevents nothing because the collisions are not
    // caused by the lights changing: 20 per cent are traffic TURNING off the
    // cross street, which has a green at exactly the same time as the walk
    // signal, and another 37 per cent are cars clearing the junction on the
    // 1.5 s all-red. Neither is visible to a pedestrian in advance, and
    // neither is fixable from inside `src/agents`. The fix is for the traffic
    // to yield, which `TrafficSystem` already supports and nobody has wired:
    // see `PedestrianSystem.carriagewayObstacles`.
    const need = link.length / Math.max(0.4, speed * CROSSING_HURRY);

    const vehicles = ctx.vehicles;
    if (!vehicles || vehicles.length === 0) return true;

    const horizon = Math.min(CROSSING_HORIZON, need + 1.2);
    const cx = (link.ax + link.bx) * 0.5;
    const cz = (link.az + link.bz) * 0.5;
    // The link's own axes: `d` runs kerb to kerb across the carriageway, `n`
    // runs along the street, which is the direction its traffic travels.
    const halfAcross = link.length * 0.5;
    // The band pedestrians may actually occupy, not the painted crossing: the
    // link's own half width is already `crossing.halfWidth` less the pavement
    // margin, and using the wider figure spends 0.46 m of the 0.4 m the stop
    // line leaves.
    const halfAlong = link.halfWidth;

    for (const vehicle of vehicles) {
      const vx = vehicle.vx ?? 0;
      const vz = vehicle.vz ?? 0;
      const moving = Math.hypot(vx, vz);
      // Forward axis. A vehicle that is going somewhere is pointing where it is
      // going; a parked one is assumed to be lined up with the street, which is
      // what every queue at a stop line actually is.
      let fx: number;
      let fz: number;
      if (moving >= VEHICLE_STOPPED) {
        fx = vx / moving;
        fz = vz / moving;
      } else {
        fx = link.nx;
        fz = link.nz;
      }
      const halfLength = vehicle.halfLength ?? 2.3;
      const halfWidth = vehicle.halfWidth ?? 0.95;
      // Projection radius of an oriented box onto an axis. The chassis' right
      // vector is the forward one turned a quarter turn, so its dot products
      // with `d` and `n` are the forward vector's with `n` and `d` swapped.
      const fd = Math.abs(fx * link.dx + fz * link.dz);
      const fn = Math.abs(fx * link.nx + fz * link.nz);
      const margin = moving >= VEHICLE_STOPPED ? PED_RADIUS + CROSSING_MARGIN : PED_RADIUS;
      const rx = vehicle.x - cx;
      const rz = vehicle.z - cz;
      const window = this.window;
      window.lo = 0;
      window.hi = horizon;
      const onD = halfAcross + fd * halfLength + fn * halfWidth + margin;
      const onN = halfAlong + fn * halfLength + fd * halfWidth + margin;
      if (!slab(rx * link.dx + rz * link.dz, vx * link.dx + vz * link.dz, onD, window)) continue;
      if (!slab(rx * link.nx + rz * link.nz, vx * link.nx + vz * link.nz, onN, window)) continue;
      return false;
    }
    return true;
  }

  // -- avoidance ------------------------------------------------------------

  /**
   * Writes a steering displacement into `this.push` and returns a speed factor.
   *
   * The important distinction is between someone walking the same way and
   * everyone else. Matching the pace of the person you are following is what
   * makes a queue behave; applying it to a person coming the other way is a
   * deadlock, because both stop, both velocities go to zero, and the dodge -
   * which is computed from relative velocity - switches off exactly when it is
   * needed. Measured before this split: 36 of 204 walkers were stalled and 53
   * were stranded part-way across a road. So a neighbour who is stationary or
   * approaching is walked AROUND, never stopped for.
   *
   * The side is chosen from the sign of the cross product, which is the same
   * sign for both people in an encounter, so each steps to their own right and
   * the pair cannot mirror each other into a stalemate.
   */
  private avoid(ped: Pedestrian, index: number, dx: number, dz: number): number {
    this.push.x = 0;
    this.push.z = 0;
    let brake = 1;

    const near = ped.lod === 0;
    const range = near ? 3.0 : 1.6;
    const cx = Math.floor(ped.x / CELL);
    const cz = Math.floor(ped.z / CELL);
    const span = range > CELL ? 2 : 1;
    const contact = PED_RADIUS * 2 + 0.14;

    for (let i = -span; i <= span; i += 1) {
      for (let j = -span; j <= span; j += 1) {
        let other = this.cellHead[hashCell(cx + i, cz + j)] ?? -1;
        while (other >= 0) {
          const step = this.cellNext[other] ?? -1;
          if (other === index) {
            other = step;
            continue;
          }
          const o = this.peds[other];
          if (!o || !o.active) {
            other = step;
            continue;
          }
          const rx = o.x - ped.x;
          const rz = o.z - ped.z;
          const d2 = rx * rx + rz * rz;
          if (d2 > range * range || d2 < 1e-8) {
            other = step;
            continue;
          }
          const d = Math.sqrt(d2);

          // A body on the ground is not a person to squeeze past: it is a
          // metre and a half of obstacle lying across the pavement, and the
          // crowd has to go round it rather than through it.
          const reach = o.state === 'down' ? contact + DOWN_RADIUS + 0.85 : contact + 0.85;
          if (d < reach) {
            const strength = ((reach - d) / reach) * 2.2;
            this.push.x -= (rx / d) * strength;
            this.push.z -= (rz / d) * strength;
          }

          const ahead = (rx * dx + rz * dz) / d;
          if (ahead > 0.6 && d < 2.4) {
            const theirs = o.vx * dx + o.vz * dz;
            if (theirs > 0.25) {
              const room = clamp((d - contact) / 1.2, 0, 1);
              const allowed = theirs * (1 - room) + ped.look.preferredSpeed * room;
              brake = Math.min(
                brake,
                clamp(allowed / Math.max(0.2, ped.look.preferredSpeed), 0.12, 1),
              );
            } else {
              // Positive means they are to our left; step the other way.
              const toLeft = dx * rz - dz * rx;
              const side = toLeft > 0 ? -1 : 1;
              const urgency = clamp((2.4 - d) / 2.4, 0, 1) * 2.1;
              this.push.x += side * -dz * urgency;
              this.push.z += side * dx * urgency;
              brake = Math.min(brake, clamp(0.4 + (d - contact) * 0.55, 0.34, 1));
            }
          }

          if (near) {
            const rvx = ped.vx - o.vx;
            const rvz = ped.vz - o.vz;
            const rvSq = rvx * rvx + rvz * rvz;
            if (rvSq > 0.02) {
              const t = clamp(-(rx * rvx + rz * rvz) / rvSq, 0, 2.4);
              if (t > 0.001) {
                const mx = rx - rvx * t;
                const mz = rz - rvz * t;
                const miss = Math.hypot(mx, mz);
                if (miss < contact + 0.34) {
                  const urgency = (contact + 0.34 - miss) / (0.5 + t);
                  if (miss > 1e-3) {
                    this.push.x -= (mx / miss) * urgency * 1.5;
                    this.push.z -= (mz / miss) * urgency * 1.5;
                  } else {
                    this.push.x += dz * urgency;
                    this.push.z -= dx * urgency;
                  }
                }
              }
            }
          }
          other = step;
        }
      }
    }
    return brake;
  }

  /** Keeps the crowd out from under the player's feet. */
  avoidPlayer(px: number, pz: number, dt: number): void {
    const radius = 0.95;
    for (const ped of this.peds) {
      // A body is not shoved out of the way by somebody walking over it.
      if (!ped.active || ped.lod !== 0 || ped.state === 'down') continue;
      const rx = ped.x - px;
      const rz = ped.z - pz;
      const d = Math.hypot(rx, rz);
      if (d > radius || d < 1e-4) continue;
      const link = this.graph.links[ped.link];
      if (!link) continue;
      const gain = (radius - d) / radius;
      ped.x += (rx / d) * gain * Math.min(0.9, 5 * dt);
      ped.z += (rz / d) * gain * Math.min(0.9, 5 * dt);
      this.project(ped, link);
    }
  }

  /** Returns a speed factor: hurry across, or stop for a vehicle that will not. */
  private avoidVehicles(
    ped: Pedestrian,
    dx: number,
    dz: number,
    ctx: CrowdContext,
  ): number {
    const vehicles = ctx.vehicles;
    if (!vehicles || vehicles.length === 0) return 1;
    const link = this.graph.links[ped.link];
    const onRoad = link?.crossing != null;
    let factor = 1;
    for (const vehicle of vehicles) {
      const rx = vehicle.x - ped.x;
      const rz = vehicle.z - ped.z;
      const d2 = rx * rx + rz * rz;
      if (d2 > 400) continue;
      const vx = vehicle.vx ?? 0;
      const vz = vehicle.vz ?? 0;
      const halfLength = vehicle.halfLength ?? 2.3;
      const halfWidth = vehicle.halfWidth ?? 0.95;
      const clearance = Math.max(halfLength, halfWidth) + PED_RADIUS + 0.5;
      // ARM'S LENGTH FROM THE CHASSIS, NOT FROM ITS CENTRE. This used to be a
      // circle of `max(halfLength, halfWidth) + 0.77` - nearly three metres,
      // which on this city's narrower streets reaches the far pavement. Every
      // car that drove past froze the people walking on it, because a car is
      // 4.6 m long and 1.9 m wide and the circle was drawn to the long axis.
      if (vehicleOverlap(vehicle, ped.x, ped.z, PED_RADIUS + VEHICLE_NEAR)) {
        // A PARKED vehicle is scenery: walk round it.
        if (Math.hypot(vx, vz) < VEHICLE_STOPPED) {
          factor = Math.min(factor, 0.6);
          continue;
        }
        // A moving one this close is an emergency, and what to do about it
        // depends entirely on where you are standing. On a pavement, stop and
        // let it go by. ON A CARRIAGEWAY, STOPPING IS THE WORST THING YOU CAN
        // DO: the branch below already knows that and hurries people off the
        // road, and this early return used to pre-empt it and plant them in
        // the car's path instead.
        if (!onRoad) return 0;
        factor = Math.max(factor, CROSSING_SPRINT);
        continue;
      }
      const rvx = ped.vx - vx;
      const rvz = ped.vz - vz;
      const rvSq = rvx * rvx + rvz * rvz;
      if (rvSq < 0.09) continue;
      const t = clamp(-(rx * rvx + rz * rvz) / rvSq, 0, 4);
      const mx = rx - rvx * t;
      const mz = rz - rvz * t;
      if (Math.hypot(mx, mz) > clearance + 0.6) continue;
      if (!onRoad) {
        // Behind a kerb a near miss is a reason to hesitate, not to freeze:
        // the lateral clamp is what actually keeps the car off them, and a
        // pedestrian who stops dead every time a car goes by never gets
        // anywhere on a street with traffic on it.
        factor = Math.min(factor, t < 1.4 ? 0.35 : 0.6);
        continue;
      }
      // Already committed to the road: getting off it fast beats stopping,
      // unless the vehicle arrives before we could clear its path.
      const ahead = rx * dx + rz * dz;
      factor = Math.min(factor, t < 0.9 && ahead > 0 ? 0 : 1);
      if (t < 2.6) factor = Math.max(factor, CROSSING_SPRINT);
    }
    return factor;
  }

  /**
   * Positional correction so two pedestrians never share a spot.
   *
   * Runs after integration, so it is the last word. The correction is split
   * between the pair and then re-projected onto the pavement, which is why
   * someone squeezed against a wall stops rather than being pushed through it.
   *
   * A BODY IS NOT SPLIT WITH. Somebody on the ground has no legs to brace with,
   * so the whole correction is taken by whoever walked into them; otherwise a
   * busy pavement would slowly shove a casualty down the street. A body also
   * takes up a person's LENGTH rather than their width, so the separation is
   * larger for a pair that includes one.
   */
  private resolveOverlaps(iterations: number): void {
    const pairMinimum = PED_RADIUS * 2;
    for (let pass = 0; pass < iterations; pass += 1) {
      for (let i = 0; i < this.peds.length; i += 1) {
        const ped = this.peds[i];
        if (!ped || !ped.active || ped.lod > 1) continue;
        const cx = Math.floor(ped.x / CELL);
        const cz = Math.floor(ped.z / CELL);
        for (let a = -1; a <= 1; a += 1) {
          for (let b = -1; b <= 1; b += 1) {
            let other = this.cellHead[hashCell(cx + a, cz + b)] ?? -1;
            while (other >= 0) {
              const step = this.cellNext[other] ?? -1;
              if (other <= i) {
                other = step;
                continue;
              }
              const o = this.peds[other];
              if (!o || !o.active) {
                other = step;
                continue;
              }
              const aDown = ped.state === 'down';
              const bDown = o.state === 'down';
              if (aDown && bDown) {
                other = step;
                continue;
              }
              const minimum = aDown || bDown ? PED_RADIUS + DOWN_RADIUS : pairMinimum;
              let rx = o.x - ped.x;
              let rz = o.z - ped.z;
              let d = Math.hypot(rx, rz);
              if (d >= minimum) {
                other = step;
                continue;
              }
              if (d < 1e-5) {
                // Coincident: separate along a stable, index-derived axis so
                // the pair cannot oscillate between two equal answers.
                const angle = ((i * 2654435761) % 1000) / 1000 * TAU;
                rx = Math.cos(angle);
                rz = Math.sin(angle);
                d = 1;
              }
              // Whoever is on their feet takes the whole correction.
              const share = aDown || bDown ? 1 : 0.5;
              const correction = (minimum - d) * share;
              const ux = (rx / d) * correction;
              const uz = (rz / d) * correction;
              if (!aDown) {
                ped.x -= ux;
                ped.z -= uz;
                const la = this.graph.links[ped.link];
                if (la) this.project(ped, la);
              }
              if (!bDown) {
                o.x += ux;
                o.z += uz;
                const lb = this.graph.links[o.link];
                if (lb) this.project(o, lb);
              }
              other = step;
            }
          }
        }
      }
      if (pass + 1 < iterations) this.reindex();
    }
  }
}
