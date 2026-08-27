/**
 * The procedural fallback crowd: one mesh, one material, two hundred people.
 *
 * THIS IS NO LONGER WHAT THE GAME NORMALLY DRAWS. `PedestrianRig.ts` draws
 * real Tripo-generated, rigged, animated characters through a vertex animation
 * texture. This module stays because those characters arrive over the network:
 * if `public/models/pedestrians/` is missing, slow or corrupt, the city still
 * has people in it rather than empty pavements. `PedestrianSystem` shows this
 * crowd from the first frame and swaps it out the moment the real characters
 * finish loading.
 *
 * WHY IT IS BUILT THIS WAY. The measured budget for this game says a draw call
 * costs about 13 microseconds and the frame is GPU-bound on pixel shading,
 * while triangles are effectively free. A `SkinnedMesh` per pedestrian would
 * cost one draw call each - 200 people would be 2.6 ms of pure submission,
 * a third of the whole frame - so the crowd is a single `InstancedMesh` and the
 * skinning happens in the vertex shader. Cost is 1 colour draw plus 1 shadow
 * draw for the entire population, whatever its size.
 *
 * THE RIG. The body is authored ONE UNIT TALL with the feet at y = 0 and the
 * face toward -Z, matching the project's yaw convention. Every vertex carries
 * `aRig = (limb, zone, part, spare)`. The shader rotates it by the limb's own
 * angle about a hard-coded pivot, so there is no bone texture and no per-frame
 * CPU skinning. The instance matrix then applies heading, height and build.
 *
 * WHY IT CANNOT T-POSE. The bind pose already has the arms down at the sides
 * and the legs together: it is a standing pose, not a rigging pose. If every
 * animation input were zero the crowd would stand still, correctly. There is no
 * clip to fail to load and no mixer to fall out of sync.
 *
 * WHY THE FEET DO NOT SLIDE. The stance leg's hip angle is the exact inverse
 * sine that holds the foot at a fixed point while the body advances, and the
 * amplitude is derived on the CPU from the distance actually travelled per
 * gait cycle. The pelvis is then lowered by the exact amount the planted foot
 * rises as the leg swings away from vertical, so contact is kept as well.
 *
 * PER-INSTANCE ATTRIBUTES (all `InstancedBufferAttribute`):
 *   iAnim   = (cycle 0..1, hip amplitude rad, arm amplitude rad, gait 0..1)
 *   iAnim2  = (extra dip, forward lean rad, shoulder roll rad, shape bits)
 *   iColors = packed sRGB (top, bottom, skin, hair)
 *   iExtra  = packed sRGB (accent, shoe), unused, unused
 * Four garment colours ride in one vec4 because an sRGB triple packs exactly
 * into a float's 24-bit mantissa; that keeps the attribute count to 11 of the
 * 16 WebGL guarantees.
 */

import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  RGBADepthPacking,
  SphereGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { GAIT_DUTY } from './gait';

// --- Rig proportions, as a fraction of total height. -------------------------
// Anthropometric: hip 0.52 H, knee 0.285 H, shoulder 0.82 H, elbow 0.655 H.
// Shoulder breadth works out at 2 * (ARM_X + shoulder ball) = 0.282 H, which is
// 49 cm on a 1.75 m adult - the biacromial width plus deltoids.
// These are the single source of truth: the GLSL below is generated from them.
const ANKLE_Y = 0.055;
const KNEE_Y = 0.285;
const HIP_Y = 0.52;
const WAIST_Y = 0.6;
const SHOULDER_Y = 0.82;
const NECK_Y = 0.855;
const ELBOW_Y = 0.655;
const HEAD_Y = 0.925;
const LEG_X = 0.061;
const ARM_X = 0.106;

// Distance from the hip axis to the sole, and the lever arms of the two
// contact corners. The pelvis drop is computed from these so a planted foot
// stays planted rather than sinking or floating as the leg swings.
const SOLE_RADIUS = 0.514;
const HEEL_LEVER = 0.0425;
const TOE_LEVER = 0.1025;

