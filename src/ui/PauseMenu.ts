/**
 * The pause menu: the only place the game stops, and the only place it is
 * configured.
 *
 * ## Why it is tabbed
 *
 * The card this replaced was one column that grew every time a setting had
 * nowhere else to live, and at 480 px of viewport height it was 1136 px tall
 * inside a panel with no `max-height` and no `overflow-y` - so the top and the
 * bottom were simply unreachable. The structure here is the fix: a fixed head,
 * a fixed tab rail, and ONE scroll container (`.mb-pause__view`) that holds the
 * active section. The panel itself never scrolls, which is the invariant the
 * tests and the browser measurements assert: `panel.scrollHeight` equals
 * `panel.clientHeight` at every supported size.
 *
 * ## Every control here is wired to something
 *
 * There are no placeholder settings. Each one names the code it drives:
 *
 *  - volume x4        -> `AudioDirector.setVolume`, persisted by that class
 *  - music on/off     -> `AudioDirector.setMusicEnabled`
 *  - detail           -> `Engine.setQuality` + crowd, traffic and lighting
 *  - mouse look speed -> `FirstPersonController.setSensitivity`
 *  - reduce motion    -> the transition rules in `ui.css`
 *  - high contrast    -> the token block in `ui.css`, which every layer reads
 *
 * The last two are the only settings this module consumes itself; they are
 * written to `documentElement` because the whole interface, not just this
 * panel, has to answer to them. They persist here because a preference that
 * resets on reload is not an accessibility feature.
 *
 * ## Input, while it is up
 *
 * A modal that leaks keys is not a pause. The overlay used to listen on its own
 * element, which meant a keystroke only reached it when focus was already
 * inside it - so a click on the backdrop moved focus to `<body>` and M, F3, the
 * weapon slots and the car controls all kept firing into a "paused" game. The
 * listener is now a CAPTURE listener on `window`, added on open and removed on
 * close, so it sees every keystroke before the game's own `window` listeners in
 * `main.ts`, `Driving.ts`, `FirstPersonController.ts` and `CombatSystem.ts` -
 * wherever focus happens to be - and stops it there.
 *
 * `keyup` is deliberately NOT intercepted: a key held down when the menu opened
 * must still register its release, or the car drives itself when play resumes.
 *
 * ## Focus
 *
 * Pointer lock can only be re-acquired from a user gesture, so Resume gives up
 * focus before it calls back; a focused button would eat the next Space. What
 * had focus before the menu opened is restored on close unless it is itself a
 * control that would eat the keyboard, in which case focus goes back to the
 * document body and the game keeps its keys.
 */

import './ui.css';
import { VOLUME_CHANNELS, type VolumeChannel } from '../audio/AudioDirector';
import { controlHints, type ControlHint } from './platform';
import { CAST, GAME_NAME, GAME_PREMISE, PROTAGONIST_PREMISE } from '../story';

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

export type { ControlHint };

/**
 * The control list, shared by the HUD hint and this menu.
 *
 * Resolved once at module load against the machine the game is running on -
 * see `platform.ts` for which entries differ and why. It stays a constant
 * because a player does not change operating system mid-session.
 */
export const CONTROL_HINTS: readonly ControlHint[] = controlHints();

/**
 * An extra block of bindings the application can add at run time.
 *
 * Aircraft controls arrive this way rather than by import: the module that
 * owns them is being written alongside this one, and a menu that cannot be
 * built until an unrelated file exports a constant is a menu that blocks
 * somebody. `setControlSections` validates what it is handed, so passing a
 * value that turns out to be `undefined` is inert rather than fatal.
 */
export interface ControlSection {
  readonly title: string;
  readonly hints: readonly ControlHint[];
}

/** What the mission director is asking for, as the menu shows it. */
export interface PauseMission {
  readonly title: string;
  readonly detail?: string;
}

export type PauseTabId =
  | 'mission'
  | 'map'
  | 'controls'
  | 'audio'
  | 'graphics'
  | 'gameplay'
  | 'access';

/**
 * Mouse look, in the units the controller actually uses: radians of yaw per
 * pixel of movement. The bounds are `FirstPersonController.setSensitivity`'s
 * own clamp, repeated here so the slider cannot offer a value that would be
 * silently clipped, and the default is that class's initial value.
 */
export const SENSITIVITY_MIN = 0.0004;
export const SENSITIVITY_MAX = 0.01;
export const SENSITIVITY_DEFAULT = 0.0022;

