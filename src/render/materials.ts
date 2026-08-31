/**
 * The city's material palette.
 *
 * Every geometry builder in the project refers to a surface by one of these
 * keys and never constructs a material of its own. That is what keeps the whole
 * city on one coherent palette, lets geometry be merged aggressively (one draw
 * call per key per chunk), and means a lighting or grading change happens in a
 * single place.
 *
 * Colours and roughness values come from `docs/art-direction.md`, which derived
 * them by sampling reference photography rather than by guesswork. Albedo is
 * authored in sRGB and converted on assignment.
 */

import {
  Color,
  DoubleSide,
  FrontSide,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  SRGBColorSpace,
  type Material,
  type Texture,
} from 'three';

export type MaterialKey =
  // Ground
  | 'asphalt'
  | 'asphaltWorn'
  | 'roadPaint'
  | 'roadPaintYellow'
  | 'kerb'
  | 'pavement'
  | 'pavementDark'
  | 'boardwalk'
  | 'plazaStone'
  | 'gravel'
  | 'sand'
  | 'sandWet'
  | 'grass'
  | 'water'
  // Walls
  | 'stuccoCream'
  | 'stuccoPeach'
  | 'stuccoMint'
  | 'stuccoRose'
  | 'stuccoSand'
  | 'stuccoBlue'
  | 'concrete'
  | 'concreteBoard'
  | 'brickRed'
  | 'brickBuff'
  | 'stoneAshlar'
  | 'skyline'
  | 'paintedMetal'
  | 'corrugated'
  | 'tileFloor'
  // Openings
  | 'glass'
  | 'glassDark'
  | 'glassShop'
  | 'shopWall'
  | 'shopFitting'
  | 'shopGoods'
  | 'windowFrame'
  | 'doorPainted'
  | 'shutter'
  // Roofs and trim
  | 'roofTar'
  | 'roofTile'
  | 'timber'
  | 'timberDark'
  | 'metalDark'
  | 'metalLight'
  | 'rust'
  | 'canvasAwning'
  // Emissive and vegetation
  | 'signEmissive'
  | 'signEmissiveWarm'
  | 'lampGlass'
  | 'signalHousing'
  | 'signalLens'
  | 'foliage'
  | 'foliageDark'
  | 'palmFrond'
  | 'barkPalm'
  | 'barkTree'
  | 'blossom'
  | 'blossomWarm';

interface Spec {
  color: number;
  roughness: number;
  metalness?: number;
  transparent?: boolean;
  opacity?: number;
  emissive?: number;
  emissiveIntensity?: number;
  side?: typeof FrontSide | typeof DoubleSide;
  /** Physically-based clear coat, used sparingly for glass and wet surfaces. */
  physical?: { transmission?: number; clearcoat?: number; ior?: number };
  /** Basic (unlit) materials for emissive signage that must not be shaded. */
  basic?: boolean;
  /** Weight of the image-based lighting. Raised for water, which is mostly reflection. */
  envMapIntensity?: number;
}

