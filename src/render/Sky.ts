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
  EquirectangularReflectionMapping,
  Mesh,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Texture,
  type WebGLRenderer,
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

  // Cheap ordered dither. Breaks up 8-bit banding across a wide gradient.
  float dither(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
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

    colour += dither(dir.xz * 512.0) * (1.4 / 255.0);
    gl_FragColor = vec4(colour, 1.0);
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
  private environment: Texture | null = null;

  constructor(radius = 4000) {
    this.radius = radius;
    this.geometry = new SphereGeometry(radius, 32, 20);
    this.material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        // Clear summer sky: a deep blue zenith falling to a pale, slightly
        // warm haze at the horizon. The warm stop is kept - a sky that goes
        // grey at the horizon reads as overcast, not as a hot day.
        uZenith: { value: linear(0x2f6ec2) },
        uUpper: { value: linear(0x5192d6) },
        uMid: { value: linear(0x87b6df) },
        uLower: { value: linear(0xb9d3e6) },
        uHorizonWarm: { value: linear(0xd8e3e8) },
        uHorizon: { value: linear(0xe6edef) },
        uSunGlow: { value: linear(0xfff6e6) },
        uSunDirection: { value: SUN_DIRECTION.clone() },
        uHaze: { value: 1.0 },
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
    target.texture.mapping = EquirectangularReflectionMapping;
    this.environment = target.texture;

    scene.remove(dome);
    pmrem.dispose();
    return target.texture;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.environment?.dispose();
    this.environment = null;
  }
}
