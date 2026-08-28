/**
 * How hard Meridian Bay's police push back, per star.
 *
 * Every number the pursuit reads is here, as a pure function of the wanted
 * level, so the escalation can be asserted in a unit test rather than inferred
 * from watching a chase. `PoliceSystem` owns the meshes and the driving; this
 * module owns the policy, and nothing in it imports Three.js.
 *
 * THE SHAPE OF THE ESCALATION. One star is a patrol car that wants to take you
 * in. Two is two cars and a pair of officers who will still arrest you. Three
 * is where they stop asking. Four and five add cars, add a second officer to
 * each, shorten the wait between dispatches and make the shooting better - but
 * the ceiling stays low enough that the frame budget survives it: five cars and
 * ten officers is one extra colour draw call for the whole response, because
 * the officers share one instanced mesh and the beacons share another.
 *
 * THE SHAPE OF THE TIMING. A response has to BUILD, not arrive. Measured on
 * the previous policy, one star and five stars were paced identically: a unit
 * was dispatched on the same frame as the offence at every level, was within
 * thirty metres at 13.5 s at every level, and - once anybody was hostile - was
 * shooting at 16.5 s at every level. The only thing a star bought was more
 * cars doing the same thing at the same time, so firing one round in the
 * street summoned a car that was on top of you before you could move.
 *
 * Three separate quantities now carry the escalation, and each is a function
 * of the wanted level rather than a constant:
 *
 *   `dispatchDelay`     how long the call takes to go out at all
 *   `dispatchDistance`  how far away the unit that answers it starts
 *   `dispatchInterval`  how long before the next one follows
 *
 * A first star is a slow, distant, single car. A fifth is immediate, close and
 * relentless. The delay shortens with the level, so escalating mid-chase does
 * not re-serve the first star's wait; see `PoliceSystem.updateDispatch`.
 */

/** Hard ceiling on simultaneous pursuit vehicles. */
export const MAX_UNITS = 5;
/** Hard ceiling on officers on foot, across every unit. */
export const MAX_OFFICERS = 10;

/** Pursuit cars the city wants on the street at this wanted level. */
export function carsForStars(stars: number): number {
  if (stars <= 0) return 0;
  return Math.min(MAX_UNITS, stars);
}

/** Officers riding in each car. A second one arrives with the third star. */
export function officersPerCar(stars: number): number {
  return stars >= 3 ? 2 : 1;
}

/**
 * Seconds from the offence that raises the alarm until the FIRST unit is sent.
 *
 * This is the number the whole complaint was about. It used to be zero: the
 * frame a shot was heard, a car was already driving at the player. One round
 * fired in the street now buys nine seconds of nothing at all, which is the
 * difference between a consequence and an ambush - long enough to walk away,
 * get in a car, or decide to make it worse.
 *
 * It shrinks fast with the level because a five-star response is meant to feel
 * like the city was already waiting for you. `PoliceSystem` measures the delay
 * from when the alarm was first raised and reads the CURRENT level, so heat
 * that climbs during the wait shortens it instead of restarting it.
 */
export function dispatchDelay(stars: number): number {
  const table = [Infinity, 9, 6, 3.5, 1.6, 0.6];
  return table[Math.max(0, Math.min(table.length - 1, stars))] ?? Infinity;
}

/**
 * Seconds between one dispatch and the next. Infinite when nobody is wanted.
 *
 * Roughly doubled at the bottom of the range and untouched at the top, so a
 * second car is a separate event rather than part of the same arrival. Must
 * stay strictly decreasing: the escalation test asserts it.
 */
export function dispatchInterval(stars: number): number {
  const table = [Infinity, 12, 9, 6, 4, 2.6];
  return table[Math.max(0, Math.min(table.length - 1, stars))] ?? Infinity;
}

/**
 * The distance a top-level response starts from: beyond the fog, on a road.
 * `dispatchDistance` opens this out at the lower levels.
 */
export const DISPATCH_DISTANCE = 115;

/**
 * How far from the player a newly dispatched unit is placed, in metres.
 *
 * Distance is time: at the pursuit's 16 m/s ceiling, and slower than that
 * through junctions, every extra thirty metres is another two or three
 * seconds of siren before anything happens. A one-star unit starts two hundred
 * metres of city driving away and has to find you; a five-star unit starts
 * where the old constant put every unit at every level.
 *
 * `dispatchLane` treats this as a preference and not a requirement - it picks
 * the lane whose midpoint is nearest this distance, biased away from the
 * player's view - so a value the city cannot satisfy degrades to the furthest
 * road it has rather than failing to dispatch.
 */
