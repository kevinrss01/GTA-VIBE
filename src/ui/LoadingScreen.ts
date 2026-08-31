/**
 * Loading screen and start gate.
 *
 * Two jobs. It reports progress while the city is built, and it holds a click
 * gate afterwards, because pointer lock and the audio context can only be
 * started from a real user gesture. The gate deliberately does not start music:
 * it hands control back and nothing else, so the game opens silent and the
 * music control is the only thing that changes that.
 *
 * ============================ WHY THE BAR IS LIKE THIS ======================
 *
 * The progress used to be eleven hand-picked fractions, and they bore no
 * relation to how long anything took. Measured on the dev server with a warm
 * cache, "Compiling shaders" was shown from 97 to 100 per cent and took 2.9 s
 * of an 11.4 s load - a QUARTER OF THE WAIT spent watching a bar that said it
 * was finished. "Raising the buildings" got 22 points of bar for 9 per cent of
 * the time. A player reading that bar was being told something untrue.
 *
 * Three things fix it, and all three are needed:
 *
 * 1. THE PHASES ARE WEIGHTED BY MEASURED TIME, not by feel. See `PHASES`.
 *    One second of loading is now one second of bar wherever it is spent.
 *
 * 2. THE BAR IS A COMPOSITOR ANIMATION, not a width. Almost all of this load
 *    is synchronous main-thread work, so nothing JavaScript writes can be
 *    painted while a phase is running - and `width` is a layout property, so a
 *    CSS transition on it stalls with everything else. `transform: scaleX` is
 *    animated off the main thread, so ONE paint at a phase boundary starts a
 *    glide that keeps moving smoothly through the whole blocking phase behind
 *    it. That is what makes the bar look alive rather than frozen, and it
 *    costs nothing.
 *
 * 3. THE PHASES THAT CAN MEASURE THEMSELVES DO. Downloading assets and
 *    compiling shaders are both `await`-driven, so the main thread is free and
 *    real per-item progress can be reported and painted as it happens - which
 *    matters most on a cold connection, where downloading is the phase that
 *    actually takes the time and the prediction below would be furthest out.
 *
 * The number beside the label is read off the same value the bar is gliding
 * to. It updates on every frame the main thread can spare and holds still
 * during a blocking phase, which is the honest thing for it to do: the bar
 * carries the motion and the number carries the fact.
 */

import './ui.css';
import { CITY_NAME, GAME_NAME } from '../story';

const FADE_MS = 420;

/** How long an exact, measured update takes to ease into place. */
const CORRECTION_MS = 180;

/**
 * The boot, phase by phase, and how long each one is expected to take.
 *
 * MEASURED, from a cold production load on 2026-08-31 - timestamps taken off
 * the loading screen itself, on a build served from an origin the browser had
 * never seen:
 *
 *   plan 1.11 s · streets 1.12 · buildings 1.08 · interiors 0.77 ·
 *   airfield 0.96 · dressing 1.07 · assets 0.53 · bake 0.43 · wake 1.05 ·
 *   shaders 3.90     (12.0 s in total)
 *
 * The same build warm does the whole thing in 1.2 s, and the phases do not
 * shrink together: the build loops come down by a factor of thirty while the
 * shader compile only halves. That is why the estimator learns a separate
 * speed for each KIND of work below rather than one for the boot.
 *
 * THESE ARE A PRIOR, NOT A SCHEDULE. The same build, warm, does the whole
 * thing in 1.2 s, and the ratios do not survive that: the download is a third
 * of a second on localhost and can be most of a minute over the internet.
 * A bar with a fixed slice per phase is therefore wrong on almost every real
 * load, which is what the eleven hand-picked fractions this replaced were.
 *
 * So the numbers below are only where the estimate STARTS. `LoadingScreen`
 * rescales everything that is left by how fast this machine has actually been
 * going, and the download phase - the one that varies most - is counted file
 * by file rather than predicted at all. See `refresh`.
 */