// Limb ids. 2/3 and 6/7 are the +X side; 4/5 and 8/9 the -X side.
const LIMB_PELVIS = 0;
const LIMB_HEAD = 1;
const LIMB_THIGH_A = 2;
const LIMB_SHIN_A = 3;
const LIMB_THIGH_B = 4;
const LIMB_SHIN_B = 5;
const LIMB_UPPER_A = 6;
const LIMB_FORE_A = 7;
const LIMB_UPPER_B = 8;
const LIMB_FORE_B = 9;
const LIMB_TORSO = 10;

// Colour zones.
const ZONE_SKIN = 0;
const ZONE_TOP = 1;
const ZONE_BOTTOM = 2;
const ZONE_HAIR = 3;
const ZONE_SHOE = 4;
const ZONE_ACCENT = 5;
/** Bare below a skirt, otherwise trousers. */
const ZONE_LEG = 6;
/** Bare below a short sleeve, otherwise the top. */
const ZONE_FOREARM = 7;

// Hideable parts. Index n is tested against bit (n - 1) of the shape bits,
// which is the same order as the SHAPE_* flags in `appearance.ts`.
const PART_ALWAYS = 0;
const PART_HAT = 1;
const PART_LONG_HAIR = 2;
const PART_SKIRT = 3;
const PART_BAG = 4;

function tag(geometry: BufferGeometry, limb: number, zone: number, part: number): BufferGeometry {
  const count = geometry.getAttribute('position').count;
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    data[i * 4] = limb;
    data[i * 4 + 1] = zone;
    data[i * 4 + 2] = part;
    data[i * 4 + 3] = 0;
  }
  geometry.setAttribute('aRig', new Float32BufferAttribute(data, 4));
  // No texture is ever sampled on a pedestrian, and dropping uv keeps the
  // merge consistent and the attribute count down.
  geometry.deleteAttribute('uv');
  return geometry;
}

/**
 * Builds the canonical body. One unit tall, feet on y = 0, facing -Z.
 *
 * Everything is a box, a cylinder or a low sphere: about 560 triangles for a
 * whole person, which the measured budget says costs nothing, and which reads
 * correctly at the two to thirty metres a pedestrian is actually seen from.
 */