export function dispatchDistance(stars: number): number {
  const table = [DISPATCH_DISTANCE, 190, 165, 140, 125, DISPATCH_DISTANCE];
  return table[Math.max(0, Math.min(table.length - 1, stars))] ?? DISPATCH_DISTANCE;
}

/**
 * Whether officers open fire without being shot at first.
 *
 * Below three stars they try to make an arrest, which is what makes the first
 * two stars a different situation rather than a smaller version of the same
 * one. Being shot at makes any officer hostile regardless.
 */
export function shootsOnSight(stars: number): boolean {
  return stars >= 3;
}

/** Probability one aimed shot from an officer lands, before cover. */
export function officerAccuracy(stars: number): number {
  return stars >= 4 ? 0.62 : 0.45;
}

/** Damage one officer's round does to the player. */
export const OFFICER_SHOT_DAMAGE = 7;
/** Seconds between an officer's shots. */
export const OFFICER_SHOT_INTERVAL = 1.05;
/** Furthest an officer will shoot from. */
export const OFFICER_FIRE_RANGE = 30;
/** Floor on the draw-and-aim time, used at the top of the wanted range. */
export const OFFICER_AIM_TIME = 0.8;

/**
 * Seconds an officer holds the player in view before their first shot.
 *
 * `shootsOnSight` decides WHETHER an officer will fire without being fired on;
 * this decides how long they take about it once they have decided. At one and
 * two stars an officer only ever gets here because the player shot at the
 * police, and even then they challenge first: nearly three seconds of being
 * aimed at, which is time to break the line of sight or surrender. At five
 * stars it is the old constant - they are not asking.
 *
 * The timer is per officer and resets whenever they lose sight of the player,
 * so ducking behind a wall really does restart the count.
 */
export function officerAimTime(stars: number): number {
  const table = [OFFICER_AIM_TIME, 2.6, 2.2, 1.5, 1.1, OFFICER_AIM_TIME];
  return table[Math.max(0, Math.min(table.length - 1, stars))] ?? OFFICER_AIM_TIME;
}

/** How far an officer on foot can see the player, given line of sight. */
export const SIGHT_RANGE_FOOT = 55;
/** How far a crew can see from a moving car. */
export const SIGHT_RANGE_CAR = 85;

/** Distance at which a pursuit car stops and its crew gets out. */
export const DISMOUNT_RANGE = 16;
/** A car stops chasing on wheels once the player is this close on foot. */
export const CAR_HOLD_RANGE = 9;

/**
 * ============================ ON-FOOT LOCOMOTION ============================
 *
 * Everything below is one number: how fast a human body can change what it is
 * doing. It exists because the officers used to have no such number at all.
 * `updateOfficers` set `speed = wantsToMove ? OFFICER_RUN_SPEED : 0` and
 * `heading = atan2(-dx, -dz)`, so an officer went from standing to a full run
 * in ONE FRAME and pivoted to face the player with no angular limit. Measured
 * on the old code at 60 Hz: peak acceleration 384 m/s², peak turn rate 7.1
 * rad/s against a player merely walking a 2 m circle. That instantaneous jump
 * between two velocities, with the walk cycle unable to follow it, is what a
 * player sees as an officer SLIDING toward them.
 *
 * The numbers are human, not generous: an officer must be beatable on foot,
 * because the alternative - the old 6.4 m/s, faster than an Olympic 800 m
 * pace, held indefinitely while wearing a duty belt - is the "implausible
 * speed" half of the same complaint. What catches a runner is the cars.
 */

/** Speed an officer walks at, m/s. A brisk purposeful walk, not a stroll. */
export const OFFICER_WALK_SPEED = 1.6;
/**
 * Speed an officer runs at, m/s.
 *
 * 5.4 m/s is 19.4 km/h: a hard run that a fit adult in uniform can hold for
 * the length of a chase. It is deliberately BELOW the player's 6.0 m/s sprint,
 * so a suspect who commits to running on foot outpaces the men chasing them
 * and has to be cut off by a car instead. The old 6.4 made every foot chase
 * unwinnable and looked wrong doing it.
 */
export const OFFICER_RUN_SPEED = 5.4;
/**
 * Bounds on how fast the desired speed may be reached, m/s².
 *
 * A standing start to 5.4 m/s in about 1.2 s, and a stop from it in about
 * 0.85 s. Stopping is quicker than starting because it is: braking is a
 * heel strike, accelerating is not.
 */
