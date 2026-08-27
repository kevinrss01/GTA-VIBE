/**
 * The player's persistent condition: money, health, weapons and heat.
 *
 * This is deliberately a plain module with no Three.js, no DOM and no timers,
 * so the economy, the shop, the combat layer and the police response all read
 * and write ONE source of truth, and every rule in it can be asserted in a unit
 * test without a browser.
 *
 * Nothing here decides presentation. It emits changes and lets the HUD, the
 * shop and the wanted display render whatever they like.
 */

export type WeaponId = 'pistol' | 'shotgun' | 'smg' | 'rifle' | 'launcher';

export interface WeaponSpec {
  readonly id: WeaponId;
  readonly name: string;
  /** Purchase price in the city's currency. */
  readonly price: number;
  /** Price of one full magazine of ammunition. */
  readonly ammoPrice: number;
  readonly damage: number;
  /** Effective range in metres; damage falls off to zero beyond it. */
  readonly rangeM: number;
  readonly roundsPerMinute: number;
  readonly magazine: number;
  /** Cone half-angle in radians at the muzzle. */
  readonly spreadRad: number;
  readonly reloadSeconds: number;
  /** Pellets per trigger pull. Shotguns fire several. */
  readonly pellets: number;
  /**
   * Rounds one ammunition purchase buys. Defaults to `magazine`.
   *
   * Only the launcher sets it: its magazine is one rocket, and charging a trip
   * to the shop per rocket would be an errand rather than a decision.
   */
  readonly ammoBundle?: number;
  /**
   * Metres per second the round travels, or `undefined` for hitscan.
   *
   * Everything up to the carbine is instantaneous as far as a player can tell -
   * a 9 mm round crosses this whole city in a fifth of a second - so modelling
   * flight time for them would only add error. A rocket is slow enough to
   * watch, to lead a moving car with, and to miss with, so it is a real object
   * with a real speed.
   */
  readonly muzzleSpeed?: number;
  /** Radius of the blast, in metres. Absent for a weapon that does not have one. */
  readonly blastRadius?: number;
  /** Damage at the centre of that blast, falling off to zero at its edge. */
  readonly blastDamage?: number;
}

export const WEAPONS: Readonly<Record<WeaponId, WeaponSpec>> = {
  pistol: {
    id: 'pistol',
    name: 'Sidearm',
    price: 450,
    ammoPrice: 30,
    damage: 26,
    rangeM: 45,
    roundsPerMinute: 320,
    magazine: 12,
    spreadRad: 0.012,
    reloadSeconds: 1.4,
    pellets: 1,
  },
  smg: {
    id: 'smg',
    name: 'Compact SMG',
    price: 1750,
    ammoPrice: 90,
    damage: 17,
    rangeM: 55,
    roundsPerMinute: 780,
    magazine: 30,
    spreadRad: 0.032,
    reloadSeconds: 1.9,
    pellets: 1,
  },
  shotgun: {
    id: 'shotgun',
    name: 'Dock Sweeper',
    price: 2400,
    ammoPrice: 110,
    damage: 13,
    rangeM: 22,
    roundsPerMinute: 75,
    magazine: 6,
    spreadRad: 0.10,
    reloadSeconds: 2.6,
    pellets: 8,
  },
  rifle: {
    id: 'rifle',
    name: 'Meridian Carbine',
    price: 4200,
    ammoPrice: 160,
    damage: 34,
    rangeM: 90,
    roundsPerMinute: 540,
    magazine: 25,
    spreadRad: 0.018,
    reloadSeconds: 2.2,
    pellets: 1,
  },
  /*
   * The launcher is priced above the starting purse on purpose: it is the one
   * thing in the shop the player has to come back for.
   *
   * EVERY SMALL-ARMS NUMBER ON IT IS DELIBERATELY UNREMARKABLE, and that is
   * the design rather than an oversight. `damage` is the DIRECT hit - a
   * warhead arriving nose-first without detonating - which is not what the
   * weapon is for and should not beat a shotgun shell at contact range.
   * `rangeM` is the falloff on that same direct hit, so a rocket that crosses
   * a district still explodes for full effect and merely stops bruising on
   * arrival. `spreadRad` is a genuinely unguided tube, wider than a pistol.
   * What the weapon actually is is `blastDamage` over `blastRadius`, and the
   * shop compares it on exactly that.
   */
  launcher: {
    id: 'launcher',
    name: 'Harbour Breaker',
    price: 9500,
    ammoPrice: 1200,
    damage: 90,
    rangeM: 85,
    roundsPerMinute: 26,
    magazine: 1,
    spreadRad: 0.014,
    reloadSeconds: 3.6,
    pellets: 1,
    ammoBundle: 3,
    muzzleSpeed: 46,
    blastRadius: 9.5,
    blastDamage: 190,
  },
};

