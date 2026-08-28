/**
 * The heads-up display.
 *
 * Deliberately almost empty. There is no avatar, no body, no hands, no weapon
 * and no health: the player is a viewpoint in a city, and the HUD's whole job
 * is to say where you are, what you can do here, and whether the music is on.
 *
 * Everything in this layer is `pointer-events: none` except the music control,
 * so the canvas keeps its clicks and its pointer lock. The one control that
 * does take clicks stops the event from propagating, because the canvas listens
 * for clicks of its own to re-acquire the lock.
 *
 * Key bindings are not owned here. The application binds the keyboard once (M
 * for the map, F3 for the diagnostics, Escape for pause) and drives this class
 * through `setStatsVisible` and `setPointerLocked`; binding the same keys twice
 * would cancel every toggle out.
 */

import './ui.css';
import { formatMoney } from '../player/money';
import { DISTRICT_LABELS } from './Minimap';
import type { ControlHint } from './platform';
import { CONTROL_HINTS, musicLabel, type QualityLevel } from './PauseMenu';

export interface HudCallbacks {
  onMusicToggle(enabled: boolean): void;
  /** Invoked by the pause menu the application pairs with this HUD. */
  onResume(): void;
  onQualityChange(level: QualityLevel): void;
}

export interface HudStats {
  fps: number;
  p95Ms: number;
  worstMs: number;
  hitches: number;
  updateMs: number;
  renderMs: number;
  bufferWidth: number;
  bufferHeight: number;
  drawCalls: number;
  triangles: number;
  memoryMB: number | null;
}

/** How long the control hint stays up after the game starts. */
const HINT_MS = 12_000;

/**
 * The contextual control panel shown while the player is flying.
 *
 * Whether it is up is decided by the caller - the flight model knows whether
 * the aeroplane is stopped, rolling or jammed, and the HUD does not - so this
 * is presentation only.
 */
