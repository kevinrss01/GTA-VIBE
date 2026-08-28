/**
 * What a warhead does when it arrives, as arithmetic.
 *
 * Four defects are pinned here, all of them the same defect wearing different
 * clothes - THE DETONATION THREW AWAY THE HIT RESULT THAT PRODUCED IT:
 *
 *  - `probeRocket` returned the distance and dropped the surface normal, the
 *    material and the identity of whatever was struck. The blast then had to
 *    guess at all three, so a rocket into a wall put its scorch flat in the
 *    air 0.55 m below the impact, and the car it hit dead centre was pushed by
 *    exactly the radial shove a car standing beside it got.
 *  - Every vehicle took the same impulse whatever its size, so the only thing
 *    separating a hatchback from a box truck was the mass the traffic layer
 *    divided by - and a blast pushed a truck's whole broadside no harder than
 *    it pushed a bollard's worth of hatchback.
 *  - Momentum fell off with the same curve as damage, so a blast that was
 *    supposed to be felt at nine metres was still shoving parked cars there.
 *  - A direct hit was worth nothing over a near miss at the same range.
 *
 * All of it is numbers: no renderer, no GL context, no traffic system. The
 * fleet double records the exact `VehicleImpact` the combat layer emits, and
 * the assertions run `TrafficSim.applyImpact`'s OWN formulae over it - the
 * moment `rz*jx - rx*jz` and the roll couple `lateral * lever` - because what
 * matters is not the impulse this layer reports but the yaw and the roll the
 * traffic layer will derive from it.
 */

import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';

import {
  FX_CAPACITY,
  impactBudget,
  type ImpactKind,
  type ImpactSound,
} from '../src/combat/CombatFx';
import {
  blastFalloff,
  blastImpulseFalloff,
  CombatSystem,
  presentedArea,
  type BlastContact,
  type CombatVehicleView,
  type VehicleImpact,
} from '../src/combat/CombatSystem';
import { WorldRayIndex } from '../src/combat/rays';
import type { ActorSource, ActorTarget, Blow, DamageResult } from '../src/combat/targets';
import { PlayerState, WEAPONS, type WeaponId } from '../src/player/PlayerState';
import type { ColliderBox } from '../src/world/build/types';

const LAUNCHER = WEAPONS.launcher;
const RADIUS = LAUNCHER.blastRadius ?? 9.5;
const PEAK = LAUNCHER.blastDamage ?? 190;

/** A saloon's half extents, matching the catalogue's 4.88 x 1.92 x 1.50 m. */
const SALOON = { halfLength: 2.44, halfWidth: 0.96, halfHeight: 0.75 } as const;
const SALOON_MASS = 1780;
/** A box truck: 6.70 x 2.14 x 2.92 m, 4 200 kg. */
const TRUCK = { halfLength: 3.35, halfWidth: 1.07, halfHeight: 1.46 } as const;
const TRUCK_MASS = 4200;

function inertElement(): HTMLElement {
  return {
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  } as unknown as HTMLElement;
}

class RecordingFleet {
  readonly views: CombatVehicleView[] = [];
  readonly impacts: { id: number; hit: VehicleImpact }[] = [];

  add(view: CombatVehicleView): CombatVehicleView {
    this.views.push(view);
    return view;
  }

  forEachNear(x: number, z: number, radius: number, visit: (v: CombatVehicleView) => void): void {
    // Centres, exactly as `TrafficSim.forEachNear` matches them.
    for (const view of this.views) {
      if (Math.hypot(view.x - x, view.z - z) <= radius) visit(view);
    }
  }

  applyImpact(id: number, hit: VehicleImpact): boolean {
    if (!this.views.some((v) => v.id === id)) return false;
    this.impacts.push({ id, hit: { ...hit } });
    return true;
  }

  applyDamage(): boolean {
    return true;
  }

  /** The single impact one vehicle took, or null. Fails loudly on a repeat. */
  only(id: number): VehicleImpact | null {
    const mine = this.impacts.filter((entry) => entry.id === id);
    // The traffic layer refuses a second impulse within 0.22 s, so a
    // detonation that issues two silently loses one of them.
    expect(mine.length, `vehicle ${id} took ${mine.length} impulses from one blast`)
      .toBeLessThanOrEqual(1);
    return mine[0]?.hit ?? null;
  }
}

