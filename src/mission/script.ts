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
  /* ---- the airport leg: the same job, and the reason it is not over ---- */
  /** Paid, and Sable has one more thing to say. */
  | 'chartered'
  /** Sable is explaining the flight. */
  | 'briefingFlight'
  /** Drive out to Meridian Bay Regional. */
  | 'toAirport'
  /** Through the terminal to the airside door. */
  | 'concourse'
  /** Find the aircraft on its stand and get in. */
  | 'boarding'
  /** Get it off the runway. */
  | 'departing'
  /** Out over the bay with the box. */
  | 'outbound'
  /** Sable is on the radio. */
  | 'handoff'
  /** Bring the aircraft home. */
  | 'inbound'
  /** Down, stopped, and Sable is talking. */
  | 'shutdown'
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
  readonly waypoint:
    | 'nightclub'
    | 'workshop'
    | 'terminalDoor'
    | 'gateDoor'
    | 'stand'
    | 'runway'
    | 'dropPoint'
    | null;
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
  chartered: {
    title: 'Sable is not finished',
    detail: `${CLUB_STREET_TOKEN}. She has one more thing to ask.`,
    waypoint: 'nightclub',
  },
  briefingFlight: {
    title: 'Sable is not finished',
    detail: 'Listening.',
    waypoint: null,
  },
  toAirport: {
    title: 'Get out to Meridian Bay Regional',
    detail: 'South of the city. Go in through the terminal, like a passenger.',
    waypoint: 'terminalDoor',
  },
  concourse: {
    title: 'Cross the terminal',
    detail: 'Airside door, past the gates. Nobody is looking for you yet.',
    waypoint: 'gateDoor',
  },
  boarding: {
    title: "Take Sable's aircraft",
    detail: 'Stand four, on the apron. Fuelled and in her name.',
    waypoint: 'stand',
  },
  departing: {
    title: 'Get airborne',
    detail: 'Taxi out and take the runway. Keep the box with you.',
    waypoint: 'runway',
  },
  outbound: {
    title: 'Carry the takings out over the bay',
    detail: 'West, over the water. Sable will call it.',
    waypoint: 'dropPoint',
  },
  handoff: {
    title: 'Carry the takings out over the bay',
    detail: 'Sable is on the radio.',
    waypoint: null,
  },
  inbound: {
    title: 'Bring the aircraft home',
    detail: 'Back to the field, and land it. She is insured for the money, not the plane.',
    waypoint: 'runway',
  },
  shutdown: {
    title: 'Bring the aircraft home',
    detail: 'Down, and stopped.',
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

/** Every conversation in the job, in the order they happen. */
export const CONVERSATIONS: Readonly<
  Record<'briefing' | 'handover' | 'payout' | 'charter' | 'handoff' | 'landed', readonly Beat[]>
> = {
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
  /*
   * The turn.
   *
   * Deliberately a SECOND press of E rather than four more lines stapled onto
   * the payout: the player has just been paid and told the job is done, and
   * the job not being done is the beat. Making them choose to hear it is what
   * turns thirty seconds of talking into a decision.
   */
  charter: [
    { line: 'dlg/sable-charter-1', hold: 0.35 },
    { line: 'dlg/sable-charter-2', hold: 0.3 },
    { line: 'dlg/sable-charter-2b', hold: 0.35 },
    { line: 'dlg/sable-charter-3', hold: 0.6 },
  ],
  /** Over the radio, at the drop point. Sable is not in the aircraft. */
  handoff: [{ line: 'dlg/sable-handoff-1', hold: 0.5 }],
  landed: [{ line: 'dlg/sable-landed-1', hold: 0.6 }],
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

/** What the charter pays on top of the delivery fee. */
export const CHARTER_FEE = 18000;

/**
 * Where the takings leave Meridian Bay.
 *
 * Out over the water, west of the shoreline and south of the city, about
 * 550 m from the runway. Far enough that the player has to climb, turn and
 * navigate rather than hop the fence, and close enough that the round trip is
 * a few minutes rather than a commute. Held here rather than in the airport
 * layout because it is a story location, not a piece of infrastructure.
 */
export const DROP_POINT = { x: -215, z: 230 } as const;

/** How near the drop point counts as arriving. A radius, not a point, because
 *  an aircraft at 60 m/s cannot be asked to hit a coordinate. */
export const DROP_RADIUS = 90;

/** Minimum height above the airfield that counts as "airborne". */
export const AIRBORNE_HEIGHT = 45;

/** On the ground, on the field, and slower than this: shut down. */
export const SHUTDOWN_SPEED = 2.5;

/**
 * How near a place waypoint counts as arriving, on foot or in a car.
 *
 * 22 m rather than a doorstep: the terminal is 190 m long, and the objective
 * is "get to the airport", not "stand on a specific paving slab".
 */
export const ARRIVAL_RADIUS = 22;

/** The mission's own name, for the banner that announces it. */
export const MISSION_NAME = 'Last Call';
export const MISSION_GIVER = 'Sable Ruiz';
