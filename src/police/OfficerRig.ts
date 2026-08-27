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

import type { Object3D } from 'three';

import { SHAPE_HAT, packColor } from '../agents/appearance';
import { gaitCadence, hipAmplitude } from '../agents/gait';
import {
  createProcPedestrianMesh,
  type ProcPedestrianMeshBundle,
} from '../agents/PedestrianProcRig';
import { createPedestrianVatMesh, type PedestrianVatBundle } from '../agents/PedestrianRig';
import { loadPedestrianVat, type PedestrianVatCharacter } from '../agents/PedestrianVat';
import { clamp, damp } from '../core/mathx';
import { hash2 } from '../core/rng';

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
  /** Per-officer variation seed, so two officers are not identical. */
  variant: number;
  /** Distance covered in rig units. Drives the baked clip. Owned by the rig. */
  walked: number;
  /** Previous position, so the REALISED displacement is what advances the clip. */
  lastX: number;
  lastZ: number;
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
  private disposed = false;

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

    if (load) void this.load();
  }

  /** Both meshes. Add every one of them to the scene; only one ever draws. */
  get meshes(): readonly Object3D[] {
    return [this.vat.mesh, this.proc.mesh];
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

  /** Advances one officer's walk cycle and distance accumulator. */
  static advance(pose: OfficerPose, dt: number): void {
    const cadence = gaitCadence(pose.speed, PREFERRED_SPEED, BASE_CADENCE, pose.height);
    pose.gait = damp(pose.gait, pose.speed > 0.16 ? 1 : 0, 6, dt);
    pose.phase = (pose.phase + cadence * dt * Math.max(pose.gait, 0.14)) % 1;
    if (pose.phase < 0) pose.phase += 1;

    // Projecting the realised displacement onto the heading is what stops a
    // sideways shove - sliding along a wall, say - from spinning the legs.
    const dx = pose.x - pose.lastX;
    const dz = pose.z - pose.lastZ;
    pose.lastX = pose.x;
    pose.lastZ = pose.z;
    if (dx * dx + dz * dz > MAX_STEP_SQUARED) return;
    const forward = -dx * Math.sin(pose.heading) - dz * Math.cos(pose.heading);
    if (forward <= 0) return;
    pose.walked += forward / Math.max(0.4, pose.girth);
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
      anim[a + 3] = 0;

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
      extra[a + 2] = 0;
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
  matrices[m] = c * width;
  matrices[m + 1] = 0;
  matrices[m + 2] = -s * width;
  matrices[m + 3] = 0;
  matrices[m + 4] = 0;
  matrices[m + 5] = pose.height;
  matrices[m + 6] = 0;
  matrices[m + 7] = 0;
  matrices[m + 8] = s * width;
  matrices[m + 9] = 0;
  matrices[m + 10] = c * width;
  matrices[m + 11] = 0;
  matrices[m + 12] = pose.x;
  matrices[m + 13] = pose.y;
  matrices[m + 14] = pose.z;
  matrices[m + 15] = 1;
}