export function createProcPedestrianGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // -- head and hair --------------------------------------------------------
  parts.push(
    tag(
      new SphereGeometry(0.078, 8, 6).scale(0.82, 1, 0.9).translate(0, HEAD_Y, 0),
      LIMB_HEAD,
      ZONE_SKIN,
      PART_ALWAYS,
    ),
  );
  parts.push(
    tag(
      new CylinderGeometry(0.03, 0.035, 0.055, 6).translate(0, NECK_Y + 0.015, 0),
      LIMB_HEAD,
      ZONE_SKIN,
      PART_ALWAYS,
    ),
  );
  parts.push(
    tag(
      new SphereGeometry(0.083, 8, 5, 0, Math.PI * 2, 0, 1.25)
        .scale(0.82, 1, 0.92)
        .translate(0, HEAD_Y, 0),
      LIMB_HEAD,
      ZONE_HAIR,
      PART_ALWAYS,
    ),
  );
  parts.push(
    tag(
      new BoxGeometry(0.115, 0.17, 0.055).translate(0, HEAD_Y - 0.06, 0.055),
      LIMB_HEAD,
      ZONE_HAIR,
      PART_LONG_HAIR,
    ),
  );
  parts.push(
    tag(
      new CylinderGeometry(0.072, 0.079, 0.072, 8).translate(0, HEAD_Y + 0.078, 0),
      LIMB_HEAD,
      ZONE_ACCENT,
      PART_HAT,
    ),
  );
  parts.push(
    tag(
      new CylinderGeometry(0.122, 0.122, 0.012, 10).translate(0, HEAD_Y + 0.044, 0),
      LIMB_HEAD,
      ZONE_ACCENT,
      PART_HAT,
    ),
  );

  // -- torso, pelvis, bag ---------------------------------------------------
  parts.push(
    tag(
      new CylinderGeometry(0.099, 0.084, SHOULDER_Y + 0.035 - WAIST_Y, 8)
        .scale(1, 1, 0.62)
        .translate(0, (WAIST_Y + SHOULDER_Y + 0.035) * 0.5, 0),
      LIMB_TORSO,
      ZONE_TOP,
      PART_ALWAYS,
    ),
  );
  for (const side of [1, -1] as const) {
    parts.push(
      tag(
        new SphereGeometry(0.035, 6, 4).translate(side * ARM_X, SHOULDER_Y, 0),
        LIMB_TORSO,
        ZONE_TOP,
        PART_ALWAYS,
      ),
    );
  }
  parts.push(
    tag(
      new BoxGeometry(0.17, 0.21, 0.085).translate(0, 0.7, 0.085),
      LIMB_TORSO,
      ZONE_ACCENT,
      PART_BAG,
    ),
  );
  parts.push(
    tag(
      new CylinderGeometry(0.086, 0.094, WAIST_Y - 0.45, 8)
        .scale(1, 1, 0.64)
        .translate(0, (0.45 + WAIST_Y) * 0.5, 0),
      LIMB_PELVIS,
      ZONE_BOTTOM,
      PART_ALWAYS,
    ),
  );
  parts.push(
    tag(
      new CylinderGeometry(0.1, 0.158, 0.225, 8)
        .scale(1, 1, 0.86)
        .translate(0, WAIST_Y - 0.1125, 0),
      LIMB_PELVIS,
      ZONE_BOTTOM,
      PART_SKIRT,
    ),
  );

  // -- legs -----------------------------------------------------------------
  const legs: readonly (readonly [number, number, number])[] = [
    [LEG_X, LIMB_THIGH_A, LIMB_SHIN_A],
    [-LEG_X, LIMB_THIGH_B, LIMB_SHIN_B],
  ];
  for (const [x, thigh, shin] of legs) {
    parts.push(
      tag(
        new CylinderGeometry(0.049, 0.041, HIP_Y - KNEE_Y, 6).translate(
          x,
          (HIP_Y + KNEE_Y) * 0.5,
          0,
        ),
        thigh,
        ZONE_LEG,
        PART_ALWAYS,
      ),
    );
    // A ball at the joint, carried by the parent, hides the wedge a bent knee
    // would otherwise open between two capped cylinders.
    parts.push(
      tag(new SphereGeometry(0.041, 6, 4).translate(x, KNEE_Y, 0), thigh, ZONE_LEG, PART_ALWAYS),
    );
    parts.push(
      tag(
        new CylinderGeometry(0.041, 0.031, KNEE_Y - ANKLE_Y, 6).translate(
          x,
          (KNEE_Y + ANKLE_Y) * 0.5,
          0,
        ),
        shin,
        ZONE_LEG,
        PART_ALWAYS,
      ),
    );
    parts.push(
      tag(
        new BoxGeometry(0.062, 0.048, 0.145).translate(x, 0.03, -0.03),
        shin,
        ZONE_SHOE,
        PART_ALWAYS,
      ),
    );
  }

  // -- arms -----------------------------------------------------------------
  const arms: readonly (readonly [number, number, number])[] = [
    [ARM_X, LIMB_UPPER_A, LIMB_FORE_A],
    [-ARM_X, LIMB_UPPER_B, LIMB_FORE_B],
  ];
  for (const [x, upper, fore] of arms) {
    parts.push(
      tag(
        new CylinderGeometry(0.032, 0.027, SHOULDER_Y - ELBOW_Y, 5).translate(
          x,
          (SHOULDER_Y + ELBOW_Y) * 0.5,
          0,
        ),
        upper,
        ZONE_TOP,
        PART_ALWAYS,
      ),
    );
    parts.push(
      tag(new SphereGeometry(0.03, 5, 4).translate(x, ELBOW_Y, 0), upper, ZONE_TOP, PART_ALWAYS),
    );
    parts.push(
      tag(
        new CylinderGeometry(0.027, 0.023, ELBOW_Y - 0.49, 5).translate(
          x,
          (ELBOW_Y + 0.49) * 0.5,
          0,
        ),
        fore,
        ZONE_FOREARM,
        PART_ALWAYS,
      ),
    );
    parts.push(
      tag(
        new BoxGeometry(0.042, 0.075, 0.03).translate(x, 0.46, 0),
        fore,
        ZONE_SKIN,
        PART_ALWAYS,
      ),
    );
  }

  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('pedestrian geometry failed to merge');
  merged.computeBoundingSphere();
  return merged;
}

