/**
 * Who everybody is, and what any of this is about.
 *
 * The city was built before the story was: `CityPlan` lays out Meridian Bay
 * from a seed and knows nothing about people. This module is the other half -
 * the game's own identity and its cast - and it is deliberately ONE file of
 * plain data with no Three.js, no DOM and no imports from the simulation, so
 * the loading screen, the pause menu, the mission and the tests all read the
 * same names rather than each spelling them out.
 *
 * NOTHING HERE IS A REFERENCE TO ANYTHING REAL. Meridian Bay, its districts,
 * its businesses and its people are invented for this project. The game's
 * title is the user's own.
 */

/** The game. The CITY is Meridian Bay; they are not the same name. */
export const GAME_NAME = 'GTA Vibe';
export const CITY_NAME = 'Meridian Bay';

/**
 * One line, for a browser tab and a page description.
 */
export const GAME_TAGLINE = 'Come back to Meridian Bay and find out who owns it now.';

/**
 * The setting, in the words the pause menu shows.
 *
 * Two paragraphs and no more: this is a card the player reads once while
 * deciding whether to press Resume, not a manual.
 */
export const GAME_PREMISE =
  'Meridian Bay is a working coastal city: a container harbour, a close-grained ' +
  'old quarter, a small downtown, and terraced streets climbing the ridge ' +
  'behind it. The money comes off the water, and it belongs to whoever holds ' +
  'the lock-ups it passes through on the way inland.';

export const PROTAGONIST_PREMISE =
  'You are Marlo Vance. You have been away eight years, you own a car you did ' +
  'not pay for, and everybody you used to know is either running something now ' +
  'or working for somebody who is. Sable Ruiz has a job. It is not a favour.';

/** The player. Never drawn - there is no avatar - but named everywhere else. */
export const PROTAGONIST = {
  id: 'marlo',
  name: 'Marlo Vance',
  shortName: 'Vance',
} as const;

export interface CastMember {
  readonly id: string;
  readonly name: string;
  /** What the HUD calls them when they are the objective. */
  readonly shortName: string;
  readonly role: string;
  /**
   * Which baked character stands in for them, from `PEDESTRIAN_VAT_IDS` plus
   * the two dedicated bakes. Null for anybody who is never on screen.
   */
  readonly character: string | null;
  /** One line of who they are, for the pause menu's cast list. */
  readonly blurb: string;
}

/**
 * Everybody with a name.
 *
 * Two of the three reuse a baked crowd character rather than getting their
 * own: a generated head costs sixty-five credits and a two-megabyte download,
 * and a shopkeeper standing behind a counter is somebody the player looks at
 * for about four seconds. Sable is the exception, because the game is named
 * after her club and the player is sent to her twice.
 */
export const CAST = {
  sable: {
    id: 'sable',
    name: 'Sable Ruiz',
    shortName: 'Sable',
    role: 'Owner, The Vibe',
    character: 'ped-sable',
    blurb:
      'Runs the club on Harbour Walk, books the bands, pays the harbour master, ' +
      'and keeps a lock-up in the Cannery that is on nobody’s manifest. She ' +
      'does not hire people. She tests them.',
  },
  teo: {
    id: 'teo',
    name: 'Teodor Krall',
    shortName: 'Teo',
    role: 'Watchman, Cannery lock-up',
    character: 'ped-a',
    blurb:
      'Minds the lock-up. Has been sitting on somebody else’s money for two ' +
      'nights and has told at least one person about it.',
  },
  ilse: {
    id: 'ilse',
    name: 'Ilse Bellhouse',
    shortName: 'Ilse',
    role: 'Proprietor, Bellhouse Arms',
    character: 'ped-c',
    blurb:
      'Sells the guns in the Old Quarter. Writes everything down and asks ' +
      'nothing.',
  },
} as const satisfies Readonly<Record<string, CastMember>>;

/** The club the game is named after. */
export const VENUE_NAME = 'The Vibe';
