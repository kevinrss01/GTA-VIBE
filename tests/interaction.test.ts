/**
 * The E prompt, and the way it used to switch off exactly when you arrived.
 *
 * A door registers its interaction point on the APPROACH - 1.5 m out from the
 * threshold, where somebody standing to go in would be - and the facing test
 * used to be taken against that point. Walk up to the door and the point is
 * behind your shoulder, the dot product goes negative, and the prompt you were
 * walking towards disappears. The old near-field grace was 0.35 m, narrower
 * than one stride, so the whole usable band was about two metres deep and it
 * ended before the door did.
 *
 * These are pure geometry over `InteractionSystem`, so they run without a
 * renderer and pin the property that actually matters: from anywhere between
 * the pavement and the threshold, facing the door, the prompt is up.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { InteractionSystem } from '../src/player/Interaction';
import type { InteractionPoint } from '../src/world/build/types';

/** `InteractionSystem` binds a keydown listener on construction. */
const listeners: { type: string; fn: EventListener }[] = [];

beforeEach(() => {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope['window'] = {
    addEventListener(type: string, fn: EventListener) {
      listeners.push({ type, fn });
    },
    removeEventListener() {
      listeners.length = 0;
    },
  };
});

afterEach(() => {
  const scope = globalThis as unknown as Record<string, unknown>;
  delete scope['window'];
  listeners.length = 0;
});

/**
 * A door on the west face of a building, facing -X.
 *
 * The threshold is at x = 0; the approach point the world builder registers is
 * 1.5 m out at x = -1.5, and the landing inside is 1.8 m in at x = +1.8. Both
 * of those are the real numbers from `BuildingFactory`.
 */
function westDoor(): InteractionPoint {
  return {
    id: 'door-test',
    x: -1.5,
    y: 0,
    z: 0,
    radius: 2.8,
    prompt: 'Press E to enter',
    kind: 'door',
    target: { x: 1.8, y: 0, z: 0, heading: Math.PI / 2 },
    parcelId: 'parcel-test',
  };
}

/** Facing +X, which is straight at the door above. */
const FACING_DOOR = -Math.PI / 2;

describe('the door prompt', () => {
  it('is offered from the pavement all the way to the threshold', () => {
    const system = new InteractionSystem([westDoor()]);
    const missing: string[] = [];
    // From 4 m out to 0.35 m out - the closest a 0.34 m collision cylinder can
    // stand to the wall - in 5 cm steps.
    for (let x = -4; x <= -0.35; x += 0.05) {
      system.update(x, 0, 0, FACING_DOOR);
      if (!system.focused) missing.push(x.toFixed(2));
    }
    expect(missing, `no prompt at x = ${missing.join(', ')}`).toEqual([]);
  });

  it('is not offered with your back to the door', () => {
    const system = new InteractionSystem([westDoor()]);
    // Far enough out that the near-field grace does not apply.
    system.update(-4, 0, 0, Math.PI / 2);
    expect(system.focused).toBeNull();
  });

  it('is not offered from across the street', () => {
    const system = new InteractionSystem([westDoor()]);
    system.update(-9, 0, 0, FACING_DOOR);
    expect(system.focused).toBeNull();
  });

  it('ignores a door on another floor', () => {
    const system = new InteractionSystem([westDoor()]);
    system.update(-2, 12, 0, FACING_DOOR);
    expect(system.focused).toBeNull();
  });

  /*
   * Two doors on a terrace are a few metres apart, and the player walking past
   * them looks roughly at both. Without hysteresis the prompt swaps between
   * them as the heading wanders, which reads as the game being unable to
   * decide what you are standing in front of.
   */
  it('holds the door it has rather than flickering between neighbours', () => {
    const first = westDoor();
    const second: InteractionPoint = { ...westDoor(), id: 'door-b', z: 2.6 };
    const system = new InteractionSystem([first, second]);

    system.update(-2, 0, 0.2, FACING_DOOR);
    const held = system.focused?.id;
    expect(held).toBe('door-test');

    let swaps = 0;
    let previous = held;
    // A hand on a mouse wanders by a degree or two; that must not be enough.
    for (let i = 0; i < 40; i += 1) {
      const wobble = Math.sin(i * 0.7) * 0.03;
      system.update(-2, 0, 0.2, FACING_DOOR + wobble);
      if (system.focused?.id !== previous) {
        swaps += 1;
        previous = system.focused?.id;
      }
    }
    expect(swaps).toBe(0);
  });

  it('still hands over when the player really has moved to the other door', () => {
    const first = westDoor();
    const second: InteractionPoint = { ...westDoor(), id: 'door-b', z: 6 };
    const system = new InteractionSystem([first, second]);
    system.update(-2, 0, 0, FACING_DOOR);
    expect(system.focused?.id).toBe('door-test');
    system.update(-2, 0, 6, FACING_DOOR);
    expect(system.focused?.id).toBe('door-b');
  });
});