interface StubBody {
  id: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  health: number;
}

class StubCrowd implements ActorSource {
  readonly bodies: StubBody[] = [];
  readonly damage_: { id: number; amount: number }[] = [];

  add(x: number, z: number): StubBody {
    const body: StubBody = { id: this.bodies.length, x, y: 0, z, radius: 0.32, height: 1.75, health: 1e6 };
    this.bodies.push(body);
    return body;
  }

  refresh(): void {
    /* stub bodies do not move */
  }

  hasWitnessWithin(): boolean {
    return false;
  }

  forEachActor(x: number, z: number, radius: number, visit: (t: ActorTarget) => void): void {
    for (const body of this.bodies) {
      if (Math.hypot(body.x - x, body.z - z) > radius) continue;
      visit({ ...body, faction: 'civilian' });
    }
  }

  damage(id: number, amount: number, _blow?: Blow): DamageResult {
    this.damage_.push({ id, amount });
    return 'hurt';
  }

  dealt(id: number): number {
    let total = 0;
    for (const entry of this.damage_) if (entry.id === id) total += entry.amount;
    return total;
  }
}

function eastwardCamera(x = 0, y = 1.68, z = 0): PerspectiveCamera {
  const camera = new PerspectiveCamera(70, 1.6, 0.1, 1000);
  camera.position.set(x, y, z);
  camera.rotation.set(0, -Math.PI / 2, 0, 'YXZ');
  camera.updateMatrixWorld(true);
  return camera;
}

function armed(id: WeaponId, rounds = 20): PlayerState {
  const player = new PlayerState();
  player.earn(500_000);
  player.buyWeapon(id);
  while (player.ammo(id) < rounds) {
    if (!player.buyAmmo(id)) break;
  }
  player.equip(id);
  return player;
}

const idle = (): {
  driving: boolean;
  playerX: number;
  playerY: number;
  playerZ: number;
  playerSpeed: number;
} => ({ driving: false, playerX: 0, playerY: 0, playerZ: 0, playerSpeed: 0 });

function build(options: {
  fleet?: RecordingFleet;
  crowd?: StubCrowd;
  boxes?: readonly ColliderBox[];
  heightAt?: (x: number, z: number) => number;
  camera?: PerspectiveCamera;
  onImpact?: (kind: ImpactSound, x: number, y: number, z: number) => void;
} = {}): CombatSystem {
  return new CombatSystem({
    // Far from every blast in this file, so the player never takes their own
    // warhead and never contributes a witness.
    player: armed('launcher'),
    camera: options.camera ?? eastwardCamera(0, 1.68, 900),
    domElement: inertElement(),
    world: new WorldRayIndex(options.boxes ?? []),
    heightAt: options.heightAt ?? ((): number => 0),
    ...(options.crowd ? { civilians: options.crowd } : {}),
    ...(options.fleet ? { vehicles: options.fleet } : {}),
    ...(options.onImpact ? { onImpact: options.onImpact } : {}),
    seed: 'impact-blast',
  });
}

/**
 * `TrafficSim.applyImpact`'s own moment about the vertical axis.
 *
 * Reproduced rather than imported because the traffic layer is another
 * workstream's file: what is being asserted is that the impact this layer
 * REPORTS will produce a spin over there, and that only depends on the two
 * numbers below.
 */
function yawMoment(hit: VehicleImpact, view: CombatVehicleView): number {
  const jx = hit.dirX * hit.impulse;
  const jz = hit.dirZ * hit.impulse;
  const rx = hit.x - view.x;
  const rz = hit.z - view.z;
  return rz * jx - rx * jz;
}

/** The roll couple: the lateral share of the impulse times its height. */
function rollCouple(hit: VehicleImpact, view: CombatVehicleView): number {
  const jx = hit.dirX * hit.impulse;
  const jz = hit.dirZ * hit.impulse;
  const rightX = Math.cos(view.yaw);
  const rightZ = -Math.sin(view.yaw);
  const lateral = jx * rightX + jz * rightZ;
  const lever = Math.max(0, hit.y - view.y);
  return lateral * lever;
}