const SPECS: Readonly<Record<MaterialKey, Spec>> = {
  asphalt: { color: 0x3a3a3c, roughness: 0.93 },
  asphaltWorn: { color: 0x4a4a4a, roughness: 0.88 },
  roadPaint: { color: 0xd8d5cb, roughness: 0.78 },
  roadPaintYellow: { color: 0xc8a94e, roughness: 0.78 },
  kerb: { color: 0x9a968d, roughness: 0.85 },
  pavement: { color: 0x8e8b84, roughness: 0.88 },
  pavementDark: { color: 0x6f6d68, roughness: 0.9 },
  boardwalk: { color: 0x8a7358, roughness: 0.86 },
  plazaStone: { color: 0xa39c8f, roughness: 0.8 },
  gravel: { color: 0x6b665e, roughness: 0.95 },
  sand: { color: 0xc9b291, roughness: 0.96 },
  // The strip the tide keeps damp: darker, and glossy enough to catch the low
  // sun. The band between dry and wet sand is one of the strongest cues that a
  // beach is a real beach rather than a coloured plane.
  sandWet: { color: 0x8f7a61, roughness: 0.42, metalness: 0.02 },
  grass: { color: 0x5c6f42, roughness: 0.94 },
  // Opaque, and a plain standard material rather than a physical one. The sea
  // is a single flat plane covering half the screen at grazing incidence: a
  // clearcoat lobe buys nothing visible there and the transparent sort is pure
  // cost. A little metalness gives the sky reflection enough weight to read as
  // water rather than as painted floor.
  // The sea at golden hour is almost entirely reflected sky, so it is weighted
  // heavily towards the environment and carries a low emissive floor keyed to
  // the horizon. Without that floor a flat plane under a low sun renders as a
  // black hole in the middle of the bay.
  water: {
    // Retuned for the summer daylight rebuild. Under golden hour the sea was
    // lifted by a warm emissive because it otherwise read black; against a
    // bright blue sky that same warm term only muddies it, and the deeper
    // body colour is what stops the surface collapsing into a flat mirror of
    // the pale horizon at grazing angles.
    color: 0x2f7d9e,
    // Slightly rougher and less mirror-like than a first guess: a very smooth,
    // heavily env-weighted sea turns every ripple into a hard highlight and the
    // surface reads as crumpled foil rather than water.
    roughness: 0.22,
    metalness: 0.30,
    envMapIntensity: 1.45,
    // A cool, very low lift: enough that shadowed swell never goes black,
    // small enough that it never tints the colour.
    emissive: 0x123c50,
    emissiveIntensity: 0.16,
  },

  stuccoCream: { color: 0xe4d7bd, roughness: 0.9 },
  stuccoPeach: { color: 0xdcb79a, roughness: 0.9 },
  stuccoMint: { color: 0xbcd0c0, roughness: 0.9 },
  stuccoRose: { color: 0xd6aaa4, roughness: 0.9 },
  stuccoSand: { color: 0xcfbd97, roughness: 0.9 },
  stuccoBlue: { color: 0xaebfcd, roughness: 0.9 },
  concrete: { color: 0x9c9a94, roughness: 0.88 },
  concreteBoard: { color: 0x8d8b86, roughness: 0.84 },
  brickRed: { color: 0x8c5442, roughness: 0.92 },
  brickBuff: { color: 0xb09070, roughness: 0.92 },
  stoneAshlar: { color: 0xc0b7a4, roughness: 0.83 },
  // The far shore. One key carries the entire distant skyline: the façade
  // family, the window rhythm and the haze weighting all come out of the
  // shader from two numbers packed into the UVs, so a hundred distant
  // buildings can each look different and still cost one draw call and no
  // texture memory. The base colour is white because the shader supplies the
  // albedo; see `makeSkylineFacades`.
  skyline: { color: 0xffffff, roughness: 0.94 },
  paintedMetal: { color: 0x5f6d6a, roughness: 0.55, metalness: 0.55 },
  corrugated: { color: 0x8b8f8b, roughness: 0.6, metalness: 0.62 },
  tileFloor: { color: 0xb8b2a6, roughness: 0.4 },

  glass: {
    color: 0x9fb6c4,
    roughness: 0.08,
    metalness: 0.0,
    transparent: true,
    opacity: 0.42,
    physical: { clearcoat: 1, ior: 1.5 },
  },
  glassDark: {
    color: 0x35434d,
    roughness: 0.1,
    metalness: 0.2,
    transparent: true,
    opacity: 0.72,
    physical: { clearcoat: 1, ior: 1.5 },
  },
  /*
   * Shopfront glazing.
   *
   * TRANSPARENT NOW, AND THAT IS THE POINT. It used to be an opaque near-black
   * pane "so we never pay for sorting on hundreds of shopfronts", which was a
   * correct trade while there was nothing behind it - and it is exactly what
   * made every ground floor in the city read as a row of dead black holes.
   * There is a shop behind it now (see `emitShopfront`), so the glass has to
   * let it through.
   *
   * The cost is bounded because the pane is still nearly opaque and still
   * carries its own colour: at 0.62 the interior reads as an interior seen
   * through tinted glass rather than as a diorama in a box, and the sheen from
   * the low roughness still dominates at the grazing angles a passer-by sees
   * most shopfronts at. `envMapIntensity` is raised so the pane picks up the
   * sky rather than going flat, which is the other half of a window looking
   * like glass.
   */
  glassShop: {
    color: 0x2a3238,
    roughness: 0.12,
    metalness: 0.2,
    transparent: true,
    opacity: 0.62,
    envMapIntensity: 1.5,
  },
  /*
   * What is behind that glass.
   *
   * A shop interior seen from the street is almost entirely its back wall, a
   * counter and whatever is stacked on it, lit by something warm and out of
   * sight. The low emissive is that unseen light: without it every shop is a
   * black room whatever colour the wall is, because no light in this scene
   * reaches through a 1 m opening in a facade.
   */
  shopWall: {
    color: 0xb9a488,
    roughness: 0.92,
    emissive: 0x3a2a16,
    emissiveIntensity: 0.55,
  },
  /** Counters, shelving and the back of a display case. */
  shopFitting: { color: 0x5c4632, roughness: 0.8, emissive: 0x241a0d, emissiveIntensity: 0.4 },
  /**
   * Whatever is stacked on the shelves.
   *
   * One key rather than a palette: a display is read as SHAPES at street
   * distance, and the per-instance colour variety that would matter is already
   * carried by the shelves being at different heights in different bays.
   */
  shopGoods: { color: 0xa8563f, roughness: 0.7, emissive: 0x30170f, emissiveIntensity: 0.35 },
  windowFrame: { color: 0x4a4842, roughness: 0.62, metalness: 0.15 },
  doorPainted: { color: 0x3f5a55, roughness: 0.55 },
  shutter: { color: 0x6d7f73, roughness: 0.72 },

  roofTar: { color: 0x4b4945, roughness: 0.95 },
  roofTile: { color: 0x9c5f45, roughness: 0.9 },
  timber: { color: 0xa3855f, roughness: 0.85 },
  timberDark: { color: 0x6d573c, roughness: 0.88 },
  metalDark: { color: 0x3e4245, roughness: 0.5, metalness: 0.7 },
  metalLight: { color: 0x9aa0a2, roughness: 0.42, metalness: 0.78 },
  rust: { color: 0x7a4a2e, roughness: 0.95, metalness: 0.2 },
  canvasAwning: { color: 0xb35f4d, roughness: 0.9, side: DoubleSide },

  // Emissive signage is deliberately not fully saturated: saturated primaries
  // are one of the strongest "made by a generator" tells.
  signEmissive: { color: 0x2a2226, roughness: 0.6, emissive: 0xff5aa8, emissiveIntensity: 2.1 },
  signEmissiveWarm: { color: 0x2a2620, roughness: 0.6, emissive: 0xffb86b, emissiveIntensity: 1.9 },
  lampGlass: { color: 0x3a3630, roughness: 0.3, emissive: 0xffd9a0, emissiveIntensity: 1.4 },
  // Traffic signals. The mast and its hood are one dark key so the whole set of
  // heads is a single instanced draw, and dark enough that the lens beside it
  // reads as lit rather than as a coloured disc.
  signalHousing: { color: 0x24272a, roughness: 0.7, metalness: 0.35 },
  // The lens itself. Unlit and un-tone-mapped, because the colour is carried by
  // the InstancedMesh's per-instance colour and must survive to the framebuffer
  // exactly as written: a red that the tone curve has rolled off is amber. The
  // base is white so the instance colour IS the output.
  signalLens: { color: 0xffffff, roughness: 0.4, basic: true },
  foliage: { color: 0x4e6b3a, roughness: 0.92, side: DoubleSide },
  foliageDark: { color: 0x3b5230, roughness: 0.93, side: DoubleSide },
  palmFrond: { color: 0x5f7a3d, roughness: 0.9, side: DoubleSide },
  barkPalm: { color: 0x8a7a5e, roughness: 0.94 },
  barkTree: { color: 0x5b4a3a, roughness: 0.95 },
  /*
   * Bedding flowers, in two colours.
   *
   * TWO KEYS, WHICH IS TWO DRAW CALLS FOR THE WHOLE CITY, and worth it: one
   * saturated colour repeated in every planter on every street reads as a
   * decal rather than as planting. Warm against cool is also the pair that
   * survives the tone map - a single mid-pink goes to mud in shadow and to
   * white in the sun.
   *
   * Bright, and deliberately so. These are the only fully saturated albedos in
   * the palette outside the signage, they cover a fraction of a square metre
   * each, and a flower bed that is not brighter than the leaf behind it is
   * just more leaf.
   */
  blossom: { color: 0xd4577f, roughness: 0.86 },
  blossomWarm: { color: 0xe8a93c, roughness: 0.86 },
};