const TAU_GLSL = '6.2831853';

/** Shared helpers, the rig constants, and the pose function. */
const POSE_GLSL = /* glsl */ `
attribute vec4 aRig;
attribute vec4 iAnim;
attribute vec4 iAnim2;
attribute vec4 iColors;
attribute vec4 iExtra;

const float MB_DUTY = ${GAIT_DUTY.toFixed(4)};
const float MB_HIP_Y = ${HIP_Y.toFixed(4)};
const float MB_KNEE_Y = ${KNEE_Y.toFixed(4)};
const float MB_SHOULDER_Y = ${SHOULDER_Y.toFixed(4)};
const float MB_ELBOW_Y = ${ELBOW_Y.toFixed(4)};
const float MB_SOLE = ${SOLE_RADIUS.toFixed(4)};
const float MB_HEEL = ${HEEL_LEVER.toFixed(4)};
const float MB_TOE = ${TOE_LEVER.toFixed(4)};

bool mbIs(float a, float b) { return abs(a - b) < 0.5; }

float mbBit(float bits, float index) {
  return mod(floor(bits / exp2(index)), 2.0);
}

vec3 mbUnpack(float v) {
  float b = mod(v, 256.0);
  float g = mod(floor(v / 256.0), 256.0);
  float r = floor(v / 65536.0);
  return vec3(r, g, b) / 255.0;
}

vec3 mbRotX(vec3 p, float pivotY, float a) {
  float c = cos(a);
  float s = sin(a);
  float y = p.y - pivotY;
  return vec3(p.x, pivotY + y * c - p.z * s, y * s + p.z * c);
}

vec3 mbRotY(vec3 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
}

// Hip angle through one cycle. During stance this is the exact inverse sine
// that keeps the foot at a fixed point while the body moves over it, which is
// the whole reason the walk does not slide.
float mbHip(float u, float amp) {
  float r = sin(amp);
  if (u < MB_DUTY) {
    return asin(clamp(r * (1.0 - 2.0 * u / MB_DUTY), -0.9995, 0.9995));
  }
  float s = (u - MB_DUTY) / (1.0 - MB_DUTY);
  return mix(-amp, amp, s * s * (3.0 - 2.0 * s));
}

// Knee flexes just after toe-off and extends again before heel strike. The
// small constant bend stops the leg reading as a locked stick.
float mbKnee(float u, float gait) {
  float s = clamp((u - MB_DUTY) / (1.0 - MB_DUTY), 0.0, 1.0);
  return -(0.055 + 1.02 * sin(3.14159265 * pow(s, 0.75)) * gait);
}

// How far the lowest point of a planted foot rises as the leg leaves vertical.
// Lowering the pelvis by this keeps the foot in contact with the ground.
float mbFootRise(float t) {
  float lever = t > 0.0 ? MB_HEEL : MB_TOE;
  return MB_SOLE * (1.0 - cos(t)) - lever * abs(sin(t));
}

vec3 mbPose(vec3 p, bool isNormal) {
  float u = iAnim.x;
  float amp = iAnim.y;
  float armAmp = iAnim.z;
  float gait = iAnim.w;
  float bits = iAnim2.w;
  float limb = aRig.x;

  if (!isNormal && aRig.z > 0.5 && mbBit(bits, aRig.z - 1.0) < 0.5) {
    // Collapse the whole triangle to a point: a hidden accessory costs a few
    // degenerate primitives, which the rasteriser discards for nothing.
    return vec3(0.0);
  }

  float uA = fract(u);
  float uB = fract(u + 0.5);
  float hipA = mbHip(uA, amp);
  float hipB = mbHip(uB, amp);
  float roll = iAnim2.z * sin(${TAU_GLSL} * u) * gait;

  if (limb > 1.5 && limb < 5.5) {
    bool sideB = limb > 3.5;
    float ul = sideB ? uB : uA;
    if (mbIs(limb, ${LIMB_SHIN_A}.0) || mbIs(limb, ${LIMB_SHIN_B}.0)) {
      p = mbRotX(p, isNormal ? 0.0 : MB_KNEE_Y, mbKnee(ul, gait));
    }
    p = mbRotX(p, isNormal ? 0.0 : MB_HIP_Y, sideB ? hipB : hipA);
    p = mbRotY(p, -roll * 0.45);
  } else if (limb > 5.5) {
    if (limb < 9.5) {
      bool sideB = limb > 7.5;
      float swing = (sideB ? 1.0 : -1.0) * armAmp * cos(${TAU_GLSL} * u);
      if (mbIs(limb, ${LIMB_FORE_A}.0) || mbIs(limb, ${LIMB_FORE_B}.0)) {
        float elbow = 0.2 + 0.42 * clamp(swing * 2.2, 0.0, 1.0);
        p = mbRotX(p, isNormal ? 0.0 : MB_ELBOW_Y, elbow);
      }
      p = mbRotX(p, isNormal ? 0.0 : MB_SHOULDER_Y, swing);
    }
    p = mbRotY(p, roll);
  } else if (limb > 0.5) {
    p = mbRotY(p, roll * 0.55);
  } else {
    p = mbRotY(p, -roll * 0.45);
  }

  p = mbRotX(p, isNormal ? 0.0 : MB_HIP_Y, -iAnim2.y);

  if (!isNormal) {
    float riseA = uA < MB_DUTY ? mbFootRise(hipA) : -1.0;
    float riseB = uB < MB_DUTY ? mbFootRise(hipB) : -1.0;
    float drop = max(riseA, riseB) * gait;
    // A shade of extra sink so a rounding error shows as contact, not float.
    float bob = -drop - 0.004
      - iAnim2.x * (0.5 - 0.5 * cos(4.0 * 3.14159265 * u));
    float sway = iAnim2.x * 2.4 * sin(${TAU_GLSL} * u) * gait;
    p += vec3(sway, bob, 0.0);
  }
  return p;
}
`;

