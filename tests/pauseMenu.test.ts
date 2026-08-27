// @vitest-environment jsdom
/**
 * The pause menu, as a piece of interface.
 *
 * Everything asserted here is a defect that shipped at least once: keys that
 * leaked past a "paused" game into the driving and combat listeners on
 * `window`, a focus trap whose element list omitted the sliders it was meant to
 * contain, tabs that said one thing in `aria-selected` and another on screen,
 * and a menu that closed without giving the keyboard back to anybody.
 *
 * The layout defect these tests cannot see - a panel with no `max-height`
 * inside a 480 px window - is measured in the browser instead, because
 * jsdom has no layout to measure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VolumeChannel } from '../src/audio/AudioDirector';
import {
  CONTROL_HINTS,
  MUSIC_LABEL_OFF,
  MUSIC_LABEL_ON,
  PauseMenu,
  SENSITIVITY_DEFAULT,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  loadSettings,
  musicLabel,
  sensitivityFromSlider,
  sliderFromSensitivity,
  type PauseTabId,
  type QualityLevel,
} from '../src/ui/PauseMenu';

type VolumeCall = [VolumeChannel, number];

interface Recorded {
  resume: number;
  music: boolean[];
  quality: QualityLevel[];
  volume: VolumeCall[];
  sensitivity: number[];
  tabs: PauseTabId[];
}

/**
 * Storage, as a double.
 *
 * Node 26 declares its own experimental `localStorage` global and leaves it
 * undefined unless the process was started with `--localstorage-file`, which
 * shadows the one jsdom provides. The menu's own guards mean it merely stops
 * persisting, which is right in a browser and useless in a test, so the double
 * is installed for every case here.
 */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length(): number {
      return map.size;
    },
    clear: (): void => {
      map.clear();
    },
    getItem: (key: string): string | null => map.get(key) ?? null,
    key: (index: number): string | null => [...map.keys()][index] ?? null,
    removeItem: (key: string): void => {
      map.delete(key);
    },
    setItem: (key: string, value: string): void => {
      map.set(key, String(value));
    },
  };
}

/** Every menu built by a case, so `afterEach` can take them all apart. */
const built: PauseMenu[] = [];

function mount(): { menu: PauseMenu; calls: Recorded } {
  const calls: Recorded = {
    resume: 0,
    music: [],
    quality: [],
    volume: [],
    sensitivity: [],
    tabs: [],
  };
  const menu = new PauseMenu({
    volumes: { master: 0.8, music: 0.5, effects: 0.9, ambience: 0.4 },
    onResume: () => {
      calls.resume += 1;
    },
    onMusicToggle: (enabled) => calls.music.push(enabled),
    onQualityChange: (level) => calls.quality.push(level),
    onVolumeChange: (channel, value) => calls.volume.push([channel, value]),
    onSensitivityChange: (value) => calls.sensitivity.push(value),
    onTabChange: (tab) => calls.tabs.push(tab),
  });
  document.body.append(menu.element);
  built.push(menu);
  return { menu, calls };
}

function tabButton(menu: PauseMenu, label: string): HTMLButtonElement {
  const found = [...menu.element.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (button) => button.textContent === label,
  );
  if (!found) throw new Error(`no tab labelled ${label}`);
  return found;
}

function control(menu: PauseMenu, setting: string): HTMLElement {
  const found = menu.element.querySelector<HTMLElement>(`[data-setting="${setting}"]`);
  if (!found) throw new Error(`no control for ${setting}`);
  return found;
}

function setRange(input: HTMLElement, value: number): void {
  if (!(input instanceof HTMLInputElement)) throw new Error('not an input');
  input.value = `${value}`;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function key(target: EventTarget, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  // An open menu holds a capture listener on `window`. Leaving one behind
  // would swallow the keystrokes of every case that ran after it - which is
  // exactly the leak these tests exist to prove is closed, pointed the wrong
  // way round.
  for (const menu of built.splice(0)) menu.dispose();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-mb-motion');
  document.documentElement.removeAttribute('data-mb-contrast');
  vi.unstubAllGlobals();
});