/**
 * Keys whose geometry must be rendered after the opaque pass.
 *
 * ALSO THE SHADOW LIST. `WorldBuilder` clears `castShadow` for everything in
 * here, because Three's shadow depth pass ignores material opacity: a
 * transparent mesh that casts still lays down a SOLID silhouette. Leaving
 * `glassShop` out when it became transparent put a hard black rectangle on the
 * pavement in front of every shopfront in the city, and paid a shadow draw for
 * it. Anything added to `SPECS` with `transparent: true` belongs here.
 */
export const TRANSPARENT_KEYS: ReadonlySet<MaterialKey> = new Set<MaterialKey>([
  'glass',
  'glassDark',
  'glassShop',
  'foliage',
  'foliageDark',
  'palmFrond',
  'canvasAwning',
]);

/**
 * Owns one material instance per key and disposes them together.
 *
 * Materials are shared by every chunk, so a chunk unloading never disposes one;
 * only `dispose()` on the library does, at teardown.
 */
export class MaterialLibrary {
  private readonly cache = new Map<MaterialKey, Material>();
  private readonly textures: Texture[] = [];
  /** Materials with a time uniform, driven from the frame loop. */
  private readonly animated: { uniforms: { uTime: { value: number } } }[] = [];

  /** Advances any animated material. Called once per frame. */
  update(elapsed: number): void {
    for (const entry of this.animated) entry.uniforms.uTime.value = elapsed;
  }

