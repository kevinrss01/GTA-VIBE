/**
 * A rocket has to arrive at the first thing in its way, and only there.
 *
 * `Projectiles` takes its whole world through one `probe` callback and reports
 * arrivals through one `onDetonate`, so the flight and the collision can be
 * driven here at a fixed step with a wall at a known distance - no renderer, no
 * model, no scene.
 *
 * THE BUG THESE PIN. The fuse must not create a gap. The first attempt offset
 * the PROBE forward by the arming distance instead of waiting until the rocket
 * had covered it: at 46 m/s a frame is 0.77 m and the offset was 0.9 m, so the
 * rocket looked at [0.9, 1.67] while moving through [0, 0.77] and a wall inside
 * that gap was passed straight through. The second attempt waited for
 * `travelled` to pass the threshold before testing the WHOLE step, which
 * leaves [0.9, 1.54] untested for the same reason. What is tested now is the
 * part of each step that lies past the arming distance, with nothing in
 * between.
 */

import { describe, expect, it } from 'vitest';

import { Projectiles } from '../src/combat/Projectiles';

const SPEED = 46;
const STEP = 1 / 60;

interface Flight {
  readonly detonations: { x: number; y: number; z: number }[];
  readonly rockets: Projectiles;
}

/**
 * Fires one rocket down +Z at a wall `wallAt` metres away and runs `frames`
 * of simulation. A `wallAt` of `Infinity` is open ground.
 */
function fireAt(wallAt: number, frames = 240): Flight {
  const detonations: { x: number; y: number; z: number }[] = [];
  const rockets = new Projectiles({
    // No url: the flight and the collision are the whole of the behaviour and
    // neither needs a model.
    probe: (_ox, _oy, oz, _dx, _dy, dz, maxT) => {
      if (!Number.isFinite(wallAt)) return -1;
      // A plane at z = wallAt. Only a forward crossing counts.
      if (dz <= 1e-9) return -1;
      const t = (wallAt - oz) / dz;
      if (t < 0 || t > maxT) return -1;
      return t;
    },
    onDetonate: (x, y, z) => detonations.push({ x, y, z }),
  });
  rockets.launch(0, 1.5, 0, 0, 0, 1, SPEED);
  for (let i = 0; i < frames; i += 1) rockets.update(STEP);
  return { detonations, rockets };
}

