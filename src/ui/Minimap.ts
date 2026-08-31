/**
 * Meridian Bay minimap.
 *
 * COORDINATES. One world unit is one metre, +X is east and +Z is south. The map
 * is north-up, so world +X runs right across the map and world +Z runs *down*
 * it. That single fact is what `worldToMap` encodes, and everything else here
 * (the crop, the player arrow, the field-of-view wedge, the labels) is derived
 * from it rather than re-deriving a sign convention of its own.
 *
 * HEADING. The camera yaw convention is forward = `(-sin yaw, 0, -cos yaw)`, so
 * yaw 0 faces north (-Z). In map space that is `(-sin yaw, -cos yaw)` with y
 * pointing down, which is exactly `headingVector`. Yaw 0 therefore points up
 * the map, as it must.
 *
 * COST. The static map - water, roads, pavements, blocks, buildings, landmarks -
 * is rasterised once into an offscreen canvas at a fixed metres-to-pixels scale
 * and never redrawn. A frame costs one `drawImage` of a translated crop plus a
 * handful of path operations for the player marker; the expanded map is the
 * same, against a second cache that also carries its labels and is only rebuilt
 * when the viewport changes. Redrawing the city per frame would cost more than
 * the 3D scene it sits on top of, which is why it is not done.
 *
 * The geometry is kept as pure exported functions so it can be tested without a
 * canvas; the class below is the only part that touches the DOM.
 */

import './ui.css';

import { TAU, type Rect } from '../core/mathx';
import {
  corridorHalfWidth,
  type CityBlock,
  type CityPlan,
  type DistrictId,
  type Parcel,
  type Street,
} from '../world/CityPlan';
import { shorelineX } from '../world/elevation';
import { RUNWAY, TERMINAL } from '../world/airport/layout';
import { pavedRects } from '../world/airport/surfaces';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/**
 * Every colour the map uses, in one place so the whole thing can be retuned
 * without hunting through draw calls. Deliberately desaturated: the only warm
 * note is the accent on the buildings the player can actually walk into.
 *
 * The values are a deliberate lightness ramp, because the street corridors
 * cover roughly 45 per cent of the plan area. Left any lighter they turn the
 * whole city into one bright slab with the buildings reading as holes in it, so
 * the ramp is ground < buildings < carriageway < pavement, with only a few
 * steps of separation between each.
 */
export const MINIMAP_PALETTE = {
  /** Outside the mapped area. */
  beyond: '#090c0f',
  land: '#12171b',
  water: '#0d1720',
  shore: '#2c4653',
  /** Courtyards and service ground inside a block. */
  block: '#171d22',
  park: '#1e2a23',
  plaza: '#2d353b',
  /**
   * The airfield platform. A shade cooler and lighter than a city block, which
   * is what 210,000 square metres of concrete and mown grass looks like next to
   * a street grid; kept inside the palette's 30-point channel spread so it
   * stays as desaturated as every other ground colour.
   */
  airfield: '#1a2126',
  /** Runway, taxiway and apron, drawn over the airfield. */
  airside: '#2b3238',
  /** Carriageway. Darker than the pavement it sits inside. */
  road: '#333c44',
  /** Wider carriageways read a shade brighter so the arterials stand out. */
  arterial: '#3c454e',
  /** Corridor: the pavement either side of the carriageway. */
  pavement: '#444d55',
  building: '#262e35',
  buildingEdge: '#12171b',
  /** Buildings the player can enter. The one warm colour on the map. */
  enterable: '#c8a06a',
  /**
   * The gun store. It gets its own colour and its own shape because the
   * player has to be able to FIND it, and a ring identical to six other rings
   * is not findable - it is only findable once you already know which one.
   */
  gunStore: '#d4574b',
  /** The Vibe's magenta, so a mission marker is never a shop marker. */
  waypoint: '#e24a78',
  landmark: '#93aab8',
  player: '#eef2f4',
  playerEdge: '#0b0f12',
  fov: 'rgba(238, 242, 244, 0.20)',
  label: '#b3bfc7',
  labelDim: '#7d8a93',
  /** Drawn behind label text so it survives crossing a pale road. */
  labelHalo: 'rgba(9, 12, 15, 0.85)',
} as const;

export type MinimapPalette = typeof MINIMAP_PALETTE;

/**
 * Display names for the plan's district ids, used on the expanded map and
 * available to the HUD readout so the two can never disagree about a place.
 */
export const DISTRICT_LABELS: Readonly<Record<DistrictId, string>> = {
  harbourside: 'Harbourside',
  cannery: 'The Cannery',
  oldQuarter: 'Old Quarter',
  core: 'Meridian Core',
  civic: 'Lantern Park',
  ridge: 'Ridge Terraces',
  airport: 'Meridian Bay Regional',
};

// ---------------------------------------------------------------------------
// Geometry - pure, canvas-free, unit-testable
// ---------------------------------------------------------------------------

/** A point in map pixels: +x right, +y down. */
export interface MapPoint {
  readonly x: number;
  readonly y: number;
}

/** The world rectangle the static map covers. */
export interface MapBounds {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly width: number;
  readonly depth: number;
}

/** Metres of empty ground kept around the built city. */
export const MAP_MARGIN = 28;

/**
 * Pixels per metre in the offscreen static layer. Chosen so the layer is sharp
 * when downsampled into the ~190 px dial and still acceptable when scaled up to
 * the expanded map, without the memory cost of a 4 px/m raster.
 *
 * It is a CEILING, not the scale: see `staticScaleFor`.
 */
export const STATIC_SCALE = 3.2;

/**
 * Ceiling on the offscreen static layer, in pixels.
 *
 * It matters because the map covers the plan, and the plan grew from 427 by
 * 362 m to 694 by 1,191 m when Meridian Bay Regional was added: at a flat
 * 3.2 px/m that is 2,221 by 3,811 px, 8.5 megapixels, 34 MB - allocated
 * eagerly in the constructor, on a device that may not have it.
 *
 * RAISED FROM 3 MP (1.94 px/m, 12 MB) when the expanded map was allowed to
 * fill the viewport. The old ceiling was chosen against an expanded map that
 * was at most 780 CSS px tall; a full-height map on a 1440p Retina display
 * asks for about 2.05 device px/m, which 1.94 could only meet by upscaling a
 * raster the player is now looking at closely. 4.5 MP is 2.33 px/m and 18 MB,
 * which covers every viewport the sizing below can produce without upscaling
 * and is still a fraction of what the city's textures already hold.
 */
const STATIC_PIXEL_BUDGET = 4_500_000;

/**
 * Pixels per metre for a given map, capped by the budget above.
 *
 * At the enlarged bounds this returns 2.33 px/m, which is above what either
 * view asks for: the dial shows about 120 m across ~190 CSS px, which is
 * 1.6 px/m, and the expanded map's worst case is the ~2.05 px/m above. The cap
 * costs nothing visible and saves 16 MB against a flat 3.2.
 */
export function staticScaleFor(bounds: MapBounds): number {
  const area = bounds.width * bounds.depth;
  if (area <= 0) return STATIC_SCALE;
  return Math.min(STATIC_SCALE, Math.sqrt(STATIC_PIXEL_BUDGET / area));
}