describe('what the HUD imports from this module', () => {
  it('still spells the music state out in words', () => {
    expect(musicLabel(false)).toBe(MUSIC_LABEL_OFF);
    expect(musicLabel(false)).toBe('Music: Off');
    expect(musicLabel(true)).toBe(MUSIC_LABEL_ON);
  });

  it('still publishes a usable control list', () => {
    expect(CONTROL_HINTS.length).toBeGreaterThan(0);
    for (const hint of CONTROL_HINTS) {
      expect(typeof hint.keys).toBe('string');
      expect(hint.keys.length).toBeGreaterThan(0);
      expect(typeof hint.action).toBe('string');
      expect(hint.action.length).toBeGreaterThan(0);
    }
  });
});

describe('tabs', () => {
  it('opens on Mission with exactly one selected tab and one visible panel', () => {
    const { menu } = mount();
    const tabs = [...menu.element.querySelectorAll<HTMLElement>('[role="tab"]')];
    const panels = [...menu.element.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    expect(tabs).toHaveLength(7);
    expect(panels).toHaveLength(7);
    expect(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(panels.filter((panel) => !panel.hidden)).toHaveLength(1);
    expect(menu.tab).toBe('mission');
    expect(tabButton(menu, 'Mission').getAttribute('aria-selected')).toBe('true');
  });

  it('wires every tab to its own panel', () => {
    const { menu } = mount();
    for (const tab of menu.element.querySelectorAll<HTMLElement>('[role="tab"]')) {
      const id = tab.getAttribute('aria-controls');
      const panel = id ? document.getElementById(id) : null;
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
    }
  });

  it('moves aria-selected, the roving tabindex and the panel together on click', () => {
    const { menu, calls } = mount();
    const audio = tabButton(menu, 'Audio');
    const mission = tabButton(menu, 'Mission');
    audio.click();

    expect(menu.tab).toBe('audio');
    expect(audio.getAttribute('aria-selected')).toBe('true');
    expect(audio.tabIndex).toBe(0);
    expect(mission.getAttribute('aria-selected')).toBe('false');
    expect(mission.tabIndex).toBe(-1);

    const audioPanel = document.getElementById(audio.getAttribute('aria-controls') ?? '');
    const missionPanel = document.getElementById(mission.getAttribute('aria-controls') ?? '');
    expect(audioPanel?.hidden).toBe(false);
    expect(missionPanel?.hidden).toBe(true);
    expect(calls.tabs).toEqual(['audio']);
  });

  it('walks the rail with the arrow keys, Home and End', () => {
    const { menu } = mount();
    menu.show();
    const mission = tabButton(menu, 'Mission');
    mission.focus();

    key(mission, { key: 'ArrowRight' });
    expect(menu.tab).toBe('map');
    expect(document.activeElement).toBe(tabButton(menu, 'Map'));

    key(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    expect(menu.tab).toBe('mission');

    // Wraps rather than stopping, so the rail has no dead end.
    key(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    expect(menu.tab).toBe('access');

    key(document.activeElement as HTMLElement, { key: 'Home' });
    expect(menu.tab).toBe('mission');
    key(document.activeElement as HTMLElement, { key: 'End' });
    expect(menu.tab).toBe('access');
  });

  it('leaves the arrow keys alone when focus is not on a tab', () => {
    const { menu } = mount();
    tabButton(menu, 'Audio').click();
    menu.show();
    const slider = control(menu, 'volume-master');
    slider.focus();
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    slider.dispatchEvent(event);
    // The browser's own handling is what moves a range input; cancelling it
    // here would leave the slider unusable by keyboard.
    expect(event.defaultPrevented).toBe(false);
    expect(menu.tab).toBe('audio');
  });
});

describe('the focus trap', () => {
  it('includes the sliders it used to skip', () => {
    const { menu } = mount();
    // The look-speed slider is the last control in the Gameplay section, which
    // makes it the trap's own boundary. Before the fix the query was
    // `button, input[type="radio"]`, so a range input was focusable but not in
    // the cycle, and Shift+Tab here wrapped to a button further up the panel.
    tabButton(menu, 'Gameplay').click();
    menu.show();

    const first = menu.element.querySelector<HTMLElement>('.mb-pause__close');
    expect(first).not.toBeNull();
    first?.focus();
    key(first as HTMLElement, { key: 'Tab', shiftKey: true });

    const last = document.activeElement as HTMLElement;
    expect(menu.element.contains(last)).toBe(true);
    expect(last.dataset.setting).toBe('sensitivity');

    // ...and Tab off that last control comes back round to the first.
    key(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('leaves a slider in the middle of the cycle alone', () => {
    const { menu } = mount();
    tabButton(menu, 'Audio').click();
    menu.show();
    const ambience = control(menu, 'volume-ambience');
    ambience.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    ambience.dispatchEvent(event);
    // The music button is after it, so the trap must not intervene: the
    // browser's own Tab has to do the move.
    expect(event.defaultPrevented).toBe(false);
  });

  it('never counts a control inside a hidden panel', () => {
    const { menu } = mount();
    menu.show();
    // Mission is showing, so the audio sliders are in a hidden panel and Tab
    // must not walk into them.
    const master = control(menu, 'volume-master');
    expect(master.closest('[hidden]')).not.toBeNull();
    const first = menu.element.querySelector<HTMLElement>('.mb-pause__close');
    first?.focus();
    key(first as HTMLElement, { key: 'Tab', shiftKey: true });
    const last = document.activeElement as HTMLElement;
    expect(last.closest('[hidden]')).toBeNull();
    expect(last.getAttribute('role')).toBe('tabpanel');
  });

  it('pulls focus back into the dialog when it is somewhere else entirely', () => {
    const { menu } = mount();
    menu.show();
    (document.activeElement as HTMLElement).blur();
    expect(menu.element.contains(document.activeElement)).toBe(false);
    key(document.body, { key: 'Tab' });
    expect(menu.element.contains(document.activeElement)).toBe(true);
  });
});

describe('the keyboard, while the menu is up', () => {
  it('stops a keystroke reaching the window listeners the game binds', () => {
    const { menu } = mount();
    const seen: string[] = [];
    const listener = (event: Event): void => {
      seen.push((event as KeyboardEvent).key);
    };
    window.addEventListener('keydown', listener);
    try {
      menu.show();
      // Every place focus can be: the body (where a backdrop click used to put
      // it), the backdrop element itself, a control, and the panel.
      key(document.body, { key: 'm' });
      key(menu.element, { key: 'F3' });
      key(control(menu, 'volume-master'), { key: '3' });
      key(document, { key: 'w' });
      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener('keydown', listener);
    }
  });

  it('lets a key RELEASE through, so nothing is left held down on resume', () => {
    const { menu } = mount();
    const seen: string[] = [];
    const listener = (event: Event): void => {
      seen.push((event as KeyboardEvent).key);
    };
    window.addEventListener('keyup', listener);
    try {
      menu.show();
      document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', bubbles: true }));
      expect(seen).toEqual(['w']);
    } finally {
      window.removeEventListener('keyup', listener);
    }
  });

  it('gives the keyboard back to the game once it closes', () => {
    const { menu } = mount();
    const seen: string[] = [];
    const listener = (event: Event): void => {
      seen.push((event as KeyboardEvent).key);
    };
    window.addEventListener('keydown', listener);
    try {
      menu.show();
      menu.hide();
      key(document.body, { key: 'm' });
      expect(seen).toEqual(['m']);
    } finally {
      window.removeEventListener('keydown', listener);
    }
  });

  it('closes on Escape from anywhere in the overlay', () => {
    const { menu, calls } = mount();
    menu.show();
    key(document.body, { key: 'Escape' });
    expect(menu.visible).toBe(false);
    expect(calls.resume).toBe(1);
    expect(menu.element.getAttribute('aria-hidden')).toBe('true');
    expect(menu.element.hasAttribute('inert')).toBe(true);
  });

  it('ignores Escape when it is not open', () => {
    const { calls } = mount();
    key(document.body, { key: 'Escape' });
    expect(calls.resume).toBe(0);
  });
});

describe('closing', () => {
  it('resumes from the X as well as from Resume', () => {
    const { menu, calls } = mount();
    menu.show();
    menu.element.querySelector<HTMLButtonElement>('.mb-pause__close')?.click();
    expect(calls.resume).toBe(1);
    expect(menu.visible).toBe(false);

    menu.show();
    menu.element.querySelector<HTMLButtonElement>('.mb-pause__resume')?.click();
    expect(calls.resume).toBe(2);
    expect(menu.visible).toBe(false);
  });

  it('restores what had focus before it opened', () => {
    const opener = document.createElement('div');
    opener.tabIndex = 0;
    document.body.append(opener);
    const { menu } = mount();
    opener.focus();
    expect(document.activeElement).toBe(opener);

    menu.show();
    expect(menu.element.contains(document.activeElement)).toBe(true);

    menu.hide();
    expect(document.activeElement).toBe(opener);
  });

  it('refuses to hand focus back to a control that would eat the game keys', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    const { menu } = mount();
    opener.focus();
    menu.show();
    menu.hide();
    expect(document.activeElement).not.toBe(opener);
    expect(menu.element.contains(document.activeElement)).toBe(false);
  });
});

describe('the settings, and what each one calls', () => {
  it('reports every volume channel as a 0-1 level', () => {
    const { menu, calls } = mount();
    tabButton(menu, 'Audio').click();
    setRange(control(menu, 'volume-master'), 40);
    setRange(control(menu, 'volume-music'), 0);
    setRange(control(menu, 'volume-effects'), 100);
    setRange(control(menu, 'volume-ambience'), 55);
    expect(calls.volume).toEqual([
      ['master', 0.4],
      ['music', 0],
      ['effects', 1],
      ['ambience', 0.55],
    ]);
  });

  it('seeds each slider from the level it was given', () => {
    const { menu } = mount();
    expect((control(menu, 'volume-master') as HTMLInputElement).value).toBe('80');
    expect((control(menu, 'volume-music') as HTMLInputElement).value).toBe('50');
    expect((control(menu, 'volume-effects') as HTMLInputElement).value).toBe('90');
    expect((control(menu, 'volume-ambience') as HTMLInputElement).value).toBe('40');
  });

  it('announces the same number it prints', () => {
    const { menu } = mount();
    const master = control(menu, 'volume-master');
    setRange(master, 62);
    expect(master.getAttribute('aria-valuetext')).toBe('62 percent');
    expect(master.parentElement?.querySelector('.mb-slider__value')?.textContent).toBe('62%');
    expect(master.style.getPropertyValue('--mb-fill')).toBe('62%');
  });

  it('reports a quality change once, and not when it did not change', () => {
    const { menu, calls } = mount();
    const low = menu.element.querySelector<HTMLInputElement>('input[value="low"]');
    expect(low).not.toBeNull();
    if (!low) return;
    low.checked = true;
    low.dispatchEvent(new Event('change'));
    expect(calls.quality).toEqual(['low']);
    low.dispatchEvent(new Event('change'));
    expect(calls.quality).toEqual(['low']);
  });

  it('keeps the music button and its label in step', () => {
    const { menu, calls } = mount();
    const music = menu.element.querySelector<HTMLButtonElement>('.mb-button--stateful');
    expect(music?.textContent).toBe(MUSIC_LABEL_OFF);
    music?.click();
    expect(calls.music).toEqual([true]);
    expect(music?.textContent).toBe(MUSIC_LABEL_ON);
    expect(music?.getAttribute('aria-pressed')).toBe('true');

    // The application answers with the state it actually reached.
    menu.setMusicEnabled(false);
    expect(music?.textContent).toBe(MUSIC_LABEL_OFF);
    expect(music?.getAttribute('aria-pressed')).toBe('false');
  });

  it('turns the look-speed slider into radians per pixel and remembers it', () => {
    const { menu, calls } = mount();
    tabButton(menu, 'Gameplay').click();
    setRange(control(menu, 'sensitivity'), 100);
    expect(calls.sensitivity).toHaveLength(1);
    expect(calls.sensitivity[0]).toBeCloseTo(SENSITIVITY_MAX, 6);
    expect(loadSettings().sensitivity).toBeCloseTo(SENSITIVITY_MAX, 6);

    setRange(control(menu, 'sensitivity'), 0);
    expect(calls.sensitivity[1]).toBeCloseTo(SENSITIVITY_MIN, 6);
  });

  it('puts the shipped default in the middle of the slider, not at one fifth', () => {
    expect(sliderFromSensitivity(SENSITIVITY_DEFAULT)).toBeGreaterThan(45);
    expect(sliderFromSensitivity(SENSITIVITY_DEFAULT)).toBeLessThan(60);
    // Round trip, at both ends and in between.
    for (const position of [0, 25, 53, 76, 100]) {
      expect(sliderFromSensitivity(sensitivityFromSlider(position))).toBe(position);
    }
    expect(sensitivityFromSlider(-40)).toBeCloseTo(SENSITIVITY_MIN, 8);
    expect(sensitivityFromSlider(400)).toBeCloseTo(SENSITIVITY_MAX, 8);
  });

  it('applies the interface preferences to the document and remembers them', () => {
    const { menu } = mount();
    tabButton(menu, 'Accessibility').click();
    const motion = control(menu, 'reduced-motion');
    const contrast = control(menu, 'high-contrast');
    expect(document.documentElement.hasAttribute('data-mb-motion')).toBe(false);

    motion.click();
    expect(document.documentElement.getAttribute('data-mb-motion')).toBe('reduced');
    expect(motion.getAttribute('aria-pressed')).toBe('true');
    expect(motion.textContent).toBe('On');
    expect(loadSettings().reducedMotion).toBe(true);

    contrast.click();
    expect(document.documentElement.getAttribute('data-mb-contrast')).toBe('high');
    expect(loadSettings().highContrast).toBe(true);

    motion.click();
    expect(document.documentElement.hasAttribute('data-mb-motion')).toBe(false);
    expect(loadSettings().reducedMotion).toBe(false);

    // A later menu picks the stored preferences up rather than starting fresh.
    const second = mount();
    expect(document.documentElement.getAttribute('data-mb-contrast')).toBe('high');
    second.menu.dispose();
  });

  it('falls back to the shipped defaults when storage holds nonsense', () => {
    localStorage.setItem('meridian.settings', '{"sensitivity":"fast","highContrast":"yes"');
    expect(loadSettings().sensitivity).toBe(SENSITIVITY_DEFAULT);
    expect(loadSettings().highContrast).toBe(false);
  });
});

describe('what the application pushes in', () => {
  it('shows the objective the mission director published', () => {
    const { menu } = mount();
    const title = menu.element.querySelector('.mb-pause__objective-title');
    const detail = menu.element.querySelector<HTMLElement>('.mb-pause__objective-detail');
    expect(title?.textContent).toBe('Nothing on the board');
    expect(detail?.hidden).toBe(true);

    menu.setObjective('Collect the takings', 'The lock-up in the Cannery.');
    expect(title?.textContent).toBe('Collect the takings');
    expect(detail?.textContent).toBe('The lock-up in the Cannery.');
    expect(detail?.hidden).toBe(false);

    menu.setMission({ title: 'Paid', detail: 'Come back when you want the next one.' });
    expect(title?.textContent).toBe('Paid');

    menu.setMission(null);
    expect(title?.textContent).toBe('Nothing on the board');
    expect(detail?.hidden).toBe(true);
  });

  it('adds a control section, and survives one that does not exist yet', () => {
    const { menu } = mount();
    const count = (): number => menu.element.querySelectorAll('.mb-keylist').length;
    expect(count()).toBe(1);

    menu.setControlSections([
      { title: 'Flight', hints: [{ keys: 'W / S', action: 'Throttle' }] },
    ]);
    expect(count()).toBe(2);
    expect(menu.element.textContent).toContain('Throttle');

    // The module that owns the aircraft bindings may not export them yet.
    const missing = undefined as unknown as { title: string; hints: never[] }[];
    menu.setControlSections(missing);
    expect(count()).toBe(1);

    menu.setControlSections([{ title: 'Flight', hints: [] }]);
    expect(count()).toBe(1);
  });

  it('offers an empty map container and hides its placeholder once filled', () => {
    const { menu } = mount();
    expect(menu.mapPanel.childElementCount).toBe(0);
    const placeholder = menu.element.querySelector<HTMLElement>('.mb-pause__empty');
    tabButton(menu, 'Map').click();
    expect(placeholder?.hidden).toBe(false);

    menu.mapPanel.append(document.createElement('canvas'));
    tabButton(menu, 'Mission').click();
    tabButton(menu, 'Map').click();
    expect(placeholder?.hidden).toBe(true);
  });
});

describe('the dialog itself', () => {
  it('is named by what it says rather than by a duplicate string', () => {
    const { menu } = mount();
    const panel = menu.element.querySelector<HTMLElement>('[role="dialog"]');
    expect(panel?.getAttribute('aria-modal')).toBe('true');
    expect(panel?.hasAttribute('aria-label')).toBe(false);
    const ids = panel?.getAttribute('aria-labelledby')?.split(' ') ?? [];
    expect(ids).toHaveLength(2);
    const named = ids.map((id) => document.getElementById(id)?.textContent);
    expect(named[0]).toBe('Paused');
    expect(named[1]).toBeTruthy();
  });

  it('names its lists with real headings', () => {
    const { menu } = mount();
    const lists = [...menu.element.querySelectorAll<HTMLElement>('dl')];
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      const id = list.getAttribute('aria-labelledby');
      expect(id).toBeTruthy();
      const heading = id ? document.getElementById(id) : null;
      expect(heading?.tagName).toBe('H2');
    }
  });

  it('is inert and hidden until it is opened', () => {
    const { menu } = mount();
    expect(menu.element.getAttribute('aria-hidden')).toBe('true');
    expect(menu.element.hasAttribute('inert')).toBe(true);

    menu.show();
    expect(menu.element.getAttribute('aria-hidden')).toBe('false');
    expect(menu.element.hasAttribute('inert')).toBe(false);
    expect(menu.element.classList.contains('is-open')).toBe(true);
    expect(menu.element.contains(document.activeElement)).toBe(true);
  });

  it('opens on the section it was asked for', () => {
    const { menu } = mount();
    menu.show('map');
    expect(menu.tab).toBe('map');
  });

  it('takes itself apart without leaving a listener on the window', () => {
    const { menu } = mount();
    const seen: string[] = [];
    const listener = (event: Event): void => {
      seen.push((event as KeyboardEvent).key);
    };
    window.addEventListener('keydown', listener);
    try {
      menu.show();
      menu.dispose();
      key(document.body, { key: 'm' });
      expect(seen).toEqual(['m']);
      expect(menu.element.isConnected).toBe(false);
    } finally {
      window.removeEventListener('keydown', listener);
    }
  });
});
