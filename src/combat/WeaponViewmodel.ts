/**
 * The weapon in the player's hands, and the hands.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   const vm = new WeaponViewmodel(defaultViewmodels(BASE_URL), defaultHands(BASE_URL));
 *   scene.add(vm.group);
 *   // AFTER the controller and the driving layer have posed the camera:
 *   vm.update(dt, camera, player.equipped, {
 *     reloading, holstered, hidden, speed, clearance,
 *   });
 *   vm.punch(strength);   // once per shot
 *   vm.dispose();
 *
 * ============================================================================
 *
 * THE HANDS ARE THE ONLY PART OF THE PLAYER THAT EXISTS. Meridian Bay draws no
 * avatar, no legs and no shadow, so a gloved fist at the end of a sleeve is the
 * whole body as far as the camera is concerned. That is why it is a generated
 * asset and not four boxes: a wrong hand is worse than no hand, and the thing
 * a player looks straight at for the entire game cannot be the one object that
 * was faked. See `docs/weapon-assets.md` for task ids and costs.
 *
 * ONE FIST, USED TWICE. The right hand is the asset; the left is the same
 * object mirrored through X, which is not a shortcut but the anatomy - a
 * mirrored right hand IS a left hand. The materials are shared and drawn
 * double-sided, because mirroring reverses triangle winding.
 *
 * WHY IT IS NOT PARENTED TO THE CAMERA. Three.js only draws a camera's own
 * children when the camera is itself in the scene graph, which this game's
 * camera is not. `group` is therefore an ordinary scene object whose transform
 * is rewritten from the camera every frame, and `rig` hangs inside it holding
 * every bit of motion in the camera's own basis: +X right, +Y up, +Z BACKWARD.
 *
 * WHY IT LAGS. A viewmodel welded to the lens reads as a texture stuck to the
 * screen. This one measures how fast the camera is actually turning and swings
 * the whole assembly against it, damped, so a quick turn throws the weapon
 * wide and it settles a moment later; walking rolls it through a stride-locked
 * figure of eight; standing still leaves a slow breath in it. Every one of
 * those is integrated from `dt`, never from `performance.now()`, so a fixed-step
 * harness that drives frames by hand sees exactly what a player sees.
 *
 * COST: two draw calls when a weapon is drawn - the weapon and the hands share
 * nothing - plus one for the mirrored hand, zero when nothing is equipped, and
 * one shared material per asset. No lights; the muzzle flash is still emissive
 * geometry in `CombatFx`.
 */

