/**
 * What a shot looks like: muzzle flash, tracer, impact spark, scorch mark.
 *
 * NO LIGHTS OF ANY KIND. Profiling this project put point lights at 61 per cent
 * of the frame, so a muzzle flash here is emissive geometry - an additively
 * blended, unlit quad that glows but illuminates nothing - exactly as the
 * headlamps, brake lamps and shop signs already are. A gunshot in a dark alley
 * therefore does not light the alley. That is the deliberate trade, and it is
 * the same one every other light source in Meridian Bay makes.
 *
 * BUDGET. Two `InstancedMesh`es for the whole combat layer, and both are
 * hidden when nothing is alive, so a player who never fires pays nothing:
 *
 *   glow    one additive unit quad, reused as flash, tracer and spark
 *   marks   one dark unlit quad, laid flat on whatever was hit
 *
 * Everything is pooled with a fixed capacity and the oldest entry is recycled,
 * so sustained automatic fire cannot grow the pool or allocate per frame.
 */

import {
  AdditiveBlending,
  Color,
  DataTexture,
  InstancedMesh,
  Group,
  LinearFilter,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  RGBAFormat,
  Vector3,
  type Object3D as Object3DType,
} from 'three';

/**
 * Bright bits alive at once: flashes, tracers, sparks and blast debris.
 *
 * Sized by the worst case rather than the common one. A rocket detonation
 * spends about 50 of these in a single frame, and a burst of automatic fire
 * into a wall another 40; the pool has to hold both at once or a blast in a
 * firefight silently deletes the firefight's sparks.
 */
const GLOW_CAPACITY = 176;
/** Scorch marks, blood and blast craters kept on the world. */
const MARK_CAPACITY = 72;

const FLASH_LIFE = 0.055;
const TRACER_LIFE = 0.05;
const SPARK_LIFE = 0.32;
/** How long a bullet's scuff lasts. Blast craters and blood set their own. */
const MARK_LIFE = 9;
/** Fraction of a mark's life spent shrinking away. */
const MARK_FADE = 0.18;

const SPARK_GRAVITY = -14;

/**
 * A radial falloff, generated rather than downloaded.
 *
 * Without it every effect is a flat card with four corners, and a muzzle flash
 * half a metre from the eye reads as a white rectangle stuck to the screen
 * rather than as light. 64x64 of generated alpha costs 16 KB, no request and
 * no decode, and one texture serves the flash, the tracer, the sparks and the
 * scorch marks.
 */
function createFalloffTexture(): DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = ((x + 0.5) / size) * 2 - 1;
      const dy = ((y + 0.5) / size) * 2 - 1;
      const r = Math.min(1, Math.hypot(dx, dy));
      // Smoothstep on the remaining radius: a soft core with no visible edge.
      const t = 1 - r;
      const alpha = t * t * (3 - 2 * t);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(255 * alpha);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export type ImpactKind = 'world' | 'metal' | 'body' | 'glass';

interface Glow {
  alive: boolean;
  life: number;
  maxLife: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Half-extents of the quad before the life curve is applied. */
  width: number;
  height: number;
  /** Set for a tracer, which must lie along the shot rather than face us. */
  aimed: boolean;
  ax: number;
  ay: number;
  az: number;
  r: number;
  g: number;
  b: number;
  /**
   * Extra half-extent added per second of life.
   *
   * Zero for a spark, which is a fixed-size ember thrown through the air, and
   * several metres a second for a fireball or a shockwave, which are volumes
   * of expanding gas and have to grow or they read as a sticker.
   */
  growth: number;
  /** Metres per second squared of fall. Embers fall; hot gas rises. */
  gravity: number;
  /** Per-second velocity decay, so blast debris slows in the air. */
  drag: number;
}

interface Mark {
  alive: boolean;
  life: number;
  /** Seconds this mark lasts. A bullet scuff and a blast crater differ. */
  maxLife: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  size: number;
  r: number;
  g: number;
  b: number;
}

