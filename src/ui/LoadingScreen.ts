/**
 * Loading screen and start gate.
 *
 * Two jobs. It reports progress while the city is built, and it holds a click
 * gate afterwards, because pointer lock and the audio context can only be
 * started from a real user gesture. The gate deliberately does not start music:
 * it hands control back and nothing else, so the game opens silent and the
 * music control is the only thing that changes that.
 */

import './ui.css';

const FADE_MS = 420;

export class LoadingScreen {
  readonly element: HTMLElement;

  private readonly bar: HTMLElement;
  private readonly track: HTMLElement;
  private readonly label: HTMLElement;
  private readonly startButton: HTMLButtonElement;
  private readonly gate: HTMLElement;

  private started: Promise<void> | null = null;
  private resolveStarted: (() => void) | null = null;
  private fadeTimer = 0;
  private progress = -1;
  private disposed = false;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'mb-loading';

    const panel = document.createElement('div');
    panel.className = 'mb-loading__panel';

    const eyebrow = document.createElement('p');
    eyebrow.className = 'mb-loading__eyebrow';
    eyebrow.textContent = 'A city on foot';

    const title = document.createElement('h1');
    title.className = 'mb-loading__title';
    title.textContent = 'Meridian Bay';

    this.track = document.createElement('div');
    this.track.className = 'mb-loading__track';
    this.track.setAttribute('role', 'progressbar');
    this.track.setAttribute('aria-valuemin', '0');
    this.track.setAttribute('aria-valuemax', '100');
    this.track.setAttribute('aria-valuenow', '0');
    this.bar = document.createElement('div');
    this.bar.className = 'mb-loading__bar';
    this.track.append(this.bar);

    this.label = document.createElement('p');
    this.label.className = 'mb-loading__label';
    this.label.textContent = 'Preparing';

    this.gate = document.createElement('div');
    this.gate.className = 'mb-loading__gate';
    this.startButton = document.createElement('button');
    this.startButton.type = 'button';
    this.startButton.className = 'mb-button mb-button--primary mb-loading__start';
    this.startButton.textContent = 'Click to explore Meridian Bay';
    this.startButton.addEventListener('click', this.onStart);
    this.gate.append(this.startButton);

    panel.append(eyebrow, title, this.track, this.label, this.gate);
    this.element.append(panel);
  }

  setProgress(fraction: number, label: string): void {
    if (this.disposed) return;
    const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
    const percent = Math.round(clamped * 100);
    if (percent !== this.progress) {
      this.progress = percent;
      this.bar.style.width = `${percent}%`;
      this.track.setAttribute('aria-valuenow', `${percent}`);
    }
    if (this.label.textContent !== label) this.label.textContent = label;
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
    if (this.fadeTimer !== 0) window.clearTimeout(this.fadeTimer);
    this.startButton.removeEventListener('click', this.onStart);
    // Never leave an awaited start hanging: a caller blocked on it would stall.
    this.resolveStarted?.();
    this.resolveStarted = null;
    this.element.remove();
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
