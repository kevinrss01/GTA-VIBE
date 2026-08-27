/**
 * Real people, three hundred of them, in one draw call each.
 *
 * WHAT CHANGED AND WHY. The crowd used to be procedural boxes and cylinders
 * posed by arithmetic in the vertex shader. It is now Tripo-generated,
 * auto-rigged, retargeted characters - a real mesh with a real texture playing
 * a real motion-captured walk - drawn with the same instancing budget as
 * before. The bridge between those two facts is a VERTEX ANIMATION TEXTURE.
 *
 * THE PROBLEM WITH REAL CHARACTERS. This game's measured budget says a draw
 * call costs about 13 microseconds and the frame is GPU-bound on pixel
 * shading. One `SkinnedMesh` per pedestrian is one draw call per pedestrian:
 * 2.6 ms of pure submission at 200 people, a third of the whole frame. That is
 * why the crowd was procedural in the first place, and it is still true.
 *
 * THE FIX. `tools/bake-pedestrian-vat.mjs` runs the skinning offline, once,
 * and writes every frame of every clip into a texture: one row per vertex, one
 * column per frame. At runtime the vertex shader looks up the pose instead of
 * computing it, so the crowd stays a single `InstancedMesh` per character and
 * the per-vertex cost is ONE texture fetch for position and one for normal -
 * against the 16 to 32 that sampling bone matrices would need. Cost is one
 * colour draw plus one shadow draw per CHARACTER, not per person.
 *
 * WHAT THE SHADER STILL DOES ON THE CPU'S BEHALF:
 *   - picks the walk or idle clip, and blends them while someone is starting
 *     or stopping (`iAnim.z`, the crowd's own `gait`);
 *   - interpolates between frames, free, because the bake puts consecutive
 *     frames in adjacent texels and the texture is linearly filtered;
 *   - tints the albedo per instance so four characters do not read as three
 *     hundred clones.
 *
 * WHY THE FEET DO NOT SLIDE. `iAnim.x` is not a clock. `PedestrianSystem`
 * integrates the distance each person has actually walked and converts it to a
 * cycle position through the bake's measured travel curve, so the pose always
 * shows the feet where the ground says they are. What remains is the
 * provider's own clip quality: 9 to 45 mm of median slide per footfall on a
 * 1.75 m person, against the 283 mm the procedural crowd was measured at in
 * the browser. `gait.ts`'s `stanceSlip` reports exactly zero for that rig, but
 * it derives the stride from the person's HEIGHT while the instance matrix
 * scales them horizontally by their GIRTH, so about 40 per cent of the stride
 * never reached the screen. See `docs/pedestrian-characters.md`.
 *
 * PER-INSTANCE ATTRIBUTES (all `InstancedBufferAttribute`):
 *   iAnim = (walk cycle 0..1, idle cycle 0..1, gait 0..1, spare)
 *   iTint = (r, g, b, spare) multiplied into the albedo
 */

import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DynamicDrawUsage,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  RGBAFormat,
  RGBADepthPacking,
  UnsignedByteType,
  Vector4,
  type IUniform,
  type Material,
  type Texture,
} from 'three';

import type { PedestrianVatCharacter } from './PedestrianVat';

/**
 * The uniforms the injected GLSL reads. Held on the material so the textures
 * and clip table can be swapped in after the character finishes downloading,
 * without rebuilding - or recompiling - the material.
 */
export interface VatUniforms {
  readonly mbVatPos: IUniform<Texture>;
  readonly mbVatNrm: IUniform<Texture>;
  /** (1/width, 1/height, 0, 0) of the animation texture. */
  readonly mbVatSize: IUniform<Vector4>;
  /** (first column, frame count, 0, 0) for each clip. */
  readonly mbClipWalk: IUniform<Vector4>;
  readonly mbClipIdle: IUniform<Vector4>;
  /**
   * The action pose, if this character has one.
   *
   * Only the police character is baked with one, so for every civilian this is
   * the idle clip and `iAnim.w` - the blend into it - is left at zero. The
   * branch is per-instance and therefore coherent across a whole character, so
   * a crowd that never uses it pays one comparison.
   */
  readonly mbClipAction: IUniform<Vector4>;
}

