/**
 * The E-key interaction layer.
 *
 * Interaction points are registered by the world builders (doors, mostly) and
 * indexed into a coarse grid so that finding the nearest candidate costs
 * nothing per frame. The player must be both close enough and roughly facing
 * the point, which stops a door behind you stealing the prompt from the one in
 * front of you.
 */

import type { InteractionPoint } from '../world/build/types';

const CELL = 8;

/**
 * Inside this distance of a point, the player is offered it whatever way they
 * are facing.
 *
 * This is the fix for the doorway that only worked from a couple of metres
 * out. A door's interaction point sits 1.5 m OUTSIDE the door, on the approach,
 * and the facing test used to be taken against that point - so walking up to
 * the door put the point behind the player's shoulder, the dot product went
 * negative, and the prompt they were walking towards switched off exactly when
 * they arrived. The old grace was 0.35 m, which is narrower than one stride.
 */
const NEAR_GRACE = 2;

/**
 * How much closer a point has to be to take the prompt away from the one that
 * already has it.
 *
 * Two doorways on a terrace are metres apart, and without hysteresis the
 * prompt swaps between them as the player's heading wanders by a degree.
 */
const STICKINESS = 0.25;

/** Cosine of the widest angle off the player's heading a point may sit at. */
const FACING_MINIMUM = 0.15;

/**
 * How far above or below a point the player may stand and still be offered it.
 *
 * Generous enough to cover a doorway seen from the top of its own steps, tight
 * enough that a prompt on the floor above never steals focus.
 */
export const SAME_FLOOR_TOLERANCE = 3.2;

export interface InteractionEvent {
  readonly point: InteractionPoint;
}

export class InteractionSystem {
  private readonly grid = new Map<number, InteractionPoint[]>();
  private current: InteractionPoint | null = null;
  private disposed = false;

  /** Fires when the player presses E on a valid target. */
  onActivate: ((event: InteractionEvent) => void) | null = null;
  /** Fires when the highlighted target changes, including to nothing. */
  onFocusChange: ((point: InteractionPoint | null) => void) | null = null;

  constructor(points: readonly InteractionPoint[]) {
    for (const point of points) {
      const key = InteractionSystem.key(
        Math.floor(point.x / CELL),
        Math.floor(point.z / CELL),
      );
      const bucket = this.grid.get(key);
      if (bucket) bucket.push(point);
      else this.grid.set(key, [point]);
    }
    window.addEventListener('keydown', this.onKeyDown);
  }

  private static key(cx: number, cz: number): number {
    return (cx + 1024) * 8192 + (cz + 1024);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'KeyE' || event.repeat) return;
    if (!this.current) return;
    event.preventDefault();
    this.onActivate?.({ point: this.current });
  };

  get focused(): InteractionPoint | null {
    return this.current;
  }

  /**
   * Picks the best target for the player's current position and heading.
   * Scoring prefers points that are both near and in front, so walking along a
   * terrace does not flicker between neighbouring doorways.
   */
  update(x: number, y: number, z: number, yaw: number): void {
    if (this.disposed) return;

    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);

    let best: InteractionPoint | null = null;
    let bestScore = -Infinity;

    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let ix = cx - 1; ix <= cx + 1; ix += 1) {
      for (let iz = cz - 1; iz <= cz + 1; iz += 1) {
        const bucket = this.grid.get(InteractionSystem.key(ix, iz));
        if (!bucket) continue;
        for (const point of bucket) {
          const dx = point.x - x;
          const dz = point.z - z;
          const distance = Math.hypot(dx, dz);
          if (distance > point.radius) continue;
          // Ignore anything on a different floor.
          if (Math.abs(point.y - y) > SAME_FLOOR_TOLERANCE) continue;

          /*
           * Face the THING, not the standing spot in front of it.
           *
           * A door registers its point on the approach and its target inside
           * the building; the door itself is between the two, and that is what
           * a player turns to look at. Halfway between them is the threshold to
           * within a few centimetres, so this is the doorway - and unlike the
           * approach point, it never ends up behind the player who has walked
           * up to it.
           */
          const target = point.target;
          const facingX = target ? (point.x + target.x) * 0.5 : point.x;
          const facingZ = target ? (point.z + target.z) * 0.5 : point.z;
          const fx = facingX - x;
          const fz = facingZ - z;
          const facingDistance = Math.hypot(fx, fz);
          const facing =
            facingDistance < NEAR_GRACE
              ? 1
              : (fx * forwardX + fz * forwardZ) / facingDistance;
          if (facing < FACING_MINIMUM) continue;

          let score = facing * 2 - distance / Math.max(0.001, point.radius);
          if (point === this.current) score += STICKINESS;
          if (score > bestScore) {
            bestScore = score;
            best = point;
          }
        }
      }
    }

    if (best !== this.current) {
      this.current = best;
      this.onFocusChange?.(best);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    this.grid.clear();
    this.current = null;
  }
}
