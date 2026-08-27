/**
 * What being shot looks like.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   const damage = new DamageFeedback();
 *   hud.element.append(damage.element);
 *   player.onDamage = (amount, sx, sz) => damage.hit(amount / MAX_HEALTH, sx, sz);
 *   // once a frame, after the camera has been posed:
 *   damage.update(dt, { health: player.health / MAX_HEALTH, alive, yaw, x, z });
 *   damage.dispose();
 *
 * ============================================================================
 *
 * WHY THIS EXISTS AT ALL. The game had a health bar in the corner and nothing
 * else, so taking fire from an officer behind you was a number quietly going
 * down somewhere you were not looking. Every shooter solves this the same way
 * and has for twenty years, because it works: tell the player they are hurt in
 * the middle of the screen where their eyes already are, and tell them WHICH
 * WAY it came from so they can do something about it.
 *
 * FOUR LAYERS, drawn on one canvas in this order:
 *
 *   1. A red edge vignette whose strength is how hurt the player is. Constant
 *      while it lasts, so it reads as a state rather than an event.
 *   2. Blood smears at the edges, fading in as the state gets worse. Generated
 *      once into an offscreen canvas rather than downloaded.
 *   3. A white-hot flash for the instant of each hit, gone in a fifth of a
 *      second. This is the event.
 *   4. Directional arcs around the crosshair, one per recent hit, pointing at
 *      where it came from IN THE CAMERA'S CURRENT FRAME - so an arc keeps
 *      pointing at the shooter as the player turns to face them, which is the
 *      entire point of having it.
 *
 * COST. One canvas, drawn only when something is live, at a deliberately low
 * resolution: this is bloom and smears, and the pixels are cheap where the
 * shading is not. It renders nothing at all - and skips the whole pass - when
 * the player is unhurt and nothing has hit them recently.
 */

/** Seconds a directional arc stays up after the hit that made it. */
const ARC_LIFE = 1.5;
/** Directional arcs alive at once. Beyond this the oldest is recycled. */
const MAX_ARCS = 6;
/** Seconds the white flash of one hit lasts. */
const FLASH_LIFE = 0.22;

/** Health fraction below which the blood smears begin, and where they peak. */
const BLOOD_FROM = 0.65;
const BLOOD_FULL = 0.15;

/** How much of the screen's short side the vignette reaches in. */
const VIGNETTE_REACH = 0.55;

/** Radius of the arc ring, as a fraction of the screen's short side. */
const ARC_RADIUS = 0.13;
/** Half-width of one arc, in radians. */
const ARC_SPAN = 0.34;

/**
 * Pixels per CSS pixel for the overlay canvas.
 *
 * Deliberately below 1: nothing drawn here has an edge sharper than a soft
 * gradient, and at 0.5 the whole pass is a quarter of the fragments for a
 * result no player can distinguish. On a Retina display this is an eighth of
 * what a `devicePixelRatio` canvas would cost.
 */
const OVERLAY_SCALE = 0.5;

export interface VitalsView {
  /** 0..1. */
  readonly health: number;
  readonly alive: boolean;
  /** Camera yaw, radians, matching the world convention. */
  readonly yaw: number;
  readonly x: number;
  readonly z: number;
}

interface Arc {
  alive: boolean;
  life: number;
  /** Where the damage came from, in world space, so the arc can be re-aimed. */
  x: number;
  z: number;
  /** Set when the source is unknown; the arc then covers the whole ring. */
  omni: boolean;
  strength: number;
}

export class DamageFeedback {
  /** Put this in the HUD. It takes no pointer events and no focus. */
  readonly element: HTMLCanvasElement;

  private readonly context: CanvasRenderingContext2D | null;
  private readonly arcs: Arc[] = [];
  private arcCursor = 0;
  private flash = 0;
  private flashStrength = 0;
  private health = 1;
  private alive = true;
  private width = 0;
  private height = 0;
  private smears: HTMLCanvasElement | null = null;
  private drewLast = false;
  private disposed = false;

  constructor() {
    this.element = document.createElement('canvas');
    this.element.className = 'mb-hud__damage';
    // Decorative. The health bar beside it is the accessible readout.
    this.element.setAttribute('aria-hidden', 'true');
    this.context = this.element.getContext('2d');
    for (let i = 0; i < MAX_ARCS; i += 1) {
      this.arcs.push({ alive: false, life: 0, x: 0, z: 0, omni: true, strength: 0 });
    }
  }

