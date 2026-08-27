/**
 * Pause menu.
 *
 * Shown whenever the pointer lock is released - by Escape, by tabbing away, or
 * by the browser dropping it. It is the only modal surface in the product, so
 * it also carries the settings that have nowhere else to live: the music
 * toggle (mirrored from the HUD) and the render quality.
 *
 * Focus discipline matters here. Pointer lock can only be re-acquired from a
 * user gesture, so the Resume button gives up focus *before* it calls back;
 * leaving focus on a button would send the next Space or Enter to the button
 * rather than to the game.
 */

import './ui.css';
import { VOLUME_CHANNELS, type VolumeChannel } from '../audio/AudioDirector';

export type QualityLevel = 'low' | 'medium' | 'high';

/**
 * The music label is a product requirement, not a cosmetic string: it must read
 * "Music: Off" on a fresh load and say plainly which state it is in. It lives
 * here because the HUD and this menu must never disagree about it.
 */
export const MUSIC_LABEL_OFF = 'Music: Off';
export const MUSIC_LABEL_ON = 'Music: On';

export function musicLabel(enabled: boolean): string {
  return enabled ? MUSIC_LABEL_ON : MUSIC_LABEL_OFF;
}

export interface ControlHint {
  readonly keys: string;
  readonly action: string;
}

/** The control list, shared by the HUD hint and this menu. */
export const CONTROL_HINTS: readonly ControlHint[] = [
  { keys: 'Arrow keys / WASD', action: 'Move' },
  { keys: 'Shift', action: 'Run' },
  { keys: 'Mouse', action: 'Look' },
  { keys: 'E', action: 'Interact' },
  { keys: 'M', action: 'Map' },
  { keys: 'Esc', action: 'Pause' },
];

/** Short, original description of the city shown under the title. */
const CITY_BLURB =
  'An original coastal city, built to be walked. Meridian Bay looks west across ' +
  'a tidal bay: a working waterfront, a close-grained old quarter, a small ' +
  'downtown, and terraced streets climbing the ridge behind it.';

const VOLUME_LABELS: Readonly<Record<VolumeChannel, string>> = {
  master: 'Overall',
  music: 'Music',
  effects: 'Footsteps & effects',
  ambience: 'City ambience',
};

const QUALITY_LEVELS: readonly { level: QualityLevel; label: string }[] = [
  { level: 'low', label: 'Low' },
  { level: 'medium', label: 'Medium' },
  { level: 'high', label: 'High' },
];

export interface PauseMenuCallbacks {
  onResume(): void;
  onMusicToggle(enabled: boolean): void;
  onQualityChange(level: QualityLevel): void;
  /** Current level per channel, used to seed the sliders. */
  volumes: Readonly<Record<VolumeChannel, number>>;
  onVolumeChange(channel: VolumeChannel, value: number): void;
}

let radioGroupSeq = 0;

export class PauseMenu {
  readonly element: HTMLElement;

  private readonly callbacks: PauseMenuCallbacks;
  private readonly panel: HTMLElement;
  private readonly resumeButton: HTMLButtonElement;
  private readonly musicButton: HTMLButtonElement;
  private readonly qualityInputs = new Map<QualityLevel, HTMLInputElement>();

  private musicEnabled = false;
  private quality: QualityLevel = 'high';
  private isVisible = false;
  private focusHandle = 0;
  private disposed = false;

