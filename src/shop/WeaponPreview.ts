/**
 * The weapon on the counter: a live 3D view of the real asset, in the panel.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   const preview = new WeaponPreview(import.meta.env.BASE_URL);
 *   panel.append(preview.element);   // a <canvas> in normal document flow
 *   preview.select('rifle');         // loads and draws the actual GLB
 *   preview.setActive(true);         // start turning
 *   preview.tick(dt);                // once per frame, from the game loop
 *   preview.dispose();
 *
 * ============================================================================
 *
 * WHY ITS OWN RENDERER. The game's renderer owns one canvas and a 5.76-megapixel
 * frame; borrowing it would mean a scissored second pass, a camera swap and a
 * render-target copy into the DOM every frame the counter is open. A second
 * WebGL context on a 300x210 canvas is one extra context - browsers allow
 * about sixteen - and it keeps the shop's scene graph, its exposure and its
 * environment entirely separate from the city's.
 *
 * WHY NO POINT LIGHTS. Measured at 61% of this game's frame cost, and this is
 * the wrong place to spend it twice over. The metal reads because the scene
 * carries a pre-filtered ENVIRONMENT baked once from a procedural gradient - a
 * studio with two soft boxes, painted into a 128x64 canvas - plus a single
 * directional light for the hard highlight along the barrel. A directional
 * light costs one shader branch and no shadow map; there is no per-light
 * culling, no attenuation and no cube shadow anywhere in this file.
 *
 * WHEN IT DRAWS. Only while the counter is open AND a frame was asked for.
 * `setActive(false)` stops it dead - no renderer call, no matrix update - so a
 * player walking around the city pays nothing at all for the shop's canvas.
 */

