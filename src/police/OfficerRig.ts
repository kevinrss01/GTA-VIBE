/**
 * Officers on foot, drawn with the crowd's own procedural character.
 *
 * `PedestrianProcRig` already solves this exact problem - a walking human in
 * one instanced draw call, with a shader-side rig whose planted foot does not
 * slide - and it is a public factory. Building a second humanoid for the police
 * would mean a second geometry, a second material, a second shader program and
 * a second walk cycle that could drift out of step with the crowd's. This
 * reuses it: one `InstancedMesh` for every officer in the city, one colour draw
 * plus one shadow draw, and the same gait arithmetic the pavement uses.
 *
 * COST. Ten officers at 560 triangles each is 5 600 triangles and 2 draw calls,
 * and the mesh is hidden entirely while nobody is wanted, so an unwanted player
 * pays nothing at all.
 *
 * The uniform is a navy tunic, navy trousers, black boots and a cap, which is
 * an invented livery for an invented city; it matches the patrol cars' own
 * original mark rather than any real force.
 */

import type { Object3D } from 'three';

import { SHAPE_HAT, packColor } from '../agents/appearance';
import { gaitCadence, hipAmplitude } from '../agents/gait';
import {
  createProcPedestrianMesh,
  type ProcPedestrianMeshBundle,
} from '../agents/PedestrianProcRig';
import { clamp, damp } from '../core/mathx';
import { hash2 } from '../core/rng';

/** Uniform colours, packed the way the crowd shader unpacks them. */
const TUNIC = packColor(0x1d2739);
const TROUSERS = packColor(0x212734);
const BOOTS = packColor(0x111317);
/**
 * The cap.
 *
 * The crowd rig's accent zone is the hat, and only the hat, so this is what an
 * officer's cap is made of rather than a shoulder flash. Navy to match the
 * tunic: a gold cap read as a bandsman rather than a police officer.
 */
const CAP = packColor(0x161c28);
const HAIR = packColor(0x1b1712);
const SKIN: readonly number[] = [0x8d5524, 0xa9683b, 0xc68642, 0xd9a066, 0xefc9a3, 0x6b4226];

/** Comfortable walking speed used to pick a cadence. */
const PREFERRED_SPEED = 1.5;
const BASE_CADENCE = 0.98;

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
  private readonly bundle: ProcPedestrianMeshBundle;
  private disposed = false;

  constructor(capacity: number, castShadows: boolean) {
    this.bundle = createProcPedestrianMesh(capacity);
    this.bundle.mesh.name = 'police-officers';
    this.bundle.mesh.castShadow = castShadows;
    this.bundle.mesh.count = 0;
    this.bundle.mesh.visible = false;
  }

  get mesh(): Object3D {
    return this.bundle.mesh;
  }

  setCastShadows(enabled: boolean): void {
    this.bundle.mesh.castShadow = enabled;
  }

  /** Advances one officer's walk cycle. Mirrors `Crowd.advancePhase`. */
  static advance(pose: OfficerPose, dt: number): void {
    const cadence = gaitCadence(pose.speed, PREFERRED_SPEED, BASE_CADENCE, pose.height);
    pose.gait = damp(pose.gait, pose.speed > 0.16 ? 1 : 0, 6, dt);
    pose.phase = (pose.phase + cadence * dt * Math.max(pose.gait, 0.14)) % 1;
    if (pose.phase < 0) pose.phase += 1;
  }

  /**
   * Writes every officer into the instance buffers.
   *
   * Officers are compacted to the front of the buffer, so `count` is simply
   * how many were written and a dead unit costs nothing.
   */
  write(poses: readonly OfficerPose[]): void {
    if (this.disposed) return;
    const mesh = this.bundle.mesh;
    const matrices = mesh.instanceMatrix.array as Float32Array;
    const anim = this.bundle.anim.array as Float32Array;
    const anim2 = this.bundle.anim2.array as Float32Array;
    const colors = this.bundle.colors.array as Float32Array;
    const extra = this.bundle.extra.array as Float32Array;

    let n = 0;
    for (const pose of poses) {
      if (n >= mesh.instanceMatrix.count) break;
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
      this.bundle.anim.needsUpdate = true;
      this.bundle.anim2.needsUpdate = true;
      this.bundle.colors.needsUpdate = true;
      this.bundle.extra.needsUpdate = true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bundle.dispose();
  }
}