export const OFFICER_ACCEL = 4.5;
export const OFFICER_BRAKE = 6.4;
/**
 * Bound on how fast an officer turns, rad/s.
 *
 * 4.5 rad/s is a 90 degree pivot in 0.35 s - fast, but a movement rather than
 * a snap. Everything an officer does is issued as a DESIRED heading and passed
 * through this, so there is no path by which a heading can jump.
 */
export const OFFICER_TURN_RATE = 4.5;
/** Beyond this an officer runs; inside it they walk. */
export const OFFICER_RUN_RANGE = 12;
/** Hysteresis band on that switch, so an officer does not stutter across it. */
export const OFFICER_RUN_HYSTERESIS = 2.5;
/**
 * How far apart officers converging on the same suspect aim, in metres.
 *
 * Each officer is given a lateral slot off the direct line, so a crew arrives
 * as two people taking an angle on you rather than as two people occupying the
 * same square metre and running straight down your throat.
 */
export const OFFICER_SPREAD = 1.8;

/** How close an officer closes to before stopping to shoot. */
export const FIRING_STANDOFF = 7;
/** How close an officer closes to when trying to make an arrest. */
export const ARREST_STANDOFF = 1.6;
/** Extra distance at which an officer drops from a run to a controlled walk. */
export const CLOSE_MARGIN = 4;

/** Seconds an officer spends registering the suspect before acting. */
export const OFFICER_NOTICE_TIME = 0.45;
/** Seconds the sidearm takes to come out of the holster and into the hand. */
export const OFFICER_DRAW_TIME = 0.55;
/** Rounds in an officer's magazine before it has to be changed. */
export const OFFICER_MAGAZINE = 9;
/** Seconds a magazine change takes, weapon down. */
export const OFFICER_RELOAD_TIME = 2.1;
/** Seconds an officer is staggered by taking a round. */
export const OFFICER_HIT_RECOVER = 0.55;
/** Seconds one repositioning move around an obstacle lasts. */
export const OFFICER_REPOSITION_TIME = 1.6;
/** Seconds without sight of the suspect before an officer stands easy. */
export const OFFICER_LOSE_PATIENCE = 6;
/**
 * How far off their heading an officer may be and still fire, in radians.
 *
 * A shot leaves the weapon, and the weapon points where the officer is facing.
 * Twelve degrees is the slop between "aimed at you" and "aimed at the weapon
 * model's forward axis"; wider than that and the tracer would visibly leave
 * the barrel sideways.
 */
export const OFFICER_FIRE_CONE = 0.21;

/** Top speed a pursuit car will ask for, m/s. */
export const PURSUIT_SPEED = 16;

/** A patrol car must be at least this far away before it is commandeered. */
export const COMMANDEER_DISTANCE = 190;

/** Units give up and go back to being traffic this far from the player. */
export const ABANDON_DISTANCE = 320;

export interface ArrestConditions {
  /** Metres between the officer and the player. */
  readonly distance: number;
  /** The player's speed over the ground, m/s. */
  readonly playerSpeed: number;
  readonly playerHealth: number;
  readonly stars: number;
  readonly driving: boolean;
  /** Seconds the officer has already held the player at gunpoint. */
  readonly held: number;
}

/** Close enough to lay hands on. */
export const ARREST_RANGE = 2.4;
/** Above this the player is running and cannot be taken. */
export const ARREST_SPEED = 1.7;
/** Seconds the conditions must hold continuously. */
export const ARREST_HOLD = 0.9;
/** Health at or below which even a five-star suspect is taken in, not shot. */
export const ARREST_HEALTH = 40;

/**
 * Whether an officer takes the player into custody this frame.
 *
 * An arrest needs the player cornered rather than merely nearby: close, slow,
 * on foot, and held there for most of a second. Who is eligible depends on the
 * wanted level - a one or two star suspect is arrested as a matter of course,
 * and a higher one only once they are too hurt to keep running.
 */
export function canArrest(c: ArrestConditions): boolean {
  if (c.driving) return false;
  if (c.distance > ARREST_RANGE) return false;
  if (c.playerSpeed > ARREST_SPEED) return false;
  if (c.held < ARREST_HOLD) return false;
  return c.stars <= 2 || c.playerHealth <= ARREST_HEALTH;
}