/**
 * The slider is 0-100 and the mapping is logarithmic, not linear.
 *
 * Linearly, the shipped default sits at 19 on the scale and three quarters of
 * the travel is spent in speeds nobody can aim with. Geometrically the range is
 * a factor of 25 from end to end, which puts the default at 53 - the middle,
 * where a default belongs - and gives the same proportional change per step
 * everywhere, which is what "twice as fast" means to a hand on a mouse.
 */
export function sensitivityFromSlider(position: number): number {
  const t = Math.min(Math.max(position, 0), 100) / 100;
  return SENSITIVITY_MIN * (SENSITIVITY_MAX / SENSITIVITY_MIN) ** t;
}

export function sliderFromSensitivity(value: number): number {
  const clamped = Math.min(Math.max(value, SENSITIVITY_MIN), SENSITIVITY_MAX);
  const t = Math.log(clamped / SENSITIVITY_MIN) / Math.log(SENSITIVITY_MAX / SENSITIVITY_MIN);
  return Math.round(t * 100);
}

/**
 * Settings this menu owns rather than reads.
 *
 * `AudioDirector` persists its own volumes; nothing owned the look speed or the
 * two interface preferences, so they are stored here under one key. Exported
 * because the controller has to be seeded with the stored look speed when the
 * game starts, which happens before anybody opens this menu.
 */
export interface StoredSettings {
  readonly sensitivity: number;
  readonly reducedMotion: boolean;
  readonly highContrast: boolean;
  /**
   * Assisted flight controls. ON by default, because the direct stick is the
   * reason a player gets into an aeroplane, cannot work out how to fly it, and
   * gives up. See the header of `src/air/assist.ts`.
   */
  readonly flightAssist: boolean;
}

const SETTINGS_STORAGE_KEY = 'meridian.settings';

const SETTINGS_DEFAULTS: StoredSettings = {
  sensitivity: SENSITIVITY_DEFAULT,
  reducedMotion: false,
  highContrast: false,
  flightAssist: true,
};

export function loadSettings(): StoredSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return SETTINGS_DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return SETTINGS_DEFAULTS;
    const record = parsed as Partial<Record<keyof StoredSettings, unknown>>;
    const sensitivity = record.sensitivity;
    return {
      sensitivity:
        typeof sensitivity === 'number' && Number.isFinite(sensitivity)
          ? Math.min(Math.max(sensitivity, SENSITIVITY_MIN), SENSITIVITY_MAX)
          : SENSITIVITY_DEFAULT,
      reducedMotion: record.reducedMotion === true,
      highContrast: record.highContrast === true,
      // Absent means never chosen, which must mean ON - a stored `false` is
      // the only thing that turns it off.
      flightAssist: record.flightAssist !== false,
    };
  } catch {
    // Private-mode Safari throws on read as well as on write.
    return SETTINGS_DEFAULTS;
  }
}

function saveSettings(settings: StoredSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable; the setting still applies for this session */
  }
}

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

const TABS: readonly { id: PauseTabId; label: string }[] = [
  { id: 'mission', label: 'Mission' },
  { id: 'map', label: 'Map' },
  { id: 'controls', label: 'Controls' },
  { id: 'audio', label: 'Audio' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'gameplay', label: 'Gameplay' },
  { id: 'access', label: 'Accessibility' },
];

export interface PauseMenuCallbacks {
  onResume(): void;
  onMusicToggle(enabled: boolean): void;
  onQualityChange(level: QualityLevel): void;
  /** Current level per channel, used to seed the sliders. */
  volumes: Readonly<Record<VolumeChannel, number>>;
  onVolumeChange(channel: VolumeChannel, value: number): void;
  /**
   * Radians of yaw per pixel, straight into
   * `FirstPersonController.setSensitivity`. Optional only so this menu can be
   * built in a harness that has no controller; the game must wire it.
   */
  onSensitivityChange?: ((radiansPerPixel: number) => void) | undefined;
  /** Told when the player switches between the assisted and direct controls. */
  onFlightAssistChange?: ((assist: boolean) => void) | undefined;
  /** Which section is on screen. Lets the caller draw the map lazily. */
  onTabChange?: ((tab: PauseTabId) => void) | undefined;
}

interface TabEntry {
  readonly id: PauseTabId;
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
}

let menuSeq = 0;

export class PauseMenu {
  readonly element: HTMLElement;

  /**
   * Empty on purpose. The application drops the expanded minimap in here; this
   * module never touches its contents, and the placeholder beside it hides
   * itself as soon as something has been added.
   */
  readonly mapPanel: HTMLElement;

