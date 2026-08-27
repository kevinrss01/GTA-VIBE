/**
 * Renderer, camera, frame loop and the numbers we optimise against.
 *
 * Three things here exist because of specific failure modes rather than taste:
 *
 * - The pixel ratio is capped and then adapted downwards under load. A Retina
 *   MacBook reports a device pixel ratio of 2, which quadruples the shaded
 *   pixels; taking that at face value is the single most common reason a
 *   browser scene runs at 20 FPS on a Mac and 60 everywhere else.
 * - The frame delta is clamped. Without it, returning to a backgrounded tab
 *   delivers one enormous delta and the simulation explodes.
 * - WebGL context loss is handled explicitly. Losing the context on a laptop
 *   GPU is normal; leaving the canvas permanently black afterwards is not.
 */

import {
  ACESFilmicToneMapping,
  Clock,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type Texture,
} from 'three';

import { clamp } from './mathx';
import { HORIZON_COLOR } from '../render/Sky';
import type { QualityLevel } from '../render/Lighting';

export interface FrameStats {
  fps: number;
  frameMs: number;
  /** 95th-percentile frame interval over the recent window, in ms. */
  p95Ms: number;
  /** Worst frame interval over the recent window, in ms. */
  worstMs: number;
  /** Frames since start that took longer than `HITCH_SECONDS`. */
  hitches: number;
  /** CPU time in the update callback (controller, audio, UI), in ms. */
  updateMs: number;
  /**
   * CPU time inside `renderer.render`, in ms.
   *
   * This is submission cost, not GPU cost - the call returns once the commands
   * are queued. Read it against the frame time: if render and update are both
   * small but the frame is long, the GPU is the limiter, and only pixel or
   * shading work will help.
   */
  renderMs: number;
  /** Drawing-buffer size, which is CSS size times the pixel ratio. */
  bufferWidth: number;
  bufferHeight: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  memoryMB: number | null;
  pixelRatio: number;
}

const MAX_PIXEL_RATIO: Record<QualityLevel, number> = { low: 1, medium: 1.35, high: 2 };
/**
 * Fog is tuned so the far side of a compact city hazes without disappearing.
 *
 * Thinned from 0.0022 for the summer rebuild. Golden-hour haze was doing real
 * work hiding the distance; a clear hot day should let you see across the bay,
 * and at 0.0022 the far shore was still being greyed out at 300 m.
 */
const FOG_DENSITY = 0.0016;
/** Minimum gap between resolution changes. Each one reallocates the buffers. */
const RESOLUTION_COOLDOWN_MS = 4000;
/**
 * A frame longer than this reads as a hitch rather than a slow frame.
 *
 * Average frame rate hides stutter completely: a scene that renders at 120 FPS
 * and drops one 120 ms frame every few seconds still averages well over 60 and
 * still feels broken. Counting the outliers is what tells the two apart.
 */
const HITCH_SECONDS = 0.05;

