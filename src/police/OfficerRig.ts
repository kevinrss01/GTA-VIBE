/**
 * Officers on foot: a real uniformed character, drawn in one instanced call.
 *
 * WHAT CHANGED AND WHY. Officers used to borrow the crowd's PROCEDURAL rig -
 * boxes and cylinders posed by arithmetic - with a navy palette written into
 * its clothing slots. That was the right call while the only generated people
 * in the project were civilians: the baked characters carry their outfit in
 * the albedo with no per-garment mask, so tinting one navy produces a civilian
 * with a dark FACE, not an officer in uniform. It stopped being the right call
 * the moment a uniformed character existed, because no arrangement of six
 * boxes reads as a police officer at ten metres.
 *
 * So `ped-police` is now a first-class member of the same generated cast as
 * the crowd: Tripo-generated in a T-pose, auto-rigged on the anatomical v1.0
 * skeleton, retargeted to walk and idle, and baked to a vertex animation
 * texture by `tools/bake-pedestrian-vat.mjs`. It is loaded with the crowd's
 * own `loadPedestrianVat` and drawn with the crowd's own
 * `createPedestrianVatMesh`, which means it shares their compiled program
 * (`customProgramCacheKey` is a constant) and adds no new material, no new
 * shader and no new walk cycle to keep in step.
 *
 * COST. One colour draw call and one shadow draw call for every officer in the
 * city, at 2 964 triangles per officer, and the mesh is hidden entirely while
 * nobody is wanted - so an unwanted player pays nothing at all. That is the
 * same shape the procedural rig had; what changed is the triangle count per
 * officer, 560 -> 2 964, and the 1.9 MB the character downloads once.
 *
 * IT DEGRADES. The download is asynchronous and may fail. Until it lands - and
 * for good if it never does - the procedural rig is still here and still
 * drawn, so a missing asset costs realism and never an empty street. Both
 * meshes live in the group from construction so `main.ts`'s compile pass
 * behind the loading screen sees both.
 *
 * WHY THE FEET DO NOT SLIDE. The walk cycle is driven by the distance an
 * officer has actually covered, inverted through the bake's measured travel
 * curve, exactly as the crowd does it - never by a clock. The accumulator is
 * in RIG UNITS, which means metres divided by GIRTH and not by height: the
 * instance matrix scales an officer horizontally by girth, so that is what a
 * stride of 1.61 rig units lands on the ground as.
 */


