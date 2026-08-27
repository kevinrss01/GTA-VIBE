/**
 * "Last Call", played start to finish without a browser.
 *
 * The mission is a state machine over `script.ts` that owns no geometry, no
 * audio graph and no DOM, which is what makes this possible: the whole job -
 * briefing, drive, pickup, tip-off, return, payment - runs here in a few
 * milliseconds, so a change to the objective order or the fee cannot ship
 * without somebody having said so.
 *
 * The city is the real one, generated from the real seed, because where the
 * club and the lock-up are is exactly the thing that must not be assumed.
 */

import { describe, expect, it } from 'vitest';

import { getCityPlan } from '../src/world/CityPlan';
import { PlayerState, STARTING_MONEY } from '../src/player/PlayerState';
import { MissionDirector, type DialoguePlayer } from '../src/mission/Mission';
import {
  CONVERSATIONS,
  MISSION_FEE,
  OBJECTIVES,
  TIP_OFF_HEAT,
  type MissionStage,
} from '../src/mission/script';
import {
  interiorFurnishings,
  lockupCrateAt,
  nightclubAnchor,
  lockupAnchor,
} from '../src/world/build/interiorProps';

const plan = getCityPlan();

/**
 * A dialogue player that speaks instantly.
 *
 * `finish()` is the test's stand-in for the seconds of audio: everything the
 * mission does at the END of a conversation happens when it is called, which
 * is exactly the seam the real `Dialogue` uses.
 */
class FakeDialogue implements DialoguePlayer {
  spoken: string[][] = [];
  speaking = false;
  private pending: (() => void) | null = null;

  say(beats: readonly { line: string; hold: number }[], onFinished?: () => void): void {
    this.spoken.push(beats.map((beat) => beat.line));
    this.speaking = true;
    this.pending = onFinished ?? null;
  }

  /** Runs the conversation to its end, as the real player does on the clock. */
  finish(): void {
    this.speaking = false;
    const pending = this.pending;
    this.pending = null;
    pending?.();
  }
}

interface Harness {
  readonly mission: MissionDirector;
  readonly player: PlayerState;
  readonly dialogue: FakeDialogue;
  readonly barId: string;
  readonly crateId: string;
  readonly objectives: MissionStage[];
  readonly waypoints: (string | null)[];
  /** How many times the world was told to stop drawing the crate. */
  readonly taken: { count: number };
}

function harness(): Harness {
  const player = new PlayerState();
  const dialogue = new FakeDialogue();
  const objectives: MissionStage[] = [];
  const waypoints: (string | null)[] = [];
  const taken = { count: 0 };
  const mission = new MissionDirector({
    plan,
    player,
    dialogue,
    onObjective: (objective) => {
      const stage = (Object.keys(OBJECTIVES) as MissionStage[]).find(
        (key) => OBJECTIVES[key] === objective,
      );
      if (stage) objectives.push(stage);
    },
    onWaypoint: (waypoint) => waypoints.push(waypoint?.label ?? null),
    onCrateTaken: () => {
      taken.count += 1;
    },
  });
  const club = plan.parcels.find((p) => p.interiorKind === 'nightclub');
  const lockup = plan.parcels.find((p) => p.interiorKind === 'workshop');
  expect(club, 'the city has no nightclub').toBeDefined();
  expect(lockup, 'the city has no lock-up').toBeDefined();
  return {
    mission,
    player,
    dialogue,
    barId: `nightclub-bar-${club?.id ?? ''}`,
    crateId: `lockup-crate-${lockup?.id ?? ''}`,
    objectives,
    waypoints,
    taken,
  };
}

