/**
 * The civilian crowd, seen from the outside.
 *
 * `PedestrianSystem` owns three hundred people and publishes them as instanced
 * matrices - one `InstancedMesh` per generated character, plus the procedural
 * fallback that is up until those finish downloading. Those matrices are the
 * only public, per-frame, per-person state the crowd exposes, and reading them
 * is deliberate: combat gets exactly the people the player can see, at the
 * position they are actually drawn, without `src/agents` growing a combat API
 * or this module reaching past a private field.
 *
 * ============================ WHAT IT ASKS THE CROWD FOR ====================
 *
 *   new CrowdTargets(pedestrians.group, {
 *     // LETHAL. Today's `PedestrianSystem.downAt`, which is permanent.
 *     removeAt: (x, y, z, dirX, dirZ) => pedestrians.downAt(x, y, z, undefined, dirX, dirZ),
 *     // WOUNDED, not killed. Does not exist yet; absent, a wounded civilian
 *     // simply walks on exactly as they did before.
 *     staggerAt: (x, z, dirX, dirZ, zone) => pedestrians.staggerAt(x, z, dirX, dirZ, zone),
 *     // A GUN WENT OFF HERE. Does not exist yet; absent, nobody flinches.
 *     alarmAt: (x, z, radius) => pedestrians.alarmAt(x, z, radius),
 *   });
 *
 * Every one of the three is optional and every one degrades to "nothing
 * happens", so this module keeps working against the crowd as it is today and
 * starts working better the moment the crowd grows the other two.
 *
 * ============================ WHAT IT KNOWS ON ITS OWN ======================
 *
 * WHO IS ON THE GROUND IS READ, NOT REMEMBERED. `PedestrianSystem.writeMatrix`
 * composes each instance as `Ry(heading) * Rx(tilt) * scale(girth, height,
 * girth)`, and `tilt` is the topple - zero on their feet, a right angle flat
 * out. Column 1 of that matrix is therefore `(sin·h·sin t, h·cos t, cos·h·sin
 * t)`: its LENGTH is the person's true height and its Y component divided by
 * that height is `cos t`. So a body on the pavement is recognisable from the
 * draw call itself, which is the only piece of per-person state that cannot go
 * stale, be recycled, or be confused with the neighbour they fell next to.
 *
 * IDENTITY. Instance slots are compacted every frame in draw order, so slot 7
 * is a different person from one frame to the next and cannot be a name. The
 * few people who have actually been shot are tracked separately by position:
 * a pedestrian moves at most 33 mm per frame at 120 Hz and the match radius is
 * 0.6 m, so the association is unambiguous, and the list only ever holds people
 * somebody shot.
 *
 * A WOUNDED RECORD FOLLOWS ITS BODY; A CASUALTY RECORD DOES NOT. Somebody
 * still walking has to be tracked or they would heal by taking a step. Somebody
 * on the ground does not move again, so re-homing their record onto "the
 * nearest body" only ever ends one way: a living pedestrian steps over the
 * corpse, inherits the casualty record, and is quietly deleted from the game as
 * a target and as a witness.
 *
 * BOUNDED, AND CLEANED UP DELIBERATELY. At most `MAX_TRACKED` records exist.
 * A casualty record is kept for at least `BODY_MEMORY` seconds AND until the
 * player is more than `BODY_FORGET_DISTANCE` away, which is deliberately the
 * same rule the crowd applies to the body itself (`CASUALTY_TIME`, `LOD_NEAR`)
 * so the record and the thing it describes never disagree about whether
 * somebody is dead.
 */

import { InstancedMesh, type Object3D } from 'three';

import { ACTOR_HEALTH, type HitZone } from './ballistics';
import type { ActorSource, ActorTarget, Blow, DamageResult } from './targets';

/** Shoulder radius used for hit tests, scaled by the person's own build. */
const BODY_RADIUS = 0.32;
/** How far a wounded record may be from a body to still be the same person. */
const TRACK_RADIUS = 0.6;
/**
 * The same question for a CASUALTY record, which is tighter on purpose.
 *
 * A wounded person walks, so their record has to reach far enough to cover a
 * frame of movement. A body does not, so the only thing a wide radius can buy
 * is the chance of shadowing somebody who walked past it - and a living person
 * matched to a corpse's record stops being shootable and stops being a witness.
 * The crowd keeps 0.85 m of clearance around a body (`DOWN_RADIUS`), so this is
 * comfortably inside the gap and cannot fail to find the body itself.
 */
