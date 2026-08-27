/**
 * Scene lighting.
 *
 * One sun, one sky/ground hemisphere term, and one weak "bounce" directional
 * standing in for light coming back off the ground. There is deliberately no
 * AmbientLight: a flat ambient term is the single fastest way to make a scene
 * look like an untuned demo, because it lifts shadow interiors to a uniform
 * grey that no real light ever produces.
 *
 * The shadow camera is small and follows the player. A shadow map stretched
 * over a whole city wastes almost all of its resolution on geometry nobody is
 * looking at; keeping it tight around the viewer is what buys crisp contact
 * shadows at street level for the same cost.
 */

import {
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  PointLight,
  Vector3,
  type Scene,
} from 'three';

import { SUN_DIRECTION } from './Sky';
import type { LightRequest } from '../world/build/types';

export type QualityLevel = 'low' | 'medium' | 'high';

const SHADOW_EXTENT: Record<QualityLevel, number> = { low: 45, medium: 62, high: 80 };
const SHADOW_MAP: Record<QualityLevel, number> = { low: 1024, medium: 2048, high: 2048 };
/** How many of the world's requested point lights we can actually afford. */
const LIGHT_BUDGET: Record<QualityLevel, number> = { low: 0, medium: 10, high: 18 };

export class Lighting {
  readonly sun: DirectionalLight;
  readonly hemisphere: HemisphereLight;
  readonly bounce: DirectionalLight;
  readonly group = new Group();

  private readonly pool: PointLight[] = [];
  private requests: LightRequest[] = [];
  private quality: QualityLevel = 'high';
  private readonly sunOffset = new Vector3();
  /** Reused per-frame scratch for the nearest-light search. */
  private readonly scored: { request: LightRequest; distance: number }[] = [];

  constructor() {
    this.group.name = 'lighting';

    // Near-white summer sunlight. The old 0xffd2a1 was golden-hour amber,
    // which tinted every lit surface orange before tone mapping even ran.
    this.sun = new DirectionalLight(new Color(0xfff4e4).convertSRGBToLinear(), 3.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.setScalar(2048);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.group.add(this.sun);
    this.group.add(this.sun.target);

    // Sky above, warm sand-and-stucco bounce below.
    this.hemisphere = new HemisphereLight(
      new Color(0xb2d4f2).convertSRGBToLinear(),
      new Color(0x9c8a70).convertSRGBToLinear(),
      // The sky term is what makes a shaded facade readable. Physically the
      // sun:fill ratio should be wider, but ACES compresses the bottom of the
      // range hard and shadowed stucco went to near-black on screen. At 2.5
      // the shaded sides hold their colour and the sunlit sides still carry
      // the image - measured against screenshots, not chosen by taste.
      2.5,
    );
    this.group.add(this.hemisphere);

    // Weak fill from the opposite side, standing in for ground bounce.
    // Ground bounce: warm, but nothing like the golden-hour amber it replaces.
    this.bounce = new DirectionalLight(new Color(0xbfab8e).convertSRGBToLinear(), 0.6);
    this.bounce.position.set(-SUN_DIRECTION.x, 0.35, -SUN_DIRECTION.z).multiplyScalar(100);
    this.bounce.castShadow = false;
    this.group.add(this.bounce);

    this.applyQuality('high');
  }

  addTo(scene: Scene): void {
    scene.add(this.group);
  }

  applyQuality(level: QualityLevel): void {
    this.quality = level;
    const extent = SHADOW_EXTENT[level];
    const camera = this.sun.shadow.camera;
    camera.left = -extent;
    camera.right = extent;
    camera.top = extent;
    camera.bottom = -extent;
    camera.updateProjectionMatrix();

    const size = SHADOW_MAP[level];
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.setScalar(size);
      // Force the map to be rebuilt at the new resolution.
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.rebuildPool();
  }

  /**
   * Takes the world's light requests and keeps only the ones the budget allows,
   * preferring higher priority. Interiors outrank street lamps, which is what
   * stops a lit shop going dark because a lamp post got there first.
   */
  setLightRequests(requests: readonly LightRequest[]): void {
    this.requests = [...requests].sort((a, b) => b.priority - a.priority);
    this.rebuildPool();
  }

  private rebuildPool(): void {
    const budget = LIGHT_BUDGET[this.quality];
    while (this.pool.length > budget) {
      const light = this.pool.pop();
      if (!light) break;
      this.group.remove(light);
      light.dispose();
    }
    while (this.pool.length < budget) {
      const light = new PointLight(0xffffff, 0, 10, 2);
      light.castShadow = false;
      // NOTE: pool lights stay `visible` for their whole life, always.
      //
      // Three.js bakes the number of point lights into every shader it
      // compiles, and a light with `visible = false` is dropped from that
      // count. Toggling visibility as the player walks past street lamps
      // therefore changes the count several times a second, and each change
      // forces a recompile of EVERY material in the scene. That is what
      // turned a smooth start into progressive stutter and then a hard freeze.
      // An unused light is switched off with `intensity = 0` instead, which
      // costs one dead light in the shader loop and keeps the program count
      // completely stable.
      light.visible = true;
      this.group.add(light);
      this.pool.push(light);
    }
  }

  /**
   * Points the shadow camera at the player and assigns the nearest requested
   * lights to the pool, so a fixed number of PointLights follows the player
   * around rather than the scene carrying hundreds of them.
   */
  update(playerX: number, playerY: number, playerZ: number): void {
    // Bias the shadow volume ahead of the viewer rather than centring it on
    // them; most of what needs a shadow is in front.
    this.sun.target.position.set(playerX, playerY, playerZ);
    this.sun.target.updateMatrixWorld();
    this.sunOffset.copy(SUN_DIRECTION).multiplyScalar(120);
    this.sun.position.set(
      playerX + this.sunOffset.x,
      playerY + this.sunOffset.y,
      playerZ + this.sunOffset.z,
    );
    this.bounce.target.position.set(playerX, playerY, playerZ);

    if (this.pool.length === 0) return;

    // Nearest-N into a reused buffer. This runs every frame, so it allocates
    // nothing: a fresh array and sort per frame is a steady drip of garbage
    // that shows up later as collection hitches.
    this.scored.length = 0;
    for (const request of this.requests) {
      const distance = Math.hypot(request.x - playerX, request.z - playerZ);
      if (distance > request.distance + 40) continue;
      this.scored.push({ request, distance });
    }
    this.scored.sort((a, b) => a.distance - b.distance);

    for (let i = 0; i < this.pool.length; i += 1) {
      const light = this.pool[i];
      if (!light) continue;
      const entry = this.scored[i];
      if (!entry) {
        // Switched off, never hidden - see the note in `rebuildPool`.
        light.intensity = 0;
        light.distance = 0.01;
        continue;
      }
      const { request } = entry;
      light.position.set(request.x, request.y, request.z);
      light.color.set(request.color).convertSRGBToLinear();
      light.distance = request.distance;
      light.intensity = request.intensity;
    }
  }

  dispose(): void {
    for (const light of this.pool) light.dispose();
    this.pool.length = 0;
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.hemisphere.dispose();
    this.bounce.dispose();
    this.group.clear();
  }
}