describe('the city the mission needs', () => {
  it('has a nightclub and a lock-up, in the districts the story says', () => {
    const club = plan.parcels.find((p) => p.interiorKind === 'nightclub');
    const lockup = plan.parcels.find((p) => p.interiorKind === 'workshop');
    expect(club?.district).toBe('harbourside');
    expect(lockup?.district).toBe('cannery');
  });

  /*
   * MEASURED, not hoped for: 110 m as the crow flies between the club on
   * Harbour Walk and the lock-up in the Cannery.
   *
   * The road distance is longer - the two are in different districts with a
   * block grid between them - and the job's length comes from the two
   * conversations, the two interiors and a two-star chase on the way back as
   * much as from the driving. The lower bound is set at the real figure with a
   * little slack, so a future change that puts the lock-up next door to the
   * club fails here rather than quietly turning the mission into a walk.
   */
  it('puts the two of them far enough apart to be a drive', () => {
    const club = plan.parcels.find((p) => p.interiorKind === 'nightclub');
    const lockup = plan.parcels.find((p) => p.interiorKind === 'workshop');
    if (!club || !lockup) return;
    const gap = Math.hypot(
      (club.rect.minX + club.rect.maxX) / 2 - (lockup.rect.minX + lockup.rect.maxX) / 2,
      (club.rect.minZ + club.rect.maxZ) / 2 - (lockup.rect.minZ + lockup.rect.maxZ) / 2,
    );
    expect(gap).toBeGreaterThan(90);
    expect(gap).toBeLessThan(600);
  });

  it('stands Sable behind her bar and Teo beside the crate, both indoors', () => {
    const club = plan.parcels.find((p) => p.interiorKind === 'nightclub');
    const lockup = plan.parcels.find((p) => p.interiorKind === 'workshop');
    if (!club || !lockup) return;

    const sable = nightclubAnchor(club);
    expect(sable).not.toBeNull();
    if (sable) {
      expect(sable.x).toBeGreaterThan(club.rect.minX);
      expect(sable.x).toBeLessThan(club.rect.maxX);
      expect(sable.z).toBeGreaterThan(club.rect.minZ);
      expect(sable.z).toBeLessThan(club.rect.maxZ);
      expect(Number.isFinite(sable.heading)).toBe(true);
    }

    const crate = lockupCrateAt(lockup);
    const teo = lockupAnchor(lockup);
    expect(crate).not.toBeNull();
    expect(teo).not.toBeNull();
    if (crate && teo) {
      // Beside the crate, not standing in it and not across the room from it.
      const gap = Math.hypot(teo.x - crate.x, teo.z - crate.z);
      expect(gap).toBeGreaterThan(0.6);
      expect(gap).toBeLessThan(2.0);
    }
  });

  /*
   * The precondition `Furnishings.setPieceVisible` is built on.
   *
   * A room draws one instanced mesh per model, so hiding the crate hides every
   * `cashBox` in the lock-up. That is correct while there is exactly one, and
   * `setPieceVisible` refuses to hide anything when there is not - so this is
   * the test that says which of those two worlds we are in.
   */
  it('puts exactly one cash box in the lock-up, so hiding it hides only it', () => {
    const lockup = plan.parcels.find((p) => p.interiorKind === 'workshop');
    expect(lockup).toBeDefined();
    if (!lockup) return;
    const boxes = interiorFurnishings(lockup).filter((piece) => piece.model === 'cashBox');
    expect(boxes).toHaveLength(1);
  });

  it('returns nothing for a building that is not theirs', () => {
    const other = plan.parcels.find((p) => p.interiorKind === 'cafe');
    expect(other).toBeDefined();
    if (!other) return;
    expect(nightclubAnchor(other)).toBeNull();
    expect(lockupAnchor(other)).toBeNull();
    expect(lockupCrateAt(other)).toBeNull();
  });
});