function saloonAt(id: number, x: number, z = 0, yaw = 0): CombatVehicleView {
  return { id, police: false, x, y: 0.75, z, yaw, ...SALOON };
}

// -- the curves ---------------------------------------------------------------

describe('blast falloff', () => {
  it('is total inside the fireball and nothing outside the radius', () => {
    expect(blastFalloff(0)).toBe(1);
    expect(blastFalloff(0.34)).toBe(1);
    expect(blastFalloff(1)).toBe(0);
    expect(blastFalloff(1.5)).toBe(0);
    expect(blastFalloff(0.6)).toBeGreaterThan(0);
    expect(blastFalloff(0.6)).toBeLessThan(1);
  });

  it('never rises as the distance grows', () => {
    let previous = Infinity;
    for (let i = 0; i <= 200; i += 1) {
      const value = blastFalloff(i / 200);
      expect(value).toBeLessThanOrEqual(previous + 1e-12);
      previous = value;
    }
  });

  it('sheds momentum faster than it sheds damage', () => {
    // Inside the fireball there is nothing to shed: both are total.
    expect(blastImpulseFalloff(0)).toBe(1);
    expect(blastImpulseFalloff(0.34)).toBe(1);
    expect(blastImpulseFalloff(1)).toBe(0);

    // Outside it, momentum has to fall away first, or every parked car within
    // nine metres of a rocket takes off together.
    for (const share of [0.4, 0.5, 0.6, 0.75, 0.9]) {
      expect(blastImpulseFalloff(share)).toBeLessThan(blastFalloff(share));
      expect(blastImpulseFalloff(share)).toBeGreaterThanOrEqual(0);
    }
    // Half a radius out: damage is still more than half, momentum is not.
    expect(blastFalloff(0.5)).toBeCloseTo(0.574, 2);
    expect(blastImpulseFalloff(0.5)).toBeCloseTo(0.435, 2);
    // Four fifths out: a bruise, and a nudge that will not move a car.
    expect(blastFalloff(0.8)).toBeCloseTo(0.0918, 3);
    expect(blastImpulseFalloff(0.8)).toBeCloseTo(0.0278, 3);
    expect(blastImpulseFalloff(0.8)).toBeLessThan(blastFalloff(0.8) / 3);
  });
});

describe('the area a blast can see', () => {
  it('reads a saloon broadside as its side elevation and nose-on as its front', () => {
    const side = presentedArea(SALOON.halfLength, SALOON.halfWidth, SALOON.halfHeight, 0, 1, 0, 0);
    const nose = presentedArea(SALOON.halfLength, SALOON.halfWidth, SALOON.halfHeight, 0, 0, 0, 1);
    expect(side).toBeCloseTo(4.88 * 1.5, 5);
    expect(nose).toBeCloseTo(1.92 * 1.5, 5);
    expect(side).toBeGreaterThan(nose * 2.5);
  });

  it('reads it from overhead as its plan', () => {
    const plan = presentedArea(SALOON.halfLength, SALOON.halfWidth, SALOON.halfHeight, 0, 0, 1, 0);
    expect(plan).toBeCloseTo(4.88 * 1.92, 5);
  });

  it('does not care which way along the line the blast is', () => {
    const a = presentedArea(SALOON.halfLength, SALOON.halfWidth, SALOON.halfHeight, 0, 3, 1, -2);
    const b = presentedArea(SALOON.halfLength, SALOON.halfWidth, SALOON.halfHeight, 0, -3, -1, 2);
    expect(a).toBeCloseTo(b, 9);
  });

  it('follows the vehicle round as it turns', () => {
    const broadside = presentedArea(SALOON.halfLength, SALOON.halfWidth, SALOON.halfHeight, 0, 1, 0, 0);
    const turned = presentedArea(
      SALOON.halfLength, SALOON.halfWidth, SALOON.halfHeight, Math.PI / 2, 1, 0, 0,
    );
    expect(turned).toBeCloseTo(1.92 * 1.5, 5);
    expect(turned).toBeLessThan(broadside);
  });

  it('falls back to the side elevation when the blast is at the centre', () => {
    const centred = presentedArea(SALOON.halfLength, SALOON.halfWidth, SALOON.halfHeight, 0, 0, 0, 0);
    expect(centred).toBeCloseTo(4.88 * 1.5, 5);
  });

  it('sees far more of a box truck than of a saloon', () => {
    const truck = presentedArea(TRUCK.halfLength, TRUCK.halfWidth, TRUCK.halfHeight, 0, 1, 0, 0);
    const saloon = presentedArea(SALOON.halfLength, SALOON.halfWidth, SALOON.halfHeight, 0, 1, 0, 0);
    expect(truck).toBeGreaterThan(saloon * 2);
  });
});