const DOWN_TRACK_RADIUS = 0.35;
/** Seconds a WOUNDED record survives with nobody near it before it is dropped. */
const TRACK_MEMORY = 20;
/**
 * Cap on tracked casualties. Beyond this the least valuable record is recycled.
 *
 * Comfortably more than the crowd will hold on the ground at once: it keeps a
 * body for sixty seconds and the player has to be a district away before the
 * pool slot is reused, and thirty-two bodies inside that window is already a
 * massacre rather than a firefight.
 */
export const MAX_TRACKED = 32;

/**
 * Seconds a casualty record is kept whatever else is going on.
 *
 * The crowd's own `CASUALTY_TIME` is sixty seconds, and a record that expired
 * first would let a body that is still lying in the street be shot again, count
 * as a witness again, and be reported as a fresh kill again.
 */
export const BODY_MEMORY = 60;
/**
 * Metres the player has to be away before an expired casualty is forgotten.
 *
 * The crowd's `LOD_NEAR` is 42 m, which is where it stops simulating a body
 * properly and allows the pool slot to be reused. A little wider here so this
 * side always forgets AFTER the crowd has, never before.
 */
export const BODY_FORGET_DISTANCE = 48;

/**
 * How far over somebody has to be before they count as on the ground.
 *
 * `cos(tilt)`: 1 upright, 0 flat. Sixty degrees is past the point of no return
 * in the crowd's own fall curve and is nowhere near anything a walking person
 * does, so there is no threshold to tune between the two states.
 */
const PRONE_COS = 0.5;

interface Casualty {
  x: number;
  z: number;
  health: number;
  down: boolean;
  /** Seconds since this record was created. Drives the cleanup rule. */
  age: number;
  /** Seconds this record has spent with no body near it. Wounded records only. */
  idle: number;
}

interface Body {
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  /** True when this instance is drawn lying on the ground. See the header. */
  prone: boolean;
}

export interface CrowdTargetOptions {
  /**
   * A LETHAL hit. Called once, with the world contact point of the round that
   * did it and the direction that round was travelling, so the crowd can drop
   * the right person the right way. Without it the agent keeps walking.
   */
  readonly removeAt?:
    | ((x: number, y: number, z: number, dirX?: number, dirZ?: number) => void)
    | undefined;
  /**
   * A hit that WOUNDED somebody without killing them.
   *
   * `x`/`z` are the contact point, `dirX`/`dirZ` the round's direction of
   * travel, `zone` where on the body it landed - a limb should stagger
   * somebody, a trunk hit should double them up. The crowd has no such state
   * today; absent, a wounded civilian walks on, which is exactly what happens
   * now.
   */
  readonly staggerAt?:
    | ((x: number, z: number, dirX: number, dirZ: number, zone: HitZone) => void)
    | undefined;
  /**
   * A gun went off at `(x, z)` and anybody within `radius` heard it.
   *
   * Not a hit: this is the event, and it fires for a miss as readily as for a
   * kill. The crowd should scatter, and should debounce - a carbine reaches
   * here thirteen times a second, and `CombatSystem` already throttles it to
   * one alarm every few tenths of a second so a burst is one event.
   */
  readonly alarmAt?: ((x: number, z: number, radius: number) => void) | undefined;
}

export class CrowdTargets implements ActorSource {
  private readonly meshes: InstancedMesh[] = [];
  private readonly bodies: Body[] = [];
  private readonly casualties: Casualty[] = [];
  private bodyCount = 0;
  private proneCountValue = 0;
  private playerX = 0;
  private playerZ = 0;
  private readonly options: CrowdTargetOptions;

  /** `group` is `PedestrianSystem.group`. Nothing in it is mutated. */
  constructor(private readonly group: Object3D, options: CrowdTargetOptions = {}) {
    this.options = options;
  }

  /** People currently drawn, on their feet or not. Diagnostics only. */
  get liveCount(): number {
    return this.bodyCount;
  }

  /** People currently drawn lying on the ground. Diagnostics only. */
  get proneCount(): number {
    return this.proneCountValue;
  }

  /** People the player has shot and who are being tracked. Diagnostics only. */
  get trackedCount(): number {
    return this.casualties.length;
  }

  get downCount(): number {
    let n = 0;
    for (const c of this.casualties) if (c.down) n += 1;
    return n;
  }

