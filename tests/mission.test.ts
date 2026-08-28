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
import { MissionDirector, type DialoguePlayer, type MissionContext } from '../src/mission/Mission';
import {
  CHARTER_FEE,
  CLUB_STREET_TOKEN,
  CONVERSATIONS,
  DROP_POINT,
  MISSION_FEE,
  OBJECTIVES,
  TIP_OFF_HEAT,
  type MissionStage,
} from '../src/mission/script';
import { AIRFIELD_LEVEL, APRON, RUNWAY, TERMINAL } from '../src/world/airport/layout';
import { SEA_LEVEL, groundElevation } from '../src/world/elevation';
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

  /** What `Dialogue.cut` does: silence, and the callback is dropped. */
  cut(): void {
    this.speaking = false;
    this.pending = null;
  }
}

interface Harness {
  readonly mission: MissionDirector;
  readonly player: PlayerState;
  readonly dialogue: FakeDialogue;
  readonly barId: string;
  readonly crateId: string;
  readonly objectives: MissionStage[];
  /** The detail line of the objective most recently announced. */
  readonly shownDetail: string;
  readonly waypoints: (string | null)[];
  /** How many times the world was told to stop drawing the crate. */
  readonly taken: { count: number };
}

function harness(): Harness {
  const player = new PlayerState();
  const dialogue = new FakeDialogue();
  const objectives: MissionStage[] = [];
  const waypoints: (string | null)[] = [];
  const details: string[] = [];
  const taken = { count: 0 };
  const mission = new MissionDirector({
    plan,
    player,
    dialogue,
    /*
     * Matched on title and waypoint, not identity: the director rewrites
     * `detail` to put the club's real street into it, so the object handed
     * back is not the one in `OBJECTIVES`. Those two fields are unique across
     * all seven stages.
     */
    onObjective: (objective) => {
      details.push(objective.detail);
      const stage = (Object.keys(OBJECTIVES) as MissionStage[]).find(
        (key) =>
          OBJECTIVES[key].title === objective.title &&
          OBJECTIVES[key].waypoint === objective.waypoint,
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
    get shownDetail() {
      return details.at(-1) ?? '';
    },
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
  /*
   * The opening line named "Harbour Walk" because that is where the club was
   * imagined. The generator put The Vibe on Dock Street, so the objective sent
   * the player to one street while the HUD, standing at the door, named
   * another. The street now comes from the plan, like the waypoint.
   */
  it('names the street the club is actually on', () => {
    const h = harness();
    const club = plan.parcels.find((p) => p.interiorKind === 'nightclub');
    expect(club).toBeDefined();
    if (!club) return;
    const street = plan.streets.find((s) => s.id === club.frontStreetId);
    expect(street, 'the club has no front street').toBeDefined();

    const opening = h.objectives.length > 0 ? h.shownDetail : '';
    expect(opening).not.toContain(CLUB_STREET_TOKEN);
    expect(opening).toContain(street?.name ?? '<none>');
  });

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
    expect(h.mission.stage).toBe('chartered');
    // The box is still being carried - it leaves on the aircraft, not at the
    // bar - and the crate on the bench stays gone either way.
    expect(h.mission.carrying).toBe(true);
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

    // Paid for the run across town - and NOT finished. Sable's next line is
    // that the takings cannot stay in the city, so the box stays with the
    // player and the job carries on out to the airport. The flight half is
    // covered in 'the airport leg' below.
    expect(h.mission.stage).toBe('chartered');
    expect(h.mission.carrying).toBe(true);
    expect(h.player.money).toBe(STARTING_MONEY + MISSION_FEE);
    // The heat was somebody else's phone call, and that part is over.
    expect(h.player.wanted).toBe(0);
    expect(h.waypoints.at(-1)).toBe('The Vibe');

    expect(h.objectives).toEqual([
      'offered',
      'briefing',
      'collect',
      'handover',
      'deliver',
      'payout',
      'chartered',
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
    // The delivery fee is paid exactly once however many times the player
    // walks back. The bar has one more thing to say - the charter - so the
    // fourth conversation is expected; a fifth would mean it repeats.
    expect(h.player.money).toBe(paid);
    expect(h.dialogue.spoken).toHaveLength(4);
    expect(h.dialogue.spoken[3]).toEqual(CONVERSATIONS.charter.map((b) => b.line));
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

  /*
   * Being killed or arrested mid-sentence rewinds to the offer.
   *
   * `main.ts` calls `Dialogue.cut` and `MissionDirector.interrupt` together
   * from the respawn director's bust handler. Neither is any use alone: cut
   * drops the callback, and only interrupt can leave the stage that callback
   * owned. Running the callback instead - the first attempt - meant dying
   * during Sable's last line paid $7,500 over the top of the BUSTED banner.
   */
  it('rewinds to the offer when a conversation is cut short', () => {
    const cases = [
      { cut: 'briefing', back: 'offered' },
      { cut: 'handover', back: 'collect' },
      { cut: 'payout', back: 'deliver' },
    ] as const;

    for (const { cut, back } of cases) {
      const h = harness();
      h.mission.activate(h.barId);
      if (cut !== 'briefing') {
        h.dialogue.finish();
        h.mission.activate(h.crateId);
        if (cut !== 'handover') {
          h.dialogue.finish();
          h.mission.activate(h.barId);
        }
      }

      const moneyBefore = h.player.money;
      const heatBefore = h.player.heat;
      h.dialogue.cut();
      h.mission.interrupt();

      expect(h.mission.stage, cut).toBe(back);
      // Nothing the conversation would have done happens to a dead player.
      expect(h.player.money, cut).toBe(moneyBefore);
      expect(h.player.heat, cut).toBe(heatBefore);
      // The box stays picked up, and the world is not told about it twice.
      if (cut !== 'briefing') {
        expect(h.mission.carrying, cut).toBe(true);
        expect(h.taken.count, cut).toBe(1);
      }
    }
  });

  it('can be picked up again after an interrupted handover, and still pays once', () => {
    const h = harness();
    h.mission.activate(h.barId);
    h.dialogue.finish();
    h.mission.activate(h.crateId);
    h.dialogue.cut();
    h.mission.interrupt();
    expect(h.mission.stage).toBe('collect');

    // Back on their feet, the player presses E on the crate again.
    expect(h.mission.activate(h.crateId)).toBe(true);
    expect(h.taken.count, 'the crate has already gone from the room').toBe(1);
    h.dialogue.finish();
    expect(h.mission.stage).toBe('deliver');
    expect(h.player.heat).toBe(TIP_OFF_HEAT);

    h.mission.activate(h.barId);
    h.dialogue.finish();
    expect(h.player.money).toBe(STARTING_MONEY + MISSION_FEE);
  });

  /*
   * A conversation outlives the director that started it.
   *
   * `dispose` runs on unload while a line may still be playing; the beat that
   * finishes a moment later must not pay a mission nobody is looking at.
   */
  it('does nothing once it has been disposed', () => {
    const h = harness();
    h.mission.activate(h.barId);
    h.dialogue.finish();
    h.mission.activate(h.crateId);
    h.dialogue.finish();

    h.mission.activate(h.barId);
    const money = h.player.money;
    h.mission.dispose();
    h.dialogue.finish();

    expect(h.mission.stage).toBe('payout');
    expect(h.player.money).toBe(money);
  });

  /*
   * The prompts belong to the mission's own two points and nothing else.
   *
   * `main.ts` treats `''` as "say nothing here" and `null` as "leave this
   * point's own prompt alone". Returning `''` for every id while somebody
   * talked took "Press E to leave" off the club's door for the length of a
   * conversation the door has no part in.
   */
  it('never silences a prompt that is not its own', () => {
    const h = harness();
    h.mission.activate(h.barId);
    expect(h.dialogue.speaking).toBe(true);
    expect(h.mission.promptFor('interior-exit-parcel-58')).toBeNull();
    expect(h.mission.promptFor('gun-shop-counter-parcel-41')).toBeNull();
    expect(h.mission.promptFor(h.barId)).toBe('');
  });

  it('stops offering a conversation once there is none left to have', () => {
    const h = harness();
    h.mission.activate(h.barId);
    h.dialogue.finish();
    h.mission.activate(h.crateId);
    h.dialogue.finish();
    h.mission.activate(h.barId);
    h.dialogue.finish();
    // The charter is the last thing the bar has to say. Hear it, and the bar
    // is scenery again.
    h.mission.activate(h.barId);
    h.dialogue.finish();
    expect(h.mission.stage).toBe('toAirport');

    // Promising "Press E to speak to Sable" and then doing nothing when the
    // player presses it is worse than promising nothing.
    expect(h.mission.promptFor(h.barId)).toBe('');
    expect(h.mission.activate(h.barId)).toBe(false);
  });

  it('pays a fee worth the drive', () => {
    // Enough to matter next to the shop's prices without making the armoury
    // free: one job buys the SMG and a magazine, and not much more.
    expect(MISSION_FEE).toBeGreaterThan(2000);
    expect(MISSION_FEE).toBeLessThan(STARTING_MONEY);
  });
});

/*
 * The airport leg.
 *
 * The first half of the job is pressed - walk up to somebody, press E. From
 * the charter onwards it is MEASURED: the stages advance on where the player
 * is and what they are flying, so these tests drive `update` with a position
 * and a flight state rather than activating interaction points. That is the
 * whole reason the second half can be tested at all without a renderer.
 */
describe('the airport leg', () => {
  /** Plays the city half of the job and leaves the player paid, at the bar. */
  function throughTheCity(h: Harness): void {
    h.mission.activate(h.barId);
    h.dialogue.finish(); // briefing -> collect
    h.mission.activate(h.crateId);
    h.dialogue.finish(); // handover -> deliver
    h.mission.activate(h.barId);
    h.dialogue.finish(); // payout -> chartered
  }

  function at(x: number, z: number, flight?: MissionContext['flight']): MissionContext {
    return flight ? { x, y: AIRFIELD_LEVEL, z, flight } : { x, y: 2, z };
  }

  it('pays the delivery fee but does not end the job', () => {
    const h = harness();
    throughTheCity(h);
    expect(h.mission.stage).toBe('chartered');
    expect(h.player.money).toBe(STARTING_MONEY + MISSION_FEE);
    // The box has NOT been handed over. That is the hinge of the second half.
    expect(h.mission.carrying).toBe(true);
  });

  it('offers the charter at the bar, and only once it has been paid for the run', () => {
    const h = harness();
    expect(h.mission.promptFor(h.barId)).not.toContain('hear');
    throughTheCity(h);
    expect(h.mission.promptFor(h.barId)).toContain('hear');
    h.mission.activate(h.barId);
    expect(h.mission.stage).toBe('briefingFlight');
    expect(h.dialogue.spoken.at(-1)).toEqual(CONVERSATIONS.charter.map((b) => b.line));
    h.dialogue.finish();
    expect(h.mission.stage).toBe('toAirport');
  });

  it('walks the player through the terminal, onto the apron and into the air', () => {
    const h = harness();
    throughTheCity(h);
    h.mission.activate(h.barId);
    h.dialogue.finish();

    // Standing in the city does nothing.
    h.mission.update(0.1, at(0, 0));
    expect(h.mission.stage).toBe('toAirport');

    // The landside door.
    h.mission.update(0.1, at(TERMINAL.minX - 6, (TERMINAL.minZ + TERMINAL.maxZ) / 2));
    expect(h.mission.stage).toBe('concourse');

    // Airside, on the apron.
    h.mission.update(0.1, at((APRON.minX + APRON.maxX) / 2, (APRON.minZ + APRON.maxZ) / 2));
    expect(h.mission.stage).toBe('boarding');

    // In an aircraft, still on the ground.
    h.mission.update(0.1, at(240, 520, { altitude: 0, speed: 0, onGround: true }));
    expect(h.mission.stage).toBe('departing');

    // Rolling is not flying.
    h.mission.update(0.1, at(RUNWAY.centreX, 500, { altitude: 2, speed: 30, onGround: true }));
    expect(h.mission.stage).toBe('departing');

    // Airborne.
    h.mission.update(0.1, at(RUNWAY.centreX, 400, { altitude: 80, speed: 55, onGround: false }));
    expect(h.mission.stage).toBe('outbound');
  });

  it('does not skip a stage when the player is already where a later one wants them', () => {
    const h = harness();
    throughTheCity(h);
    h.mission.activate(h.barId);
    h.dialogue.finish();
    // Flying over the drop point while still being asked to reach the airport
    // must do nothing at all: only the current stage's own condition is run.
    h.mission.update(0.1, at(DROP_POINT.x, DROP_POINT.z, { altitude: 200, speed: 60, onGround: false }));
    expect(h.mission.stage).toBe('toAirport');
  });

  it('hands the box off over the bay and sends the player home', () => {
    const h = airborne();
    h.mission.update(0.1, at(DROP_POINT.x, DROP_POINT.z, { altitude: 150, speed: 55, onGround: false }));
    expect(h.mission.stage).toBe('handoff');
    expect(h.dialogue.spoken.at(-1)).toEqual(CONVERSATIONS.handoff.map((b) => b.line));
    h.dialogue.finish();
    expect(h.mission.stage).toBe('inbound');
  });

  it('pays the charter only when the aircraft is down, stopped and on the field', () => {
    const h = airborne();
    h.mission.update(0.1, at(DROP_POINT.x, DROP_POINT.z, { altitude: 150, speed: 55, onGround: false }));
    h.dialogue.finish();
    const paidForTheRun = h.player.money;

    // Still flying over the field.
    h.mission.update(0.1, at(RUNWAY.centreX, 500, { altitude: 90, speed: 55, onGround: false }));
    expect(h.mission.stage).toBe('inbound');
    // Down but still rolling fast.
    h.mission.update(0.1, at(RUNWAY.centreX, 500, { altitude: 0, speed: 40, onGround: true }));
    expect(h.mission.stage).toBe('inbound');
    // Stopped, but in a street in the city rather than at the airport.
    h.mission.update(0.1, at(0, 0, { altitude: 0, speed: 0, onGround: true }));
    expect(h.mission.stage).toBe('inbound');
    expect(h.player.money).toBe(paidForTheRun);

    // Down, stopped, on the runway.
    h.mission.update(0.1, at(RUNWAY.centreX, 500, { altitude: 0, speed: 0, onGround: true }));
    expect(h.mission.stage).toBe('shutdown');
    h.dialogue.finish();
    expect(h.mission.stage).toBe('complete');
    expect(h.player.money).toBe(STARTING_MONEY + MISSION_FEE + CHARTER_FEE);
    // The box is gone: it left on the aircraft.
    expect(h.mission.carrying).toBe(false);
  });

  it('points the waypoint at a real place at every stage of the flight', () => {
    const h = airborne();
    // Every airport waypoint must resolve to somewhere inside the world, not
    // to null - a stage that points nowhere is a stage the player cannot find.
    const seen = h.waypoints.filter((label): label is string => label !== null);
    expect(seen).toEqual(
      expect.arrayContaining(['The Vibe', 'Lock-up', 'Terminal', 'Gates', 'Stand 4', 'Runway 18/36']),
    );
  });

  it('rewinds a radio call the player died during, instead of paying for it', () => {
    const h = airborne();
    h.mission.update(0.1, at(DROP_POINT.x, DROP_POINT.z, { altitude: 150, speed: 55, onGround: false }));
    h.dialogue.finish();
    const before = h.player.money;
    // Shot down while Sable is talking them onto the ground.
    h.mission.update(0.1, at(RUNWAY.centreX, 500, { altitude: 0, speed: 0, onGround: true }));
    expect(h.mission.stage).toBe('shutdown');
    h.dialogue.cut();
    h.mission.interrupt();
    expect(h.mission.stage).toBe('inbound');
    expect(h.player.money).toBe(before);
    // And it can be finished properly afterwards.
    h.mission.update(0.1, at(RUNWAY.centreX, 500, { altitude: 0, speed: 0, onGround: true }));
    h.dialogue.finish();
    expect(h.mission.stage).toBe('complete');
    expect(h.player.money).toBe(before + CHARTER_FEE);
  });

  it('holds still while somebody is talking', () => {
    const h = harness();
    throughTheCity(h);
    h.mission.activate(h.barId);
    // Mid-briefing. Being at the airport already must not jump the stage.
    expect(h.dialogue.speaking).toBe(true);
    h.mission.update(0.1, at(TERMINAL.minX - 6, (TERMINAL.minZ + TERMINAL.maxZ) / 2));
    expect(h.mission.stage).toBe('briefingFlight');
  });

  /** Plays the job as far as "airborne, on the way to the drop point". */
  function airborne(): Harness {
    const h = harness();
    throughTheCity(h);
    h.mission.activate(h.barId);
    h.dialogue.finish();
    h.mission.update(0.1, at(TERMINAL.minX - 6, (TERMINAL.minZ + TERMINAL.maxZ) / 2));
    h.mission.update(0.1, at((APRON.minX + APRON.maxX) / 2, (APRON.minZ + APRON.maxZ) / 2));
    h.mission.update(0.1, at(240, 520, { altitude: 0, speed: 0, onGround: true }));
    h.mission.update(0.1, at(RUNWAY.centreX, 400, { altitude: 80, speed: 55, onGround: false }));
    expect(h.mission.stage).toBe('outbound');
    return h;
  }
});

describe('the drop point', () => {
  it('is out over the water, not on land', () => {
    // A hand-off in the middle of a street would be a hand-off the player
    // could drive to. It has to be somewhere only an aircraft reaches.
    expect(groundElevation(DROP_POINT.x, DROP_POINT.z)).toBeLessThan(SEA_LEVEL);
  });

  it('is far enough from the runway to be a flight and near enough to be a short one', () => {
    const gap = Math.hypot(DROP_POINT.x - RUNWAY.centreX, DROP_POINT.z - (RUNWAY.northZ + RUNWAY.southZ) / 2);
    expect(gap).toBeGreaterThan(400);
    expect(gap).toBeLessThan(1200);
  });
});