// -- what a detonation does to the street -------------------------------------

describe('a warhead and the cars around it', () => {
  it('falls off with distance, and stops dead at the radius', () => {
    const fleet = new RecordingFleet();
    // Nearest-point distances of 0, half a radius, and just past the radius.
    fleet.add(saloonAt(1, SALOON.halfWidth));
    fleet.add(saloonAt(2, SALOON.halfWidth + RADIUS * 0.5));
    fleet.add(saloonAt(3, SALOON.halfWidth + RADIUS + 0.5));
    const combat = build({ fleet });

    combat.detonate(0, 0.75, 0);

    const seat = fleet.only(1);
    const middle = fleet.only(2);
    expect(seat).not.toBeNull();
    expect(middle).not.toBeNull();
    // Outside the radius is untouched. Not "barely touched" - untouched.
    expect(fleet.only(3), 'a car outside the radius was shoved').toBeNull();
    if (!seat || !middle) return;

    expect(seat.damage).toBeGreaterThan(middle.damage * 1.7);
    expect(middle.damage).toBeGreaterThan(0);
    // Momentum falls away faster than damage does, so the far car is nudged
    // where the near one is thrown.
    expect(middle.impulse / seat.impulse).toBeLessThan(middle.damage / seat.damage);
    expect(seat.impulse / SALOON_MASS).toBeGreaterThan(3);
    expect(middle.impulse / SALOON_MASS).toBeLessThan(2);
    combat.dispose();
  });

  it('shoves a big body harder and a light one further', () => {
    const fleet = new RecordingFleet();
    // Both broadside, both with the same 2 m of air between the blast and the
    // nearest panel, so the only difference is how much of them there is.
    fleet.add(saloonAt(1, SALOON.halfWidth + 2));
    fleet.add({ id: 2, police: false, x: TRUCK.halfWidth + 2, y: 1.46, z: 14, yaw: 0, ...TRUCK });
    const combat = build({ fleet });

    combat.detonate(0, 0.75, 0);
    combat.detonate(0, 1.46, 14);

    const saloon = fleet.only(1);
    const truck = fleet.only(2);
    expect(saloon).not.toBeNull();
    expect(truck).not.toBeNull();
    if (!saloon || !truck) return;

    // The truck catches more of the shockwave...
    expect(truck.impulse).toBeGreaterThan(saloon.impulse * 1.4);
    // ...and still moves less, because it is more than twice the mass. That
    // ordering is the whole point: a blast rocks a van and throws a saloon.
    expect(truck.impulse / TRUCK_MASS).toBeLessThan(saloon.impulse / SALOON_MASS);
    combat.dispose();
  });

  it('spins a car it goes off beside one wing, and not one abeam its middle', () => {
    const fleet = new RecordingFleet();
    const centred = fleet.add(saloonAt(1, 3));
    const offset = fleet.add(saloonAt(2, 3, 20));
    const combat = build({ fleet });

    // Abeam the centre: the push runs down the same line as the contact, so
    // there is no moment and the car is shoved square.
    combat.detonate(0, 0.75, 0);
    // Beside the front of the second car: the contact is 2 m up its length
    // while the push is across it, which is a lever arm and a spin.
    combat.detonate(0, 0.75, 22);

    const square = fleet.only(1);
    const corner = fleet.only(2);
    expect(square).not.toBeNull();
    expect(corner).not.toBeNull();
    if (!square || !corner) return;

    expect(Math.abs(yawMoment(square, centred))).toBeLessThan(square.impulse * 1e-6);
    expect(Math.abs(yawMoment(corner, offset))).toBeGreaterThan(corner.impulse * 0.5);
    combat.dispose();
  });

  it('rolls a car it goes off above the sill, and not one at its own height', () => {
    const fleet = new RecordingFleet();
    const low = fleet.add(saloonAt(1, 3));
    const high = fleet.add(saloonAt(2, 3, 20));
    const combat = build({ fleet });

    // Level with the centre of mass: pure translation, nothing to tip it.
    combat.detonate(0, 0.75, 0);
    // Up at roof height: the same lateral push, now acting 0.65 m above the
    // centre, which is what puts a car on its side.
    combat.detonate(0, 1.4, 20);

    const level = fleet.only(1);
    const above = fleet.only(2);
    expect(level).not.toBeNull();
    expect(above).not.toBeNull();
    if (!level || !above) return;

    expect(rollCouple(level, low)).toBeCloseTo(0, 6);
    expect(Math.abs(rollCouple(above, high))).toBeGreaterThan(above.impulse * 0.5);
    combat.dispose();
  });

  it('gives the car it actually hit more than the one standing beside it', () => {
    const fleet = new RecordingFleet();
    fleet.add(saloonAt(1, SALOON.halfWidth));
    fleet.add(saloonAt(2, -SALOON.halfWidth));
    const combat = build({ fleet });

    const contact: BlastContact = {
      nx: -1, ny: 0, nz: 0,
      dirX: 1, dirY: 0, dirZ: 0,
      kind: 'vehicle', impact: 'metal', vehicleId: 1,
    };
    combat.detonate(SALOON.halfWidth, 0.75, 0, contact);

    const direct = fleet.only(1);
    const beside = fleet.only(2);
    expect(direct).not.toBeNull();
    expect(beside).not.toBeNull();
    if (!direct || !beside) return;

    // The warhead's own direct damage lands on top of the blast.
    expect(direct.damage).toBeCloseTo(PEAK + LAUNCHER.damage, 4);
    expect(beside.damage).toBeCloseTo(PEAK, 4);
    expect(direct.impulse).toBeGreaterThan(beside.impulse * 1.4);
    // Enough to put the car well past the traffic layer's 0.9 m/s threshold
    // for leaving the road network and becoming a free body.
    expect(direct.impulse / SALOON_MASS).toBeGreaterThan(5);
    // ONE impulse, not two. `RecordingFleet.only` fails if a second arrived,
    // which the traffic layer's 0.22 s cooldown would have thrown away.
    expect(fleet.impacts.filter((entry) => entry.id === 1)).toHaveLength(1);
    combat.dispose();
  });

  it('throws the car it hit into the air, and only presses on a distant one', () => {
    /*
     * The gap this closes. `VehicleImpact` carried no vertical channel at all,
     * so a blast could yaw a car, roll it, overturn it and shove it down the
     * street - and never lift one. A rocket into a car that settles back onto
     * its springs is the difference between a detonation and a shove.
     *
     * The lift is a SEPARATE impulse rather than a third component of the
     * direction, so none of the horizontal numbers above move by adding it.
     */
    const fleet = new RecordingFleet();
    fleet.add(saloonAt(1, SALOON.halfWidth));
    fleet.add(saloonAt(2, SALOON.halfWidth + RADIUS * 0.75));
    const combat = build({ fleet });

    combat.detonate(SALOON.halfWidth, 0.75, 0, {
      nx: -1, ny: 0, nz: 0,
      dirX: 1, dirY: 0, dirZ: 0,
      kind: 'vehicle', impact: 'metal', vehicleId: 1,
    });

    const direct = fleet.only(1);
    const far = fleet.only(2);
    expect(direct).not.toBeNull();
    expect(far).not.toBeNull();
    if (!direct || !far) return;

    const lift = direct.lift ?? 0;
    // Past the traffic layer's 0.6 m/s trigger by a wide margin: this car
    // genuinely leaves the road rather than shivering on its suspension.
    expect(lift / SALOON_MASS).toBeGreaterThan(1.5);
    // ...and not so far past it that a car is launched over a rooftop.
    expect(lift / SALOON_MASS).toBeLessThan(6);
    // Three quarters of the radius away, the same blast may press but must not
    // throw. This is the "does not launch every distant object" bound.
    expect(far.lift ?? 0).toBeLessThan(lift * 0.25);

    // The horizontal shove is untouched by the presence of the lift, which is
    // the whole reason it is a separate field. Same bound as the test above.
    expect(direct.impulse / SALOON_MASS).toBeGreaterThan(5);
    combat.dispose();
  });

  it('presses a car DOWN when the warhead comes through its roof', () => {
    const fleet = new RecordingFleet();
    // Blast seat above the body's mid height, and nothing was struck, so the
    // geometry alone decides and the overpressure is on top of the car.
    fleet.add(saloonAt(1, 1.2));
    const combat = build({ fleet });
    combat.detonate(0, 2.4, 0);

    const hit = fleet.only(1);
    expect(hit).not.toBeNull();
    if (!hit) return;
    expect(hit.lift ?? 0).toBeLessThan(0);
    combat.dispose();
  });

  it('never reuses the last car\'s lift on the next one', () => {
    // The hit object is reused across every vehicle in a blast and across
    // blasts, so a field written only on some paths would follow the next car.
    const fleet = new RecordingFleet();
    fleet.add(saloonAt(1, SALOON.halfWidth));
    const combat = build({ fleet });
    combat.detonate(SALOON.halfWidth, 0.75, 0, {
      nx: -1, ny: 0, nz: 0, dirX: 1, dirY: 0, dirZ: 0,
      kind: 'vehicle', impact: 'metal', vehicleId: 1,
    });
    const thrown = fleet.only(1)?.lift ?? 0;
    expect(thrown).toBeGreaterThan(0);

    fleet.impacts.length = 0;
    // A second detonation far away reaches the same car not at all; a third
    // through its roof must report its OWN, downward lift.
    combat.detonate(0, 2.4, 0);
    const pressed = fleet.only(1)?.lift ?? 0;
    expect(pressed).toBeLessThan(thrown);
    combat.dispose();
  });

  it('turns the direct shove toward the way the rocket was going', () => {
    const fleet = new RecordingFleet();
    // The car is due north of the blast, so the radial push is +Z. The rocket
    // arrived travelling due east, so the sum has to lean east of north.
    fleet.add(saloonAt(1, 0, 3));
    const combat = build({ fleet });

    combat.detonate(0, 0.75, 0, {
      nx: 0, ny: 0, nz: -1,
      dirX: 1, dirY: 0, dirZ: 0,
      kind: 'vehicle', impact: 'metal', vehicleId: 1,
    });

    const hit = fleet.only(1);
    expect(hit).not.toBeNull();
    if (!hit) return;
    expect(hit.dirZ).toBeGreaterThan(0.2);
    expect(hit.dirX).toBeGreaterThan(0.2);
    expect(Math.hypot(hit.dirX, hit.dirZ)).toBeCloseTo(1, 6);
    combat.dispose();
  });

  it('leaves a car alone when nothing detonated near it', () => {
    const fleet = new RecordingFleet();
    fleet.add(saloonAt(1, 40));
    const combat = build({ fleet });
    combat.detonate(0, 0.75, 0);
    expect(fleet.impacts).toHaveLength(0);
    combat.dispose();
  });
});

