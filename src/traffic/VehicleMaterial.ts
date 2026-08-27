/**
 * One material per body shell, one shader for the whole fleet.
 *
 * A car needs paint, glazing, rubber, chrome and lit lamps, and the paint has
 * to differ per instance while the rest does not. The usual answer - a material
 * per surface - would cost five or six draw calls per shell, and this project's
 * measured budget is 13 microseconds per draw call against an 8.4 ms frame.
 *
 * So the surface properties travel on the vertex and the varying parts travel
 * on the instance, and a small patch to the standard shader reassembles them:
 *
 *   albedo    = aAlbedo * mix(1, aTint, aPaint)     paint tints, glass does not
 *   roughness = aSurf.x, metalness = aSurf.y        per surface, one material
 *   emissive  = aEmit * aLights[aChan]              brake lamps, headlamps
 *
 * A generated Tripo body cannot supply any of that: it is one fused mesh with
 * one texture set and no idea which texel is paint and which is a window. The
 * patch therefore has a second path, selected per vertex by `aTex`:
 *
 *   albedo    = map * mix(1, aTint * gain, w)   w from the texel's own luminance
 *   roughness = the roughness/metalness map
 *   normal    = the normal map
 *
 * The luminance gate is what recovers per-instance paint on a textured body.
 * Every vehicle model is generated in plain light grey, so its base colour map
 * is effectively a mask already: painted panels sit near white, glazing, tyres,
 * grille and lamp housings sit near black, and multiplying only the bright half
 * by the instance tint recolours the car without staining its windows. It is a
 * heuristic, not a material assignment, and it is the honest limit of what a
 * single fused generated mesh can be made to do.
 *
 * DELIBERATELY NO POINT LIGHTS. Profiling this scene showed 18 point lights
 * costing 5.1 ms of an 8.4 ms frame, because every fragment evaluates all of
 * them. Headlamps and lamp lenses are emissive surfaces here; they glow but
 * they do not illuminate, which is the only version of them this frame budget
 * can afford.
 */

import { Color, MeshStandardMaterial, Vector4 } from 'three';

/**
 * Linear luminance below which a texel is treated as trim rather than paint,
 * and above which it takes the instance colour in full.
 *
 * Measured on the generated base colour maps: painted panels land around 0.55
 * to 0.75 linear, glazing and tyres around 0.05 to 0.12, and the shadowed
 * creases between them bridge the gap. A soft ramp across the middle keeps the
 * boundary from crawling as the light moves.
 */
const PAINT_LOW = 0.16;
const PAINT_HIGH = 0.42;
/**
 * Compensates for the grey the models are generated in: without it a car
 * painted pearl white would render as mid-grey, because the tint multiplies a
 * texture that is already only two thirds bright.
 */
const PAINT_GAIN = 1.45;

const VERTEX_DECLARATIONS = /* glsl */ `
attribute vec3 aAlbedo;
attribute vec2 aSurf;
attribute float aPaint;
attribute vec3 aEmit;
attribute float aChan;
attribute float aTex;
attribute vec3 aTint;
attribute vec4 aLights;
varying vec3 vAlbedo;
varying vec2 vSurf;
varying vec3 vEmit;
varying vec3 vTint;
varying float vTex;
varying float vPaintMask;
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
uniform vec4 uSurfaceFloor;
varying vec3 vAlbedo;
varying vec2 vSurf;
varying vec3 vEmit;
varying vec3 vTint;
varying float vTex;
varying float vPaintMask;
`;

const VERTEX_BODY = /* glsl */ `
vAlbedo = mix(aAlbedo, aAlbedo * aTint, aPaint);
vSurf = aSurf;
float lightWeight = aChan < 0.5 ? 1.0
  : aChan < 1.5 ? aLights.x
  : aChan < 2.5 ? aLights.y
  : aChan < 3.5 ? aLights.z
  : aLights.w;
vEmit = aEmit * lightWeight;
vTint = aTint;
vTex = aTex;
vPaintMask = aPaint;
`;

/**
 * Runs after `color_fragment`, where `diffuseColor` already holds the base
 * colour texel on a textured shell and plain white on an authored one. The
 * `mix` on `vTex` is what lets both live in one geometry: on an authored
 * vertex the textured branch is computed and discarded, which costs a few
 * instructions and saves a whole draw call.
 */
const FRAGMENT_ALBEDO = /* glsl */ `
float paintLuminance = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
float paintWeight = smoothstep(${PAINT_LOW.toFixed(3)}, ${PAINT_HIGH.toFixed(3)}, paintLuminance) * vPaintMask;
vec3 paintedColor = diffuseColor.rgb * mix(vec3(1.0), vTint * ${PAINT_GAIN.toFixed(3)}, paintWeight);
// The floor pulls whatever the tint did not touch towards one colour. It is
// off for bodies, where the dark half of the map is real detail - glazing,
// grilles, shut lines - and on for the wheel, whose generated tyre came back
// a sandy brown that no amount of tinting turns into rubber.
paintedColor = mix(paintedColor, uSurfaceFloor.rgb, uSurfaceFloor.a * (1.0 - paintWeight));
diffuseColor.rgb = mix(vAlbedo, min(paintedColor, vec3(1.0)), vTex);
`;

function patch(
  material: MeshStandardMaterial,
  name: string,
  floor: Vector4,
): MeshStandardMaterial {
  material.name = name;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSurfaceFloor = { value: floor };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECLARATIONS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECLARATIONS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAGMENT_ALBEDO}`)
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(vSurf.x, roughnessFactor, vTex);',
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\nmetalnessFactor = mix(vSurf.y, metalnessFactor, vTex);',
      )
      // The generated body's normal map must not bump the authored lamp faces
      // sharing its geometry: they carry a dummy UV and would pick up whatever
      // happens to sit at the corner of the map.
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\nnormal = normalize(mix(nonPerturbedNormal, normal, vTex));',
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEmit;',
      );
  };

  // A patched shader must declare that its program differs from the stock one,
  // or three reuses the unpatched program from its cache. Every vehicle
  // material shares this key: three's own parameter hash still separates the
  // textured shells from the authored fallback, so they compile once each.
  material.customProgramCacheKey = (): string => 'meridian-vehicle';
  return material;
}

/**
 * Builds the material for the authored fallback shells. One instance serves
 * every shell and every wheel built by `VehicleGeometry`; the caller disposes
 * it once, at teardown.
 */
export function createVehicleMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: new Color(0xffffff),
    roughness: 0.4,
    metalness: 0.1,
    emissive: new Color(0x000000),
    emissiveIntensity: 1,
    envMapIntensity: 1.15,
  });
  return patch(material, 'vehicle', new Vector4(0, 0, 0, 0));
}

/** Linear rubber, for the wheel's surface floor. */
const RUBBER = new Color(0x151617).convertSRGBToLinear();

/**
 * Adopts a generated model's own material - its base colour, normal and
 * roughness/metalness maps - into the vehicle shader.
 *
 * The material is taken over rather than copied so its textures are shared,
 * and the caller becomes responsible for disposing it.
 */
export function adoptVehicleMaterial(
  material: MeshStandardMaterial,
  name: string,
  options: { readonly rubberFloor?: boolean } = {},
): MeshStandardMaterial {
  material.color = new Color(0xffffff);
  material.emissive = new Color(0x000000);
  material.emissiveIntensity = 1;
  material.envMapIntensity = 1.15;
  material.vertexColors = false;
  const floor = options.rubberFloor
    ? new Vector4(RUBBER.r, RUBBER.g, RUBBER.b, 1)
    : new Vector4(0, 0, 0, 0);
  return patch(material, name, floor);
}