const COLOR_GLSL = /* glsl */ `
varying vec3 vPedColor;
varying float vPedRough;
`;

const COLOR_ASSIGN_GLSL = /* glsl */ `
{
  float bits = iAnim2.w;
  float zone = aRig.y;
  vec3 skin = mbUnpack(iColors.z);
  vec3 top = mbUnpack(iColors.x);
  vec3 chosen = skin;
  float rough = 0.62;
  if (mbIs(zone, ${ZONE_TOP}.0)) { chosen = top; rough = 0.87; }
  else if (mbIs(zone, ${ZONE_BOTTOM}.0)) { chosen = mbUnpack(iColors.y); rough = 0.87; }
  else if (mbIs(zone, ${ZONE_HAIR}.0)) { chosen = mbUnpack(iColors.w); rough = 0.48; }
  else if (mbIs(zone, ${ZONE_SHOE}.0)) { chosen = mbUnpack(iExtra.y); rough = 0.4; }
  else if (mbIs(zone, ${ZONE_ACCENT}.0)) { chosen = mbUnpack(iExtra.x); rough = 0.7; }
  else if (mbIs(zone, ${ZONE_LEG}.0)) {
    bool bare = mbBit(bits, 2.0) > 0.5;
    chosen = bare ? skin : mbUnpack(iColors.y);
    rough = bare ? 0.62 : 0.87;
  } else if (mbIs(zone, ${ZONE_FOREARM}.0)) {
    bool bare = mbBit(bits, 4.0) > 0.5;
    chosen = bare ? skin : top;
    rough = bare ? 0.62 : 0.87;
  }
  // Albedo is authored in sRGB; the renderer works in linear.
  vPedColor = pow(chosen, vec3(2.2));
  vPedRough = rough;
}
`;

