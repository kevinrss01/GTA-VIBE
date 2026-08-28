/**
 * The pause is wired the only way it can actually work.
 *
 * WHY THIS IS A SOURCE-TEXT TEST. `main.ts` builds a `WebGLRenderer` on the
 * way to its first statement, so it cannot be imported in Node at all - the
 * same reason `tests/combat.test.ts` reads it as text to pin the `onDeath`
 * ordering. What is asserted here is the SHAPE of the wiring, which is exactly
 * the thing that regresses: somebody adds a second way to resume, forgets one
 * of the three systems, and the world quietly keeps running behind the menu.
 *
 * The behaviour itself is verified in a real browser, where the frame counter
 * can be read before and after. This file is the guard rail, not the proof.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const engine = readFileSync(new URL('../src/core/Engine.ts', import.meta.url), 'utf8');

describe('the engine holds the world still', () => {
  it('skips the whole update when paused, and still renders', () => {
    // Everything the game simulates hangs off `onUpdate`, so not calling it IS
    // the pause. Rendering must continue or the world vanishes behind the menu.
    expect(engine).toMatch(/if \(!this\.paused\) this\.onUpdate\?\.\(/);
    const tick = engine.slice(engine.indexOf('private readonly tick'));
    const body = tick.slice(0, tick.indexOf('\n  };'));
    expect(body).toContain('this.renderFrame();');
    // The render call must NOT be inside the paused guard.
    expect(body).not.toMatch(/if \(!this\.paused\)[\s\S]{0,200}this\.renderFrame\(\);/);
  });

  it('still consumes the frame delta while paused', () => {
    /*
     * `Clock.getDelta` reports the time since it was last ASKED. Skipping the
     * call while the menu is open would hand the first resumed frame the whole
     * length of the pause; the 0.1 s clamp would cap it, but a tenth of a
     * second of traffic, gunfire and falling rockets still arrives in one
     * step. So the delta is read every frame and thrown away.
     */
    const tick = engine.slice(engine.indexOf('private readonly tick'));
    const body = tick.slice(0, tick.indexOf('\n  };'));
    const readAt = body.indexOf('this.clock.getDelta()');
    const guardAt = body.indexOf('if (!this.paused)');
    expect(readAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(guardAt);
  });

  it('freezes the clock the world is told about, not just the update', () => {
    /*
     * Traffic signals and pedestrian crossings phase off `elapsed` as an
     * ABSOLUTE time. Handing them wall-clock seconds after a two-minute pause
     * would jump every light in the city on the first resumed frame, so the
     * simulation clock only advances on frames that were actually simulated.
     */
    expect(engine).toMatch(/this\.onUpdate\?\.\(dt, \(this\.simTime \+= dt\)\)/);
    expect(engine).not.toContain('this.clock.elapsedTime');
  });
});

describe('main.ts routes every pause and resume through one place', () => {
  it('stops the simulation, the controller and the audio together', () => {
    const at = main.indexOf('const setGamePaused');
    expect(at).toBeGreaterThan(-1);
    const fn = main.slice(at, main.indexOf('\n  };', at));
    expect(fn).toContain('engine.setPaused(paused)');
    expect(fn).toContain('controller.setPaused(paused)');
    expect(fn).toContain('audio.setGamePaused(paused)');
  });

  it('has exactly one switch for the world, and three understood ones for the player', () => {
    /*
     * ONE `engine.setPaused` is the point: it is the only thing that stops the
     * simulation, so a second call site is a second, divergent pause.
     *
     * `controller.setPaused` is a different and weaker thing - it takes the
     * keyboard and the mouse-look away from the player without stopping the
     * world - and there are exactly three places that legitimately want it:
     *
     *   `paused`  inside `setGamePaused`, where the world stops too
     *   `open`    the gun shop, a modal the city is allowed to run behind
     *   `paused`  the respawn director, which takes control away while the
     *             player is lying in the road - and the city MUST keep running
     *             there, or being killed would freeze the game
     *
     * A fourth is almost certainly somebody pausing half the game.
     */
    const args = [...main.matchAll(/controller\.setPaused\(([^)]*)\)/g)].map((m) => m[1]);
    expect(args.sort()).toEqual(['open', 'paused', 'paused']);
    expect([...main.matchAll(/engine\.setPaused\(/g)]).toHaveLength(1);
  });

  it('does not let regaining pointer lock resume a game the menu is still over', () => {
    // Escape releases the lock, so a stray click on the canvas behind the
    // overlay used to hand control straight back with the menu still up.
    expect(main).toMatch(/if \(!pause\.visible\) setGamePaused\(false\)/);
  });

  it('resumes from the menu and from the HUD, and both take the same route', () => {
    const resumes = [...main.matchAll(/onResume: \(\) => \{([\s\S]*?)\},/g)].map((m) => m[1] ?? '');
    expect(resumes.length).toBeGreaterThanOrEqual(2);
    for (const body of resumes) {
      expect(body).toContain('setGamePaused(false)');
      expect(body).toContain('pause.hide()');
    }
  });
});
