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
    if (this.options.dialogue.speaking) return '';
    if (id === this.barId) {
      if (this.stageValue === 'offered') return `Press E to speak to ${CAST.sable.shortName}`;
      if (this.stageValue === 'deliver') return `Press E to hand over the takings`;
      if (this.stageValue === 'complete') return `Press E to speak to ${CAST.sable.shortName}`;
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
      return this.stageValue === 'complete' || this.stageValue === 'payout';
    }

    if (id === this.crateId) {
      if (this.stageValue !== 'collect') return true;
      this.carryingValue = true;
      this.options.onCrateTaken?.();
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
    if (this.stageValue === stage) return;
    this.stageValue = stage;
    this.announce();
  }

  private announce(): void {
    this.options.onObjective?.(OBJECTIVES[this.stageValue]);
    this.options.onWaypoint?.(this.waypointFor(this.stageValue));
  }

  private finish(): void {
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
