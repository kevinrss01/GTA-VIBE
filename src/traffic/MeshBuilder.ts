/**
 * A small geometry builder that carries per-vertex surface data.
 *
 * Vehicles cannot use the shared `MaterialLibrary` the static city uses,
 * because a car needs several surfaces - paint, glazing, rubber, chrome, lit
 * lamps - inside a SINGLE draw call, and it needs the paint colour to differ
 * per instance while the glass and tyres do not. So instead of one material per
 * surface, every surface property travels on the vertex:
 *
 * - `aAlbedo` base colour, already converted to linear.
 * - `aSurf`   roughness and metalness.
 * - `aPaint`  1 where the vertex takes the instance's paint colour.
 * - `aEmit`   emissive colour, pre-multiplied by its intensity.
 * - `aChan`   which per-instance light channel gates that emission.
 * - `aTex`    1 where the vertex reads the material's maps instead of `aAlbedo`.
 *
 * `VehicleMaterial` reads all six. The result is one draw call per body shell
 * for the whole city, and one more for every wheel in it, which is what the
 * measured draw-call budget for this project can afford.
 *
 * `aTex` is what lets a generated Tripo body - one fused, textured mesh with
 * no separation between paint, glazing and lamps - share a draw call with the
 * few untextured emissive faces that keep the brake lights and headlamps
 * responding per instance. Textured vertices carry a real `uv`; the rest carry
 * a dummy one, and the shader mixes between the two sources rather than
 * needing a second material.
 *
 * CONVENTION: the vehicle is authored with its nose at -Z, +X to the driver's
 * right, and y = 0 on the ground contact plane, matching the yaw convention in
 * `types.ts` where forward is `(-sin yaw, 0, -cos yaw)`.
 */

import { BufferAttribute, BufferGeometry, Color } from 'three';

/** Per-instance channel that gates a vertex's emission. */
export const CHANNEL_CONSTANT = 0;
export const CHANNEL_BRAKE = 1;
export const CHANNEL_HEAD = 2;
export const CHANNEL_BEACON_A = 3;
export const CHANNEL_BEACON_B = 4;

export interface SurfaceStyle {
  /** Authored sRGB. Use white where `paint` is set; the tint multiplies it. */
  readonly albedo: number;
  readonly roughness: number;
  readonly metalness?: number;
  /** Takes the per-instance paint colour. */
  readonly paint?: boolean;
  readonly emissive?: number;
  readonly emissiveIntensity?: number;
  readonly channel?: number;
}

/** One cross-section of a lofted shell. `top` and `bottom` are absolute Y. */
export interface Station {
  readonly z: number;
  readonly halfWidth: number;
  readonly bottom: number;
  readonly top: number;
}

export interface LoftOptions {
  /** Section fullness above and below the section centre. */
  readonly fullnessTop: number;
  readonly fullnessBottom: number;
  readonly segments: number;
  readonly capStart?: SurfaceStyle | undefined;
  readonly capEnd?: SurfaceStyle | undefined;
}

export type LoftStyleFn = (
  station: number,
  angle: number,
  x: number,
  y: number,
  z: number,
) => SurfaceStyle;

const scratchColor = new Color();

function linear(hex: number): [number, number, number] {
  scratchColor.setHex(hex);
  scratchColor.convertSRGBToLinear();
  return [scratchColor.r, scratchColor.g, scratchColor.b];
}

/**
 * Point on a superelliptic cross-section.
 *
 * A car's body section is neither a box nor an ellipse: the sides are close to
 * flat with a rounded shoulder and a tucked-under sill. A superellipse with a
 * different exponent above and below the centreline gives exactly that from
 * two numbers, which is what makes the blueprint table short enough to read.
 */
function sectionPoint(
  angle: number,
  halfWidth: number,
  centreY: number,
  halfHeight: number,
  fullnessTop: number,
  fullnessBottom: number,
): { x: number; y: number } {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const power = s >= 0 ? fullnessTop : fullnessBottom;
  const e = 2 / power;
  const x = halfWidth * Math.sign(c) * Math.abs(c) ** e;
  const y = centreY + halfHeight * Math.sign(s) * Math.abs(s) ** e;
  return { x, y };
}

export class VehicleMeshBuilder {
  private readonly position: number[] = [];
  private readonly normal: number[] = [];
  private readonly albedo: number[] = [];
  private readonly surf: number[] = [];
  private readonly paint: number[] = [];
  private readonly emit: number[] = [];
  private readonly chan: number[] = [];
  private readonly uv: number[] = [];
  private readonly tex: number[] = [];
  private readonly index: number[] = [];