const SAMPLE_GLSL = /* glsl */ `
attribute float aVid;
attribute vec4 iAnim;
attribute vec4 iTint;

uniform sampler2D mbVatPos;
uniform sampler2D mbVatNrm;
uniform vec4 mbVatSize;
uniform vec4 mbClipWalk;
uniform vec4 mbClipIdle;
uniform vec4 mbClipAction;

// Texel centres sit on integer + 0.5, so a coordinate of
// column + phase * frames + 0.5 lands between the two frames either side of
// the phase and the sampler's linear filter does the interpolation. The row is
// pinned to its own centre so no two vertices are ever blended.
vec2 mbVatUv(vec4 clip, float phase) {
  return vec2(
    (clip.x + phase * clip.y + 0.5) * mbVatSize.x,
    (aVid + 0.5) * mbVatSize.y
  );
}
`;

/**
 * Reads the pose. Written into a `mbPose`/`mbNormal` pair so the depth
 * material, whose shader has no normal stage at all, can use the same code.
 *
 * The branch is on a per-instance value, so it is coherent across a whole
 * character (a couple of thousand vertices) and the common cases - walking, or
 * standing still - cost one fetch each instead of two.
 */
const READ_GLSL = /* glsl */ `
  vec3 mbPose;
  vec3 mbNormal;
  {
    float gait = iAnim.z;
    vec2 uvWalk = mbVatUv(mbClipWalk, iAnim.x);
    vec2 uvIdle = mbVatUv(mbClipIdle, iAnim.y);
    if (gait > 0.995) {
      mbPose = texture2D(mbVatPos, uvWalk).xyz;
      mbNormal = texture2D(mbVatNrm, uvWalk).xyz;
    } else if (gait < 0.005) {
      mbPose = texture2D(mbVatPos, uvIdle).xyz;
      mbNormal = texture2D(mbVatNrm, uvIdle).xyz;
    } else {
      mbPose = mix(texture2D(mbVatPos, uvIdle).xyz, texture2D(mbVatPos, uvWalk).xyz, gait);
      mbNormal = mix(texture2D(mbVatNrm, uvIdle).xyz, texture2D(mbVatNrm, uvWalk).xyz, gait);
    }
    // The action pose, blended over whatever the gait produced. The blend is
    // zero for every civilian in the city, so this branch costs one compare
    // for the crowd and only ever fetches for an officer who is firing.
    float act = iAnim.w;
    if (act > 0.004) {
      vec2 uvAct = mbVatUv(mbClipAction, mbClipAction.z);
      mbPose = mix(mbPose, texture2D(mbVatPos, uvAct).xyz, act);
      mbNormal = mix(mbNormal, texture2D(mbVatNrm, uvAct).xyz, act);
    }
    mbNormal = normalize(mbNormal * 2.0 - 1.0);
  }
`;

function injectColorVertex(source: string): string {
  return source
    .replace('#include <common>', `#include <common>\n${SAMPLE_GLSL}\nvarying vec3 vPedTint;`)
    .replace(
      '#include <beginnormal_vertex>',
      `${READ_GLSL}\n#include <beginnormal_vertex>\nobjectNormal = mbNormal;`,
    )
    .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = mbPose;\nvPedTint = iTint.rgb;');
}

function injectDepthVertex(source: string): string {
  // The depth shader only includes `beginnormal_vertex` behind a displacement
  // map, so the read has to hang off `begin_vertex` instead.
  return source
    .replace('#include <common>', `#include <common>\n${SAMPLE_GLSL}`)
    .replace('#include <begin_vertex>', `${READ_GLSL}\n#include <begin_vertex>\ntransformed = mbPose;`);
}

/** A 1x1 stand-in so the material compiles before the real texture arrives. */
function placeholderTexture(half: boolean): DataTexture {
  const texture = half
    ? new DataTexture(new Uint16Array([0, 0, 0, 0x3c00]), 1, 1, RGBAFormat, HalfFloatType)
    : new DataTexture(new Uint8Array([128, 255, 128, 255]), 1, 1, RGBAFormat, UnsignedByteType);
  texture.needsUpdate = true;
  return texture;
}

/** A single triangle carrying every attribute the program expects. */
function placeholderGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(6), 2));
  geometry.setAttribute('aVid', new BufferAttribute(new Float32Array(3), 1));
  geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  return geometry;
}

export interface PedestrianVatBundle {
  readonly mesh: InstancedMesh;
  readonly anim: InstancedBufferAttribute;
  readonly tint: InstancedBufferAttribute;
  /** The character currently installed, or null while the placeholder is up. */
  character: PedestrianVatCharacter | null;
  /** Swaps the downloaded character in. Does not recompile the program. */
  install(character: PedestrianVatCharacter): void;
  /** Cycle position of the shared action pose, 0..1. */
  setActionPhase(phase: number): void;
  dispose(): void;
}

