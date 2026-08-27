/**
 * "Last Call": the state machine that turns a script into a job.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   const mission = new MissionDirector({
 *     plan, player, dialogue,
 *     onObjective: (o) => hud.setObjective(o.title, o.detail),
 *     onWaypoint:  (w) => minimap.setWaypoint(w),
 *     onBanner:    (t, d) => hud.setBanner(t, d),
 *   });
 *   // when the player presses E on an interaction point:
 *   if (mission.activate(point.id)) return;      // the mission claimed it
 *   // and once a frame:
 *   mission.update(dt, { x, z });
 *
 * ============================================================================
 *
 * WHAT IT OWNS AND WHAT IT DOES NOT. It owns the stage, the objective text,
 * the waypoint and the payment. It owns no geometry, no audio graph and no
 * DOM: the club and the lock-up are ordinary interiors built by `world/build`,
 * the voices belong to `Dialogue`, and the HUD is reached through callbacks.
 * That is what lets the whole mission be played through in a unit test with no
 * browser at all - `tests/mission.test.ts` runs it start to finish.
 *
 * WHY THE WAYPOINT IS A BUILDING AND NOT A POSITION. The city is generated
 * from a seed. The club is wherever the plan put it, so the mission asks the
 * plan rather than carrying a coordinate that would be wrong the moment
 * anybody changed the seed - which is exactly the failure the enterable-target
 * ordering in `CityPlan` already guards against.
 */

import type { CityPlan, InteriorKind, Parcel } from '../world/CityPlan';
import { formatMoney } from '../player/money';
import type { PlayerState } from '../player/PlayerState';
import { CAST } from '../story';
import {
  CLUB_STREET_TOKEN,
  CONVERSATIONS,
  MISSION_FEE,
  MISSION_NAME,
  OBJECTIVES,
  TIP_OFF_HEAT,
  type MissionStage,
  type Objective,
} from './script';

/** Enough of `Dialogue` for the director to drive it, and to fake in a test. */
export interface DialoguePlayer {
  say(beats: readonly { line: string; hold: number }[], onFinished?: () => void): void;
  readonly speaking: boolean;
}

export interface Waypoint {
  readonly x: number;
  readonly z: number;
  readonly label: string;
}

export interface MissionOptions {
  readonly plan: CityPlan;
  readonly player: PlayerState;
  readonly dialogue: DialoguePlayer;
  /** The objective line changed. */
  readonly onObjective?: ((objective: Objective) => void) | undefined;
  /** Where to point the player, or null to clear the marker. */
  readonly onWaypoint?: ((waypoint: Waypoint | null) => void) | undefined;
  /** A short banner: the job starting, and the job paying. */
  readonly onBanner?: ((title: string | null, detail: string) => void) | undefined;
  /** Fires once when the fee lands, so audio can mark it. */
  readonly onPaid?: ((amount: number) => void) | undefined;
  /**
   * Fires once, when the player lifts the box off the bench.
   *
   * The world uses it to stop drawing the crate, so that taking it actually
   * takes it. It is deliberately one-way: the box goes to Sable and never
   * returns to the lock-up, so there is nothing to put back.
   */
  readonly onCrateTaken?: (() => void) | undefined;
}

/** Seconds the completion banner stays up. */
const BANNER_SECONDS = 5;

/**
 * Where a conversation that was cut short puts the player back.
 *
 * One entry per stage that is nothing but a conversation; every other stage is
 * something the player is doing and survives being killed unchanged.
 */
const REWIND: Readonly<Partial<Record<MissionStage, MissionStage>>> = {
  briefing: 'offered',
  handover: 'collect',
  payout: 'deliver',
};

export interface MissionSnapshot {
  readonly stage: MissionStage;
  readonly objective: Objective;
  readonly carrying: boolean;
  readonly paid: number;
  readonly waypoint: Waypoint | null;
}

export class MissionDirector {
  private readonly options: MissionOptions;
  private readonly club: Parcel | null;
  private readonly lockup: Parcel | null;

