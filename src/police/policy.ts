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

/** Seconds between one dispatch and the next. Infinite when nobody is wanted. */
export function dispatchInterval(stars: number): number {
  const table = [Infinity, 6, 5, 4, 3.2, 2.6];
  return table[Math.max(0, Math.min(table.length - 1, stars))] ?? Infinity;
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
/** Seconds an officer spends drawing and aiming before the first shot. */
export const OFFICER_AIM_TIME = 0.8;

/** How far an officer on foot can see the player, given line of sight. */
export const SIGHT_RANGE_FOOT = 55;
/** How far a crew can see from a moving car. */
export const SIGHT_RANGE_CAR = 85;

/** Distance at which a pursuit car stops and its crew gets out. */
export const DISMOUNT_RANGE = 16;
/** A car stops chasing on wheels once the player is this close on foot. */
export const CAR_HOLD_RANGE = 9;

/** Speed an officer runs at, m/s. Faster than the player's 6.0 sprint. */
export const OFFICER_RUN_SPEED = 6.4;
/** Top speed a pursuit car will ask for, m/s. */
export const PURSUIT_SPEED = 16;

/** How far from the player a new unit is placed. Beyond the fog, on a road. */
export const DISPATCH_DISTANCE = 115;
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