  constructor(callbacks: PauseMenuCallbacks) {
    this.callbacks = callbacks;

    this.element = document.createElement('div');
    this.element.className = 'mb-pause';
    this.element.setAttribute('aria-hidden', 'true');
    // `inert` rather than CSS alone: the fade-out is a transition, and a
    // transition does not run in a background tab. Without this the closed
    // menu could still hold a place in the tab order.
    this.element.setAttribute('inert', '');

    this.panel = document.createElement('section');
    this.panel.className = 'mb-pause__panel';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    this.panel.setAttribute('aria-label', 'Paused');

    const eyebrow = document.createElement('p');
    eyebrow.className = 'mb-pause__eyebrow';
    eyebrow.textContent = 'Paused';

    const title = document.createElement('h1');
    title.className = 'mb-pause__title';
    title.textContent = 'Meridian Bay';

    const blurb = document.createElement('p');
    blurb.className = 'mb-pause__blurb';
    blurb.textContent = CITY_BLURB;

    const actions = document.createElement('div');
    actions.className = 'mb-pause__actions';

    this.resumeButton = document.createElement('button');
    this.resumeButton.type = 'button';
    this.resumeButton.className = 'mb-button mb-button--primary';
    this.resumeButton.textContent = 'Resume';
    this.resumeButton.addEventListener('click', this.onResumeClick);

    this.musicButton = document.createElement('button');
    this.musicButton.type = 'button';
    this.musicButton.className = 'mb-button mb-button--stateful';
    this.musicButton.textContent = musicLabel(this.musicEnabled);
    this.musicButton.setAttribute('aria-pressed', 'false');
    this.musicButton.addEventListener('click', this.onMusicClick);

    actions.append(this.resumeButton, this.musicButton);

    this.panel.append(
      eyebrow,
      title,
      blurb,
      actions,
      this.buildVolume(),
      this.buildQuality(),
      this.buildControls(),
    );
    this.element.append(this.panel);

    this.element.addEventListener('keydown', this.onKeyDown);
    // The menu is modal: swallow clicks so a stray one cannot re-lock the
    // pointer behind it. Resume is the only way out that this layer offers.
    this.element.addEventListener('pointerdown', stopEvent);
    this.element.addEventListener('mousedown', stopEvent);
    this.element.addEventListener('click', stopEvent);
  }

  get visible(): boolean {
    return this.isVisible;
  }

  show(): void {
    this.setVisible(true);
  }

