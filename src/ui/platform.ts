/**
 * What the player's keyboard actually says.
 *
 * The game binds one set of keys, but the LABELS for those keys are not the
 * same on every machine, and printing the wrong one is worse than printing
 * nothing: a hint that says "F3" on a MacBook is a hint that does not work,
 * because F3 is Mission Control there unless `fn` is held. Everything in this
 * module is presentation. No binding is platform-dependent - only the words
 * used to describe it - so a hint can never drift away from the key it names.
 *
 * DETECTION. `navigator.userAgentData.platform` where the browser has it,
 * falling back to `navigator.platform`, falling back to the user agent string.
 * The fallbacks matter: Safari has never shipped `userAgentData`, and this is
 * a game that has to work on the machine the player already has.
 */

export type Platform = 'mac' | 'windows' | 'linux' | 'other';

interface PlatformSource {
  readonly userAgentData?: { readonly platform?: string } | undefined;
  readonly platform?: string | undefined;
  readonly userAgent?: string | undefined;
}

/**
 * The current platform, decided once.
 *
 * `source` exists so the tests can ask about a machine they are not running
 * on; nothing in the game passes it.
 */
export function detectPlatform(source?: PlatformSource): Platform {
  const nav: PlatformSource | undefined =
    source ?? (typeof navigator === 'undefined' ? undefined : (navigator as PlatformSource));
  if (!nav) return 'other';
  const raw = (nav.userAgentData?.platform || nav.platform || nav.userAgent || '').toLowerCase();
  // iPadOS reports itself as a Mac, which for a keyboard label is the right
  // answer anyway: an iPad keyboard has a Command key, not a Windows key.
  if (raw.includes('mac') || raw.includes('iphone') || raw.includes('ipad')) return 'mac';
  if (raw.includes('win')) return 'windows';
  if (raw.includes('linux') || raw.includes('android') || raw.includes('x11')) return 'linux';
  return 'other';
}

export interface ControlHint {
  readonly keys: string;
  readonly action: string;
}

/**
 * The control list, in the words of the machine it is being read on.
 *
 * Three entries differ by platform and every one of them is a real difference
 * rather than decoration:
 *
 *  - PERFORMANCE STATS. Bound to both `F3` and the backquote. On a Mac the
 *    function-key row is media control by default, so `F3` alone opens Mission
 *    Control and never reaches the page; the backquote is named first there
 *    and `fn` is named with the F-key. On Windows and Linux `F3` is just `F3`.
 *  - SHIFT and ESC. Mac keyboards print the glyphs, so the hint prints them
 *    too, with the word kept alongside for anyone whose keyboard does not.
 *  - WEAPONS. Named as a range plus the scroll wheel everywhere, because the
 *    wheel is the fallback for any layout where the number row needs a
 *    modifier - AZERTY, among others - and for a trackpad with no number row
 *    in comfortable reach at all.
 */
export function controlHints(platform: Platform = detectPlatform()): readonly ControlHint[] {
  const mac = platform === 'mac';
  return [
    { keys: 'Arrow keys / WASD', action: 'Move' },
    { keys: mac ? '⇧ Shift' : 'Shift', action: 'Run' },
    { keys: 'Mouse', action: 'Look' },
    { keys: 'E', action: 'Enter a car, a door or a shop' },
    { keys: 'Left mouse', action: 'Fire' },
    { keys: '1 - 5 / scroll wheel', action: 'Select a weapon' },
    { keys: 'H', action: 'Holster or draw' },
    { keys: 'R', action: 'Reload' },
    { keys: 'Space', action: 'Handbrake (driving)' },
    { keys: 'M', action: 'Map' },
    { keys: mac ? '` or fn + F3' : '` or F3', action: 'Performance stats' },
    { keys: mac ? '⎋ Esc' : 'Esc', action: 'Pause' },
  ];
}