  private stageValue: MissionStage = 'offered';
  private carryingValue = false;
  private paidValue = 0;
  private bannerLeft = 0;
  private disposed = false;

  constructor(options: MissionOptions) {
    this.options = options;
    this.club = findInterior(options.plan, 'nightclub');
    this.lockup = findInterior(options.plan, 'workshop');
    this.announce();
  }

  get stage(): MissionStage {
    return this.stageValue;
  }

  /** True while the player has the box. */
  get carrying(): boolean {
    return this.carryingValue;
  }

  get snapshot(): MissionSnapshot {
    return {
      stage: this.stageValue,
      objective: OBJECTIVES[this.stageValue],
      carrying: this.carryingValue,
      paid: this.paidValue,
      waypoint: this.waypointFor(this.stageValue),
    };
  }

  /**
   * What an interaction point should SAY right now.
   *
   * Returns null to leave the point's own prompt alone. This is how one
   * interaction point in the world - the bar, the crate - reads differently
   * depending on what the player has been asked to do, without the world
   * builder knowing a mission exists.
   */
  promptFor(id: string): string | null {
    // Only the mission's own points, even mid-sentence. Suppressing every
    // prompt while somebody talks took "Press E to leave" off the club's door
    // and the shop's counter with it, for a conversation neither is part of.
    if (id !== this.barId && id !== this.crateId) return null;
    if (this.options.dialogue.speaking) return '';
    if (id === this.barId) {
      if (this.stageValue === 'offered') return `Press E to speak to ${CAST.sable.shortName}`;
      if (this.stageValue === 'deliver') return `Press E to hand over the takings`;
      // Paid, and there is nothing more to say. Promising a conversation that
      // `activate` will not start is worse than promising nothing.
      return '';
    }
    if (id === this.crateId) {
      if (this.stageValue === 'collect') return 'Press E to take the takings';
      // Before the job and after it, the crate is somebody else's property and
      // says so rather than silently doing nothing.
      return 'The lock-up crate is padlocked';
    }
    return null;
  }

  /**
   * The player pressed E on something. Returns true when the mission claimed
   * it, which is the caller's signal not to also open a shop or a door.
   */
  activate(id: string): boolean {
    if (this.disposed || this.options.dialogue.speaking) return id === this.barId || id === this.crateId;

    if (id === this.barId) {
      if (this.stageValue === 'offered') {
        this.enter('briefing');
        this.options.dialogue.say(CONVERSATIONS.briefing, () => this.enter('collect'));
        return true;
      }
      if (this.stageValue === 'deliver') {
        this.enter('payout');
        this.options.dialogue.say(CONVERSATIONS.payout, () => this.finish());
        return true;
      }
      // `payout` is claimed so a second press mid-payment does nothing; once
      // it is `complete` the bar is an ordinary piece of scenery again.
      return this.stageValue === 'payout';
    }

    if (id === this.crateId) {
      if (this.stageValue !== 'collect') return true;
      // Only the first time. A second pickup after an interrupted handover is
      // the same box, and the world was already told it had gone.
      if (!this.carryingValue) {
        this.carryingValue = true;
        this.options.onCrateTaken?.();
      }
      this.enter('handover');
      this.options.dialogue.say(CONVERSATIONS.handover, () => {
        this.enter('deliver');
        /*
         * Teo told somebody, and this is that somebody making the call.
         *
         * The heat goes on when the CONVERSATION ends rather than when the box
         * is picked up, so the player hears why they are suddenly wanted
         * instead of being given two stars by a room they are still standing
         * in.
         */
        this.options.player.addHeat(TIP_OFF_HEAT);
      });
      return true;
    }
    return false;
  }