  get(key: MaterialKey): Material {
    const existing = this.cache.get(key);
    if (existing) return existing;

    const spec = SPECS[key];
    const color = new Color(spec.color).convertSRGBToLinear();

    let material: Material;
    if (spec.basic) {
      material = new MeshBasicMaterial({ color, toneMapped: false });
    } else if (spec.physical) {
      material = new MeshPhysicalMaterial({
        color,
        roughness: spec.roughness,
        metalness: spec.metalness ?? 0,
        transparent: spec.transparent ?? false,
        opacity: spec.opacity ?? 1,
        side: spec.side ?? FrontSide,
        clearcoat: spec.physical.clearcoat ?? 0,
        clearcoatRoughness: 0.12,
        ior: spec.physical.ior ?? 1.5,
        transmission: spec.physical.transmission ?? 0,
      });
    } else {
      material = new MeshStandardMaterial({
        color,
        roughness: spec.roughness,
        metalness: spec.metalness ?? 0,
        transparent: spec.transparent ?? false,
        opacity: spec.opacity ?? 1,
        side: spec.side ?? FrontSide,
        emissive: spec.emissive ? new Color(spec.emissive).convertSRGBToLinear() : new Color(0),
        emissiveIntensity: spec.emissiveIntensity ?? 0,
        envMapIntensity: spec.envMapIntensity ?? 1,
      });
    }

    if (key === 'water') this.makeWaterAnimated(material as MeshStandardMaterial);
    if (key === 'skyline') this.makeSkylineFacades(material as MeshStandardMaterial);

    material.name = key;
    this.cache.set(key, material);
    return material;
  }