  private readonly callbacks: PauseMenuCallbacks;
  private readonly ids: string;
  private readonly panel: HTMLElement;
  private readonly view: HTMLElement;
  private readonly tablist: HTMLElement;
  private readonly tabs: TabEntry[] = [];
  private readonly resumeButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly musicButton: HTMLButtonElement;
  private readonly qualityInputs = new Map<QualityLevel, HTMLInputElement>();
  private readonly objectiveTitle: HTMLElement;
  private readonly objectiveDetail: HTMLElement;
  private readonly mapEmpty: HTMLElement;
  private readonly controlExtras: HTMLElement;

  private settings: StoredSettings;
  private keyListSeq = 0;
  private musicEnabled = false;
  private quality: QualityLevel = 'high';
  private activeTab: PauseTabId = 'mission';
  private isVisible = false;
  private focusHandle = 0;
  private returnFocus: HTMLElement | null = null;
  private disposed = false;

  constructor(callbacks: PauseMenuCallbacks) {
    this.callbacks = callbacks;
    menuSeq += 1;
    this.ids = `mb-pause-${menuSeq}`;
    this.settings = loadSettings();

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
    // Named by what is on screen rather than by a duplicate hard-coded string:
    // "Paused, GTA Vibe" is read from the two elements that say it.
    this.panel.setAttribute('aria-labelledby', `${this.ids}-eyebrow ${this.ids}-title`);

    const head = document.createElement('header');
    head.className = 'mb-pause__head';

    const titles = document.createElement('div');
    titles.className = 'mb-pause__heading';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'mb-pause__eyebrow';
    eyebrow.id = `${this.ids}-eyebrow`;
    eyebrow.textContent = 'Paused';
    const title = document.createElement('h1');
    title.className = 'mb-pause__title';
    title.id = `${this.ids}-title`;
    title.textContent = GAME_NAME;
    titles.append(eyebrow, title);

    this.closeButton = document.createElement('button');
    this.closeButton.type = 'button';
    this.closeButton.className = 'mb-pause__close';
    // The glyph is decorative; the button's name is the sentence a screen
    // reader should hear, and it says what actually happens - the game resumes.
    this.closeButton.setAttribute('aria-label', 'Close menu and resume the game');
    this.closeButton.append(crossIcon());
    this.closeButton.addEventListener('click', this.onResumeClick);

    head.append(titles, this.closeButton);

    const rail = document.createElement('div');
    rail.className = 'mb-pause__rail';

    /*
     * Resume is a button, not a tab, even though it sits at the head of the
     * same rail. A `role="tab"` must control a `tabpanel`; this one ends the
     * dialog, so making it a tab would be a lie to anybody navigating by
     * keyboard. It is first in the DOM, so it is also first in the tab order.
     */
    this.resumeButton = document.createElement('button');
    this.resumeButton.type = 'button';
    this.resumeButton.className = 'mb-pause__resume';
    this.resumeButton.textContent = 'Resume';
    this.resumeButton.addEventListener('click', this.onResumeClick);

    this.tablist = document.createElement('div');
    this.tablist.className = 'mb-pause__tabs';
    this.tablist.setAttribute('role', 'tablist');
    this.tablist.setAttribute('aria-orientation', 'horizontal');
    this.tablist.setAttribute('aria-label', 'Pause menu sections');

    rail.append(this.resumeButton, this.tablist);

    this.view = document.createElement('div');
    this.view.className = 'mb-pause__view';

    // -- the sections, in the order the rail lists them ---------------------

    const mission = this.section('mission');
    this.objectiveTitle = document.createElement('p');
    this.objectiveTitle.className = 'mb-pause__objective-title';
    this.objectiveDetail = document.createElement('p');
    this.objectiveDetail.className = 'mb-pause__objective-detail';
    mission.append(this.buildMission());

    const map = this.section('map');
    // The one tab that wants all of the panel's height rather than flowing.
    map.classList.add('mb-pause__panel-map');
    this.mapPanel = document.createElement('div');
    this.mapPanel.className = 'mb-pause__map';
    this.mapEmpty = document.createElement('p');
    this.mapEmpty.className = 'mb-pause__empty';
    this.mapEmpty.textContent = 'The city map opens here, and on M while you are playing.';
    map.append(this.mapPanel, this.mapEmpty);

    const controls = this.section('controls');
    this.controlExtras = document.createElement('div');
    this.controlExtras.className = 'mb-pause__extras';
    controls.append(this.buildControls(), this.controlExtras);

    const audio = this.section('audio');
    this.musicButton = document.createElement('button');
    this.musicButton.type = 'button';
    this.musicButton.className = 'mb-button mb-button--stateful';
    this.musicButton.textContent = musicLabel(this.musicEnabled);
    this.musicButton.setAttribute('aria-pressed', 'false');
    this.musicButton.addEventListener('click', this.onMusicClick);
    audio.append(this.buildVolume(), this.buildMusic());

    const graphics = this.section('graphics');
    graphics.append(this.buildQuality());

    const gameplay = this.section('gameplay');
    /*
     * Flying first, look-speed second. Not cosmetic: the look-speed slider is
     * the last focusable control in this section and is therefore the focus
     * trap's own boundary, which `tests/pauseMenu.test.ts` uses to prove a
     * range input is inside the tab cycle. Appending after it would move the
     * boundary onto a button and quietly retire that assertion.
     */
    gameplay.append(this.buildFlight(), this.buildSensitivity());

    const access = this.section('access');
    access.append(this.buildAccessibility());

    const foot = document.createElement('p');
    foot.className = 'mb-pause__foot';
    foot.textContent = 'Esc or Resume returns to the city. Nothing moves while this is open.';

    this.panel.append(head, rail, this.view, foot);
    this.element.append(this.panel);

    // The two interface preferences are read by the stylesheet, so they are
    // applied to the document as soon as this exists rather than waiting for
    // somebody to open the menu.
    this.applyInterfacePreferences();
    this.applyTab('mission', false);

    /*
     * The overlay is modal: swallow pointer events so a stray click cannot
     * re-lock the pointer behind it. `mousedown` on the backdrop is also
     * cancelled, because its default action is what moves focus to `<body>`
     * and out of the dialog.
     */
    this.element.addEventListener('pointerdown', this.onBackdropPointer);
    this.element.addEventListener('mousedown', this.onBackdropPointer);
    this.element.addEventListener('click', stopEvent);
  }

