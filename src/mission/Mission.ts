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
  AIRBORNE_HEIGHT,
  ARRIVAL_RADIUS,
  CHARTER_FEE,
  CLUB_STREET_TOKEN,
  CONVERSATIONS,
  DROP_POINT,
  DROP_RADIUS,
  MISSION_FEE,
  MISSION_NAME,
  OBJECTIVES,
  SHUTDOWN_SPEED,
  TIP_OFF_HEAT,
  type MissionStage,
  type Objective,
} from './script';
import { APRON, RUNWAY, STANDS, TERMINAL, inRect } from '../world/airport/layout';

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

/**
 * What the world looks like this frame, as far as the job cares.
 *
 * Optional in `update` so the three-quarters of the mission that happen on
 * foot in the city still run in a test that knows nothing about aircraft -
 * which is what `tests/mission.test.ts` has always done.
 */
export interface MissionContext {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Null unless the player is actually in an aircraft. */
  readonly flight?:
    | {
        /** Height above the airfield surface, in metres. */
        readonly altitude: number;
        readonly speed: number;
        readonly onGround: boolean;
      }
    | undefined;
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
  // The charter briefing is offered by standing at the bar, so it rewinds the
  // same way. `handoff` and `shutdown` are radio calls with nobody to walk
  // back to, so they rewind to the flying stage that triggers them again.
  briefingFlight: 'chartered',
  handoff: 'outbound',
  shutdown: 'inbound',
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
      if (this.stageValue === 'chartered') return `Press E to hear ${CAST.sable.shortName} out`;
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
        this.options.dialogue.say(CONVERSATIONS.payout, () => this.payDelivery());
        return true;
      }
      if (this.stageValue === 'chartered') {
        this.enter('briefingFlight');
        this.options.dialogue.say(CONVERSATIONS.charter, () => this.enter('toAirport'));
        return true;
      }
      // The talking stages are claimed so a second press mid-sentence does
      // nothing; once it is `complete` the bar is scenery again.
      return this.stageValue === 'payout' || this.stageValue === 'briefingFlight';
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

  update(dt: number, ctx?: MissionContext): void {
    if (this.disposed) return;
    if (this.bannerLeft > 0) {
      this.bannerLeft = Math.max(0, this.bannerLeft - dt);
      if (this.bannerLeft === 0) this.options.onBanner?.(null, '');
    }
    if (ctx) this.advanceFlight(ctx);
  }

  /**
   * The half of the job that is measured rather than pressed.
   *
   * Everything before the airport happens because the player walked up to
   * somebody and pressed E. From here on the stages advance on WHERE the
   * player is and WHAT they are flying, so this runs once a frame and each
   * stage owns exactly one condition. A stage never skips: reaching the drop
   * point while still on stage `boarding` does nothing, because the only test
   * run is the current stage's own.
   */
  private advanceFlight(ctx: MissionContext): void {
    if (this.options.dialogue.speaking) return;
    switch (this.stageValue) {
      case 'toAirport':
        // The landside door, not the building: the terminal is 190 m long and
        // arriving anywhere along its back wall is not arriving.
        if (near(ctx.x, ctx.z, TERMINAL.minX - 6, mid(TERMINAL.minZ, TERMINAL.maxZ), ARRIVAL_RADIUS)) {
          this.enter('concourse');
        }
        break;
      case 'concourse':
        // Out the other side and onto the apron. Crossing the terminal is the
        // point, so this asks for airside, not for a door.
        if (inRect(APRON, ctx.x, ctx.z, 8)) this.enter('boarding');
        break;
      case 'boarding':
        if (ctx.flight) this.enter('departing');
        break;
      case 'departing':
        if (ctx.flight && !ctx.flight.onGround && ctx.flight.altitude >= AIRBORNE_HEIGHT) {
          this.enter('outbound');
        }
        break;
      case 'outbound':
        if (near(ctx.x, ctx.z, DROP_POINT.x, DROP_POINT.z, DROP_RADIUS)) {
          this.enter('handoff');
          this.options.dialogue.say(CONVERSATIONS.handoff, () => this.enter('inbound'));
        }
        break;
      case 'inbound':
        // Down, stopped, and actually on the field - not stopped in a street
        // somewhere having given up. `onGround` alone would also be true a
        // metre after a wheels-up arrival in a car park.
        if (
          ctx.flight &&
          ctx.flight.onGround &&
          ctx.flight.speed <= SHUTDOWN_SPEED &&
          onAirfield(ctx.x, ctx.z)
        ) {
          this.enter('shutdown');
          this.options.dialogue.say(CONVERSATIONS.landed, () => this.payCharter());
        }
        break;
      default:
        break;
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

  /**
   * The delivery fee, at the bar.
   *
   * The box does NOT leave the player here, and that is the whole hinge of the
   * second half: Sable pays for the run across town and then says the takings
   * cannot stay in the city. `carrying` stays true until the aircraft reaches
   * the drop point.
   */
  private payDelivery(): void {
    if (this.disposed) return;
    this.paidValue = MISSION_FEE;
    this.options.player.earn(MISSION_FEE);
    // The heat was somebody else's phone call, and that part is over.
    this.options.player.clearHeat();
    this.enter('chartered');
    this.options.onPaid?.(MISSION_FEE);
    this.options.onBanner?.(
      `${MISSION_NAME} — the run`,
      `${formatMoney(MISSION_FEE)} from ${CAST.sable.name}`,
    );
    this.bannerLeft = BANNER_SECONDS;
  }

  /** The charter fee, on the ground back at the field. The job is over here. */
  private payCharter(): void {
    if (this.disposed) return;
    this.carryingValue = false;
    this.paidValue = MISSION_FEE + CHARTER_FEE;
    this.options.player.earn(CHARTER_FEE);
    this.options.player.clearHeat();
    this.enter('complete');
    this.options.onPaid?.(CHARTER_FEE);
    this.options.onBanner?.(
      `${MISSION_NAME} — paid`,
      `${formatMoney(CHARTER_FEE)} from ${CAST.sable.name}`,
    );
    this.bannerLeft = BANNER_SECONDS;
  }

  private waypointFor(stage: MissionStage): Waypoint | null {
    const kind = OBJECTIVES[stage].waypoint;
    if (!kind) return null;
    // The two city buildings are wherever the generator put them, so they are
    // asked for by interior kind. The airport is surveyed infrastructure at
    // fixed coordinates, so it is read straight out of the layout.
    if (kind === 'nightclub' || kind === 'workshop') {
      const parcel = kind === 'nightclub' ? this.club : this.lockup;
      if (!parcel) return null;
      return {
        x: (parcel.rect.minX + parcel.rect.maxX) * 0.5,
        z: (parcel.rect.minZ + parcel.rect.maxZ) * 0.5,
        label: kind === 'nightclub' ? 'The Vibe' : 'Lock-up',
      };
    }
    switch (kind) {
      case 'terminalDoor':
        return { x: TERMINAL.minX - 6, z: mid(TERMINAL.minZ, TERMINAL.maxZ), label: 'Terminal' };
      case 'gateDoor':
        return { x: TERMINAL.maxX + 4, z: mid(TERMINAL.minZ, TERMINAL.maxZ), label: 'Gates' };
      case 'stand': {
        // Stand four is the light stand, which is the one an aircraft Sable
        // could plausibly own is parked on. Falls back to the first stand so a
        // change to the apron layout cannot strand the job.
        const stand = STANDS.find((s) => s.id === 'stand-4') ?? STANDS[0];
        return stand ? { x: stand.x, z: stand.z, label: 'Stand 4' } : null;
      }
      case 'runway':
        return {
          x: RUNWAY.centreX,
          z: mid(RUNWAY.northZ, RUNWAY.southZ),
          label: 'Runway 18/36',
        };
      case 'dropPoint':
        return { x: DROP_POINT.x, z: DROP_POINT.z, label: 'Drop point' };
      default:
        return null;
    }
  }
}

function mid(a: number, b: number): number {
  return (a + b) * 0.5;
}

function near(x: number, z: number, tx: number, tz: number, radius: number): boolean {
  const dx = x - tx;
  const dz = z - tz;
  return dx * dx + dz * dz <= radius * radius;
}

/**
 * On the field, loosely.
 *
 * The runway, the taxiway and the apron with a generous margin, because a
 * light aircraft that rolls off the edge of the tarmac onto the grass beside
 * the runway has still landed at Meridian Bay Regional, and refusing to pay
 * for that would be pedantry rather than difficulty.
 */
function onAirfield(x: number, z: number): boolean {
  return (
    inRect(APRON, x, z, 40) ||
    (Math.abs(x - RUNWAY.centreX) <= RUNWAY.halfWidth + 60 &&
      z >= RUNWAY.northZ - RUNWAY.overrun &&
      z <= RUNWAY.southZ + RUNWAY.overrun)
  );
}

function findInterior(plan: CityPlan, kind: InteriorKind): Parcel | null {
  return plan.parcels.find((parcel) => parcel.interiorKind === kind) ?? null;
}