/** Field of view of the wedge drawn from the player marker. */
export const FOV_DEGREES = 70;

/** World-space extent of a street corridor, pavements included. */
export function streetExtent(street: Street): Rect {
  const half = corridorHalfWidth(street);
  return street.axis === 'x'
    ? {
        minX: street.position - half,
        maxX: street.position + half,
        minZ: street.from,
        maxZ: street.to,
      }
    : {
        minX: street.from,
        maxX: street.to,
        minZ: street.position - half,
        maxZ: street.position + half,
      };
}

/**
 * The world rectangle the map covers: everything in the plan plus a margin.
 * Not squared off - the dial crops a square out of it and the expanded map
 * keeps the aspect, so forcing a square here would only waste texture memory.
 */
export function mapBoundsFor(plan: CityPlan, margin: number = MAP_MARGIN): MapBounds {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;

  const include = (rect: Rect): void => {
    if (rect.minX < minX) minX = rect.minX;
    if (rect.minZ < minZ) minZ = rect.minZ;
    if (rect.maxX > maxX) maxX = rect.maxX;
    if (rect.maxZ > maxZ) maxZ = rect.maxZ;
  };

  for (const street of plan.streets) include(streetExtent(street));
  for (const block of plan.blocks) include(block.rect);
  for (const parcel of plan.parcels) include(parcel.rect);
  for (const landmark of plan.landmarks) {
    include({ minX: landmark.x, maxX: landmark.x, minZ: landmark.z, maxZ: landmark.z });
  }

  const padded = {
    minX: minX - margin,
    minZ: minZ - margin,
    maxX: maxX + margin,
    maxZ: maxZ + margin,
  };
  return {
    ...padded,
    width: padded.maxX - padded.minX,
    depth: padded.maxZ - padded.minZ,
  };
}

/**
 * Projects a world point onto the map. `scale` is pixels per metre.
 * +X (east) goes right, +Z (south) goes down: a north-up map.
 */
export function worldToMap(
  x: number,
  z: number,
  bounds: MapBounds,
  scale: number = STATIC_SCALE,
): MapPoint {
  return { x: (x - bounds.minX) * scale, y: (z - bounds.minZ) * scale };
}

/** Unit heading in map space for a camera yaw. Yaw 0 faces north, i.e. up. */
export function headingVector(yaw: number): MapPoint {
  return { x: -Math.sin(yaw), y: -Math.cos(yaw) };
}

/**
 * The field-of-view wedge, in map pixels relative to the player.
 *
 * Element 0 is the apex at the player; the rest is the arc, swept symmetrically
 * about `headingVector(yaw)`. This is the clearest reading of which way the
 * player is looking, which is why it is drawn rather than the arrow alone.
 */