  get visible(): boolean {
    return this.isVisible;
  }

  get tab(): PauseTabId {
    return this.activeTab;
  }

  /** Opens the menu, optionally on a named section. */
  show(tab?: PauseTabId): void {
    if (tab) this.applyTab(tab, true);
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
      this.returnFocus = currentFocus();
      // Capture, on window: see the note at the top of this file. Added only
      // while the menu is up so a closed menu costs the keyboard nothing.
      window.addEventListener('keydown', this.onWindowKeyDown, true);
      releasePointerLock();
      if (this.activeTab === 'map') this.refreshMapPlaceholder();
      /*
       * Focus twice on purpose. The synchronous call is what actually lands in
       * a backgrounded or throttled tab, where `requestAnimationFrame` may not
       * run for seconds; the frame callback is the retry for the case where the
       * panel is still mid-transition and refuses focus. The retry checks that
       * focus is still outside the panel first, so it can never take it back
       * from a player who has already moved.
       */
      this.resumeButton.focus();
      this.focusHandle = window.requestAnimationFrame(() => {
        this.focusHandle = 0;
        if (!this.isVisible) return;
        const active = document.activeElement;
        if (active instanceof HTMLElement && this.panel.contains(active)) return;
        this.resumeButton.focus();
      });
    } else {
      window.removeEventListener('keydown', this.onWindowKeyDown, true);
      if (this.focusHandle !== 0) {
        window.cancelAnimationFrame(this.focusHandle);
        this.focusHandle = 0;
      }
      this.restoreFocus();
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

  /** Mirrors `Hud.setObjective`, so the application can push both from one line. */
  setObjective(title: string | null, detail = ''): void {
    // The empty state states a fact and invents nothing: this menu does not
    // know what the player can do when the director has published no objective.
    this.objectiveTitle.textContent = title ?? 'Nothing on the board';
    this.objectiveDetail.textContent = title ? detail : '';
    this.objectiveDetail.hidden = this.objectiveDetail.textContent === '';
  }

  /** The same thing, in the shape the mission director publishes. */
  setMission(mission: PauseMission | null): void {
    this.setObjective(mission?.title ?? null, mission?.detail ?? '');
  }

  /**
   * Replaces the extra control blocks under the built-in bindings.
   *
   * Hostile to bad input on purpose: the caller may be passing a constant from
   * a module that does not export it yet, in which case it is `undefined` at
   * run time and this must do nothing rather than throw inside a constructor
   * chain the player would see as a black screen.
   */
  setControlSections(sections: readonly ControlSection[] | null | undefined): void {
    this.controlExtras.replaceChildren();
    const list: readonly ControlSection[] = Array.isArray(sections) ? sections : [];
    for (const section of list) {
      if (!section || typeof section.title !== 'string') continue;
      const raw: readonly ControlHint[] = Array.isArray(section.hints) ? section.hints : [];
      const hints = raw.filter(
        (hint) => !!hint && typeof hint.keys === 'string' && typeof hint.action === 'string',
      );
      if (hints.length === 0) continue;
      this.controlExtras.append(this.keyList(section.title, hints));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.focusHandle !== 0) window.cancelAnimationFrame(this.focusHandle);
    window.removeEventListener('keydown', this.onWindowKeyDown, true);
    this.resumeButton.removeEventListener('click', this.onResumeClick);
    this.closeButton.removeEventListener('click', this.onResumeClick);
    this.musicButton.removeEventListener('click', this.onMusicClick);
    for (const input of this.qualityInputs.values()) {
      input.removeEventListener('change', this.onQualityInput);
    }
    for (const entry of this.tabs) {
      entry.button.removeEventListener('click', this.onTabClick);
    }
    this.element.removeEventListener('pointerdown', this.onBackdropPointer);
    this.element.removeEventListener('mousedown', this.onBackdropPointer);
    this.element.removeEventListener('click', stopEvent);
    this.element.remove();
  }

  // -- construction ---------------------------------------------------------

  /** One tab, one panel, and the pair wired to each other by id. */
  private section(id: PauseTabId): HTMLElement {
    const label = TABS.find((entry) => entry.id === id)?.label ?? id;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mb-pause__tab';
    button.id = `${this.ids}-tab-${id}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `${this.ids}-panel-${id}`);
    button.setAttribute('aria-selected', 'false');
    button.tabIndex = -1;
    button.dataset.tab = id;
    button.textContent = label;
    button.addEventListener('click', this.onTabClick);

    const panel = document.createElement('div');
    panel.className = 'mb-pause__page';
    panel.id = `${this.ids}-panel-${id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    // A section can scroll and can be longer than the screen, so it has to be
    // reachable by keyboard even when nothing inside it is focusable.
    panel.tabIndex = 0;
    panel.hidden = true;

    this.tablist.append(button);
    this.view.append(panel);
    this.tabs.push({ id, button, panel });
    return panel;
  }

  private buildMission(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'mb-pause__cols';

    const left = document.createElement('div');
    const objective = document.createElement('div');
    objective.className = 'mb-pause__objective';
    objective.append(this.objectiveTitle, this.objectiveDetail);
    // Seeded rather than left blank: the menu can be opened before the mission
    // director has published anything.
    this.setObjective(null);

    const city = document.createElement('div');
    city.className = 'mb-pause__block';
    city.append(heading('The city'));
    for (const paragraph of [GAME_PREMISE, PROTAGONIST_PREMISE]) {
      const p = document.createElement('p');
      p.className = 'mb-pause__blurb';
      p.textContent = paragraph;
      city.append(p);
    }
    left.append(heading('Objective'), objective, city);

    const right = document.createElement('div');
    right.className = 'mb-pause__block';
    const castHeading = heading('People');
    castHeading.id = `${this.ids}-cast`;
    const list = document.createElement('dl');
    list.className = 'mb-castlist';
    // A `<dl>` is what this is - a person, and who they are - and it is now
    // named by the heading above it rather than merely sitting under it.
    list.setAttribute('aria-labelledby', castHeading.id);
    for (const person of Object.values(CAST)) {
      const who = document.createElement('dt');
      who.textContent = person.name;
      const role = document.createElement('span');
      role.className = 'mb-castlist__role';
      role.textContent = person.role;
      who.append(role);
      const blurb = document.createElement('dd');
      blurb.textContent = person.blurb;
      list.append(who, blurb);
    }
    right.append(castHeading, list);

    wrap.append(left, right);
    return wrap;
  }

  private buildControls(): HTMLElement {
    return this.keyList('On foot, in a car', CONTROL_HINTS);
  }

  private keyList(title: string, hints: readonly ControlHint[]): HTMLElement {
    const block = document.createElement('div');
    block.className = 'mb-pause__block';
    const label = heading(title);
    // Numbered as well as slugged: the caller supplies these titles, and two
    // sections with the same name would otherwise share one id and leave the
    // second list pointing at the first list's heading.
    this.keyListSeq += 1;
    label.id = `${this.ids}-keys-${this.keyListSeq}-${slug(title)}`;
    const list = document.createElement('dl');
    list.className = 'mb-keylist mb-keylist--pause';
    list.setAttribute('aria-labelledby', label.id);
    for (const hint of hints) {
      const keys = document.createElement('dt');
      keys.textContent = hint.keys;
      const action = document.createElement('dd');
      action.textContent = hint.action;
      list.append(keys, action);
    }
    block.append(label, list);
    return block;
  }

  /**
   * Volume sliders.
   *
   * Four channels rather than one master control, because the complaint these
   * answer is never "everything is too loud" - it is one group sitting wrong
   * against the others. Each slider shows its percentage so a setting can be
   * described and restored exactly, and repeats it in `aria-valuetext` so the
   * printed number and the announced one cannot drift apart.
   */
  private buildVolume(): HTMLElement {
    const group = document.createElement('fieldset');
    group.className = 'mb-pause__group';
    const legend = document.createElement('legend');
    legend.className = 'mb-pause__legend';
    legend.textContent = 'Volume';
    group.append(legend);

    for (const channel of VOLUME_CHANNELS) {
      const seed = Math.round((this.callbacks.volumes[channel] ?? 1) * 100);
      group.append(
        this.slider({
          id: `${this.ids}-volume-${channel}`,
          setting: `volume-${channel}`,
          label: VOLUME_LABELS[channel],
          value: seed,
          format: (percent) => `${percent}%`,
          announce: (percent) => `${percent} percent`,
          onChange: (percent) => this.callbacks.onVolumeChange(channel, percent / 100),
        }),
      );
    }
    return group;
  }

  private buildMusic(): HTMLElement {
    const block = document.createElement('div');
    block.className = 'mb-pause__block';
    const label = heading('Soundtrack');
    const note = document.createElement('p');
    note.className = 'mb-pause__note';
    note.textContent = 'The car radio and the club both play through the music channel.';
    block.append(label, this.musicButton, note);
    return block;
  }

  private buildQuality(): HTMLElement {
    const group = document.createElement('fieldset');
    group.className = 'mb-pause__group';
    const legend = document.createElement('legend');
    legend.className = 'mb-pause__legend';
    legend.textContent = 'Detail';
    group.append(legend);

    const row = document.createElement('div');
    row.className = 'mb-segmented';
    const name = `${this.ids}-quality`;

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

    const note = document.createElement('p');
    note.className = 'mb-pause__note';
    note.textContent =
      'Detail sets the render resolution and shadows, and how many people and ' +
      'cars the city keeps alive around you. Drop it if the frame rate does.';

    group.append(row, note);
    return group;
  }

  private buildSensitivity(): HTMLElement {
    const group = document.createElement('fieldset');
    group.className = 'mb-pause__group';
    const legend = document.createElement('legend');
    legend.className = 'mb-pause__legend';
    legend.textContent = 'Mouse';
    group.append(legend);

    const row = this.slider({
      id: `${this.ids}-sensitivity`,
      setting: 'sensitivity',
      label: 'Look speed',
      value: sliderFromSensitivity(this.settings.sensitivity),
      format: (position) => `${position}`,
      announce: (position) => `${position} of 100`,
      onChange: (position) => {
        const sensitivity = sensitivityFromSlider(position);
        this.settings = { ...this.settings, sensitivity };
        saveSettings(this.settings);
        this.callbacks.onSensitivityChange?.(sensitivity);
      },
    });

    const note = document.createElement('p');
    note.className = 'mb-pause__note';
    note.textContent = 'How far the view turns for the same movement of the mouse.';

    group.append(row, note);
    return group;
  }

  private buildFlight(): HTMLElement {
    const block = document.createElement('div');
    block.className = 'mb-pause__block';
    block.append(heading('Flying'));
    block.append(
      this.toggle({
        setting: 'flight-assist',
        label: 'Flight assist',
        note: 'Up climbs, Down descends, Left and Right turn, and the wing will not be stalled. Turn it off for a centre stick: W pitches the nose down, A and D roll, and the rudder is on Z and C.',
        pressed: this.settings.flightAssist,
        onChange: (on) => {
          this.settings = { ...this.settings, flightAssist: on };
          saveSettings(this.settings);
          // The Controls tab documents whichever mapping is live, so the app
          // re-supplies the flight section from here rather than leaving it
          // describing the other one.
          this.callbacks.onFlightAssistChange?.(on);
        },
      }),
    );
    return block;
  }

  private buildAccessibility(): HTMLElement {
    const block = document.createElement('div');
    block.className = 'mb-pause__block';
    block.append(heading('Interface'));

    block.append(
      this.toggle({
        setting: 'reduced-motion',
        label: 'Reduce motion',
        note: 'Removes the fades and the panel transitions. Your system setting is honoured on its own; this is the override.',
        pressed: this.settings.reducedMotion,
        onChange: (on) => {
          this.settings = { ...this.settings, reducedMotion: on };
          saveSettings(this.settings);
          this.applyInterfacePreferences();
        },
      }),
      this.toggle({
        setting: 'high-contrast',
        label: 'High contrast',
        note: 'Brightens the interface text and hairlines across every panel and the HUD.',
        pressed: this.settings.highContrast,
        onChange: (on) => {
          this.settings = { ...this.settings, highContrast: on };
          saveSettings(this.settings);
          this.applyInterfacePreferences();
        },
      }),
    );
    return block;
  }

  /** One labelled range input with a printed value beside it. */
  private slider(spec: {
    id: string;
    setting: string;
    label: string;
    value: number;
    format(value: number): string;
    announce(value: number): string;
    onChange(value: number): void;
  }): HTMLElement {
    const row = document.createElement('div');
    row.className = 'mb-slider';

    const label = document.createElement('label');
    label.className = 'mb-slider__label';
    label.htmlFor = spec.id;
    label.textContent = spec.label;

    const input = document.createElement('input');
    input.type = 'range';
    input.id = spec.id;
    input.className = 'mb-slider__input';
    // A stable handle for the tests and for browser QA, which otherwise have
    // to identify a control by its position in the document.
    input.dataset.setting = spec.setting;
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.value = `${spec.value}`;

    const readout = document.createElement('span');
    readout.className = 'mb-slider__value';

    const paint = (value: number): void => {
      readout.textContent = spec.format(value);
      // The percentage announced and the percentage printed are the same
      // string; without this a screen reader reads the raw "62" and the
      // adjacent readout is never announced at all.
      input.setAttribute('aria-valuetext', spec.announce(value));
      // The filled part of the track. A range input cannot express it in CSS,
      // so the fill is a gradient stop driven from here.
      input.style.setProperty('--mb-fill', `${value}%`);
    };
    paint(spec.value);

    // `input` so the level follows the thumb rather than jumping on release.
    input.addEventListener('input', () => {
      const value = Number(input.value);
      paint(value);
      spec.onChange(value);
    });

    row.append(label, input, readout);
    return row;
  }

  /** A stateful on/off control with a line of explanation under it. */
  private toggle(spec: {
    setting: string;
    label: string;
    note: string;
    pressed: boolean;
    onChange(pressed: boolean): void;
  }): HTMLElement {
    const row = document.createElement('div');
    row.className = 'mb-switch';

    const text = document.createElement('div');
    const name = document.createElement('p');
    name.className = 'mb-switch__label';
    name.textContent = spec.label;
    const note = document.createElement('p');
    note.className = 'mb-pause__note';
    note.textContent = spec.note;
    text.append(name, note);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mb-button mb-button--stateful';
    button.dataset.setting = spec.setting;
    button.setAttribute('aria-pressed', spec.pressed ? 'true' : 'false');
    button.setAttribute('aria-label', spec.label);
    button.textContent = spec.pressed ? 'On' : 'Off';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const next = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', next ? 'true' : 'false');
      button.textContent = next ? 'On' : 'Off';
      spec.onChange(next);
    });

    row.append(text, button);
    return row;
  }