export const ALL_WEAPONS: readonly WeaponId[] = ['pistol', 'smg', 'shotgun', 'rifle', 'launcher'];

/**
 * Enough to walk out of Bellhouse Arms carrying everything, with change.
 *
 * The five weapons total 18,300 and one refill of every kind of ammunition is
 * another 1,590, so this leaves about six and a half thousand for reloads -
 * five spare rockets, or dozens of magazines for anything else.
 *
 * It used to be 6,500, which bought a sidearm and shells and made the carbine
 * and the launcher things you had to come back for. That was a deliberate
 * shape and the player asked for it to go: they want to buy the guns.
 */
export const STARTING_MONEY = 25_000;

/** Rounds one ammunition purchase buys, which is a magazine unless stated. */
export function ammoBundleFor(spec: WeaponSpec): number {
  return spec.ammoBundle ?? spec.magazine;
}

export const MAX_HEALTH = 100;
export const MAX_WANTED = 5;

/**
 * Heat is the continuous quantity behind the discrete star rating.
 *
 * Stars that tick up the instant something happens and down again a moment
 * later read as a bug rather than a manhunt, so offences add heat, heat decays
 * only while the player is not being actively pursued, and the star count is a
 * threshold over heat. The thresholds are spaced so the first star is easy and
 * the fifth genuinely takes sustained trouble.
 */
const STAR_THRESHOLDS = [0, 10, 60, 140, 300, 500] as const;

/*
 * Why these numbers: one visible gunshot (12) must be enough for the first
 * star, or firing in the street has no consequence at all. Killing a civilian
 * (70) reaches two; killing an officer (150) reaches three; a second officer
 * reaches four. Five takes sustained trouble rather than one bad decision.
 */

/** Heat added per offence. */
export const HEAT = {
  /** Firing a weapon where somebody can see it. */
  gunshot: 12,
  /** Hurting a civilian. */
  civilianHurt: 22,
  /** Killing a civilian. */
  civilianKilled: 70,
  /** Hitting a police officer or their vehicle. */
  policeHurt: 60,
  policeKilled: 150,
  /** Hitting a pedestrian or another car with your vehicle. */
  vehicleImpact: 8,
} as const;

/**
 * Recovery.
 *
 * Health comes back on its own after a spell of not being shot, which is the
 * Call of Duty model rather than the medkit model, and it is the right one
 * here: there are no pickups anywhere in this city, so without regeneration a
 * player's health only ever falls until they die, and a bad thirty seconds
 * early on would follow them for the rest of the session.
 *
 * The delay is what keeps it from trivialising a firefight. Eight seconds is
 * long enough that it never ticks during one - the police fire every 1.1 s -
 * so it is a recovery between fights and never a heal inside one.
 */
const REGEN_DELAY_SECONDS = 8;
const REGEN_PER_SECOND = 12;

/** Heat lost per second once nobody is actively chasing. */
const HEAT_DECAY_PER_SECOND = 7;
/** Seconds of no new offence before heat starts falling at all. */
const HEAT_COOLDOWN_SECONDS = 8;