export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  /**
   * The first-person overlay: everything drawn ON the camera rather than in
   * front of it.
   *
   * WHY A SECOND PASS. A held weapon reaches most of a metre out of the eye
   * and the player's collision cylinder is only 0.34 m of radius, so anything
   * the player can stand next to - a shop counter, a till, a door frame - is
   * geometrically INSIDE the weapon. No amount of tucking the model back fixes
   * that; it is two solids occupying one volume, and the depth buffer resolves
   * it the only way it can, by drawing the counter through the gun.
   *
   * The fix is the one every first-person game uses: render the world, throw
   * the depth buffer away, then render the viewmodel into the empty one. The
   * weapon is then always in front of everything, because there is no longer
   * anything for it to be behind.
   *
   * `overlayCamera` deliberately shares the main camera's field of view and
   * aspect and differs only in its near plane, so the weapon appears at
   * exactly the position and size the single-pass version put it - the muzzle
   * world position `CombatSystem` computes for tracers stays correct.
   *
   * Costs one extra draw call per object in the overlay - three, for a weapon
   * and two hands - and nothing at all while it is empty.
   */
  readonly overlayScene: Scene;
  readonly overlayCamera: PerspectiveCamera;
  private readonly overlayFixtures: number;

  private readonly clock = new Clock();
  private frameHandle = 0;
  private running = false;
  private disposed = false;
  private quality: QualityLevel = 'high';
  private pixelRatioScale = 1;
  private lastResolutionChange = 0;
  private lowSamples = 0;
  private highSamples = 0;

  private readonly frameTimes: number[] = [];
  private readonly sortedFrameTimes: number[] = [];
  private framesSeen = 0;
  private lastUpdateMs = 0;
  private lastRenderMs = 0;
  private statsAccumulator = 0;
  private readonly stats: FrameStats = {
    fps: 0,
    frameMs: 0,
    p95Ms: 0,
    worstMs: 0,
    hitches: 0,
    updateMs: 0,
    renderMs: 0,
    bufferWidth: 0,
    bufferHeight: 0,
    drawCalls: 0,
    triangles: 0,
    programs: 0,
    geometries: 0,
    textures: 0,
    memoryMB: null,
    pixelRatio: 1,
  };

  /** Called once per frame with a clamped delta, before rendering. */
  onUpdate: ((dt: number, elapsed: number) => void) | null = null;
  onContextLost: (() => void) | null = null;
  onContextRestored: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
      // A depth buffer is needed; alpha is not, and dropping it saves bandwidth.
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO.high));
    this.renderer.toneMapping = ACESFilmicToneMapping;
    // Chosen by measuring, not by eye. Across six street-level vantages this
    // gives a mean luma of 55-106 out of 255 with ZERO blown-out pixels and
    // under 7 per cent crushed to black - bright and summery with the
    // highlights still intact. Raising it further only crushes less at the
    // cost of starting to clip the pale stucco.
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.scene = new Scene();
    // The fog colour is the sky's horizon colour. They must match or the
    // distance reads as a coloured band rather than as air.
    this.scene.fog = new FogExp2(
      new Color(HORIZON_COLOR).convertSRGBToLinear().getHex(),
      FOG_DENSITY,
    );
    this.scene.background = new Color(HORIZON_COLOR).convertSRGBToLinear();

    this.camera = new PerspectiveCamera(62, 1, 0.1, 1200);
    this.camera.rotation.order = 'YXZ';

    // No fog and no background: the overlay is composited over a finished
    // frame, so a background would erase it and fog would tint a weapon held
    // 40 cm from the eye as though it were across the street.
    this.overlayScene = new Scene();
    // 4 cm of near plane. The muzzle of the carbine sits about 0.8 m out and
    // the nearest knuckle about 0.25 m, so this clears both without throwing
    // away depth precision the pass does not need.
    this.overlayCamera = new PerspectiveCamera(62, 1, 0.04, 12);
    this.overlayCamera.rotation.order = 'YXZ';

    /*
     * The overlay carries its own lights, and it has to.
     *
     * A second scene sees none of the first one's - and the world's sun is
     * positioned relative to the city in any case, so borrowing it would swing
     * the shading of the held weapon as the player walked across town. These
     * two are parented to the overlay CAMERA, so they travel with the eye and
     * the weapon is lit the same way everywhere: a key over the player's left
     * shoulder, which is where a hand held in front of a face is lit from
     * outdoors, and a wide fill for the side facing away from it.
     *
     * `overlayScene.environment` is set through `setOverlayEnvironment` once
     * the sky has been baked, so the metal reflects the same sky the city does.
     */
    const key = new DirectionalLight(0xfff2df, 2.2);
    key.position.set(-0.6, 1.1, 0.5);
    const fill = new HemisphereLight(0xb9d6f2, 0x50493f, 1.5);
    this.overlayCamera.add(key, key.target, fill);
    // A camera is only walked by the renderer when it is in the scene being
    // rendered, and this one is that scene's camera, so it has to be in it for
    // the lights hanging off it to be found at all.
    this.overlayScene.add(this.overlayCamera);
    // Everything the overlay owns for itself. Anything past this count is
    // content somebody put there, which is what decides whether the second
    // pass runs at all.
    this.overlayFixtures = this.overlayScene.children.length;

    this.resize();
    window.addEventListener('resize', this.onResize);
    canvas.addEventListener('webglcontextlost', this.onWebglContextLost);
    canvas.addEventListener('webglcontextrestored', this.onWebglContextRestored);
  }

  /**
   * Gives the first-person overlay the same sky the world reflects.
   *
   * Called once, after `Sky.createEnvironment`. Without it the weapon's metal
   * has nothing to reflect and reads as flat plastic.
   */
  setOverlayEnvironment(texture: Texture | null): void {
    this.overlayScene.environment = texture;
  }

  private readonly onResize = (): void => this.resize();

  private readonly onWebglContextLost = (event: Event): void => {
    // Preventing the default is what allows a restore to happen at all.
    event.preventDefault();
    this.stop();
    this.onContextLost?.();
  };

  private readonly onWebglContextRestored = (): void => {
    this.resize();
    this.onContextRestored?.();
    this.start();
  };

  resize(): void {
    // Measure the element that LAYS OUT the canvas, never the canvas itself.
    // Reading the canvas's own client size and then enlarging its backing
    // buffer feeds straight back into that measurement, and the buffer grows
    // without bound until the frame rate collapses.
    const host = this.canvas.parentElement;
    const bounds = host?.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds?.width || window.innerWidth));
    const height = Math.max(1, Math.round(bounds?.height || window.innerHeight));
    const ratio = clamp(
      window.devicePixelRatio * this.pixelRatioScale,
      0.6,
      MAX_PIXEL_RATIO[this.quality],
    );
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.overlayCamera.aspect = this.camera.aspect;
    this.overlayCamera.fov = this.camera.fov;
    this.overlayCamera.updateProjectionMatrix();
    this.stats.pixelRatio = ratio;
  }

  setQuality(level: QualityLevel): void {
    this.quality = level;
    this.pixelRatioScale = 1;
    this.renderer.shadowMap.enabled = level !== 'low';
    this.resize();
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.clock.start();
    this.frameHandle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
  }

  private readonly tick = (): void => {
    if (!this.running) return;
    this.frameHandle = requestAnimationFrame(this.tick);

    const raw = this.clock.getDelta();
    // 100 ms is a slow frame; anything beyond that is a stall, not gameplay.
    const dt = Math.min(raw, 0.1);
    const started = performance.now();

    this.renderer.info.reset();
    this.onUpdate?.(dt, this.clock.elapsedTime);
    const afterUpdate = performance.now();
    this.renderFrame();
    const finished = performance.now();
    this.lastUpdateMs = afterUpdate - started;
    this.lastRenderMs = finished - afterUpdate;

    this.collectStats(finished - started, raw);
  };

  /**
   * Runs exactly one frame with an explicit delta, outside the rAF loop.
   *
   * Automated verification in a headless or backgrounded browser cannot rely on
   * `requestAnimationFrame`: the pane stops compositing and the loop silently
   * stops, which makes every measurement read as "nothing moved". This lets a
   * test drive the real update path deterministically instead.
   */
  stepOnce(dt: number): void {
    if (this.disposed) return;
    this.renderer.info.reset();
    this.onUpdate?.(dt, (this.stepClock += dt));
    this.renderFrame();
  }

  /**
   * The world, then the first-person overlay on top of it.
   *
   * `clearDepth` between the two is the whole trick: the overlay pass starts
   * with an empty depth buffer, so nothing in the world can occlude it. The
   * colour buffer is deliberately NOT cleared, which is why `autoClear` has to
   * be off for the second render.
   */
  private renderFrame(): void {
    this.renderer.render(this.scene, this.camera);
    if (this.overlayScene.children.length <= this.overlayFixtures) return;
    this.overlayCamera.position.copy(this.camera.position);
    this.overlayCamera.quaternion.copy(this.camera.quaternion);
    // The lights hang off the camera, so its world matrix has to be current
    // before the render walks them.
    this.overlayCamera.updateMatrixWorld(true);
    const autoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.overlayScene, this.overlayCamera);
    this.renderer.autoClear = autoClear;
  }

  private stepClock = 0;

  private collectStats(frameMs: number, rawDelta: number): void {
    this.frameTimes.push(rawDelta);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    // Ignore the first frames: the clock starts cold and the first delta after
    // a start or a context restore is not something the player ever felt.
    if (this.framesSeen > 8 && rawDelta > HITCH_SECONDS) this.stats.hitches += 1;
    this.framesSeen += 1;

    this.statsAccumulator += rawDelta;
    if (this.statsAccumulator < 0.5) return;
    this.statsAccumulator = 0;

    let total = 0;
    for (const t of this.frameTimes) total += t;
    const average = total / Math.max(1, this.frameTimes.length);

    // Percentiles come off a reused scratch array so the stats pass allocates
    // nothing; it runs twice a second for the whole session.
    this.sortedFrameTimes.length = 0;
    for (const t of this.frameTimes) this.sortedFrameTimes.push(t);
    this.sortedFrameTimes.sort((a, b) => a - b);
    const index = Math.min(
      this.sortedFrameTimes.length - 1,
      Math.floor(this.sortedFrameTimes.length * 0.95),
    );

    const info = this.renderer.info;
    this.stats.fps = average > 0 ? 1 / average : 0;
    this.stats.frameMs = frameMs;
    this.stats.updateMs = this.lastUpdateMs;
    this.stats.renderMs = this.lastRenderMs;
    this.stats.bufferWidth = this.canvas.width;
    this.stats.bufferHeight = this.canvas.height;
    this.stats.p95Ms = (this.sortedFrameTimes[index] ?? 0) * 1000;
    this.stats.worstMs = (this.sortedFrameTimes[this.sortedFrameTimes.length - 1] ?? 0) * 1000;
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.programs = info.programs?.length ?? 0;
    this.stats.geometries = info.memory.geometries;
    this.stats.textures = info.memory.textures;

    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    this.stats.memoryMB = perf.memory ? perf.memory.usedJSHeapSize / (1024 * 1024) : null;

    this.adaptResolution();
  }

  /**
   * Nudges the render resolution when the frame rate is clearly off target.
   *
   * Every change here reallocates the drawing buffer and every render target
   * behind it, which is expensive and, on some drivers, worse than the frame
   * it was trying to save. So it is deliberately reluctant: a wide dead band
   * between the thresholds, a minimum interval between changes, and a
   * requirement that the frame rate stays off target for several consecutive
   * samples. An adaptive scale that oscillates costs more than it recovers.
   */
  private adaptResolution(): void {
    const fps = this.stats.fps;
    if (fps <= 0) return;

    const now = performance.now();
    if (now - this.lastResolutionChange < RESOLUTION_COOLDOWN_MS) return;

    if (fps < 45) {
      this.lowSamples += 1;
      this.highSamples = 0;
    } else if (fps > 72) {
      this.highSamples += 1;
      this.lowSamples = 0;
    } else {
      // Comfortably inside the dead band: leave the resolution alone.
      this.lowSamples = 0;
      this.highSamples = 0;
      return;
    }

    const before = this.pixelRatioScale;
    if (this.lowSamples >= 3 && this.pixelRatioScale > 0.62) this.pixelRatioScale -= 0.12;
    else if (this.highSamples >= 6 && this.pixelRatioScale < 1) this.pixelRatioScale += 0.12;
    this.pixelRatioScale = clamp(this.pixelRatioScale, 0.6, 1);

    if (Math.abs(before - this.pixelRatioScale) > 0.001) {
      this.lowSamples = 0;
      this.highSamples = 0;
      this.lastResolutionChange = now;
      this.resize();
    }
  }

  getStats(): Readonly<FrameStats> {
    return this.stats;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    window.removeEventListener('resize', this.onResize);
    this.canvas.removeEventListener('webglcontextlost', this.onWebglContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onWebglContextRestored);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