const SPARK_COLOUR: Readonly<Record<ImpactKind, readonly [number, number, number]>> = {
  // Struck stone throws pale dust; struck steel throws hot orange; a body
  // throws a dull dark red, kept deliberately muted; glazing throws pale
  // near-white chips that catch the light rather than glowing.
  world: [0.72, 0.68, 0.6],
  metal: [1, 0.62, 0.22],
  body: [0.34, 0.07, 0.07],
  glass: [0.78, 0.86, 0.9],
};

const MARK_COLOUR: Readonly<Record<ImpactKind, readonly [number, number, number]>> = {
  world: [0.06, 0.06, 0.065],
  metal: [0.05, 0.05, 0.055],
  body: [0.09, 0.02, 0.02],
  glass: [0.07, 0.08, 0.085],
};

/** How many embers each kind of impact throws. */
const SPARK_COUNT: Readonly<Record<ImpactKind, number>> = {
  world: 4,
  metal: 5,
  // A hit on a person is the one the player is looking straight at when it
  // happens, and four dull specks did not read as a hit at all.
  body: 9,
  glass: 8,
};

/** Seconds a blood pool stays on the ground. Far longer than a bullet scuff. */
const BLOOD_LIFE = 26;
/** Seconds a blast crater stays. Longer still: it is the size of a car. */
const CRATER_LIFE = 40;

export class CombatFx {
  /** Add this to the scene. It owns two meshes and nothing else. */
  readonly group: Object3DType;

  private readonly glowMesh: InstancedMesh;
  private readonly markMesh: InstancedMesh;
  private readonly glows: Glow[] = [];
  private readonly marks: Mark[] = [];
  private glowCursor = 0;
  private markCursor = 0;

  private readonly dummy = new Object3D();
  private readonly colour = new Color();
  private readonly quaternion = new Quaternion();
  private readonly unitZ = new Vector3(0, 0, 1);
  private readonly scratch = new Vector3();
  private readonly axisX = new Vector3();
  private readonly axisY = new Vector3();
  private readonly axisZ = new Vector3();
  private readonly basis = new Matrix4();
  private disposed = false;

  private readonly falloff = createFalloffTexture();