export function fovWedgePoints(
  yaw: number,
  radius: number,
  fovDegrees: number = FOV_DEGREES,
  segments = 12,
): MapPoint[] {
  const heading = headingVector(yaw);
  const centre = Math.atan2(heading.y, heading.x);
  const half = ((fovDegrees * Math.PI) / 180) * 0.5;
  const steps = Math.max(2, Math.floor(segments));
  const points: MapPoint[] = [{ x: 0, y: 0 }];
  for (let i = 0; i <= steps; i += 1) {
    const angle = centre - half + (2 * half * i) / steps;
    points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return points;
}

/** The buildings the player can walk into. */
export function enterableParcels(plan: CityPlan): readonly Parcel[] {
  return plan.parcels.filter((parcel) => parcel.enterable);
}

/** Streets worth naming on the expanded map. */
export function labelledStreets(plan: CityPlan): readonly Street[] {
  return plan.streets.filter(
    (street) => street.kind === 'arterial' || street.kind === 'promenade',
  );
}

/** Label anchor for each district: the centre of the ground it covers. */
export function districtAnchors(plan: CityPlan): { district: DistrictId; x: number; z: number }[] {
  const sums = new Map<DistrictId, { x: number; z: number; weight: number }>();
  for (const block of plan.blocks) {
    const entry = sums.get(block.district) ?? { x: 0, z: 0, weight: 0 };
    const area = (block.rect.maxX - block.rect.minX) * (block.rect.maxZ - block.rect.minZ);
    entry.x += ((block.rect.minX + block.rect.maxX) * 0.5) * area;
    entry.z += ((block.rect.minZ + block.rect.maxZ) * 0.5) * area;
    entry.weight += area;
    sums.set(block.district, entry);
  }
  const out: { district: DistrictId; x: number; z: number }[] = [];
  for (const [district, entry] of sums) {
    if (entry.weight <= 0) continue;
    out.push({ district, x: entry.x / entry.weight, z: entry.z / entry.weight });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The widget
// ---------------------------------------------------------------------------

export interface MinimapOptions {
  /** Diameter of the corner dial in CSS pixels. */
  size?: number;
  /** Metres of world per CSS pixel in the dial. Smaller means closer in. */
  metresPerPixel?: number;
}

const DEFAULT_SIZE = 190;
const DEFAULT_METRES_PER_PIXEL = 1.3;
/**
 * How much of the viewport the expanded map is allowed to take.
 *
 * MERIDIAN BAY IS A TALL, NARROW CITY: 694 m across against 1,191 m from the
 * north shore to the far end of the airfield, an aspect of 0.58. Anything that
 * sizes the map from the SMALLER viewport axis therefore throws away most of a
 * landscape screen - the previous rule (0.62 of the short axis, capped at
 * 780 px) put a 454 by 779 px strip in the middle of a 1,996 by 1,256 window
 * and the street labels were genuinely unreadable.
 *
 * So the map is sized from the axis that actually binds. Height leads, because
 * that is the long side of the city and the short side of a monitor; width is
 * a second constraint for the rare tall window. There is no absolute pixel cap
 * any more - a bigger screen should get a bigger map - only the device-pixel
 * budget below, which is about the canvas allocation rather than the layout.
 */
const EXPANDED_HEIGHT_FRACTION = 0.88;
const EXPANDED_WIDTH_FRACTION = 0.92;
/** Room left under the map for the caption, in CSS pixels. */
const EXPANDED_CAPTION_SPACE = 46;
/**
 * Ceiling on the expanded canvas's backing store, in device pixels.
 *
 * The canvas is reallocated on resize and repainted whole whenever the layout
 * changes, so an unbounded one on a 5K display would be a 30 MP allocation for
 * a map nobody can resolve that finely. 5 MP covers a full-height map at
 * device pixel ratio 2 on a 1440p screen with room to spare.
 */
const EXPANDED_PIXEL_BUDGET = 5_000_000;

/**
 * Zoom steps for the expanded map, where 1 fits the whole plan.
 *
 * WHY THE WHOLE PLAN IS NOT A USABLE DEFAULT. The bounds run from the north
 * shore to the far end of Meridian Bay Regional - 1,191 m, of which the built
 * city is the top third and the rest is runway, apron and grass. Fitted to a
 * screen, downtown gets about 200 px of height for six districts and every
 * street label lands on top of its neighbour. That is the "I cannot see
 * anything" the map was reported with, and no amount of extra canvas fixes it,
 * because the problem is the SCALE, not the size.
 *
 * So the map opens at a scale a street name survives, centred on the player,
 * and zooming out to the whole plan is a step rather than the only view.
 */
const EXPANDED_ZOOMS: readonly number[] = [1, 1.8, 3.2, 5.5];
/** 3.2: about 215 by 370 m on screen, which is a district and its neighbours. */
const DEFAULT_ZOOM_INDEX = 2;
/**
 * How far the player may drift, as a fraction of the visible window, before
 * the cached raster is repainted around them.
 *
 * The cache holds the streets, the buildings and every label, so repainting it
 * is not free; the player is also usually standing still while reading a map.
 * An eighth of a window keeps the view centred without repainting on a walk
 * pace, and at zoom 1 the window covers the plan and this never fires at all.
 */
const RECENTRE_FRACTION = 0.125;
const MAX_DPR = 2;

/** The world rectangle the expanded map is showing. */
interface MapWindow {
  readonly minX: number;
  readonly minZ: number;
  readonly width: number;
  readonly depth: number;
}
/** Published on <body> while the map is open so other layers can stand back. */
const BODY_MAP_OPEN = 'mb-map-open';

function clampRange(value: number, low: number, high: number): number {
  // `high` can fall below `low` if the window is wider than the plan, which is
  // what zoom 1 does on the short axis. Low wins: the plan is fully shown.
  if (high <= low) return low;
  return value < low ? low : value > high ? high : value;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Minimap requires a 2D canvas context');
  return ctx;
}

export class Minimap {
  /** The element to append to the DOM. A full-screen, click-through layer. */
  readonly element: HTMLElement;

  private readonly plan: CityPlan;
  /**
   * Where the mission is pointing, in world metres, or null.
   *
   * Held here rather than passed into `update` because it changes about four
   * times in a session and the frame loop should not be carrying it.
   */
  private waypoint: { readonly x: number; readonly z: number } | null = null;
  private readonly bounds: MapBounds;
  /** Pixels per metre in `staticLayer`, capped against the pixel budget. */
  private readonly staticScale: number;
  private readonly size: number;
  private readonly metresPerPixel: number;

  private readonly staticLayer: HTMLCanvasElement;
  private readonly dial: HTMLCanvasElement;
  private readonly dialCtx: CanvasRenderingContext2D;
  private readonly overlay: HTMLElement;
  private readonly overlayCanvas: HTMLCanvasElement;
  private readonly overlayCtx: CanvasRenderingContext2D;
  /** Static map plus labels, rasterised at the expanded map's display size. */
  private readonly expandedCache: HTMLCanvasElement;

  private dpr = 1;
  private expandedWidth = 0;
  private expandedHeight = 0;
  private isExpanded = false;
  private disposed = false;
  /**
   * Where the city is being painted TO, in the units of whatever canvas is
   * being filled. The static raster and the expanded map share every drawing
   * routine below and differ only in this transform, so it is state on the
   * object rather than an argument threaded through fifteen call sites.
   */
  private paintOriginX = 0;
  private paintOriginZ = 0;
  private paintScale = 1;
  /** Which of `EXPANDED_ZOOMS` the expanded map is showing. */
  private zoomIndex = DEFAULT_ZOOM_INDEX;
  /** The window the cached raster was painted for, or null if it is stale. */
  private cachedWindow: MapWindow | null = null;

  private playerX = 0;
  private playerZ = 0;
  private playerYaw = 0;
  private dirty = true;

  private readonly onResize = (): void => {
    this.layout();
    this.dirty = true;
    this.render();
  };

  constructor(plan: CityPlan, options?: MinimapOptions) {
    this.plan = plan;
    this.bounds = mapBoundsFor(plan);
    this.staticScale = staticScaleFor(this.bounds);
    this.size = Math.max(120, Math.round(options?.size ?? DEFAULT_SIZE));
    this.metresPerPixel = Math.max(0.4, options?.metresPerPixel ?? DEFAULT_METRES_PER_PIXEL);

    this.staticLayer = document.createElement('canvas');
    this.staticLayer.width = Math.ceil(this.bounds.width * this.staticScale);
    this.staticLayer.height = Math.ceil(this.bounds.depth * this.staticScale);
    this.buildStaticLayer(context2d(this.staticLayer));

    this.element = document.createElement('div');
    this.element.className = 'mb-minimap-layer';

    const dialBox = document.createElement('div');
    dialBox.className = 'mb-minimap';
    dialBox.style.setProperty('--mb-minimap-size', `${this.size}px`);

    this.dial = document.createElement('canvas');
    this.dial.className = 'mb-minimap__canvas';
    this.dialCtx = context2d(this.dial);

    // Bezel and the north tick. Both are chrome only: the map is north-up, so
    // the tick never moves and neither needs to be touched again.
    const frame = document.createElement('div');
    frame.className = 'mb-minimap__frame';
    const north = document.createElement('span');
    north.className = 'mb-minimap__north';
    north.textContent = 'N';

    dialBox.append(this.dial, frame, north);

    this.overlay = document.createElement('div');
    this.overlay.className = 'mb-map';
    this.overlay.setAttribute('aria-hidden', 'true');
    const sheet = document.createElement('div');
    sheet.className = 'mb-map__sheet';
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.className = 'mb-map__canvas';
    this.overlayCtx = context2d(this.overlayCanvas);
    const caption = document.createElement('p');
    caption.className = 'mb-map__caption';
    caption.textContent = 'Meridian Bay — scroll to zoom, M to close';
    sheet.append(this.overlayCanvas, caption);
    this.overlay.append(sheet);

    this.expandedCache = document.createElement('canvas');

    this.element.append(dialBox, this.overlay);

    this.layout();
    window.addEventListener('resize', this.onResize, { passive: true });
    this.render();
  }

  get expanded(): boolean {
    return this.isExpanded;
  }

  /**
   * Steps the expanded map's zoom. Positive zooms in, negative zooms out.
   *
   * Returns whether anything moved, so a caller can decide whether the step
   * was worth a click of feedback. A no-op at either end of the ladder.
   */
  zoomBy(steps: number): boolean {
    if (!this.isExpanded || this.disposed || steps === 0) return false;
    const next = clampRange(this.zoomIndex + Math.sign(steps), 0, EXPANDED_ZOOMS.length - 1);
    if (next === this.zoomIndex) return false;
    this.zoomIndex = next;
    this.cachedWindow = null;
    this.dirty = true;
    this.render();
    return true;
  }

  /** Metres per screen pixel the expanded map is currently showing. */
  get zoom(): number {
    return EXPANDED_ZOOMS[this.zoomIndex] ?? 1;
  }

  setExpanded(expanded: boolean): void {
    if (this.isExpanded === expanded || this.disposed) return;
    this.isExpanded = expanded;
    // Repaint around wherever the player is now, not wherever they were when
    // the map was last closed.
    if (expanded) this.cachedWindow = null;
    this.element.classList.toggle('is-expanded', expanded);
    this.overlay.setAttribute('aria-hidden', expanded ? 'false' : 'true');
    // The HUD is a separate layer with no reference to this one, so the state
    // is published on <body> and ui.css quietens the chrome that would
    // otherwise sit on top of the open map.
    document.body.classList.toggle(BODY_MAP_OPEN, expanded);
    if (expanded) this.layoutExpanded();
    this.dirty = true;
    this.render();
  }

  /** Called every frame. Cheap: one blit plus the marker. */
  update(x: number, z: number, yaw: number): void {
    if (this.disposed) return;
    if (x === this.playerX && z === this.playerZ && yaw === this.playerYaw && !this.dirty) return;
    this.playerX = x;
    this.playerZ = z;
    this.playerYaw = yaw;
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    document.body.classList.remove(BODY_MAP_OPEN);
    // Release the raster memory; a detached canvas of 0x0 frees its backing store.
    this.staticLayer.width = 0;
    this.staticLayer.height = 0;
    this.expandedCache.width = 0;
    this.expandedCache.height = 0;
    this.element.remove();
  }

  // -- layout ---------------------------------------------------------------

  private layout(): void {
    this.dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const device = Math.round(this.size * this.dpr);
    if (this.dial.width !== device || this.dial.height !== device) {
      this.dial.width = device;
      this.dial.height = device;
    }
    this.dial.style.width = `${this.size}px`;
    this.dial.style.height = `${this.size}px`;
    this.layoutExpanded();
  }

  private layoutExpanded(): void {
    const aspect = this.bounds.width / this.bounds.depth;
    // A viewport can read as zero while the page is still coming up or while
    // the tab is hidden; falling back keeps the map from baking a 1x1 canvas
    // it would then have to be told to rebuild.
    const viewWidth = Math.max(320, window.innerWidth || 0);
    const viewHeight = Math.max(240, window.innerHeight || 0);

    // Height first: the city is taller than it is wide, so on any landscape
    // window this is the constraint that binds. The caption sits below the
    // canvas inside the same column, so its space comes off the top.
    let cssHeight = Math.max(240, viewHeight * EXPANDED_HEIGHT_FRACTION - EXPANDED_CAPTION_SPACE);
    let cssWidth = cssHeight * aspect;
    const maxWidth = viewWidth * EXPANDED_WIDTH_FRACTION;
    if (cssWidth > maxWidth) {
      cssWidth = maxWidth;
      cssHeight = cssWidth / aspect;
    }

    // Keep the allocation bounded without changing the layout: shrinking the
    // backing store below the CSS size would blur the map, so the CSS size is
    // scaled down with it and both stay in proportion.
    const budgetScale = Math.min(
      1,
      Math.sqrt(EXPANDED_PIXEL_BUDGET / Math.max(1, cssWidth * cssHeight * this.dpr * this.dpr)),
    );
    cssWidth *= budgetScale;
    cssHeight *= budgetScale;

    const width = Math.max(1, Math.round(cssWidth * this.dpr));
    const height = Math.max(1, Math.round(cssHeight * this.dpr));
    this.overlayCanvas.style.width = `${Math.round(cssWidth)}px`;
    this.overlayCanvas.style.height = `${Math.round(cssHeight)}px`;
    if (this.overlayCanvas.width !== width || this.overlayCanvas.height !== height) {
      this.overlayCanvas.width = width;
      this.overlayCanvas.height = height;
    }
    if (this.expandedWidth !== width || this.expandedHeight !== height) {
      this.expandedWidth = width;
      this.expandedHeight = height;
      // Repainted on the next render, which is the only place that knows
      // which window the player is looking at.
      this.cachedWindow = null;
    }
  }

  // -- per-frame ------------------------------------------------------------

  private render(): void {
    this.dirty = false;
    if (this.isExpanded) this.renderExpanded();
    else this.renderDial();
  }

  private renderDial(): void {
    const ctx = this.dialCtx;
    const side = this.dial.width;
    if (side === 0) return;
    const radius = side * 0.5;
    const span = this.size * this.metresPerPixel * this.staticScale * this.dpr;
    // Source crop in static-layer pixels, centred on the player.
    const centre = worldToMap(this.playerX, this.playerZ, this.bounds, this.staticScale);
    const sourceSpan = span / this.dpr;

    ctx.save();
    ctx.clearRect(0, 0, side, side);
    ctx.beginPath();
    ctx.arc(radius, radius, radius, 0, TAU);
    ctx.clip();
    ctx.fillStyle = MINIMAP_PALETTE.beyond;
    ctx.fillRect(0, 0, side, side);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      this.staticLayer,
      centre.x - sourceSpan * 0.5,
      centre.y - sourceSpan * 0.5,
      sourceSpan,
      sourceSpan,
      0,
      0,
      side,
      side,
    );
    // Markers ride on top at a fixed screen size, and anything outside the
    // crop is pinned to the rim so it still points the way.
    const originX = centre.x - sourceSpan * 0.5;
    const originY = centre.y - sourceSpan * 0.5;
    const k = side / sourceSpan;
    const project = (wx: number, wz: number): MapPoint => {
      const m = worldToMap(wx, wz, this.bounds, this.staticScale);
      return { x: (m.x - originX) * k, y: (m.y - originY) * k };
    };
    this.drawMarkers(ctx, project, this.dpr, {
      cx: radius,
      cy: radius,
      radius: radius - 9 * this.dpr,
    });
    this.drawPlayer(ctx, radius, radius, this.dpr, 30);
    ctx.restore();
  }

  /**
   * Draws the whole-city map into somebody else's canvas.
   *
   * The pause menu's Map tab needs the same picture the `M` overlay shows, and
   * cannot simply borrow that overlay: it is a full-screen layer at z-index 30
   * and the pause menu sits at 60, so it would be drawn behind the menu.
   *
   * This shares the cached static layer with the overlay - the city is
   * rasterised once at start-up and never redrawn - so the cost is one
   * `drawImage` plus the markers, whatever it is drawn into. The caller owns
   * the canvas and its size; the aspect it should use is `mapAspect`.
   */
  drawInto(canvas: HTMLCanvasElement): void {
    if (this.disposed) return;
    const { width, height } = canvas;
    if (width === 0 || height === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    /*
     * The pause tab always shows the WHOLE plan, whatever zoom the `M` overlay
     * is on: it is an orientation view inside a menu, not a map the player is
     * navigating with, and a zoomed pane with no way to zoom it would only
     * raise the question of where the rest of the city went.
     */
    const whole: MapWindow = {
      minX: this.bounds.minX,
      minZ: this.bounds.minZ,
      width: this.bounds.width,
      depth: this.bounds.depth,
    };
    if (
      this.expandedCache.width !== width ||
      this.expandedCache.height !== height ||
      !this.cacheCoversWindow(whole)
    ) {
      /*
       * Painted at the CALLER's size, and the overlay's own layout is left
       * alone. The two views share one cache, so whichever painted last owns
       * it and the other rebuilds on its next frame - which is correct, and is
       * why neither may write the other's dimensions.
       */
      this.buildExpandedCache(width, height, whole);
    }
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.expandedCache, 0, 0);
    const project = this.expandedProjector(whole, width);
    const point = project(this.playerX, this.playerZ);
    this.drawPlayer(ctx, point.x, point.y, this.dpr * 1.35, 30);
    this.drawMarkers(ctx, project, this.dpr);
  }

  /** Width over depth of the whole-city map, for sizing a canvas to hold it. */
  get mapAspect(): number {
    return this.bounds.width / this.bounds.depth;
  }

  private renderExpanded(): void {
    const ctx = this.overlayCtx;
    const { width, height } = this.overlayCanvas;
    if (width === 0 || height === 0) return;
    const window = this.expandedWindow();
    if (
      this.expandedCache.width !== width ||
      this.expandedCache.height !== height ||
      !this.cacheCoversWindow(window)
    ) {
      this.buildExpandedCache(width, height, window);
    }
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.expandedCache, 0, 0);
    // The cache may be up to RECENTRE_FRACTION out of date, so the marker is
    // placed against the window it was actually painted for. Anything else and
    // the arrow drifts off the street it is standing on.
    const project = this.expandedProjector(this.cachedWindow ?? window, width);
    const point = project(this.playerX, this.playerZ);
    // A shade larger than on the dial: the marker has a whole city around it
    // here and would otherwise be lost among the streets.
    this.drawPlayer(ctx, point.x, point.y, this.dpr * 1.35, 30);
  }

  /** The player arrow and its field-of-view wedge, drawn at (cx, cy). */
  private drawPlayer(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    scale: number,
    reach: number,
  ): void {
    const radius = reach * scale;
    const wedge = fovWedgePoints(this.playerYaw, radius);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (let i = 1; i < wedge.length; i += 1) {
      const point = wedge[i];
      if (!point) continue;
      ctx.lineTo(cx + point.x, cy + point.y);
    }
    ctx.closePath();
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, MINIMAP_PALETTE.fov);
    gradient.addColorStop(1, 'rgba(238, 242, 244, 0)');
    ctx.fillStyle = gradient;
    ctx.fill();

    const heading = headingVector(this.playerYaw);
    const px = -heading.y;
    const py = heading.x;
    const nose = 8.2 * scale;
    const tail = 5.4 * scale;
    const wing = 5.0 * scale;
    ctx.beginPath();
    ctx.moveTo(cx + heading.x * nose, cy + heading.y * nose);
    ctx.lineTo(cx - heading.x * tail + px * wing, cy - heading.y * tail + py * wing);
    ctx.lineTo(cx - heading.x * tail * 0.42, cy - heading.y * tail * 0.42);
    ctx.lineTo(cx - heading.x * tail - px * wing, cy - heading.y * tail - py * wing);
    ctx.closePath();
    ctx.fillStyle = MINIMAP_PALETTE.player;
    ctx.fill();
    ctx.lineWidth = 1.1 * scale;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = MINIMAP_PALETTE.playerEdge;
    ctx.stroke();
    ctx.restore();
  }

  // -- static raster --------------------------------------------------------

  private toStatic(x: number, z: number): MapPoint {
    return { x: (x - this.paintOriginX) * this.paintScale, y: (z - this.paintOriginZ) * this.paintScale };
  }

  private fillRect(ctx: CanvasRenderingContext2D, rect: Rect, colour: string): void {
    const a = this.toStatic(rect.minX, rect.minZ);
    const b = this.toStatic(rect.maxX, rect.maxZ);
    ctx.fillStyle = colour;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }

  /** Whether a world rectangle can contribute anything to the current paint. */
  private visible(rect: Rect, window: MapWindow): boolean {
    return (
      rect.maxX >= window.minX &&
      rect.minX <= window.minX + window.width &&
      rect.maxZ >= window.minZ &&
      rect.minZ <= window.minZ + window.depth
    );
  }

  /** Rasterises the whole plan once, for the dial to crop out of. */
  private buildStaticLayer(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.staticLayer;
    this.setPaint(this.bounds.minX, this.bounds.minZ, this.staticScale);
    this.paintCity(ctx, width, height, {
      minX: this.bounds.minX,
      minZ: this.bounds.minZ,
      width: this.bounds.width,
      depth: this.bounds.depth,
    });
  }

  /** Points the drawing routines below at a canvas. */
  private setPaint(originX: number, originZ: number, scale: number): void {
    this.paintOriginX = originX;
    this.paintOriginZ = originZ;
    this.paintScale = scale;
  }

  /**
   * Draws the city into whatever the paint transform currently points at.
   *
   * Order is water, corridors, carriageways, block interiors, buildings - each
   * layer only ever sits inside the gap the previous one left, so nothing is
   * overpainted by accident.
   *
   * THIS IS DRAWN, NOT SCALED. The expanded map used to blow the static raster
   * up with `drawImage`, which put a hard ceiling on how far it could be zoomed
   * before the streets turned to mush. Painting the same vectors at the
   * viewport's own scale has no such ceiling, and with the window cull below it
   * is CHEAPER than the full-plan raster at every zoom above 1 - a zoomed view
   * touches a fraction of the 1,900 parcels.
   *
   * NOTE: markers are deliberately NOT baked here. They are drawn per view at a
   * fixed size in screen pixels, because a marker baked at world scale shrank
   * with the zoom: the gun-store pin measured THREE pixels on the expanded map.
   * See `drawMarkers`.
   */
  private paintCity(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    window: MapWindow,
  ): void {
    ctx.fillStyle = MINIMAP_PALETTE.land;
    ctx.fillRect(0, 0, width, height);

    this.drawBay(ctx, width, window);

    for (const street of this.plan.streets) {
      const extent = streetExtent(street);
      if (!this.visible(extent, window)) continue;
      this.fillRect(ctx, extent, MINIMAP_PALETTE.pavement);
    }
    for (const street of this.plan.streets) {
      const half = street.roadHalf;
      const rect: Rect =
        street.axis === 'x'
          ? {
              minX: street.position - half,
              maxX: street.position + half,
              minZ: street.from,
              maxZ: street.to,
            }
          : {
              minX: street.from,
              maxX: street.to,
              minZ: street.position - half,
              maxZ: street.position + half,
            };
      if (!this.visible(rect, window)) continue;
      this.fillRect(
        ctx,
        rect,
        street.kind === 'arterial' ? MINIMAP_PALETTE.arterial : MINIMAP_PALETTE.road,
      );
    }

    for (const block of this.plan.blocks) {
      if (this.visible(block.rect, window)) this.drawBlock(ctx, block);
    }
    this.drawAirside(ctx, window);
    for (const parcel of this.plan.parcels) {
      if (this.visible(parcel.rect, window)) this.drawParcel(ctx, parcel);
    }
  }

  /** The bay: everything west of the shoreline curve. */
  private drawBay(ctx: CanvasRenderingContext2D, width: number, window: MapWindow): void {
    // Sampled in WORLD metres so the shoreline keeps its shape at every zoom,
    // and only across the window so a zoomed view does not walk a kilometre of
    // coast it cannot show. The polygon is closed off the left edge of the
    // canvas, which is west of the shore at every scale the map allows.
    const step = 3;
    const from = window.minZ - step;
    const to = window.minZ + window.depth + step;
    ctx.beginPath();
    ctx.moveTo(-width, this.toStatic(0, from).y);
    for (let z = from; z <= to; z += step) {
      const point = this.toStatic(shorelineX(z), z);
      ctx.lineTo(point.x, point.y);
    }
    ctx.lineTo(-width, this.toStatic(0, to).y);
    ctx.closePath();
    ctx.fillStyle = MINIMAP_PALETTE.water;
    ctx.fill();
    ctx.strokeStyle = MINIMAP_PALETTE.shore;
    ctx.lineWidth = Math.max(1, this.paintScale * 0.6);
    ctx.stroke();
  }

  private drawBlock(ctx: CanvasRenderingContext2D, block: CityBlock): void {
    const colour =
      block.kind === 'park'
        ? MINIMAP_PALETTE.park
        : block.kind === 'plaza'
          ? MINIMAP_PALETTE.plaza
          : block.kind === 'airfield'
            ? MINIMAP_PALETTE.airfield
            : MINIMAP_PALETTE.block;
    this.fillRect(ctx, block.rect, colour);
  }

  /**
   * Runway, taxiway, apron and terminal, drawn over the airfield block.
   *
   * Read straight out of `airport/plan.ts` rather than restated, so the shape
   * on the map is the shape on the ground. Without it the airport is a grey
   * rectangle 200 m across and the player has no way to tell which end of it
   * the runway is.
   */
  private drawAirside(ctx: CanvasRenderingContext2D, window: MapWindow): void {
    ctx.fillStyle = MINIMAP_PALETTE.airside;
    for (const paved of pavedRects()) {
      if (paved.key !== 'concrete') continue;
      if (!this.visible(paved.rect, window)) continue;
      const a = this.toStatic(paved.rect.minX, paved.rect.minZ);
      const b = this.toStatic(paved.rect.maxX, paved.rect.maxZ);
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
    // The runway centreline, so its direction is unmistakable at dial scale.
    const a = this.toStatic(RUNWAY.centreX, RUNWAY.northZ);
    const b = this.toStatic(RUNWAY.centreX, RUNWAY.southZ);
    ctx.strokeStyle = MINIMAP_PALETTE.label;
    ctx.lineWidth = Math.max(1, this.paintScale * 0.6);
    ctx.setLineDash([this.paintScale * 8, this.paintScale * 6]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    // The terminal, in the enterable accent: it is the one building here the
    // player can walk into.
    const t0 = this.toStatic(TERMINAL.minX, TERMINAL.minZ);
    const t1 = this.toStatic(TERMINAL.maxX, TERMINAL.maxZ);
    ctx.fillStyle = MINIMAP_PALETTE.enterable;
    ctx.fillRect(t0.x, t0.y, t1.x - t0.x, t1.y - t0.y);
  }

  private drawParcel(ctx: CanvasRenderingContext2D, parcel: Parcel): void {
    const a = this.toStatic(parcel.rect.minX, parcel.rect.minZ);
    const b = this.toStatic(parcel.rect.maxX, parcel.rect.maxZ);
    const w = b.x - a.x;
    const h = b.y - a.y;
    ctx.fillStyle = parcel.enterable ? MINIMAP_PALETTE.enterable : MINIMAP_PALETTE.building;
    ctx.fillRect(a.x, a.y, w, h);
    // A hairline between neighbours, otherwise a terrace reads as one long slab.
    ctx.strokeStyle = MINIMAP_PALETTE.buildingEdge;
    ctx.lineWidth = 0.9;
    ctx.strokeRect(a.x + 0.45, a.y + 0.45, w - 0.9, h - 0.9);
  }

  /**
   * Draws every marker at a FIXED SIZE IN SCREEN PIXELS, on top of whatever
   * view is being composited.
   *
   * `project` maps world metres to that view's pixels. `edge`, when given,
   * clamps a marker that falls outside the view onto a ring of that radius
   * around the centre, so an off-screen gun store still tells the player which
   * way to walk instead of silently not existing.
   */
  /**
   * Points the map at somewhere, or clears it.
   *
   * REDRAWS BOTH VIEWS, and throws away the expanded map's cache.
   *
   * The waypoint moves when the mission stage changes, which usually happens
   * while the player is standing still listening to somebody - and `update`
   * returns early when nothing has moved. Worse, the pin is painted into the
   * full map's cached raster along with the streets and the district names,
   * which is only rebuilt when the viewport size changes. Without both of
   * these the dial kept pointing at the last destination until the player
   * turned their head, and the full map kept pointing at it until they resized
   * the window.
   */
  setWaypoint(waypoint: { readonly x: number; readonly z: number } | null): void {
    const same =
      (this.waypoint === null && waypoint === null) ||
      (this.waypoint !== null &&
        waypoint !== null &&
        this.waypoint.x === waypoint.x &&
        this.waypoint.z === waypoint.z);
    if (same) return;
    this.waypoint = waypoint;
    if (this.disposed) return;
    // A zero-width canvas fails the size check in `renderExpanded`, which is
    // what makes it rebuild - and frees the old raster on the way.
    this.expandedCache.width = 0;
    this.expandedCache.height = 0;
    this.dirty = true;
    this.render();
  }

  private drawMarkers(
    ctx: CanvasRenderingContext2D,
    project: (x: number, z: number) => MapPoint,
    unit: number,
    edge?: { cx: number; cy: number; radius: number },
  ): void {
    const clamp = (p: MapPoint): { x: number; y: number; off: boolean } => {
      if (!edge) return { x: p.x, y: p.y, off: false };
      const dx = p.x - edge.cx;
      const dy = p.y - edge.cy;
      const d = Math.hypot(dx, dy);
      if (d <= edge.radius) return { x: p.x, y: p.y, off: false };
      const k = edge.radius / d;
      return { x: edge.cx + dx * k, y: edge.cy + dy * k, off: true };
    };

    for (const landmark of this.plan.landmarks) {
      const p = clamp(project(landmark.x, landmark.z));
      if (p.off) continue; // Landmarks do not need an off-screen arrow.
      // The terminal is a building the player walks into, so it takes the same
      // ring every other enterable building has rather than a landmark
      // diamond - the ring is the map's one piece of taught vocabulary and it
      // would be a waste to have the biggest enterable building opt out of it.
      if (landmark.kind === 'terminal') drawDoorPin(ctx, p.x, p.y, 5.5 * unit);
      else drawLandmarkPin(ctx, p.x, p.y, 6 * unit);
    }

    for (const parcel of this.plan.parcels) {
      if (!parcel.enterable) continue;
      const centre = project(
        (parcel.rect.minX + parcel.rect.maxX) * 0.5,
        (parcel.rect.minZ + parcel.rect.maxZ) * 0.5,
      );
      const isShop = parcel.interiorKind === 'gunStore';
      const p = clamp(centre);
      if (p.off && !isShop) continue;
      if (isShop) drawShopPin(ctx, p.x, p.y, 9 * unit, p.off);
      else drawDoorPin(ctx, p.x, p.y, 5.5 * unit);
    }

    /*
     * The mission waypoint, drawn LAST so it is on top of every other pin.
     *
     * It is the only marker that is allowed to survive being clamped to the
     * rim: the whole point of it is telling the player which way to drive, and
     * a waypoint that vanishes the moment it leaves the minimap is a waypoint
     * that is missing exactly when it is needed.
     */
    if (this.waypoint) {
      const p = clamp(project(this.waypoint.x, this.waypoint.z));
      drawWaypointPin(ctx, p.x, p.y, 8 * unit, p.off);
    }
  }



  // -- expanded raster ------------------------------------------------------

  /**
   * The expanded map: the static layer scaled to the display size with district
   * names, arterial street names, landmark labels and a scale bar drawn on top
   * at device resolution. Rebuilt only when the viewport changes.
   */
  /**
   * The world rectangle the expanded map is showing at the current zoom.
   *
   * Centred on the player and then clamped inside the plan, so walking to the
   * edge of the city slides the window up against the boundary instead of
   * showing a screenful of nothing. At zoom 1 the clamp collapses to the whole
   * plan, which is the view every earlier build had.
   */
  private expandedWindow(): MapWindow {
    const zoom = EXPANDED_ZOOMS[this.zoomIndex] ?? 1;
    const width = this.bounds.width / zoom;
    const depth = this.bounds.depth / zoom;
    const maxX = this.bounds.minX + this.bounds.width - width;
    const maxZ = this.bounds.minZ + this.bounds.depth - depth;
    return {
      minX: clampRange(this.playerX - width * 0.5, this.bounds.minX, maxX),
      minZ: clampRange(this.playerZ - depth * 0.5, this.bounds.minZ, maxZ),
      width,
      depth,
    };
  }

  /** Whether the cached raster still covers where the player is looking. */
  private cacheCoversWindow(want: MapWindow): boolean {
    const have = this.cachedWindow;
    if (!have) return false;
    if (have.width !== want.width || have.depth !== want.depth) return false;
    return (
      Math.abs(have.minX - want.minX) < want.width * RECENTRE_FRACTION &&
      Math.abs(have.minZ - want.minZ) < want.depth * RECENTRE_FRACTION
    );
  }

  /**
   * Projects world metres into a raster of `width` pixels.
   *
   * The width is a PARAMETER rather than `this.expandedWidth` because the same
   * cache serves two canvases of different sizes - the `M` overlay and the
   * pause menu's Map tab - and reading it off the object meant whichever of
   * them painted last decided where the other one put its player marker.
   */
  private expandedProjector(
    window: MapWindow,
    width: number,
  ): (x: number, z: number) => MapPoint {
    const scale = width / window.width;
    return (x: number, z: number): MapPoint => ({
      x: (x - window.minX) * scale,
      y: (z - window.minZ) * scale,
    });
  }

  private buildExpandedCache(width: number, height: number, window: MapWindow): void {
    if (width <= 0 || height <= 0) return;
    this.expandedCache.width = width;
    this.expandedCache.height = height;
    const ctx = context2d(this.expandedCache);
    const scale = width / window.width;
    const unit = Math.max(1, this.dpr);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = MINIMAP_PALETTE.beyond;
    ctx.fillRect(0, 0, width, height);

    this.setPaint(window.minX, window.minZ, scale);
    this.paintCity(ctx, width, height, window);
    this.cachedWindow = window;

    const project = this.expandedProjector(window, width);
    ctx.textBaseline = 'middle';

    // Painted smallest first so the district names, which carry the map, win
    // any collision with a street or a landmark caption.
    this.drawMarkers(ctx, project, unit);
    this.drawStreetLabels(ctx, project, unit);
    this.drawLandmarkLabels(ctx, project, width, unit);
    this.drawDistrictLabels(ctx, project, unit);
    this.drawScaleBar(ctx, height, scale, unit);
    this.drawLegend(ctx, width, height, unit);
  }

  private labelFont(size: number, weight: number, unit: number): string {
    return `${weight} ${size * unit}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  }

  private drawDistrictLabels(
    ctx: CanvasRenderingContext2D,
    project: (x: number, z: number) => MapPoint,
    unit: number,
  ): void {
    ctx.font = this.labelFont(11, 600, unit);
    ctx.fillStyle = MINIMAP_PALETTE.label;
    for (const anchor of districtAnchors(this.plan)) {
      const point = project(anchor.x, anchor.z);
      this.drawTrackedText(
        ctx,
        DISTRICT_LABELS[anchor.district].toUpperCase(),
        point.x,
        point.y,
        2.6 * unit,
        3.4 * unit,
      );
    }
  }

  private drawStreetLabels(
    ctx: CanvasRenderingContext2D,
    project: (x: number, z: number) => MapPoint,
    unit: number,
  ): void {
    ctx.font = this.labelFont(9, 500, unit);
    ctx.fillStyle = MINIMAP_PALETTE.labelDim;
    for (const street of labelledStreets(this.plan)) {
      const name = street.name.toUpperCase();
      if (street.axis === 'x') {
        // North-south street: the name runs up it, so the text is turned too.
        const along = (Math.max(street.from, this.bounds.minZ) + Math.min(street.to, this.bounds.maxZ)) / 2;
        const point = project(street.position, along);
        ctx.save();
        ctx.translate(point.x, point.y);
        ctx.rotate(-Math.PI / 2);
        this.drawTrackedText(ctx, name, 0, 0, 1.8 * unit, 2.8 * unit);
        ctx.restore();
      } else {
        const from = Math.max(street.from, this.bounds.minX);
        const to = Math.min(street.to, this.bounds.maxX);
        const point = project((from + to) / 2, street.position);
        this.drawTrackedText(ctx, name, point.x, point.y, 1.8 * unit, 2.8 * unit);
      }
    }
  }

  private drawLandmarkLabels(
    ctx: CanvasRenderingContext2D,
    project: (x: number, z: number) => MapPoint,
    width: number,
    unit: number,
  ): void {
    ctx.font = this.labelFont(9, 500, unit);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.8 * unit;
    ctx.strokeStyle = MINIMAP_PALETTE.labelHalo;
    ctx.fillStyle = MINIMAP_PALETTE.label;
    for (const landmark of this.plan.landmarks) {
      const point = project(landmark.x, landmark.z);
      // Labels near the east edge read inward so they cannot run off the sheet.
      const flip = point.x > width * 0.8;
      ctx.textAlign = flip ? 'right' : 'left';
      const tx = point.x + (flip ? -9 * unit : 9 * unit);
      ctx.strokeText(landmark.name, tx, point.y);
      ctx.fillText(landmark.name, tx, point.y);
    }
    ctx.textAlign = 'left';
  }

  /** Canvas has no letter-spacing everywhere yet, so labels are tracked by hand. */
  private drawTrackedText(
    ctx: CanvasRenderingContext2D,
    text: string,
    cx: number,
    cy: number,
    tracking: number,
    halo: number,
  ): void {
    const chars = [...text];
    let total = 0;
    const widths: number[] = [];
    for (const char of chars) {
      const w = ctx.measureText(char).width;
      widths.push(w);
      total += w;
    }
    total += tracking * Math.max(0, chars.length - 1);
    const align = ctx.textAlign;
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    ctx.lineWidth = halo;
    ctx.strokeStyle = MINIMAP_PALETTE.labelHalo;
    let cursor = cx - total * 0.5;
    for (let i = 0; i < chars.length; i += 1) {
      const char = chars[i];
      if (char === undefined) continue;
      if (halo > 0) ctx.strokeText(char, cursor, cy);
      ctx.fillText(char, cursor, cy);
      cursor += (widths[i] ?? 0) + tracking;
    }
    ctx.textAlign = align;
  }

  /**
   * A key for the map's symbols.
   *
   * Without it a warm ring is just a warm ring: the player has no way to learn
   * that it means "you can go inside this one", which is exactly the thing the
   * markers exist to say.
   */
  private drawLegend(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    unit: number,
  ): void {
    const rows: [string, (x: number, y: number) => void][] = [
      [
        'Gun store',
        (x, y) => drawShopPin(ctx, x, y, 7 * unit),
      ],
      [
        'Enter this building',
        (x, y) => {
          ctx.beginPath();
          ctx.arc(x, y, 5.5 * unit, 0, TAU);
          ctx.strokeStyle = MINIMAP_PALETTE.enterable;
          ctx.lineWidth = 2.2 * unit;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x, y, 2.2 * unit, 0, TAU);
          ctx.fillStyle = MINIMAP_PALETTE.playerEdge;
          ctx.fill();
        },
      ],
      [
        'Landmark',
        (x, y) => {
          const r = 6 * unit;
          ctx.beginPath();
          ctx.moveTo(x, y - r);
          ctx.lineTo(x + r, y);
          ctx.lineTo(x, y + r);
          ctx.lineTo(x - r, y);
          ctx.closePath();
          ctx.fillStyle = MINIMAP_PALETTE.landmark;
          ctx.fill();
          ctx.strokeStyle = MINIMAP_PALETTE.playerEdge;
          ctx.lineWidth = 1.4 * unit;
          ctx.stroke();
        },
      ],
    ];

    const pad = 14 * unit;
    const rowHeight = 20 * unit;
    const boxW = 168 * unit;
    const boxH = pad * 2 + rowHeight * rows.length;
    const x0 = width - boxW - pad;
    const y0 = height - boxH - pad;

    ctx.fillStyle = 'rgba(9, 12, 15, 0.82)';
    ctx.strokeStyle = 'rgba(200, 160, 106, 0.28)';
    ctx.lineWidth = 1 * unit;
    ctx.beginPath();
    ctx.rect(x0, y0, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = this.labelFont(10, 500, unit);
    rows.forEach(([label, glyph], i) => {
      const cy = y0 + pad + rowHeight * (i + 0.5);
      glyph(x0 + pad + 8 * unit, cy);
      ctx.fillStyle = MINIMAP_PALETTE.label;
      ctx.fillText(label, x0 + pad + 24 * unit, cy);
    });
  }

  private drawScaleBar(
    ctx: CanvasRenderingContext2D,
    height: number,
    scale: number,
    unit: number,
  ): void {
    const metres = 100;
    const length = metres * scale;
    const x = 16 * unit;
    const y = height - 20 * unit;
    ctx.strokeStyle = MINIMAP_PALETTE.labelDim;
    ctx.lineWidth = 1 * unit;
    ctx.beginPath();
    ctx.moveTo(x, y - 3 * unit);
    ctx.lineTo(x, y);
    ctx.lineTo(x + length, y);
    ctx.lineTo(x + length, y - 3 * unit);
    ctx.stroke();
    ctx.fillStyle = MINIMAP_PALETTE.labelDim;
    ctx.font = this.labelFont(9, 500, unit);
    ctx.textAlign = 'left';
    ctx.fillText(`${metres} m`, x + length + 6 * unit, y - 1 * unit);
  }
}

/**
 * The gun-store pin: a filled teardrop with a crosshair.
 *
 * Sized in SCREEN pixels by the caller, never in world units - baked at world
 * scale it collapsed to three pixels once the map was zoomed out. When `off`
 * is set the pin is riding the edge of the view and gains a ring, so it reads
 * as "this way" rather than "it is here".
 */
/**
 * The mission waypoint: a hollow diamond with a dot in it, in the club's own
 * magenta so it cannot be confused with the gun shop's red pin.
 *
 * `off` draws it as an arrow pointing off the rim instead, which is the state
 * it spends most of a cross-city drive in.
 */
function drawWaypointPin(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  off: boolean,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = Math.max(1.4, r * 0.22);
  ctx.strokeStyle = 'rgba(12, 14, 18, 0.85)';
  ctx.fillStyle = MINIMAP_PALETTE.waypoint;

  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.78, 0);
  ctx.lineTo(0, r);
  ctx.lineTo(-r * 0.78, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  if (!off) {
    // A dark pip in the middle, so a waypoint sitting on top of a building
    // block still reads as a marker rather than as a coloured tile.
    ctx.fillStyle = 'rgba(12, 14, 18, 0.9)';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.24, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawShopPin(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  off = false,
): void {
  if (off) {
    ctx.beginPath();
    ctx.arc(x, y, r * 1.05, 0, TAU);
    ctx.fillStyle = 'rgba(9, 12, 15, 0.85)';
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(x, y + r);
  ctx.bezierCurveTo(x - r * 0.95, y + r * 0.15, x - r * 0.85, y - r * 0.75, x, y - r * 0.8);
  ctx.bezierCurveTo(x + r * 0.85, y - r * 0.75, x + r * 0.95, y + r * 0.15, x, y + r);
  ctx.closePath();
  ctx.fillStyle = MINIMAP_PALETTE.gunStore;
  ctx.fill();
  ctx.strokeStyle = MINIMAP_PALETTE.playerEdge;
  ctx.lineWidth = Math.max(1, r * 0.16);
  ctx.stroke();
  // Crosshair, only once the pin is big enough to carry it. Below that the
  // strokes eat the fill and the pin stops reading as red at all.
  if (r >= 7) {
    ctx.beginPath();
    ctx.arc(x, y - r * 0.12, r * 0.28, 0, TAU);
    ctx.moveTo(x - r * 0.44, y - r * 0.12);
    ctx.lineTo(x + r * 0.44, y - r * 0.12);
    ctx.moveTo(x, y - r * 0.56);
    ctx.lineTo(x, y + r * 0.32);
    ctx.strokeStyle = MINIMAP_PALETTE.playerEdge;
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.stroke();
  }
}

/** An ordinary enterable door: a warm ring with a dark centre. */
function drawDoorPin(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.strokeStyle = MINIMAP_PALETTE.enterable;
  ctx.lineWidth = Math.max(1.4, r * 0.4);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.4, 0, TAU);
  ctx.fillStyle = MINIMAP_PALETTE.playerEdge;
  ctx.fill();
}

/** A landmark: a pale diamond. */
function drawLandmarkPin(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = MINIMAP_PALETTE.landmark;
  ctx.fill();
  ctx.strokeStyle = MINIMAP_PALETTE.playerEdge;
  ctx.lineWidth = Math.max(1, r * 0.22);
  ctx.stroke();
}
