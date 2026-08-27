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
 * WHAT THIS CANNOT DO. It cannot remove a body. The crowd owns each agent's
 * lifecycle and nothing outside `src/agents` can end one, so a civilian who
 * takes a lethal hit is recorded as down - they stop being a target, they stop
 * counting as a witness, and the heat for killing them is applied once - but
 * their agent keeps walking. Pass `removeAt` to fix that the moment the crowd
 * grows a way to be told; `PoliceSystem` needs no such hook because it owns its
 * officers outright.
 *
 * IDENTITY. Instance slots are compacted every frame in draw order, so slot 7
 * is a different person from one frame to the next and cannot be a name. The
 * few people who have actually been shot are tracked separately by position:
 * a pedestrian moves at most 33 mm per frame at 120 Hz and the match radius is
 * 0.6 m, so the association is unambiguous, and the list is at most a dozen
 * entries because it only ever holds people somebody shot.
 */

import { InstancedMesh, type Object3D } from 'three';

import { ACTOR_HEALTH } from './ballistics';
import type { ActorSource, ActorTarget, Blow, DamageResult } from './targets';

/** Shoulder radius used for hit tests, scaled by the person's own build. */
const BODY_RADIUS = 0.32;
/** How far a wounded record may be from a body to still be the same person. */
const TRACK_RADIUS = 0.6;
/** Seconds a record survives with nobody near it before it is dropped. */
const TRACK_MEMORY = 20;
/** Cap on tracked casualties. Beyond this the oldest is recycled. */
const MAX_TRACKED = 24;

interface Casualty {
  x: number;
  z: number;
  health: number;
  down: boolean;
  idle: number;
}

interface Body {
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
}

export interface CrowdTargetOptions {
  /**
   * Optional hook for a crowd that can be told somebody died. Called once, with
   * the world position of the body. Without it the agent keeps walking.
   */
  readonly removeAt?:
    | ((x: number, y: number, z: number, dirX?: number, dirZ?: number) => void)
    | undefined;
}

export class CrowdTargets implements ActorSource {
  private readonly meshes: InstancedMesh[] = [];
  private readonly bodies: Body[] = [];
  private readonly casualties: Casualty[] = [];
  private bodyCount = 0;
  private readonly removeAt:
    | ((x: number, y: number, z: number, dirX?: number, dirZ?: number) => void)
    | undefined;

  /** `group` is `PedestrianSystem.group`. Nothing in it is mutated. */
  constructor(private readonly group: Object3D, options: CrowdTargetOptions = {}) {
    this.removeAt = options.removeAt;
  }

  /** People currently drawn and not already down. Diagnostics only. */
  get liveCount(): number {
    return this.bodyCount;
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
   */
  refresh(dt: number): void {
    if (this.meshes.length === 0) this.collectMeshes();

    this.bodyCount = 0;
    for (const mesh of this.meshes) {
      if (!mesh.visible || mesh.count <= 0) continue;
      const m = mesh.instanceMatrix.array as ArrayLike<number>;
      for (let i = 0; i < mesh.count; i += 1) {
        const o = i * 16;
        const x = m[o + 12] ?? 0;
        const y = m[o + 13] ?? 0;
        const z = m[o + 14] ?? 0;
        // Column 0 is (cos * girth, 0, sin * girth); column 1 is (0, height, 0).
        const girth = Math.hypot(m[o] ?? 1, m[o + 2] ?? 0) || 1;
        const height = m[o + 5] ?? 1.75;
        const slot = this.bodies[this.bodyCount] ?? { x: 0, y: 0, z: 0, radius: 0, height: 0 };
        slot.x = x;
        slot.y = y;
        slot.z = z;
        slot.radius = BODY_RADIUS * girth;
        slot.height = height;
        this.bodies[this.bodyCount] = slot;
        this.bodyCount += 1;
      }
    }

    this.trackCasualties(dt);
  }

  /**
   * Follows each tracked casualty to the nearest body, so a wounded pedestrian
   * who walks away keeps their wound. Records nobody claims for a while are
   * dropped - the person left the draw radius, or the pool slot was recycled.
   */
  private trackCasualties(dt: number): void {
    for (let c = this.casualties.length - 1; c >= 0; c -= 1) {
      const record = this.casualties[c];
      if (!record) continue;
      let bestX = 0;
      let bestZ = 0;
      let bestDistance = TRACK_RADIUS * TRACK_RADIUS;
      let found = false;
      for (let i = 0; i < this.bodyCount; i += 1) {
        const body = this.bodies[i];
        if (!body) continue;
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
      if (!body) continue;
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
    let record = this.recordAt(body.x, body.z);
    if (!record) {
      record = { x: body.x, z: body.z, health: ACTOR_HEALTH, down: false, idle: 0 };
      if (this.casualties.length >= MAX_TRACKED) this.casualties.shift();
      this.casualties.push(record);
    }
    if (record.down) return 'none';
    record.health -= amount;
    if (record.health > 0) return 'hurt';
    record.down = true;
    record.health = 0;
    // The blow decides which way they topple. `ActorSource.damage` has
    // always offered it; this implementation used to drop it on the floor,
    // so every civilian folded forwards whichever side the shot came from.
    this.removeAt?.(body.x, body.y, body.z, blow?.dirX, blow?.dirZ);
    return 'killed';
  }

  /**
   * True when somebody who is still on their feet is close enough to see the
   * player. Cheap by design: it stops at the first witness.
   */
  hasWitnessWithin(x: number, z: number, radius: number): boolean {
    const limit = radius * radius;
    for (let i = 0; i < this.bodyCount; i += 1) {
      const body = this.bodies[i];
      if (!body) continue;
      const dx = body.x - x;
      const dz = body.z - z;
      if (dx * dx + dz * dz > limit) continue;
      if (this.recordAt(body.x, body.z)?.down) continue;
      return true;
    }
    return false;
  }

  private recordAt(x: number, z: number): Casualty | null {
    let best: Casualty | null = null;
    let bestDistance = TRACK_RADIUS * TRACK_RADIUS;
    for (const record of this.casualties) {
      const dx = record.x - x;
      const dz = record.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestDistance) {
        bestDistance = d;
        best = record;
      }
    }
    return best;
  }
}