  constructor() {
    const glowGeometry = new PlaneGeometry(1, 1);
    const glowMaterial = new MeshBasicMaterial({
      color: 0xffffff,
      map: this.falloff,
      transparent: true,
      opacity: 0.95,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    glowMaterial.name = 'combat-glow';
    this.glowMesh = new InstancedMesh(glowGeometry, glowMaterial, GLOW_CAPACITY);
    this.glowMesh.name = 'combat-glow';
    this.glowMesh.frustumCulled = false;
    this.glowMesh.renderOrder = 6;
    this.glowMesh.count = 0;
    this.glowMesh.visible = false;

    const markGeometry = new PlaneGeometry(1, 1);
    const markMaterial = new MeshBasicMaterial({
      color: 0xffffff,
      map: this.falloff,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      toneMapped: false,
    });
    markMaterial.name = 'combat-mark';
    this.markMesh = new InstancedMesh(markGeometry, markMaterial, MARK_CAPACITY);
    this.markMesh.name = 'combat-marks';
    this.markMesh.frustumCulled = false;
    // Marks sit a millimetre off the surface; a render order keeps them above
    // the wall they are on without a depth-bias fight.
    this.markMesh.renderOrder = 5;
    this.markMesh.count = 0;
    this.markMesh.visible = false;

    for (let i = 0; i < GLOW_CAPACITY; i += 1) {
      this.glows.push({
        alive: false, life: 0, maxLife: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        width: 0, height: 0, aimed: false, ax: 0, ay: 0, az: 1, r: 1, g: 1, b: 1,
        growth: 0, gravity: SPARK_GRAVITY, drag: 0,
      });
    }
    for (let i = 0; i < MARK_CAPACITY; i += 1) {
      this.marks.push({
        alive: false, life: 0, maxLife: MARK_LIFE, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0,
        size: 0.2, r: 0, g: 0, b: 0,
      });
    }

    const group = new Group();
    group.name = 'combat-fx';
    group.add(this.glowMesh, this.markMesh);
    this.group = group;
  }

  /** A flash at the muzzle. `scale` follows the weapon's violence. */
  muzzle(x: number, y: number, z: number, scale: number): void {
    const glow = this.takeGlow();
    glow.alive = true;
    glow.life = 0;
    glow.maxLife = FLASH_LIFE;
    glow.x = x;
    glow.y = y;
    glow.z = z;
    glow.vx = 0;
    glow.vy = 0;
    glow.vz = 0;
    // Small: the muzzle is half a metre from the eye, where a 62-degree
    // frustum is only sixty centimetres tall. A flash the size of a hand
    // covers a tenth of the screen, which is already a lot of light.
    glow.width = 0.06 * scale;
    glow.height = 0.06 * scale;
    glow.aimed = false;
    glow.r = 1;
    glow.g = 0.86;
    glow.b = 0.52;
  }

  /** The bullet's path, drawn as a short bright streak along the shot. */
  tracer(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const length = Math.hypot(dx, dy, dz);
    if (length < 0.4) return;
    const glow = this.takeGlow();
    glow.alive = true;
    glow.life = 0;
    glow.maxLife = TRACER_LIFE;
    glow.x = (x0 + x1) * 0.5;
    glow.y = (y0 + y1) * 0.5;
    glow.z = (z0 + z1) * 0.5;
    glow.vx = 0;
    glow.vy = 0;
    glow.vz = 0;
    glow.width = 0.035;
    glow.height = length;
    glow.aimed = true;
    glow.ax = dx / length;
    glow.ay = dy / length;
    glow.az = dz / length;
    glow.r = 1;
    glow.g = 0.82;
    glow.b = 0.46;
  }

  /**
   * Sparks and a scorch mark where a shot landed.
   *
   * `n*` is the surface normal; a body hit passes the shot direction reversed,
   * which is close enough for four sparks that live a third of a second.
   */
  impact(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    kind: ImpactKind,
    rand: () => number,
  ): void {
    const spark = SPARK_COLOUR[kind];
    for (let i = 0; i < SPARK_COUNT[kind]; i += 1) {
      const glow = this.takeGlow();
      glow.alive = true;
      glow.life = 0;
      glow.maxLife = SPARK_LIFE * (0.6 + rand() * 0.7);
      glow.x = x + nx * 0.02;
      glow.y = y + ny * 0.02;
      glow.z = z + nz * 0.02;
      // Scatter around the normal: mostly back the way the shot came from.
      const speed = 1.8 + rand() * 3.4;
      glow.vx = (nx + (rand() - 0.5) * 1.4) * speed;
      glow.vy = (ny + (rand() - 0.5) * 1.4) * speed + 1.2;
      glow.vz = (nz + (rand() - 0.5) * 1.4) * speed;
      glow.width = 0.045;
      glow.height = 0.045;
      glow.aimed = false;
      glow.r = spark[0];
      glow.g = spark[1];
      glow.b = spark[2];
    }

    const mark = this.takeMark();
    const tint = MARK_COLOUR[kind];
    mark.alive = true;
    mark.life = 0;
    if (kind === 'body') {
      // A hit on a person does not mark the person - they move, and a decal
      // welded to a walking body slides. It marks the GROUND under them, which
      // is what a player actually sees afterwards, and it lasts long enough to
      // still be there when they walk back past it.
      mark.maxLife = BLOOD_LIFE;
      mark.x = x + (rand() - 0.5) * 0.4;
      mark.y = y - 0.9 - rand() * 0.6;
      mark.z = z + (rand() - 0.5) * 0.4;
      mark.nx = 0;
      mark.ny = 1;
      mark.nz = 0;
      mark.size = 0.18 + rand() * 0.12;
    } else {
      mark.x = x + nx * 0.012;
      mark.y = y + ny * 0.012;
      mark.z = z + nz * 0.012;
      mark.nx = nx;
      mark.ny = ny;
      mark.nz = nz;
      mark.size = 0.12 + rand() * 0.07;
    }
    mark.r = tint[0];
    mark.g = tint[1];
    mark.b = tint[2];
  }

  /**
   * One puff of rocket exhaust, left behind along a flight path.
   *
   * Deliberately slow-dying and slow-growing: a trail that fades as fast as a
   * spark is invisible from the side, which is exactly the angle a player
   * watches their own rocket from.
   */
  exhaust(x: number, y: number, z: number, rand: () => number): void {
    const puff = this.takeGlow();
    puff.alive = true;
    puff.life = 0;
    puff.maxLife = 0.5 + rand() * 0.35;
    puff.x = x + (rand() - 0.5) * 0.12;
    puff.y = y + (rand() - 0.5) * 0.12;
    puff.z = z + (rand() - 0.5) * 0.12;
    puff.vy = 0.35;
    puff.gravity = 0.4;
    puff.drag = 1.4;
    puff.width = 0.09;
    puff.height = 0.09;
    puff.growth = 0.9;
    puff.r = 0.62;
    puff.g = 0.55;
    puff.b = 0.5;
  }

  /**
   * A detonation.
   *
   * Four layers, all out of the same two instanced meshes the rest of the
   * combat layer already uses: a white core that is gone in a twentieth of a
   * second, a fireball that expands and cools from white through orange to
   * dull red, a ground-hugging shockwave ring, and forty embers thrown out
   * with drag so they slow in the air instead of flying off like sparks.
   *
   * It leaves a scorch on the ground that outlasts the blast by half a minute,
   * because a crater that vanishes as soon as the smoke clears is the tell
   * that nothing really happened there.
   *
   * `radius` is the blast's damage radius, and everything drawn is scaled from
   * it, so a bigger warhead is a bigger explosion without a second set of
   * numbers to keep in step.
   */
  explosion(x: number, y: number, z: number, radius: number, rand: () => number): void {
    // The core: a hard white flash at the seat of the blast.
    const core = this.takeGlow();
    core.alive = true;
    core.life = 0;
    core.maxLife = 0.09;
    core.x = x;
    core.y = y;
    core.z = z;
    core.width = radius * 0.5;
    core.height = radius * 0.5;
    core.growth = radius * 3;
    core.r = 3.4;
    core.g = 3.1;
    core.b = 2.6;

    // The fireball: several overlapping puffs so it has a shape rather than
    // being one perfectly round card, each rising as hot gas does.
    for (let i = 0; i < 7; i += 1) {
      const puff = this.takeGlow();
      puff.alive = true;
      puff.life = 0;
      puff.maxLife = 0.5 + rand() * 0.55;
      puff.x = x + (rand() - 0.5) * radius * 0.5;
      puff.y = y + rand() * radius * 0.3;
      puff.z = z + (rand() - 0.5) * radius * 0.5;
      puff.vx = (rand() - 0.5) * 4;
      puff.vy = 1.4 + rand() * 2.6;
      puff.vz = (rand() - 0.5) * 4;
      // Hot gas rises; it must not be pulled down by the ember gravity.
      puff.gravity = 1.5;
      puff.drag = 1.6;
      puff.width = radius * 0.24;
      puff.height = radius * 0.24;
      puff.growth = radius * (0.7 + rand() * 0.5);
      puff.r = 2.6;
      puff.g = 1.05 + rand() * 0.35;
      puff.b = 0.24;
    }

    // The shockwave: one flat ring at ground level, growing past the damage
    // radius so the player can see exactly how far the blast reached.
    const wave = this.takeGlow();
    wave.alive = true;
    wave.life = 0;
    wave.maxLife = 0.42;
    wave.x = x;
    wave.y = y - 0.6;
    wave.z = z;
    wave.width = radius * 0.3;
    wave.height = radius * 0.3;
    wave.growth = radius * 3.6;
    wave.r = 1.1;
    wave.g = 0.85;
    wave.b = 0.6;

    // Embers and burning debris.
    for (let i = 0; i < 26; i += 1) {
      const ember = this.takeGlow();
      ember.alive = true;
      ember.life = 0;
      ember.maxLife = 0.7 + rand() * 1.5;
      ember.x = x;
      ember.y = y;
      ember.z = z;
      const theta = rand() * Math.PI * 2;
      const lift = 0.15 + rand() * 0.95;
      const speed = radius * (0.9 + rand() * 1.6);
      ember.vx = Math.cos(theta) * speed;
      ember.vy = lift * speed;
      ember.vz = Math.sin(theta) * speed;
      ember.drag = 1.1;
      ember.width = 0.05 + rand() * 0.09;
      ember.height = ember.width;
      ember.r = 2.2;
      ember.g = 0.75 + rand() * 0.4;
      ember.b = 0.12;
    }

    const crater = this.takeMark();
    crater.alive = true;
    crater.life = 0;
    crater.maxLife = CRATER_LIFE;
    crater.x = x;
    crater.y = y - 0.55;
    crater.z = z;
    crater.nx = 0;
    crater.ny = 1;
    crater.nz = 0;
    crater.size = radius * 0.62;
    crater.r = 0.035;
    crater.g = 0.03;
    crater.b = 0.028;
  }

  /**
   * Advances every live effect and repacks the instance buffers.
   *
   * `cameraX/Y/Z` orients the unaimed quads at the viewer; a flash or a spark
   * seen edge-on would otherwise vanish.
   */
  update(dt: number, cameraX: number, cameraY: number, cameraZ: number): void {
    if (this.disposed) return;

    let live = 0;
    for (const glow of this.glows) {
      if (!glow.alive) continue;
      glow.life += dt;
      if (glow.life >= glow.maxLife) {
        glow.alive = false;
        continue;
      }
      if (glow.vy !== 0 || glow.vx !== 0 || glow.vz !== 0) {
        glow.vy += glow.gravity * dt;
        if (glow.drag > 0) {
          const keep = Math.max(0, 1 - glow.drag * dt);
          glow.vx *= keep;
          glow.vy *= keep;
          glow.vz *= keep;
        }
        glow.x += glow.vx * dt;
        glow.y += glow.vy * dt;
        glow.z += glow.vz * dt;
      }

      const t = glow.life / glow.maxLife;
      // Bright immediately, gone quickly: additive blending means the fade has
      // to happen in the colour, because there is no per-instance alpha.
      const fade = 1 - t * t;
      const grown = glow.growth * glow.life;
      const swell = glow.aimed ? 1 : 1 + t * 0.7;

      if (glow.aimed) {
        // A tracer is a ribbon: its local +Y must lie along the shot and its
        // face must turn toward the viewer. Building the basis directly is
        // exact and avoids composing two rotations that fight each other.
        this.axisY.set(glow.ax, glow.ay, glow.az);
        this.scratch.set(cameraX - glow.x, cameraY - glow.y, cameraZ - glow.z).normalize();
        this.axisX.crossVectors(this.axisY, this.scratch);
        if (this.axisX.lengthSq() < 1e-8) {
          // Looking straight down the barrel: any perpendicular will do.
          this.axisX.set(this.axisY.y, -this.axisY.x, 0);
          if (this.axisX.lengthSq() < 1e-8) this.axisX.set(1, 0, 0);
        }
        this.axisX.normalize().multiplyScalar(glow.width);
        this.axisZ.crossVectors(this.axisX, this.axisY).normalize();
        this.axisY.multiplyScalar(glow.height);
        this.basis.makeBasis(this.axisX, this.axisY, this.axisZ);
        this.basis.setPosition(glow.x, glow.y, glow.z);
        this.glowMesh.setMatrixAt(live, this.basis);
      } else {
        this.dummy.position.set(glow.x, glow.y, glow.z);
        this.dummy.lookAt(cameraX, cameraY, cameraZ);
        this.dummy.scale.set(glow.width * swell + grown, glow.height * swell + grown, 1);
        this.dummy.updateMatrix();
        this.glowMesh.setMatrixAt(live, this.dummy.matrix);
      }
      this.colour.setRGB(glow.r * fade, glow.g * fade, glow.b * fade);
      this.glowMesh.setColorAt(live, this.colour);
      live += 1;
      if (live >= GLOW_CAPACITY) break;
    }
    this.glowMesh.count = live;
    this.glowMesh.visible = live > 0;
    if (live > 0) {
      this.glowMesh.instanceMatrix.needsUpdate = true;
      if (this.glowMesh.instanceColor) this.glowMesh.instanceColor.needsUpdate = true;
    }

    let marks = 0;
    for (const mark of this.marks) {
      if (!mark.alive) continue;
      mark.life += dt;
      if (mark.life >= mark.maxLife) {
        mark.alive = false;
        continue;
      }
      const remaining = 1 - mark.life / mark.maxLife;
      const scale = mark.size * (remaining < MARK_FADE ? remaining / MARK_FADE : 1);
      this.dummy.position.set(mark.x, mark.y, mark.z);
      this.quaternion.setFromUnitVectors(
        this.unitZ,
        this.scratch.set(mark.nx, mark.ny, mark.nz).normalize(),
      );
      this.dummy.quaternion.copy(this.quaternion);
      this.dummy.scale.set(scale * 2, scale * 2, 1);
      this.dummy.updateMatrix();
      this.markMesh.setMatrixAt(marks, this.dummy.matrix);
      this.colour.setRGB(mark.r, mark.g, mark.b);
      this.markMesh.setColorAt(marks, this.colour);
      marks += 1;
      if (marks >= MARK_CAPACITY) break;
    }
    this.markMesh.count = marks;
    this.markMesh.visible = marks > 0;
    if (marks > 0) {
      this.markMesh.instanceMatrix.needsUpdate = true;
      if (this.markMesh.instanceColor) this.markMesh.instanceColor.needsUpdate = true;
    }
  }

  /** Live effects, for diagnostics. */
  get stats(): { glows: number; marks: number } {
    return { glows: this.glowMesh.count, marks: this.markMesh.count };
  }

  /** Drops every live effect without tearing the pools down. */
  clear(): void {
    for (const glow of this.glows) glow.alive = false;
    for (const mark of this.marks) mark.alive = false;
    this.glowMesh.count = 0;
    this.markMesh.count = 0;
    this.glowMesh.visible = false;
    this.markMesh.visible = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.falloff.dispose();
    this.glowMesh.geometry.dispose();
    (this.glowMesh.material as MeshBasicMaterial).dispose();
    this.markMesh.geometry.dispose();
    (this.markMesh.material as MeshBasicMaterial).dispose();
    this.glowMesh.dispose();
    this.markMesh.dispose();
    this.group.clear();
  }

  /**
   * A free glow slot, with every field a caller might not set already back at
   * its default.
   *
   * The reset matters: slots are recycled, so a fireball that set `growth` and
   * then died would hand a spark three metres a second of expansion if the
   * next caller only wrote the fields it cared about.
   */
  private takeGlow(): Glow {
    let glow: Glow | null = null;
    for (let i = 0; i < GLOW_CAPACITY; i += 1) {
      const index = (this.glowCursor + i) % GLOW_CAPACITY;
      const candidate = this.glows[index];
      if (candidate && !candidate.alive) {
        this.glowCursor = (index + 1) % GLOW_CAPACITY;
        glow = candidate;
        break;
      }
    }
    if (!glow) {
      // Everything is busy: reuse the oldest slot rather than dropping the shot.
      glow = this.glows[this.glowCursor] as Glow;
      this.glowCursor = (this.glowCursor + 1) % GLOW_CAPACITY;
    }
    glow.vx = 0;
    glow.vy = 0;
    glow.vz = 0;
    glow.aimed = false;
    glow.growth = 0;
    glow.gravity = SPARK_GRAVITY;
    glow.drag = 0;
    return glow;
  }

  private takeMark(): Mark {
    let mark: Mark | null = null;
    for (let i = 0; i < MARK_CAPACITY; i += 1) {
      const index = (this.markCursor + i) % MARK_CAPACITY;
      const candidate = this.marks[index];
      if (candidate && !candidate.alive) {
        this.markCursor = (index + 1) % MARK_CAPACITY;
        mark = candidate;
        break;
      }
    }
    if (!mark) {
      mark = this.marks[this.markCursor] as Mark;
      this.markCursor = (this.markCursor + 1) % MARK_CAPACITY;
    }
    mark.maxLife = MARK_LIFE;
    return mark;
  }
}