export interface FlightHints {
  readonly hints: readonly ControlHint[];
  /** True while the panel should stay on screen. */
  readonly hold: boolean;
  /** A short line about why the aeroplane is not moving, or null. */
  readonly warning: string | null;
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1000).toFixed(0)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value)}`;
}

export class Hud {
  readonly element: HTMLElement;

  private readonly callbacks: HudCallbacks;

  private readonly musicButton: HTMLButtonElement;
  private readonly moneyEl: HTMLElement;
  private readonly districtEl: HTMLElement;
  private readonly streetEl: HTMLElement;
  private readonly promptEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly flightHintEl: HTMLElement;
  private readonly flightWarningEl: HTMLElement;
  private readonly flightRowsEl: HTMLElement;
  private flightHints: readonly ControlHint[] | null = null;
  private flightWarning: string | null = null;
  private flightHintsVisible = false;
  private readonly crosshair: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly statValues = new Map<string, HTMLElement>();

  // -- combat, wanted level and respawn (additive) --------------------------
  private readonly wantedEl: HTMLElement;
  private readonly starEls: HTMLElement[] = [];
  private readonly vitalsEl: HTMLElement;
  private readonly healthFillEl: HTMLElement;
  private readonly weaponNameEl: HTMLElement;
  private readonly ammoEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly bannerTitleEl: HTMLElement;
  private readonly bannerDetailEl: HTMLElement;
  private readonly flashEl: HTMLElement;
  private flashTimer = 0;
  private flashText = '';
  private readonly objectiveEl: HTMLElement;
  private readonly objectiveTitleEl: HTMLElement;
  private readonly objectiveDetailEl: HTMLElement;
  private objectiveLine = '';
  private wanted = -1;
  private health = Number.NaN;
  private weaponLine = '';
  // -------------------------------------------------------------------------

  private musicEnabled = false;
  private money = Number.NaN;
  private statsVisible = false;
  private pointerLocked = false;
  private promptText: string | null = null;
  private hintTimer = 0;
  private disposed = false;
  private readonly lastStats: Record<string, string> = {};

  constructor(callbacks: HudCallbacks) {
    this.callbacks = callbacks;

    this.element = document.createElement('div');
    this.element.className = 'mb-hud';

    this.crosshair = document.createElement('div');
    this.crosshair.className = 'mb-hud__crosshair';
    this.crosshair.setAttribute('aria-hidden', 'true');

    // Location readout, top left.
    const readout = document.createElement('div');
    readout.className = 'mb-hud__readout';
    readout.setAttribute('aria-live', 'polite');
    this.districtEl = document.createElement('span');
    this.districtEl.className = 'mb-hud__district';
    this.streetEl = document.createElement('span');
    this.streetEl.className = 'mb-hud__street';
    readout.append(this.districtEl, this.streetEl);

    // Money, music control and diagnostics, top right.
    const corner = document.createElement('div');
    corner.className = 'mb-hud__corner';

    // The wallet. Top right and larger than the rest of the chrome, because it
    // is the one number the player checks mid-stride; every other readout here
    // is something they go looking for.
    this.moneyEl = document.createElement('p');
    this.moneyEl.className = 'mb-hud__money';
    this.moneyEl.setAttribute('aria-live', 'polite');
    this.moneyEl.setAttribute('aria-label', 'Cash');
    this.moneyEl.hidden = true;

    this.musicButton = document.createElement('button');
    this.musicButton.type = 'button';
    this.musicButton.className = 'mb-button mb-button--ghost mb-button--stateful mb-hud__music';
    this.musicButton.textContent = musicLabel(false);
    this.musicButton.setAttribute('aria-pressed', 'false');
    this.musicButton.addEventListener('click', this.onMusicClick);
    this.musicButton.addEventListener('pointerdown', stopEvent);
    this.musicButton.addEventListener('mousedown', stopEvent);
    this.musicButton.addEventListener('keydown', stopEvent);

    this.statsEl = document.createElement('div');
    this.statsEl.className = 'mb-stats';
    this.statsEl.hidden = true;
    for (const [key, label] of [
      ['fps', 'FPS'],
      ['p95', 'Frame p95'],
      ['worst', 'Worst'],
      ['hitch', 'Hitches'],
      ['upd', 'Update cpu'],
      ['rnd', 'Render cpu'],
      ['res', 'Buffer'],
      ['draws', 'Draws'],
      ['tris', 'Tris'],
      ['mem', 'Mem'],
    ] as const) {
      const row = document.createElement('div');
      row.className = 'mb-stats__row';
      const name = document.createElement('span');
      name.className = 'mb-stats__label';
      name.textContent = label;
      const value = document.createElement('span');
      value.className = 'mb-stats__value';
      value.textContent = '—';
      row.append(name, value);
      this.statValues.set(key, value);
      this.statsEl.append(row);
    }
    corner.append(this.moneyEl, this.musicButton, this.statsEl);

    // Interaction prompt, centred low.
    this.promptEl = document.createElement('div');
    this.promptEl.className = 'mb-hud__prompt';
    this.promptEl.setAttribute('aria-live', 'polite');

    // Control hint, bottom left.
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'mb-hud__hint is-visible';
    this.hintEl.append(...CONTROL_HINTS.map(hintRow));

    /*
     * The contextual flight panel.
     *
     * Deliberately the SAME class, the same corner and the same key/action
     * rows as the walking hint, and shown instead of it rather than beside it:
     * two competing control lists in one corner is worse than either. The only
     * additions are a panel backing, because it sits over a moving world
     * rather than over the street, and a warning line for a jammed aeroplane.
     *
     * Styled from here rather than from `ui.css` because these are the only
     * three declarations that differ, and a class in the stylesheet for three
     * declarations used by one element is a worse trade than the inline set.
     */
    this.flightHintEl = document.createElement('div');
    this.flightHintEl.className = 'mb-hud__hint mb-hud__hint--flight';
    this.flightHintEl.style.padding = '8px 12px';
    this.flightHintEl.style.borderRadius = 'var(--mb-radius)';
    this.flightHintEl.style.background = 'rgba(12, 15, 19, 0.5)';
    this.flightWarningEl = document.createElement('p');
    this.flightWarningEl.className = 'mb-hud__flight-warning';
    this.flightWarningEl.setAttribute('role', 'status');
    this.flightWarningEl.style.margin = '0 0 4px';
    this.flightWarningEl.style.color = '#f0b45e';
    this.flightWarningEl.style.letterSpacing = '0.14em';
    this.flightWarningEl.style.textTransform = 'uppercase';
    this.flightWarningEl.style.fontSize = '10px';
    this.flightWarningEl.hidden = true;
    this.flightRowsEl = document.createElement('div');
    this.flightRowsEl.style.display = 'grid';
    this.flightRowsEl.style.gap = '3px';
    this.flightHintEl.append(this.flightWarningEl, this.flightRowsEl);

    this.element.append(
      this.crosshair,
      readout,
      corner,
      this.promptEl,
      this.hintEl,
      this.flightHintEl,
    );

    // -- combat, wanted level and respawn (additive) -------------------------
    // Stars sit above the wallet in the top-right stack; health and the
    // loaded weapon sit bottom left, over the control hint, where they can be
    // read without leaving the middle of the screen.
    this.wantedEl = document.createElement('div');
    this.wantedEl.className = 'mb-hud__wanted';
    this.wantedEl.setAttribute('role', 'img');
    this.wantedEl.hidden = true;
    for (let i = 0; i < 5; i += 1) {
      const star = document.createElement('span');
      star.className = 'mb-hud__star';
      star.textContent = '\u2605';
      star.setAttribute('aria-hidden', 'true');
      this.starEls.push(star);
      this.wantedEl.append(star);
    }
    corner.prepend(this.wantedEl);

    this.vitalsEl = document.createElement('div');
    this.vitalsEl.className = 'mb-hud__vitals';
    this.vitalsEl.hidden = true;
    const healthTrack = document.createElement('div');
    healthTrack.className = 'mb-hud__health';
    this.healthFillEl = document.createElement('span');
    this.healthFillEl.className = 'mb-hud__health-fill';
    healthTrack.append(this.healthFillEl);
    const weaponRow = document.createElement('p');
    weaponRow.className = 'mb-hud__weapon';
    this.weaponNameEl = document.createElement('span');
    this.weaponNameEl.className = 'mb-hud__weapon-name';
    this.ammoEl = document.createElement('span');
    this.ammoEl.className = 'mb-hud__ammo';
    weaponRow.append(this.weaponNameEl, this.ammoEl);
    this.vitalsEl.append(healthTrack, weaponRow);

    this.bannerEl = document.createElement('div');
    this.bannerEl.className = 'mb-hud__banner';
    this.bannerEl.setAttribute('role', 'status');
    this.bannerTitleEl = document.createElement('p');
    this.bannerTitleEl.className = 'mb-hud__banner-title';
    this.bannerDetailEl = document.createElement('p');
    this.bannerDetailEl.className = 'mb-hud__banner-detail';
    this.bannerEl.append(this.bannerTitleEl, this.bannerDetailEl);

    this.flashEl = document.createElement('p');
    this.flashEl.className = 'mb-hud__flash';
    this.flashEl.setAttribute('role', 'status');

    /*
     * The objective card, top left under the district name.
     *
     * Deliberately NOT the banner: the banner takes the middle of the screen
     * and is for being dead or being paid. This is a standing line that says
     * what the player is currently doing, and it has to be readable while
     * driving, which is why it sits out of the way and never moves.
     */
    this.objectiveEl = document.createElement('div');
    this.objectiveEl.className = 'mb-hud__objective';
    this.objectiveEl.setAttribute('aria-live', 'polite');
    this.objectiveTitleEl = document.createElement('p');
    this.objectiveTitleEl.className = 'mb-hud__objective-title';
    this.objectiveDetailEl = document.createElement('p');
    this.objectiveDetailEl.className = 'mb-hud__objective-detail';
    this.objectiveEl.append(this.objectiveTitleEl, this.objectiveDetailEl);

    this.element.append(this.vitalsEl, this.bannerEl, this.flashEl, this.objectiveEl);
    // -------------------------------------------------------------------------

    this.setLocation('', null);
    this.scheduleHintHide();
  }

  // -- public API -----------------------------------------------------------

  setInteractionPrompt(text: string | null): void {
    if (text === this.promptText) return;
    this.promptText = text;
    this.promptEl.textContent = text ?? '';
    this.promptEl.classList.toggle('is-visible', text !== null && text.length > 0);
  }

  /**
   * The contextual controls for the aircraft the player is in. `null` when
   * they are not in one, which puts the walking hint back.
   *
   * Idempotent and cheap: the rows are rebuilt only when the list itself
   * changes, so this can be called every frame.
   */
  setFlightHints(state: FlightHints | null): void {
    if (!state) {
      if (this.flightHintsVisible) {
        this.flightHintsVisible = false;
        this.flightHintEl.classList.remove('is-visible');
      }
      // Whatever the walking hint's own timer had decided still stands; it is
      // shown again on the next pointer-lock change, exactly as before.
      return;
    }

    /*
     * Compared by IDENTITY, not by a rebuilt string. This runs once a frame for
     * as long as the player is flying, and the hint list is a module constant
     * resolved once per platform - so mapping it into fresh strings and joining
     * them, only to discover it had not changed, was a per-frame allocation
     * that bought nothing. A caller that really does swap the list gets new
     * rows because the array identity differs.
     */
    if (state.hints !== this.flightHints) {
      this.flightHints = state.hints;
      this.flightRowsEl.replaceChildren(...state.hints.map(hintRow));
    }
    if (state.warning !== this.flightWarning) {
      this.flightWarning = state.warning;
      this.flightWarningEl.textContent = state.warning ?? '';
      this.flightWarningEl.hidden = state.warning === null;
    }
    // One control list at a time: the walking hint is not the one that applies.
    this.hintEl.classList.remove('is-visible');
    this.clearHintTimer();
    if (state.hold !== this.flightHintsVisible) {
      this.flightHintsVisible = state.hold;
      this.flightHintEl.classList.toggle('is-visible', state.hold);
    }
  }

  /** Whether the contextual flight panel is on screen. For automated QA. */
  get flightHintsShown(): boolean {
    return this.flightHintEl.classList.contains('is-visible');
  }

  setMusicEnabled(enabled: boolean): void {
    this.applyMusic(enabled);
  }

  /**
   * Shows the player's cash. Hidden until the application calls this once, so
   * a build with no economy wired in shows no empty wallet.
   */
  setMoney(amount: number): void {
    if (amount === this.money) return;
    this.money = amount;
    this.moneyEl.textContent = formatMoney(amount);
    this.moneyEl.hidden = false;
  }

  setLocation(district: string, street: string | null): void {
    const label = DISTRICT_LABELS[district as keyof typeof DISTRICT_LABELS] ?? district;
    if (this.districtEl.textContent !== label) this.districtEl.textContent = label;
    const streetText = street ?? '';
    if (this.streetEl.textContent !== streetText) this.streetEl.textContent = streetText;
  }

  setStats(stats: HudStats): void {
    if (!this.statsVisible) return;
    this.writeStat('fps', `${Math.round(stats.fps)}`);
    // Stutter lives in these three, not in the average frame rate.
    this.writeStat('p95', `${stats.p95Ms.toFixed(1)} ms`);
    this.writeStat('worst', `${stats.worstMs.toFixed(1)} ms`);
    this.writeStat('hitch', `${stats.hitches}`);
    this.writeStat('upd', `${stats.updateMs.toFixed(1)} ms`);
    this.writeStat('rnd', `${stats.renderMs.toFixed(1)} ms`);
    this.writeStat(
      'res',
      `${stats.bufferWidth}x${stats.bufferHeight} (${((stats.bufferWidth * stats.bufferHeight) / 1e6).toFixed(1)} MP)`,
    );
    this.writeStat('draws', `${Math.round(stats.drawCalls)}`);
    this.writeStat('tris', formatCount(stats.triangles));
    this.writeStat('mem', stats.memoryMB === null ? '—' : `${Math.round(stats.memoryMB)} MB`);
  }

  // -- combat, wanted level and respawn (additive) --------------------------

  /**
   * The wanted level, 0 to 5. Hidden entirely at zero: an empty row of grey
   * stars would advertise a system the player is not currently inside.
   */
  setWanted(stars: number): void {
    const clamped = Math.max(0, Math.min(5, Math.round(stars)));
    if (clamped === this.wanted) return;
    this.wanted = clamped;
    this.wantedEl.hidden = clamped === 0;
    this.wantedEl.setAttribute('aria-label', `Wanted level ${clamped} of 5`);
    for (let i = 0; i < this.starEls.length; i += 1) {
      this.starEls[i]?.classList.toggle('is-lit', i < clamped);
    }
  }

  /**
   * Health, as a bar. Shown from the first call, so a build with no combat
   * wired in carries no health readout at all.
   */
  setHealth(health: number, max: number): void {
    const value = Math.max(0, Math.min(max, health));
    if (value === this.health) return;
    this.health = value;
    const fraction = max > 0 ? value / max : 0;
    this.healthFillEl.style.width = `${(fraction * 100).toFixed(1)}%`;
    this.healthFillEl.classList.toggle('is-critical', fraction <= 0.25);
    this.vitalsEl.hidden = false;
  }

  /**
   * The weapon in hand. `magazine` is what is loaded and `reserve` is what the
   * player still owns; `null` means nothing is drawn.
   */
  setWeapon(
    name: string | null,
    magazine: number,
    reserve: number,
    state: 'ready' | 'reloading' | 'empty' | 'stowed',
  ): void {
    const label = name ?? '';
    const ammo =
      name === null
        ? ''
        : state === 'stowed'
          ? 'Stowed'
          : state === 'reloading'
            ? 'Reloading'
            : `${magazine} / ${reserve}`;
    const line = `${label}|${ammo}`;
    if (line === this.weaponLine) return;
    this.weaponLine = line;
    this.weaponNameEl.textContent = label;
    this.ammoEl.textContent = ammo;
    this.ammoEl.classList.toggle('is-empty', state === 'empty');
    this.vitalsEl.hidden = false;
  }

  /**
   * A short line under the crosshair, for something the player just tried to
   * do and could not.
   *
   * Deliberately not the banner: the banner is for being dead or arrested and
   * takes over the screen. This is for "you do not own that weapon" - the
   * answer to a key press, gone in a couple of seconds. Repeating the same
   * message restarts its timer rather than stacking.
   */
  flash(message: string, seconds = 2.2): void {
    this.flashText = message;
    this.flashTimer = seconds;
    this.flashEl.textContent = message;
    this.flashEl.classList.add('is-visible');
  }

  /**
   * Ages the transient line. Called once a frame by the application, which
   * already owns the clock; the HUD deliberately has no timers of its own.
   */
  tick(dt: number): void {
    if (this.flashTimer <= 0) return;
    this.flashTimer -= dt;
    if (this.flashTimer > 0) return;
    this.flashTimer = 0;
    this.flashText = '';
    this.flashEl.classList.remove('is-visible');
  }

  /** The message currently up, or an empty string. For automated QA. */
  get flashMessage(): string {
    return this.flashText;
  }

  /**
   * What the player is doing. `null` clears the card entirely, which is what a
   * build with no mission wired in shows.
   */
  setObjective(title: string | null, detail = ''): void {
    const line = `${title ?? ''}|${detail}`;
    if (line === this.objectiveLine) return;
    this.objectiveLine = line;
    this.objectiveTitleEl.textContent = title ?? '';
    this.objectiveDetailEl.textContent = detail;
    this.objectiveEl.classList.toggle('is-visible', title !== null && title.length > 0);
  }

  /** The objective currently shown, or an empty string. For automated QA. */
  get objective(): string {
    return this.objectiveTitleEl.textContent ?? '';
  }

  /**
   * The outcome banner shown while the player is out of play. `null` clears it.
   */
  setBanner(title: string | null, detail = ''): void {
    this.bannerTitleEl.textContent = title ?? '';
    this.bannerDetailEl.textContent = detail;
    this.bannerEl.classList.toggle('is-visible', title !== null);
  }

  // -------------------------------------------------------------------------

  setStatsVisible(visible: boolean): void {
    if (this.statsVisible === visible) return;
    this.statsVisible = visible;
    this.statsEl.hidden = !visible;
  }

  /**
   * The running/paused signal. Shows the crosshair while the game has the
   * pointer, and brings the control hint back whenever it is handed over -
   * which is exactly when the player is looking at the pause menu.
   */
  setPointerLocked(locked: boolean): void {
    if (this.pointerLocked === locked) return;
    this.pointerLocked = locked;
    this.element.classList.toggle('is-playing', locked);
    this.showHint();
    if (locked) this.scheduleHintHide();
    else this.clearHintTimer();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearHintTimer();
    this.musicButton.removeEventListener('click', this.onMusicClick);
    this.musicButton.removeEventListener('pointerdown', stopEvent);
    this.musicButton.removeEventListener('mousedown', stopEvent);
    this.musicButton.removeEventListener('keydown', stopEvent);
    this.element.remove();
  }

  // -- internals ------------------------------------------------------------

  private writeStat(key: string, value: string): void {
    if (this.lastStats[key] === value) return;
    this.lastStats[key] = value;
    const node = this.statValues.get(key);
    if (node) node.textContent = value;
  }

  private applyMusic(enabled: boolean): void {
    this.musicEnabled = enabled;
    this.musicButton.textContent = musicLabel(enabled);
    this.musicButton.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  }

  private readonly onMusicClick = (event: MouseEvent): void => {
    // The canvas listens for clicks to re-acquire pointer lock; this one is not
    // for it. `detail === 0` means the button was activated from the keyboard,
    // in which case focus is left alone so the tab order still makes sense.
    event.stopPropagation();
    this.applyMusic(!this.musicEnabled);
    this.callbacks.onMusicToggle(this.musicEnabled);
    if (event.detail !== 0) this.musicButton.blur();
  };

  private showHint(): void {
    // Never over the flight panel: whichever list is on screen has to be the
    // one that describes the controls the player is actually holding.
    if (this.flightHintsVisible) return;
    this.hintEl.classList.add('is-visible');
  }

  private clearHintTimer(): void {
    if (this.hintTimer !== 0) {
      window.clearTimeout(this.hintTimer);
      this.hintTimer = 0;
    }
  }

  private scheduleHintHide(): void {
    this.clearHintTimer();
    this.hintTimer = window.setTimeout(() => {
      this.hintTimer = 0;
      this.hintEl.classList.remove('is-visible');
    }, HINT_MS);
  }
}

function stopEvent(event: Event): void {
  event.stopPropagation();
}

/** One `keys / action` line, in the shape both control lists use. */
function hintRow(hint: ControlHint): HTMLElement {
  const row = document.createElement('p');
  const keys = document.createElement('span');
  keys.className = 'mb-hud__keys';
  keys.textContent = hint.keys;
  const action = document.createElement('span');
  action.className = 'mb-hud__action';
  action.textContent = hint.action;
  row.append(keys, action);
  return row;
}