import {
  Box3,
  Color,
  DoubleSide,
  Euler,
  Group,
  Mesh,
  Object3D,
  Vector3,
  type Material,
  type PerspectiveCamera,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { clamp, damp } from '../core/mathx';
import type { WeaponId } from '../player/PlayerState';

/**
 * How each generated asset has to be turned and sized to sit in a hand.
 *
 * Every Tripo model arrives normalised to 1.0 on its longest axis with a
 * CENTRE pivot, so the length here is the real one in metres and the rotation
 * is whatever puts the muzzle down the camera's forward axis. `yaw` is applied
 * first, then `pitch`, then `roll`; every three-vector below is in the camera's
 * own basis, (right, up, forward), in metres.
 */
export interface ViewmodelSpec {
  readonly url: string;
  /** Real length along the barrel, in metres. */
  readonly length: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  readonly offset: readonly [number, number, number];
  /** Where the muzzle sits, along the same three axes, in metres. */
  readonly muzzle: readonly [number, number, number];
  /** Where the trigger hand closes on the weapon. */
  readonly grip: readonly [number, number, number];
  /**
   * Where the support hand closes on it.
   *
   * A pistol is held with both hands nearly together, a carbine with them a
   * forearm's length apart; the difference is entirely in these two numbers.
   */
  readonly support: readonly [number, number, number];
  /** Cant of both hands about the barrel, radians. Positive rolls inboard. */
  readonly handRoll: number;
  /**
   * Optional multiplier over the generated base colour map.
   *
   * A generator reads "blued steel" as the colour blue, and the shotgun came
   * back a bright cobalt that looked like a toy in the hand. Multiplying the
   * map down is an honest correction of a known generation artefact, and it
   * costs nothing at runtime - it is one material colour, not a shader.
   */
  readonly tint?: number | undefined;
}

/**
 * Everything the viewmodel needs to draw: four weapons and one pair of hands.
 *
 * Bundled into a single value so the game's one call site - `main.ts`, which
 * passes `defaultViewmodels(BASE_URL)` straight through to `CombatSystem` -
 * did not have to learn about hands to get them.
 */
export interface ViewmodelSet {
  readonly weapons: Readonly<Record<WeaponId, ViewmodelSpec>>;
  /** Null draws the weapon with nothing holding it, as this used to. */
  readonly hands: HandsSpec | null;
}

/**
 * The gloved fist, once, for both hands.
 *
 * `pivot` moves the model so its ORIGIN is the point that closes on the grip
 * rather than the centre of its bounding box, which is where a normalised
 * generated asset puts it. Without that the offsets above would mean "put the
 * middle of the forearm on the trigger".
 */
export interface HandsSpec {
  readonly url: string;
  /** Real length of the fist and forearm together, in metres. */
  readonly length: number;
  /**
   * Rotation, in XYZ order: `yaw` spins the fist about its own forearm axis
   * FIRST, then `pitch` lays that forearm forward. Written this way round
   * because those are the two questions the asset actually poses - "which way
   * are the knuckles" and "how steeply does the arm come in" - and an order
   * that mixed them would make one unturnable without breaking the other.
   */
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  /** Bounding-box centre to grip point, in rig axes, in metres. */
  readonly pivot: readonly [number, number, number];
  /**
   * Multiplier over the generated base colour map.
   *
   * The glove is painted a mid grey, which under this city's sky - the only
   * thing lighting it, since a viewmodel gets no lights of its own - comes out
   * denim blue. Multiplying it down puts it back to black leather.
   */
  readonly tint: number;
  /**
   * How much of the environment the glove reflects, 0 to 1.
   *
   * Leather is not a mirror, and at full strength the sky washes the knuckle
   * separation out of the silhouette entirely - which on the only part of the
   * player that exists is the whole read.
   */
  readonly envIntensity: number;
}

/**
 * The shipped set.
 *
 * The sidearm and the carbine are `models/shop/*.glb`, generated for the gun
 * shop; the SMG and the shotgun are `models/weapons/*.glb`, generated here.
 * Three of the four are modelled nose-along-Z and the carbine nose-along-X,
 * and the two that face -Z already need no yaw at all, which is why the four
 * rotations differ rather than the assets being re-exported. Each one was
 * checked against the mesh - the barrel end is the thin end - not guessed.
 *
 * THE LENGTHS ARE FRAMING, NOT PHYSICS. A real 1.12 m carbine held 40 cm from
 * a 62-degree eye fills half the screen and puts its butt inside the near
 * plane; every first-person game shortens and shrinks the held weapon for the
 * same reason. The shop's rack draws the same file at its real world size,
 * where the viewer is metres away and the real size is what reads correctly.
 *
 * THE WEAPON SITS CLOSER IN THAN IT USED TO. It has to: there are arms behind
 * it now, and an arm that reaches further than a shoulder can is the detail
 * that gives the whole trick away. Pulling it in also buys back most of the
 * distance a barrel used to be able to push through a wall.
 */
export function defaultViewmodels(baseUrl: string): ViewmodelSet {
  return {
    hands: defaultHands(baseUrl),
    weapons: {
      pistol: {
        url: `${baseUrl}models/shop/pistol.glb`,
        length: 0.21,
        yaw: Math.PI,
        pitch: 0,
        roll: 0,
        offset: [0.088, -0.118, 0.395],
        muzzle: [0.088, -0.098, 0.5],
        // Both hands on the same grip, the left cupped under and outboard of
        // the right: a two-handed pistol hold, not a gangster's.
        grip: [0.093, -0.163, 0.3],
        support: [0.046, -0.188, 0.285],
        handRoll: 0.35,
      },
      smg: {
        url: `${baseUrl}models/weapons/smg.glb`,
        // Shorter and further out than its real proportions would suggest: the
        // generated receiver is deep and its magazine deeper, and at the
        // carbine's stand-off it filled a third of the frame.
        length: 0.36,
        // Nose already down -Z. Measured, not assumed: the thin end of the
        // mesh is at min-Z on both this and the shotgun. They used to carry
        // the pistol's `Math.PI` and were drawn back to front - the flash left
        // the butt plate - which is invisible without hands to give the model
        // a right way up.
        yaw: 0,
        pitch: 0,
        roll: 0,
        offset: [0.098, -0.152, 0.47],
        muzzle: [0.098, -0.132, 0.67],
        grip: [0.096, -0.192, 0.36],
        support: [0.048, -0.202, 0.54],
        handRoll: 0.25,
      },
      shotgun: {
        url: `${baseUrl}models/weapons/shotgun.glb`,
        length: 0.6,
        // Nose down -Z, like the SMG. See the note there.
        yaw: 0,
        pitch: 0,
        roll: 0,
        offset: [0.093, -0.133, 0.44],
        muzzle: [0.093, -0.113, 0.74],
        grip: [0.093, -0.173, 0.26],
        support: [0.042, -0.178, 0.5],
        handRoll: 0.25,
        // The generator painted "blued steel" cobalt blue. Halving the blue
        // channel and easing the green back turns it into gunmetal again.
        tint: 0xf2e089,
      },
      rifle: {
        // The gun shop's own rack model, turned nose-forward. Its local +X is
        // the butt, so -PI/2 about Y puts the muzzle down the camera's -Z.
        url: `${baseUrl}models/shop/rifle.glb`,
        length: 0.66,
        yaw: -Math.PI / 2,
        pitch: 0,
        roll: 0,
        offset: [0.093, -0.133, 0.46],
        muzzle: [0.093, -0.113, 0.79],
        grip: [0.093, -0.173, 0.28],
        support: [0.042, -0.178, 0.55],
        handRoll: 0.25,
      },
    },
  };
}

/**
 * The shipped hands.
 *
 * One Tripo text-to-3D fist in a leather glove on a jacketed forearm. The
 * rotation lays the forearm back along +Z - toward the player, out of frame -
 * with the knuckles up, which is the pose every one of the grip offsets above
 * is written against.
 */
export function defaultHands(baseUrl: string): HandsSpec {
  return {
    url: `${baseUrl}models/weapons/fist.glb`,
    // A fist and its cuff, measured end to end. Human-sized, and deliberately
    // NOT scaled with the weapons: the guns are foreshortened for framing and
    // a hand foreshortened to match would look like a child's.
    length: 0.156,
    // Measured against the pistol in the running game, not derived: the asset
    // arrives with its forearm along +Y and no convention about which way the
    // knuckles face, so these three numbers are the answer to "what turns this
    // into a right hand closed on a grip in front of the eye".
    yaw: 0.77,
    pitch: -0.35,
    roll: 0,
    pivot: [0, 0, 0],
    tint: 0x8c8c94,
    envIntensity: 0.55,
  };
}

/** How far the weapon is pushed back and down when it is being reloaded. */
const RELOAD_DROP = 0.11;
/** How far the whole model kicks back along the barrel per shot. */
const KICK_BACK = 0.045;
/** How far down the assembly travels when it is holstered away. */
const STOW_DROP = 0.42;
/** How far it tips muzzle-down on the way there. Most of the read is here. */
const STOW_TILT = 1.15;
/** Below this the assembly is not drawn at all. */
const STOW_HIDDEN = 0.035;
/** Seconds-scale rate for the raise and the lower. Deliberately unhurried. */
const STOW_RATE = 8.5;

/** Radians the rig swings against a turn, per radian per second of turn. */
const LAG_YAW = 0.055;
const LAG_PITCH = 0.045;
/** Ceiling on the swing, so a mouse flick cannot throw the weapon off screen. */
const LAG_LIMIT = 0.14;
/** How quickly the swing catches up. Lower is heavier. */
const LAG_RATE = 7;

/** Stride cycles per metre walked. A 1.7 m stride is one full figure of eight. */
const BOB_RATE = 3.7;
/** Metres of sway at a full run. */
const BOB_AMPLITUDE = 0.019;
/** Speed, in m/s, at which the bob is at full amplitude. */
const BOB_FULL_SPEED = 5.5;

/** Breaths per second while standing still, and how far the weapon rides. */
const IDLE_RATE = 0.55;
const IDLE_AMPLITUDE = 0.0055;

/**
 * Room the weapon needs in front of the eye before it starts being pulled in.
 *
 * Measured from the eye along the barrel. A carbine reaches about 0.8 m; the
 * player's collision cylinder is 0.34 m of radius, so without this the muzzle
 * is half a metre inside a wall whenever somebody stands close to one.
 */
const CLEARANCE_NEEDED = 0.95;
/**
 * How the weapon is tucked when there is no room in front of it.
 *
 * Muzzle up, a little back, a little down - and crucially rotated ABOUT THE
 * TRIGGER HAND rather than about the eye. Pivoting at the eye swings the whole
 * weapon clean off the top of the screen, which reads as the viewmodel
 * vanishing; pivoting at the hand is what a person actually does when they
 * shorten up in a doorway, and it keeps both the weapon and the hands in frame
 * the entire time.
 *
 * Together these take a carbine's 0.79 m of forward reach down to about
 * 0.46 m and stand the barrel up 26 degrees, so what is left inside a wall is
 * a tenth of a metre at a steep angle instead of most of the barrel. It is not
 * a depth-buffer trick and it does not pretend to be one: a separate
 * near-plane pass for the viewmodel is the real fix, and that belongs in the
 * render loop rather than here.
 */
const CLOSE_PULL = 0.05;
const CLOSE_TILT = 1;
const CLOSE_DROP = 0.04;

interface Entry {
  readonly spec: ViewmodelSpec;
  object: Object3D | null;
  loading: boolean;
  failed: boolean;
}

export interface ViewmodelPose {
  readonly reloading: boolean;
  /** The weapon is put away: no model, and the caller must refuse to fire. */
  readonly holstered: boolean;
  /** Nothing at all is drawn - driving, or dead. */
  readonly hidden: boolean;
  /** Metres per second on the ground, for the walk cycle. */
  readonly speed: number;
  /**
   * Metres of open space straight ahead of the eye, or `Infinity` when the
   * caller has nothing to tell us. Anything under `CLEARANCE_NEEDED` pulls the
   * weapon in and tips it up rather than letting the barrel enter the wall.
   */
  readonly clearance?: number | undefined;
}

export class WeaponViewmodel {
  /** Add this to the scene. It holds at most one weapon at a time. */
  readonly group: Object3D;

  private readonly entries = new Map<WeaponId, Entry>();
  private readonly loader = new GLTFLoader();
  private readonly disposables: (Material | { dispose(): void })[] = [];

  /** Everything that moves. A child of `group`, posed in the camera's basis. */
  private readonly rig: Group;
  private readonly weaponSlot: Group;
  private readonly rightHand: Group;
  private readonly leftHand: Group;

  private readonly handsSpec: HandsSpec | null;
  private handsObject: Object3D | null = null;
  private handsLoading = false;
  private handsFailed = false;

  private current: WeaponId | null = null;
  private kick = 0;
  private lower = 0;
  private stow = 0;
  private close = 0;
  private lagYaw = 0;
  private lagPitch = 0;
  private bobPhase = 0;
  private idlePhase = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private hasLastAngles = false;
  /** The trigger hand in rig-local space: the pivot the wall tuck turns about. */
  private pivotY = 0;
  private pivotZ = 0;
  private disposed = false;

  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly forward = new Vector3();
  private readonly angles = new Euler(0, 0, 0, 'YXZ');
  private readonly offset = new Vector3();

  constructor(set: ViewmodelSet) {
    const group = new Group();
    group.name = 'weapon-viewmodel';
    // Held a few tens of centimetres from the eye, well inside the fog and
    // never worth culling against a frustum it is always inside.
    group.frustumCulled = false;
    group.renderOrder = 4;
    this.group = group;

    this.rig = new Group();
    this.rig.name = 'weapon-rig';
    this.rig.frustumCulled = false;
    group.add(this.rig);

    this.weaponSlot = new Group();
    this.rightHand = new Group();
    this.leftHand = new Group();
    // A mirrored right hand IS a left hand. Winding reverses with it, which is
    // why the shared material is drawn double-sided in `prepareHands`.
    this.leftHand.scale.set(-1, 1, 1);
    this.rightHand.visible = false;
    this.leftHand.visible = false;
    this.rig.add(this.weaponSlot, this.rightHand, this.leftHand);

    this.handsSpec = set.hands;
    for (const [id, spec] of Object.entries(set.weapons) as [WeaponId, ViewmodelSpec][]) {
      this.entries.set(id, { spec, object: null, loading: false, failed: false });
    }
  }

  /** The muzzle position in world space, for the flash and the tracer. */
  muzzleWorld(camera: PerspectiveCamera, out: Vector3): Vector3 {
    const entry = this.current ? this.entries.get(this.current) : undefined;
    this.readBasis(camera);
    const m = entry?.spec.muzzle ?? [0.17, -0.13, 0.5];
    // The rig's own sway is in the same basis, so adding it keeps the flash on
    // the end of the barrel instead of hanging where the barrel would be if
    // the player were standing perfectly still.
    const pose = this.rig.position;
    out.copy(camera.position);
    out.addScaledVector(this.right, (m[0] ?? 0) + pose.x);
    out.addScaledVector(this.up, (m[1] ?? 0) + pose.y);
    out.addScaledVector(this.forward, (m[2] ?? 0) - pose.z - this.close * CLOSE_PULL);
    return out;
  }

  /** True once the equipped weapon's asset is on screen. Diagnostics only. */
  get ready(): boolean {
    const entry = this.current ? this.entries.get(this.current) : undefined;
    return entry?.object !== null && entry?.object !== undefined;
  }

  /** True once the generated hands are on screen. Diagnostics only. */
  get handsReady(): boolean {
    return this.handsObject !== null;
  }

  /** Assets that failed to download. The game carries on without them. */
  get failedCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.failed) n += 1;
    if (this.handsFailed) n += 1;
    return n;
  }

  /** How far the weapon is out of its holster, 0 to 1. Diagnostics only. */
  get raised(): number {
    return 1 - this.stow;
  }

  /** Kicks the model back. Called once per shot, alongside the camera recoil. */
  punch(strength = 1): void {
    this.kick = Math.min(0.09, this.kick + KICK_BACK * strength);
  }

  /**
   * One frame.
   *
   * `equipped` is the weapon in hand, or null for empty hands - which is also
   * what a driving player has, since this game does not fire from a car.
   */
  update(
    dt: number,
    camera: PerspectiveCamera,
    equipped: WeaponId | null,
    pose: ViewmodelPose,
  ): void {
    if (this.disposed) return;

    const wanted = pose.hidden ? null : equipped;
    if (wanted !== this.current) {
      this.setCurrent(wanted);
      // A weapon that has just been drawn comes up from below rather than
      // appearing in place. The same animation the holster key drives.
      if (wanted) this.stow = 1;
    }
    if (wanted) {
      this.ensureLoaded(wanted);
      this.ensureHands();
    }

    this.kick = damp(this.kick, 0, 11, dt);
    this.lower = damp(this.lower, pose.reloading ? 1 : 0, 9, dt);
    this.stow = damp(this.stow, pose.holstered ? 1 : 0, STOW_RATE, dt);

    const clearance = pose.clearance ?? Infinity;
    const crowded = clearance >= CLEARANCE_NEEDED
      ? 0
      : clamp(1 - clearance / CLEARANCE_NEEDED, 0, 1);
    // Snaps in fast so a barrel never enters a wall, eases out slowly so
    // stepping away from one does not look like the weapon was spring-loaded.
    this.close = damp(this.close, crowded, crowded > this.close ? 16 : 6, dt);

    const entry = wanted ? this.entries.get(wanted) : undefined;
    const object = entry?.object ?? null;
    const shown = object !== null && this.stow < 1 - STOW_HIDDEN;
    this.group.visible = shown;
    this.rightHand.visible = shown && this.handsObject !== null;
    this.leftHand.visible = this.rightHand.visible;
    if (!object || !entry) return;

    this.readBasis(camera);
    this.trackTurn(dt, camera);
    this.integrateWalk(dt, pose.speed);

    // Everything from here is in the camera's own basis: +X right, +Y up,
    // +Z BACKWARD, which is why the forward offsets are negated when they are
    // written into local space and the kick is positive.
    const walk = clamp(pose.speed / BOB_FULL_SPEED, 0, 1);
    const swing = BOB_AMPLITUDE * walk;
    const bobX = Math.sin(this.bobPhase) * swing;
    // Twice the frequency vertically: a stride drops the shoulder once per
    // foot, not once per pair.
    const bobY = -Math.abs(Math.sin(this.bobPhase * 2)) * swing * 0.8;
    const breathe = (1 - walk) * IDLE_AMPLITUDE;
    const idleX = Math.sin(this.idlePhase) * breathe;
    const idleY = Math.sin(this.idlePhase * 1.7) * breathe;

    const drop = this.lower * RELOAD_DROP + this.stow * STOW_DROP + this.close * CLOSE_DROP;
    // Tipped down while reloading and further while stowing - both are the
    // weapon coming off the aim - and UP when there is a wall in the way,
    // because a barrel pointed at the ceiling is the pose that reads as "no
    // room" rather than as a bug.
    const pitch =
      -this.lower * 0.5 +
      this.kick * 1.4 -
      this.lagPitch -
      this.stow * STOW_TILT +
      this.close * CLOSE_TILT;

    /*
     * Turn the wall tuck about the trigger hand instead of about the eye.
     *
     * `rig` pivots at the camera, so any pitch on it swings the whole assembly
     * through an arc a third of a metre long. For the small angles - sway,
     * recoil, the reload dip - that IS the motion wanted. For a full radian it
     * throws the weapon off screen. Rotating the pivot point and adding back
     * the difference leaves the hand where it was and turns the weapon around
     * it, which is what a person does. Only the tuck's share of the pitch is
     * compensated; everything else is small enough that the arc is the point.
     */
    const tuck = this.close * CLOSE_TILT;
    const cos = Math.cos(tuck);
    const sin = Math.sin(tuck);
    const pivotedY = this.pivotY * cos - this.pivotZ * sin;
    const pivotedZ = this.pivotY * sin + this.pivotZ * cos;

    this.rig.position.set(
      bobX + idleX + this.lagYaw * 0.5,
      bobY + idleY - drop - this.lagPitch * 0.4 + (this.pivotY - pivotedY),
      this.kick + this.close * CLOSE_PULL + (this.pivotZ - pivotedZ),
    );
    this.rig.rotation.set(pitch, this.lagYaw, this.lagYaw * 0.6 + this.stow * 0.35, 'YXZ');

    this.group.position.copy(camera.position);
    this.group.quaternion.copy(camera.quaternion);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.weaponSlot.clear();
    this.rightHand.clear();
    this.leftHand.clear();
    this.rig.clear();
    this.group.clear();
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.entries.clear();
    this.handsObject = null;
  }

  // -- internals ------------------------------------------------------------

  private readBasis(camera: PerspectiveCamera): void {
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    this.forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  }

  /**
   * How hard the camera is turning, and the weapon swinging against it.
   *
   * The angular rate is differentiated from the camera's own yaw and pitch
   * rather than taken from the controller, so this works for any caller and
   * for a camera driven by a test. The first frame after a teleport is
   * discarded: a jump of two radians in one step is not a turn.
   */
  private trackTurn(dt: number, camera: PerspectiveCamera): void {
    this.angles.setFromQuaternion(camera.quaternion, 'YXZ');
    const yaw = this.angles.y;
    const pitch = this.angles.x;
    let rateYaw = 0;
    let ratePitch = 0;
    if (this.hasLastAngles && dt > 1e-5) {
      let dYaw = yaw - this.lastYaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      // A teleport, not a turn. Half a radian in one frame is already faster
      // than any mouse; beyond that it is the harness moving the player.
      if (Math.abs(dYaw) < 0.5) rateYaw = dYaw / dt;
      const dPitch = pitch - this.lastPitch;
      if (Math.abs(dPitch) < 0.5) ratePitch = dPitch / dt;
    }
    this.lastYaw = yaw;
    this.lastPitch = pitch;
    this.hasLastAngles = true;

    const wantYaw = clamp(rateYaw * LAG_YAW, -LAG_LIMIT, LAG_LIMIT);
    const wantPitch = clamp(ratePitch * LAG_PITCH, -LAG_LIMIT, LAG_LIMIT);
    this.lagYaw = damp(this.lagYaw, wantYaw, LAG_RATE, dt);
    this.lagPitch = damp(this.lagPitch, wantPitch, LAG_RATE, dt);
  }

  /**
   * The walk cycle, advanced by DISTANCE rather than by time.
   *
   * A bob driven by a clock keeps swaying while the player stands still and
   * runs at the same rate whether they walk or sprint. Advancing it by
   * `speed * dt` locks it to the stride, which is what makes it read as
   * somebody carrying something rather than as an oscillator.
   */
  private integrateWalk(dt: number, speed: number): void {
    this.bobPhase += dt * Math.max(speed, 0) * BOB_RATE;
    if (this.bobPhase > Math.PI * 2) this.bobPhase %= Math.PI * 2;
    this.idlePhase += dt * IDLE_RATE * Math.PI * 2;
    if (this.idlePhase > Math.PI * 2) this.idlePhase %= Math.PI * 2;
  }

  private setCurrent(id: WeaponId | null): void {
    this.current = id;
    this.weaponSlot.clear();
    if (!id) return;
    const entry = this.entries.get(id);
    if (entry?.object) this.weaponSlot.add(entry.object);
    if (entry) this.placeHands(entry.spec);
  }

  /**
   * Puts the two hands where this weapon is held.
   *
   * The grip points are in the camera's basis and the rig's local space has
   * +Z backward, so the forward component is negated on the way in. The roll
   * cants both fists inboard, because a fist whose knuckles face straight up
   * reads as a mannequin's.
   */
  private placeHands(spec: ViewmodelSpec): void {
    const grip = spec.grip;
    const support = spec.support;
    this.rightHand.position.set(grip[0] ?? 0, grip[1] ?? 0, -(grip[2] ?? 0));
    this.pivotY = grip[1] ?? 0;
    this.pivotZ = -(grip[2] ?? 0);
    this.rightHand.rotation.set(0, 0, -spec.handRoll, 'YXZ');
    this.leftHand.position.set(support[0] ?? 0, support[1] ?? 0, -(support[2] ?? 0));
    // Mirrored through X, so the same inboard cant is the opposite sign.
    this.leftHand.rotation.set(0, 0, -spec.handRoll, 'YXZ');
  }

  private ensureLoaded(id: WeaponId): void {
    const entry = this.entries.get(id);
    if (!entry || entry.object || entry.loading || entry.failed) return;
    entry.loading = true;
    this.loader.load(
      entry.spec.url,
      (gltf) => {
        entry.loading = false;
        if (this.disposed) return;
        entry.object = this.prepare(gltf.scene, entry.spec);
        if (this.current === id) this.setCurrent(id);
      },
      undefined,
      () => {
        // A weapon the player cannot see still fires: the asset is cosmetic.
        entry.loading = false;
        entry.failed = true;
      },
    );
  }

  private ensureHands(): void {
    const spec = this.handsSpec;
    if (!spec || this.handsObject || this.handsLoading || this.handsFailed) return;
    this.handsLoading = true;
    this.loader.load(
      spec.url,
      (gltf) => {
        this.handsLoading = false;
        if (this.disposed) return;
        const prepared = this.prepareHands(gltf.scene, spec);
        this.handsObject = prepared;
        this.rightHand.add(prepared);
        // `clone` shares geometry and material; only the transform is new,
        // which is the whole point of mirroring one asset into two hands.
        this.leftHand.add(prepared.clone());
      },
      undefined,
      () => {
        // A weapon with no hands behind it is the old behaviour, not a crash.
        this.handsLoading = false;
        this.handsFailed = true;
      },
    );
  }

  /**
   * Rescales a normalised generated asset to real metres and re-origins it.
   *
   * Tripo returns a model normalised to 1.0 on its longest axis with a centre
   * pivot and its own node scaling, so the transform is measured rather than
   * trusted - exactly what `ModelLibrary` does for the street furniture.
   */
  private prepare(scene: Object3D, spec: ViewmodelSpec): Object3D {
    const holder = new Group();
    const inner = new Group();
    inner.add(scene);
    inner.rotation.set(spec.pitch, spec.yaw, spec.roll, 'YXZ');
    inner.updateMatrixWorld(true);

    const box = new Box3().setFromObject(inner);
    const size = box.getSize(new Vector3());
    const longest = Math.max(size.x, size.y, size.z, 1e-4);
    const scale = spec.length / longest;
    inner.scale.setScalar(scale);
    inner.updateMatrixWorld(true);

    // Re-measure after scaling and put the model's centre on the holder's
    // origin, so the offsets above mean the same thing for every weapon.
    const scaled = new Box3().setFromObject(inner);
    const centre = scaled.getCenter(new Vector3());
    inner.position.sub(centre);

    holder.add(inner);
    // The camera's basis has +Z backward, so a forward offset goes in negated.
    holder.position.set(spec.offset[0] ?? 0, spec.offset[1] ?? 0, -(spec.offset[2] ?? 0));
    this.dress(holder, spec.tint);
    this.weaponSlot.position.set(0, 0, 0);
    return holder;
  }

  /**
   * The same normalisation for the hands, but re-origined on the GRIP.
   *
   * `pivot` is measured by eye from the rendered asset and applied after the
   * bounding-box centring, because "the point where the fingers close" is not
   * a thing a bounding box knows about.
   */
  private prepareHands(scene: Object3D, spec: HandsSpec): Object3D {
    const holder = new Group();
    const inner = new Group();
    inner.add(scene);
    // XYZ, so the spin about the forearm happens before the forearm is laid
    // forward. See `HandsSpec`.
    inner.rotation.set(spec.pitch, spec.yaw, spec.roll, 'XYZ');
    inner.updateMatrixWorld(true);

    const box = new Box3().setFromObject(inner);
    const size = box.getSize(new Vector3());
    const longest = Math.max(size.x, size.y, size.z, 1e-4);
    inner.scale.setScalar(spec.length / longest);
    inner.updateMatrixWorld(true);

    const scaled = new Box3().setFromObject(inner);
    this.offset.copy(scaled.getCenter(new Vector3()));
    inner.position.sub(this.offset);
    inner.position.x -= spec.pivot[0] ?? 0;
    inner.position.y -= spec.pivot[1] ?? 0;
    inner.position.z -= spec.pivot[2] ?? 0;

    holder.add(inner);
    this.dress(holder, spec.tint, true, spec.envIntensity);
    return holder;
  }

  /** Shared material and shadow policy for anything held in front of the eye. */
  private dress(
    root: Object3D,
    tint: number | undefined,
    mirrored = false,
    envIntensity?: number,
  ): void {
    root.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      // Held a hand's width from the eye: it lights itself from the
      // environment and casts nothing, because a shadow cast by a pair of arms
      // with no body behind them is the thing that gives the trick away.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      const material = mesh.material as Material | Material[];
      const list = Array.isArray(material) ? material : [material];
      for (const item of list) {
        if (tint !== undefined) {
          const tinted = item as Material & { color?: Color };
          tinted.color?.setHex(tint).convertSRGBToLinear();
        }
        if (envIntensity !== undefined) {
          const lit = item as Material & { envMapIntensity?: number };
          if (lit.envMapIntensity !== undefined) lit.envMapIntensity = envIntensity;
        }
        // The left hand is the right hand through a mirror, which reverses
        // triangle winding; culling the back faces would hollow it out.
        if (mirrored) item.side = DoubleSide;
        this.disposables.push(item);
      }
      if (mesh.geometry) this.disposables.push(mesh.geometry);
    });
  }
}