const PHASES = [
  { id: 'plan', label: 'Planning Meridian Bay', seconds: 1.11, kind: 'cpu' },
  { id: 'streets', label: 'Laying out the streets', seconds: 1.12, kind: 'cpu' },
  { id: 'buildings', label: 'Raising the buildings', seconds: 1.08, kind: 'cpu' },
  { id: 'interiors', label: 'Fitting out the interiors', seconds: 0.77, kind: 'cpu' },
  { id: 'airfield', label: 'Grading the airfield', seconds: 0.96, kind: 'cpu' },
  { id: 'dressing', label: 'Dressing the streets', seconds: 1.07, kind: 'cpu' },
  { id: 'assets', label: 'Downloading generated assets', seconds: 0.53, kind: 'net' },
  { id: 'bake', label: 'Baking the city', seconds: 0.43, kind: 'cpu' },
  { id: 'wake', label: 'Waking the city', seconds: 1.05, kind: 'cpu' },
  /*
   * Between the two measurements rather than at either: 3.9 s cold on a driver
   * with an empty shader cache, 1.7 s once it is warm, on the same machine. It
   * cannot be learned before it runs - nothing else in the boot is GPU-bound -
   * so it is the one prior that is a genuine guess, and it is deliberately a
   * low one. The phase reports its own progress object by object, so an
   * underestimate is corrected within a few hundred milliseconds of entering
   * it, while an overestimate parks the bar low for the whole compile.
   */
  { id: 'shaders', label: 'Compiling shaders', seconds: 2.4, kind: 'gpu' },
] as const;

type PhaseKind = (typeof PHASES)[number]['kind'];

export type LoadPhaseId = (typeof PHASES)[number]['id'];

/** Seconds still to come after each phase, at the priors, split by kind. */
const AFTER: readonly Readonly<Record<PhaseKind, number>>[] = PHASES.map((_, i) => {
  const rest: Record<PhaseKind, number> = { cpu: 0, net: 0, gpu: 0 };
  for (const phase of PHASES.slice(i + 1)) rest[phase.kind] += phase.seconds;
  return rest;
});

/**
 * How far the observed speed may be trusted to differ from the priors.
 *
 * A machine genuinely can be eight times slower than the reference, and the
 * estimate has to follow it there or the bar sticks. The floor matters more:
 * one phase that happens to be trivially fast must not convince the estimator
 * that the whole remaining boot is instant.
 *
 * PER KIND, and that is the correction that mattered. A single speed factor
 * learned from the build loops was applied to the shader compile as well, and
 * they do not share a bottleneck: measured on this machine the CPU phases run
 * about thirty times faster than the reference while the driver's compile runs
 * about twice as fast, so a bar scaled by the CPU raced to two thirds and then
 * sat there for the seventeen hundred milliseconds the compile actually took.
 * Work is learned from work of the same kind, or not at all.
 */
const SCALE_MIN = 0.1;
const SCALE_MAX = 8;

/** The bar never claims to be finished before the boot says it is. */
const PREDICTION_CEILING = 0.99;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Whether the machine has asked for less movement.
 *
 * Checked in JavaScript as well as in the stylesheet because the glide's
 * duration is written INLINE, and an inline style beats the media query that
 * would otherwise have shortened it. The menu's own `data-mb-motion` switch
 * does not need this - that rule carries `!important` - but it is not applied
 * until the pause menu exists, which is long after this screen is on the
 * page.
 */