  /**
   * Registers one hit.
   *
   * `strength` is the damage as a fraction of full health, so a graze and a
   * shotgun at close range do not produce the same flash. `sourceX/sourceZ`
   * are where it came from; omit them for damage with no direction - a fall,
   * a blast the player set off themselves - and the arc becomes a full ring.
   */
  hit(strength: number, sourceX?: number, sourceZ?: number): void {
    if (this.disposed) return;
    const scaled = Math.max(0.12, Math.min(1, strength));
    this.flash = FLASH_LIFE;
    this.flashStrength = Math.max(this.flashStrength, scaled);

    const arc = this.arcs[this.arcCursor] as Arc;
    this.arcCursor = (this.arcCursor + 1) % MAX_ARCS;
    arc.alive = true;
    arc.life = 0;
    arc.strength = scaled;
    if (sourceX === undefined || sourceZ === undefined) {
      arc.omni = true;
      arc.x = 0;
      arc.z = 0;
    } else {
      arc.omni = false;
      arc.x = sourceX;
      arc.z = sourceZ;
    }
  }

  /** Clears every live indicator. Called on respawn. */
  reset(): void {
    for (const arc of this.arcs) arc.alive = false;
    this.flash = 0;
    this.flashStrength = 0;
  }

  update(dt: number, vitals: VitalsView): void {
    if (this.disposed) return;
    this.health = Math.max(0, Math.min(1, vitals.health));
    this.alive = vitals.alive;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt);
    let liveArcs = 0;
    for (const arc of this.arcs) {
      if (!arc.alive) continue;
      arc.life += dt;
      if (arc.life >= ARC_LIFE) {
        arc.alive = false;
        continue;
      }
      liveArcs += 1;
    }

