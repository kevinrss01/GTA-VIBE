/**
 * Sky dome and image-based lighting.
 *
 * The gradient stops, the sun direction and the horizon colour are the sampled
 * values from `docs/art-direction.md`, taken off reference photography rather
 * than invented. Two details matter more than they look:
 *
 * - The fog colour must equal the sky near the horizon. If it does not, distant
 *   buildings sit on a band of the wrong colour and the whole image reads as
 *   fake. That is why `HORIZON_COLOR` is exported and the scene fog is built
 *   from it rather than from a separate guess.
 * - The gradient is dithered by a fraction of a colour step. Without it a wide
 *   sky shows visible banding on an 8-bit display, which is one of the loudest
 *   "generated demo" tells there is.
 */

import {
  BackSide,
  Color,
  Mesh,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';

/**
 * Sun elevation and azimuth: high summer afternoon.
 *
 * This was late golden hour at 11 degrees, which is why the city read as dark.
 * A sun that low puts most of every north and east facade in its own shadow,
 * throws shadows longer than the blocks that cast them, and pushes the whole
 * image through an orange filter that ACES then compresses into mud.
 *
 * 54 degrees is high summer without being noon: facades still take the light
 * at an angle that models them, shadows are short enough to read as midday,
 * and the sun is not so overhead that the streets go flat. The azimuth is
 * nudged from 255 to 246 so the main east-west streets are lit along their
 * length rather than straight down one kerb.
 */
export const SUN_ELEVATION_DEG = 54;
export const SUN_AZIMUTH_DEG = 246;

/** Unit vector from the origin towards the sun. */
export const SUN_DIRECTION = new Vector3(
  Math.sin((SUN_AZIMUTH_DEG * Math.PI) / 180) * Math.cos((SUN_ELEVATION_DEG * Math.PI) / 180),
  Math.sin((SUN_ELEVATION_DEG * Math.PI) / 180),
  -Math.cos((SUN_AZIMUTH_DEG * Math.PI) / 180) * Math.cos((SUN_ELEVATION_DEG * Math.PI) / 180),
).normalize();

/**
 * Sky colour at the horizon. The scene fog MUST use this.
 *
 * Pale blue-grey summer haze, replacing the warm sand of the golden-hour
 * build. If this and the fog ever disagree the distance sits on a band of the
 * wrong colour and the whole image reads as fake.
 */
export const HORIZON_COLOR = 0xdde6ea;

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = normalize(position);
    // Keep the dome pinned to the far plane regardless of camera position.
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vDirection;

  uniform vec3 uZenith;
  uniform vec3 uUpper;
  uniform vec3 uMid;
  uniform vec3 uLower;
  uniform vec3 uHorizonWarm;
  uniform vec3 uHorizon;
  uniform vec3 uSunGlow;
  uniform vec3 uSunDirection;
  uniform float uHaze;
  uniform vec3 uCloudLit;
  uniform vec3 uCloudShade;
  uniform float uCloudCover;
  uniform float uTime;

  // Cheap ordered dither. Breaks up 8-bit banding across a wide gradient.
  float dither(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  }

  // -- clouds ---------------------------------------------------------------
  //
  // WHY A SKY WITH NOTHING IN IT IS A TELL. A cloudless gradient is the second
  // most common "generated demo" sky after a flat colour, and on a coastal city
  // the sky is a third of every outdoor frame. These are the cheapest clouds
  // that read as weather: value noise, four octaves, projected onto a flat
  // plane at a notional altitude and drifting slowly.
  //
  // The projection is the part worth understanding. A view direction is turned
  // into the point where it would pierce a horizontal plane one unit above the
  // camera, which is dir.xz / dir.y. That diverges at the horizon, which is
  // exactly right: cloud cells compress towards the horizon the way real ones
  // do, and it is also why the layer has to be faded out down there before the
  // compression turns into aliasing.

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    // Hermite, so the lattice never shows as a grid of creases.
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  // THREE OCTAVES, NOT FOUR. The sky can be most of the frame and this runs
  // per pixel: the fourth octave contributes an amplitude of 0.0625 to a value
  // that is then put through a smoothstep with a 0.17 window, so it is worth
  // about a third of a shade of grey and a quarter of the cost of the whole
  // cloud layer.
  float fbm(vec2 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 3; i += 1) {
      sum += valueNoise(p) * amp;
      p = p * 2.03 + vec2(17.3, 9.1);
      amp *= 0.5;
    }
    return sum;
  }

  vec3 gradient(float elevation) {
    // Piecewise between the sampled stops, in elevation degrees.
    vec3 c = mix(uHorizon, uHorizonWarm, smoothstep(0.0, 6.0, elevation));
    c = mix(c, uLower, smoothstep(6.0, 15.0, elevation));
    c = mix(c, uMid, smoothstep(15.0, 35.0, elevation));
    c = mix(c, uUpper, smoothstep(35.0, 60.0, elevation));
    c = mix(c, uZenith, smoothstep(60.0, 90.0, elevation));
    return c;
  }

  void main() {
    vec3 dir = normalize(vDirection);
    float elevation = degrees(asin(clamp(dir.y, -1.0, 1.0)));
    vec3 colour = gradient(max(elevation, 0.0));

    // Below the horizon the dome fades to the haze colour so the seam with the
    // ground and the water never shows.
    colour = mix(colour, uHorizon * 0.82, smoothstep(0.0, -8.0, elevation));

    // Broad glow around the sun, plus a tighter core. No hard disc: a hard sun
    // aliases badly and blows out the exposure.
    float cosAngle = dot(dir, uSunDirection);
    float glow = pow(max(cosAngle, 0.0), 28.0);
    float halo = pow(max(cosAngle, 0.0), 4.0) * 0.35;
    colour += uSunGlow * (glow * 0.9 + halo) * uHaze;

    /*
     * Cumulus, over the gradient and under the dither.
     *
     * Three things keep this from looking like noise painted on a dome:
     *   - the layer is faded out below 9 degrees, where the plane projection
     *     compresses cells to nothing and the fog has to be able to match the
     *     sky exactly, and again very near the zenith, where the projection
     *     stretches them;
     *   - the shape is a warped fbm rather than a raw one, so the cells have
     *     the lumpy, torn edges of real cloud instead of the smooth blobs a
     *     single noise gives;
     *   - the same field, sampled with a small offset towards the sun, is used
     *     as a cheap stand-in for self-shadowing. It costs one extra fbm and it
     *     is the whole difference between clouds with volume and grey paint.
     */
    float above = max(dir.y, 0.02);
    vec2 plane = dir.xz / above * 3.4 + vec2(uTime * 0.006, uTime * 0.0037);
    float warp = fbm(plane * 0.5 + 4.7);
    float field = fbm(plane + vec2(warp * 0.9, warp * 0.6));
    float density = smoothstep(uCloudCover, uCloudCover + 0.15, field);
    // Off at the horizon, off at the zenith, full in the band between.
    float band = smoothstep(9.0, 26.0, elevation) * (1.0 - smoothstep(72.0, 89.0, elevation));
    density *= band;

    if (density > 0.001) {
      vec2 sunward = normalize(uSunDirection.xz + vec2(1e-4, 0.0)) * 0.35;
      float lit = smoothstep(uCloudCover, uCloudCover + 0.15, fbm(plane + sunward + vec2(warp * 0.9, warp * 0.6)));
      // Where the sunward sample is thinner, this part of the cloud is an
      // edge and takes the light; where it is thicker, it is in shade.
      vec3 cloud = mix(uCloudShade, uCloudLit, clamp(1.0 - lit + 0.35, 0.0, 1.0));
      // Silver lining: the rim facing the sun picks up the glow.
      cloud += uSunGlow * pow(max(cosAngle, 0.0), 6.0) * 0.25 * (1.0 - density);
      colour = mix(colour, cloud, density * 0.88);
    }

    colour += dither(dir.xz * 512.0) * (1.4 / 255.0);
    gl_FragColor = vec4(colour, 1.0);

    /*
     * THE SAME OUTPUT PATH EVERY OTHER MATERIAL TAKES.
     *
     * The stops above are authored in sRGB and converted to linear, which is
     * correct - and this shader then wrote them straight to the framebuffer,
     * skipping the ACES curve and the linear-to-sRGB conversion that
     * MeshStandardMaterial gets for free. The result was a sky rendered
     * about a stop and a half dark and noticeably more saturated than the
     * values it was authored from, and - worse - a sky that could not match
     * the scene fog at the horizon, which is the one thing the top of this
     * file says must never happen: the fog colour goes through the standard
     * path and the sky did not.
     *
     * ShaderMaterial gets toneMapping() and linearToOutputTexel() in its
     * prefix from WebGLProgram; only the two call sites have to be written
     * out, which is what these chunks are.
     */
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function linear(hex: number): Color {
  return new Color(hex).convertSRGBToLinear();
}

export class Sky {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly geometry: SphereGeometry;
  private readonly radius: number;
  /** Held so `dispose` can release the framebuffer, not only its texture. */
  private target: WebGLRenderTarget | null = null;

  /*
   * DEFAULT RADIUS: INSIDE THE CAMERA'S FAR PLANE, AND THAT IS THE WHOLE POINT.
   *
   * This was 4000 m against a far plane of 1200 (`Engine`), so the dome was
   * clipped away in its entirety and every sky pixel in the game was
   * `scene.background` - a single flat colour. The gradient below, the sun
   * glow, the dither that exists to stop that gradient banding, and anything
   * else this shader has ever drawn were all invisible, which is why the sky
   * read as the one thing `docs/art-direction.md` lists as a tell: "Sky as a
   * flat background colour".
   *
   * The dome follows the camera and is drawn first with `depthWrite: false`,
   * so its radius has nothing to do with what it can occlude - everything in
   * the world draws over it regardless of distance. It only has to be inside
   * the far plane. 1000 m leaves 200 m of margin at the frustum corners.
   *
   * `createEnvironment` renders the same dome in its own scene with an
   * explicit far plane, so the image-based lighting was never affected by
   * this and is unchanged.
   */
  constructor(radius = 1000) {
    this.radius = radius;
    this.geometry = new SphereGeometry(radius, 32, 20);
    this.material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        /*
         * Clear summer sky: a deep blue zenith falling to a pale, slightly
         * warm haze at the horizon. The warm stop is kept - a sky that goes
         * grey at the horizon reads as overcast, not as a hot day.
         *
         * DEEPER THAN THE SAMPLED VALUES, ON PURPOSE. These now go through
         * ACES and the 1.15 exposure like every other surface in the game -
         * see the output chunks at the end of the fragment shader - and ACES
         * lifts and desaturates a mid blue hard: the sampled 0x2f6ec2 zenith
         * came out as a pale wash barely distinguishable from the haze below
         * it. Each stop is pushed down and in so that what LANDS ON SCREEN is
         * the colour the art brief sampled.
         *
         * uHorizon is the exception and stays exactly HORIZON_COLOR: the scene
         * fog is built from the same constant and goes through the same curve,
         * so equal inputs are what makes the two meet invisibly at the
         * horizon. Deepening it here would break the one property the top of
         * this file says must never break.
         */
        uZenith: { value: linear(0x11439c) },
        uUpper: { value: linear(0x2f6ec2) },
        uMid: { value: linear(0x5f9ad2) },
        uLower: { value: linear(0x9cc2df) },
        uHorizonWarm: { value: linear(0xc9dae2) },
        uHorizon: { value: linear(HORIZON_COLOR) },
        uSunGlow: { value: linear(0xfff6e6) },
        uSunDirection: { value: SUN_DIRECTION.clone() },
        uHaze: { value: 1.0 },
        /*
         * Cumulus over a hot coast: bright, slightly warm tops and a cool
         * grey-blue underside rather than a grey one. `uCloudCover` is a
         * THRESHOLD on the density field, so a HIGHER number is LESS cloud;
         * 0.46 gives broken cumulus with plenty of open sky between cells,
         * which is what a summer afternoon over a bay looks like and leaves
         * the city lit rather than overcast.
         */
        uCloudLit: { value: linear(0xfdfaf4) },
        uCloudShade: { value: linear(0x93a8bd) },
        uCloudCover: { value: 0.46 },
        uTime: { value: 0 },
      },
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    // Render first, and never let anything depth-test against it.
    this.mesh.renderOrder = -1000;
    this.mesh.matrixAutoUpdate = false;
  }

  /** Keeps the dome centred on the camera so it can never be walked out of. */
  follow(x: number, y: number, z: number): void {
    this.mesh.position.set(x, y, z);
    this.mesh.updateMatrix();
  }

  /**
   * Drifts the cloud layer.
   *
   * Seconds since start, the same clock everything else animates from. The
   * motion is deliberately slow - a few metres per second at the notional
   * cloud altitude - because clouds that visibly scud read as a time-lapse,
   * and the whole point of the layer is that the sky is not a still image.
   */
  setTime(seconds: number): void {
    const uniform = this.material.uniforms['uTime'];
    if (uniform) uniform.value = seconds;
  }

  /**
   * Bakes the sky into a prefiltered environment map. Without this, every PBR
   * surface in the city reflects flat black and metal reads as plastic.
   */
  createEnvironment(renderer: WebGLRenderer): Texture {
    const pmrem = new PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();

    const scene = new Scene();
    const dome = new Mesh(this.geometry, this.material);
    dome.frustumCulled = false;
    scene.add(dome);

    // The far plane matters: PMREMGenerator.fromScene defaults to far = 100,
    // and this dome sits at a radius of several thousand metres. With the
    // default it renders nothing at all and every PBR surface in the city ends
    // up lit by the sun and the hemisphere only, with a black environment -
    // which reads as a scene with crushed, lifeless shadows.
    const target = pmrem.fromScene(scene, 0.04, 1, this.radius * 2);
    /*
     * THE MAPPING IS NOT OURS TO SET. `fromScene` returns a CubeUV ATLAS and
     * has already tagged it `CubeUVReflectionMapping`; the renderer picks its
     * sampling path from that tag. Overwriting it with
     * `EquirectangularReflectionMapping` - which this used to do - told every
     * PBR shader in the city to read a packed cube atlas as a latitude and
     * longitude image, so every reflection in the game was sampling the wrong
     * texels. It went unnoticed for as long as the sky dome itself was clipped
     * away and there was nothing recognisable in the reflection to be wrong.
     */
    this.target = target;

    scene.remove(dome);
    pmrem.dispose();
    return target.texture;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    /*
     * The RENDER TARGET, not just its texture. `WebGLRenderTarget.dispose`
     * releases the framebuffer and its depth renderbuffer as well; disposing
     * only `target.texture` left both allocated on the GPU for the life of the
     * context, which a hot reload or a second `createEnvironment` accumulates.
     */
    this.target?.dispose();
    this.target = null;
  }
}