/**
 * Builds one character's instanced mesh, with placeholder geometry and
 * textures.
 *
 * It is created EMPTY on purpose. `main.ts` compiles every material in the
 * scene behind the loading screen because a lazily compiled program costs a
 * 200 ms freeze on the first playable frame; a mesh that only appears once its
 * download finishes would miss that pass and stall exactly when the player
 * takes control. An `InstancedMesh` with `count = 0` draws nothing but is
 * still walked by `compileAsync`.
 */
export function createPedestrianVatMesh(capacity: number, slot: number): PedestrianVatBundle {
  const positionTexture = placeholderTexture(true);
  const normalTexture = placeholderTexture(false);

  const uniforms: VatUniforms = {
    mbVatPos: { value: positionTexture },
    mbVatNrm: { value: normalTexture },
    mbVatSize: { value: new Vector4(1, 1, 0, 0) },
    mbClipWalk: { value: new Vector4(0, 1, 0, 0) },
    mbClipIdle: { value: new Vector4(0, 1, 0, 0) },
    // (column, frames, phase, 0). The phase is a UNIFORM rather than a
    // per-instance attribute because every officer firing at the same moment
    // is at the same point of the same one-second pose; giving each their own
    // would cost a fourth float per person in the whole crowd's buffer to
    // express something no player could distinguish.
    mbClipAction: { value: new Vector4(0, 1, 0, 0) },
  };

  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0 });
  material.name = `pedestrianVat${slot}`;
  // A white 1x1 map keeps `USE_MAP` defined from the first compile, so
  // installing the real albedo later never triggers a second one.
  const white = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  white.needsUpdate = true;
  material.map = white;
  material.onBeforeCompile = (shader): void => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = injectColorVertex(shader.vertexShader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPedTint;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= vPedTint;');
  };
  material.customProgramCacheKey = (): string => 'meridian-pedestrian-vat-v1';

  // The shadow pass runs its own program. Without the same lookup here the
  // crowd would cast the shadow of an unanimated rest pose, which is the most
  // obvious way to give away a baked character.
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  depth.name = `pedestrianVatDepth${slot}`;
  depth.onBeforeCompile = (shader): void => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = injectDepthVertex(shader.vertexShader);
  };
  depth.customProgramCacheKey = (): string => 'meridian-pedestrian-vat-depth-v1';

  const anim = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const tint = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  for (const attribute of [anim, tint]) attribute.setUsage(DynamicDrawUsage);

  const geometry = placeholderGeometry();
  geometry.setAttribute('iAnim', anim);
  geometry.setAttribute('iTint', tint);

  const mesh = new InstancedMesh(geometry, material as Material, capacity);
  mesh.name = `pedestrians-${slot}`;
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

  let placeholder: BufferGeometry | null = geometry;

  return {
    mesh,
    anim,
    tint,
    character: null,
    install(character: PedestrianVatCharacter): void {
      // The downloaded geometry carries only per-vertex data; the instanced
      // attributes move across so the buffers - and their bound program - stay
      // exactly the same.
      character.geometry.setAttribute('iAnim', anim);
      character.geometry.setAttribute('iTint', tint);
      mesh.geometry = character.geometry;
      placeholder?.dispose();
      placeholder = null;

      uniforms.mbVatPos.value = character.position;
      uniforms.mbVatNrm.value = character.normal;
      uniforms.mbVatSize.value.set(
        1 / character.position.image.width,
        1 / character.position.image.height,
        0,
        0,
      );
      uniforms.mbClipWalk.value.set(character.walk.column, character.walk.frames, 0, 0);
      const idle = character.idle ?? character.walk;
      uniforms.mbClipIdle.value.set(idle.column, idle.frames, 0, 0);
      const action = character.action ?? idle;
      uniforms.mbClipAction.value.set(action.column, action.frames, 0, 0);
      if (character.albedo) material.map = character.albedo;
      this.character = character;
    },
    setActionPhase(phase: number): void {
      uniforms.mbClipAction.value.z = phase;
    },
    dispose(): void {
      placeholder?.dispose();
      white.dispose();
      positionTexture.dispose();
      normalTexture.dispose();
      material.dispose();
      depth.dispose();
      mesh.dispose();
    },
  };
}