  hide(): void {
    this.setVisible(false);
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.isVisible === visible) return;
    this.isVisible = visible;
    this.element.classList.toggle('is-open', visible);
    this.element.setAttribute('aria-hidden', visible ? 'false' : 'true');
    if (visible) this.element.removeAttribute('inert');
    else this.element.setAttribute('inert', '');
    if (visible) {
      // Focus after the class lands so the element is focusable when we ask.
      this.focusHandle = window.requestAnimationFrame(() => {
        this.focusHandle = 0;
        if (this.isVisible) this.resumeButton.focus();
      });
    } else if (this.focusHandle !== 0) {
      window.cancelAnimationFrame(this.focusHandle);
      this.focusHandle = 0;
    }
  }

  setMusicEnabled(enabled: boolean): void {
    this.musicEnabled = enabled;
    this.musicButton.textContent = musicLabel(enabled);
    this.musicButton.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  }

  setQuality(level: QualityLevel): void {
    this.quality = level;
    const input = this.qualityInputs.get(level);
    if (input) input.checked = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.focusHandle !== 0) window.cancelAnimationFrame(this.focusHandle);
    this.resumeButton.removeEventListener('click', this.onResumeClick);
    this.musicButton.removeEventListener('click', this.onMusicClick);
    for (const input of this.qualityInputs.values()) {
      input.removeEventListener('change', this.onQualityInput);
    }
    this.element.removeEventListener('keydown', this.onKeyDown);
    this.element.removeEventListener('pointerdown', stopEvent);
    this.element.removeEventListener('mousedown', stopEvent);
    this.element.removeEventListener('click', stopEvent);
    this.element.remove();
  }

  // -- construction ---------------------------------------------------------

  /**
   * Volume sliders.
   *
   * Four channels rather than one master control, because the complaint these
   * answer is never "everything is too loud" - it is one group sitting wrong
   * against the others. Each slider shows its percentage so a setting can be
   * described and restored exactly.
   */
  private buildVolume(): HTMLElement {
    const group = document.createElement('fieldset');
    group.className = 'mb-pause__group';
    const legend = document.createElement('legend');
    legend.className = 'mb-pause__legend';
    legend.textContent = 'Volume';
    group.append(legend);

    for (const channel of VOLUME_CHANNELS) {
      const row = document.createElement('div');
      row.className = 'mb-slider';

      const label = document.createElement('label');
      label.className = 'mb-slider__label';
      radioGroupSeq += 1;
      const id = `mb-volume-${channel}-${radioGroupSeq}`;
      label.htmlFor = id;
      label.textContent = VOLUME_LABELS[channel];

      const input = document.createElement('input');
      input.type = 'range';
      input.id = id;
      input.className = 'mb-slider__input';
      input.min = '0';
      input.max = '100';
      input.step = '1';
      input.value = `${Math.round((this.callbacks.volumes[channel] ?? 1) * 100)}`;

      const readout = document.createElement('span');
      readout.className = 'mb-slider__value';
      readout.textContent = `${input.value}%`;

      const apply = (): void => {
        const percent = Number(input.value);
        readout.textContent = `${percent}%`;
        this.callbacks.onVolumeChange(channel, percent / 100);
      };
      // `input` so the level follows the thumb rather than jumping on release.
      input.addEventListener('input', apply);
      // Keys must not reach the game while a slider has focus.
      input.addEventListener('keydown', (event) => event.stopPropagation());

      row.append(label, input, readout);
      group.append(row);
    }
    return group;
  }

  private buildQuality(): HTMLElement {
    const group = document.createElement('fieldset');
    group.className = 'mb-pause__group';
    const legend = document.createElement('legend');
    legend.className = 'mb-pause__legend';
    legend.textContent = 'Quality';
    group.append(legend);

    const row = document.createElement('div');
    row.className = 'mb-segmented';
    radioGroupSeq += 1;
    const name = `mb-quality-${radioGroupSeq}`;

    for (const option of QUALITY_LEVELS) {
      const id = `${name}-${option.level}`;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = name;
      input.id = id;
      input.className = 'mb-segmented__input';
      input.value = option.level;
      input.checked = option.level === this.quality;
      input.addEventListener('change', this.onQualityInput);
      const label = document.createElement('label');
      label.className = 'mb-segmented__label';
      label.htmlFor = id;
      label.textContent = option.label;
      this.qualityInputs.set(option.level, input);
      row.append(input, label);
    }

    group.append(row);
    return group;
  }

  private buildControls(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'mb-pause__group';
    const heading = document.createElement('p');
    heading.className = 'mb-pause__legend';
    heading.textContent = 'Controls';
    const list = document.createElement('dl');
    list.className = 'mb-keylist';
    for (const hint of CONTROL_HINTS) {
      const keys = document.createElement('dt');
      keys.textContent = hint.keys;
      const action = document.createElement('dd');
      action.textContent = hint.action;
      list.append(keys, action);
    }
    section.append(heading, list);
    return section;
  }

  // -- events ---------------------------------------------------------------

  private readonly onResumeClick = (event: MouseEvent): void => {
    event.stopPropagation();
    this.resume();
  };

  private readonly onMusicClick = (event: MouseEvent): void => {
    event.stopPropagation();
    this.setMusicEnabled(!this.musicEnabled);
    this.callbacks.onMusicToggle(this.musicEnabled);
  };

  private readonly onQualityInput = (event: Event): void => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement) || !input.checked) return;
    const level = input.value as QualityLevel;
    if (level === this.quality) return;
    this.quality = level;
    this.callbacks.onQualityChange(level);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.isVisible) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.resume();
      return;
    }
    if (event.key !== 'Tab') {
      // Movement keys must not leak to the game while the menu is up.
      event.stopPropagation();
      return;
    }
    const focusable = this.focusableElements();
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  private focusableElements(): HTMLElement[] {
    const nodes = this.panel.querySelectorAll<HTMLElement>('button, input[type="radio"]');
    return [...nodes].filter((node) => !node.hasAttribute('disabled'));
  }

  private resume(): void {
    // Hand focus back before the callback: the caller re-requests pointer lock
    // inside this gesture and a focused button would keep eating the keyboard.
    this.resumeButton.blur();
    this.setVisible(false);
    this.callbacks.onResume();
  }
}

function stopEvent(event: Event): void {
  event.stopPropagation();
}
