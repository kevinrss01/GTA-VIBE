/**
 * "Last Call" - the first job in GTA Vibe, as data.
 *
 * The whole mission is four objectives and seven spoken lines, and all of both
 * are here. `Mission.ts` is a state machine over this file and holds no
 * strings of its own, so changing what Sable asks for is a change to one
 * table rather than a change to control flow.
 *
 * No Three.js, no DOM, no audio: this is a script, and it is asserted as one.
 */

import type { DialogueAssetId } from '../audio/manifest';

/** What the player is doing right now. */
export type MissionStage =
  /** Not started. The waypoint points at the club. */
  | 'offered'
  /** Sable is talking. */
  | 'briefing'
  /** Drive to the Cannery lock-up. */
  | 'collect'
  /** Teo is talking. */
  | 'handover'
  /** Get the box back to the club. */
  | 'deliver'
  /** Sable is paying. */
  | 'payout'
  | 'complete';

export interface Objective {
  /** One line, shown in the HUD for the whole of this stage. */
  readonly title: string;
  /** The second line, which says why. */
  readonly detail: string;
  /**
   * Which building the waypoint points at.
   *
   * An `InteriorKind` rather than a coordinate: the city is generated from a
   * seed, so the club is wherever the plan put it, and a hard-coded position
   * would be wrong the first time anybody changed the seed.
   */
  readonly waypoint: 'nightclub' | 'workshop' | null;
}

/**
 * Stands in for the street the club actually fronts.
 *
 * The same reason `waypoint` is a building and not a coordinate: which street
 * The Vibe opens onto is decided by the generator, and the first version of
 * this line simply asserted "Harbour Walk" - which was wrong for the shipping
 * seed. `MissionDirector` asks the plan and substitutes.
 */
export const CLUB_STREET_TOKEN = '{clubStreet}';

export const OBJECTIVES: Readonly<Record<MissionStage, Objective>> = {
  offered: {
    title: 'See Sable at The Vibe',
    detail: `${CLUB_STREET_TOKEN}. She asked for you by name.`,
    waypoint: 'nightclub',
  },
  briefing: {
    title: 'See Sable at The Vibe',
    detail: 'Listening.',
    waypoint: null,
  },
  collect: {
    title: 'Collect the takings',
    detail: 'The lock-up in the Cannery. Teo is expecting somebody.',
    waypoint: 'workshop',
  },
  handover: {
    title: 'Collect the takings',
    detail: 'Teo has something to tell you.',
    waypoint: null,
  },
  deliver: {
    title: 'Get the box back to The Vibe',
    detail: 'Somebody made a call. Do not stop.',
    waypoint: 'nightclub',
  },
  payout: {
    title: 'Get the box back to The Vibe',
    detail: 'Sable is counting.',
    waypoint: null,
  },
  complete: {
    title: 'Paid',
    detail: 'Come back when you want the next one.',
    waypoint: null,
  },
};

/** One spoken beat: a recording, and how long to leave the subtitle up. */
export interface Beat {
  readonly line: DialogueAssetId;
  /** Extra seconds held after the audio ends, so a line can land. */
  readonly hold: number;
}

/** The three conversations, in the order they happen. */
export const CONVERSATIONS: Readonly<Record<'briefing' | 'handover' | 'payout', readonly Beat[]>> = {
  briefing: [
    { line: 'dlg/sable-brief-1', hold: 0.35 },
    { line: 'dlg/sable-brief-2', hold: 0.35 },
    { line: 'dlg/sable-brief-3', hold: 0.6 },
  ],
  handover: [
    { line: 'dlg/teo-handover-1', hold: 0.35 },
    { line: 'dlg/teo-handover-2', hold: 0.6 },
  ],
  payout: [
    { line: 'dlg/sable-paid-1', hold: 0.35 },
    { line: 'dlg/sable-paid-2', hold: 0.6 },
  ],
};

/** What the job pays. */
export const MISSION_FEE = 7500;

/**
 * Heat added when Teo admits he talked.
 *
 * Two stars: enough that patrol cars come looking and the drive back is a
 * chase, and short of the three at which officers shoot on sight. The job is
 * meant to be survivable in a car, not a firefight.
 */
export const TIP_OFF_HEAT = 70;

/** How near the player must be to a building to be offered its conversation. */
export const TALK_RANGE = 3.2;

/** The mission's own name, for the banner that announces it. */
export const MISSION_NAME = 'Last Call';
export const MISSION_GIVER = 'Sable Ruiz';