import { SHAPE_HAT, packColor } from '../agents/appearance';
import { gaitCadence, hipAmplitude } from '../agents/gait';
import {
  createProcPedestrianMesh,
  type ProcPedestrianMeshBundle,
} from '../agents/PedestrianProcRig';
import { createPedestrianVatMesh, type PedestrianVatBundle } from '../agents/PedestrianRig';
import { loadPedestrianVat, type PedestrianVatCharacter } from '../agents/PedestrianVat';
import {
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type Material,
  type Mesh,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { clamp, damp } from '../core/mathx';
import { hash2 } from '../core/rng';
import { stanceFor, type OfficerStance } from './locomotion';
import { OFFICER_RUN_SPEED } from './policy';

/** The baked character officers are drawn as. */
export const OFFICER_VAT_ID = 'ped-police';

/**
 * Which material slot the officer mesh names itself after.
 *
 * The crowd owns 0..3. This is only ever used in a debug name; the program
 * itself is shared with the crowd through `customProgramCacheKey`.
 */
const OFFICER_VAT_SLOT = 4;

/**
 * Fallback uniform colours, packed the way the crowd shader unpacks them.
 *
 * Only reachable while the baked character has not loaded. Kept because a
 * navy-boxes officer is a far better failure than no officer.
 */
const TUNIC = packColor(0x1d2739);
const TROUSERS = packColor(0x212734);
const BOOTS = packColor(0x111317);
const CAP = packColor(0x161c28);
const HAIR = packColor(0x1b1712);
const SKIN: readonly number[] = [0x8d5524, 0xa9683b, 0xc68642, 0xd9a066, 0xefc9a3, 0x6b4226];

/**
 * The sidearm an officer holds while they are firing.
 *
 * Drawn as its own small `InstancedMesh` - one draw call for every officer in
 * the city, and hidden entirely while nobody is aiming - rather than being
 * baked into the character, because a VAT is a fixed mesh: a weapon inside it
 * would be in the officer's hand while they were walking, standing, and lying
 * down, and could never be dropped, holstered or shot out of their grip.
 *
 * Where it goes comes from the bake's own measurement of the right hand
 * (`VatClip.handAt`), so it follows the hand that is holding it instead of
 * being pinned to an offset somebody guessed.
 */
const WEAPON_URL = 'models/shop/pistol.glb';
/** Real length of that model along its barrel, in metres. */
const WEAPON_LENGTH = 0.21;
/**
 * How far in front of the hand the weapon's centre sits, along the officer's
 * own forward axis, in metres.
 *
 * MEASURED, and larger than it looks like it should be. Tripo's biped library
 * has exactly one shooting preset and it is a CROUCHED stance with the weapon
 * hand drawn in to the chest - the baked right hand sits at the sternum, 0.027
 * body-heights in front of the body's own centre line, with the elbow outboard
 * of it. That is a real firing position (it is where a long weapon's grip hand
 * goes, and where a pistol goes in a close-quarters compressed ready) but it
 * means a weapon drawn AT the hand is inside the officer's chest. The torso
 * front at that height is about 0.12 body-heights out, so the weapon is pushed
 * clear of it and reads as being held in front of the chest.
 */
const WEAPON_REACH = 0.22;
/** Above this blend the officer is in the firing stance rather than carrying. */
const WEAPON_SHOWN = 0.35;

/**
 * Where the right hand sits when the bake has not loaded, in rig units.
 *
 * The mean of the `shoot` clip's measured hand track in
 * `public/models/pedestrians/ped-police.json`: (0.087, 0.467, -0.009), x
 * across, y up as a fraction of body height, z forward-negative. It exists so
 * that a MUZZLE POSITION is available on every code path - including the
 * headless tests and the procedural fallback - rather than only once a 1.9 MB
 * download has landed. A shot that has no weapon to come out of is exactly the
 * defect this is here to prevent.
 */
const HAND_FALLBACK_X = 0.087;
const HAND_FALLBACK_Y = 0.467;
const HAND_FALLBACK_Z = -0.009;

/**
 * The world transform of an officer's weapon muzzle.
 *
 * THE ONE AUTHORITY. The damage ray, the line-of-sight test, the muzzle flash,
 * the tracer and the audio position all read this, so a round cannot appear to
 * come from anywhere except the thing the player can see in the officer's
 * hand. Before this existed the tracer left the body centre 1.38 m up while
 * the drawn weapon was 0.84 m up and 0.3 m further forward, which is what
 * "fires without visibly handling a weapon" looked like.
 */
export interface MuzzleTransform {
  /** Muzzle tip, in world metres. */
  x: number;
  y: number;
  z: number;
  /** Unit horizontal direction the barrel points, world. */
  dirX: number;
  dirZ: number;
}

/** Comfortable walking speed used to pick a cadence. */
const PREFERRED_SPEED = 1.5;
const BASE_CADENCE = 0.98;

/**
 * A teleport is not a step.
 *
 * An officer is repositioned outright when they get out of a car, so the
 * distance accumulator has to reject a jump the same way the crowd rejects a
 * respawn - otherwise one dismount spins the legs through several strides.
 */
const MAX_STEP_SQUARED = 2.25;

/**
 * How a shot officer goes down, in seconds from the round landing.
 *
 * The same numbers the CROWD uses for the civilians it lays in the road - see
 * `FALL_TIME` in `src/agents/crowd.ts` - deliberately duplicated rather than
 * imported, because `src/agents` belongs to another workstream and a body in
 * the street has to read as one game whoever it was. If the crowd's fall is
 * ever retuned, retune this with it.
 */
export const FALL_TIME = 0.34;

/**
 * How far a toppled body is lifted so it does not sink into the pavement.
 *
 * A body pivoting about its feet has its front-back axis lying along the
 * vertical, so half its thickness - about 0.12 of a rig unit, and the rig is
 * authored one unit tall - would be under the ground. Matches
 * `PedestrianSystem`'s `DOWN_LIFT` for the same reason as `FALL_TIME`.
 */
const DOWN_LIFT = 0.12;

export interface OfficerPose {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  height: number;
  girth: number;
  /** Walk cycle position, 0..1. Owned by the rig; seed it once and leave it. */
  phase: number;
  /** Standing-to-walking blend, 0..1. Owned by the rig. */
  gait: number;
  /**
   * Which locomotion clip is playing. Owned by the rig.
   *
   * Chosen from the MEASURED speed with hysteresis, so the boundary between
   * standing, walking and running is a band and not a threshold: an officer
   * decelerating through it cannot flicker between two clips.
   */
  stance: OfficerStance;
  /** Per-officer variation seed, so two officers are not identical. */
  variant: number;
  /** Distance covered in rig units. Drives the baked clip. Owned by the rig. */
  walked: number;
  /** Previous position, so the REALISED displacement is what advances the clip. */
  lastX: number;
  lastZ: number;
  /**
   * How far into the firing stance this officer is, 0..1. Owned by the caller.
   *
   * Blended over the gait rather than replacing it, so an officer bringing
   * their weapon up while still moving reads as one person doing two things
   * and not as a pose snapping on.
   */
  aiming: number;
  /**
   * The sidearm is out of the holster and in the hand. Owned by the caller.
   *
   * Separate from `aiming` because carrying and aiming are different things:
   * an officer runs with the weapon in their hand at their side long before
   * they stop and bring it up, and the model has to be drawn for both. It is
   * also what makes a DRAW visible - for the length of the draw the hands move
   * and there is nothing in them yet.
   */
  armed: boolean;
  /**
   * True once this officer has been put on the ground. Owned by the caller.
   *
   * Everything about DRAWING a body is this flag and the two fields under it:
   * `tilt` folds them into the same instance matrix that already carries the
   * heading and the build, so a body costs the police exactly nothing extra -
   * no second mesh, no second material, no extra draw call. It is the crowd's
   * knock-down renderer, applied to the people who wear uniforms.
   */
  down: boolean;
  /** Seconds since they went down. Drives the topple. Owned by the caller. */
  downFor: number;
  /** Which way they topple: +1 over backwards, -1 onto their face. */
  fallSign: number;
}

/** Fresh appearance for one officer, deterministic in `seed`. */
export function makeOfficer(seed: number): {
  height: number;
  girth: number;
  variant: number;
} {
  const a = hash2(seed, 11, 3);
  const b = hash2(seed, 29, 5);
  return {
    height: 1.68 + a * 0.2,
    girth: 0.95 + b * 0.2,
    variant: seed,
  };
}

export class OfficerRig {
  private readonly proc: ProcPedestrianMeshBundle;
  private readonly vat: PedestrianVatBundle;
  private character: PedestrianVatCharacter | null = null;
  private weapon: InstancedMesh | null = null;
  private readonly weaponHolder = new Group();
  private weaponRequested = false;
  private disposed = false;

  private readonly hand = { x: 0, y: 0, z: 0 };
  private readonly muzzle: MuzzleTransform = { x: 0, y: 0, z: 0, dirX: 0, dirZ: -1 };
  private readonly weaponMatrix = new Matrix4();
  private readonly weaponPosition = new Vector3();
  private readonly weaponRotation = new Quaternion();
  private readonly weaponScale = new Vector3(1, 1, 1);
  private readonly weaponAxis = new Vector3(0, 1, 0);

  /**
   * `load` defaults to "only where a browser can resolve a relative URL".
   *
   * `loadPedestrianVat` fetches `models/pedestrians/...` against the document
   * base and finishes with a `TextureLoader`, neither of which exists under
   * the unit tests' bare Node environment - it would fail, correctly, on every
   * construction and print a warning per test. Skipping it there keeps the
   * deterministic suite silent and exercises the procedural fallback, which is
   * the branch a headless run should be exercising anyway.
   */
  constructor(capacity: number, castShadows: boolean, load = typeof document !== 'undefined') {
    this.proc = createProcPedestrianMesh(capacity);
    this.proc.mesh.name = 'police-officers-proc';
    this.proc.mesh.castShadow = castShadows;
    this.proc.mesh.count = 0;
    this.proc.mesh.visible = false;

    this.vat = createPedestrianVatMesh(capacity, OFFICER_VAT_SLOT);
    this.vat.mesh.name = 'police-officers';
    this.vat.mesh.castShadow = castShadows;
    this.vat.mesh.count = 0;
    this.vat.mesh.visible = false;

    this.weaponHolder.name = 'police-sidearms';
    if (load) {
      void this.load();
      this.loadWeapon();
    }
  }

  /**
   * Downloads the sidearm and builds its instanced mesh.
   *
   * Failure is silent and survivable: officers then fire with empty hands,
   * which is what they did before this existed, and nothing else changes.
   */
  private loadWeapon(baseUrl = ''): void {
    if (this.weaponRequested || this.disposed) return;
    this.weaponRequested = true;
    new GLTFLoader().load(
      `${baseUrl}${WEAPON_URL}`,
      (gltf) => {
        if (this.disposed) return;
        let source: Mesh | null = null;
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((child: Object3D) => {
          const mesh = child as Mesh;
          if (!source && mesh.isMesh && mesh.geometry) source = mesh;
        });
        const found = source as Mesh | null;
        if (!found) return;
        const geometry = found.geometry.clone();
        geometry.applyMatrix4(found.matrixWorld);
        // The model arrives normalised into a unit box with a centre pivot,
        // like every Tripo asset. Scaling by the real length here means the
        // per-instance matrix only has to carry position and rotation.
        geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        const longest = box
          ? Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
          : 1;
        geometry.scale(
          WEAPON_LENGTH / longest,
          WEAPON_LENGTH / longest,
          WEAPON_LENGTH / longest,
        );
        const material = Array.isArray(found.material)
          ? (found.material[0] as Material)
          : (found.material as Material);
        const mesh = new InstancedMesh(geometry, material, this.vat.mesh.instanceMatrix.count);
        mesh.name = 'police-sidearm';
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        mesh.count = 0;
        mesh.visible = false;
        this.weapon = mesh;
        this.weaponHolder.add(mesh);
      },
      undefined,
      () => {
        /* An officer with empty hands is a small loss; a crash is not. */
      },
    );
  }

  /** Every mesh. Add all of them to the scene; only the right ones draw. */
  get meshes(): readonly Object3D[] {
    return [this.vat.mesh, this.proc.mesh, this.weaponHolder];
  }

  /** True once the officers' sidearm model is on screen. Diagnostics and QA. */
  get weaponReady(): boolean {
    return this.weapon !== null;
  }

  /** True once the baked officer is installed and being drawn. */
  get ready(): boolean {
    return this.character !== null;
  }

  /** Triangles one drawn officer costs, for the diagnostics overlay. */
  get trianglesPerOfficer(): number {
    return this.character?.triangles ?? 560;
  }

  setCastShadows(enabled: boolean): void {
    this.vat.mesh.castShadow = enabled;
    this.proc.mesh.castShadow = enabled;
  }

  /**
   * How far over a downed officer has toppled, in radians, and which way.
   *
   * Zero on their feet, `±PI/2` flat out, eased out because a falling body
   * accelerates and then stops dead on the ground. An officer never gets back
   * up - the only thing that puts one down here is being killed - so unlike
   * the crowd's version there is no rise to fold back in.
   */
  static tilt(pose: OfficerPose): number {
    if (!pose.down) return 0;
    const fall = clamp(pose.downFor / FALL_TIME, 0, 1);
    const amount = 1 - (1 - fall) * (1 - fall);
    return pose.fallSign * amount * Math.PI * 0.5;
  }

  /**
   * Advances one officer's walk cycle and distance accumulator.
   *
   * CALL THIS AFTER THE BODY HAS BEEN MOVED AND RESOLVED AGAINST THE WORLD.
   * Everything here is driven by the displacement that actually happened, so
   * calling it before the move would key the legs off last frame's position.
   */
  static advance(pose: OfficerPose, dt: number): void {
    // A body has no gait. Advancing one would walk the legs of a corpse.
    if (pose.down) return;

    // Projecting the realised displacement onto the heading is what stops a
    // sideways shove - sliding along a wall, say - from spinning the legs.
    // The clip runs BACKWARDS for a backward step rather than freezing, which
    // is what a person stepping back off a doorway actually does; freezing it
    // was itself a slide, because the body still moved.
    const dx = pose.x - pose.lastX;
    const dz = pose.z - pose.lastZ;
    pose.lastX = pose.x;
    pose.lastZ = pose.z;
    const jumped = dx * dx + dz * dz > MAX_STEP_SQUARED;
    if (!jumped) {
      const forward = -dx * Math.sin(pose.heading) - dz * Math.cos(pose.heading);
      pose.walked += forward / Math.max(0.4, pose.girth);
    }

    // The clip choice follows the MEASURED speed, not the requested one, and
    // through a hysteresis band so it cannot flicker at the boundary.
    pose.stance = stanceFor(pose.speed, pose.stance, OFFICER_RUN_SPEED);
    const cadence = gaitCadence(pose.speed, PREFERRED_SPEED, BASE_CADENCE, pose.height);
    pose.gait = damp(pose.gait, pose.stance === 'idle' ? 0 : 1, 6, dt);
    pose.phase = (pose.phase + cadence * dt * Math.max(pose.gait, 0.14)) % 1;
    if (pose.phase < 0) pose.phase += 1;
  }

  /**
   * Writes every officer into the live mesh's instance buffers.
   *
   * Officers are compacted to the front of the buffer, so `count` is simply
   * how many were written and a dead unit costs nothing. `time` drives the
   * idle clip, which has no travel to key off.
   */
  write(poses: readonly OfficerPose[], time: number): void {
    if (this.disposed) return;
    if (this.character) this.writeVat(poses, time, this.character);
    else this.writeProc(poses);
    // Outside both branches: the sidearm is its own mesh and has to be in the
    // hand whichever body mesh is live, or a failed character download would
    // silently disarm the whole force.
    this.writeWeapons(poses, time);
  }

  private writeVat(
    poses: readonly OfficerPose[],
    time: number,
    character: PedestrianVatCharacter,
  ): void {
    const mesh = this.vat.mesh;
    const matrices = mesh.instanceMatrix.array as Float32Array;
    const anim = this.vat.anim.array as Float32Array;
    const tint = this.vat.tint.array as Float32Array;

    let n = 0;
    for (const pose of poses) {
      if (n >= mesh.instanceMatrix.count) break;
      writeMatrix(matrices, n, pose);

      const a = n * 4;
      anim[a] = character.walk.phaseFor(pose.walked);
      const idle = character.idle;
      if (idle && idle.duration > 1e-3) {
        // Per-officer rate and offset, so a cordon does not breathe in unison.
        const rate = (0.9 + 0.2 * hash2(pose.variant, 17, 5)) / idle.duration;
        anim[a + 1] = (hash2(pose.height, pose.girth, 23) + time * rate) % 1;
      } else {
        anim[a + 1] = 0;
      }
      anim[a + 2] = pose.gait;
      anim[a + 3] = clamp(pose.aiming, 0, 1);

      // No tint. The uniform IS the albedo; multiplying it would be exactly
      // the mistake that kept officers procedural in the first place.
      tint[a] = 1;
      tint[a + 1] = 1;
      tint[a + 2] = 1;
      tint[a + 3] = 1;

      n += 1;
    }

    mesh.count = n;
    mesh.visible = n > 0;
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      this.vat.anim.needsUpdate = true;
      this.vat.tint.needsUpdate = true;
    }

    // Every officer firing at once is at the same point of the same one-second
    // pose, so the phase is a uniform rather than a per-instance float. It is
    // driven by the clock and not by anything an officer does, which is right
    // for a settled stance: what changes per officer is how far into it they
    // are, and that is the blend.
    const action = character.action;
    if (action && action.duration > 1e-3) {
      this.vat.setActionPhase((time / action.duration) % 1);
    }
  }

  /**
   * Where this officer's weapon sits, in world metres. The one authority.
   *
   * The hand's position comes from the bake, in rig units, and goes through
   * exactly the transform the instance matrix applies to the body: scale by
   * girth across and height up, yaw by heading, translate to the officer. Do
   * this any other way and the weapon drifts out of the hand the moment an
   * officer is taller or wider than average.
   *
   * Which hand track is read depends on what the officer is DOING: the firing
   * pose once the stance is up, the walk clip at the officer's own gait phase
   * while they are merely carrying it, so a running officer's pistol swings
   * with the arm that is holding it. Both are the same track the body is being
   * drawn from on this frame.
   *
   * `out.x/y/z` is the muzzle TIP, half a weapon length past the grip, which
   * is where a round leaves and where a flash belongs.
   */
  muzzleOf(pose: OfficerPose, time: number, out: MuzzleTransform): void {
    const c = Math.cos(pose.heading);
    const s = Math.sin(pose.heading);
    const width = pose.girth;
    const hand = this.hand;
    if (!this.handTrack(pose, time, hand)) {
      hand.x = HAND_FALLBACK_X;
      hand.y = HAND_FALLBACK_Y;
      hand.z = HAND_FALLBACK_Z;
    }

    // The body's own instance transform, applied to one point.
    const handX = pose.x + width * (c * hand.x + s * hand.z);
    const handY = pose.y + pose.height * hand.y;
    const handZ = pose.z + width * (-s * hand.x + c * hand.z);

    // Along the officer's heading, which is where they are shooting: the
    // forearm-to-hand vector would point the barrel wherever the retargeted
    // clip happens to leave the wrist, and this pose is a two-handed hold
    // with the weapon across the body rather than an extended arm.
    const forwardX = -s;
    const forwardZ = -c;
    const reach = WEAPON_REACH + WEAPON_LENGTH * 0.5;
    out.x = handX + forwardX * reach;
    out.y = handY;
    out.z = handZ + forwardZ * reach;
    out.dirX = forwardX;
    out.dirZ = forwardZ;
  }

  /**
   * The hand position for the clip this officer is currently being drawn with.
   *
   * False when the bake has not landed or carries no hand track, which is the
   * caller's cue to fall back to the measured constant.
   */
  private handTrack(
    pose: OfficerPose,
    time: number,
    out: { x: number; y: number; z: number },
  ): boolean {
    const character = this.character;
    if (!character) return false;
    const action = character.action;
    if (pose.aiming >= WEAPON_SHOWN && action) {
      const phase = action.duration > 1e-3 ? (time / action.duration) % 1 : 0;
      return action.handAt(phase, out);
    }
    // Carrying: the walk clip at the officer's own distance-driven phase, so
    // the weapon is where the swinging hand is and not where a clock says.
    const walk = character.walk;
    if (pose.stance === 'idle' && character.idle) {
      const idle = character.idle;
      const phase = idle.duration > 1e-3 ? (time / idle.duration) % 1 : 0;
      return idle.handAt(phase, out);
    }
    return walk.handAt(walk.phaseFor(pose.walked), out);
  }

  /**
   * Puts a sidearm in the hand of every officer who has one out.
   *
   * Drawn whenever the weapon is in the hand at all, not only while it is
   * raised: an officer who has drawn and is running with it has to be holding
   * something, or the draw the player just watched produced nothing.
   */
  private writeWeapons(poses: readonly OfficerPose[], time: number): void {
    const weapon = this.weapon;
    if (!weapon) return;
    const matrices = weapon.instanceMatrix.array as Float32Array;
    let drawn = 0;

    for (const pose of poses) {
      if (drawn >= weapon.instanceMatrix.count) break;
      if (!pose.armed || pose.down) continue;
      this.muzzleOf(pose, time, this.muzzle);
      // Back off from the tip to the model's own centre, which is what the
      // instance matrix positions.
      this.weaponPosition.set(
        this.muzzle.x - this.muzzle.dirX * WEAPON_LENGTH * 0.5,
        this.muzzle.y,
        this.muzzle.z - this.muzzle.dirZ * WEAPON_LENGTH * 0.5,
      );
      // The model's barrel lies along its own +Z, so a half turn plus the
      // officer's heading puts it down the officer's forward axis.
      this.weaponRotation.setFromAxisAngle(this.weaponAxis, pose.heading + Math.PI);
      this.weaponMatrix.compose(this.weaponPosition, this.weaponRotation, this.weaponScale);
      this.weaponMatrix.toArray(matrices, drawn * 16);
      drawn += 1;
    }

    weapon.count = drawn;
    weapon.visible = drawn > 0;
    if (drawn > 0) weapon.instanceMatrix.needsUpdate = true;
  }

  private writeProc(poses: readonly OfficerPose[]): void {
    const mesh = this.proc.mesh;
    const matrices = mesh.instanceMatrix.array as Float32Array;
    const anim = this.proc.anim.array as Float32Array;
    const anim2 = this.proc.anim2.array as Float32Array;
    const colors = this.proc.colors.array as Float32Array;
    const extra = this.proc.extra.array as Float32Array;

    let n = 0;
    for (const pose of poses) {
      if (n >= mesh.instanceMatrix.count) break;
      writeMatrix(matrices, n, pose);

      const cadence = gaitCadence(pose.speed, PREFERRED_SPEED, BASE_CADENCE, pose.height);
      const amp = hipAmplitude(pose.speed, cadence, pose.height) * pose.gait;
      const a = n * 4;
      anim[a] = pose.phase;
      anim[a + 1] = amp;
      // A running officer swings their arms harder than a strolling civilian.
      anim[a + 2] = amp * 0.95;
      anim[a + 3] = pose.gait;

      anim2[a] = 0.006;
      anim2[a + 1] = clamp(pose.speed * 0.018, 0, 0.09);
      anim2[a + 2] = 0.05;
      anim2[a + 3] = SHAPE_HAT;

      const skin = SKIN[Math.floor(hash2(pose.variant, 7, 13) * SKIN.length)] ?? SKIN[0] ?? 0xc68642;
      colors[a] = TUNIC;
      colors[a + 1] = TROUSERS;
      colors[a + 2] = packColor(skin);
      colors[a + 3] = HAIR;

      extra[a] = CAP;
      extra[a + 1] = BOOTS;
      // FULLY OPAQUE, and it must never be zero. `iExtra.z` is the crowd's
      // dissolve, and the procedural shader discards a fragment whenever the
      // stipple noise exceeds it - so a zero here discards every pixel and the
      // officer is invisible while still shooting and still arresting. The
      // police own their officers outright and never spawn or retire one in
      // view, so they have no dissolve to run: they are always solid.
      extra[a + 2] = 1;
      extra[a + 3] = 0;

      n += 1;
    }

    mesh.count = n;
    mesh.visible = n > 0;
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      this.proc.anim.needsUpdate = true;
      this.proc.anim2.needsUpdate = true;
      this.proc.colors.needsUpdate = true;
      this.proc.extra.needsUpdate = true;
    }
  }

  /**
   * Downloads and installs the baked officer.
   *
   * `loadPedestrianVat` already returns null rather than throwing on any
   * failure, so there is nothing to catch: a null simply leaves the procedural
   * rig in charge for the rest of the session.
   */
  private async load(): Promise<void> {
    const character = await loadPedestrianVat(OFFICER_VAT_ID);
    if (this.disposed) {
      character?.dispose();
      return;
    }
    if (!character) return;
    this.vat.install(character);
    this.character = character;
    // The procedural stand-in is retired the frame the real one arrives.
    this.proc.mesh.count = 0;
    this.proc.mesh.visible = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.proc.dispose();
    this.vat.dispose();
    this.character?.dispose();
    this.character = null;
    if (this.weapon) {
      this.weapon.geometry.dispose();
      this.weapon.dispose();
      this.weapon = null;
    }
    this.weaponHolder.clear();
  }
}