function prefersLessMotion(): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export class LoadingScreen {
  readonly element: HTMLElement;

  private readonly bar: HTMLElement;
  private readonly track: HTMLElement;
  private readonly label: HTMLElement;
  private readonly percent: HTMLElement;
  private readonly startButton: HTMLButtonElement;
  private readonly gate: HTMLElement;

  private started: Promise<void> | null = null;
  private resolveStarted: (() => void) | null = null;
  private fadeTimer = 0;
  private disposed = false;

  /** The glide currently running: where it began, where it ends, and when. */
  private glideFrom = 0;
  private glideTo = 0;
  private glideAt = 0;
  private glideMs = 0;
  /*
   * The estimator.
   *
   * `phaseAt` is when the phase in flight began; `spentPrior` is the sum of
   * the PRIORS of the phases already finished and `spent` the seconds they
   * really took, and their ratio is how much faster or slower this machine is
   * running than the reference. `phase` is the index into `PHASES` of the one
   * in flight, and `from`/`to` the slice of the bar the current estimate gives
   * it - recomputed every time anything is learned.
   */
  private phaseAt = now();
  private phase = -1;
  private spent = 0;
  /** Seconds really taken, and seconds the priors expected, per kind of work. */
  private readonly took: Record<PhaseKind, number> = { cpu: 0, net: 0, gpu: 0 };
  private readonly expected: Record<PhaseKind, number> = { cpu: 0, net: 0, gpu: 0 };
  private from = 0;
  private to = 0;
  /** Last integer written, so an unchanged frame touches no DOM. */
  private shownPercent = -1;
  private ticker = 0;

  private readonly baseUrl: string;

  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
    this.element = document.createElement('div');
    this.element.className = 'mb-loading';

    const panel = document.createElement('div');
    panel.className = 'mb-loading__panel';

    const eyebrow = document.createElement('p');
    eyebrow.className = 'mb-loading__eyebrow';
    eyebrow.textContent = CITY_NAME;

    const title = document.createElement('h1');
    title.className = 'mb-loading__title';
    title.textContent = GAME_NAME;

    this.track = document.createElement('div');
    this.track.className = 'mb-loading__track';
    this.track.setAttribute('role', 'progressbar');
    this.track.setAttribute('aria-valuemin', '0');
    this.track.setAttribute('aria-valuemax', '100');
    this.track.setAttribute('aria-valuenow', '0');
    this.bar = document.createElement('div');
    this.bar.className = 'mb-loading__bar';
    this.bar.style.transform = 'scaleX(0)';
    this.track.append(this.bar);

    const status = document.createElement('div');
    status.className = 'mb-loading__status';
    this.label = document.createElement('p');
    this.label.className = 'mb-loading__label';
    this.label.textContent = 'Preparing';
    this.percent = document.createElement('p');
    this.percent.className = 'mb-loading__percent';
    this.percent.textContent = '0%';
    status.append(this.label, this.percent);

    this.gate = document.createElement('div');
    this.gate.className = 'mb-loading__gate';
    this.startButton = document.createElement('button');
    this.startButton.type = 'button';
    this.startButton.className = 'mb-button mb-button--primary mb-loading__start';
    this.startButton.textContent = `Click to explore ${CITY_NAME}`;
    this.startButton.addEventListener('click', this.onStart);
    this.gate.append(this.startButton);

    panel.append(eyebrow, title, this.track, status, this.gate);
    this.element.append(panel);
    this.adoptKeyArt();
    this.startTicker();
  }

  /**
   * Puts the generated key art behind the panel, IF it is there.
   *
   * Probed with an `Image` rather than written into the stylesheet, and that
   * is the whole point: `tools/generate-key-art.mjs` writes
   * `public/art/key-art.jpg`, and a build made before anybody has run it has
   * no such file. A CSS `background-image` would log a failed request on every
   * single load; a probe that quietly fails leaves the flat dark ground the
   * screen already had, which is a complete design on its own.
   */
  private adoptKeyArt(): void {
    if (typeof Image === 'undefined') return;
    const url = `${this.baseUrl}art/key-art.jpg`;
    const probe = new Image();
    probe.onload = (): void => {
      this.element.style.backgroundImage = `url(${JSON.stringify(url)})`;
      this.element.classList.add('has-art');
    };
    probe.src = url;
  }

  /**
   * Enters a phase, and sets the bar gliding across its whole share of the
   * bar over the time that phase is expected to take.
   *
   * The glide is the prediction. A phase that runs long leaves the bar parked
   * at its own boundary rather than running into the next one's share, and a
   * phase that finishes early is simply overtaken by the next `beginPhase`.
   * Neither can go backwards.
   */
  beginPhase(id: LoadPhaseId): void {
    if (this.disposed) return;
    const index = PHASES.findIndex((phase) => phase.id === id);
    if (index < 0) return;

    // Close the phase that has just finished, and learn from what it cost.
    const done = this.phase >= 0 ? PHASES[this.phase] : undefined;
    if (done) {
      const cost = (now() - this.phaseAt) / 1000;
      this.spent += cost;
      this.took[done.kind] += cost;
      this.expected[done.kind] += done.seconds;
    }
    this.phase = index;
    this.phaseAt = now();

    const label = PHASES[index]?.label ?? '';
    if (this.label.textContent !== label) this.label.textContent = label;
    this.refresh(0);
  }

  /**
   * Recomputes where this phase sits on the bar and sets the glide going.
   *
   * `within` is measured progress inside the phase, 0 when there is none to
   * be had. The whole estimate is rebuilt from scratch every time, because
   * every input can move: how fast the machine has been (`scale`), how long
   * this phase has already run, and - for the download - how much of it is
   * actually done.
   *
   * The position is TIME, not phases: elapsed over elapsed-plus-remaining. A
   * machine five times slower than the reference reads the same percentage at
   * the same point in its own boot, which is the only definition of "real
   * progress" that survives leaving this laptop.
   */
  private refresh(within: number): void {
    const index = this.phase;
    const phase = PHASES[index];
    const prior = phase?.seconds ?? 0;
    const scale = this.scaleFor(phase?.kind ?? 'cpu');

    const inPhase = (now() - this.phaseAt) / 1000;
    /*
     * What this phase will cost in the end. The prior, scaled - but never less
     * than it has already taken, and, once a counted phase is far enough in to
     * be believed, its own observed rate. That last term is what lets a
     * thirty-second download on a slow line push the rest of the bar along in
     * front of it instead of piling up at one boundary.
     */
    let expect = Math.max(prior * scale, inPhase);
    if (within > 0.05) expect = Math.max(expect, inPhase / within);

    const before = this.spent;
    const rest = AFTER[index] ?? { cpu: 0, net: 0, gpu: 0 };
    const after =
      rest.cpu * this.scaleFor('cpu') +
      rest.net * this.scaleFor('net') +
      rest.gpu * this.scaleFor('gpu');
    const total = Math.max(1e-3, before + expect + after);
    this.from = Math.min(PREDICTION_CEILING, before / total);
    this.to = Math.min(PREDICTION_CEILING, (before + expect) / total);

    const still = prefersLessMotion();
    if (within > 0) {
      this.glide(this.from + (this.to - this.from) * within, still ? 0 : CORRECTION_MS);
      return;
    }
    if (still) {
      // No prediction without motion: a glide is what makes a predicted
      // position honest, because it arrives over the time the phase takes.
      this.glide(Math.max(this.value(), this.from), 0, Math.max(this.value(), this.from));
      return;
    }
    // The boundary is a fact and the position inside it is the prediction, so
    // the glide always starts from the boundary this phase has actually
    // reached - otherwise a machine faster than the priors lags further behind
    // with every phase.
    const start = Math.max(this.value(), this.from);
    this.glide(this.to, Math.max(0, expect - inPhase) * 1000, start);
  }

  /**
   * Exact progress inside the current phase, for the phases that can count.
   *
   * Overrides the prediction with a short correction rather than a jump, and
   * only ever forwards: a download that finishes early should pull the bar
   * along, never drag it back.
   */
  reportPhase(done: number, total: number): void {
    if (this.disposed || this.phase < 0 || total <= 0) return;
    this.refresh(Math.min(1, Math.max(0, done / total)));
  }

  /** Everything is built. Fills the bar and names the state. */
  finish(): void {
    if (this.disposed) return;
    this.phase = -1;
    this.label.textContent = 'Ready';
    this.glide(1, prefersLessMotion() ? 0 : CORRECTION_MS);
    this.paint();
  }

  /** Shows the "click to start" gate; resolves when the player clicks. */
  awaitStart(): Promise<void> {
    if (this.started) return this.started;
    this.started = new Promise<void>((resolve) => {
      this.resolveStarted = resolve;
    });
    if (!this.disposed) {
      this.element.classList.add('is-ready');
      // Focusing the gate makes Enter and Space work as well as a click, and
      // pointer lock is not held yet, so nothing can be stolen from the game.
      this.startButton.focus();
    }
    return this.started;
  }

  hide(): void {
    if (this.disposed) return;
    this.stopTicker();
    this.element.classList.add('is-hidden');
    // Out of the tab order at once, not when the fade finishes: a background
    // tab never finishes the fade, and the gate must not outlive the game start.
    this.element.setAttribute('inert', '');
    if (this.fadeTimer !== 0) window.clearTimeout(this.fadeTimer);
    this.fadeTimer = window.setTimeout(() => {
      this.fadeTimer = 0;
      this.element.hidden = true;
    }, FADE_MS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTicker();
    if (this.fadeTimer !== 0) window.clearTimeout(this.fadeTimer);
    this.startButton.removeEventListener('click', this.onStart);
    // Never leave an awaited start hanging: a caller blocked on it would stall.
    this.resolveStarted?.();
    this.resolveStarted = null;
    this.element.remove();
  }

  // -- the bar ---------------------------------------------------------------

  /**
   * Where the bar is right now, following the glide by hand.
   *
   * A SECOND CLOCK, deliberately. The glide is a compositor animation - that is
   * what keeps it moving while the main thread is inside a build loop and
   * cannot repaint - and the compositor will not tell the main thread where it
   * has got to. `getComputedStyle` was tried and does not reliably report a
   * transition in flight. So the number runs the same linear interpolation the
   * transition is running, from the same start, target and duration, and the
   * two agree to within a frame on any tab that is actually being drawn.
   */
  private value(): number {
    if (this.glideMs <= 0) return this.glideTo;
    const through = Math.min(1, Math.max(0, (now() - this.glideAt) / this.glideMs));
    return this.glideFrom + (this.glideTo - this.glideFrom) * through;
  }

  /**
   * How fast this machine has been at one kind of work, against the priors.
   *
   * One where nothing of that kind has finished yet: an unmeasured kind is
   * predicted at its reference cost rather than at somebody else's speed.
   */
  private scaleFor(kind: PhaseKind): number {
    const expected = this.expected[kind];
    if (expected <= 0) return 1;
    return Math.min(SCALE_MAX, Math.max(SCALE_MIN, this.took[kind] / expected));
  }

  /**
   * Starts a linear glide to `to` over `ms`, and hands the same animation to
   * the compositor.
   *
   * `transform` with a LINEAR timing function, both because the underlying
   * progress really is roughly linear in time and because the compositor has
   * to be able to run it alone: an eased curve would still be correct, but the
   * point of this is that it keeps moving while the main thread is inside a
   * build loop and cannot repaint anything.
   */
  private glide(to: number, ms: number, from = this.value()): void {
    const at = Math.max(from, 0);
    this.glideFrom = at;
    this.glideTo = Math.max(at, Math.min(1, to));
    this.glideAt = now();
    this.glideMs = Math.max(0, ms);
    this.bar.style.transitionDuration = `${Math.round(this.glideMs)}ms`;
    // Written from the CURRENT value first, so a correction that arrives
    // mid-glide starts from where the bar visibly is rather than snapping back
    // to wherever the last transition began.
    this.bar.style.transform = `scaleX(${at})`;
    // Reading a layout property flushes the style above, which is what makes
    // the two-step actually produce an animation instead of one assignment.
    void this.bar.offsetWidth;
    this.bar.style.transform = `scaleX(${this.glideTo})`;
    this.paint();
  }

  /** Writes the number and the ARIA value. Cheap, and skips an unchanged frame. */
  private paint(): void {
    const percent = Math.round(this.value() * 100);
    if (percent === this.shownPercent) return;
    this.shownPercent = percent;
    this.percent.textContent = `${percent}%`;
    this.track.setAttribute('aria-valuenow', `${percent}`);
  }

  private startTicker(): void {
    if (typeof requestAnimationFrame !== 'function') return;
    const tick = (): void => {
      if (this.disposed) return;
      this.paint();
      this.ticker = requestAnimationFrame(tick);
    };
    this.ticker = requestAnimationFrame(tick);
  }

  private stopTicker(): void {
    if (this.ticker !== 0 && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.ticker);
    }
    this.ticker = 0;
  }

  private readonly onStart = (event: MouseEvent): void => {
    event.stopPropagation();
    this.startButton.blur();
    this.element.classList.remove('is-ready');
    const resolve = this.resolveStarted;
    this.resolveStarted = null;
    resolve?.();
  };
}
