/**
 * What the combat layer is allowed to know about the people in the city.
 *
 * The crowd and the traffic are owned by other systems with their own
 * lifecycles, and combat has no business reaching into either. It asks for a
 * list of standing bodies near a point and reports damage back; whoever
 * supplies the list decides what damage means.
 *
 * That indirection is also what makes the whole hit-registration path testable
 * without a renderer: `tests/combat.test.ts` supplies a handful of plain
 * objects where the game supplies three hundred instanced pedestrians.
 */

export type Faction = 'civilian' | 'police';

/**
 * One standing body, as a vertical cylinder.
 *
 * `y` is the height of the FEET, matching the crowd's own instance matrices
 * and `CityGround.sample().y`, so no consumer has to guess whether a position
 * is a centre or a contact point.
 *
 * Targets are transient: an implementation is free to reuse the object between
 * calls, so read what you need during the visit and do not retain it.
 */
export interface ActorTarget {
  /** Identifies the actor to `damage`. Only valid until the next refresh. */
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly height: number;
  readonly faction: Faction;
}

/** What a hit did to whoever took it. */
export type DamageResult = 'none' | 'hurt' | 'killed';

export interface ActorSource {
  /**
   * Visits every live body whose centre is within `radius` of `(x, z)`.
   * Implementations must not visit anyone already killed.
   */
  forEachActor(x: number, z: number, radius: number, visit: (target: ActorTarget) => void): void;
  /** Applies damage to one actor and says what happened. */
  damage(id: number, amount: number): DamageResult;
}

/** An `ActorSource` with nobody in it. Keeps wiring optional. */
export const EMPTY_ACTORS: ActorSource = {
  forEachActor: () => undefined,
  damage: () => 'none',
};

/**
 * The police, as combat sees them.
 *
 * Declared here rather than in `src/police` so the combat layer never imports
 * the pursuit and the two can be tested apart. `PoliceSystem` implements it.
 */
export interface LawTargets extends ActorSource {
  /** Damage to a pursuit vehicle, identified by its id in the traffic fleet. */
  damageVehicle(vehicleId: number, amount: number): DamageResult;
  /** The player attacked the police. Officers who were not hostile now are. */
  reportAttack(x: number, z: number): void;
  /** True while any unit has line of sight to the player. */
  watchingPlayer(): boolean;
}
