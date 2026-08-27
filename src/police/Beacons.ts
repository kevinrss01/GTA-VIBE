/**
 * The flashing bar on a pursuit car.
 *
 * NO POINT LIGHTS. A beacon here is an unlit box whose colour is driven
 * directly, so it reads as a lamp that is on without costing a light: the
 * measured profile for this project puts point lights at 61 per cent of the
 * frame, and a five-car pursuit would have wanted ten of them.
 *
 * The whole response shares ONE `InstancedMesh` - two lenses per car, hidden
 * entirely when nothing is being chased - so the beacons are one draw call
 * during a pursuit and zero the rest of the time.
 *
 * The authored patrol shell already carries an unlit bar, and the generated
 * patrol body carries its own; these lenses sit just above whichever is there,
 * which is why they are positioned from the vehicle's bounding box rather than
 * from a blueprint that may not be what is drawn.
 */

import { BoxGeometry, Color, InstancedMesh, MeshBasicMaterial, Object3D } from 'three';

/** Flashes per second, per side. Two sides alternate. */
const FLASH_HZ = 2.4;

/** Lens size: across the car, tall, along the car. */
const LENS_X = 0.3;
const LENS_Y = 0.07;
const LENS_Z = 0.12;

/** How far above the roof the bar sits. */
const ROOF_CLEARANCE = 0.055;

const RED = new Color(0xff2a24).convertSRGBToLinear();
const BLUE = new Color(0x2c6bff).convertSRGBToLinear();
/** A lens that is off is not black - it is a dark tinted glass. */
const OFF_MIX = 0.11;

export interface BeaconPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  /** Half the vehicle's height; the roof is `y + halfHeight`. */
  readonly halfHeight: number;
  readonly halfWidth: number;
  /** False for a wrecked unit, whose bar goes dark. */
  readonly lit: boolean;
}

export class Beacons {
  private readonly mesh: InstancedMesh;
  private readonly dummy = new Object3D();
  private readonly colour = new Color();
  private disposed = false;

  constructor(maxUnits: number) {
    const geometry = new BoxGeometry(LENS_X, LENS_Y, LENS_Z);
    const material = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    material.name = 'police-beacon';
    this.mesh = new InstancedMesh(geometry, material, Math.max(2, maxUnits * 2));
    this.mesh.name = 'police-beacons';
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  get object(): Object3D {
    return this.mesh;
  }

  /** Writes one pair of lenses per unit. `time` is the shared world clock. */
  write(poses: readonly BeaconPose[], time: number): void {
    if (this.disposed) return;
    const capacity = this.mesh.instanceMatrix.count;
    let n = 0;
    // A square wave rather than a sine: a real beacon is on or off, and a
    // smooth fade reads as a pulsing ornament instead of a warning.
    const phase = (time * FLASH_HZ) % 1;
    const redOn = phase < 0.25 || (phase >= 0.5 && phase < 0.62);
    const blueOn = (phase >= 0.25 && phase < 0.5) || phase >= 0.75;

    for (const pose of poses) {
      if (n + 2 > capacity) break;
      const roofY = pose.y + pose.halfHeight + ROOF_CLEARANCE;
      // The car's right-hand axis: forward is (-sin yaw, 0, -cos yaw).
      const rx = Math.cos(pose.yaw);
      const rz = -Math.sin(pose.yaw);
      const offset = Math.min(0.34, pose.halfWidth * 0.42);

      for (const side of [1, -1] as const) {
        this.dummy.position.set(pose.x + rx * offset * side, roofY, pose.z + rz * offset * side);
        this.dummy.rotation.set(0, pose.yaw, 0);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(n, this.dummy.matrix);
        const base = side > 0 ? RED : BLUE;
        const on = pose.lit && (side > 0 ? redOn : blueOn);
        this.colour.copy(base).multiplyScalar(on ? 1 : OFF_MIX);
        this.mesh.setColorAt(n, this.colour);
        n += 1;
      }
    }

    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.mesh.dispose();
  }
}