/**
 * One officer's instance matrix: heading and girth across, height up.
 *
 * The same convention `PedestrianSystem.writeMatrix` uses, and it has to be:
 * the baked clip's stride is in rig units and the runtime converts it back to
 * metres with girth.
 */
function writeMatrix(matrices: Float32Array, n: number, pose: OfficerPose): void {
  const m = n * 16;
  const c = Math.cos(pose.heading);
  const s = Math.sin(pose.heading);
  const width = pose.girth;
  const height = pose.height;
  // `Ry(heading) * Rx(tilt) * scale(girth, height, girth)`, column-major.
  // `tilt` is zero for anybody on their feet, which collapses this back to the
  // yaw-and-scale form it used to be; for a body it is the topple. The slots a
  // tilt uses are written unconditionally, because an instance slot that held
  // a body last frame and a walking officer this one would keep the shear.
  const tilt = OfficerRig.tilt(pose);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  matrices[m] = c * width;
  matrices[m + 1] = 0;
  matrices[m + 2] = -s * width;
  matrices[m + 3] = 0;
  matrices[m + 4] = s * height * st;
  matrices[m + 5] = height * ct;
  matrices[m + 6] = c * height * st;
  matrices[m + 7] = 0;
  matrices[m + 8] = s * width * ct;
  matrices[m + 9] = -width * st;
  matrices[m + 10] = c * width * ct;
  matrices[m + 11] = 0;
  matrices[m + 12] = pose.x;
  matrices[m + 13] = pose.y + DOWN_LIFT * width * Math.abs(st);
  matrices[m + 14] = pose.z;
  matrices[m + 15] = 1;
}