import {
  ACESFilmicToneMapping,
  Box3,
  CanvasTexture,
  Color,
  DirectionalLight,
  EquirectangularReflectionMapping,
  Group,
  Mesh,
  Object3D,
  PMREMGenerator,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Sphere,
  Vector3,
  WebGLRenderer,
  type Material,
  type Texture,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { defaultViewmodels } from '../combat/WeaponViewmodel';
import type { WeaponId } from '../player/PlayerState';

/** CSS pixels. The canvas is laid out at this size and rendered to match. */
export const PREVIEW_WIDTH = 300;
export const PREVIEW_HEIGHT = 214;

/** A retina panel is worth two samples; a 3x phone is not worth nine. */
const MAX_PIXEL_RATIO = 2;

/** Radians per second on the turntable. One revolution takes about eleven. */
const TURN_RATE = 0.55;

/**
 * How far to swing an asset past "muzzle down the camera's forward axis".
 *
 * `defaultViewmodels` already carries the rotation that points each model's
 * muzzle where the player is looking, which in this little camera would show
 * the butt plate and nothing else. A quarter turn puts the weapon broadside,
 * and a further 26 degrees opens it into the three-quarter view a catalogue
 * uses, because a flat side elevation hides the receiver and the sights.
 * Everything else - scale, pivot - is measured from the loaded mesh; a
 * generated asset's own transform is never to be trusted.
 */
const DISPLAY_YAW_OFFSET = -Math.PI / 2 + 0.45;

/**
 * How much of a long weapon's wasted frame to give back, per unit of aspect
 * ratio past a pistol's, and the ceiling on it.
 */
const ELONGATION_GAIN = 0.16;
const MAX_ELONGATION_GAIN = 1.55;

interface Entry {
  readonly url: string;
  /** Rotation that lays the model nose-along -Z before the turntable swing. */
  readonly yaw: number;
  /**
   * The viewmodel's colour correction, applied here too.
   *
   * The generator painted the Dock Sweeper's "blued steel" cobalt blue with a
   * cherry-red stock. The held weapon already multiplies that back to gunmetal;
   * the display case has to do the same, or the shop sells a bright blue toy
   * and hands the player a grey shotgun.
   */
  readonly tint: number | undefined;
  object: Object3D | null;
  loading: boolean;
  failed: boolean;
}

export class WeaponPreview {
  /** The canvas. Put it in the panel; it lays out like any other element. */
  readonly element: HTMLCanvasElement;

  private readonly entries = new Map<WeaponId, Entry>();
  private readonly loader = new GLTFLoader();
  private readonly disposables: { dispose(): void }[] = [];

  private renderer: WebGLRenderer | null = null;
  private scene: Scene | null = null;
  private camera: PerspectiveCamera | null = null;
  private readonly pivot = new Group();
  private environment: Texture | null = null;

  private current: WeaponId | null = null;
  private turn = 0;
  private active = false;
  private started = false;
  private broken = false;
  private disposed = false;

  constructor(baseUrl: string) {
    const specs = defaultViewmodels(baseUrl).weapons;
    for (const [id, spec] of Object.entries(specs) as [WeaponId, (typeof specs)[WeaponId]][]) {
      this.entries.set(id, {
        url: spec.url,
        yaw: spec.yaw,
        tint: spec.tint,
        object: null,
        loading: false,
        failed: false,
      });
    }

    this.element = document.createElement('canvas');
    this.element.className = 'mb-shop__preview';
    this.element.width = PREVIEW_WIDTH;
    this.element.height = PREVIEW_HEIGHT;
    this.element.style.width = `${PREVIEW_WIDTH}px`;
    this.element.style.height = `${PREVIEW_HEIGHT}px`;
    // Decorative: the weapon's name, price and stats are all real text beside
    // it, so a screen reader gains nothing from being told a canvas is here.
    this.element.setAttribute('aria-hidden', 'true');
  }

  /** False when WebGL is unavailable, so the panel can hide the canvas. */
  get available(): boolean {
    return !this.broken;
  }

  /** True once the selected weapon's asset is actually on screen. */
  get ready(): boolean {
    const entry = this.current ? this.entries.get(this.current) : undefined;
    return entry?.object != null;
  }

  /** Assets that failed to download. The panel still sells them. */
  get failedCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.failed) n += 1;
    return n;
  }

  /**
   * Shows a weapon. Draws one frame straight away so the panel is never blank
   * for a frame, and so a still capture of a paused page shows the model.
   */
  select(id: WeaponId): void {
    if (this.disposed || this.current === id) return;
    this.current = id;
    // Every weapon starts from the same angle, so moving down the list is a
    // comparison of the weapons and not of whatever phase the turntable is in.
    this.turn = 0;
    this.ensureStarted();
    this.ensureLoaded(id);
    this.mount();
    this.draw();
  }

  /** Starts or stops the turntable. Nothing is rendered while inactive. */
  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (!active) return;
    this.ensureStarted();
    this.draw();
  }

  /** One frame, from the game's own loop. A no-op while the counter is shut. */
  tick(dt: number): void {
    if (this.disposed || !this.active || this.broken) return;
    this.turn += dt * TURN_RATE;
    this.draw();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.pivot.clear();
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.environment?.dispose();
    this.environment = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.entries.clear();
    this.element.remove();
  }

  // -- internals ------------------------------------------------------------

  /**
   * Builds the renderer, the environment and the camera, once, on first use.
   *
   * Deferred rather than done in the constructor because the shop is
   * constructed during the world build and most players never open it: a
   * context and a PMREM pass are not worth paying for a counter nobody walks
   * up to.
   */
  private ensureStarted(): void {
    if (this.started || this.broken) return;
    this.started = true;

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        canvas: this.element,
        antialias: true,
        alpha: true,
        powerPreference: 'low-power',
      });
    } catch {
      // No WebGL, or the browser refused another context. The counter still
      // sells weapons; it just does so without a picture.
      this.broken = true;
      return;
    }

    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
    renderer.setPixelRatio(Math.min(dpr || 1, MAX_PIXEL_RATIO));
    renderer.setSize(PREVIEW_WIDTH, PREVIEW_HEIGHT, false);
    renderer.outputColorSpace = SRGBColorSpace;
    // The same tone curve the city uses, so a weapon does not change colour
    // between the display case and the player's hands.
    renderer.toneMapping = ACESFilmicToneMapping;
    // A touch hotter than the city's 1.15: the panel behind is nearly black
    // and a gun that reads outdoors reads as a silhouette in here.
    renderer.toneMappingExposure = 1.32;
    renderer.shadowMap.enabled = false;
    this.renderer = renderer;

    const scene = new Scene();
    scene.environment = this.bakeEnvironment(renderer);
    // A key light for the hard specular line down the barrel. Directional:
    // no attenuation, no cube map, no per-object light culling.
    const key = new DirectionalLight(0xfff1de, 2.6);
    key.position.set(-1.4, 2.0, 2.2);
    key.castShadow = false;
    scene.add(key);
    // A dim cool fill from behind picks the silhouette off the panel.
    const rim = new DirectionalLight(0x9fc4e8, 1.1);
    rim.position.set(1.8, 0.6, -2.0);
    rim.castShadow = false;
    scene.add(rim);
    scene.add(this.pivot);
    this.scene = scene;

    // Raised and aimed back down at the origin rather than tilting the model:
    // a tilt on the turntable would swing round with it and read as a wobble.
    const camera = new PerspectiveCamera(28, PREVIEW_WIDTH / PREVIEW_HEIGHT, 0.05, 12);
    camera.position.set(0, 0.62, 2.94);
    camera.lookAt(0, 0, 0);
    this.camera = camera;
  }

  /**
   * A studio, painted rather than lit.
   *
   * Two soft boxes and a dark surround drawn into a 128x64 equirectangular
   * canvas, pre-filtered once by `PMREMGenerator`. After this there is no
   * light of any kind behind the reflections: the specular response is a
   * texture lookup, which is what makes gunmetal read as metal for free.
   */
  private bakeEnvironment(renderer: WebGLRenderer): Texture | null {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const ground = ctx.createLinearGradient(0, 0, 0, 64);
    ground.addColorStop(0, '#40484f');
    ground.addColorStop(0.5, '#252b30');
    ground.addColorStop(1, '#0a0d10');
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, 128, 64);

    const box = (x: number, y: number, r: number, colour: string): void => {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
      glow.addColorStop(0, colour);
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    };
    // Warm key, high and to the left; cool rim, low and behind.
    box(34, 14, 32, 'rgba(255, 246, 232, 1)');
    box(96, 30, 28, 'rgba(163, 200, 232, 0.7)');

    const texture = new CanvasTexture(canvas);
    texture.mapping = EquirectangularReflectionMapping;
    texture.colorSpace = SRGBColorSpace;

    const pmrem = new PMREMGenerator(renderer);
    const target = pmrem.fromEquirectangular(texture);
    pmrem.dispose();
    texture.dispose();
    this.environment = target.texture;
    return target.texture;
  }

  private mount(): void {
    this.pivot.clear();
    const object = this.current ? this.entries.get(this.current)?.object : null;
    if (object) this.pivot.add(object);
  }

  private draw(): void {
    if (this.broken) return;
    this.ensureStarted();
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    if (!renderer || !scene || !camera) return;
    this.pivot.rotation.y = this.turn;
    renderer.render(scene, camera);
  }

  private ensureLoaded(id: WeaponId): void {
    const entry = this.entries.get(id);
    if (!entry || entry.object || entry.loading || entry.failed) return;
    entry.loading = true;
    this.loader.load(
      entry.url,
      (gltf) => {
        entry.loading = false;
        if (this.disposed) return;
        entry.object = this.prepare(gltf.scene, entry.yaw, entry.tint);
        if (this.current === id) {
          this.mount();
          this.draw();
        }
      },
      undefined,
      () => {
        entry.loading = false;
        entry.failed = true;
      },
    );
  }

  /**
   * Frames a normalised generated asset in the little camera.
   *
   * Tripo returns a model normalised to 1.0 on its longest axis with a CENTRE
   * pivot and its own node scaling, so the transform is measured rather than
   * trusted - the same discipline `ModelLibrary` applies to the street
   * furniture. Here the target is not a real-world size at all but a bounding
   * sphere the camera can hold, so a pistol and a carbine both fill the panel.
   */
  private prepare(scene: Object3D, yaw: number, tint: number | undefined): Object3D {
    const holder = new Group();
    const inner = new Group();
    inner.add(scene);

    /*
     * Elongation is measured BEFORE the display yaw is applied, and that
     * ordering is the whole of it.
     *
     * The three-quarter view turns the weapon 26 degrees off broadside, so an
     * axis-aligned box taken after the turn spreads the length across two axes
     * and the second-largest number is another projection of the SAME length
     * rather than the weapon's thickness. The shipped 4.6:1 launcher measures
     * 1.6:1 that way and gets essentially no correction at all.
     */
    inner.updateMatrixWorld(true);
    const upright = new Box3().setFromObject(inner);
    const extent = upright.getSize(new Vector3());
    const dimensions = [extent.x, extent.y, extent.z].sort((a, b) => b - a);
    const aspect = (dimensions[1] ?? 0) > 1e-5 ? (dimensions[0] ?? 0) / (dimensions[1] ?? 1) : 1;

    inner.rotation.set(0, yaw + DISPLAY_YAW_OFFSET, 0, 'YXZ');
    inner.updateMatrixWorld(true);

    const box = new Box3().setFromObject(inner);
    const sphere = box.getBoundingSphere(new Sphere());
    // 1.0 is the radius the camera at z = 3 with a 28-degree field frames with
    // a comfortable margin; anything longer than it is wide still fits because
    // the sphere, not the length, is what is normalised.
    //
    // A bounding sphere is the right fit for a compact object and a wasteful
    // one for a long thin object: the launch tube's sphere is set by its
    // length, so the pistol fills the case and the launcher sat in the middle
    // of it at a third the size. `ELONGATION_GAIN` gives back a share of that
    // for the elongated ones only - the pistol's aspect is 1.4 and its frame
    // is unchanged to within four per cent, while a 4.6:1 tube is drawn half
    // as large again. Capped, because at some point the turntable would swing
    // it out of shot. `aspect` is measured above, before the display yaw.
    const gain = Math.min(MAX_ELONGATION_GAIN, 1 + Math.max(0, aspect - 1.4) * ELONGATION_GAIN);
    const scale = sphere.radius > 1e-5 ? (1.15 * gain) / sphere.radius : 1;
    inner.scale.setScalar(scale);
    inner.updateMatrixWorld(true);

    const scaled = new Box3().setFromObject(inner);
    inner.position.sub(scaled.getCenter(new Vector3()));

    holder.add(inner);
    holder.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // The pivot turns; the frustum test would be recomputed every frame for
      // an object that is always dead centre of a 300-pixel canvas.
      mesh.frustumCulled = false;
      const material = mesh.material as Material | Material[];
      for (const item of Array.isArray(material) ? material : [material]) {
        if (tint !== undefined) {
          const tinted = item as Material & { color?: Color };
          tinted.color?.setHex(tint).convertSRGBToLinear();
        }
        this.disposables.push(item);
      }
      if (mesh.geometry) this.disposables.push(mesh.geometry);
    });
    return holder;
  }
}