  // -- state ----------------------------------------------------------------

  private applyInterfacePreferences(): void {
    const root = document.documentElement;
    if (this.settings.reducedMotion) root.setAttribute('data-mb-motion', 'reduced');
    else root.removeAttribute('data-mb-motion');
    if (this.settings.highContrast) root.setAttribute('data-mb-contrast', 'high');
    else root.removeAttribute('data-mb-contrast');
  }

  private applyTab(id: PauseTabId, notify: boolean): void {
    let found = false;
    for (const entry of this.tabs) {
      const on = entry.id === id;
      if (on) found = true;
      entry.button.setAttribute('aria-selected', on ? 'true' : 'false');
      // Roving tabindex: Tab moves INTO the tablist once and lands on the
      // selected tab; the arrow keys move between them from there.
      entry.button.tabIndex = on ? 0 : -1;
      entry.panel.hidden = !on;
    }
    if (!found) return;
    this.activeTab = id;
    if (id === 'map') this.refreshMapPlaceholder();
    this.view.scrollTop = 0;
    if (notify) this.callbacks.onTabChange?.(id);
  }

  private refreshMapPlaceholder(): void {
    this.mapEmpty.hidden = this.mapPanel.childElementCount > 0;
  }

  private restoreFocus(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.element.contains(active)) active.blur();
    const target = this.returnFocus;
    this.returnFocus = null;
    if (!target || !target.isConnected || this.element.contains(target)) return;
    /*
     * Restore what had focus - unless it is a control that would then eat the
     * next Space or Enter meant for the game. The HUD has one such button, and
     * a player who clicked it before pressing Escape must not come back to a
     * city where jumping opens the music toggle instead.
     */
    if (eatsKeyboard(target)) {
      document.body.focus();
      return;
    }
    target.focus();
  }

  private resume(): void {
    // Focus is handed back inside `setVisible` before the callback: the caller
    // re-requests pointer lock in this same gesture, and a focused button would
    // keep eating the keyboard.
    this.setVisible(false);
    this.callbacks.onResume();
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

  private readonly onTabClick = (event: MouseEvent): void => {
    event.stopPropagation();
    const id = tabIdOf(event.currentTarget);
    if (id) this.applyTab(id, true);
  };

  private readonly onBackdropPointer = (event: Event): void => {
    event.stopPropagation();
    // Only the backdrop itself. Cancelling the default action here is what
    // keeps focus inside the dialog: a click on the dark area would otherwise
    // move it to `<body>`, which is where the old key leak came from.
    if (event.target === this.element) event.preventDefault();
  };

  /**
   * Every key, everywhere, while the menu is up.
   *
   * Capture phase on `window`, so this runs before the game's own `window`
   * listeners and before anything bound to the canvas, regardless of where
   * focus is. `stopPropagation` at this point ends the event's journey: the
   * capture phase has not reached the target yet, so nothing below sees it.
   *
   * `preventDefault` is used sparingly and deliberately. Stopping propagation
   * does not stop DEFAULT actions, which is exactly what is wanted: the arrow
   * keys still move a focused slider, Tab still moves focus, Enter and Space
   * still press the focused button - none of that reaches the game.
   */
  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    if (!this.isVisible) return;
    event.stopPropagation();

    if (event.key === 'Escape') {
      event.preventDefault();
      this.resume();
      return;
    }

    if (event.key === 'Tab') {
      this.trapTab(event);
      return;
    }

    const active = document.activeElement;
    const here = this.tabs.findIndex((entry) => entry.button === active);
    if (here < 0) return;

    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    let next = -1;
    if (step !== 0) next = (here + step + this.tabs.length) % this.tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = this.tabs.length - 1;
    if (next < 0) return;

    event.preventDefault();
    const entry = this.tabs[next];
    if (!entry) return;
    // Selection follows focus. The panels are already built, so there is
    // nothing to be gained by making the player press Enter as well.
    this.applyTab(entry.id, true);
    entry.button.focus();
  };

  private trapTab(event: KeyboardEvent): void {
    const focusable = this.focusableElements();
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !this.panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !this.panel.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * Everything Tab can reach inside the panel, in document order.
   *
   * The old query asked for `button, input[type="radio"]`, which left the
   * volume sliders focusable but outside the trap - so Tab wrapped at the
   * wrong element and could walk out of the dialog into the page behind it.
   * This asks for every focusable kind and then removes what the browser would
   * skip anyway: disabled controls, the unselected tabs (roving tabindex) and
   * anything inside a hidden panel. `hidden` is checked rather than layout,
   * because layout does not exist in a test DOM.
   */
  private focusableElements(): HTMLElement[] {
    const nodes = this.panel.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]',
    );
    return [...nodes].filter((node) => {
      if (node.hasAttribute('disabled')) return false;
      if (node.getAttribute('tabindex') === '-1') return false;
      return node.closest('[hidden]') === null;
    });
  }
}

function heading(text: string): HTMLElement {
  const element = document.createElement('h2');
  element.className = 'mb-pause__legend';
  element.textContent = text;
  return element;
}

function crossIcon(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M1 1 L11 11 M11 1 L1 11');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linecap', 'square');
  svg.append(path);
  return svg;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function tabIdOf(target: EventTarget | null): PauseTabId | null {
  if (!(target instanceof HTMLElement)) return null;
  const id = target.dataset.tab;
  return TABS.some((entry) => entry.id === id) ? (id as PauseTabId) : null;
}

function currentFocus(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement ? active : null;
}

/** Controls that would swallow the next Space or Enter meant for the game. */
function eatsKeyboard(element: HTMLElement): boolean {
  const tag = element.tagName;
  return tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

function releasePointerLock(): void {
  // Escape releases the lock itself, but the menu can be opened by other means
  // - a lost lock, a mission interrupt - and a modal over a locked pointer is
  // a menu the mouse cannot reach.
  if (typeof document.exitPointerLock !== 'function') return;
  if (!document.pointerLockElement) return;
  document.exitPointerLock();
}

function stopEvent(event: Event): void {
  event.stopPropagation();
}