  /**
   * Re-reads the crowd's instance buffers. Call once per frame, before any hit
   * test, so every query in that frame sees the same city.
   *
   * The player's position is only used to decide when a casualty may be
   * forgotten - see `BODY_FORGET_DISTANCE`. It defaults to the origin so a
   * caller that has nothing to say still gets the time-based half of the rule.
   */
  refresh(dt: number, playerX = 0, playerZ = 0): void {
    if (this.meshes.length === 0) this.collectMeshes();
    this.playerX = playerX;
    this.playerZ = playerZ;

    this.bodyCount = 0;
    this.proneCountValue = 0;
    for (const mesh of this.meshes) {
      if (!mesh.visible || mesh.count <= 0) continue;
      const m = mesh.instanceMatrix.array as ArrayLike<number>;
      for (let i = 0; i < mesh.count; i += 1) {
        const o = i * 16;
        const x = m[o + 12] ?? 0;
        const y = m[o + 13] ?? 0;
        const z = m[o + 14] ?? 0;
        // Column 0 is (cos·girth, 0, -sin·girth) whatever the topple, so the
        // build is read from it directly. Column 1 carries the topple: its
        // length is the person's height and its Y component is height·cos t.
        const girth = Math.hypot(m[o] ?? 1, m[o + 2] ?? 0) || 1;
        const height = Math.hypot(m[o + 4] ?? 0, m[o + 5] ?? 1.75, m[o + 6] ?? 0) || 1.75;
        const upright = Math.abs((m[o + 5] ?? height) / height);
        const slot = this.bodies[this.bodyCount] ?? {
          x: 0, y: 0, z: 0, radius: 0, height: 0, prone: false,
        };
        slot.x = x;
        slot.y = y;
        slot.z = z;
        slot.radius = BODY_RADIUS * girth;
        // The STANDING extent, which is what a vertical cylinder can mean. It
        // collapses as somebody goes over, which is right: a shot aimed at
        // where their head was passes over a body on the pavement.
        slot.height = height * upright;
        slot.prone = upright < PRONE_COS;
        if (slot.prone) this.proneCountValue += 1;
        this.bodies[this.bodyCount] = slot;
        this.bodyCount += 1;
      }
    }

    this.trackCasualties(dt);
  }

  /**
   * Ages every record, follows the wounded, and forgets the long dead.
   *
   * A wounded pedestrian keeps walking, so their record is moved to whichever
   * body is nearest and their wound goes with them. A casualty does not move
   * again and their record is PINNED - see the header for what re-homing one
   * costs.
   */
  private trackCasualties(dt: number): void {
    for (let c = this.casualties.length - 1; c >= 0; c -= 1) {
      const record = this.casualties[c];
      if (!record) continue;
      record.age += dt;

      if (record.down) {
        if (this.forgettable(record)) this.casualties.splice(c, 1);
        continue;
      }

      let bestX = 0;
      let bestZ = 0;
      let bestDistance = TRACK_RADIUS * TRACK_RADIUS;
      let found = false;
      for (let i = 0; i < this.bodyCount; i += 1) {
        const body = this.bodies[i];
        if (!body || body.prone) continue;
        const dx = body.x - record.x;
        const dz = body.z - record.z;
        const d = dx * dx + dz * dz;
        if (d < bestDistance) {
          bestDistance = d;
          bestX = body.x;
          bestZ = body.z;
          found = true;
        }
      }
      if (found) {
        record.x = bestX;
        record.z = bestZ;
        record.idle = 0;
      } else {
        record.idle += dt;
        if (record.idle > TRACK_MEMORY) this.casualties.splice(c, 1);
      }
    }
  }

  /** True once a casualty has been dead long enough AND is far enough away. */
  private forgettable(record: Casualty): boolean {
    if (record.age <= BODY_MEMORY) return false;
    const dx = record.x - this.playerX;
    const dz = record.z - this.playerZ;
    return dx * dx + dz * dz > BODY_FORGET_DISTANCE * BODY_FORGET_DISTANCE;
  }

  private collectMeshes(): void {
    this.group.traverse((child) => {
      if (child instanceof InstancedMesh) this.meshes.push(child);
    });
  }

  private readonly scratch: {
    id: number;
    x: number;
    y: number;
    z: number;
    radius: number;
    height: number;
    faction: 'civilian';
  } = { id: 0, x: 0, y: 0, z: 0, radius: 0, height: 0, faction: 'civilian' };

  forEachActor(x: number, z: number, radius: number, visit: (target: ActorTarget) => void): void {
    const limit = radius * radius;
    for (let i = 0; i < this.bodyCount; i += 1) {
      const body = this.bodies[i];
      if (!body || body.prone) continue;
      const dx = body.x - x;
      const dz = body.z - z;
      if (dx * dx + dz * dz > limit) continue;
      if (this.recordAt(body.x, body.z)?.down) continue;
      const target = this.scratch;
      target.id = i;
      target.x = body.x;
      target.y = body.y;
      target.z = body.z;
      target.radius = body.radius;
      target.height = body.height;
      visit(target);
    }
  }