describe('a warhead and the people around it', () => {
  it('kills at the seat, hurts at the rim and misses past it', () => {
    const crowd = new StubCrowd();
    crowd.add(0.2, 0);
    crowd.add(RADIUS * 0.6, 0);
    crowd.add(RADIUS + 2, 0);
    const combat = build({ crowd });

    combat.detonate(0, 0.875, 0);

    const seat = crowd.dealt(0);
    const rim = crowd.dealt(1);
    expect(seat).toBeCloseTo(PEAK, 4);
    expect(rim).toBeGreaterThan(0);
    expect(rim).toBeLessThan(seat * 0.5);
    expect(crowd.dealt(2), 'somebody outside the radius was hurt').toBe(0);
    combat.dispose();
  });
});

// -- the hit result reaching the mark -----------------------------------------

describe('the surface a warhead struck', () => {
  it('stands the scorch up on the wall a rocket flew into', () => {
    // A wall running north-south at x = 20, struck from the west. The rocket
    // is fired for real and the whole chain - probe, swept collision,
    // detonation, decal - runs; nothing is handed the normal.
    const boxes: ColliderBox[] = [
      { minX: 20, maxX: 24, minZ: -8, maxZ: 8, bottom: 0, top: 9, solid: true, surface: 'concrete' },
    ];
    const combat = build({ boxes, camera: eastwardCamera(0, 1.68, 0) });

    expect(combat.fireOnce()).toBe(true);
    for (let frame = 0; frame < 200 && combat.rocketsLive > 0; frame += 1) {
      combat.update(1 / 60, idle());
    }
    expect(combat.rocketsLive).toBe(0);

    const marks = combat.effects.markReport();
    expect(marks.length).toBeGreaterThan(0);
    // The scorch is the biggest mark by a wide margin: 0.62 of a 9.5 m radius
    // against a chip's few centimetres.
    const scorch = marks.reduce((a, b) => (b.size > a.size ? b : a));
    expect(scorch.size).toBeGreaterThan(1);

    // Standing UP on the wall's west face, not lying flat in the air.
    expect(scorch.nx).toBeCloseTo(-1, 6);
    expect(scorch.ny).toBeCloseTo(0, 6);
    // ...and just clear of the wall on the side the rocket came from.
    expect(scorch.x).toBeLessThan(20);
    expect(20 - scorch.x).toBeLessThan(0.06);
    combat.dispose();
  });

  it('throws the material of whatever it landed on, not a generic spray', () => {
    const spend = (contact?: BlastContact): number => {
      const combat = build();
      combat.detonate(0, 1, 0, contact);
      combat.effects.update(1 / 60, 0, 2, 0);
      const glows = combat.effects.stats.glows;
      combat.dispose();
      return glows;
    };
    const surface = (impact: ImpactKind): BlastContact => ({
      nx: 0, ny: 1, nz: 0, dirX: 0, dirY: -1, dirZ: 0, kind: 'world', impact, vehicleId: -1,
    });

    const bare = spend();
    // The debris budget of the struck material, exactly - which is only
    // possible because the material came out of the probe's hit result.
    expect(spend(surface('concrete')) - bare).toBe(impactBudget('concrete'));
    expect(spend(surface('metal')) - bare).toBe(impactBudget('metal'));
    expect(spend(surface('glass')) - bare).toBe(impactBudget('glass'));
    expect(impactBudget('concrete')).not.toBe(impactBudget('metal'));
  });

  it('does not let one rocket’s surface leak into the next rocket’s burst', () => {
    /*
     * The probe result is LATCHED between the probe that ends a flight and the
     * detonation that follows it, which is only safe if it is cleared once
     * used. A rocket that hits a wall followed by one that simply times out in
     * the air is the case that catches a latch that is never released: the
     * second burst would inherit the first one's wall and stand its scorch up
     * two hundred metres in the air.
     */
    const boxes: ColliderBox[] = [
      { minX: 20, maxX: 24, minZ: -8, maxZ: 8, bottom: 0, top: 9, solid: true, surface: 'concrete' },
    ];
    const camera = eastwardCamera(0, 1.68, 0);
    const combat = build({ boxes, camera, heightAt: (): number => 0 });

    expect(combat.fireOnce()).toBe(true);
    for (let frame = 0; frame < 200 && combat.rocketsLive > 0; frame += 1) {
      combat.update(1 / 60, idle());
    }
    const wall = combat.effects.markReport().reduce((a, b) => (b.size > a.size ? b : a));
    expect(wall.nx).toBeCloseTo(-1, 6);

    // Aim over the wall, at nothing at all, and wait out the reload.
    combat.effects.clear();
    camera.rotation.set(Math.PI / 3, -Math.PI / 2, 0, 'YXZ');
    camera.updateMatrixWorld(true);
    // The launcher holds one round and reloads itself for 3.6 s.
    let rearmed = false;
    for (let frame = 0; frame < 600 && !rearmed; frame += 1) {
      combat.update(1 / 60, idle());
      rearmed = combat.fireOnce();
    }
    expect(rearmed, 'the launcher never reloaded').toBe(true);
    for (let frame = 0; frame < 500 && combat.rocketsLive > 0; frame += 1) {
      combat.update(1 / 60, idle());
    }
    expect(combat.rocketsLive).toBe(0);

    const air = combat.effects.markReport().reduce((a, b) => (b.size > a.size ? b : a));
    // On the ground, facing up. Not the wall the LAST rocket found.
    expect(air.ny).toBeCloseTo(1, 6);
    expect(air.nx).toBeCloseTo(0, 6);
    expect(air.y).toBeLessThan(0.1);
    combat.dispose();
  });

  it('drops the scorch to the ground when the fuse simply ran out', () => {
    // Nothing to hit and no surface to describe: the mark has to fall to the
    // terrain under the burst or it hangs in the sky.
    const combat = build({ heightAt: (): number => 2.5 });
    combat.detonate(0, 14, 0);

    const marks = combat.effects.markReport();
    const scorch = marks.reduce((a, b) => (b.size > a.size ? b : a));
    expect(scorch.ny).toBeCloseTo(1, 6);
    expect(scorch.nx).toBeCloseTo(0, 6);
    expect(scorch.y).toBeGreaterThan(2.5);
    expect(scorch.y - 2.5).toBeLessThan(0.06);
    combat.dispose();
  });

  it('drops it to the ground when the thing it hit is about to drive away', () => {
    const fleet = new RecordingFleet();
    fleet.add(saloonAt(1, 3));
    const combat = build({ fleet, heightAt: (): number => 0 });
    combat.detonate(2.04, 1.5, 0, {
      nx: 0, ny: 1, nz: 0,
      dirX: 0, dirY: -1, dirZ: 0,
      kind: 'vehicle', impact: 'metal', vehicleId: 1,
    });

    const scorch = combat.effects.markReport().reduce((a, b) => (b.size > a.size ? b : a));
    // On the road under the car, where it will still be when the wreck is
    // towed - not welded to a panel that is about to roll over.
    expect(scorch.ny).toBeCloseTo(1, 6);
    expect(scorch.y).toBeLessThan(0.1);
    combat.dispose();
  });
});