  /**
   * Gives the sea a moving surface.
   *
   * Rather than a normal map, the normal is perturbed analytically by a few
   * crossing wave trains, which costs nothing to download and never tiles. A
   * foam band is added along the shoreline, computed from the same curve the
   * world uses for the waterline, so the foam follows every bend of the coast
   * exactly instead of approximating it.
   */
  private makeWaterAnimated(material: MeshStandardMaterial): void {
    const uniforms = { uTime: { value: 0 } };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSeaPos;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvSeaPos = (modelMatrix * vec4(position, 1.0)).xyz;',
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vSeaPos;
           uniform float uTime;

           // Must match shorelineX() in src/world/elevation.ts.
           float seaShoreX(float z) {
             return -182.0 + 11.0 * sin(z * 0.0163 + 0.6) + 4.5 * sin(z * 0.041 - 1.9);
           }

           /**
            * Surface normal for the sea.
            *
            * Two things matter here. The slopes are small - open water seen
            * from a promenade is nearly flat, and a big perturbation turns the
            * specular into a regular quilt that reads as a tiled texture. And
            * the detail fades out with distance: high-frequency normals a few
            * hundred metres away land far below one pixel and alias into moire,
            * so beyond the near field the surface is allowed to go flat and let
            * the sky reflection carry it.
            */
           vec3 seaWaves(vec2 p, float t, float viewDist) {
             float detail = 1.0 - smoothstep(35.0, 260.0, viewDist);
             vec2 g = vec2(0.0);
             // Long swell, always present; it is broad enough not to alias.
             g += vec2(0.016, 0.009) * cos(dot(p, vec2(0.061, 0.043)) + t * 0.55);
             g += vec2(-0.013, 0.015) * cos(dot(p, vec2(-0.048, 0.079)) + t * 0.44);
             // Chop and glitter, faded out with distance. The wave vectors are
             // deliberately incommensurate so nothing repeats on a grid.
             g += detail * vec2(0.010, 0.008) * cos(dot(p, vec2(0.317, 0.229)) + t * 1.31);
             g += detail * vec2(-0.008, 0.009) * cos(dot(p, vec2(-0.271, 0.413)) + t * 1.07);
             g += detail * vec2(0.005, 0.004) * cos(dot(p, vec2(0.911, 0.677)) + t * 2.03);
             return normalize(vec3(-g.x, 1.0, -g.y));
           }`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
           normal = normalize(seaWaves(vSeaPos.xz, uTime, distance(vSeaPos, cameraPosition)));`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           {
             float shore = seaShoreX(vSeaPos.z);
             // Surf line, with a slow breathing edge so it is never static.
             float swell = sin(vSeaPos.z * 0.35 + uTime * 0.9) * 0.8
                         + sin(vSeaPos.z * 0.11 - uTime * 0.6) * 1.5;
             float d = vSeaPos.x - (shore - 1.0 + swell);
             float foam = smoothstep(-7.0, 0.5, d) * (1.0 - smoothstep(1.5, 5.0, d));
             float lace = 0.6 + 0.4 * sin(vSeaPos.z * 1.7 + uTime * 1.3);
             diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.85, 0.80), foam * lace * 0.7);
             // Shallows read lighter and greener as the bed comes up.
             float shallow = 1.0 - smoothstep(-60.0, -6.0, d);
             diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.38, 0.49, 0.47), shallow * 0.35);
           }`,
        );
    };
    // A material whose shader is patched must be told its cache key changed.
    material.customProgramCacheKey = (): string => 'meridian-sea';
    this.animated.push({ uniforms });
  }

  /**
   * Gives the distant skyline façades, window rhythm and per-building colour.
   *
   * The far shore is 250-700 m out and the fog only takes a third of it at
   * that range, so plain extruded boxes read as exactly what they are. Real
   * geometry is the wrong answer - windows on a hundred buildings would be
   * tens of thousands of triangles that land under a pixel each - so the
   * façade is drawn in the fragment shader from world position, and every
   * building is given its own character from two numbers the builder packs
   * into the UVs: `uv.x` identifies the building, `uv.y` is how far back in
   * the haze it sits.
   *
   * Two details make this survive at distance rather than turn into moire.
   * The bands are widened by their own screen-space derivative and then
   * dissolved into their average once a floor is thinner than a pixel, so the
   * pattern fades to a flat tone instead of aliasing. And the whole treatment
   * is faded out beyond 520 m, where nothing finer than a silhouette survives
   * the haze anyway.
   */
  private makeSkylineFacades(material: MeshStandardMaterial): void {
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vSkyPos;
           varying vec3 vSkyNormal;
           varying vec2 vSkyData;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vSkyPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
           vSkyNormal = normalize(mat3(modelMatrix) * objectNormal);
           vSkyData = uv;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vSkyPos;
           varying vec3 vSkyNormal;
           varying vec2 vSkyData;

           /**
            * A repeating band that antialiases itself.
            *
            * \`duty\` is the fraction of each period the band covers. Once one
            * period is narrower than a pixel the mask is replaced by that
            * fraction - the exact average - which is what a correctly filtered
            * texture would converge to, and what stops a window grid at 600 m
            * from crawling.
            */
           float skyBand(float coord, float period, float duty) {
             float u = coord / period;
             float f = fract(u);
             float w = fwidth(u);
             float edge = w * 1.2 + 0.002;
             float half_ = duty * 0.5;
             float mask = smoothstep(0.5 - half_ - edge, 0.5 - half_ + edge, f)
                        * (1.0 - smoothstep(0.5 + half_ - edge, 0.5 + half_ + edge, f));
             return mix(mask, duty, clamp(w * 2.5, 0.0, 1.0));
           }`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           {
             float id = vSkyData.x;
             float haze = vSkyData.y;
             float detail = 1.0 - smoothstep(520.0, 950.0, distance(vSkyPos, cameraPosition));

             // Four façade families, so the horizon is not one colour. Chosen
             // to sit under the city's own palette rather than compete with it.
             vec3 base = id < 0.30
               ? vec3(0.63, 0.60, 0.53)   // weathered concrete
               : id < 0.55
                 ? vec3(0.76, 0.74, 0.69) // pale stone
                 : id < 0.80
                   ? vec3(0.44, 0.50, 0.57) // blue-grey curtain wall
                   : vec3(0.53, 0.39, 0.32); // brick

             // Curtain-walled towers get taller, narrower, darker bays; the
             // masonry families get punched windows in a wider rhythm.
             float glazed = step(0.55, id);
             float floorHeight = mix(3.6, 4.1, glazed);
             float bayWidth = mix(3.2, 2.3, glazed);
             vec3 glass = mix(vec3(0.24, 0.26, 0.28), vec3(0.14, 0.18, 0.23), glazed);

             // Which way the wall runs, so the bays follow the façade instead
             // of the world axes on the returns.
             float along = mix(vSkyPos.x, vSkyPos.z, step(0.5, abs(vSkyNormal.x)));
             // The half-period offset per building keeps neighbouring towers
             // from sharing a floor line.
             float storey = vSkyPos.y + id * floorHeight;
             float windows = skyBand(storey, floorHeight, mix(0.5, 0.66, glazed))
                           * skyBand(along + id * bayWidth, bayWidth, mix(0.44, 0.74, glazed));

             vec3 facade = mix(base, glass, windows * mix(0.62, 0.8, glazed) * detail);
             // A thin shadow line under every floor: the spandrel course that
             // gives a distant tower its horizontal grain.
             facade *= 1.0 - 0.12 * detail * skyBand(storey + floorHeight * 0.5, floorHeight, 0.1);
             // Roofs are decking, never façade.
             facade = mix(facade, base * 0.58, smoothstep(0.5, 0.85, abs(vSkyNormal.y)));
             // The deep band is lifted towards the sky so the layers separate
             // through the haze instead of stacking into one silhouette.
             facade = mix(facade, vec3(0.80, 0.83, 0.86), haze * 0.34);

             // Authored in sRGB like the rest of the palette; the shader
             // bypasses the library's own conversion, so it happens here.
             diffuseColor.rgb *= pow(facade, vec3(2.2));
           }`,
        );
    };
    material.customProgramCacheKey = (): string => 'meridian-skyline';
  }

  /** Registers a texture so it is disposed with the library. */
  own(texture: Texture): Texture {
    texture.colorSpace = SRGBColorSpace;
    this.textures.push(texture);
    return texture;
  }

  dispose(): void {
    for (const material of this.cache.values()) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.cache.clear();
    this.textures.length = 0;
  }
}

export const ALL_MATERIAL_KEYS = Object.keys(SPECS) as MaterialKey[];