export interface PlayerSnapshot {
  readonly money: number;
  readonly health: number;
  readonly alive: boolean;
  readonly wanted: number;
  readonly heat: number;
  readonly equipped: WeaponId | null;
  readonly owned: readonly WeaponId[];
  readonly ammo: Readonly<Record<WeaponId, number>>;
}

function emptyAmmo(): Record<WeaponId, number> {
  return { pistol: 0, smg: 0, shotgun: 0, rifle: 0, launcher: 0 };
}

export class PlayerState {
  private moneyValue = STARTING_MONEY;
  private healthValue = MAX_HEALTH;
  private heatValue = 0;
  private sinceOffence = HEAT_COOLDOWN_SECONDS;
  private sinceHurt = REGEN_DELAY_SECONDS;
  private readonly ownedSet = new Set<WeaponId>();
  private ammoCounts = emptyAmmo();
  private equippedWeapon: WeaponId | null = null;

  /** Called whenever anything observable changes, so the HUD can redraw. */
  onChange: (() => void) | null = null;
  /** Called once when health reaches zero. */
  onDeath: (() => void) | null = null;
  /**
   * Called for every hit that lands, with where it came from when that is
   * known. The damage overlay draws its directional indicator from this, and
   * the audio layer plays the grunt.
   */
  onDamage:
    | ((amount: number, sourceX: number | undefined, sourceZ: number | undefined) => void)
    | null = null;

  get money(): number {
    return this.moneyValue;
  }

  get health(): number {
    return this.healthValue;
  }

  get alive(): boolean {
    return this.healthValue > 0;
  }

  get heat(): number {
    return this.heatValue;
  }

  /** Star rating, 0 to `MAX_WANTED`. */
  get wanted(): number {
    let stars = 0;
    for (let i = 1; i < STAR_THRESHOLDS.length; i += 1) {
      const threshold = STAR_THRESHOLDS[i];
      if (threshold !== undefined && this.heatValue >= threshold) stars = i;
    }
    return Math.min(MAX_WANTED, stars);
  }

  get equipped(): WeaponId | null {
    return this.equippedWeapon;
  }

  owns(id: WeaponId): boolean {
    return this.ownedSet.has(id);
  }

  ammo(id: WeaponId): number {
    return this.ammoCounts[id];
  }

  snapshot(): PlayerSnapshot {
    return {
      money: this.moneyValue,
      health: this.healthValue,
      alive: this.alive,
      wanted: this.wanted,
      heat: this.heatValue,
      equipped: this.equippedWeapon,
      owned: [...this.ownedSet],
      ammo: { ...this.ammoCounts },
    };
  }

  // -- economy --------------------------------------------------------------

  canAfford(cost: number): boolean {
    return cost <= this.moneyValue;
  }

  /** Spends money if there is enough. Returns false and changes nothing if not. */
  spend(cost: number): boolean {
    if (cost < 0 || !this.canAfford(cost)) return false;
    this.moneyValue -= cost;
    this.changed();
    return true;
  }

  earn(amount: number): void {
    if (amount <= 0) return;
    this.moneyValue += amount;
    this.changed();
  }

  /**
   * Buys a weapon, which comes with one full magazine. Buying one already
   * owned is refused rather than silently charging for it again.
   */
  buyWeapon(id: WeaponId): boolean {
    if (this.ownedSet.has(id)) return false;
    const spec = WEAPONS[id];
    if (!this.spend(spec.price)) return false;
    this.ownedSet.add(id);
    this.ammoCounts[id] += spec.magazine;
    if (!this.equippedWeapon) this.equippedWeapon = id;
    this.changed();
    return true;
  }