// -- the pools ----------------------------------------------------------------

describe('repeated detonations', () => {
  it('never grow the effect pools past their capacity', () => {
    const combat = build();
    const fx = combat.effects;
    for (let i = 0; i < 400; i += 1) {
      combat.detonate((i % 20) * 3, 1, Math.floor(i / 20) * 3);
      if (i % 5 === 0) fx.update(1 / 60, 0, 2, 0);
      expect(fx.stats.glows).toBeLessThanOrEqual(FX_CAPACITY.glows);
      expect(fx.stats.marks).toBeLessThanOrEqual(FX_CAPACITY.marks);
      expect(fx.stats.smoke).toBeLessThanOrEqual(FX_CAPACITY.smoke);
    }
    fx.update(1 / 60, 0, 2, 0);
    // Saturated, not overflowing: every pool is full and none has grown.
    expect(fx.stats.glows).toBe(FX_CAPACITY.glows);
    expect(fx.stats.marks).toBe(FX_CAPACITY.marks);
    expect(fx.stats.smoke).toBe(FX_CAPACITY.smoke);
    combat.dispose();
  });

  it('drain back to nothing once the last one has burned out', () => {
    const combat = build();
    const fx = combat.effects;
    for (let i = 0; i < 40; i += 1) combat.detonate(i * 2, 1, 0);
    fx.update(1 / 60, 0, 2, 0);
    expect(fx.stats.smoke).toBeGreaterThan(0);

    // Past the longest-lived thing a blast leaves, which is its scorch.
    for (let i = 0; i < 60 * 60; i += 1) fx.update(1 / 60, 0, 2, 0);
    expect(fx.stats.glows).toBe(0);
    expect(fx.stats.marks).toBe(0);
    expect(fx.stats.smoke).toBe(0);
    combat.dispose();
  });

  it('spends a bounded number of effects on each one', () => {
    const combat = build();
    const fx = combat.effects;
    combat.detonate(0, 1, 0);
    fx.update(1 / 60, 0, 2, 0);
    const one = { ...fx.stats };
    // A single blast must not be able to fill a pool on its own, or two of
    // them in a street would delete each other.
    expect(one.glows).toBeLessThan(FX_CAPACITY.glows / 2);
    expect(one.smoke).toBeLessThan(FX_CAPACITY.smoke / 2);
    expect(one.marks).toBe(1);
    combat.dispose();
  });
});
