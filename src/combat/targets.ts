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

import type { HitZone } from './ballistics';

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

/**
 * Which way the blow that landed was travelling, and how hard.
 *
 * A body has to fall AWAY from whatever hit it, and a source that owns its own
 * agents - `PoliceSystem` does; `CrowdTargets` does not - needs the direction
 * to decide whether they go over backwards or onto their face. `speed` is the
 * speed of whatever delivered the hit in m/s, not the damage: it is what the
 * body is thrown at a share of, so a bullet nudges and a shockwave throws.
 *
 * Optional on `damage` rather than a second method: every existing caller and
 * every existing test double keeps compiling, and a source that has nowhere to
 * put a direction simply ignores it.
 *
 * Transient, like `ActorTarget`: the caller reuses one object across a burst
 * and across every victim of one blast, so read it during the call and do not
 * retain it.
 */
export interface Blow {
  /** Unit direction of travel in the horizontal plane. */
  readonly dirX: number;
  readonly dirZ: number;
  readonly speed: number;
  /**
   * WHERE THE BLOW MET THE BODY, in world space.
   *
   * The contact point the ray test found, not the body's centre and not its
   * feet. A source that forwards a casualty to somebody else - `CrowdTargets`
   * hands one to the crowd - has to report where the round actually arrived,
   * or a shoulder hit is filed at the victim's shoes and the wrong person is
   * matched when two people are standing together.
   *
   * Optional because a blast has no contact point worth the name: it arrives
   * everywhere at once, and the receiver should fall back to the body itself.
   */
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly z?: number | undefined;
  /**
   * Where on the body it landed, when the caller measured it.
   *
   * Absent for a blast, for the same reason. A receiver uses it to choose the
   * REACTION - a leg takes a stagger, a trunk takes a fold - and never to
   * re-derive damage, which the caller has already applied.
   */
  readonly zone?: HitZone | undefined;
}

export interface ActorSource {
  /**
   * Visits every live body whose centre is within `radius` of `(x, z)`.
   * Implementations must not visit anyone already killed.
   */
  forEachActor(x: number, z: number, radius: number, visit: (target: ActorTarget) => void): void;
  /** Applies damage to one actor and says what happened. */
  damage(id: number, amount: number, blow?: Blow): DamageResult;
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