  /** Buys one bundle of ammunition for a weapon the player owns. */
  buyAmmo(id: WeaponId): boolean {
    if (!this.ownedSet.has(id)) return false;
    const spec = WEAPONS[id];
    if (!this.spend(spec.ammoPrice)) return false;
    this.ammoCounts[id] += ammoBundleFor(spec);
    this.changed();
    return true;
  }

  equip(id: WeaponId | null): boolean {
    if (id !== null && !this.ownedSet.has(id)) return false;
    this.equippedWeapon = id;
    this.changed();
    return true;
  }

  /** Consumes one round. Returns false when the weapon is empty. */
  consumeRound(id: WeaponId): boolean {
    if (this.ammoCounts[id] <= 0) return false;
    this.ammoCounts[id] -= 1;
    this.changed();
    return true;
  }

  // -- condition ------------------------------------------------------------

  /**
   * Applies damage. Returns true if this killed the player.
   *
   * `sourceX`/`sourceZ` are where it came from, and are passed straight
   * through to `onDamage` so the HUD can point at it. They are optional
   * because not every kind of damage has a direction - a blast the player set
   * off under their own feet does not.
   */
  hurt(amount: number, sourceX?: number, sourceZ?: number): boolean {
    if (amount <= 0 || !this.alive) return false;
    this.healthValue = Math.max(0, this.healthValue - amount);
    this.sinceHurt = 0;
    this.changed();
    this.onDamage?.(amount, sourceX, sourceZ);
    if (this.healthValue === 0) {
      this.onDeath?.();
      return true;
    }
    return false;
  }

  heal(amount: number): void {
    if (amount <= 0) return;
    this.healthValue = Math.min(MAX_HEALTH, this.healthValue + amount);
    this.changed();
  }

  /**
   * Recovers health once the player has been left alone long enough.
   *
   * Deliberately silent about `onDamage` and deliberately capped: it can only
   * ever put back what was taken, and it stops the instant anything lands.
   */
  regenerate(dt: number): void {
    if (dt <= 0 || !this.alive) return;
    if (this.sinceHurt < REGEN_DELAY_SECONDS) {
      this.sinceHurt += dt;
      return;
    }
    if (this.healthValue >= MAX_HEALTH) return;
    this.healthValue = Math.min(MAX_HEALTH, this.healthValue + REGEN_PER_SECOND * dt);
    this.changed();
  }

  // -- heat -----------------------------------------------------------------

  /** Records an offence. Heat only ever goes up here. */
  addHeat(amount: number): void {
    if (amount <= 0) return;
    const before = this.wanted;
    this.heatValue += amount;
    this.sinceOffence = 0;
    this.changed();
    if (this.wanted !== before) this.changed();
  }

  /**
   * Cools the player off. `pursued` holds the level while police still have
   * eyes on them, which is what stops a chase ending because the player hid
   * behind a wall for two seconds.
   */
  coolOff(dt: number, pursued: boolean): void {
    if (this.heatValue <= 0) return;
    if (pursued) {
      this.sinceOffence = 0;
      return;
    }
    this.sinceOffence += dt;
    if (this.sinceOffence < HEAT_COOLDOWN_SECONDS) return;
    const before = this.wanted;
    this.heatValue = Math.max(0, this.heatValue - HEAT_DECAY_PER_SECOND * dt);
    if (this.wanted !== before || this.heatValue === 0) this.changed();
  }

  clearHeat(): void {
    if (this.heatValue === 0) return;
    this.heatValue = 0;
    this.changed();
  }

  /**
   * Back to the start after dying or being arrested. Money and weapons are
   * kept - losing an hour of progress to one mistake is a punishment, not a
   * consequence - but the heat is gone and the player is whole again.
   */
  respawn(): void {
    this.healthValue = MAX_HEALTH;
    this.heatValue = 0;
    this.sinceOffence = HEAT_COOLDOWN_SECONDS;
    this.sinceHurt = REGEN_DELAY_SECONDS;
    this.changed();
  }

  private changed(): void {
    this.onChange?.();
  }
}
