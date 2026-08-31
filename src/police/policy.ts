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

/** Speed an officer runs at, m/s. Faster than the player's 6.0 sprint. */
export const OFFICER_RUN_SPEED = 6.4;
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

/**
 * How near an officer has to be before they bother shouting at the player.
 *
 * Further than a conversation, nearer than a rifle shot: an order yelled
 * across a street is the point, and an officer who challenges the player from
 * beyond `OFFICER_FIRE_RANGE` is shouting at somebody they are about to shoot
 * at anyway, which reads as a bug rather than as procedure.
 */
export const OFFICER_VOICE_RANGE = 26;
/**
 * Seconds before the same officer may shout again.
 *
 * Long, deliberately. Every unit carries a crew, so four officers converging
 * with a two-second cooldown each would produce an order roughly twice a
 * second: not a police response, a chant. Eight seconds means a cordon of four
 * says something about every two seconds between them, which is about the rate
 * a real one does.
 */
export const OFFICER_VOICE_COOLDOWN = 8;
/** Seconds before any unit may key the radio again. */
export const RADIO_COOLDOWN = 12;
/**
 * How near a unit has to be to hail a driver over its PA.
 *
 * Further than a shout, because it IS one through a loudhailer at somebody
 * sitting inside a car - but still well short of `SIGHT_RANGE_CAR`, or a
 * pursuit would be narrated from the far side of the district.
 */
export const UNIT_VOICE_RANGE = 45;

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