  damage(id: number, amount: number, blow?: Blow): DamageResult {
    const body = this.bodies[id];
    if (!body || id >= this.bodyCount || amount <= 0) return 'none';
    // Somebody already on the pavement is not a target. Read from the draw
    // call rather than from the record, so a corpse whose record was recycled
    // still cannot be killed a second time.
    if (body.prone) return 'none';
    let record = this.recordAt(body.x, body.z);
    if (!record) {
      record = { x: body.x, z: body.z, health: ACTOR_HEALTH, down: false, age: 0, idle: 0 };
      this.admit(record);
    }
    if (record.down) return 'none';
    record.health -= amount;

    // The contact point the ray test found, falling back to the body itself
    // for a blast, which has none. This is what tells the crowd WHICH person
    // was hit, so it has to be the round's own arrival point and not a centre.
    const cx = blow?.x ?? body.x;
    const cy = blow?.y ?? body.y + body.height * 0.5;
    const cz = blow?.z ?? body.z;

    if (record.health > 0) {
      // Wounded, not killed. The direction is the round's line of travel, so
      // the crowd can stagger them the way it was going rather than at random.
      this.options.staggerAt?.(cx, cz, blow?.dirX ?? 0, blow?.dirZ ?? 0, blow?.zone ?? 'body');
      return 'hurt';
    }
    record.down = true;
    record.health = 0;
    // Pinned where they fell rather than where the round entered, because that
    // is where the body will be lying for the next minute and every later
    // lookup is a proximity test against it.
    record.x = body.x;
    record.z = body.z;
    record.age = 0;
    // The blow decides which way they topple. `ActorSource.damage` has
    // always offered it; this implementation used to drop it on the floor,
    // so every civilian folded forwards whichever side the shot came from.
    this.options.removeAt?.(cx, cy, cz, blow?.dirX, blow?.dirZ);
    return 'killed';
  }

  /**
   * A gunshot the crowd should notice. Forwarded straight through.
   *
   * Part of `WitnessSource` rather than of `ActorSource`: it is about the
   * street rather than about one person, and a source with nobody in it has
   * nothing to alarm.
   */
  alarm(x: number, z: number, radius: number): void {
    this.options.alarmAt?.(x, z, radius);
  }

  /**
   * True when somebody who is still on their feet is close enough to see the
   * player. Cheap by design: it stops at the first witness.
   */
  hasWitnessWithin(x: number, z: number, radius: number): boolean {
    const limit = radius * radius;
    for (let i = 0; i < this.bodyCount; i += 1) {
      const body = this.bodies[i];
      // Somebody face down on the pavement is not watching the street. Note
      // this covers a survivor a car knocked over as well as a casualty, which
      // is right for as long as they are on the ground and stops being true on
      // its own when they get up.
      if (!body || body.prone) continue;
      const dx = body.x - x;
      const dz = body.z - z;
      if (dx * dx + dz * dz > limit) continue;
      if (this.recordAt(body.x, body.z)?.down) continue;
      return true;
    }
    return false;
  }

  /**
   * Files a new record, making room for it if the list is full.
   *
   * Eviction order, worst first: a casualty that has already served its time
   * and is far away, then the oldest merely wounded record, and only then -
   * because the list has to stay bounded and there is nothing else to give -
   * the oldest casualty. The last case needs a street with thirty-two bodies
   * on it inside one minute.
   */
  private admit(record: Casualty): void {
    if (this.casualties.length >= MAX_TRACKED) {
      let victim = this.casualties.findIndex((c) => c.down && this.forgettable(c));
      if (victim < 0) victim = this.casualties.findIndex((c) => !c.down);
      if (victim < 0) victim = 0;
      this.casualties.splice(victim, 1);
    }
    this.casualties.push(record);
  }

  /**
   * The record belonging to whoever is standing at a point, if any.
   *
   * Each record carries its own reach - see `DOWN_TRACK_RADIUS` - so a corpse
   * claims a much smaller patch of pavement than somebody still walking, and
   * the nearest MATCH wins rather than the nearest record.
   */
  private recordAt(x: number, z: number): Casualty | null {
    let best: Casualty | null = null;
    let bestDistance = Infinity;
    for (const record of this.casualties) {
      const reach = record.down ? DOWN_TRACK_RADIUS : TRACK_RADIUS;
      const dx = record.x - x;
      const dz = record.z - z;
      const d = dx * dx + dz * dz;
      if (d < reach * reach && d < bestDistance) {
        bestDistance = d;
        best = record;
      }
    }
    return best;
  }
}