  /**
   * The player went down mid-conversation. Rewind to the offer.
   *
   * Called with `Dialogue.cut` from the respawn director's bust handler, and
   * only ever together with it. The three conversational stages each have
   * exactly one stage that offers them, so backing up one step leaves the
   * player able to walk up and press E again once they are on their feet.
   *
   * WHY NOT SIMPLY FINISH THE CONVERSATION. Because `payout`'s callback pays
   * $7,500 and clears the heat, so dying during Sable's last line would be a
   * way to be paid for the delivery while being loaded into an ambulance, with
   * "Last Call - paid" written over the top of the BUSTED banner. And
   * `handover`'s callback puts two stars on a player the police just stood
   * down from.
   *
   * The box is NOT given back. The player picked it up, and it stays picked
   * up: `carrying` survives, the crate stays gone from the lock-up bench, and
   * `collect` simply offers the pickup conversation again.
   */
  interrupt(): void {
    if (this.disposed) return;
    const back = REWIND[this.stageValue];
    if (back) this.enter(back);
  }

  update(dt: number): void {
    if (this.disposed) return;
    if (this.bannerLeft > 0) {
      this.bannerLeft = Math.max(0, this.bannerLeft - dt);
      if (this.bannerLeft === 0) this.options.onBanner?.(null, '');
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  // -- internals ------------------------------------------------------------

  /** The interaction id of the club's bar, or null if the city has no club. */
  private get barId(): string | null {
    return this.club ? `nightclub-bar-${this.club.id}` : null;
  }

  private get crateId(): string | null {
    return this.lockup ? `lockup-crate-${this.lockup.id}` : null;
  }

  private enter(stage: MissionStage): void {
    // A conversation started before `dispose` still ends afterwards, and its
    // callback must not move a director the application has let go of.
    if (this.disposed) return;
    if (this.stageValue === stage) return;
    this.stageValue = stage;
    this.announce();
  }

  private announce(): void {
    this.options.onObjective?.(this.objectiveFor(this.stageValue));
    this.options.onWaypoint?.(this.waypointFor(this.stageValue));
  }

  /**
   * The objective, with the club's real street written into it.
   *
   * `script.ts` says `{clubStreet}` rather than a name because which street
   * The Vibe fronts is the generator's decision. If the plan cannot say, the
   * token drops out along with the sentence it was in rather than being shown
   * to the player.
   */
  private objectiveFor(stage: MissionStage): Objective {
    const objective = OBJECTIVES[stage];
    if (!objective.detail.includes(CLUB_STREET_TOKEN)) return objective;
    const street = this.clubStreet;
    return {
      ...objective,
      detail: street
        ? objective.detail.split(CLUB_STREET_TOKEN).join(street)
        : objective.detail
            .split(`${CLUB_STREET_TOKEN}. `)
            .join('')
            .split(CLUB_STREET_TOKEN)
            .join(''),
    };
  }

  /** The name of the street the club opens onto, or null if the plan has none. */
  private get clubStreet(): string | null {
    const id = this.club?.frontStreetId;
    if (!id) return null;
    return this.options.plan.streets.find((street) => street.id === id)?.name ?? null;
  }

  private finish(): void {
    if (this.disposed) return;
    this.carryingValue = false;
    this.paidValue = MISSION_FEE;
    this.options.player.earn(MISSION_FEE);
    // The heat was somebody else's phone call, and the job is over.
    this.options.player.clearHeat();
    this.enter('complete');
    this.options.onPaid?.(MISSION_FEE);
    this.options.onBanner?.(
      `${MISSION_NAME} — paid`,
      `${formatMoney(MISSION_FEE)} from ${CAST.sable.name}`,
    );
    this.bannerLeft = BANNER_SECONDS;
  }

  private waypointFor(stage: MissionStage): Waypoint | null {
    const kind = OBJECTIVES[stage].waypoint;
    if (!kind) return null;
    const parcel = kind === 'nightclub' ? this.club : this.lockup;
    if (!parcel) return null;
    return {
      x: (parcel.rect.minX + parcel.rect.maxX) * 0.5,
      z: (parcel.rect.minZ + parcel.rect.maxZ) * 0.5,
      label: kind === 'nightclub' ? 'The Vibe' : 'Lock-up',
    };
  }
}

function findInterior(plan: CityPlan, kind: InteriorKind): Parcel | null {
  return plan.parcels.find((parcel) => parcel.interiorKind === kind) ?? null;
}