  get triangleCount(): number {
    return this.index.length / 3;
  }

  get vertexCount(): number {
    return this.position.length / 3;
  }

  private pushVertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    style: SurfaceStyle,
  ): number {
    const i = this.position.length / 3;
    this.position.push(x, y, z);
    this.normal.push(nx, ny, nz);
    const [r, g, b] = linear(style.albedo);
    this.albedo.push(r, g, b);
    this.surf.push(style.roughness, style.metalness ?? 0);
    this.paint.push(style.paint ? 1 : 0);
    if (style.emissive !== undefined) {
      const [er, eg, eb] = linear(style.emissive);
      const k = style.emissiveIntensity ?? 1;
      this.emit.push(er * k, eg * k, eb * k);
    } else {
      this.emit.push(0, 0, 0);
    }
    this.chan.push(style.channel ?? CHANNEL_CONSTANT);
    this.uv.push(0, 0);
    this.tex.push(0);
    return i;
  }

  /**
   * Appends an already-fitted external mesh - a generated body or wheel - as
   * textured geometry.
   *
   * The vertices come across unchanged: positions and normals are expected to
   * be in the vehicle's own frame already (see `VehicleModelFit`), and the
   * surface comes from the material's maps rather than from `style.albedo`.
   * `style` still supplies the fallback surface values and, crucially,
   * `paint`, which decides whether the instance tint is allowed to recolour
   * this mesh at all - a body generated with its own livery must not be
   * repainted per car.
   *
   * `lampMask` marks the vertices that take `lampStyle`'s emission and light
   * channel. It is how a fused generated body still has brake lights: the
   * loader finds the lamp lenses in the model's own texture and flags their
   * vertices, so the emission lands on the lens rather than on a face bolted
   * over the top of it.
   */
  appendTextured(
    position: ArrayLike<number>,
    normal: ArrayLike<number>,
    uv: ArrayLike<number> | null,
    index: ArrayLike<number>,
    style: SurfaceStyle,
    lampMask?: ArrayLike<number> | null,
    lampStyle?: SurfaceStyle,
  ): void {
    const base = this.position.length / 3;
    const count = Math.floor(position.length / 3);
    const [r, g, b] = linear(style.albedo);
    const lamp =
      lampMask && lampStyle && lampStyle.emissive !== undefined
        ? {
            mask: lampMask,
            emit: linear(lampStyle.emissive).map(
              (c) => c * (lampStyle.emissiveIntensity ?? 1),
            ) as [number, number, number],
            channel: lampStyle.channel ?? CHANNEL_CONSTANT,
          }
        : null;
    for (let i = 0; i < count; i += 1) {
      this.position.push(
        position[i * 3] ?? 0,
        position[i * 3 + 1] ?? 0,
        position[i * 3 + 2] ?? 0,
      );
      this.normal.push(normal[i * 3] ?? 0, normal[i * 3 + 1] ?? 1, normal[i * 3 + 2] ?? 0);
      this.albedo.push(r, g, b);
      this.surf.push(style.roughness, style.metalness ?? 0);
      this.paint.push(style.paint ? 1 : 0);
      if (lamp && (lamp.mask[i] ?? 0) > 0) {
        this.emit.push(lamp.emit[0], lamp.emit[1], lamp.emit[2]);
        this.chan.push(lamp.channel);
      } else {
        this.emit.push(0, 0, 0);
        this.chan.push(style.channel ?? CHANNEL_CONSTANT);
      }
      this.uv.push(uv ? (uv[i * 2] ?? 0) : 0, uv ? (uv[i * 2 + 1] ?? 0) : 0);
      this.tex.push(1);
    }
    for (let i = 0; i < index.length; i += 1) this.index.push(base + (index[i] ?? 0));
  }

  /**
   * Flat-shaded quad.
   *
   * `outward` is a hint at which way the face should look. Pass it for anything
   * whose winding is not obvious from the code - a decal laid on a curved
   * flank, a wheel arch, the inside of a load bed - because a quad wound the
   * wrong way is not subtly wrong, it is invisible, and an invisible livery
   * stripe looks exactly like a livery stripe that was never drawn.
   */
  quad(
    p0: readonly [number, number, number],
    p1: readonly [number, number, number],
    p2: readonly [number, number, number],
    p3: readonly [number, number, number],
    style: SurfaceStyle,
    outward?: readonly [number, number, number],
  ): void {
    const ux = p1[0] - p0[0];
    const uy = p1[1] - p0[1];
    const uz = p1[2] - p0[2];
    const vx = p3[0] - p0[0];
    const vy = p3[1] - p0[1];
    const vz = p3[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    const flip =
      outward !== undefined && nx * outward[0] + ny * outward[1] + nz * outward[2] < 0;
    if (flip) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }

    const a = this.pushVertex(p0[0], p0[1], p0[2], nx, ny, nz, style);
    const b = this.pushVertex(p1[0], p1[1], p1[2], nx, ny, nz, style);
    const c = this.pushVertex(p2[0], p2[1], p2[2], nx, ny, nz, style);
    const d = this.pushVertex(p3[0], p3[1], p3[2], nx, ny, nz, style);
    if (flip) this.index.push(a, d, c, a, c, b);
    else this.index.push(a, b, c, a, c, d);
  }

  /** Axis-aligned box, optionally yawed about its own centre. */
  box(
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    style: SurfaceStyle,
    yaw = 0,
  ): void {
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const at = (sx: number, sy: number, sz: number): [number, number, number] => {
      const x = sx * hx;
      const z = sz * hz;
      return [cx + x * cos + z * sin, cy + sy * hy, cz - x * sin + z * cos];
    };
    // +X, -X, +Y, -Y, +Z, -Z
    this.quad(at(1, -1, 1), at(1, -1, -1), at(1, 1, -1), at(1, 1, 1), style);
    this.quad(at(-1, -1, -1), at(-1, -1, 1), at(-1, 1, 1), at(-1, 1, -1), style);
    this.quad(at(-1, 1, 1), at(1, 1, 1), at(1, 1, -1), at(-1, 1, -1), style);
    this.quad(at(-1, -1, -1), at(1, -1, -1), at(1, -1, 1), at(-1, -1, 1), style);
    this.quad(at(-1, -1, 1), at(1, -1, 1), at(1, 1, 1), at(-1, 1, 1), style);
    this.quad(at(1, -1, -1), at(-1, -1, -1), at(-1, 1, -1), at(1, 1, -1), style);
  }

  /**
   * Box stretched between two points. Used for pillars, roof rails, mirror
   * stalks and light-bar mounts, which all want to follow a slope rather than
   * an axis.
   */
  strut(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    halfWidth: number,
    halfThickness: number,
    style: SurfaceStyle,
  ): void {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return;
    const fx = dx / len;
    const fy = dy / len;
    const fz = dz / len;
    // Side vector: perpendicular to the strut and as close to world X as possible.
    let sx = 1 - fx * fx;
    let sy = -fx * fy;
    let sz = -fx * fz;
    let sl = Math.hypot(sx, sy, sz);
    if (sl < 1e-4) {
      sx = 0;
      sy = 0;
      sz = 1;
      sl = 1;
    }
    sx /= sl;
    sy /= sl;
    sz /= sl;
    // Up vector completes the frame.
    const ux = fy * sz - fz * sy;
    const uy = fz * sx - fx * sz;
    const uz = fx * sy - fy * sx;

    const corner = (
      t: number,
      s: number,
      u: number,
    ): [number, number, number] => [
      ax + dx * t + sx * s * halfWidth + ux * u * halfThickness,
      ay + dy * t + sy * s * halfWidth + uy * u * halfThickness,
      az + dz * t + sz * s * halfWidth + uz * u * halfThickness,
    ];

    this.quad(corner(0, 1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(0, 1, 1), style);
    this.quad(corner(0, -1, 1), corner(1, -1, 1), corner(1, -1, -1), corner(0, -1, -1), style);
    this.quad(corner(0, -1, 1), corner(0, 1, 1), corner(1, 1, 1), corner(1, -1, 1), style);
    this.quad(corner(0, 1, -1), corner(0, -1, -1), corner(1, -1, -1), corner(1, 1, -1), style);
    this.quad(corner(1, -1, -1), corner(1, -1, 1), corner(1, 1, 1), corner(1, 1, -1), style);
    this.quad(corner(0, 1, -1), corner(0, 1, 1), corner(0, -1, 1), corner(0, -1, -1), style);
  }

  /**
   * Smooth-shaded lofted shell. The style callback runs per vertex, which is
   * how one loft can be glass down the sides and paint across the roof without
   * a second draw call or a seam.
   */
  loft(stations: readonly Station[], styleFor: LoftStyleFn, options: LoftOptions): void {
    if (stations.length < 2) return;
    const segments = options.segments;
    const start = this.position.length / 3;
    const rings: number[][] = [];

    for (let si = 0; si < stations.length; si += 1) {
      const station = stations[si] as Station;
      const centreY = (station.top + station.bottom) * 0.5;
      const halfHeight = (station.top - station.bottom) * 0.5;
      const ring: number[] = [];
      for (let j = 0; j < segments; j += 1) {
        const angle = (j / segments) * Math.PI * 2;
        const p = sectionPoint(
          angle,
          station.halfWidth,
          centreY,
          halfHeight,
          options.fullnessTop,
          options.fullnessBottom,
        );
        const style = styleFor(si, angle, p.x, p.y, station.z);
        ring.push(this.pushVertex(p.x, p.y, station.z, 0, 0, 0, style));
      }
      rings.push(ring);
    }

    // Winding is decided once, by testing the first quad's normal against the
    // outward direction of the section. Getting this wrong inverts the whole
    // shell, and it is not obvious in a wireframe.
    const flip = this.loftNeedsFlip(rings, stations, segments);
    for (let si = 0; si < rings.length - 1; si += 1) {
      const a = rings[si] as number[];
      const b = rings[si + 1] as number[];
      for (let j = 0; j < segments; j += 1) {
        const k = (j + 1) % segments;
        const i0 = a[j] as number;
        const i1 = a[k] as number;
        const i2 = b[k] as number;
        const i3 = b[j] as number;
        if (flip) this.index.push(i0, i2, i1, i0, i3, i2);
        else this.index.push(i0, i1, i2, i0, i2, i3);
      }
    }

    if (options.capStart) this.cap(stations[0] as Station, options, options.capStart, -1);
    if (options.capEnd) {
      this.cap(stations[stations.length - 1] as Station, options, options.capEnd, 1);
    }

    this.smoothRange(start, this.position.length / 3);
  }

  private loftNeedsFlip(
    rings: readonly number[][],
    stations: readonly Station[],
    segments: number,
  ): boolean {
    const a = rings[0] as number[];
    const b = rings[1] as number[];
    const i0 = a[0] as number;
    const i1 = a[1 % segments] as number;
    const i3 = b[0] as number;
    const p = (i: number): [number, number, number] => [
      this.position[i * 3] as number,
      this.position[i * 3 + 1] as number,
      this.position[i * 3 + 2] as number,
    ];
    const v0 = p(i0);
    const v1 = p(i1);
    const v3 = p(i3);
    const ux = v1[0] - v0[0];
    const uy = v1[1] - v0[1];
    const uz = v1[2] - v0[2];
    const vx = v3[0] - v0[0];
    const vy = v3[1] - v0[1];
    const vz = v3[2] - v0[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const s0 = stations[0] as Station;
    const centreY = (s0.top + s0.bottom) * 0.5;
    // Outward from the section centre at the sampled vertex.
    const ox = v0[0];
    const oy = v0[1] - centreY;
    return nx * ox + ny * oy < 0;
  }

  private cap(station: Station, options: LoftOptions, style: SurfaceStyle, facing: 1 | -1): void {
    const centreY = (station.top + station.bottom) * 0.5;
    const halfHeight = (station.top - station.bottom) * 0.5;
    if (station.halfWidth < 1e-4 || halfHeight < 1e-4) return;
    const centre = this.pushVertex(0, centreY, station.z, 0, 0, facing, style);
    const ring: number[] = [];
    for (let j = 0; j < options.segments; j += 1) {
      const angle = (j / options.segments) * Math.PI * 2;
      const p = sectionPoint(
        angle,
        station.halfWidth,
        centreY,
        halfHeight,
        options.fullnessTop,
        options.fullnessBottom,
      );
      ring.push(this.pushVertex(p.x, p.y, station.z, 0, 0, facing, style));
    }
    for (let j = 0; j < options.segments; j += 1) {
      const k = (j + 1) % options.segments;
      const i1 = ring[j] as number;
      const i2 = ring[k] as number;
      if (facing > 0) this.index.push(centre, i1, i2);
      else this.index.push(centre, i2, i1);
    }
  }

  /** Replaces the normals in a vertex range with area-weighted smooth normals. */
  private smoothRange(from: number, to: number): void {
    for (let i = from; i < to; i += 1) {
      this.normal[i * 3] = 0;
      this.normal[i * 3 + 1] = 0;
      this.normal[i * 3 + 2] = 0;
    }
    for (let t = 0; t < this.index.length; t += 3) {
      const a = this.index[t] as number;
      if (a < from || a >= to) continue;
      const b = this.index[t + 1] as number;
      const c = this.index[t + 2] as number;
      const ax = this.position[a * 3] as number;
      const ay = this.position[a * 3 + 1] as number;
      const az = this.position[a * 3 + 2] as number;
      const ux = (this.position[b * 3] as number) - ax;
      const uy = (this.position[b * 3 + 1] as number) - ay;
      const uz = (this.position[b * 3 + 2] as number) - az;
      const vx = (this.position[c * 3] as number) - ax;
      const vy = (this.position[c * 3 + 1] as number) - ay;
      const vz = (this.position[c * 3 + 2] as number) - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const i of [a, b, c]) {
        this.normal[i * 3] = (this.normal[i * 3] as number) + nx;
        this.normal[i * 3 + 1] = (this.normal[i * 3 + 1] as number) + ny;
        this.normal[i * 3 + 2] = (this.normal[i * 3 + 2] as number) + nz;
      }
    }
    for (let i = from; i < to; i += 1) {
      const nx = this.normal[i * 3] as number;
      const ny = this.normal[i * 3 + 1] as number;
      const nz = this.normal[i * 3 + 2] as number;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-8) {
        this.normal[i * 3 + 1] = 1;
        continue;
      }
      this.normal[i * 3] = nx / len;
      this.normal[i * 3 + 1] = ny / len;
      this.normal[i * 3 + 2] = nz / len;
    }
  }

  /** Wheel-shaped cylinder: axle along X, radius in the YZ plane. */
  cylinderX(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    halfLength: number,
    segments: number,
    side: SurfaceStyle,
    face: SurfaceStyle,
  ): void {
    const start = this.position.length / 3;
    const outer: number[][] = [[], []];
    for (let j = 0; j < segments; j += 1) {
      const angle = (j / segments) * Math.PI * 2;
      const y = cy + Math.sin(angle) * radius;
      const z = cz + Math.cos(angle) * radius;
      (outer[0] as number[]).push(this.pushVertex(cx - halfLength, y, z, 0, 0, 0, side));
      (outer[1] as number[]).push(this.pushVertex(cx + halfLength, y, z, 0, 0, 0, side));
    }
    const left = outer[0] as number[];
    const right = outer[1] as number[];
    for (let j = 0; j < segments; j += 1) {
      const k = (j + 1) % segments;
      this.index.push(
        left[j] as number,
        right[j] as number,
        right[k] as number,
        left[j] as number,
        right[k] as number,
        left[k] as number,
      );
    }
    this.smoothRange(start, this.position.length / 3);

    for (const [x, facing] of [
      [cx - halfLength, -1],
      [cx + halfLength, 1],
    ] as const) {
      const centre = this.pushVertex(x, cy, cz, facing, 0, 0, face);
      const ring: number[] = [];
      for (let j = 0; j < segments; j += 1) {
        const angle = (j / segments) * Math.PI * 2;
        ring.push(
          this.pushVertex(
            x,
            cy + Math.sin(angle) * radius,
            cz + Math.cos(angle) * radius,
            facing,
            0,
            0,
            face,
          ),
        );
      }
      for (let j = 0; j < segments; j += 1) {
        const k = (j + 1) % segments;
        const i1 = ring[j] as number;
        const i2 = ring[k] as number;
        if (facing > 0) this.index.push(centre, i2, i1);
        else this.index.push(centre, i1, i2);
      }
    }
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.position), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(this.normal), 3));
    geometry.setAttribute('aAlbedo', new BufferAttribute(new Float32Array(this.albedo), 3));
    geometry.setAttribute('aSurf', new BufferAttribute(new Float32Array(this.surf), 2));
    geometry.setAttribute('aPaint', new BufferAttribute(new Float32Array(this.paint), 1));
    geometry.setAttribute('aEmit', new BufferAttribute(new Float32Array(this.emit), 3));
    geometry.setAttribute('aChan', new BufferAttribute(new Float32Array(this.chan), 1));
    geometry.setAttribute('aTex', new BufferAttribute(new Float32Array(this.tex), 1));
    // `uv` is only read where `aTex` is 1, but three requires the attribute to
    // exist for the whole geometry as soon as the material carries a map.
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    const count = this.position.length / 3;
    const index =
      count > 65535 ? new Uint32Array(this.index) : new Uint16Array(this.index);
    geometry.setIndex(new BufferAttribute(index, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}