describe('Last Call', () => {
  it('starts by pointing at the club and asking for nothing else', () => {
    const h = harness();
    expect(h.mission.stage).toBe('offered');
    expect(h.mission.carrying).toBe(false);
    expect(h.waypoints.at(-1)).toBe('The Vibe');
    expect(h.mission.promptFor(h.barId)).toContain('Sable');
  });

  it('will not let the crate be taken before it has been asked for', () => {
    const h = harness();
    expect(h.mission.promptFor(h.crateId)).toContain('padlocked');
    h.mission.activate(h.crateId);
    expect(h.mission.carrying).toBe(false);
    expect(h.mission.stage).toBe('offered');
    expect(h.taken.count).toBe(0);
  });

  /*
   * The box leaves the room when it is lifted, ONCE.
   *
   * `main.ts` hangs `Furnishings.setPieceVisible` off this, so a second call
   * would be harmless but a missing one leaves the crate sitting on the bench
   * after the player has carried it across the city - and a call on the way
   * back would put it there again.
   */
  it('tells the world the crate has gone exactly once, when it is lifted', () => {
    const h = harness();
    h.mission.activate(h.barId);
    h.dialogue.finish();
    expect(h.taken.count).toBe(0);

    h.mission.activate(h.crateId);
    expect(h.taken.count).toBe(1);

    h.dialogue.finish();
    h.mission.activate(h.barId);
    h.dialogue.finish();
    expect(h.mission.stage).toBe('complete');
    expect(h.mission.carrying).toBe(false);
    // Paid, and the crate stays gone.
    expect(h.taken.count).toBe(1);
  });

  it('plays the whole job through in the order the script says', () => {
    const h = harness();

    // 1. The briefing.
    expect(h.mission.activate(h.barId)).toBe(true);
    expect(h.mission.stage).toBe('briefing');
    expect(h.dialogue.spoken[0]).toEqual(CONVERSATIONS.briefing.map((b) => b.line));
    h.dialogue.finish();
    expect(h.mission.stage).toBe('collect');
    expect(h.waypoints.at(-1)).toBe('Lock-up');

    // 2. The pickup, and Teo's confession.
    expect(h.player.heat).toBe(0);
    expect(h.mission.activate(h.crateId)).toBe(true);
    expect(h.mission.carrying).toBe(true);
    expect(h.mission.stage).toBe('handover');
    expect(h.dialogue.spoken[1]).toEqual(CONVERSATIONS.handover.map((b) => b.line));
    // The heat lands when he ADMITS it, not when the box is lifted.
    expect(h.player.heat).toBe(0);
    h.dialogue.finish();
    expect(h.mission.stage).toBe('deliver');
    expect(h.player.heat).toBe(TIP_OFF_HEAT);
    expect(h.player.wanted).toBeGreaterThanOrEqual(2);
    expect(h.waypoints.at(-1)).toBe('The Vibe');

    // 3. The delivery.
    expect(h.mission.activate(h.barId)).toBe(true);
    expect(h.mission.stage).toBe('payout');
    expect(h.dialogue.spoken[2]).toEqual(CONVERSATIONS.payout.map((b) => b.line));
    h.dialogue.finish();

    expect(h.mission.stage).toBe('complete');
    expect(h.mission.carrying).toBe(false);
    expect(h.player.money).toBe(STARTING_MONEY + MISSION_FEE);
    // The heat was somebody else's phone call and the job is over.
    expect(h.player.wanted).toBe(0);
    expect(h.waypoints.at(-1)).toBeNull();

    expect(h.objectives).toEqual([
      'offered',
      'briefing',
      'collect',
      'handover',
      'deliver',
      'payout',
      'complete',
    ]);
  });

  it('cannot be paid twice by walking back to the bar', () => {
    const h = harness();
    h.mission.activate(h.barId);
    h.dialogue.finish();
    h.mission.activate(h.crateId);
    h.dialogue.finish();
    h.mission.activate(h.barId);
    h.dialogue.finish();
    const paid = h.player.money;

    for (let i = 0; i < 5; i += 1) {
      h.mission.activate(h.barId);
      h.dialogue.finish();
    }
    expect(h.player.money).toBe(paid);
    expect(h.dialogue.spoken).toHaveLength(3);
  });

  it('says nothing while somebody is already speaking', () => {
    const h = harness();
    h.mission.activate(h.barId);
    expect(h.mission.promptFor(h.barId)).toBe('');
    // A second press mid-sentence must not start the conversation again.
    h.mission.activate(h.barId);
    expect(h.dialogue.spoken).toHaveLength(1);
  });

  it('leaves anything that is not its own business alone', () => {
    const h = harness();
    expect(h.mission.promptFor('door-parcel-0')).toBeNull();
    expect(h.mission.activate('door-parcel-0')).toBe(false);
  });

  it('pays a fee worth the drive', () => {
    // Enough to matter next to the shop's prices without making the armoury
    // free: one job buys the SMG and a magazine, and not much more.
    expect(MISSION_FEE).toBeGreaterThan(2000);
    expect(MISSION_FEE).toBeLessThan(STARTING_MONEY);
  });
});