describe('a rocket in flight', () => {
  it('leaves the tube and reports itself alive', () => {
    const flight = fireAt(Infinity, 1);
    expect(flight.rockets.liveCount).toBe(1);
    expect(flight.detonations).toHaveLength(0);
  });

  /*
   * The fuse. A rocket must not go off on the shoulder that fired it, which
   * means the first stretch really is not tested - that is the design, not an
   * oversight, and this pins the distance so a later change cannot quietly
   * grow it.
   */
  it('passes through anything inside the arming distance', () => {
    const flight = fireAt(0.5);
    expect(flight.detonations).toHaveLength(0);
  });

  /*
   * ...and the moment the fuse is armed there is no gap. Every tenth of a
   * metre from the arming distance out to five metres has to stop the rocket
   * AT the wall, not somewhere past it and not not at all.
   */
  it('stops at every wall past the arming distance, with no gap', () => {
    const missed: string[] = [];
    const late: string[] = [];
    for (let wall = 1.0; wall <= 5.0; wall += 0.1) {
      const at = Number(wall.toFixed(2));
      const flight = fireAt(at);
      const hit = flight.detonations[0];
      if (!hit) {
        missed.push(`${at}`);
        continue;
      }
      // Arrive at the wall, not through it. A centimetre of tolerance covers
      // the floating point in the parametric solve.
      if (Math.abs(hit.z - at) > 0.01) late.push(`${at} -> ${hit.z.toFixed(3)}`);
    }
    expect(missed, `passed through walls at ${missed.join(', ')} m`).toEqual([]);
    expect(late, `detonated away from the wall: ${late.join(', ')}`).toEqual([]);
  });

  it('gives up in mid air rather than flying forever', () => {
    const flight = fireAt(Infinity, 600);
    expect(flight.detonations).toHaveLength(1);
    expect(flight.rockets.liveCount).toBe(0);
  });

  it('detonates exactly once, however many frames run afterwards', () => {
    const flight = fireAt(3, 600);
    expect(flight.detonations).toHaveLength(1);
  });

  it('drops a little on the way, but nothing like a mortar', () => {
    const flight = fireAt(60, 600);
    const hit = flight.detonations[0];
    expect(hit).toBeDefined();
    if (!hit) return;
    // 60 m at 46 m/s is 1.3 s of flight. A real motor barely drops in that
    // time and a full 9.81 would put the round in the road.
    const drop = 1.5 - hit.y;
    expect(drop).toBeGreaterThan(0);
    expect(drop).toBeLessThan(3);
  });

  it('reports a trail while it flies and stops when it arrives', () => {
    const trail: number[] = [];
    const rockets = new Projectiles({
      probe: () => -1,
      onDetonate: () => {},
      onTrail: (_x, _y, z) => trail.push(z),
    });
    rockets.launch(0, 1.5, 0, 0, 0, 1, SPEED);
    for (let i = 0; i < 30; i += 1) rockets.update(STEP);
    expect(trail.length).toBeGreaterThan(10);
    // The trail is laid along the flight, so it has to march forward.
    for (let i = 1; i < trail.length; i += 1) {
      expect(trail[i] as number).toBeGreaterThanOrEqual(trail[i - 1] as number);
    }
  });

  /*
   * The detonation has to say whether it CAME FROM a probe hit.
   *
   * The combat layer latches the probe's surface normal and material between
   * the probe and the arrival, and the only thing that makes that safe is
   * knowing which arrivals the latch describes. A fuse running out in mid-air
   * describes nothing, and a caller that could not tell the two apart would
   * scorch the sky with the last wall the rocket flew past.
   */
  it('says whether it arrived on something or merely ran out of fuse', () => {
    const arrivals: { contact: boolean; z: number }[] = [];
    const rockets = new Projectiles({
      probe: (_ox, _oy, oz, _dx, _dy, dz, maxT) => {
        const t = (5 - oz) / (dz || 1);
        return t >= 0 && t <= maxT ? t : -1;
      },
      onDetonate: (_x, _y, z, _dx, _dy, _dz, contact) => arrivals.push({ contact, z }),
    });
    rockets.launch(0, 1.5, 0, 0, 0, 1, SPEED);
    for (let i = 0; i < 60; i += 1) rockets.update(STEP);
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]?.contact).toBe(true);
    expect(arrivals[0]?.z ?? 0).toBeCloseTo(5, 2);

    // Nothing to hit: the same rocket, the same weapon, no surface.
    const spent: boolean[] = [];
    const timedOut = new Projectiles({
      probe: () => -1,
      onDetonate: (_x, _y, _z, _dx, _dy, _dz, contact) => spent.push(contact),
    });
    timedOut.launch(0, 1.5, 0, 0, 0, 1, SPEED);
    for (let i = 0; i < 600; i += 1) timedOut.update(STEP);
    expect(spent).toEqual([false]);
  });

  it('reports the direction it was travelling when it arrived', () => {
    const arrivals: { dx: number; dy: number; dz: number }[] = [];
    const rockets = new Projectiles({
      probe: (_ox, _oy, oz, _dx, _dy, dz, maxT) => {
        const t = (12 - oz) / (dz || 1);
        return t >= 0 && t <= maxT ? t : -1;
      },
      onDetonate: (_x, _y, _z, dx, dy, dz) => arrivals.push({ dx, dy, dz }),
    });
    rockets.launch(0, 1.5, 0, 0, 0, 1, SPEED);
    for (let i = 0; i < 120; i += 1) rockets.update(STEP);

    const hit = arrivals[0];
    expect(hit).toBeDefined();
    if (!hit) return;
    // A unit vector, pointing where the rocket was going - mostly down +Z and
    // a little downward, because the motor does not quite hold it level.
    expect(Math.hypot(hit.dx, hit.dy, hit.dz)).toBeCloseTo(1, 6);
    expect(hit.dz).toBeGreaterThan(0.99);
    expect(hit.dy).toBeLessThan(0);
    expect(hit.dy).toBeGreaterThan(-0.1);
  });

  it('clears the sky on demand without detonating anything', () => {
    const detonations: unknown[] = [];
    const rockets = new Projectiles({ probe: () => -1, onDetonate: () => detonations.push(1) });
    rockets.launch(0, 1.5, 0, 0, 0, 1, SPEED);
    rockets.update(STEP);
    expect(rockets.liveCount).toBe(1);
    rockets.clear();
    expect(rockets.liveCount).toBe(0);
    expect(detonations).toHaveLength(0);
  });

  it('hands out a handle that follows its own rocket and then goes quiet', () => {
    let handle: { id: number; live: boolean; z: number } | null = null;
    const rockets = new Projectiles({
      probe: (_ox, _oy, oz, _dx, _dy, dz, maxT) => {
        const t = (4 - oz) / (dz || 1);
        return t >= 0 && t <= maxT ? t : -1;
      },
      onDetonate: () => {},
      onLaunch: (rocket) => {
        handle = rocket as unknown as { id: number; live: boolean; z: number };
      },
    });
    rockets.launch(0, 1.5, 0, 0, 0, 1, SPEED);
    expect(handle).not.toBeNull();
    const live = handle as unknown as { id: number; live: boolean; z: number };
    const firstId = live.id;
    rockets.update(STEP);
    expect(live.live).toBe(true);
    expect(live.z).toBeGreaterThan(0);
    for (let i = 0; i < 30; i += 1) rockets.update(STEP);
    expect(live.live).toBe(false);

    // A second launch reuses the slot, and the id is what tells the two apart.
    rockets.launch(0, 1.5, 0, 0, 0, 1, SPEED);
    expect(live.id).not.toBe(firstId);
  });
});