function injectVertex(source: string, withColor: boolean): string {
  let out = source.replace(
    '#include <common>',
    `#include <common>\n${withColor ? COLOR_GLSL : ''}${POSE_GLSL}`,
  );
  if (withColor) {
    out = out.replace(
      '#include <beginnormal_vertex>',
      '#include <beginnormal_vertex>\nobjectNormal = normalize(mbPose(objectNormal, true));',
    );
  }
  return out.replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>\ntransformed = mbPose(transformed, false);${
      withColor ? COLOR_ASSIGN_GLSL : ''
    }`,
  );
}

export interface ProcPedestrianMaterials {
  readonly material: MeshStandardMaterial;
  readonly depth: MeshDepthMaterial;
}

export function createProcPedestrianMaterials(): ProcPedestrianMaterials {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0,
  });
  material.name = 'pedestrian';
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = injectVertex(shader.vertexShader, true);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${COLOR_GLSL}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vPedColor;')
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = vPedRough;',
      );
  };
  material.customProgramCacheKey = (): string => 'meridian-pedestrian-proc-v1';

  // The shadow pass uses its own program. Without the same displacement here
  // the crowd would cast the shadow of an unanimated bind pose, which is the
  // single most obvious way to give away a procedural character.
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  depth.name = 'pedestrianDepth';
  depth.onBeforeCompile = (shader) => {
    shader.vertexShader = injectVertex(shader.vertexShader, false);
  };
  depth.customProgramCacheKey = (): string => 'meridian-pedestrian-proc-depth-v1';

  return { material, depth };
}

export interface ProcPedestrianMeshBundle {
  readonly mesh: InstancedMesh;
  readonly anim: InstancedBufferAttribute;
  readonly anim2: InstancedBufferAttribute;
  readonly colors: InstancedBufferAttribute;
  readonly extra: InstancedBufferAttribute;
  dispose(): void;
}

export function createProcPedestrianMesh(capacity: number): ProcPedestrianMeshBundle {
  const geometry = createProcPedestrianGeometry();
  const { material, depth } = createProcPedestrianMaterials();

  const anim = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const anim2 = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const colors = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const extra = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  for (const attribute of [anim, anim2, colors, extra]) attribute.setUsage(DynamicDrawUsage);
  geometry.setAttribute('iAnim', anim);
  geometry.setAttribute('iAnim2', anim2);
  geometry.setAttribute('iColors', colors);
  geometry.setAttribute('iExtra', extra);

  const mesh = new InstancedMesh(geometry, material as Material, capacity);
  mesh.name = 'pedestriansProcedural';
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.customDepthMaterial = depth;
  mesh.receiveShadow = true;
  // Instances are culled by distance in `PedestrianSystem`; the mesh itself
  // has no meaningful bounding volume once the instances move every frame.
  mesh.frustumCulled = false;
  mesh.count = 0;

  // The rotation-and-scale matrix only ever writes six of sixteen slots, so
  // the constant ones are set once here rather than every frame.
  const matrices = mesh.instanceMatrix.array as Float32Array;
  for (let i = 0; i < capacity; i += 1) matrices[i * 16 + 15] = 1;

  return {
    mesh,
    anim,
    anim2,
    colors,
    extra,
    dispose(): void {
      geometry.dispose();
      material.dispose();
      depth.dispose();
      mesh.dispose();
    },
  };
}