    const wounded = this.health < 0.999;
    const anything = wounded || liveArcs > 0 || this.flash > 0 || !this.alive;
    if (!anything) {
      // Clear once when the last thing goes away, then stop touching the
      // canvas entirely until something happens again.
      if (this.drewLast) {
        this.clear();
        this.drewLast = false;
      }
      this.element.hidden = true;
      return;
    }
    this.element.hidden = false;
    this.draw(vitals);
    this.drewLast = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.smears = null;
    this.element.remove();
  }

  // -- drawing --------------------------------------------------------------

  private resize(): void {
    const host = this.element.parentElement;
    const cssWidth = Math.max(1, Math.round(host?.clientWidth || window.innerWidth));
    const cssHeight = Math.max(1, Math.round(host?.clientHeight || window.innerHeight));
    const width = Math.max(1, Math.round(cssWidth * OVERLAY_SCALE));
    const height = Math.max(1, Math.round(cssHeight * OVERLAY_SCALE));
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.element.width = width;
    this.element.height = height;
    // The smears are sized to the canvas, so they have to be rebuilt with it.
    this.smears = null;
  }

  private clear(): void {
    this.context?.clearRect(0, 0, this.width, this.height);
  }

  private draw(vitals: VitalsView): void {
    const ctx = this.context;
    if (!ctx) return;
    this.resize();
    const w = this.width;
    const h = this.height;
    const short = Math.min(w, h);
    ctx.clearRect(0, 0, w, h);

    // 1. The state: how hurt the player is, as an edge vignette.
    const hurt = 1 - this.health;
    if (hurt > 0.001) {
      // Cubed so the first scratch is barely visible and the last quarter of
      // health is unmistakable. A linear ramp made a full-health-minus-one
      // player look as though they were dying.
      const strength = Math.min(0.82, hurt * hurt * hurt * 1.9 + hurt * 0.16);
      const gradient = ctx.createRadialGradient(
        w / 2, h / 2, short * (1 - VIGNETTE_REACH) * 0.5,
        w / 2, h / 2, short * 0.78,
      );
      gradient.addColorStop(0, 'rgba(120, 6, 6, 0)');
      gradient.addColorStop(0.55, `rgba(122, 8, 8, ${(strength * 0.42).toFixed(3)})`);
      gradient.addColorStop(1, `rgba(88, 2, 2, ${strength.toFixed(3)})`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
    }

    // 2. Blood on the lens, once things are genuinely bad.
    if (this.health < BLOOD_FROM) {
      const t = Math.min(
        1,
        (BLOOD_FROM - this.health) / Math.max(1e-3, BLOOD_FROM - BLOOD_FULL),
      );
      const smears = this.ensureSmears();
      if (smears) {
        ctx.globalAlpha = Math.min(0.85, t * 0.9);
        ctx.drawImage(smears, 0, 0);
        ctx.globalAlpha = 1;
      }
    }

    // 3. The event: one hit, right now.
    if (this.flash > 0) {
      const t = this.flash / FLASH_LIFE;
      const alpha = t * t * this.flashStrength * 0.55;
      ctx.fillStyle = `rgba(190, 24, 24, ${alpha.toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    } else {
      this.flashStrength = 0;
    }

    // 4. Where it came from.
    const radius = short * ARC_RADIUS;
    for (const arc of this.arcs) {
      if (!arc.alive) continue;
      const remaining = 1 - arc.life / ARC_LIFE;
      const alpha = remaining * remaining * (0.35 + arc.strength * 0.55);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.lineWidth = Math.max(2, short * 0.012);
      ctx.lineCap = 'butt';
      ctx.strokeStyle = `rgba(226, 46, 40, ${alpha.toFixed(3)})`;
      if (arc.omni) {
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        // Screen angle of the source, in the camera's CURRENT frame. Forward
        // is (-sin yaw, -cos yaw); the arc sits at zero when the source is
        // dead ahead and swings round as the player turns.
        const dx = arc.x - vitals.x;
        const dz = arc.z - vitals.z;
        const forwardX = -Math.sin(vitals.yaw);
        const forwardZ = -Math.cos(vitals.yaw);
        // Right-hand screen axis for this yaw, so the sign of the cross
        // product puts a shooter on the player's right on the right of the ring.
        const rightX = -forwardZ;
        const rightZ = forwardX;
        const along = dx * forwardX + dz * forwardZ;
        const across = dx * rightX + dz * rightZ;
        const angle = Math.atan2(across, along) - Math.PI / 2;
        ctx.beginPath();
        ctx.arc(0, 0, radius, angle - ARC_SPAN, angle + ARC_SPAN);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Death takes the screen out entirely, over and above the vignette.
    if (!this.alive) {
      ctx.fillStyle = 'rgba(24, 2, 2, 0.55)';
      ctx.fillRect(0, 0, w, h);
    }
  }

  /**
   * The blood smears, drawn once into their own canvas.
   *
   * Generated rather than downloaded: it is a dozen soft blobs pushed in from
   * the edges, which costs nothing to make, needs no request, and cannot fail
   * to load. Deterministic in the canvas size so it does not reshuffle itself
   * every time the player is hurt.
   */
  private ensureSmears(): HTMLCanvasElement | null {
    if (this.smears) return this.smears;
    if (this.width <= 0 || this.height <= 0) return null;
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const w = this.width;
    const h = this.height;
    const short = Math.min(w, h);
    // A small integer hash, so the same viewport always produces the same
    // smears and resizing is the only thing that ever changes them.
    let seed = (w * 73856093) ^ (h * 19349663);
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 16; i += 1) {
      // Pushed towards whichever edge is nearest, so the middle of the screen
      // - where the player is actually aiming - stays readable.
      const edge = i % 4;
      const along = rand();
      const depth = 0.02 + rand() * 0.16;
      // 0 top, 1 right, 2 bottom, 3 left: one coordinate runs along the edge
      // and the other sits a little way in from it.
      const horizontal = edge === 0 || edge === 2;
      const x = horizontal ? along * w : edge === 1 ? w * (1 - depth) : w * depth;
      const y = horizontal ? (edge === 0 ? h * depth : h * (1 - depth)) : along * h;
      const radius = short * (0.05 + rand() * 0.13);
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      const alpha = 0.22 + rand() * 0.3;
      gradient.addColorStop(0, `rgba(96, 6, 6, ${alpha.toFixed(3)})`);
      gradient.addColorStop(0.6, `rgba(74, 4, 4, ${(alpha * 0.5).toFixed(3)})`);
      gradient.addColorStop(1, 'rgba(60, 2, 2, 0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    this.smears = canvas;
    return canvas;
  }
}
