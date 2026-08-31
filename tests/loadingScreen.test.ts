// @vitest-environment jsdom
/**
 * The loading screen's progress, as a number a player is entitled to believe.
 *
 * The bar it replaced was eleven hand-picked fractions with no relation to how
 * long anything took: "Compiling shaders" was shown from 97 to 100 per cent and
 * was a quarter of the wait. Everything asserted here is a property that has to
 * hold for the replacement to be worth more than the fractions were - it never
 * goes backwards, it never says it is finished before it is, a phase cannot
 * spend the next phase's share, and what it learns about one kind of work is
 * not applied to another.
 *
 * jsdom has no compositor and no layout, so what is NOT asserted here is how
 * the bar looks moving. That is a browser judgement and it is made in one; see
 * `docs/arrival-and-the-map.md`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoadingScreen, type LoadPhaseId } from '../src/ui/LoadingScreen';

/** The boot's phases in the order `main.ts` runs them. */
const ORDER: LoadPhaseId[] = [
  'plan',
  'streets',
  'buildings',
  'interiors',
  'airfield',
  'dressing',
  'assets',
  'bake',
  'wake',
  'shaders',
];

let clock = 0;

function percentOf(screen: LoadingScreen): number {
  const text = screen.element.querySelector('.mb-loading__percent')?.textContent ?? '';
  return Number.parseInt(text, 10);
}

/** Moves the fake clock on and lets the screen repaint from it. */
function advance(screen: LoadingScreen, seconds: number): void {
  clock += seconds * 1000;
  // The rAF ticker is what normally repaints; jsdom has none, so the same
  // painting path is reached through a no-op report on the phase in flight.
  screen.reportPhase(0, 0);
}

beforeEach(() => {
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  // jsdom has no compositor, so nothing reads `transform` back; the screen's
  // own interpolation is the value under test.
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loading progress', () => {
  it('starts at nothing and only finishes when the boot says so', () => {
    const screen = new LoadingScreen();
    expect(percentOf(screen)).toBe(0);
    for (const id of ORDER) {
      screen.beginPhase(id);
      advance(screen, 1);
      expect(percentOf(screen), `${id} claimed to be finished`).toBeLessThan(100);
    }
    screen.finish();
    // The correction is a glide, so let it land.
    clock += 1000;
    screen.finish();
    expect(percentOf(screen)).toBe(100);
    screen.dispose();
  });

  it('never goes backwards, whatever the phases cost', () => {
    const screen = new LoadingScreen();
    let worst = 0;
    let previous = 0;
    // Wildly uneven: some phases instant, some ten times their prior.
    const costs = [0.01, 4, 0.01, 3, 0.01, 2, 6, 0.01, 0.01, 5];
    ORDER.forEach((id, i) => {
      screen.beginPhase(id);
      for (let step = 0; step < 8; step += 1) {
        advance(screen, (costs[i] ?? 1) / 8);
        const value = percentOf(screen);
        worst = Math.min(worst, value - previous);
        previous = value;
      }
    });
    expect(worst).toBe(0);
    screen.dispose();
  });

  it('does not let a phase that runs long spend the next phase share', () => {
    const screen = new LoadingScreen();
    screen.beginPhase('plan');
    advance(screen, 1.11);
    const atBoundary = percentOf(screen);
    // Ten times its prior, with nothing to report.
    advance(screen, 11);
    const afterOverrun = percentOf(screen);
    screen.beginPhase('streets');
    const nextPhase = percentOf(screen);
    /*
     * An overrun may move the bar - the estimate of the whole boot grows with
     * it - but it must not carry it past where the NEXT phase begins, or the
     * bar would have spent progress the boot has not made.
     */
    expect(afterOverrun).toBeGreaterThanOrEqual(atBoundary);
    expect(afterOverrun).toBeLessThanOrEqual(nextPhase);
    screen.dispose();
  });

  it('moves within a phase that can count itself', () => {
    const screen = new LoadingScreen();
    for (const id of ORDER.slice(0, ORDER.indexOf('assets'))) {
      screen.beginPhase(id);
      advance(screen, 1);
    }
    screen.beginPhase('assets');
    const start = percentOf(screen);
    const seen: number[] = [];
    for (let file = 1; file <= 8; file += 1) {
      clock += 400;
      screen.reportPhase(file, 8);
      seen.push(percentOf(screen));
    }
    /*
     * Real progress, not a prediction. The download is about a twentieth of the
     * bar at the priors, and this one runs six times its prior with eight
     * reports along the way, so what is asserted is that the count carries the
     * number the width of that share rather than parking it at the boundary.
     */
    expect(seen[0]).toBeGreaterThan(start);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] as number);
    }
    expect(seen[seen.length - 1]).toBeGreaterThanOrEqual((seen[0] as number) + 4);
    screen.dispose();
  });

  it('does not apply what it learned about the CPU to the shader compile', () => {
    /*
     * THE DEFECT THIS PINS. A single speed factor learned from the build loops
     * was applied to every phase left, and the shader compile does not share a
     * bottleneck with them: measured, the loops run about thirty times faster
     * than the reference on this machine while the driver's compile only
     * halves. The bar raced to two thirds and then sat there for the whole
     * compile - the same lie the hand-picked fractions told.
     *
     * So: run every CPU phase at a hundredth of its prior and check the bar
     * still reserves most of itself for the compile that has not happened.
     */
    const screen = new LoadingScreen();
    for (const id of ORDER) {
      if (id === 'shaders') break;
      screen.beginPhase(id);
      advance(screen, 0.01);
    }
    screen.beginPhase('shaders');
    expect(percentOf(screen)).toBeLessThan(35);
    screen.dispose();
  });

  it('publishes the same number to assistive technology', () => {
    const screen = new LoadingScreen();
    screen.beginPhase('plan');
    advance(screen, 0.5);
    const track = screen.element.querySelector('.mb-loading__track');
    expect(track?.getAttribute('aria-valuenow')).toBe(`${percentOf(screen)}`);
    screen.dispose();
  });

  it('names the phase it is in', () => {
    const screen = new LoadingScreen();
    screen.beginPhase('buildings');
    expect(screen.element.querySelector('.mb-loading__label')?.textContent).toBe(
      'Raising the buildings',
    );
    screen.finish();
    expect(screen.element.querySelector('.mb-loading__label')?.textContent).toBe('Ready');
    screen.dispose();
  });
});
